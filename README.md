# h2tunnel - TCP over HTTP/2

[![NPM Version](https://img.shields.io/npm/v/h2tunnel)](https://www.npmjs.com/package/h2tunnel)
[![GitHub Actions Workflow Status](https://img.shields.io/github/actions/workflow/status/boronine/h2tunnel/node.js.yml)](https://github.com/boronine/h2tunnel/actions/workflows/node.js.yml)

A CLI tool and Node.js library for a popular "tunneling" workflow, like the proprietary [ngrok](https://ngrok.com/)
or the [`ssh -R` solution](https://www.ssh.com/academy/ssh/tunneling-example#remote-forwarding).

The client (localhost) establishes a tunnel to the server (public IP), and the server forwards incoming connections to
your local machine through this tunnel. In effect, your local server becomes publically available.

All in [less than 500 LOC](https://github.com/boronine/h2tunnel/blob/main/src/h2tunnel.ts)
with no dependencies.

![Diagram](https://raw.githubusercontent.com/boronine/h2tunnel/main/diagram.drawio.svg)

## How does h2tunnel work?

h2tunnel is unique among [its many alternatives](https://github.com/anderspitman/awesome-tunneling) for the way it
leverages existing protocols:

1. The client initiates a TLS connection to the server and starts listening for HTTP/2 sessions
2. The server receives a TLS connection and initiates an HTTP/2 session through it
3. The server takes incoming TCP connections, converts them into HTTP/2 streams, and forwards them to the client
4. The client receives these HTTP/2 streams, converts them back into TCP connections for the local server

The purpose of using HTTP/2 is to take advantage of its multiplexing capability. This feature of the protocol allows
simultaneous requests to be processed on a single TCP connection (the "tunnel").

For authentication we use a self-signed TLS certificate + private key pair. This pair is used by both the client and
the server, and both are configured to reject anything else. The pair is effectively a shared password.

## Installation

```bash
npm install -g h2tunnel
```

## Usage

```
usage: h2tunnel <command> [options]

commands:
  client
  server

client options:
  --crt <path>                 Path to certificate file (.crt)
  --key <path>                 Path to private key file (.key)
  --tunnel-host <host>         Host for the tunnel server
  --tunnel-port <port>         Port for the tunnel server
  --origin-host <port>         Host for the local TCP server (default: localhost)
  --origin-port <port>         Port for the local TCP server

server options:
  --crt <path>                 Path to certificate file (.crt)
  --key <path>                 Path to private key file (.key)
  --tunnel-listen-ip <ip>      IP for the tunnel server to bind on (default: 0.0.0.0)
  --tunnel-listen-port <port>  Port for the tunnel server to listen on
  --proxy-listen-ip <port>     IP for the remote TCP proxy server to bind on (default: 0.0.0.0)
  --proxy-listen-port <port>   Port for the remote TCP proxy server to listen on

The tunnel and proxy servers will bind to 0.0.0.0 by default which will make them publically available. This requires
superuser permissions on Linux. You can change this setting to bind to a specific network interface, e.g. a VPN, but
this is advanced usage.
```

Generate `h2tunnel.key` and `h2tunnel.crt` files using `openssl` command:

```bash
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:secp384r1 -days 3650 -nodes -keyout h2tunnel.key -out h2tunnel.crt -subj "/CN=localhost"
```

### Forward localhost:8000 to http://mysite.example.com

On your server (example.com), we will be listening for tunnel connections on port 15001, and providing an HTTP proxy
on port 80. Make sure these are open in your firewall.

```bash
# sudo is required to bind to 0.0.0.0, which is necessary for public access
sudo h2tunnel server \
  --crt h2tunnel.crt \
  --key h2tunnel.key \
  --tunnel-listen-port 15001 \
  --proxy-listen-port 80
```

On your local machine, we will connect to the tunnel and forward a local HTTP server on port 8000.

```bash
h2tunnel client \
  --crt h2tunnel.crt \
  --key h2tunnel.key \
  --tunnel-host=mysite.example.com \
  --tunnel-port=15001 \
  --local-http-port=8000

# If you have python3 installed, you can test using this built-in HTTP server
python3 -m http.server
```

### Forward localhost:8000 to https://mysite.example.com

This is the same as the previous example, but with an extra layer: a [Caddy](https://caddyserver.com/) reverse proxy
that will auto-provision TLS certificates for your domain. This is useful if you want to expose a local HTTP server
as HTTPS.

Specify your domain in the `.env` file:

```
TUNNEL_DOMAIN=mysite.example.com
```

Push the necessary files to the server:

```bash
scp .env Caddyfile Dockerfile docker-compose.yml h2tunnel.crt h2tunnel.key mysite.example.com:/home/myuser
```

Start the server:

```bash
ssh myuser@mysite.example.com
docker compose up
```

To connect to your tunnel, run the same client command as in the above recipe.

### Use as a library

You can integrate h2tunnel into your own Node.js application by importing the `TunnelServer` and `TunnelClient` classes.

```typescript
import { TunnelClient } from "h2tunnel";

const client = new TunnelClient({
  logger: (line) => console.log(line), // optional
  key: `-----BEGIN PRIVATE KEY----- ...`,
  cert: `-----BEGIN CERTIFICATE----- ...`,
  originHost: "localhost", // optional
  originPort: 8000,
  tunnelHost: `mysite.example.com`,
  tunnelPort: 15001,
});

// Start the client
client.start();

// Wait until client is connected
await client.waitUntilConnected();

// Stop the client
await client.stop();
```

```typescript
import { TunnelServer } from "h2tunnel";

const server = new TunnelServer({
  logger: (line) => console.log(line), // optional
  key: `-----BEGIN PRIVATE KEY----- ...`,
  cert: `-----BEGIN CERTIFICATE----- ...`,
  tunnelListenIp: "0.0.0.0", // optional
  tunnelListenPort: 15001,
  proxyListenIp: "0.0.0.0", // optional
  proxyListenPort: 80,
});

// Start the server
server.start();

// Wait until server is listening
await client.waitUntilListening();

// Wait until server is connected
await client.waitUntilConnected();

// Stop the server
await server.stop();
```

## Testing

```bash
npm run test
npm run coverage
```

## Changelog

### 0.3.0

- Support tunneling half-closed TCP connections, these are sometimes killed by middleboxes but they will be safe in h2tunnel
- Remove mux/demux port configuration, instead take a random port assigned by the OS
- Allow specifying the origin host for advanced use cases, default is localhost

### 0.2.0

- Tunnel TCP instead of HTTP1, supporting a wide range of protocols
- Prevent double TLS encryption by using Node.js unencrypted HTTP/2 connection
- Lots of testing improvements
- Reduce code size to <500 LOC

### 0.1.1

- Improved testing and reconnection logic

### 0.1.0

- Proof of concept
- Supports tunneling HTTP1 over HTTP/2 + TLS

## License

See [LICENSE](./LICENSE) file for full text.
