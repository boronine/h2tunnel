import * as http from "node:http";
import { test } from "node:test";
import {
  ClientOptions,
  ServerOptions,
  TunnelClient,
  TunnelServer,
} from "./h2tunnel.js";
import * as assert from "node:assert";
import { Readable } from "node:stream";

// localhost HTTP1 server "python3 -m http.server"
const LOCAL_HTTP_PORT = 14000;
// localhost HTTP2 server that proxies to localhost HTTP1 server
const DEMUX_PORT = 14003;

// remote public HTTP1 server
const REMOTE_HTTP_PORT = 14004;
// remote TLS server for establishing a tunnel
const TUNNEL_PORT = 14005;
// remote HTTPS server that is piped through the tunnel to localhost
const MUX_PORT = 14006;

// https://stackoverflow.com/a/41366949/212584
// openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:secp384r1 -days 3650 -nodes -keyout example.com.key -out example.com.crt -subj "/CN=example.com" -addext "subjectAltName=DNS:example.com,DNS:*.example.com,IP:10.0.0.1"

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

const getLogger = (colorCode: number) => (line: object) =>
  process.stdout.write(`\x1b[${colorCode}m${JSON.stringify(line)}\x1b[0m\n`);

export async function streamToText(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const reader = stream.getReader();
  const arrs: Uint8Array[] = [];
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) {
      return new Blob(arrs).text();
    }
    arrs.push(chunk.value);
  }
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createDummyHttpServer(): Promise<() => Promise<void>> {
  const logger = getLogger(35);
  const dummyServerHttp1 = http.createServer(async (request, response) => {
    logger({
      dummyServerRequest: { method: request.method, path: request.url },
    });
    const xIncrement = request.headers["x-increment"] as string;
    const reqBody = await streamToText(Readable.toWeb(request));
    const body = String(Number(reqBody) + 1);
    const headerResp = String(Number(xIncrement) + 1);
    const headers = {
      "Content-Type": "text/plain",
      "x-incremented": headerResp,
    };
    await sleep(100);
    const statusCode = 200;
    response.writeHead(statusCode, headers);
    response.end(body);
    logger({
      dummyServerSentResponse: statusCode,
      body,
      headers,
    });
  });
  dummyServerHttp1.listen(LOCAL_HTTP_PORT);
  await new Promise((resolve) => dummyServerHttp1.on("listening", resolve));
  return () =>
    new Promise<void>((resolve) => dummyServerHttp1.close(() => resolve()));
}

const serverOptions: ServerOptions = {
  logger: getLogger(32),
  tunnelListenIp: "127.0.0.1",
  tunnelListenPort: TUNNEL_PORT,
  key: CLIENT_KEY,
  cert: CLIENT_CRT,
  proxyListenPort: REMOTE_HTTP_PORT,
  proxyListenIp: "127.0.0.1",
  muxListenPort: MUX_PORT,
};

const clientOptions: ClientOptions = {
  logger: getLogger(33),
  tunnelHost: "localhost",
  tunnelPort: TUNNEL_PORT,
  key: CLIENT_KEY,
  cert: CLIENT_CRT,
  localHttpPort: LOCAL_HTTP_PORT,
  demuxListenPort: DEMUX_PORT,
  tunnelRestartTimeout: 500,
};

async function expect503() {
  const resp = await fetch(`http://localhost:${REMOTE_HTTP_PORT}`, {
    method: "post",
    body: "1",
    headers: { "x-increment": "2" },
  });
  assert.strictEqual(resp.status, 503);
}

async function expect200() {
  const resp = await fetch(`http://localhost:${REMOTE_HTTP_PORT}`, {
    method: "post",
    body: "1",
    headers: { "x-increment": "2" },
  });
  const body = await resp.text();
  assert.strictEqual(resp.status, 200);
  assert.strictEqual(body, "2");
  assert.strictEqual(resp.headers.get("x-incremented"), "3");
}

test("happy-path", async () => {
  const stopDummyServer = await createDummyHttpServer();

  const server = new TunnelServer(serverOptions);
  const client = new TunnelClient(clientOptions);
  server.start();

  // Make a request too early
  await expect503();

  await server.waitUntilListening();
  client.start();

  // Make a request too early
  await expect503();

  // Wait until client is connected and test 200
  await client.waitUntilConnected();
  assert.strictEqual(server.state, "connected");
  await expect200();

  // Restart server while client is running
  await server.stop();
  server.start();
  await server.waitUntilListening();
  await expect503();

  // Make sure client reconnected and request succeeds
  await client.waitUntilConnected();
  assert.strictEqual(server.state, "connected");
  await server.waitUntilConnected();
  await expect200();

  // Restart client while server is running
  await client.stop();
  client.start();

  // Make a request too early
  await expect503();

  // Wait until client reconnected and make a request
  await client.waitUntilConnected();
  await expect200();

  // Break tunnel
  client.tunnelSocket!.destroy();
  await expect503();

  // Wait until client reconnected and make a request
  await client.waitUntilConnected();
  await expect200();

  await client.stop();
  await server.stop();
  await stopDummyServer();
});
