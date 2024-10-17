import { test, TestContext } from "node:test";
import child_process from "node:child_process";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import stream from "node:stream";
import readline from "node:readline";
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
const TIME_MULTIPLIER = Number(process.env["TIME_MULTIPLIER"] ?? "0.1");

const TEST_TIMEOUT = 100000 * TIME_MULTIPLIER;

// This keypair is issued for example.com: openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:secp384r1 -days 3650 -nodes -keyout h2tunnel.key -out h2tunnel.crt -subj "/CN=example.com"

const TLS_KEY_EXAMPLECOM = `-----BEGIN PRIVATE KEY-----
MIG2AgEAMBAGByqGSM49AgEGBSuBBAAiBIGeMIGbAgEBBDCDzcLnOqzvCrnUyd4P
1QcIG/Xi/VPpA5dVIwPVkutr9y/wZo3aJsYUX5xExQMsEeihZANiAAQfSPquV3P/
uhHm2D5czJoFyldutJrQswri0brL99gHSsOmQ34cH7bddcSTVToAZfwkv2yEZPNf
eLM7tASBpINt8uuOjJhCp034thS1V0HH/qDEHzEfy5wZEDrwevuzD+k=
-----END PRIVATE KEY-----`;

const TLS_CRT_EXAMPLECOM = `-----BEGIN CERTIFICATE-----
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "h2tunnel-test-"));
const TLS_KEY_FILE = path.join(tmpDir, "h2tunnel.key");
const TLS_CRT_FILE = path.join(tmpDir, "h2tunnel.crt");
fs.writeFileSync(TLS_KEY_FILE, TLS_KEY_EXAMPLECOM);
fs.writeFileSync(TLS_CRT_FILE, TLS_CRT_EXAMPLECOM);

// This keypair is issued for localhost: openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:secp384r1 -days 3650 -nodes -keyout h2tunnel.key -out h2tunnel.crt -subj "/CN=localhost"

const TLS_KEY_LOCALHOST = `-----BEGIN PRIVATE KEY-----
MIG2AgEAMBAGByqGSM49AgEGBSuBBAAiBIGeMIGbAgEBBDDittBDK95KNEY62DbX
7YdaqtpqEVJLt+6fg1CIhkbDd8ZtrZLF98d8o0qTBJyr/xuhZANiAAShciJg7L29
VczOqPMG1YmTOh5t9ZfEwCQRqaQcUuilm5uFGf4eZbx3cyc3YypvjONIykSMPShM
NeCoOEX13zU5d5vJb01zEpBijunhS0/YD08kmLvq7S8pR6TPlzCiDqc=
-----END PRIVATE KEY-----`;

const TLS_CRT_LOCALHOST = `-----BEGIN CERTIFICATE-----
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
  | "connection"
  | `${"recv" | "send"} ${number | "FIN"}`
  | `listening on ${number}`
  | "send RST"
  | `error ${string}`;

let LOG_LINES: string[] = [];

type LogName =
  | "client"
  | "client1"
  | "client2"
  | "server"
  | "bad-tls"
  | "network"
  | "origin"
  | "browser";

type L = `${LogName}   ${LogLineTest}`;

function logPos() {
  try {
    throw new Error();
  } catch (e) {
    const line: string = e.stack.trim().split("\n")[2];
    const pos = line.match(/\((.*)\)/);
    console.log(pos?.[1]);
  }
}

const getLogger = (name: LogName, colorCode: number) => (line: LogLineTest) => {
  // process.stdout.write(`${name.padEnd(10)} \x1b[${colorCode}m${line}\x1b[0m\n`);
  if (
    name === "client" ||
    name === "client1" ||
    name === "client2" ||
    name === "server"
  ) {
    LOG_LINES.push(`${name}   ${line}`);
  }
};

const TIMEOUT = 5000;

const DEFAULT_SERVER_OPTIONS: ServerOptions = {
  logger: getLogger("server", 32),
  key: TLS_KEY_EXAMPLECOM,
  cert: TLS_CRT_EXAMPLECOM,
  tunnelListenIp: "::1",
  tunnelListenPort: TUNNEL_PORT,
  proxyListenIp: "::1",
  proxyListenPort: PROXY_PORT,
};

const DEFAULT_CLIENT_OPTIONS: ClientOptions = {
  logger: getLogger("client", 33),
  key: TLS_KEY_EXAMPLECOM,
  cert: TLS_CRT_EXAMPLECOM,
  tunnelHost: "::1",
  tunnelPort: TUNNEL_PORT,
  originHost: "::1",
  originPort: LOCAL_PORT,
  timeout: TIMEOUT * TIME_MULTIPLIER,
};

function linesToRegex(lines: L[]): RegExp {
  return RegExp(
    "^" +
      lines
        .join("\n")
        .replaceAll(".", "\\.")
        .replaceAll("[", "\\[")
        .replaceAll("]", "\\]")
        .replaceAll("*", ".*")
        .replaceAll("00", "\\d+") +
      "$",
  );
}

function assertLastLines(...expectedLines: L[][]) {
  // get last lines
  const actual = LOG_LINES.join("\n");
  LOG_LINES = [];
  // if (!expectedLines.some((lines) => linesToRegex(lines).test(actual))) {
  //   throw new Error();
  // }
  assert.match(actual, linesToRegex(expectedLines[0]));
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
  const socket = net.createConnection(port, "::1");
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

  async breakConn() {
    this.incomingSocket!.resetAndDestroy();
    // Sleep to make logs more predictable
    await sleep(100);
    this.outgoingSocket!.resetAndDestroy();
  }

  unpipe() {
    this.incomingSocket!.unpipe(this.outgoingSocket!);
    this.outgoingSocket!.unpipe(this.incomingSocket!);
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
        this.logger("connection");
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

/**
 * To avoid confusion, instead of calling these client and server, we call these "origin" and "browser"
 */
class EchoOriginAndBrowser extends Stoppable {
  // ID is first byte that is sent by the browser
  readonly originSocketByID: Map<string, net.Socket> = new Map();
  readonly browserSockets: Set<net.Socket> = new Set();
  readonly dataBySocket: Map<net.Socket, string> = new Map();

  constructor(
    readonly params: EndToEndTestParams = DEFAULT_PARAMS,
    readonly loggerOrigin = getLogger("origin", 35),
    readonly loggerBrowser = getLogger("browser", 36),
    readonly server = net.createServer({ allowHalfOpen: true }),
  ) {
    super();
    this.server.on("connection", (socket) => {
      this.addDestroyable(socket);
      this.setupEavesdrop(socket);
      loggerOrigin("connection");
      socket.on("error", (err) => {
        loggerOrigin(`error ${err.toString()}`);
      });
      socket.once("data", (data) => {
        this.originSocketByID.set(data.toString("utf-8").charAt(0), socket);
      });
      socket.on("data", (data) => {
        this.loggerOrigin(`recv ${data.length}`);
        if (!socket.writableEnded) {
          this.loggerOrigin(`send ${data.length}`);
          socket.write(data);
        }
      });
      // Make sure other end stays half-open long enough to receive the last byte
      socket.on("end", () => {
        this.loggerOrigin("recv FIN");
        this.setTimeout(() => {
          this.loggerOrigin(`send 1`);
          this.loggerOrigin(`send FIN`);
          socket.end("z");
        }, 100 * TIME_MULTIPLIER);
      });
    });
  }

  async startAndWaitUntilListening() {
    this.addCloseable(this.server);
    await new Promise<void>((resolve, reject) => {
      this.server.on("listening", () => {
        this.loggerOrigin(`listening on ${this.params.originListenPort}`);
        resolve();
      });
      this.server.on("error", (err) => reject(err));
      this.server.listen(this.params.originListenPort);
    });
  }

  setupEavesdrop(socket: net.Socket) {
    socket.on("data", (data) => {
      const s = this.dataBySocket.get(socket) ?? "";
      this.dataBySocket.set(socket, s + data.toString());
    });
  }

  createBrowserSocket(): net.Socket {
    this.loggerBrowser("connecting");
    const socket = net.createConnection({
      host: this.params.proxyHost,
      port: this.params.proxyPort,
      allowHalfOpen: true,
    });
    this.setupEavesdrop(socket);
    this.browserSockets.add(socket);
    this.addDestroyable(socket);
    // Make sure other end stays half-open long enough to receive the last byte
    socket.on("end", () => {
      this.loggerBrowser("recv FIN");
      this.setTimeout(() => {
        this.loggerBrowser(`send 1`);
        this.loggerBrowser(`send FIN`);
        socket.end("z");
      }, 100 * TIME_MULTIPLIER);
    });
    socket.on("close", () => this.browserSockets.delete(socket));
    return socket;
  }

  async expectEconn() {
    return new Promise<void>((resolve, reject) => {
      const socket = this.createBrowserSocket();
      socket.on("error", () => {});
      socket.on("close", (hadError) => {
        if (hadError) {
          this.loggerBrowser(`error ${socket.errored}`);
          resolve();
        } else {
          reject(new Error("Unexpected success"));
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
    const browserSocket = this.createBrowserSocket();
    const curConnectionId = this.browserSockets.size.toString();
    await new Promise<void>((resolve) => browserSocket.on("connect", resolve));
    // Send ID byte and wait for it to come back
    await sleep(400);
    browserSocket.write(curConnectionId);
    const chunk = await new Promise<Buffer>((resolve) =>
      browserSocket.once("data", resolve),
    );
    assert.strictEqual(chunk.toString(), curConnectionId);
    await sleep(100);
    for (const [connectionId, originSocket] of this.originSocketByID) {
      if (connectionId === curConnectionId) {
        this.originSocketByID.delete(connectionId);
        return { browserSocket, originSocket };
      }
    }
    throw new Error(`Socket not found`);
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
      // let socket1data = "";
      // let socket2data = "";
      // socket1.on("data", (data) => (socket1data += data.toString()));
      // socket2.on("data", (data) => (socket2data += data.toString()));
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
      // Make sure last byte was successfully communicated in half-open state
      const socket1data = this.dataBySocket.get(socket1);
      const socket2data = this.dataBySocket.get(socket2);
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

async function setupClientAndServer(
  t: TestContext,
  clientOverrides: Partial<ClientOptions>,
  serverOverrides: Partial<ServerOptions>,
): Promise<{ client: TunnelClient; server: TunnelServer }> {
  LOG_LINES = [];
  const server = new TunnelServer({
    ...DEFAULT_SERVER_OPTIONS,
    ...serverOverrides,
  });
  const client = new TunnelClient({
    ...DEFAULT_CLIENT_OPTIONS,
    ...clientOverrides,
  });
  t.after(() => server.stop());
  t.after(() => client.stop());
  server.start();
  await server.waitUntilListening();
  client.start();
  await server.waitUntilConnected();
  await client.waitUntilConnected();

  return { client, server };
}

async function testHalfClosed(t: TestContext, params: EndToEndTestParams) {
  const echo = new EchoOriginAndBrowser(params);
  t.after(() => echo.stop());
  await echo.startAndWaitUntilListening();

  for (const term of ["FIN", "RST"] satisfies ("FIN" | "RST")[]) {
    for (const by of ["browser", "localhost"] satisfies (
      | "browser"
      | "localhost"
    )[]) {
      await t.test(
        `clean termination by ${by} ${term} on ${params.proxyHost}:${params.proxyPort}`,
        async () => {
          // Test single
          await echo.testConn(1, term, by, 0);
          await echo.testConn(4, term, by, 0);
          // Test double simultaneous
          await Promise.all([
            echo.testConn(3, term, by, 0),
            echo.testConn(3, term, by, 0),
          ]);
          // Test triple delayed
          await Promise.all([
            echo.testConn(4, term, by, 0),
            echo.testConn(4, term, by, 10),
            echo.testConn(4, term, by, 100),
          ]);
        },
      );
    }
  }
}

// --------------------------------------------------------------------------------------------------------
// TESTS

await test("localhost and non-localhost key/crt pairs", {}, async (t) => {
  // Localhost certificate support is ensured by this option: https://nodejs.org/api/tls.html#tlsconnectoptions-callback
  const PAIRS: Partial<ClientOptions>[] = [
    { key: TLS_KEY_EXAMPLECOM, cert: TLS_CRT_EXAMPLECOM },
    { key: TLS_KEY_LOCALHOST, cert: TLS_CRT_LOCALHOST },
  ];
  for (const pair of PAIRS) {
    await t.test(async (t) => {
      await setupClientAndServer(t, pair, pair);
      const echo = new EchoOriginAndBrowser();
      t.after(() => echo.stop());
      await echo.startAndWaitUntilListening();
      await echo.expectPingPongAndClose();
    });
  }
});

await test("logging test", { timeout: TEST_TIMEOUT }, async (t) => {
  await setupClientAndServer(t, {}, {});
  const echo = new EchoOriginAndBrowser();
  t.after(() => echo.stop());
  await echo.startAndWaitUntilListening();

  LOG_LINES = [];
  await echo.testConn(0, "FIN", "browser", 0);
  assertLastLines([
    "server   stream0 forwarded from [::1]:00",
    "client   stream0 forwarding to [::1]:00",
    // Browser sends ID byte
    "server   stream0 send 1",
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

  await echo.testConn(0, "FIN", "localhost", 0);
  assertLastLines([
    "server   stream0 forwarded from [::1]:00",
    "client   stream0 forwarding to [::1]:00",
    // Browser sends ID byte
    "server   stream0 send 1",
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

  await echo.testConn(0, "RST", "browser", 0);
  assertLastLines([
    "server   stream0 forwarded from [::1]:00",
    "client   stream0 forwarding to [::1]:00",
    // Browser sends ID byte
    "server   stream0 send 1",
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

  await echo.testConn(0, "RST", "localhost", 0);
  assertLastLines([
    "server   stream0 forwarded from [::1]:00",
    "client   stream0 forwarding to [::1]:00",
    // Browser sends ID byte
    "server   stream0 send 1",
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
});

await test("test-testing-utils", { timeout: TEST_TIMEOUT }, async (t) => {
  for (const localIp of ["127.0.0.1", "::1"]) {
    // Run EchoServer tests without proxy or tunnel
    await t.test(
      `test-echo-server-no-proxy-no-tunnel-${localIp}`,
      async (t) => {
        await testHalfClosed(t, {
          originListenHost: localIp,
          originListenPort: LOCAL_PORT,
          proxyHost: localIp,
          proxyPort: LOCAL_PORT,
        });
      },
    );

    await t.test(
      `test-network-emulator-using-echo-server-${localIp}`,
      async (t) => {
        // Test NetworkEmulator using EchoServer
        const net = new NetworkEmulator({
          listenHost: localIp,
          listenPort: LOCAL2_PORT,
          forwardHost: localIp,
          forwardPort: LOCAL_PORT,
        });
        t.after(() => net.stop());
        await net.startAndWaitUntilReady();
        await testHalfClosed(t, {
          originListenHost: localIp,
          originListenPort: LOCAL_PORT,
          proxyHost: localIp,
          proxyPort: LOCAL2_PORT,
        });
      },
    );
  }
});

await test("test-half-closed", { timeout: TEST_TIMEOUT }, async (t) => {
  for (const localIp of ["127.0.0.1", "::1"]) {
    await t.test(`half-closed-${localIp}`, async (t) => {
      // Test EchoServer through default tunnel
      await setupClientAndServer(
        t,
        {
          originHost: localIp,
          tunnelHost: localIp,
        },
        {
          tunnelListenIp: localIp,
          proxyListenIp: localIp,
        },
      );
      await testHalfClosed(t, {
        originListenHost: localIp,
        originListenPort: LOCAL_PORT,
        proxyHost: localIp,
        proxyPort: PROXY_PORT,
      });
    });
  }
});

await test("happy-path", { timeout: TEST_TIMEOUT }, async (t) => {
  const { client, server } = await setupClientAndServer(t, {}, {});
  const echo = new EchoOriginAndBrowser();
  t.after(() => echo.stop());
  await echo.startAndWaitUntilListening();

  LOG_LINES = [];

  // Make one request
  await echo.expectPingPongAndClose();

  assertLastLines([
    "server   stream0 forwarded from [::1]:00",
    "client   stream0 forwarding to [::1]:00",
    "server   stream0 send 1",
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

  await echo.stop();
  await client.stop();
  await sleep(50);

  assertLastLines([
    "client   stopping",
    "server   disconnected",
    "client   disconnected",
    "client   stopped",
  ]);

  await server.stop();

  assertLastLines(["server   stopping", "server   stopped"]);
});

await test("use-before-ready", async () => {
  const server = new TunnelServer(DEFAULT_SERVER_OPTIONS);
  const client = new TunnelClient(DEFAULT_CLIENT_OPTIONS);
  const echo = new EchoOriginAndBrowser();
  await echo.startAndWaitUntilListening();

  LOG_LINES = [];
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
    `server   connected to [::1]:${TUNNEL_PORT} from [::1]:00`,
    `client   connected to [::1]:${TUNNEL_PORT} from [::1]:00`,
  ]);

  await echo.stop();
  await client.stop();
  await server.stop();
});

await test(
  "restart-client-while-server-running",
  { timeout: TEST_TIMEOUT },
  async (t) => {
    const { client, server } = await setupClientAndServer(t, {}, {});
    const echo = new EchoOriginAndBrowser();
    t.after(() => echo.stop());
    await echo.startAndWaitUntilListening();
    LOG_LINES = [];
    // Restart server while client is running
    await server.stop();
    await echo.expectEconn();
    await sleep(1000);
    server.start();
    await server.waitUntilConnected();
    await client.waitUntilConnected();

    assertLastLines([
      "server   stopping",
      "server   disconnected",
      "server   stopped",
      // "client   tunnel error This socket has been ended by the other party",
      "client   disconnected",
      "server   listening",
      "client   restarting",
      `server   connected to [::1]:${TUNNEL_PORT} from [::1]:00`,
      `client   connected to [::1]:${TUNNEL_PORT} from [::1]:00`,
    ]);

    // Make sure client reconnected and request succeeds
    await echo.expectPingPongAndClose();
    await echo.stop();
  },
);

await test(
  "restart-server-while-client-running",
  { timeout: TEST_TIMEOUT },
  async (t) => {
    const { client, server } = await setupClientAndServer(t, {}, {});
    const echo = new EchoOriginAndBrowser();
    t.after(() => echo.stop());
    await echo.startAndWaitUntilListening();
    LOG_LINES = [];

    await client.stop();
    client.start();

    // Wait until client reconnected and make a request
    await sleep(50);
    await echo.expectEconn();
    await server.waitUntilConnected();
    await client.waitUntilConnected();

    assertLastLines([
      "client   stopping",
      "client   disconnected",
      "client   stopped",
      "client   connecting",
      // "server   stream0 forwarded from [::1]:00",
      "server   disconnected",
      "server   rejecting connection from [::1]:00",
      `server   connected to [::1]:${TUNNEL_PORT} from [::1]:00`,
      `client   connected to [::1]:${TUNNEL_PORT} from [::1]:00`,
    ]);

    // Make sure client reconnected and request succeeds
    await echo.expectPingPongAndClose();
  },
);

await test("bad-network", { timeout: TEST_TIMEOUT }, async (t) => {
  LOG_LINES = [];
  const echo = new EchoOriginAndBrowser();
  t.after(() => echo.stop());
  const net = new NetworkEmulator({
    listenHost: "::1",
    listenPort: TUNNEL2_PORT,
    forwardHost: "::1",
    forwardPort: TUNNEL_PORT,
  });
  t.after(() => net.stop());
  const server = new TunnelServer(DEFAULT_SERVER_OPTIONS);
  t.after(() => server.stop());
  const client = new TunnelClient({
    ...DEFAULT_CLIENT_OPTIONS,
    tunnelPort: TUNNEL2_PORT,
  });
  t.after(() => client.stop());

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
    `server   connected to [::1]:${TUNNEL_PORT} from [::1]:00`,
    `client   connected to [::1]:${TUNNEL2_PORT} from [::1]:00`,
  ]);

  // Make one request
  await echo.expectPingPongAndClose();

  assertLastLines([
    "server   stream0 forwarded from [::1]:00",
    "client   stream0 forwarding to [::1]:00",
    "server   stream0 send 1",
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

  // Break tunnel while no requests are taking place
  await net.breakConn();

  await sleep(100);
  await echo.expectEconn();

  assertLastLines([
    "client   disconnected",
    "server   disconnected",
    "server   rejecting connection from [::1]:00",
  ]);

  // Wait until client reconnected and make a request
  await server.waitUntilConnected();
  await client.waitUntilConnected();
  await echo.expectPingPongAndClose();

  assertLastLines([
    "client   restarting",
    `server   connected to [::1]:${TUNNEL_PORT} from [::1]:00`,
    `client   connected to [::1]:${TUNNEL2_PORT} from [::1]:00`,
    "server   stream0 forwarded from [::1]:00",
    "client   stream0 forwarding to [::1]:00",
    "server   stream0 send 1",
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
  await net.breakConn();
  await sleep(10);
  await promise1;

  await client.waitUntilConnected();
  await server.waitUntilConnected();

  LOG_LINES = [];

  net.unpipe();

  await sleep(TIMEOUT * 0.25);

  // Too early to detect timeout
  assertLastLines([]);

  await sleep(TIMEOUT * 4);

  // Timeout activated because ping frame could not go through
  assertLastLines([
    "client   disconnected",
    "client   restarting",
    "server   disconnected",
    `server   connected to [::1]:${TUNNEL_PORT} from [::1]:00`,
    `client   connected to [::1]:${TUNNEL2_PORT} from [::1]:00`,
  ]);
});

await test("garbage-to-client", { timeout: TEST_TIMEOUT }, async (t) => {
  const echoServer = new EchoOriginAndBrowser();
  t.after(() => echoServer.stop());
  await echoServer.startAndWaitUntilListening();
  const stopBadServer = await createBadTlsServer(TUNNEL_PORT);
  t.after(stopBadServer);
  const client = new TunnelClient(DEFAULT_CLIENT_OPTIONS);
  t.after(() => client.stop());
  client.start();

  // Still no connection after a second
  await sleep(1000);
  await echoServer.expectEconn();
  assert.strictEqual(client.activeSession, null);

  // Let the network recover and make a successful connection
  await stopBadServer();
  const server = new TunnelServer(DEFAULT_SERVER_OPTIONS);
  t.after(() => server.stop());
  server.start();

  await server.waitUntilConnected();
  await echoServer.expectPingPongAndClose();
});

await test("garbage-to-server", { timeout: TEST_TIMEOUT }, async (t) => {
  const echoServer = new EchoOriginAndBrowser();
  t.after(() => echoServer.stop());
  await echoServer.startAndWaitUntilListening();
  const server = new TunnelServer(DEFAULT_SERVER_OPTIONS);
  t.after(() => server.stop());
  server.start();
  await server.waitUntilListening();

  // Still no connection after a second
  const stopBadClient = await createBadTlsClient(TUNNEL_PORT);
  t.after(stopBadClient);
  await sleep(1000);
  await echoServer.expectEconn();
  assert.strictEqual(server.activeSession, null);

  // Let the network recover and make a successful connection
  await stopBadClient();
  const client = new TunnelClient(DEFAULT_CLIENT_OPTIONS);
  t.after(() => client.stop());
  client.start();
  await server.waitUntilConnected();
  await echoServer.expectPingPongAndClose();
});

await test("latest-client-wins", { timeout: TEST_TIMEOUT }, async (t) => {
  const echoServer = new EchoOriginAndBrowser();
  t.after(() => echoServer.stop());
  await echoServer.startAndWaitUntilListening();
  const server = new TunnelServer(DEFAULT_SERVER_OPTIONS);
  t.after(() => server.stop());
  server.start();
  await server.waitUntilListening();

  const client1 = new TunnelClient({
    ...DEFAULT_CLIENT_OPTIONS,
    logger: getLogger("client1", 33),
  });
  t.after(() => client1.stop());
  const client2 = new TunnelClient({
    ...DEFAULT_CLIENT_OPTIONS,
    logger: getLogger("client2", 33),
  });
  t.after(() => client2.stop());

  client1.start();

  await client1.waitUntilConnected();
  await server.waitUntilConnected();

  await echoServer.expectPingPongAndClose();

  LOG_LINES = [];

  client2.start();
  await client2.waitUntilConnected();
  await server.waitUntilConnected();

  await echoServer.expectPingPongAndClose();

  assertLastLines([
    "client2   connecting",
    "server   disconnected",
    "client1   disconnected",
    `server   connected to [::1]:${TUNNEL_PORT} from [::1]:00`,
    `client2   connected to [::1]:${TUNNEL_PORT} from [::1]:00`,
    "server   stream0 forwarded from [::1]:00",
    "client2   stream0 forwarding to [::1]:00",
    "server   stream0 send 1",
    "client2   stream0 recv 1",
    "client2   stream0 send 1",
    "server   stream0 recv 1",
    "server   stream0 send FIN",
    "client2   stream0 recv FIN",
    "client2   stream0 send 1",
    "client2   stream0 send FIN",
    "client2   stream0 closed",
    "server   stream0 recv 1",
    "server   stream0 recv FIN",
    "server   stream0 closed",
  ]);
});

await test("addr-in-use", { timeout: TEST_TIMEOUT }, async (t) => {
  const server1 = new TunnelServer(DEFAULT_SERVER_OPTIONS);
  const server2 = new TunnelServer(DEFAULT_SERVER_OPTIONS);
  t.after(() => server1.stop());
  t.after(() => server2.stop());
  server1.start();
  await server1.waitUntilListening();
  server2.start();
  await assert.rejects(() => server2.waitUntilListening(), {
    message: /EADDRINUSE/,
  });
});

function spawnServer(): child_process.ChildProcessByStdio<
  stream.Writable,
  stream.Readable,
  stream.Readable
> {
  return child_process.spawn(
    process.execPath,
    [
      path.join("build", "cli.js"),
      "server",
      "--crt",
      TLS_CRT_FILE,
      "--key",
      TLS_KEY_FILE,
      "--tunnel-listen-ip",
      "::1",
      "--tunnel-listen-port",
      TUNNEL_PORT.toString(),
      "--proxy-listen-port",
      PROXY_PORT.toString(),
    ],
    {
      // timeout: 1000,
      stdio: "pipe",
    },
  );
}

async function expectExitCode(
  child: child_process.ChildProcess,
  expected: number | null,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    child.on("exit", (code) => {
      console.log("child.exitCode", child.exitCode);
      if (code === expected) {
        resolve();
      } else {
        reject(new Error(`Unexpected exit code ${code}`));
      }
    });
  });
}

await test("cli-exit-1", { timeout: TEST_TIMEOUT }, async (t) => {
  const child1 = spawnServer();
  t.after(() => child1.kill());

  // Wait until listening
  await new Promise<void>((resolve) => {
    readline.createInterface({ input: child1.stdout }).on("line", (line) => {
      if (line === "listening") {
        resolve();
      }
    });
  });

  const child2 = spawnServer();
  t.after(() => child2.kill());

  // Expect exit code 1 because address is already in use
  await expectExitCode(child2, 1);
});

await test("cli-exit-sigterm-sigint", { timeout: TEST_TIMEOUT }, async (t) => {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    const child = spawnServer();
    t.after(() => child.kill());

    const rl = readline.createInterface({ input: child.stdout });

    // Wait until listening
    await new Promise<void>((resolve) => {
      rl.on("line", (line) => {
        if (line === "listening") {
          resolve();
        }
      });
    });

    child.kill(signal);

    await expectExitCode(child, 0);
  }
});
