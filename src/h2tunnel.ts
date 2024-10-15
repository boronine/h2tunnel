import tls from "node:tls";
import net from "node:net";
import events from "node:events";
import * as http2 from "node:http2";
import * as http from "node:http";
import * as stream from "node:stream";

export type TunnelState =
  | "listening"
  | "connected"
  | "stopped"
  | "starting"
  | "stopping";

export interface CommonOptions {
  logger?: (line: object) => void;
  key: string;
  cert: string;
}

export interface ServerOptions extends CommonOptions {
  tunnelListenIp: string;
  tunnelListenPort: number;
  proxyListenIp: string;
  proxyListenPort: number;
  muxListenPort: number;
}

export interface ClientOptions extends CommonOptions {
  demuxListenPort: number;
  localHttpPort: number;
  tunnelHost: string;
  tunnelPort: number;
  tunnelRestartTimeout?: number;
}

const SOCKET_PROPS: (keyof net.Socket)[] = [
  "localAddress",
  "localPort",
  "remoteAddress",
  "remotePort",
];

const DEFAULT_TUNNEL_RESTART_TIMEOUT = 1000;

function pruneHttp2Headers(headers: http2.IncomingHttpHeaders) {
  const headerCopy = { ...headers };
  delete headerCopy[":path"];
  delete headerCopy[":method"];
  delete headerCopy[":authority"];
  delete headerCopy[":scheme"];
  delete headerCopy[":status"];
  return headerCopy;
}

function pruneHttp1Headers(headers: http.IncomingHttpHeaders) {
  const headersCopy = { ...headers };
  // HTTP/1 Connection specific headers are forbidden
  delete headersCopy["connection"];
  delete headersCopy["keep-alive"];
  delete headersCopy["transfer-encoding"];
  return headersCopy;
}

abstract class AbstractTunnel extends events.EventEmitter<
  Record<TunnelState, []>
> {
  abortController: AbortController;
  abstract readonly tool: "server" | "client";
  abstract iter(): void;
  abstract get state(): TunnelState;
  constructor(readonly logger?: (line: object) => void) {
    super();
  }

  log(line: object) {
    line = { h2tunnel: this.tool, ...line };
    if (this.logger) {
      this.logger(line);
    } else {
      process.stdout.write(JSON.stringify(line) + "\n");
    }
  }

  start() {
    if (this.state !== "stopped") {
      throw new Error("Already running");
    }
    this.log({ starting: true, pid: process.pid });
    this.abortController = new AbortController();
    this.abortController.signal.addEventListener("abort", () => {
      this.log({ aborting: true });
      this.iter();
    });
    this.iter();
  }

  linkSockets(remoteSideSocket: net.Socket, localSideSocket: net.Socket) {
    const spyToLocal = new stream.PassThrough();
    const spyToRemote = new stream.PassThrough();
    spyToLocal.on("data", (chunk: Buffer) => {
      this.log({ receivedBytes: chunk.length });
    });
    spyToRemote.on("data", (chunk: Buffer) => {
      this.log({ sentBytes: chunk.length });
    });
    remoteSideSocket.pipe(spyToLocal).pipe(localSideSocket);
    localSideSocket.pipe(spyToRemote).pipe(remoteSideSocket);
    this.log({ socketsLinked: true });
  }

  async waitUntilState(state: TunnelState): Promise<void> {
    if (this.state !== state) {
      await new Promise<void>((resolve) => this.once(state, resolve));
    }
  }

  async waitUntilConnected() {
    await this.waitUntilState("connected");
  }

  async waitUntilListening() {
    await this.waitUntilState("listening");
  }

  async stop() {
    this.abortController.abort();
    await this.waitUntilState("stopped");
  }
}

export class TunnelServer extends AbstractTunnel {
  tool = "server" as const;
  tunnelSocket: tls.TLSSocket | null = null;
  muxSession: http2.ClientHttp2Session | null = null;
  muxSessionConnected: boolean = false;
  tunnelServer: tls.Server | null = null;
  httpServer: http.Server | null = null;
  muxServer: net.Server | null = null;
  muxServerListening = false; // muxServer.listening is not reliable
  muxSocket: net.Socket | null = null;

  constructor(readonly options: ServerOptions) {
    super(options.logger);
    this.abortController = new AbortController();
  }

  startHttpServer() {
    this.log({ httpServer: "starting" });
    this.httpServer = http.createServer(
      (req: http.IncomingMessage, res: http.ServerResponse) => {
        if (
          !this.tunnelSocket ||
          !this.muxSession ||
          !this.muxSessionConnected
        ) {
          res.writeHead(503);
          res.end();
          return;
        }
        this.log({
          receivingHttp1Request: { method: req.method, path: req.url },
        });
        const stream: http2.ClientHttp2Stream = this.muxSession.request(
          {
            [http2.constants.HTTP2_HEADER_METHOD]: req.method,
            [http2.constants.HTTP2_HEADER_PATH]: req.url,
            ...pruneHttp1Headers(req.headers),
          },
          { signal: this.abortController.signal },
        );
        req.pipe(stream);
        stream.on("error", () => {
          res.writeHead(503);
          res.end();
          return;
        });
        stream.on("response", (http2Headers: http2.IncomingHttpHeaders) => {
          const status = Number(
            http2Headers[http2.constants.HTTP2_HEADER_STATUS],
          );
          const headers = pruneHttp2Headers(http2Headers);
          this.log({
            sendingHttp1Response: { status: status, headers },
          });
          res.writeHead(status, headers);
          stream.pipe(res);
        });
      },
    );
    this.httpServer.on("listening", () => {
      this.log({ httpServer: "listening" });
      this.iter();
    });
    this.httpServer.on("close", () => {
      this.log({ httpServer: "close" });
      this.httpServer = null;
      this.iter();
    });
    this.httpServer.listen(
      this.options.proxyListenPort,
      this.options.proxyListenIp,
    );
    this.iter();
  }

  startTunnelServer() {
    this.log({ tunnelServer: "starting" });
    this.tunnelServer = tls.createServer({
      key: this.options.key,
      cert: this.options.cert,
      // This is necessary only if using client certificate authentication.
      requestCert: true,
      // This is necessary only if the client uses a self-signed certificate.
      ca: [this.options.cert],
    });
    this.tunnelServer.on("close", () => {
      this.log({ tunnelServer: "close" });
      this.tunnelServer = null;
      this.iter();
    });
    this.tunnelServer.on("error", (err) => {
      this.log({ tunnelServer: "error", err });
    });
    this.tunnelServer.on(
      "secureConnection",
      (newTunnelSocket: tls.TLSSocket) => {
        this.log({
          tunnelServer: "secureConnection",
          socket: Object.fromEntries(
            SOCKET_PROPS.map((k) => [k, newTunnelSocket[k]]),
          ),
        });
        if (!this.abortController.signal.aborted) {
          this.tunnelSocket = newTunnelSocket;
          this.tunnelSocket.on("error", (err) => {
            this.log({ tunnelSocket: "error", err });
          });
          this.tunnelSocket.on("close", () => {
            this.log({ tunnelSocket: "close" });
            this.tunnelSocket = null;
            this.muxSocket?.end();
            this.iter();
          });
          this.iter();
        }
      },
    );
    this.tunnelServer.listen(
      this.options.tunnelListenPort,
      this.options.tunnelListenIp,
      () => this.iter(),
    );
    this.iter();
  }

  startMuxServer() {
    this.log({ muxServer: "starting" });
    this.muxServer = net.createServer();
    this.muxServer.maxConnections = 1;
    this.muxServer.on("connection", (socket: net.Socket) => {
      this.log({ muxServer: "connection" });
      if (!this.tunnelSocket) {
        this.log({ muxServerRejectConnectionBecauseTunnelIsClosed: true });
        socket.end();
      } else {
        this.muxSocket = socket;
        this.linkSockets(this.tunnelSocket, this.muxSocket);
        this.iter();
      }
    });
    this.muxServer.on("drop", (options) => {
      this.log({ muxServer: "drop", options });
    });
    this.muxServer.on("listening", () => {
      this.log({ muxServer: "listening" });
      this.muxServerListening = true;
      this.iter();
    });
    this.muxServer.on("error", (err) => {
      this.log({ muxServer: "error", err });
    });
    this.muxServer.on("close", () => {
      this.log({ muxServer: "close" });
      this.muxServer = null;
      this.muxServerListening = false;
      this.iter();
    });
    this.muxServer.listen(this.options.muxListenPort);
  }

  get state(): TunnelState {
    if (
      !this.muxSession &&
      !this.httpServer &&
      !this.muxServer &&
      !this.tunnelServer
    ) {
      return "stopped";
    } else if (this.abortController.signal.aborted) {
      return "stopping";
    } else if (this.muxSession) {
      return "connected";
    } else if (
      this.tunnelServer?.listening &&
      this.muxServerListening &&
      this.httpServer?.listening
    ) {
      return "listening";
    } else {
      return "starting";
    }
  }

  startMuxSession() {
    this.log({ muxSession: "starting" });
    this.muxSession = http2.connect(
      `https://localhost:${this.options.muxListenPort}`,
      {
        cert: this.options.cert,
        key: this.options.key,
        ca: [this.options.cert],
        // Necessary only if the server's cert isn't for "localhost".
        checkServerIdentity: () => undefined,
      },
    );
    this.muxSession.on("connect", () => {
      this.log({ muxSession: "connected" });
      this.muxSessionConnected = true;
      this.iter();
    });
    this.muxSession.on("close", () => {
      this.log({ muxSession: "closed" });
      this.muxSession = null;
      this.muxSessionConnected = false;
      this.iter();
    });
    this.muxSession.on("error", (err) => {
      this.log({ muxSession: "error", err });
    });
    this.iter();
  }

  iter() {
    if (this.abortController.signal.aborted) {
      if (this.httpServer) {
        this.httpServer.close();
      } else if (this.muxSession) {
        this.muxSession.close();
      } else if (this.muxServer) {
        this.muxServer.close();
      } else if (this.tunnelSocket) {
        this.tunnelSocket.end();
      } else if (this.tunnelServer) {
        this.tunnelServer.close();
      }
    } else {
      if (!this.tunnelServer) {
        this.startTunnelServer();
      } else if (!this.muxServer) {
        this.startMuxServer();
      } else if (!this.httpServer) {
        this.startHttpServer();
      } else if (
        this.muxServerListening &&
        this.tunnelSocket &&
        !this.muxSession
      ) {
        this.startMuxSession();
      }
    }
    this.emit(this.state);
  }
}

export class TunnelClient extends AbstractTunnel {
  tool = "client" as const;
  demuxServer: http2.Http2SecureServer | null = null;
  demuxSession: http2.ServerHttp2Session | null = null;
  tunnelSocket: tls.TLSSocket | null = null;
  tunnelSocketConnected = false;
  // The tunnel will not restart as long as this property is not null
  tunnelSocketRestartTimeout: NodeJS.Timeout | null = null;
  reverseSocket: net.Socket | null = null;
  reverseSocketConnected = false;
  socketsLinked = false;

  constructor(readonly options: ClientOptions) {
    super(options.logger);
    this.abortController = new AbortController();
  }

  startTunnel() {
    this.log({ tunnelSocket: "starting" });
    this.tunnelSocketRestartTimeout = null;
    this.tunnelSocket = tls.connect({
      host: this.options.tunnelHost,
      port: this.options.tunnelPort,
      // Necessary only if the server requires client certificate authentication.
      key: this.options.key,
      cert: this.options.cert,
      // Necessary only if the server uses a self-signed certificate.
      ca: [this.options.cert],
      // Necessary only if the server's cert isn't for "localhost".
      checkServerIdentity: () => undefined,
    });
    this.tunnelSocket.on("secureConnect", () => {
      this.log({ tunnelSocket: "secureConnect" });
      this.tunnelSocketConnected = true;
      this.iter();
    });
    this.tunnelSocket.on("error", (err) => {
      this.log({ tunnelSocket: "error", err });
    });
    this.tunnelSocket.on("close", () => {
      this.log({ tunnelSocket: "close" });
      this.tunnelSocket = null;
      this.tunnelSocketConnected = false;
      this.socketsLinked = false;
      // This session doesn't detect a broken tunnel, it needs to be terminated manually
      this.demuxSession?.close();
      if (!this.abortController.signal.aborted) {
        const timeout =
          this.options.tunnelRestartTimeout ?? DEFAULT_TUNNEL_RESTART_TIMEOUT;
        this.log({ tunnelSocketWillRestart: timeout });
        this.tunnelSocketRestartTimeout = setTimeout(() => {
          this.tunnelSocketRestartTimeout = null;
          this.iter();
        }, timeout);
      }
      this.iter();
    });
  }

  startReverseSocket() {
    this.reverseSocket = net.createConnection({
      host: "localhost",
      port: this.options.demuxListenPort,
    });
    this.reverseSocket.on("close", () => {
      this.log({ reverseSocketClose: true });
      this.reverseSocket = null;
      this.reverseSocketConnected = false;
      this.socketsLinked = false;
      this.iter();
    });
    this.reverseSocket.on("connect", () => {
      this.reverseSocketConnected = true;
      this.iter();
    });
  }

  startDemuxServer() {
    this.demuxServer = http2.createSecureServer({
      key: this.options.key,
      cert: this.options.cert,
      // This is necessary only if using client certificate authentication.
      requestCert: true,
      // This is necessary only if the client uses a self-signed certificate.
      ca: [this.options.cert],
    });
    this.demuxServer.on("close", () => {
      this.demuxServer = null;
      this.iter();
    });
    this.demuxServer.on("timeout", () => {
      this.log({ demuxServer: "timeout" });
    });
    this.demuxServer.on("sessionError", (err) => {
      this.log({ demuxServer: "sessionError", err });
    });
    this.demuxServer.on("clientError", (err) => {
      this.log({ demuxServer: "clientError", err });
    });
    this.demuxServer.on("unknownProtocol", () => {
      this.log({ demuxServer: "unknownProtocol" });
    });
    this.demuxServer.on("session", (session: http2.ServerHttp2Session) => {
      this.demuxSession = session;
      this.demuxSession.on("error", (err) => {
        this.log({ demuxSession: "error", err });
        this.demuxSession = null;
        this.iter();
      });
      this.demuxSession.on("close", () => {
        this.log({ demuxSession: "close" });
        this.demuxSession = null;
        this.iter();
      });
      this.demuxSession.on(
        "stream",
        async (
          stream: http2.ServerHttp2Stream,
          headers: http2.IncomingHttpHeaders,
        ) => {
          const method = headers[http2.constants.HTTP2_HEADER_METHOD] as string;
          const path = headers[http2.constants.HTTP2_HEADER_PATH] as string;
          this.log({ receivingHttp2Request: { method, path } });
          const req = http.request(
            {
              hostname: "localhost",
              port: this.options.localHttpPort,
              path: path,
              method: method,
              headers: pruneHttp2Headers(headers),
              signal: this.abortController.signal,
            },
            (res: http.IncomingMessage) => {
              const headers = pruneHttp1Headers(res.headers);
              this.log({
                sendingHttp2Response: { status: res.statusCode, headers },
              });
              stream.respond({
                [http2.constants.HTTP2_HEADER_STATUS]: res.statusCode,
                ...headers,
              });
              res.pipe(stream);
            },
          );
          req.on("error", (e) => {
            this.log({ http1ReqError: e });
          });
          stream.pipe(req);
        },
      );
      this.iter();
    });
    this.demuxServer.on("listening", () => {
      this.log({ demuxServer: "listening" });
      this.iter();
    });
    this.demuxServer.listen(this.options.demuxListenPort);
    this.iter();
  }

  get state(): TunnelState {
    if (!this.tunnelSocket && !this.reverseSocket) {
      return "stopped";
    } else if (this.abortController.signal.aborted) {
      return "stopping";
    } else if (this.socketsLinked && this.demuxSession) {
      return "connected";
    } else if (this.demuxServer?.listening) {
      return "listening";
    } else {
      return "starting";
    }
  }

  iter() {
    if (this.abortController.signal.aborted) {
      if (this.tunnelSocketRestartTimeout) {
        clearTimeout(this.tunnelSocketRestartTimeout);
        this.tunnelSocketRestartTimeout = null;
      } else if (this.reverseSocket) {
        this.reverseSocket.end();
      } else if (this.tunnelSocket) {
        this.tunnelSocket.end();
      } else if (this.demuxSession) {
        this.demuxSession.close();
      } else if (this.demuxServer) {
        this.demuxServer.close();
      }
    } else {
      if (!this.demuxServer) {
        this.startDemuxServer();
        this.iter();
        return;
      }
      if (this.demuxServer.listening && !this.reverseSocket) {
        this.startReverseSocket();
        this.iter();
        return;
      }
      if (
        this.reverseSocket &&
        this.reverseSocketConnected &&
        this.tunnelSocket &&
        this.tunnelSocketConnected &&
        !this.socketsLinked
      ) {
        this.linkSockets(this.tunnelSocket, this.reverseSocket);
        this.socketsLinked = true;
        this.iter();
        return;
      }
      if (!this.tunnelSocket && !this.tunnelSocketRestartTimeout) {
        this.startTunnel();
        this.iter();
        return;
      }
    }

    this.emit(this.state);
  }
}
