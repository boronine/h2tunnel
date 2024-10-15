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

export abstract class AbstractTunnel extends events.EventEmitter<
  Record<TunnelState, []>
> {
  abortController: AbortController;
  abstract iter(): TunnelState;
  constructor(
    readonly log: (line: object) => void = (line) =>
      process.stdout.write(JSON.stringify(line) + "\n"),
  ) {
    super();
  }

  updateHook() {
    const state = this.iter();
    this.log({ state });
    this.emit(state);
  }

  start() {
    this.log({ starting: true, pid: process.pid });
    this.abortController = new AbortController();
    this.abortController.signal.addEventListener("abort", () => {
      this.log({ aborting: true });
      this.updateHook();
    });
    this.updateHook();
  }

  linkSockets(remoteSideSocket: net.Socket, localSideSocket: net.Socket) {
    const spyReceive = new stream.PassThrough();
    const spySend = new stream.PassThrough();
    spyReceive.on("data", (chunk: Buffer) => {
      this.log({ receivedBytes: chunk.length });
    });
    spySend.on("data", (chunk: Buffer) => {
      this.log({ sentBytes: chunk.length });
    });
    remoteSideSocket.pipe(spyReceive).pipe(localSideSocket);
    localSideSocket.pipe(spySend).pipe(remoteSideSocket);
    this.log({ socketsLinked: true });
  }

  unlinkSockets(remoteSideSocket: net.Socket, localSideSocket: net.Socket) {
    remoteSideSocket.unpipe(localSideSocket);
    localSideSocket.unpipe(remoteSideSocket);
    this.log({ socketsUnlinked: true });
  }

  async waitUntilState(state: TunnelState): Promise<void> {
    if (this.iter() !== state) {
      await new Promise<void>((resolve) => this.once(state, resolve));
    }
  }

  async waitUntilConnected() {
    await this.waitUntilState("connected");
  }

  async stop() {
    this.abortController.abort();
    await this.waitUntilState("stopped");
  }
}

export class TunnelServer extends AbstractTunnel {
  tunnelSocket: tls.TLSSocket | null = null;
  tunnelSocketClosing = false;
  muxSession: http2.ClientHttp2Session | null = null;
  muxSessionClosing = false;
  muxSessionConnected: boolean = false;
  tunnelServer: tls.Server | null = null;
  tunnelServerClosing = false;
  httpServer: http.Server | null = null;
  httpServerClosing = false;
  muxServer: net.Server | null = null;
  muxServerClosing = false;
  muxServerListening = false; // muxServer.listening is not reliable
  muxSocket: net.Socket | null = null;

  constructor(readonly options: ServerOptions) {
    super(options.logger);
  }

  startHttpServer() {
    this.log({ httpServer: "starting" });
    this.httpServerClosing = false;
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
        this.muxSession.once("close", () => {
          if (!res.writableEnded) {
            this.log({ muxSession: "close", resHeadersSent: res.headersSent });
            if (res.headersSent) {
              res.destroy();
            } else {
              res.writeHead(503);
              res.end();
            }
          }
        });
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
            sendingHttp1Response: {
              method: req.method,
              path: req.url,
              status: status,
              headers,
            },
          });
          res.writeHead(status, headers);
          stream.pipe(res);
        });
      },
    );
    this.httpServer.on("listening", () => {
      this.log({ httpServer: "listening" });
      this.updateHook();
    });
    this.httpServer.on("close", () => {
      this.log({ httpServer: "close" });
      this.httpServerClosing = false;
      this.httpServer = null;
      this.updateHook();
    });
    this.httpServer.listen(
      this.options.proxyListenPort,
      this.options.proxyListenIp,
    );
    this.updateHook();
  }

  startTunnelServer() {
    this.log({ tunnelServer: "starting" });
    this.tunnelServerClosing = false;
    this.tunnelServer = tls.createServer({
      key: this.options.key,
      cert: this.options.cert,
      // This is necessary only if using client certificate authentication.
      requestCert: true,
      // This is necessary only if the client uses a self-signed certificate.
      ca: [this.options.cert],
    });
    this.tunnelServer.maxConnections = 1;
    this.tunnelServer.on("drop", (options) => {
      this.log({ tunnelServer: "drop", options });
    });
    this.tunnelServer.on("close", () => {
      this.log({ tunnelServer: "close" });
      this.tunnelServer = null;
      this.updateHook();
    });
    this.tunnelServer.on("error", (err) => {
      this.log({ tunnelServer: "error", err });
    });
    this.tunnelServer.on("tlsClientError", (err) => {
      this.log({ tunnelServer: "tlsClientError", err });
    });
    this.tunnelServer.on("secureConnection", (socket: tls.TLSSocket) => {
      this.log({
        tunnelServer: "secureConnection",
        socket: Object.fromEntries(SOCKET_PROPS.map((k) => [k, socket[k]])),
      });
      if (!this.abortController.signal.aborted) {
        this.tunnelSocketClosing = false;
        this.tunnelSocket = socket;
        this.tunnelSocket.on("error", (err) => {
          this.log({ tunnelSocket: "error", err });
        });
        this.tunnelSocket.on("close", () => {
          this.log({ tunnelSocket: "close" });
          this.tunnelSocket = null;
          this.updateHook();
        });
        this.updateHook();
      }
    });
    this.tunnelServer.listen(
      this.options.tunnelListenPort,
      this.options.tunnelListenIp,
      () => this.updateHook(),
    );
  }

  startMuxServer() {
    this.log({ muxServer: "starting" });
    this.muxServerClosing = false;
    this.muxServer = net.createServer();
    this.muxServer.maxConnections = 1;
    this.muxServer.on("connection", (socket: net.Socket) => {
      this.log({ muxServer: "connection" });
      if (!this.tunnelSocket) {
        this.log({ muxServerRejectConnectionBecauseTunnelIsClosed: true });
        // TODO: Close gracefully
        socket.destroy();
      } else {
        this.muxSocket = socket;
        this.linkSockets(this.tunnelSocket, this.muxSocket);
        this.updateHook();
      }
    });
    this.muxServer.on("drop", (options) => {
      this.log({ muxServer: "drop", options });
    });
    this.muxServer.on("listening", () => {
      this.log({ muxServer: "listening" });
      this.muxServerListening = true;
      this.updateHook();
    });
    this.muxServer.on("error", (err) => {
      this.log({ muxServer: "error", err });
    });
    this.muxServer.on("close", () => {
      this.log({ muxServer: "close" });
      this.muxServer = null;
      this.muxServerListening = false;
      this.updateHook();
    });
    this.muxServer.listen(this.options.muxListenPort);
  }

  startMuxSession() {
    this.log({ muxSession: "starting" });
    this.muxSessionClosing = false;
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
      this.log({ muxSession: "connect" });
      this.muxSessionConnected = true;
      this.updateHook();
    });
    this.muxSession.on("close", () => {
      this.log({ muxSession: "close" });
      this.muxSession = null;
      this.muxSessionConnected = false;
      this.updateHook();
    });
    this.muxSession.on("error", (err) => {
      this.log({ muxSession: "error", err });
    });
  }

  iter() {
    while (true) {
      if (this.abortController.signal.aborted) {
        if (this.httpServer && !this.httpServerClosing) {
          this.httpServerClosing = true;
          this.httpServer.close();
        } else if (this.muxSession && !this.muxSessionClosing) {
          this.muxSessionClosing = true;
          this.muxSession.close();
        } else if (this.muxServer && !this.muxServerClosing) {
          if (this.muxServer.listening) {
            this.muxServerClosing = true;
            this.muxServer.close();
          } else {
            this.muxServer = null;
          }
        } else if (this.tunnelSocket && !this.tunnelSocketClosing) {
          this.tunnelSocketClosing = true;
          this.tunnelSocket.end();
        } else if (this.tunnelServer && !this.tunnelServerClosing) {
          this.tunnelServerClosing = true;
          this.tunnelServer.close();
        } else if (
          !this.muxSession &&
          !this.httpServer &&
          !this.muxServer &&
          !this.tunnelServer
        ) {
          return "stopped";
        } else {
          return "stopping";
        }
      } else {
        if (!this.tunnelServer) {
          this.startTunnelServer();
        } else if (!this.muxServer) {
          this.startMuxServer();
        } else if (!this.httpServer) {
          this.startHttpServer();
        } else if (
          !this.httpServer.listening ||
          !this.tunnelServer.listening ||
          !this.muxServer.listening
        ) {
          // Wait until everything is listening
          return "starting";
        } else if (!this.tunnelSocket) {
          // Nothing else to do until we have a tunnel socket
          return "listening";
        } else if (!this.muxSession) {
          this.startMuxSession();
        } else if (this.muxSessionConnected) {
          return "connected";
        } else {
          return "listening";
        }
      }
    }
  }

  async waitUntilListening() {
    await this.waitUntilState("listening");
  }
}

export class TunnelClient extends AbstractTunnel {
  demux: null | {
    server: http2.Http2SecureServer;
    closing: boolean;
  };
  demuxSession: http2.ServerHttp2Session | null = null;
  demuxSessionClosing = false;
  tunnel: null | {
    socket: tls.TLSSocket;
    state: "connecting" | "connected" | "closing";
  };
  // The tunnel will not restart as long as this property is not null
  tunnelSocketRestartTimeout: NodeJS.Timeout | null = null;
  reverse: null | {
    socket: net.Socket;
    state: "connecting" | "connected" | "closing";
  };
  socketsLinked = false;

  constructor(readonly options: ClientOptions) {
    super(options.logger);
  }

  startTunnel() {
    this.log({ tunnelSocket: "starting" });
    this.tunnelSocketRestartTimeout = null;
    const socket = tls.connect({
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
    socket.on("secureConnect", () => {
      this.log({ tunnelSocket: "secureConnect" });
      this.tunnel = { socket: socket, state: "connected" };
      this.updateHook();
    });
    socket.on("error", (err) => {
      this.log({ tunnelSocket: "error", err });
    });
    socket.on("close", () => {
      this.log({ tunnelSocket: "close" });
      this.tunnel = null;
      this.socketsLinked = false;
      // This session doesn't detect a broken tunnel, it needs to be terminated manually
      this.demuxSession?.close();
      if (!this.abortController.signal.aborted) {
        const timeout =
          this.options.tunnelRestartTimeout ?? DEFAULT_TUNNEL_RESTART_TIMEOUT;
        this.log({ tunnelSocketWillRestart: timeout });
        this.tunnelSocketRestartTimeout = setTimeout(() => {
          this.tunnelSocketRestartTimeout = null;
          this.updateHook();
        }, timeout);
      }
      this.updateHook();
    });
    this.tunnel = { socket: socket, state: "connecting" };
  }

  startReverseSocket() {
    const socket = net.createConnection({
      host: "localhost",
      port: this.options.demuxListenPort,
    });
    socket.on("error", (err) => {
      this.log({ reverseSocket: "error", err });
    });
    socket.on("close", () => {
      this.log({ reverseSocket: "close" });
      this.reverse = null;
      this.socketsLinked = false;
      this.updateHook();
    });
    socket.on("connect", () => {
      this.log({ reverseSocket: "connect" });
      this.reverse = { socket, state: "connected" };
      this.updateHook();
    });
    this.reverse = { socket, state: "connecting" };
  }

  receiveHttp2Request(
    stream: http2.ServerHttp2Stream,
    headers: http2.IncomingHttpHeaders,
  ) {
    const method = headers[http2.constants.HTTP2_HEADER_METHOD] as string;
    const path = headers[http2.constants.HTTP2_HEADER_PATH] as string;
    this.log({ receivingHttp2Request: { method, path } });
    const req = http.request({
      hostname: "localhost",
      port: this.options.localHttpPort,
      path: path,
      method: method,
      headers: pruneHttp2Headers(headers),
      signal: this.abortController.signal,
    });
    req.on("response", (res: http.IncomingMessage) => {
      const headers = pruneHttp1Headers(res.headers);
      this.log({
        sendingHttp2Response: { status: res.statusCode, headers },
      });
      stream.respond({
        [http2.constants.HTTP2_HEADER_STATUS]: res.statusCode,
        ...headers,
      });
      res.pipe(stream);
    });
    req.on("error", (e) => {
      this.log({ http1ReqError: e });
      stream.destroy();
    });
    stream.pipe(req);
  }

  receiveDemuxSession(session: http2.ServerHttp2Session) {
    this.demuxSession = session;
    this.demuxSessionClosing = false;
    this.demuxSession.on("error", (err) => {
      this.log({ demuxSession: "error", err });
      this.demuxSession = null;
      this.updateHook();
    });
    this.demuxSession.on("close", () => {
      this.log({ demuxSession: "close" });
      this.demuxSession = null;
      this.updateHook();
    });
    this.demuxSession.on("stream", (stream, headers) =>
      this.receiveHttp2Request(stream, headers),
    );
    this.updateHook();
  }

  startDemuxServer() {
    const server = http2.createSecureServer({
      key: this.options.key,
      cert: this.options.cert,
      // This is necessary only if using client certificate authentication.
      requestCert: true,
      // This is necessary only if the client uses a self-signed certificate.
      ca: [this.options.cert],
    });
    server.on("close", () => {
      this.demux = null;
      this.updateHook();
    });
    server.on("timeout", () => {
      this.log({ demuxServer: "timeout" });
    });
    server.on("sessionError", (err) => {
      this.log({ demuxServer: "sessionError", err });
    });
    server.on("clientError", (err) => {
      this.log({ demuxServer: "clientError", err });
    });
    server.on("unknownProtocol", () => {
      this.log({ demuxServer: "unknownProtocol" });
    });
    server.on("session", (session) => this.receiveDemuxSession(session));
    server.on("listening", () => {
      this.log({ demuxServer: "listening" });
      this.updateHook();
    });
    server.listen(this.options.demuxListenPort);
    this.demux = { server, closing: false };
  }

  iter() {
    while (true) {
      if (this.abortController.signal.aborted) {
        if (this.tunnelSocketRestartTimeout) {
          clearTimeout(this.tunnelSocketRestartTimeout);
          this.tunnelSocketRestartTimeout = null;
        } else if (this.demuxSession) {
          if (!this.demuxSessionClosing) {
            this.demuxSessionClosing = true;
            this.demuxSession.close();
          } else {
            // Do not mess around with sockets until HTTP2 session is cleanly closed
            return "stopping";
          }
        } else if (this.socketsLinked && this.tunnel && this.reverse) {
          // Unlink sockets before closing them individually
          this.unlinkSockets(this.reverse.socket, this.tunnel.socket);
          this.socketsLinked = false;
        } else if (this.tunnel || this.reverse) {
          // Sockets are unlinked, they are safe to stop simultaneously
          if (this.tunnel && this.tunnel.state !== "closing") {
            this.tunnel.state = "closing";
            this.tunnel.socket.end();
          }
          if (this.reverse && this.reverse.state !== "closing") {
            this.reverse.state = "closing";
            this.reverse.socket.end();
          }
          // Do not continue until both are stopped
          return "stopping";
        } else if (this.demux) {
          if (!this.demux.closing) {
            this.demux.closing = true;
            this.demux.server.close();
          } else {
            return "stopping";
          }
        } else {
          return "stopped";
        }
      } else {
        if (!this.demux) {
          this.startDemuxServer();
        } else if (!this.tunnel && !this.tunnelSocketRestartTimeout) {
          this.startTunnel();
        } else if (
          !this.demux.server.listening ||
          !this.tunnel ||
          this.tunnel.state !== "connected"
        ) {
          return "starting";
        } else if (!this.reverse) {
          this.startReverseSocket();
        } else if (this.reverse.state === "connected" && !this.socketsLinked) {
          this.linkSockets(this.tunnel.socket, this.reverse.socket);
          this.socketsLinked = true;
        } else if (this.socketsLinked && this.demuxSession) {
          return "connected";
        } else {
          return "starting";
        }
      }
    }
  }
}
