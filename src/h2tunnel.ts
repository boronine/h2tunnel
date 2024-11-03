import net from "node:net";
import events from "node:events";
import * as http2 from "node:http2";
import * as tls from "node:tls";
import stream from "node:stream";

export type TunnelState = "listening" | "connected" | "stopped" | "stopping";

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

const DEFAULT_TUNNEL_RESTART_TIMEOUT = 1000;

export abstract class AbstractTunnel<
  S extends http2.Http2Session,
  M extends net.Server,
> extends events.EventEmitter<Record<TunnelState, []>> {
  state: TunnelState = "stopped";
  aborted: boolean;
  tunnelSocket: tls.TLSSocket | null = null;
  muxSocket: net.Socket | null = null;
  h2session: S | null = null;
  abstract init(): void;
  constructor(
    readonly log: (line: object) => void = (line) =>
      process.stdout.write(JSON.stringify(line) + "\n"),
    readonly muxServer: M,
    readonly muxListenPort: number,
  ) {
    super();
    muxServer.maxConnections = 1;
    muxServer.on("drop", (options) => {
      this.log({ muxServer: "drop", options });
    });
    muxServer.on("listening", () => {
      this.log({ muxServer: "listening" });
      this.updateHook();
    });
    muxServer.on("error", (err) => {
      this.log({ muxServer: "error", err });
    });
    muxServer.on("close", () => {
      this.log({ muxServer: "close" });
      this.updateHook();
    });
  }

  setH2Session(session: S) {
    this.h2session = session;
    this.h2session.on("close", () => {
      this.log({ h2session: "close" });
      this.h2session = null;
      this.updateHook();
    });
    this.h2session.on("error", (err) => {
      this.log({ h2session: "error", err });
    });
  }

  linkSocketsIfNecessary() {
    if (this.tunnelSocket && !this.tunnelSocket.closed && this.muxSocket) {
      this.tunnelSocket.pipe(this.muxSocket);
      this.muxSocket.pipe(this.tunnelSocket);
      this.log({ linked: true });
    }
  }

  setMuxSocket(socket: net.Socket) {
    this.muxSocket = socket;
    this.muxSocket.on("error", (err) => {
      this.log({ muxSocket: "error", err });
    });
    this.muxSocket.on("close", () => {
      this.log({ muxSocket: "close" });
      this.muxSocket = null;
      if (this.aborted) {
        this.muxServer.close();
      }
      this.updateHook();
    });
    this.linkSocketsIfNecessary();
  }

  setTunnelSocket(socket: tls.TLSSocket) {
    this.tunnelSocket = socket;
    // Error will be handled in the 'close' event below
    this.tunnelSocket.on("error", () => {});
    this.tunnelSocket.on("close", () => {
      this.log({ tunnelSocket: "close", error: socket.errored });
      this.muxSocket?.destroy();
      // Make sure error cascades to all active HTTP2 streams
      this.h2session?.destroy(socket.errored ? new Error() : undefined);
      this.updateHook();
    });
    this.linkSocketsIfNecessary();
  }

  updateHook() {
    let state: TunnelState;
    if (this.aborted) {
      state = this.isStopped() ? "stopped" : "stopping";
    } else if (this.h2session && this.tunnelSocket?.readyState === "open") {
      state = "connected";
    } else {
      this.init();
      state = this.isListening() ? "listening" : "stopped";
    }

    if (state !== this.state) {
      this.state = state;
      this.log({ state });
      this.emit(state);
    }
  }

  addDemuxSocket(socket: net.Socket, stream: http2.Http2Stream): void {
    const log = (line: object) => {
      this.log({
        streamId: stream.id,
        streamWritableEnd: stream.writableEnded,
        socketWritableEnd: socket.writableEnded,
        streamDestroyed: stream.destroyed,
        socketDestroyed: socket.destroyed,
        streamError: stream.errored,
        socketError: socket.errored,
        ...line,
      });
    };
    log({ demux: "added" });

    const setup = (duplex1: stream.Duplex, duplex2: stream.Duplex) => {
      const isStream = duplex1 === stream;
      const tag = isStream ? "demuxStream" : "demuxSocket";
      duplex1.on("data", (chunk) => {
        log({
          [isStream ? "readBytes" : "writeBytes"]: chunk.length,
        });
        duplex2.write(chunk);
      });
      // Catch error but do not handle it, we will handle it later during the 'close' event
      duplex1.on("error", () => {
        log({ [tag]: "error" });
      });
      let endTimeout: NodeJS.Timeout | null = null;
      duplex1.on("end", () => {
        log({ [tag]: "end", ts: new Date().getTime() });
        if (!duplex2.writableEnded) {
          log({ [tag]: "closing opposite" });
          duplex2.end();
        }
      });

      duplex1.on("close", () => {
        log({ [tag]: "close", ts: new Date().getTime() });
        if (duplex1.errored && !duplex2.closed) {
          if (endTimeout) {
            clearTimeout(endTimeout);
          }
          if (isStream) {
            log({ [tag]: "destroying socket" });
            socket.resetAndDestroy();
          } else {
            log({ [tag]: "destroying stream" });
            stream.destroy(new Error());
          }
        }
      });
    };

    setup(socket, stream);
    setup(stream, socket);
  }

  start() {
    this.log({ starting: true, pid: process.pid });
    this.log({ muxServer: "starting" });
    this.muxServer.listen(this.muxListenPort);
    this.aborted = false;
    this.updateHook();
  }

  isListening() {
    return this.muxServer.listening;
  }

  isStopped() {
    return (
      !this.h2session &&
      !this.muxServer.listening &&
      !this.muxSocket &&
      (!this.tunnelSocket || this.tunnelSocket.closed)
    );
  }

  onAbort() {
    this.log({ aborting: true });
    this.muxSocket?.destroy();
    this.tunnelSocket?.destroy();
    this.h2session?.destroy();
    this.muxServer?.close();
    this.updateHook();
  }

  async waitUntilState(state: TunnelState): Promise<void> {
    if (this.state !== state) {
      await new Promise<void>((resolve) => this.once(state, resolve));
    }
  }

  async waitUntilConnected() {
    await this.waitUntilState("connected");
  }

  async stop() {
    this.aborted = true;
    this.onAbort();
    await this.waitUntilState("stopped");
  }
}

export class TunnelServer extends AbstractTunnel<
  http2.ClientHttp2Session,
  net.Server
> {
  constructor(
    readonly options: ServerOptions,
    readonly tunnelServer = tls.createServer({
      key: options.key,
      cert: options.cert,
      // This is necessary only if using client certificate authentication.
      requestCert: true,
      // This is necessary only if the client uses a self-signed certificate.
      ca: [options.cert],
    }),
    readonly proxyServer = net.createServer({ allowHalfOpen: true }),
  ) {
    super(options.logger, net.createServer(), options.muxListenPort);
    this.muxServer.on("connection", (socket: net.Socket) => {
      this.log({ muxServer: "connection" });
      this.setMuxSocket(socket);
      this.updateHook();
    });
    proxyServer.on("connection", (socket: net.Socket) => {
      this.log({ proxyServer: "connection" });
      if (!this.h2session || this.h2session.destroyed) {
        socket.resetAndDestroy();
      } else {
        this.addDemuxSocket(
          socket,
          this.h2session.request({
            [http2.constants.HTTP2_HEADER_METHOD]: "POST",
          }),
        );
      }
    });
    proxyServer.on("listening", () => {
      this.log({ proxyServer: "listening" });
      this.updateHook();
    });
    proxyServer.on("close", () => {
      this.log({ proxyServer: "close" });
      this.updateHook();
    });
    tunnelServer.maxConnections = 1;
    tunnelServer.on("drop", (options) => {
      this.log({ tunnelServer: "drop", options });
    });
    tunnelServer.on("listening", () => {
      this.log({ tunnelServer: "listening" });
      this.updateHook();
    });
    tunnelServer.on("close", () => {
      this.log({ tunnelServer: "close" });
      this.updateHook();
    });
    tunnelServer.on("error", (err) => {
      this.log({ tunnelServer: "error", err });
    });
    tunnelServer.on("secureConnection", (socket: tls.TLSSocket) => {
      if (!this.aborted) {
        this.log({ tunnelServer: "secureConnection" });
        this.setTunnelSocket(socket);
        this.updateHook();
      }
    });
  }

  start() {
    this.log({ proxyServer: "starting" });
    this.proxyServer.listen(
      this.options.proxyListenPort,
      this.options.proxyListenIp,
    );
    this.log({ tunnelServer: "starting" });
    this.tunnelServer.listen(
      this.options.tunnelListenPort,
      this.options.tunnelListenIp,
    );
    super.start();
  }

  onAbort() {
    super.onAbort();
    this.proxyServer?.close();
    this.tunnelServer?.close();
  }

  isStopped() {
    return (
      super.isStopped() &&
      !this.proxyServer.listening &&
      !this.tunnelServer.listening
    );
  }

  isListening() {
    return (
      super.isListening() &&
      this.proxyServer.listening &&
      this.tunnelServer.listening
    );
  }

  init() {
    if (this.tunnelSocket && !this.tunnelSocket.closed && !this.h2session) {
      this.log({ muxSession: "starting" });
      const session = http2.connect(
        `http://localhost:${this.options.muxListenPort}`,
      );
      session.on("connect", () => {
        this.log({ h2session: "connect" });
        this.updateHook();
      });
      this.setH2Session(session);
    }
  }

  async waitUntilListening() {
    await this.waitUntilState("listening");
  }
}

export class TunnelClient extends AbstractTunnel<
  http2.ServerHttp2Session,
  http2.Http2Server
> {
  // The tunnel will not restart as long as this property is not null
  tunnelSocketRestartTimeout: NodeJS.Timeout | null = null;

  constructor(readonly options: ClientOptions) {
    super(options.logger, http2.createServer(), options.demuxListenPort);
    this.muxServer.on("session", (session: http2.ServerHttp2Session) => {
      this.log({ muxServer: "session" });
      this.setH2Session(session);
      session.on("stream", (stream: http2.ServerHttp2Stream) => {
        this.addDemuxSocket(
          net.createConnection({
            host: "127.0.0.1",
            port: this.options.localHttpPort,
            allowHalfOpen: true,
          }),
          stream,
        );
      });
      this.updateHook();
    });
  }

  startTunnel() {
    this.log({ tunnelSocket: "starting" });
    const socket = tls.connect({
      host: this.options.tunnelHost,
      port: this.options.tunnelPort,
      cert: this.options.cert,
      key: this.options.key,
      ca: [this.options.cert],
      // Necessary only if the server's cert isn't for "localhost".
      checkServerIdentity: () => undefined,
    });
    socket.on("secureConnect", () => {
      this.log({ tunnelSocket: "secureConnect" });
      this.updateHook();
    });
    this.setTunnelSocket(socket);
  }

  onAbort() {
    if (this.tunnelSocketRestartTimeout) {
      clearTimeout(this.tunnelSocketRestartTimeout);
      this.tunnelSocketRestartTimeout = null;
    }
    super.onAbort();
  }

  init() {
    if (!this.muxSocket) {
      const muxSocket = net.createConnection({
        host: "localhost",
        port: this.options.demuxListenPort,
      });
      muxSocket.on("connect", () => {
        this.log({ muxSocket: "connect" });
        this.updateHook();
      });
      this.setMuxSocket(muxSocket);
    }
    if (!this.tunnelSocketRestartTimeout) {
      if (!this.tunnelSocket) {
        this.startTunnel();
      } else if (this.tunnelSocket.closed) {
        const timeout =
          this.options.tunnelRestartTimeout ?? DEFAULT_TUNNEL_RESTART_TIMEOUT;
        this.log({ tunnelSocketWillRestart: timeout });
        this.tunnelSocketRestartTimeout = setTimeout(() => {
          this.tunnelSocketRestartTimeout = null;
          this.startTunnel();
          this.updateHook();
        }, timeout);
      }
    }
  }
}
