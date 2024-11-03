import { test, TestContext } from "node:test";
import {
  ClientOptions,
  ServerOptions,
  TunnelClient,
  TunnelServer,
} from "./h2tunnel.js";
import net from "node:net";
import * as http2 from "node:http2";

// localhost HTTP1 server "python3 -m http.server"
const LOCAL_PORT = 14000;
// localhost HTTP2 server that proxies to localhost HTTP1 server
const DEMUX_PORT = 14003;

// remote public HTTP1 server
const PROXY_PORT = 14004;
const PROXY_TEST_PORT = 14007;
// remote TLS server for establishing a tunnel
const TUNNEL_PORT = 14005;
const TUNNEL_TEST_PORT = 14008;
// remote HTTPS server that is piped through the tunnel to localhost
const MUX_PORT = 14006;

// Reduce this to make tests faster
const TIME_MULTIPLIER = 0.1;

const CLIENT_KEY = `-----BEGIN PRIVATE KEY-----
MIG2AgEAMBAGByqGSM49AgEGBSuBBAAiBIGeMIGbAgEBBDCDzcLnOqzvCrnUyd4P
1QcIG/Xi/VPpA5dVIwPVkutr9y/wZo3aJsYUX5xExQMsEeihZANiAAQfSPquV3P/
uhHm2D5czJoFyldutJrQswri0brL99gHSsOmQ34cH7bddcSTVToAZfwkv2yEZPNf
eLM7tASBpINt8uuOjJhCp034thS1V0HH/qDEHzEfy5wZEDrwevuzD+k=
-----END PRIVATE KEY-----`;

const CLIENT_CRT = `-----BEGIN CERTIFICATE-----
MIIB7DCCAXKgAwIBAgIUIyesgpQMVroHhiDuFa56b+bf7UwwCgYIKoZIzj0EAwIw
FjEUMBIGA1UEAwwLZXhhbXBsZS5jb20wHhcNMjQwNTMwMTAzMTM3WhcNMzQwNTI4
MTAzMTM3WjAWMRQwEgYDVQQDDAtleGFtcGxlLmNvbTB2MBAGByqGSM49AgEGBSuB
BAAiA2IABB9I+q5Xc/+6EebYPlzMmgXKV260mtCzCuLRusv32AdKw6ZDfhwftt11
xJNVOgBl/CS/bIRk8194szu0BIGkg23y646MmEKnTfi2FLVXQcf+oMQfMR/LnBkQ
OvB6+7MP6aOBgDB+MB0GA1UdDgQWBBROAP/JNaVvPWqbGcB6zGLA8zSWljAfBgNV
HSMEGDAWgBROAP/JNaVvPWqbGcB6zGLA8zSWljAPBgNVHRMBAf8EBTADAQH/MCsG
A1UdEQQkMCKCC2V4YW1wbGUuY29tgg0qLmV4YW1wbGUuY29thwQKAAABMAoGCCqG
SM49BAMCA2gAMGUCMQCJ2CU2Qh9UsHzmgpDXiIwAtA6YvBKSlR+MO22CcuFC45aM
JN+yjDEXE/TgT+bxgfcCMFFZkqT7GYLc18lW6sv6GZvhzFPV8eTePa2xwVyBgaca
93vJMc5HXDLt7XPK+Iz90g==
-----END CERTIFICATE-----`;

const getLogger = (name: string, colorCode: number) => (line: object) =>
  process.stdout.write(
    `${name.padEnd(10)} \x1b[${colorCode}m${JSON.stringify(line)}\x1b[0m\n`,
  );

const serverOptions: ServerOptions = {
  logger: getLogger("server", 32),
  tunnelListenIp: "127.0.0.1",
  tunnelListenPort: TUNNEL_PORT,
  key: CLIENT_KEY,
  cert: CLIENT_CRT,
  proxyListenPort: PROXY_PORT,
  proxyListenIp: "127.0.0.1",
  muxListenPort: MUX_PORT,
};

const clientOptions: ClientOptions = {
  logger: getLogger("client", 33),
  tunnelHost: "localhost",
  tunnelPort: TUNNEL_PORT,
  key: CLIENT_KEY,
  cert: CLIENT_CRT,
  localHttpPort: LOCAL_PORT,
  demuxListenPort: DEMUX_PORT,
  tunnelRestartTimeout: 500 * TIME_MULTIPLIER,
};

type Conn = { browserSocket: net.Socket; localhostSocket: net.Socket };

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms * TIME_MULTIPLIER));
}

async function createBadTlsServer(port: number): Promise<() => Promise<void>> {
  const server = net.createServer();
  const logger = getLogger("bad-tls", 34);
  const sockets = new Set<net.Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    logger({ badTlsServer: "sending garbage" });
    socket.write("bad TLS handshake");
  });
  server.listen(port);
  await new Promise((resolve) => server.on("listening", resolve));
  return () =>
    new Promise<void>((resolve) => {
      sockets.forEach((socket) => socket.destroy());
      server.close(() => resolve());
    });
}

async function createBadTlsClient(port: number): Promise<() => Promise<void>> {
  const socket = net.createConnection(port);
  const logger = getLogger("bad-tls", 34);
  socket.on("connect", () => {
    logger({ badTlsClient: "sending garbage" });
    socket.write("bad TLS handshake");
  });
  return () =>
    new Promise<void>((resolve) => {
      if (socket.closed) {
        resolve();
      } else {
        // Node.js TLS server does not seem to send RST packet to misbehaving client TODO
        socket.destroy();
        socket.on("close", () => resolve());
      }
    });
}

class NetworkEmulator {
  incomingSocket: net.Socket | null = null;
  outgoingSocket: net.Socket | null = null;
  constructor(
    readonly forwardPort: number,
    readonly listenPort: number,
    readonly server = net.createServer({ allowHalfOpen: true }),
    readonly logger = getLogger("network", 31),
    readonly abortController = new AbortController(),
  ) {}

  async startAndWaitUntilReady() {
    return new Promise<void>((resolve) => {
      this.server.on("connection", (incomingSocket: net.Socket) => {
        this.incomingSocket = incomingSocket;
        const outgoingSocket = net.createConnection({
          host: "127.0.0.1",
          port: this.forwardPort,
          allowHalfOpen: true,
        });
        this.outgoingSocket = outgoingSocket;
        outgoingSocket.on("error", () => incomingSocket.resetAndDestroy());
        incomingSocket.on("error", () => outgoingSocket.resetAndDestroy());
        this.logger({ server: "connection" });
        incomingSocket.pipe(outgoingSocket);
        outgoingSocket.pipe(incomingSocket);
      });
      this.server.on("listening", () => resolve());
      this.server.listen(this.listenPort, "127.0.0.1");
    });
  }
  async stopAndWaitUntilClosed() {
    this.incomingSocket?.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

class EchoServer {
  readonly server: net.Server;
  readonly dataReceived: Map<net.Socket, string> = new Map();
  private i = 0;
  constructor(
    readonly port: number,
    public proxyPort = port,
    readonly loggerLocalhost = getLogger("localhost", 35),
    readonly loggerBrowser = getLogger("browser", 36),
  ) {
    const server = net.createServer({ allowHalfOpen: true });
    server.on("connection", (socket) => {
      loggerLocalhost({ localhost: "connection" });
      socket.on("error", (err) => {
        loggerLocalhost({ localhost: "error", err });
      });
      socket.on("data", (data) => {
        this.loggerLocalhost({
          echoServerData: data.toString(),
          socketWritableEnded: socket.writableEnded,
        });
        this.appendData(socket, data);
        if (!socket.writableEnded) {
          socket.write(data);
        }
      });
      // Make sure other end stays half-open long enough to receive the last byte
      socket.on("end", async () => {
        loggerLocalhost({ localhost: "received FIN" });
        await sleep(50);
        loggerLocalhost({ localhost: "sending last byte and FIN" });
        socket.end("z");
      });
    });

    this.server = server;
  }

  appendData(socket: net.Socket, data: Buffer): void {
    const previousData = this.dataReceived.get(socket) ?? "";
    this.dataReceived.set(socket, previousData + data.toString("utf-8"));
  }

  getSocketByPrefix(prefix: string): net.Socket {
    for (const [socket, data] of this.dataReceived) {
      if (data.startsWith(prefix)) {
        return socket;
      }
    }
    throw new Error(`Socket not found: ${prefix}`);
  }

  async startAndWaitUntilReady() {
    this.server.listen(this.port);
    await new Promise<void>((resolve) =>
      this.server.on("listening", () => {
        this.loggerLocalhost({ localhost: "listening" });
        resolve();
      }),
    );
  }

  async stopAndWaitUntilClosed() {
    await new Promise((resolve) => this.server.close(resolve));
  }

  createClientSocket(): net.Socket {
    this.loggerBrowser({ browser: "connecting" });
    const socket = net.createConnection({
      port: this.proxyPort,
      allowHalfOpen: true,
    });
    socket.on("data", (chunk) => {
      this.appendData(socket, chunk);
    });
    // Make sure other end stays half-open long enough to receive the last byte
    socket.on("end", async () => {
      this.loggerBrowser({ browser: "received FIN" });
      await sleep(50);
      this.loggerBrowser({ browser: "sending last byte and FIN" });
      socket.end("z");
    });
    return socket;
  }

  async expectEconn() {
    return new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(this.proxyPort);
      socket.on("error", () => {});
      socket.on("close", (hadError) => {
        if (hadError) {
          resolve();
        } else {
          reject();
        }
      });
    });
  }

  async expectPingPongAndClose(t: TestContext) {
    const conn = await this.createConn(t);
    await new Promise<void>((resolve) => {
      conn.localhostSocket.once("data", (pong) => {
        t.assert.strictEqual(pong.toString(), "a");
        // Send FIN from client and wait for FIN back
        conn.browserSocket.end();
        conn.browserSocket.on("close", () => resolve());
      });
      // ping
      const ping = "a";
      conn.browserSocket.write(ping);
    });
  }

  async createConn(t: TestContext): Promise<Conn> {
    const browserSocket = this.createClientSocket();
    const id = (this.i++).toString();
    new Promise<void>((resolve) => browserSocket.on("connect", resolve));
    // Expect id back
    await new Promise<void>((resolve) => {
      browserSocket.once("data", (chunk) => {
        t.assert.strictEqual(chunk.toString(), id);
        resolve();
      });
      browserSocket.write(id);
    });
    await sleep(100);
    const localhostSocket = this.getSocketByPrefix(id);
    return { browserSocket, localhostSocket };
  }

  async testConn(
    t: TestContext,
    numBytes: number,
    term: "FIN" | "RST",
    by: "browser" | "localhost",
    delay: number = 0,
  ) {
    await sleep(delay);
    const conn = await this.createConn(t);
    for (let i = 0; i < numBytes; i++) {
      await new Promise<void>((resolve) => {
        conn.localhostSocket.once("data", (pong) => {
          t.assert.strictEqual(pong.toString(), "a");
          resolve();
        });
        conn.browserSocket.write("a");
      });
      await sleep(50);
    }

    const [socket1, socket2] =
      by === "browser"
        ? [conn.browserSocket, conn.localhostSocket]
        : [conn.localhostSocket, conn.browserSocket];

    if (term === "FIN") {
      t.assert.strictEqual(socket2.readyState, "open");
      t.assert.strictEqual(socket1.readyState, "open");
      socket1.end();
      // socket1 sent FIN, but socket2 didn't receive it yet
      t.assert.strictEqual(socket2.readyState, "open");
      t.assert.strictEqual(socket1.readyState, "readOnly");
      await Promise.all([
        new Promise<void>((resolve) => {
          socket2.on("end", () => {
            // socket1 sent FIN and socket2 received it
            t.assert.strictEqual(socket2.readyState, "writeOnly");
            t.assert.strictEqual(socket1.readyState, "readOnly");
            resolve();
          });
        }),
        new Promise<void>((resolve) => {
          socket2.on("close", (hasError) => {
            t.assert.strictEqual(hasError, false);
            t.assert.strictEqual(socket2.errored, null);
            t.assert.strictEqual(socket2.readyState, "closed");
            resolve();
          });
        }),
        new Promise<void>((resolve) => {
          socket1.on("close", (hasError) => {
            t.assert.strictEqual(hasError, false);
            t.assert.strictEqual(socket1.errored, null);
            t.assert.strictEqual(socket1.readyState, "closed");
            resolve();
          });
        }),
      ]);
      const socket1data = this.dataReceived.get(socket1);
      const socket2data = this.dataReceived.get(socket2);
      // Make sure last byte was successfully communicated in half-open state
      t.assert.strictEqual(socket1data, socket2data + "z");
    } else if (term == "RST") {
      socket1.resetAndDestroy();
      t.assert.strictEqual(socket1.readyState, "closed");
      t.assert.strictEqual(socket2.readyState, "open");
      await Promise.all([
        new Promise<void>((resolve) => {
          socket2.on("error", (err) => {
            t.assert.strictEqual(err["code"], "ECONNRESET");
            t.assert.strictEqual(socket2.readyState, "closed");
            t.assert.strictEqual(socket2.destroyed, true);
            resolve();
          });
        }),
        new Promise<void>((resolve) => {
          socket1.on("close", (hasError) => {
            // No error on our end because we initiated the RST
            t.assert.strictEqual(hasError, false);
            t.assert.strictEqual(socket1.readyState, "closed");
            t.assert.strictEqual(socket1.destroyed, true);
            resolve();
          });
        }),
      ]);
    }
  }
}

await test.only(
  "basic connection and termination",
  { timeout: 10000 },
  async (t) => {
    const net = new NetworkEmulator(LOCAL_PORT, PROXY_TEST_PORT);
    const server = new TunnelServer(serverOptions);
    const client = new TunnelClient(clientOptions);
    server.start();
    client.start();
    await server.waitUntilListening();
    await client.waitUntilConnected();
    await server.waitUntilConnected();
    await net.startAndWaitUntilReady();
    for (const term of ["FIN", "RST"] satisfies ("FIN" | "RST")[]) {
      for (const by of ["browser", "localhost"] satisfies (
        | "browser"
        | "localhost"
      )[]) {
        for (const proxyPort of [LOCAL_PORT, PROXY_TEST_PORT, PROXY_PORT]) {
          // if (term !== "RST" || by !== "browser" || proxyPort !== PROXY_PORT) {
          //   continue;
          // }
          // clean termination by browser RST on 14004
          console.log(`clean termination by ${by} ${term} on ${proxyPort}`);
          const echoServer = new EchoServer(LOCAL_PORT, proxyPort);
          await echoServer.startAndWaitUntilReady();
          // Test single
          await echoServer.testConn(t, 1, term, by, 0);
          await echoServer.testConn(t, 4, term, by, 0);
          // Test double simultaneous
          await Promise.all([
            echoServer.testConn(t, 3, term, by, 0),
            echoServer.testConn(t, 3, term, by, 0),
          ]);
          // Test triple delayed
          await Promise.all([
            echoServer.testConn(t, 4, term, by, 0),
            echoServer.testConn(t, 4, term, by, 10),
            echoServer.testConn(t, 4, term, by, 100),
          ]);
          await echoServer.stopAndWaitUntilClosed();
        }
      }
    }

    await net.stopAndWaitUntilClosed();
    await client.stop();
    await server.stop();
  },
);

await test("happy-path", { timeout: 5000 }, async (t) => {
  const echo = new EchoServer(LOCAL_PORT, PROXY_PORT);
  await echo.startAndWaitUntilReady();

  const server = new TunnelServer(serverOptions);
  const client = new TunnelClient({
    ...clientOptions,
    tunnelPort: TUNNEL_TEST_PORT,
  });
  server.start();

  // Make a request too early
  await echo.expectEconn();

  await server.waitUntilListening();
  const net = new NetworkEmulator(TUNNEL_PORT, TUNNEL_TEST_PORT);
  await net.startAndWaitUntilReady();
  client.start();

  // Make a request too early
  await echo.expectEconn();

  // Wait until client is connected and test 200
  await client.waitUntilConnected();
  // Make two simultaneous slow requests
  await Promise.all([
    echo.expectPingPongAndClose(t),
    echo.expectPingPongAndClose(t),
  ]);

  // Restart server while client is running
  await server.stop();
  server.start();
  await echo.expectEconn();
  await server.waitUntilListening();

  // Make sure client reconnected and request succeeds
  await echo.expectEconn();
  await client.waitUntilConnected();
  await echo.expectPingPongAndClose(t);

  // Restart client while server is running
  await client.stop();
  client.start();
  // Wait until client reconnected and make a request
  await echo.expectEconn();

  await client.waitUntilConnected();
  await echo.expectPingPongAndClose(t);

  // Break tunnel while no requests are taking place
  net.incomingSocket!.resetAndDestroy();
  net.outgoingSocket!.resetAndDestroy();
  await sleep(10);
  await echo.expectEconn();

  // Wait until client reconnected and make a request
  await client.waitUntilConnected();
  await echo.expectPingPongAndClose(t);

  // Break tunnel during a request but before response headers could be sent
  const promise1 = echo.expectEconn();
  await sleep(10);
  net.incomingSocket!.resetAndDestroy();
  net.outgoingSocket!.resetAndDestroy();
  await sleep(10);
  await promise1;

  await client.stop();
  await server.stop();
  await echo.stopAndWaitUntilClosed();
  await net.stopAndWaitUntilClosed();
});

await test("garbage-to-client", { timeout: 5000 }, async (t: TestContext) => {
  const echoServer = new EchoServer(LOCAL_PORT, PROXY_PORT);
  await echoServer.startAndWaitUntilReady();
  const stopBadServer = await createBadTlsServer(TUNNEL_PORT);
  const client = new TunnelClient(clientOptions);
  client.start();

  // Still no connection after a second
  await sleep(1000);
  await echoServer.expectEconn();
  t.assert.strictEqual(client.state, "listening");

  // Let the network recover and make a successful connection
  await stopBadServer();
  const server = new TunnelServer(serverOptions);
  server.start();

  await client.waitUntilConnected();
  await echoServer.expectPingPongAndClose(t);

  await client.stop();
  await server.stop();
  await echoServer.stopAndWaitUntilClosed();
});

await test("garbage-to-server", { timeout: 5000 }, async (t: TestContext) => {
  const echoServer = new EchoServer(LOCAL_PORT, PROXY_PORT);
  await echoServer.startAndWaitUntilReady();
  const server = new TunnelServer(serverOptions);
  server.start();
  await server.waitUntilListening();

  // Still no connection after a second
  const stopBadClient = await createBadTlsClient(TUNNEL_PORT);
  await sleep(1000);
  await echoServer.expectEconn();
  t.assert.strictEqual(server.state, "listening");

  // Let the network recover and make a successful connection
  await stopBadClient();
  const client = new TunnelClient(clientOptions);
  client.start();
  await server.waitUntilConnected();
  await echoServer.expectPingPongAndClose(t);

  await client.stop();
  await server.stop();
  await echoServer.stopAndWaitUntilClosed();
});
