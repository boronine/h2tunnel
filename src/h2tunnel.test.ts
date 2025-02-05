import { test, TestContext } from "node:test";
import assert from "node:assert";
import net from "node:net";
import {
  ClientOptions,
  LogLine,
  ServerOptions,
  Stoppable,
  TunnelClient,
  TunnelServer,
} from "./h2tunnel.js";

// localhost echo server
const LOCAL_PORT = 15000;
// localhost echo server passed through network emulator
const LOCAL2_PORT = 15007;

// remote public echo server forwarded by h2tunnel
const PROXY_PORT = 15004;

// remote TLS server for establishing a tunnel
const TUNNEL_PORT = 15005;
// remote TLS server for establishing a tunnel passed through network emulator
const TUNNEL2_PORT = 15008;

// Reduce this to make tests faster
const TIME_MULTIPLIER = 0.2;

// This keypair is issued for example.com: openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:secp384r1 -days 3650 -nodes -keyout h2tunnel.key -out h2tunnel.crt -subj "/CN=example.com"

const CLIENT_KEY_EXAMPLECOM = `-----BEGIN PRIVATE KEY-----
MIG2AgEAMBAGByqGSM49AgEGBSuBBAAiBIGeMIGbAgEBBDCDzcLnOqzvCrnUyd4P
1QcIG/Xi/VPpA5dVIwPVkutr9y/wZo3aJsYUX5xExQMsEeihZANiAAQfSPquV3P/
uhHm2D5czJoFyldutJrQswri0brL99gHSsOmQ34cH7bddcSTVToAZfwkv2yEZPNf
eLM7tASBpINt8uuOjJhCp034thS1V0HH/qDEHzEfy5wZEDrwevuzD+k=
-----END PRIVATE KEY-----`;

const CLIENT_CRT_EXAMPLECOM = `-----BEGIN CERTIFICATE-----
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

// This keypair is issued for localhost: openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:secp384r1 -days 3650 -nodes -keyout h2tunnel.key -out h2tunnel.crt -subj "/CN=localhost"

const CLIENT_KEY_LOCALHOST = `-----BEGIN PRIVATE KEY-----
MIG2AgEAMBAGByqGSM49AgEGBSuBBAAiBIGeMIGbAgEBBDDittBDK95KNEY62DbX
7YdaqtpqEVJLt+6fg1CIhkbDd8ZtrZLF98d8o0qTBJyr/xuhZANiAAShciJg7L29
VczOqPMG1YmTOh5t9ZfEwCQRqaQcUuilm5uFGf4eZbx3cyc3YypvjONIykSMPShM
NeCoOEX13zU5d5vJb01zEpBijunhS0/YD08kmLvq7S8pR6TPlzCiDqc=
-----END PRIVATE KEY-----`;

const CLIENT_CRT_LOCALHOST = `-----BEGIN CERTIFICATE-----
MIIBujCCAUCgAwIBAgIUB/l/jY39X+YnVsApRJ2qF7fLYlYwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI1MDIwNTA5NDAzOVoXDTM1MDIwMzA5
NDAzOVowFDESMBAGA1UEAwwJbG9jYWxob3N0MHYwEAYHKoZIzj0CAQYFK4EEACID
YgAEoXIiYOy9vVXMzqjzBtWJkzoebfWXxMAkEamkHFLopZubhRn+HmW8d3MnN2Mq
b4zjSMpEjD0oTDXgqDhF9d81OXebyW9NcxKQYo7p4UtP2A9PJJi76u0vKUekz5cw
og6no1MwUTAdBgNVHQ4EFgQUrs/3sLZ2MxxLsg2iFxSp8XCi1SgwHwYDVR0jBBgw
FoAUrs/3sLZ2MxxLsg2iFxSp8XCi1SgwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjO
PQQDAgNoADBlAjEAxuAidOxI5IHINYbBTRPugLuEQssk2ofAc9RxlyOyyBbNKswL
NIO0NAnTpBdpTWf0AjB79TWx1dVF1WKTUOfO7taYmjj5NTwwPvjfQVuP1zMGpxd0
5H/5nMUHDime5raC/gw=
-----END CERTIFICATE-----`;

type LogLineTest =
  | LogLine
  | "sending garbage"
  | "networkEmulator connection"
  | "localhost connection"
  | `${"recv" | "send"} ${number | "FIN"}`
  | `listening on ${number}`
  | "connecting"
  | "send RST"
  | `error ${string}`;

let LOG_LINES: string[] = [];

type LogName =
  | "client"
  | "server"
  | "bad-tls"
  | "network"
  | "origin"
  | "browser";

const getLogger = (name: LogName, colorCode: number) => (line: LogLineTest) => {
  process.stdout.write(`${name.padEnd(10)} \x1b[${colorCode}m${line}\x1b[0m\n`);
  if (name === "client" || name === "server") {
    LOG_LINES.push(`${name}   ${line}`);
  }
};

const serverOptions: ServerOptions = {
  logger: getLogger("server", 32),
  key: CLIENT_KEY_EXAMPLECOM,
  cert: CLIENT_CRT_EXAMPLECOM,
  tunnelListenIp: "::1",
  tunnelListenPort: TUNNEL_PORT,
  proxyListenIp: "::1",
  proxyListenPort: PROXY_PORT,
};

const clientOptions: ClientOptions = {
  logger: getLogger("client", 33),
  key: CLIENT_KEY_EXAMPLECOM,
  cert: CLIENT_CRT_EXAMPLECOM,
  tunnelHost: "::1",
  tunnelPort: TUNNEL_PORT,
  originHost: "::1",
  originPort: LOCAL_PORT,
  tunnelRestartTimeout: 5000 * TIME_MULTIPLIER,
};

function assertLastLines(
  expectedLines: `${"client" | "server"}   ${LogLineTest}`[],
) {
  // get last lines
  const actual = LOG_LINES.join("\n");
  LOG_LINES = [];
  const expected = expectedLines
    .join("\n")
    .replaceAll(".", "\\.")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]")
    .replaceAll("*", ".*")
    .replaceAll("00", "\\d+");
  assert.match(actual, RegExp("^" + expected + "$"));
}

type Conn = { browserSocket: net.Socket; originSocket: net.Socket };

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms * TIME_MULTIPLIER));
}

async function createBadTlsServer(port: number): Promise<() => Promise<void>> {
  const stoppable = new Stoppable();
  const server = net.createServer();
  stoppable.addCloseable(server);
  const logger = getLogger("bad-tls", 34);
  server.on("connection", (socket) => {
    stoppable.addDestroyable(socket);
    logger("sending garbage");
    socket.write("bad TLS handshake");
  });
  server.listen(port);
  await new Promise<void>((resolve) =>
    server.on("listening", () => {
      logger(`listening on ${port}`);
      resolve();
    }),
  );
  return () => stoppable.stop();
}

async function createBadTlsClient(port: number): Promise<() => Promise<void>> {
  const stoppable = new Stoppable();
  const socket = net.createConnection(port);
  stoppable.addDestroyable(socket);
  const logger = getLogger("bad-tls", 34);
  socket.on("connect", () => {
    logger("sending garbage");
    socket.write("bad TLS handshake");
  });
  return () => stoppable.stop();
}

interface NetworkEmulatorParams {
  listenHost: string;
  listenPort: number;
  forwardHost: string;
  forwardPort: number;
}

class NetworkEmulator extends Stoppable {
  incomingSocket: net.Socket | null = null;
  outgoingSocket: net.Socket | null = null;

  constructor(
    readonly params: NetworkEmulatorParams,
    readonly server = net.createServer({ allowHalfOpen: true }),
    readonly logger = getLogger("network", 31),
  ) {
    super();
  }

  async startAndWaitUntilReady() {
    this.addCloseable(this.server);
    return new Promise<void>((resolve) => {
      this.server.on("connection", (incomingSocket: net.Socket) => {
        this.addDestroyable(incomingSocket);
        this.incomingSocket = incomingSocket;
        const outgoingSocket = net.createConnection({
          host: this.params.forwardHost,
          port: this.params.forwardPort,
          allowHalfOpen: true,
        });
        this.addDestroyable(outgoingSocket);
        this.outgoingSocket = outgoingSocket;
        this.logger("networkEmulator connection");
        outgoingSocket.on("error", () => incomingSocket.resetAndDestroy());
        incomingSocket.on("error", () => outgoingSocket.resetAndDestroy());
        incomingSocket.pipe(outgoingSocket);
        outgoingSocket.pipe(incomingSocket);
      });
      this.server.on("listening", () => resolve());
      this.server.listen(this.params.listenPort, this.params.listenHost);
    });
  }
}

interface EndToEndTestParams {
  originListenHost: string;
  originListenPort: number;
  proxyHost: string;
  proxyPort: number;
}

const DEFAULT_PARAMS: EndToEndTestParams = {
  originListenHost: "::1",
  originListenPort: LOCAL_PORT,
  proxyHost: "::1",
  proxyPort: PROXY_PORT,
};

class EchoOriginAndBrowser extends Stoppable {
  readonly dataReceived: Map<net.Socket, string> = new Map();
  private i = 0;

  constructor(
    readonly params: EndToEndTestParams = DEFAULT_PARAMS,
    readonly loggerOrigin = getLogger("origin", 35),
    readonly loggerBrowser = getLogger("browser", 36),
    readonly server = net.createServer({ allowHalfOpen: true }),
  ) {
    super();
    this.server.on("connection", (socket) => {
      this.addDestroyable(socket);
      loggerOrigin("localhost connection");
      socket.on("error", (err) => {
        loggerOrigin(`error ${err.toString()}`);
      });
      socket.on("data", (data) => {
        this.loggerOrigin(`recv ${data.length}`);
        this.appendData(socket, data);
        if (!socket.writableEnded) {
          this.loggerOrigin(`send ${data.length}`);
          socket.write(data);
        }
      });
      // Make sure other end stays half-open long enough to receive the last byte
      socket.on("end", async () => {
        loggerOrigin("recv FIN");
        this.setTimeout(() => {
          this.loggerOrigin(`send 1`);
          this.loggerOrigin(`send FIN`);
          socket.end("z");
        }, 500 * TIME_MULTIPLIER);
      });
    });
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

  async startAndWaitUntilListening() {
    this.addCloseable(this.server);
    this.server.listen(this.params.originListenPort);
    await new Promise<void>((resolve) =>
      this.server.on("listening", () => {
        this.loggerOrigin(`listening on ${this.params.originListenPort}`);
        resolve();
      }),
    );
  }

  createClientSocket(): net.Socket {
    this.loggerBrowser("connecting");
    const socket = net.createConnection({
      host: this.params.proxyHost,
      port: this.params.proxyPort,
      allowHalfOpen: true,
    });
    this.addDestroyable(socket);
    socket.on("data", (chunk) => this.appendData(socket, chunk));
    // Make sure other end stays half-open long enough to receive the last byte
    socket.on("end", () => {
      this.setTimeout(() => socket.end("z"), 100 * TIME_MULTIPLIER);
    });
    return socket;
  }

  async expectEconn() {
    return new Promise<void>((resolve, reject) => {
      const socket = this.createClientSocket();
      socket.on("error", () => {});
      socket.on("close", (hadError) => {
        if (hadError) {
          this.loggerBrowser(`error ${socket.errored}`);
          resolve();
        } else {
          reject(new Error("Unexcpected success"));
        }
      });
    });
  }

  async expectPingPongAndClose() {
    const conn = await this.createConn();
    conn.browserSocket.end();
    await new Promise((resolve) => conn.browserSocket.on("close", resolve));
  }

  async createConn(): Promise<Conn> {
    const browserSocket = this.createClientSocket();
    const id = (this.i++).toString();
    await new Promise<void>((resolve) => browserSocket.on("connect", resolve));
    // Send ID byte and wait for it to come back
    await new Promise<void>((resolve) => {
      browserSocket.once("data", (chunk) => {
        assert.strictEqual(chunk.toString(), id);
        resolve();
      });
      browserSocket.write(id);
    });
    await sleep(100);
    const originSocket = this.getSocketByPrefix(id);
    return { browserSocket, originSocket };
  }

  async testConn(
    numBytes: number,
    term: "FIN" | "RST",
    by: "browser" | "localhost",
    delay: number = 0,
  ) {
    await sleep(delay);
    const conn = await this.createConn();
    // send 1, recv 1, send 1, recv 1, etc.
    for (let i = 0; i < numBytes; i++) {
      await new Promise<void>((resolve) => {
        conn.originSocket.once("data", (pong) => {
          assert.strictEqual(pong.toString(), "a");
          resolve();
        });
        conn.browserSocket.write("a");
      });
      await sleep(50);
    }

    const [socket1, socket2] =
      by === "browser"
        ? [conn.browserSocket, conn.originSocket]
        : [conn.originSocket, conn.browserSocket];

    if (term === "FIN") {
      assert.strictEqual(socket2.readyState, "open");
      assert.strictEqual(socket1.readyState, "open");
      socket1.end();
      // socket1 sent FIN, but socket2 didn't receive it yet
      assert.strictEqual(socket2.readyState, "open");
      assert.strictEqual(socket1.readyState, "readOnly");
      await Promise.all([
        new Promise<void>((resolve) => {
          socket2.on("end", () => {
            // socket1 sent FIN and socket2 received it
            assert.strictEqual(socket2.readyState, "writeOnly");
            assert.strictEqual(socket1.readyState, "readOnly");
            resolve();
          });
        }),
        new Promise<void>((resolve) => {
          socket2.on("close", (hasError) => {
            assert.strictEqual(hasError, false);
            assert.strictEqual(socket2.errored, null);
            assert.strictEqual(socket2.readyState, "closed");
            resolve();
          });
        }),
        new Promise<void>((resolve) => {
          socket1.on("close", (hasError) => {
            assert.strictEqual(hasError, false);
            assert.strictEqual(socket1.errored, null);
            assert.strictEqual(socket1.readyState, "closed");
            resolve();
          });
        }),
      ]);
      const socket1data = this.dataReceived.get(socket1);
      const socket2data = this.dataReceived.get(socket2);
      // Make sure last byte was successfully communicated in half-open state
      assert.strictEqual(socket1data, socket2data + "z");
    } else if (term == "RST") {
      if (by === "browser") {
        this.loggerBrowser("send RST");
      } else {
        this.loggerOrigin("send RST");
      }
      socket1.resetAndDestroy();
      assert.strictEqual(socket1.readyState, "closed");
      assert.strictEqual(socket2.readyState, "open");
      await Promise.all([
        new Promise<void>((resolve) => {
          socket2.on("error", (err) => {
            assert.strictEqual(err["code"], "ECONNRESET");
            assert.strictEqual(socket2.readyState, "closed");
            assert.strictEqual(socket2.destroyed, true);
            resolve();
          });
        }),
        new Promise<void>((resolve) => {
          socket1.on("close", (hasError) => {
            // No error on our end because we initiated the RST
            assert.strictEqual(hasError, false);
            assert.strictEqual(socket1.readyState, "closed");
            assert.strictEqual(socket1.destroyed, true);
            resolve();
          });
        }),
      ]);
    }
  }
}

async function withClientAndServer(
  clientOverrides: Partial<ClientOptions>,
  serverOverrides: Partial<ServerOptions>,
  func: (client: TunnelClient, server: TunnelServer) => Promise<void>,
) {
  LOG_LINES = [];
  const server = new TunnelServer({ ...serverOptions, ...serverOverrides });
  server.start();
  await server.waitUntilListening();
  const client = new TunnelClient({ ...clientOptions, ...clientOverrides });
  client.start();
  await server.waitUntilConnected();

  // assertLastLines([
  //   "server   listening",
  //   "client   connecting",
  //   "client   connected to *:00 from *:00",
  //   "server   connected to *:00 from *:00",
  // ]);

  await func(client, server);

  await client.stop();
  await server.stop();
}

async function runTests(params: EndToEndTestParams) {
  for (const term of ["FIN", "RST"] satisfies ("FIN" | "RST")[]) {
    for (const by of ["browser", "localhost"] satisfies (
      | "browser"
      | "localhost"
    )[]) {
      console.log(
        `clean termination by ${by} ${term} on ${params.proxyHost}:${params.proxyPort}`,
      );
      const echoServer = new EchoOriginAndBrowser(params);
      await echoServer.startAndWaitUntilListening();
      // Test single
      await echoServer.testConn(1, term, by, 0);
      await echoServer.testConn(4, term, by, 0);
      // Test double simultaneous
      await Promise.all([
        echoServer.testConn(3, term, by, 0),
        echoServer.testConn(3, term, by, 0),
      ]);
      // Test triple delayed
      await Promise.all([
        echoServer.testConn(4, term, by, 0),
        echoServer.testConn(4, term, by, 10),
        echoServer.testConn(4, term, by, 100),
      ]);
      await echoServer.stop();
    }
  }
}

// --------------------------------------------------------------------------------------------------------
// TESTS

await test.only("localhost and non-localhost key/crt pairs", {}, async () => {
  // Localhost certificate support is ensured by this option: https://nodejs.org/api/tls.html#tlsconnectoptions-callback
  const PAIRS: Partial<ClientOptions>[] = [
    { key: CLIENT_KEY_EXAMPLECOM, cert: CLIENT_CRT_EXAMPLECOM },
    { key: CLIENT_KEY_LOCALHOST, cert: CLIENT_CRT_LOCALHOST },
  ];
  for (const pair of PAIRS) {
    await withClientAndServer(pair, pair, async () => {
      const echoServer = new EchoOriginAndBrowser();
      await echoServer.startAndWaitUntilListening();
      await echoServer.expectPingPongAndClose();
      await echoServer.stop();
    });
  }
});

await test("logging test", { timeout: 10000 }, async () => {
  await withClientAndServer({}, {}, async () => {
    const echoServer = new EchoOriginAndBrowser();
    await echoServer.startAndWaitUntilListening();

    LOG_LINES = [];
    await echoServer.testConn(0, "FIN", "browser", 0);
    assertLastLines([
      "server   stream0 forwarded from [::1]:00",
      // Browser sends ID byte
      "server   stream0 send 1",
      "client   stream0 forwarding to [::1]:00",
      "client   stream0 recv 1",
      // Localhost sends ID byte back
      "client   stream0 send 1",
      "server   stream0 recv 1",
      // Browser sends FIN
      "server   stream0 send FIN",
      "client   stream0 recv FIN",
      // Localhost received FIN and is now write-only, it sends last byte and FIN
      "client   stream0 send 1",
      "client   stream0 send FIN",
      "client   stream0 closed",
      // Browser recieves last byte and FIN
      "server   stream0 recv 1",
      "server   stream0 recv FIN",
      "server   stream0 closed",
    ]);

    await echoServer.testConn(0, "FIN", "localhost", 0);
    assertLastLines([
      "server   stream0 forwarded from [::1]:00",
      // Browser sends ID byte
      "server   stream0 send 1",
      "client   stream0 forwarding to [::1]:00",
      "client   stream0 recv 1",
      // Localhost sends ID byte back
      "client   stream0 send 1",
      "server   stream0 recv 1",
      // Localhost sends FIN
      "client   stream0 send FIN",
      "server   stream0 recv FIN",
      // Browser received FIN and is now write-only, it sends last byte and FIN
      "server   stream0 send 1",
      "server   stream0 send FIN",
      "server   stream0 closed",
      // Localhost recieves last byte and FIN
      "client   stream0 recv 1",
      "client   stream0 recv FIN",
      "client   stream0 closed",
    ]);

    await echoServer.testConn(0, "RST", "browser", 0);
    assertLastLines([
      "server   stream0 forwarded from [::1]:00",
      // Browser sends ID byte
      "server   stream0 send 1",
      "client   stream0 forwarding to [::1]:00",
      "client   stream0 recv 1",
      // Localhost sends ID byte back
      "client   stream0 send 1",
      "server   stream0 recv 1",
      // Browser breaks connection
      "server   stream0 error *",
      "server   stream0 send RST",
      "server   stream0 closed",
      // Localhost receives RST
      "client   stream0 recv RST",
      "client   stream0 closed",
    ]);

    await echoServer.testConn(0, "RST", "localhost", 0);
    assertLastLines([
      "server   stream0 forwarded from [::1]:00",
      // Browser sends ID byte
      "server   stream0 send 1",
      "client   stream0 forwarding to [::1]:00",
      "client   stream0 recv 1",
      // Localhost sends ID byte back
      "client   stream0 send 1",
      "server   stream0 recv 1",
      // Browser breaks connection
      "client   stream0 error *",
      "client   stream0 send RST",
      "client   stream0 closed",
      // Localhost receives RST
      "server   stream0 recv RST",
      "server   stream0 closed",
    ]);

    await echoServer.stop();
  });
});

await test("basic connection and termination", { timeout: 20000 }, async () => {
  for (const localIp of ["127.0.0.1", "::1"]) {
    // Run EchoServer tests without proxy or tunnel
    await runTests({
      originListenHost: localIp,
      originListenPort: LOCAL_PORT,
      proxyHost: localIp,
      proxyPort: LOCAL_PORT,
    });

    // Test NetworkEmulator using EchoServer
    const net = new NetworkEmulator({
      listenHost: localIp,
      listenPort: LOCAL2_PORT,
      forwardHost: localIp,
      forwardPort: LOCAL_PORT,
    });
    await net.startAndWaitUntilReady();
    await runTests({
      originListenHost: localIp,
      originListenPort: LOCAL_PORT,
      proxyHost: localIp,
      proxyPort: LOCAL2_PORT,
    });
    await net.stop();

    // Test EchoServer through default tunnel
    await withClientAndServer(
      {
        originHost: localIp,
        tunnelHost: localIp,
      },
      {
        tunnelListenIp: localIp,
        proxyListenIp: localIp,
      },
      () =>
        runTests({
          originListenHost: localIp,
          originListenPort: LOCAL_PORT,
          proxyHost: localIp,
          proxyPort: PROXY_PORT,
        }),
    );
  }
});

await test("happy-path1", { timeout: 5000 }, async (t: TestContext) => {
  LOG_LINES = [];
  const server = new TunnelServer(serverOptions);
  const client = new TunnelClient(clientOptions);
  const echo = new EchoOriginAndBrowser();
  await echo.startAndWaitUntilListening();

  await t.test("try using tunnel before it is ready", async () => {
    server.start();

    // Make a request before server is listening
    await echo.expectEconn();

    assertLastLines([
      "server   listening",
      "server   rejecting connection from [::1]:00",
    ]);

    await server.waitUntilListening();
    client.start();

    // Make a request after server is listening but before tunnel is established
    await echo.expectEconn();

    await client.waitUntilConnected();
    await server.waitUntilConnected();

    assertLastLines([
      "client   connecting",
      "server   rejecting connection from [::1]:00",
      `client   connected to [::1]:${TUNNEL_PORT} from [::1]:00`,
      `server   connected to [::1]:${TUNNEL_PORT} from [::1]:00`,
    ]);
  });

  await t.test("send data back and forth", async () => {
    // Make one request
    await echo.expectPingPongAndClose();

    assertLastLines([
      "server   stream0 forwarded from [::1]:00",
      "server   stream0 send 1",
      "client   stream0 forwarding to [::1]:00",
      "client   stream0 recv 1",
      "client   stream0 send 1",
      "server   stream0 recv 1",
      "server   stream0 send FIN",
      "client   stream0 recv FIN",
      "client   stream0 send 1",
      "client   stream0 send FIN",
      "client   stream0 closed",
      "server   stream0 recv 1",
      "server   stream0 recv FIN",
      "server   stream0 closed",
    ]);

    await echo.stop();
    await client.stop();
    await sleep(50);

    assertLastLines([
      "client   stopping",
      "client   disconnected",
      "client   stopped",
      "server   disconnected",
    ]);

    await server.stop();

    assertLastLines(["server   stopping", "server   stopped"]);
  });
});

await test("happy-path2", { timeout: 5000 }, async () => {
  LOG_LINES = [];
  const echo = new EchoOriginAndBrowser();
  const net = new NetworkEmulator({
    listenHost: "::1",
    listenPort: TUNNEL2_PORT,
    forwardHost: "::1",
    forwardPort: TUNNEL_PORT,
  });
  const server = new TunnelServer(serverOptions);
  const client = new TunnelClient({
    ...clientOptions,
    tunnelPort: TUNNEL2_PORT,
  });

  await echo.startAndWaitUntilListening();
  await net.startAndWaitUntilReady();

  server.start();
  await server.waitUntilListening();

  // Wait until client is connected and test 200
  client.start();
  await client.waitUntilConnected();
  await server.waitUntilConnected();

  assertLastLines([
    "server   listening",
    "client   connecting",
    `client   connected to [::1]:${TUNNEL2_PORT} from [::1]:00`,
    `server   connected to [::1]:${TUNNEL_PORT} from [::1]:00`,
  ]);

  // Make one request
  await echo.expectPingPongAndClose();

  assertLastLines([
    "server   stream0 forwarded from [::1]:00",
    "server   stream0 send 1",
    "client   stream0 forwarding to [::1]:00",
    "client   stream0 recv 1",
    "client   stream0 send 1",
    "server   stream0 recv 1",
    "server   stream0 send FIN",
    "client   stream0 recv FIN",
    "client   stream0 send 1",
    "client   stream0 send FIN",
    "client   stream0 closed",
    "server   stream0 recv 1",
    "server   stream0 recv FIN",
    "server   stream0 closed",
  ]);

  // Make two simultaneous slow requests
  await Promise.all([
    echo.expectPingPongAndClose(),
    sleep(10).then(() => echo.expectPingPongAndClose()),
  ]);

  // NOTE: Log lines are unreliable here
  LOG_LINES = [];

  // Restart server while client is running
  await server.stop();
  await echo.expectEconn();
  await sleep(6000);
  server.start();
  await server.waitUntilConnected();

  assertLastLines([
    "server   stopping",
    "server   disconnected",
    "server   stopped",
    "client   disconnected",
    "client   restarting",
    "client   tunnel error read ECONNRESET",
    "server   listening",
    "client   restarting",
    `client   connected to [::1]:${TUNNEL2_PORT} from [::1]:00`,
    `server   connected to [::1]:${TUNNEL_PORT} from [::1]:00`,
  ]);

  // Make sure client reconnected and request succeeds
  await echo.expectPingPongAndClose();
  LOG_LINES = [];

  // Restart client while server is running
  await client.stop();
  client.start();

  // Wait until client reconnected and make a request
  await echo.expectEconn();
  await server.waitUntilConnected();

  assertLastLines([
    "client   stopping",
    "client   disconnected",
    "client   stopped",
    "client   connecting",
    "server   stream0 forwarded from [::1]:00",
    "server   stream0 recv RST",
    "server   stream0 closed",
    "server   disconnected",
    `client   connected to [::1]:${TUNNEL2_PORT} from [::1]:00`,
    `server   connected to [::1]:${TUNNEL_PORT} from [::1]:00`,
  ]);

  await echo.expectPingPongAndClose();

  LOG_LINES = [];

  // Break tunnel while no requests are taking place
  net.incomingSocket!.resetAndDestroy();
  net.outgoingSocket!.resetAndDestroy();
  await sleep(100);
  await echo.expectEconn();

  assertLastLines([
    "client   tunnel error read ECONNRESET",
    "client   disconnected",
    "server   disconnected",
    "server   rejecting connection from [::1]:00",
  ]);

  // Wait until client reconnected and make a request
  await server.waitUntilConnected();
  await echo.expectPingPongAndClose();

  assertLastLines([
    "client   restarting",
    `client   connected to [::1]:${TUNNEL2_PORT} from [::1]:00`,
    `server   connected to [::1]:${TUNNEL_PORT} from [::1]:00`,
    "server   stream0 forwarded from [::1]:00",
    "server   stream0 send 1",
    "client   stream0 forwarding to [::1]:00",
    "client   stream0 recv 1",
    "client   stream0 send 1",
    "server   stream0 recv 1",
    "server   stream0 send FIN",
    "client   stream0 recv FIN",
    "client   stream0 send 1",
    "client   stream0 send FIN",
    "client   stream0 closed",
    "server   stream0 recv 1",
    "server   stream0 recv FIN",
    "server   stream0 closed",
  ]);

  // Break tunnel during a request
  const promise1 = echo.expectEconn();
  await sleep(5);
  net.incomingSocket!.resetAndDestroy();
  net.outgoingSocket!.resetAndDestroy();
  await sleep(10);
  await promise1;

  await client.stop();
  await server.stop();
  await echo.stop();
  await net.stop();
});

await test("garbage-to-client", { timeout: 5000 }, async () => {
  const echoServer = new EchoOriginAndBrowser();
  await echoServer.startAndWaitUntilListening();
  const stopBadServer = await createBadTlsServer(TUNNEL_PORT);
  const client = new TunnelClient(clientOptions);
  client.start();

  // Still no connection after a second
  await sleep(1000);
  await echoServer.expectEconn();
  assert.strictEqual(client.session, null);

  // Let the network recover and make a successful connection
  await stopBadServer();
  const server = new TunnelServer(serverOptions);
  server.start();

  await server.waitUntilConnected();
  await echoServer.expectPingPongAndClose();

  await client.stop();
  await server.stop();
  await echoServer.stop();
});

await test("garbage-to-server", { timeout: 5000 }, async () => {
  const echoServer = new EchoOriginAndBrowser();
  await echoServer.startAndWaitUntilListening();
  const server = new TunnelServer(serverOptions);
  server.start();
  await server.waitUntilListening();

  // Still no connection after a second
  const stopBadClient = await createBadTlsClient(TUNNEL_PORT);
  await sleep(1000);
  await echoServer.expectEconn();
  assert.strictEqual(server.session, null);

  // Let the network recover and make a successful connection
  await stopBadClient();
  const client = new TunnelClient(clientOptions);
  client.start();
  await server.waitUntilConnected();
  await echoServer.expectPingPongAndClose();

  await client.stop();
  await server.stop();
  await echoServer.stop();
});
