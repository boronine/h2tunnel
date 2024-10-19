import { test, TestContext } from "node:test";
import {
  ClientOptions,
  ServerOptions,
  TunnelClient,
  TunnelServer,
} from "./h2tunnel.js";
import net from "node:net";

// localhost HTTP1 server "python3 -m http.server"
const LOCAL_PORT = 14000;
// localhost HTTP2 server that proxies to localhost HTTP1 server
const DEMUX_PORT = 14003;

// remote public HTTP1 server
const PROXY_PORT = 14004;
const PROXY_TEST_PORT = 14007;
// remote TLS server for establishing a tunnel
const TUNNEL_PORT = 14005;
// remote HTTPS server that is piped through the tunnel to localhost
const MUX_PORT = 14006;

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
  tunnelRestartTimeout: 500,
};

type Conn = { clientSocket: net.Socket; originSocket: net.Socket };

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    readonly originPort: number,
    readonly proxyPort: number,
    readonly server = net.createServer(),
    readonly logger = getLogger("network", 31),
    readonly abortController = new AbortController(),
  ) {}

  async startAndWaitUntilReady() {
    return new Promise<void>((resolve) => {
      this.server.on("connection", (incomingSocket: net.Socket) => {
        this.incomingSocket = incomingSocket;
        const outgoingSocket = net.createConnection({
          host: "127.0.0.1",
          port: this.originPort,
        });
        this.outgoingSocket = outgoingSocket;
        outgoingSocket.on("error", () => incomingSocket.resetAndDestroy());
        incomingSocket.on("error", () => outgoingSocket.resetAndDestroy());
        this.logger({ server: "connection" });
        incomingSocket.pipe(outgoingSocket);
        outgoingSocket.pipe(incomingSocket);
      });
      this.server.on("listening", () => resolve());
      this.server.listen(this.proxyPort, "127.0.0.1");
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
    readonly logger = getLogger("localhost", 35),
  ) {
    const server = net.createServer();
    server.on("connection", (socket) => {
      logger({ echoServer: "connection" });
      socket.on("error", (err) => {
        logger({ echoServer: "error", err });
      });
      socket.on("data", (data) => {
        this.logger({
          echoServerData: data.toString(),
          socketWritableEnded: socket.writableEnded,
        });
        // Add to data received
        const previousData = this.dataReceived.get(socket) ?? "";
        this.dataReceived.set(socket, previousData + data.toString("utf-8"));

        if (!socket.writableEnded) {
          socket.write(data);
        }
      });
    });

    this.server = server;
  }

  // reset(proxyPort: number) {
  //   this.proxyPort = proxyPort;
  //   this.dataReceived.clear();
  //   this.i = 0;
  // }

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
        this.logger({ echoServer: "listening" });
        resolve();
      }),
    );
  }

  async stopAndWaitUntilClosed() {
    await new Promise((resolve) => this.server.close(resolve));
  }

  createClientSocket(): net.Socket {
    return net.createConnection(this.proxyPort);
  }

  async expectEconn() {
    return new Promise<void>((resolve) => {
      const socket = net.createConnection(this.proxyPort);
      socket.on("error", () => {
        resolve();
      });
    });
  }

  async expectPingPongAndClose(t: TestContext) {
    const conn = await this.createConn(t);
    await new Promise<void>((resolve) => {
      conn.originSocket.once("data", (pong) => {
        t.assert.strictEqual(pong.toString(), "a");
        // TODO: Test graceful destruction
        conn.clientSocket.resetAndDestroy();
        conn.originSocket.resetAndDestroy();
        resolve();
      });
      // ping
      const ping = "a";
      conn.clientSocket.write(ping);
    });
  }

  async createConn(t: TestContext): Promise<Conn> {
    const clientSocket = this.createClientSocket();
    const id = (this.i++).toString();
    new Promise<void>((resolve) => clientSocket.on("connect", resolve));
    // Expect id back
    await new Promise<void>((resolve) => {
      clientSocket.once("data", (chunk) => {
        t.assert.strictEqual(chunk.toString(), id);
        resolve();
      });
      clientSocket.write(id);
    });
    await sleep(100);
    const originSocket = this.getSocketByPrefix(id);
    return { clientSocket, originSocket };
  }
}

async function testConn(
  t: TestContext,
  server: EchoServer,
  numBytes: number,
  term: "FIN" | "RST",
  by: "client" | "server",
  delay: number = 0,
  strict = true,
) {
  await sleep(delay);
  const conn = await server.createConn(t);
  await t.test(
    `ping pong ${numBytes} byte(s)`,
    { plan: numBytes },
    async (t: TestContext) => {
      for (let i = 0; i < numBytes; i++) {
        await new Promise<void>((resolve) => {
          conn.originSocket.once("data", (pong) => {
            t.assert.strictEqual(pong.toString(), "a");
            resolve();
          });
          // ping
          const ping = "a";
          conn.clientSocket.write(ping);
        });
        await sleep(50);
      }
    },
  );

  const [socket1, socket2] =
    by === "client"
      ? [conn.clientSocket, conn.originSocket]
      : [conn.originSocket, conn.clientSocket];

  if (term === "FIN") {
    await t.test(
      `clean termination by ${by} FIN`,
      { plan: 12 },
      (t: TestContext) =>
        new Promise<void>((resolve) => {
          let i = 0;
          const done = () => i === 2 && resolve();
          t.assert.strictEqual(socket2.readyState, "open");
          t.assert.strictEqual(socket1.readyState, "open");
          socket2.on("end", () => {
            // Server sent FIN and client received it
            t.assert.strictEqual(socket2.readyState, "writeOnly");
            t.assert.strictEqual(
              socket1.readyState,
              strict ? "readOnly" : "closed",
            );
          });
          socket2.on("close", (hasError) => {
            t.assert.strictEqual(hasError, false);
            t.assert.strictEqual(socket2.errored, null);
            t.assert.strictEqual(socket2.readyState, "closed");
            i++;
            done();
          });
          socket1.on("close", (hasError) => {
            t.assert.strictEqual(hasError, false);
            t.assert.strictEqual(socket1.errored, null);
            t.assert.strictEqual(socket1.readyState, "closed");
            i++;
            done();
          });
          socket1.end();
          // Server sent FIN, but client didn't receive it yet
          t.assert.strictEqual(socket2.readyState, "open");
          t.assert.strictEqual(socket1.readyState, "readOnly");
        }),
    );
  } else if (term == "RST") {
    await t.test(
      `clean reset by ${by} RST`,
      { plan: 8 },
      (t: TestContext) =>
        new Promise<void>((resolve) => {
          let i = 0;
          const done = () => i === 2 && resolve();
          socket2.on("error", (err) => {
            t.assert.strictEqual(err["code"], "ECONNRESET");
            t.assert.strictEqual(socket2.readyState, "closed");
            t.assert.strictEqual(socket2.destroyed, true);
            i++;
            done();
          });
          socket1.on("close", (hasError) => {
            // No error on our end because we initiated the RST
            t.assert.strictEqual(hasError, false);
            t.assert.strictEqual(socket1.readyState, "closed");
            t.assert.strictEqual(socket1.destroyed, true);
            i++;
            done();
          });
          socket1.resetAndDestroy();
          t.assert.strictEqual(socket1.readyState, "closed");
          t.assert.strictEqual(socket2.readyState, "open");
        }),
    );
  }
}

await test("basic connection and termination", async (t) => {
  const net = new NetworkEmulator(LOCAL_PORT, PROXY_TEST_PORT);
  const server = new TunnelServer(serverOptions);
  const client = new TunnelClient(clientOptions);
  server.start();
  client.start();
  await server.waitUntilListening();
  await client.waitUntilConnected();
  await net.startAndWaitUntilReady();
  for (const term of ["FIN", "RST"] satisfies ("FIN" | "RST")[]) {
    for (const by of ["client", "server"] satisfies ("client" | "server")[]) {
      for (const numBytes of [1, 4]) {
        for (const proxyPort of [LOCAL_PORT, PROXY_TEST_PORT, PROXY_PORT]) {
          const echoServer = new EchoServer(LOCAL_PORT, proxyPort);
          await echoServer.startAndWaitUntilReady();
          const strict = proxyPort !== PROXY_PORT;
          // Test single
          await testConn(t, echoServer, numBytes, term, by, 0, strict);
          // Test double simultaneous
          await Promise.all([
            testConn(t, echoServer, numBytes, term, by, 0, strict),
            testConn(t, echoServer, numBytes, term, by, 0, strict),
          ]);
          // Test triple delayed
          await Promise.all([
            testConn(t, echoServer, numBytes, term, by, 0, strict),
            testConn(t, echoServer, numBytes, term, by, 10, strict),
            testConn(t, echoServer, numBytes, term, by, 100, strict),
          ]);
          await echoServer.stopAndWaitUntilClosed();
        }
      }
    }
  }

  await net.stopAndWaitUntilClosed();
  await client.stop();
  await server.stop();
});

await test.only("happy-path", async (t) => {
  const echo = new EchoServer(LOCAL_PORT, PROXY_PORT);
  await echo.startAndWaitUntilReady();

  const server = new TunnelServer(serverOptions);
  const client = new TunnelClient(clientOptions);
  server.start();

  // Make a request too early
  await echo.expectEconn();

  await server.waitUntilListening();
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
  client.tunnelSocket!.destroy();
  await sleep(10);
  await echo.expectEconn();

  // Wait until client reconnected and make a request
  await client.waitUntilConnected();
  await echo.expectPingPongAndClose(t);

  // Break tunnel during a request but before response headers could be sent
  const promise1 = echo.expectEconn();
  await sleep(10);
  client.tunnelSocket!.destroy();
  server.tunnelSocket!.destroy();
  await sleep(10);
  await promise1;

  await client.stop();
  await server.stop();
  await echo.stopAndWaitUntilClosed();
});

await test("garbage-to-client", async (t: TestContext) => {
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

await test("garbage-to-server", async (t: TestContext) => {
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
