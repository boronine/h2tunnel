import events from "node:events";
import stream from "node:stream";
import net from "node:net";
import tls from "node:tls";
import http2 from "node:http2";

export const DEFAULT_LISTEN_IP = "::0";
export const DEFAULT_ORIGIN_HOST = "localhost";
export const DEFAULT_TIMEOUT = 5000;
export const DEFAULT_TUNNEL_PORT = 15900;

interface CommonOptions {
  logger?: (line: any) => void;
  key: string;
  cert: string;
}

export interface ServerOptions extends CommonOptions {
  tunnelListenIp?: string;
  tunnelListenPort?: number;
  proxyListenIp?: string;
  proxyListenPort: number;
}

export interface ClientOptions extends CommonOptions {
  originHost?: string;
  originPort: number;
  tunnelHost: string;
  tunnelPort?: number;
  timeout?: number;
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
  | `${Servers | Stream | "tunnel"} error ${string}`
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
  activeSession: S | null = null;
  tunnelSocket: tls.TLSSocket | null = null;
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

  addStream(socket: net.Socket, stream: http2.Http2Stream): number {
    const streamId = this.activeStreams.size;
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
    return streamId;
  }

  start() {
    this.aborted = false;
    this.addCloseable(this.muxServer);
    this.muxServer.listen(0); // Let the OS pick a port
  }

  async stop() {
    this.log("stopping");
    this.aborted = true;
    await super.stop();
    this.log("stopped");
  }

  async waitUntilConnected() {
    if (!this.activeSession || this.activeSession.destroyed) {
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
      if (!this.activeSession || this.activeSession.destroyed || this.aborted) {
        this.log(`rejecting connection from ${formatRemote(socket)}`);
        socket.resetAndDestroy();
      } else {
        const stream = this.activeSession.request({
          [http2.constants.HTTP2_HEADER_METHOD]: "POST",
        });
        this.addDestroyable(stream);
        const streamId = this.addStream(socket, stream);
        this.log(`stream${streamId} forwarded from ${formatRemote(socket)}`);
      }
    });
    proxyServer.on("error", (err) =>
      this.log(`proxyServer error ${err.toString()}`),
    );
    tunnelServer.on("tlsClientError", (err) =>
      this.log(`tunnel error ${err.message.trim()}`),
    );
    tunnelServer.on("error", (err) =>
      this.log(`tunnelServer error ${err.toString()}`),
    );
    tunnelServer.on("drop", () => {
      console.log("drop");
    });
    tunnelServer.on("secureConnection", (tunnelSocket: tls.TLSSocket) => {
      // Make sure latest tunnel kills previous tunnel
      this.tunnelSocket?.destroy();
      this.tunnelSocket = tunnelSocket;
      this.addDestroyable(tunnelSocket);
      tunnelSocket.on("error", () => {});
      tunnelSocket.on("close", () => {
        session.destroy(new Error());
        this.log(`disconnected`);
      });
      const address = this.muxServer.address() as net.AddressInfo;
      const session: http2.ClientHttp2Session = http2.connect(
        `http://${formatAddr(address.family, address.address, address.port)}`,
      );
      this.addDestroyable(session);
      session.on("error", () => {});
      this.muxServer.once("connection", (muxSocket: net.Socket) => {
        this.addDestroyable(muxSocket);
        tunnelSocket.on("close", () => muxSocket.destroy());
        tunnelSocket.pipe(muxSocket);
        muxSocket.pipe(tunnelSocket);
      });
      session.on(`remoteSettings`, () => {
        this.activeSession = session;
        this.activeSession.on("ping", () => {});
        this.log(
          `connected to ${formatLocal(tunnelSocket)} from ${formatRemote(tunnelSocket)}`,
        );
        this.connectedEvent.emit("connected");
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
      this.options.tunnelListenPort ?? DEFAULT_TUNNEL_PORT,
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
  pingTimeout: NodeJS.Timeout | null = null;

  constructor(readonly options: ClientOptions) {
    super(options.logger, http2.createServer());
    this.muxServer.on("listening", () => this.startTunnel());
    this.muxServer.on("stream", (stream: http2.ClientHttp2Stream) => {
      this.addDestroyable(stream);
      const socket = net.createConnection({
        host: this.options.originHost ?? DEFAULT_ORIGIN_HOST,
        port: this.options.originPort,
        allowHalfOpen: true,
      });
      this.addDestroyable(socket);
      // Wait for connection so we know the local port
      socket.on("connect", () => {
        const streamId = this.addStream(socket, stream);
        this.log(`stream${streamId} forwarding to ${formatLocal(socket)}`);
      });
    });
  }

  start() {
    super.start();
    this.log("connecting");
  }

  startTunnel() {
    if (this.restartTimeout) {
      clearTimeout(this.restartTimeout);
    }
    if (this.pingTimeout) {
      clearTimeout(this.pingTimeout);
    }
    const timeout = this.options.timeout ?? DEFAULT_TIMEOUT;
    const tunnelSocket = tls.connect({
      host: this.options.tunnelHost,
      port: this.options.tunnelPort ?? DEFAULT_TUNNEL_PORT,
      cert: this.options.cert,
      key: this.options.key,
      ca: [this.options.cert],
      timeout: timeout,
      checkServerIdentity: () => undefined,
    });
    tunnelSocket.on("timeout", () => tunnelSocket.destroy(new Error()));
    this.tunnelSocket = tunnelSocket;
    const address = this.muxServer.address() as net.AddressInfo;
    const muxSocket = net.createConnection({
      port: address.port,
      host: address.address,
      family: Number(address.family.charAt(3)),
    });
    this.addDestroyable(tunnelSocket);
    this.addDestroyable(muxSocket);
    tunnelSocket.pipe(muxSocket);
    muxSocket.pipe(tunnelSocket);
    tunnelSocket.on("error", () => {});
    tunnelSocket.on("close", () => {
      this.log(`disconnected`);
      muxSocket.destroy();
      if (!this.aborted) {
        this.restartTimeout = this.setTimeout(() => {
          this.log("restarting");
          this.startTunnel();
        }, timeout);
      }
    });
    this.muxServer.once("session", (session: http2.ServerHttp2Session) => {
      this.addDestroyable(session);
      session.on("error", () => {});
      tunnelSocket.on("close", () => session.destroy(new Error()));
      session.on("remoteSettings", () => {
        const ping = () => {
          this.pingTimeout = this.setTimeout(() => {
            if (!session.destroyed) {
              session.ping((err, duration) => {
                // When session is destroyed we get ERR_HTTP2_PING_CANCEL
                if (!err) {
                  ping();
                }
              });
            }
          }, timeout * 0.5);
        };
        ping();
        this.log(
          `connected to ${formatRemote(tunnelSocket)} from ${formatLocal(tunnelSocket)}`,
        );
        this.connectedEvent.emit("connected");
      });
    });
  }
}
