import net from "node:net";
import events from "node:events";
import http2 from "node:http2";
import tls from "node:tls";
import stream from "node:stream";
import { ClientHttp2Stream } from "http2";

export interface CommonOptions {
  logger?: (line: any) => void;
  key: string;
  cert: string;
}

export const DEFAULT_LISTEN_IP = "::0";
export const DEFAULT_ORIGIN_HOST = "localhost";
export const DEFAULT_TUNNEL_RESTART_TIMEOUT = 1000;
export const MUX_SERVER_HOST = "127.0.0.1";

export interface ServerOptions extends CommonOptions {
  tunnelListenIp?: string;
  tunnelListenPort: number;
  proxyListenIp?: string;
  proxyListenPort: number;
}

export interface ClientOptions extends CommonOptions {
  originHost?: string;
  originPort: number;
  tunnelHost: string;
  tunnelPort: number;
  tunnelRestartTimeout?: number;
}

const formatAddr = (family?: string, address?: string, port?: number) =>
  family === "IPv6" ? `[${address}]:${port}` : `${address}:${port}`;

const formatRemote = (socket: net.Socket) =>
  formatAddr(socket.remoteFamily, socket.remoteAddress, socket.remotePort);

const formatLocal = (socket: net.Socket) =>
  formatAddr(socket.localFamily, socket.localAddress, socket.localPort);

type Servers = "muxServer" | "proxyServer" | "tunnelServer";
type Stream = `stream${number}`;

export type LogLine =
  | `connected to ${string} from ${string}`
  | `rejecting connection from ${string}`
  | `${Stream} ${"send" | "recv"} ${"FIN" | "RST" | number}`
  | `${Stream} closed`
  | `${Servers | Stream} error ${string}`
  | `${Stream} forwarding to ${string}` // client: local address which we connect to
  | `${Stream} forwarded from ${string}` // server: remote address connecting to proxy server
  | "connecting"
  | "disconnected"
  | "listening"
  | "stopping"
  | "stopped"
  | `restarting`;

interface Closeable {
  close(): void;
  on(event: "close", listener: () => void): void;
}

interface Destroyable {
  destroy(): void;
  on(event: "close", listener: () => void): void;
}

export class Stoppable {
  closeables: Set<Closeable> = new Set();
  destroyables: Set<Destroyable> = new Set();
  timeouts: Set<NodeJS.Timeout> = new Set();
  addCloseable(closeable: Closeable) {
    this.closeables.add(closeable);
    closeable.on("close", () => this.closeables.delete(closeable));
  }
  addDestroyable(destroyable: Destroyable) {
    this.destroyables.add(destroyable);
    destroyable.on("close", () => this.destroyables.delete(destroyable));
  }
  setTimeout(callback: () => void, ms: number): NodeJS.Timeout {
    const timeout = setTimeout(() => {
      this.timeouts.delete(timeout);
      callback();
    }, ms);
    this.timeouts.add(timeout);
    return timeout;
  }
  async stop() {
    [...this.timeouts].forEach(clearTimeout);
    [...this.closeables].forEach((closeable) => closeable.close());
    [...this.destroyables].forEach((closeable) => closeable.destroy());
    await Promise.all(
      [...this.closeables, ...this.destroyables].map(
        (closeable) =>
          new Promise<void>((resolve) => closeable.on("close", resolve)),
      ),
    );
  }
}

export abstract class AbstractTunnel<
  S extends http2.Http2Session,
  M extends net.Server,
> extends Stoppable {
  // Due to Node.js bug, we have seen HTTP2 sessions that were destroyed before "close" event was emitted, so we always have to check for "destroyed"
  session: S | null = null;
  activeStreams: Map<http2.Http2Stream, net.Socket> = new Map();
  aborted: boolean = false;
  connectedEvent = new events.EventEmitter<Record<"connected", []>>();

  protected constructor(
    readonly log: (line: LogLine) => void = (line) =>
      process.stdout.write(line + "\n"),
    readonly muxServer: M,
  ) {
    super();
    muxServer.on("error", (err) =>
      this.log(`muxServer error ${err.toString()}`),
    );
  }

  getMuxServerPort(): number {
    return (this.muxServer.address() as net.AddressInfo).port;
  }

  addStream(
    streamId: number,
    socket: net.Socket,
    stream: http2.Http2Stream,
  ): void {
    this.activeStreams.set(stream, socket);
    // Error can be on the socket side or on the stream side. Socket error is logged as error, stream error is logged as RST
    socket.on("error", (error) => {
      this.log(`stream${streamId} error ${error.toString()}`);
      this.log(`stream${streamId} send RST`);
    });
    stream.on("error", () => {
      // Make sure stream error is received from the network and not from the socket
      if (!socket.errored) {
        this.log(`stream${streamId} recv RST`);
      }
    });
    stream.on("close", () => {
      this.log(`stream${streamId} closed`);
      this.activeStreams.delete(stream);
    });
    const setup = (
      duplex1: stream.Duplex,
      duplex2: stream.Duplex,
      t: "send" | "recv",
      destroyDuplex2: () => void,
    ) => {
      duplex1.on("data", (chunk: Buffer) => {
        this.log(`stream${streamId} ${t} ${chunk.length}`);
        duplex2.write(chunk);
      });
      duplex1.on("end", () => {
        this.log(`stream${streamId} ${t} FIN`);
        if (!duplex2.writableEnded) {
          duplex2.end();
        }
      });
      duplex1.on("close", () => {
        if (duplex1.errored && !duplex2.destroyed) {
          destroyDuplex2();
        }
      });
    };

    setup(socket, stream, "send", () => stream.destroy(new Error()));
    setup(stream, socket, "recv", () => socket.resetAndDestroy());
  }

  start() {
    this.aborted = false;
    this.addCloseable(this.muxServer);
    this.muxServer.listen(0, MUX_SERVER_HOST); // Let the OS pick a port
  }

  async stop() {
    this.log("stopping");
    this.aborted = true;
    await super.stop();
    this.log("stopped");
  }

  async waitUntilConnected() {
    if (!this.session || this.session.destroyed) {
      await new Promise<void>((resolve) =>
        this.connectedEvent.once("connected", resolve),
      );
    }
  }
}

export class TunnelServer extends AbstractTunnel<
  http2.ClientHttp2Session,
  net.Server
> {
  listeningEvent = new events.EventEmitter<Record<"listening", []>>();
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
    super(options.logger, net.createServer());
    proxyServer.on("connection", (socket: net.Socket) => {
      this.addDestroyable(socket);
      if (!this.session || this.session.destroyed || this.aborted) {
        this.log(`rejecting connection from ${formatRemote(socket)}`);
        socket.resetAndDestroy();
      } else {
        const streamId = this.activeStreams.size;
        this.log(`stream${streamId} forwarded from ${formatRemote(socket)}`);
        const session = this.session.request({
          [http2.constants.HTTP2_HEADER_METHOD]: "POST",
        });
        this.addDestroyable(session);
        this.addStream(streamId, socket, session);
      }
    });
    proxyServer.on("error", (err) =>
      this.log(`proxyServer error ${err.toString()}`),
    );
    tunnelServer.on("error", (err) =>
      this.log(`tunnelServer error ${err.toString()}`),
    );
    tunnelServer.on("secureConnection", (tunnelSocket: tls.TLSSocket) => {
      this.addDestroyable(tunnelSocket);
      tunnelSocket.on("error", () => {});
      tunnelSocket.on("close", () => this.session?.destroy(new Error()));
      // TODO: make sure latest tunnel kills previous tunnel
      const session: http2.ClientHttp2Session = http2.connect(
        `http://${MUX_SERVER_HOST}:${this.getMuxServerPort()}`,
      );
      this.addDestroyable(session);
      session.on("close", () => {
        tunnelSocket.destroy();
        this.log(`disconnected`);
      });
      session.on("error", () => {});
      session.on("connect", () => {
        this.session = session;
        this.log(
          `connected to ${formatLocal(tunnelSocket)} from ${formatRemote(tunnelSocket)}`,
        );
        this.connectedEvent.emit("connected");
      });
      this.muxServer.once("connection", (muxSocket: net.Socket) => {
        this.addDestroyable(muxSocket);
        session.on("close", () => muxSocket.destroy());
        tunnelSocket.pipe(muxSocket);
        muxSocket.pipe(tunnelSocket);
      });
    });
  }

  isListening() {
    return (
      this.muxServer.listening &&
      this.proxyServer.listening &&
      this.tunnelServer.listening
    );
  }

  start() {
    super.start();
    this.addCloseable(this.proxyServer);
    this.addCloseable(this.tunnelServer);
    let listening = false;
    const hook = () => {
      if (!listening && this.isListening()) {
        listening = true;
        this.log("listening");
        this.listeningEvent.emit("listening");
      }
    };
    this.muxServer.once("listening", hook);
    this.proxyServer.once("listening", hook);
    this.tunnelServer.once("listening", hook);
    this.proxyServer.listen(
      this.options.proxyListenPort,
      this.options.proxyListenIp ?? DEFAULT_LISTEN_IP,
    );
    this.tunnelServer.listen(
      this.options.tunnelListenPort,
      this.options.tunnelListenIp ?? DEFAULT_LISTEN_IP,
    );
  }

  async waitUntilListening() {
    if (!this.isListening()) {
      await new Promise<void>((resolve) =>
        this.listeningEvent.once("listening", resolve),
      );
    }
  }
}

export class TunnelClient extends AbstractTunnel<
  http2.ServerHttp2Session,
  http2.Http2Server
> {
  // The tunnel will not restart as long as this property is not null
  restartTimeout: NodeJS.Timeout | null = null;

  constructor(readonly options: ClientOptions) {
    super(options.logger, http2.createServer());
    this.muxServer.on("listening", () => this.startTunnel());
  }

  start() {
    super.start();
    this.log("connecting");
  }

  startTunnel() {
    if (this.restartTimeout) {
      clearTimeout(this.restartTimeout);
    }
    const tunnelSocket = tls.connect({
      host: this.options.tunnelHost,
      port: this.options.tunnelPort,
      cert: this.options.cert,
      key: this.options.key,
      ca: [this.options.cert],
      // Necessary only if the server's cert isn't for "localhost".
      checkServerIdentity: () => undefined,
    });
    this.addDestroyable(tunnelSocket);
    tunnelSocket.on("error", () => {});
    tunnelSocket.on("close", () => {
      if (!this.session?.destroyed) {
        this.session?.destroy(new Error());
      }
      if (!this.aborted) {
        this.restartTimeout = this.setTimeout(() => {
          this.log("restarting");
          this.startTunnel();
        }, this.options.tunnelRestartTimeout ?? DEFAULT_TUNNEL_RESTART_TIMEOUT);
      }
    });
    tunnelSocket.on("secureConnect", () => {
      // We don't have to wait for muxSocket to connect before we can start using it
      const muxSocket = net.createConnection({
        host: MUX_SERVER_HOST,
        port: this.getMuxServerPort(),
      });
      this.addDestroyable(muxSocket);
      tunnelSocket.pipe(muxSocket);
      muxSocket.pipe(tunnelSocket);

      this.muxServer.once("session", (session: http2.ServerHttp2Session) => {
        this.addDestroyable(session);
        session.on("close", () => {
          tunnelSocket.destroy();
          muxSocket.destroy();
          this.log(`disconnected`);
        });
        session.on("error", () => {});
        this.session = session;
        this.log(
          `connected to ${formatRemote(tunnelSocket)} from ${formatLocal(tunnelSocket)}`,
        );
        this.connectedEvent.emit("connected");
        session.on("stream", (stream: ClientHttp2Stream) => {
          this.addDestroyable(stream);
          const socket = net.createConnection({
            host: this.options.originHost ?? DEFAULT_ORIGIN_HOST,
            port: this.options.originPort,
            allowHalfOpen: true,
          });
          this.addDestroyable(socket);
          socket.on("connect", () => {
            const streamId = this.activeStreams.size;
            this.log(`stream${streamId} forwarding to ${formatLocal(socket)}`);
            this.addStream(streamId, socket, stream);
          });
        });
      });
    });
  }
}
