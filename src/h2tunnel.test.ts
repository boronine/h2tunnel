import * as http from "node:http";
import { test } from "node:test";
import {
  ClientOptions,
  ServerOptions,
  TunnelClient,
  TunnelServer,
} from "./h2tunnel.js";
import * as assert from "node:assert";
import net from "node:net";

// localhost HTTP1 server "python3 -m http.server"
const LOCAL_HTTP_PORT = 14000;
// localhost HTTP2 server that proxies to localhost HTTP1 server
const DEMUX_PORT = 14003;

// remote public HTTP1 server
const REMOTE_HTTP_PORT = 14004;
// remote TLS server for establishing a tunnel
const TUNNEL_PORT = 14005;
// In order to simulate a bad network, we host a proxy TCP server on this port
const TUNNEL_PROXY_PORT = 14007;
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

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Waits 100 ms before sending a 200, then pipes request into response
 */
async function createEchoHttpServer(): Promise<() => Promise<void>> {
  const logger = getLogger("localhost", 35);
  const dummyServerHttp1 = http.createServer((request, response) => {
    logger({
      dummyServerRequest: { method: request.method, path: request.url },
    });
    const t = setTimeout(() => {
      const xIncrement = request.headers["x-increment"] as string;
      const headerResp = String(Number(xIncrement) + 1);
      const headers = {
        "Content-Type": "text/plain",
        "x-incremented": headerResp,
      };
      const statusCode = 200;
      response.writeHead(statusCode, headers);
      request.pipe(response);
      logger({
        dummyServerSentResponse: statusCode,
        headers,
        method: request.method,
        path: request.url,
      });
    }, 100);
    request.on("close", () => clearTimeout(t));
  });
  dummyServerHttp1.listen(LOCAL_HTTP_PORT);
  await new Promise((resolve) => dummyServerHttp1.on("listening", resolve));
  return () =>
    new Promise<void>((resolve) => dummyServerHttp1.close(() => resolve()));
}

class NetworkEmulator {
  socket: net.Socket | null = null;
  constructor(
    public scenario: "good" | "garbage-to-client" | "garbage-to-server",
    readonly server = net.createServer(),
    readonly logger = getLogger("network", 31),
    readonly abortController = new AbortController(),
  ) {}
  async startAndWaitUntilReady() {
    return new Promise<void>((resolve) => {
      this.server.on("connection", (socket: net.Socket) => {
        if (this.socket) {
          // We have discovered that when not TLS client errors out, it leaves the TCP server hanging. This is why
          // we cannot rely on 'maxConnections' to enforce a single connection.
          this.logger({ socket: "destroying" });
          this.socket.destroy();
        }
        this.socket = socket;
        this.socket.on("error", (err) => this.logger({ socket: "error", err }));
        this.socket.on("close", () => this.logger({ socket: "close" }));
        this.logger({ server: "connection", scenario: this.scenario });
        if (this.scenario === "good") {
          const targetSocket = net.createConnection({
            host: "127.0.0.1",
            port: TUNNEL_PORT,
          });
          this.socket.pipe(targetSocket);
          targetSocket.pipe(this.socket);
        } else if (this.scenario === "garbage-to-client") {
          this.socket.write("bad TLS handshake");
        } else if (this.scenario === "garbage-to-server") {
          const targetSocket = net.createConnection({
            host: "127.0.0.1",
            port: TUNNEL_PORT,
          });
          targetSocket.write("bad TLS handshake");
          this.socket.on("close", () => targetSocket.end());
        }
      });
      this.server.on("listening", () => resolve());
      this.server.listen(TUNNEL_PROXY_PORT, "127.0.0.1");
    });
  }
  async stopAndWaitUntilClosed() {
    this.socket?.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

const serverOptions: ServerOptions = {
  logger: getLogger("server", 32),
  tunnelListenIp: "127.0.0.1",
  tunnelListenPort: TUNNEL_PORT,
  key: CLIENT_KEY,
  cert: CLIENT_CRT,
  proxyListenPort: REMOTE_HTTP_PORT,
  proxyListenIp: "127.0.0.1",
  muxListenPort: MUX_PORT,
};

const clientOptions: ClientOptions = {
  logger: getLogger("client", 33),
  tunnelHost: "localhost",
  tunnelPort: TUNNEL_PORT,
  key: CLIENT_KEY,
  cert: CLIENT_CRT,
  localHttpPort: LOCAL_HTTP_PORT,
  demuxListenPort: DEMUX_PORT,
  tunnelRestartTimeout: 500,
};

// Send one byte per 50 ms and confirms echo server returns same data back
async function makeRequest(
  expect: 200 | 503 | "ECONN",
  numBytes: number,
  name: string = "",
) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const url = `http://localhost:${REMOTE_HTTP_PORT}/${expect}/${name}`;
  console.log("making request", url);
  const respPromise = fetch(url, {
    method: "post",
    body: readable,
    headers: { "x-increment": "2" },
    duplex: "half",
  });
  // Send first byte immediately
  try {
    await writer.write("1");
    for (let i = 1; i < numBytes; i++) {
      await writer.write("1");
      await sleep(50);
    }
    await writer.close();
  } catch (e) {
    assert.strictEqual(expect, "ECONN");
    return;
  }

  let resp: Response;
  try {
    resp = await respPromise;
  } catch (e) {
    assert.strictEqual(expect, "ECONN");
    return;
  }
  if (expect === 200) {
    const body = await resp.text();
    assert.strictEqual(resp.status, 200);
    assert.strictEqual(body.length, numBytes);
    assert.strictEqual(resp.headers.get("x-incremented"), "3");
  } else if (expect === 503) {
    if (resp.status === 200) {
      console.log(8);
    }
    assert.strictEqual(resp.status, 503);
  }
}

async function expect200(numBytes: number, name: string = "") {
  await makeRequest(200, numBytes, name);
}

async function expect503(numBytes: number, name: string = "") {
  await makeRequest(503, numBytes, name);
}

// async function withHappyPath(
//   func: (opts: { client: TunnelClient; server: TunnelServer }) => Promise<void>,
// ): Promise<void> {
//   const stopDummyServer = await createEchoHttpServer();
//   const server = new TunnelServer(serverOptions);
//   const client = new TunnelClient(clientOptions);
//   await func({ client, server });
//   await client.stop();
//   await server.stop();
//   await stopDummyServer();
// }

test("happy-path", async () => {
  const stopDummyServer = await createEchoHttpServer();

  const server = new TunnelServer(serverOptions);
  const client = new TunnelClient(clientOptions);
  server.start();

  // Make a request too early
  await expect503(1, "server-not-started");

  await server.waitUntilListening();
  client.start();

  // Make a request too early
  await expect503(1, "server-started-but-client-not-started");

  // Wait until client is connected and test 200
  await client.waitUntilConnected();
  assert.strictEqual(server.iter(), "connected");
  // Make two simultaneous slow requests
  await Promise.all([
    expect200(4, "long-request-1"),
    expect200(4, "long-request-2"),
  ]);

  // Restart server while client is running
  await server.stop();
  server.start();
  await expect503(1);
  await server.waitUntilListening();

  // Make sure client reconnected and request succeeds
  await expect503(1);
  await client.waitUntilConnected();
  assert.strictEqual(server.iter(), "connected");
  await server.waitUntilConnected();
  await expect200(1);

  // Restart client while server is running
  await client.stop();
  client.start();

  // Wait until client reconnected and make a request
  await expect503(1);

  await client.waitUntilConnected();
  await expect200(1);

  // Break tunnel while no requests are taking place
  client.tunnel!.socket.destroy();
  await sleep(10);
  await expect503(1);

  // Wait until client reconnected and make a request
  await client.waitUntilConnected();
  await expect200(1);

  // Break tunnel during a request but before response headers could be sent
  const promise1 = expect503(1, "break-tunnel-before-reponse-headers-sent");
  await sleep(10);
  client.tunnel!.socket.destroy();
  await sleep(10);
  await promise1;

  // Break tunnel during a request but after response headers were already sent
  await client.waitUntilConnected();
  const promise2 = makeRequest("ECONN", 4);
  await sleep(110);
  client.tunnel!.socket.destroy();
  await sleep(10);
  await promise2;

  await client.stop();
  await server.stop();
  await stopDummyServer();
});

test("garbage-to-client", async () => {
  const stopDummyServer = await createEchoHttpServer();
  const network = new NetworkEmulator("garbage-to-client");
  await network.startAndWaitUntilReady();
  const server = new TunnelServer(serverOptions);
  const client = new TunnelClient({
    ...clientOptions,
    tunnelPort: TUNNEL_PROXY_PORT,
  });
  server.start();
  client.start();

  // Still no connection after a second
  await sleep(1000);
  await expect503(1);
  assert.strictEqual(client.iter(), "starting");

  // Let the network recover and make a successful connection
  network.scenario = "good";
  await client.waitUntilConnected();
  await expect200(1);

  await client.stop();
  await server.stop();
  await network.stopAndWaitUntilClosed();
  await stopDummyServer();
});

test("garbage-to-server", async () => {
  const stopDummyServer = await createEchoHttpServer();
  const badNetwork = new NetworkEmulator("garbage-to-server");
  await badNetwork.startAndWaitUntilReady();
  const server = new TunnelServer(serverOptions);
  const client = new TunnelClient({
    ...clientOptions,
    tunnelPort: TUNNEL_PROXY_PORT,
  });
  server.start();
  client.start();

  // Still no connection after a second
  await sleep(1000);
  await expect503(1);
  assert.strictEqual(client.iter(), "starting");

  // Let the network recover and make a successful connection
  badNetwork.socket!.destroy();
  badNetwork.scenario = "good";
  await client.waitUntilConnected();
  await expect200(1);

  await client.stop();
  await server.stop();
  await badNetwork.stopAndWaitUntilClosed();
  await stopDummyServer();
});
