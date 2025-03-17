# h2tunnel - TCP over HTTP/2

[![NPM Version](https://img.shields.io/npm/v/h2tunnel)](https://www.npmjs.com/package/h2tunnel)
[![GitHub Actions Workflow Status](https://img.shields.io/github/actions/workflow/status/boronine/h2tunnel/node.js.yml)](https://github.com/boronine/h2tunnel/actions/workflows/node.js.yml)

A CLI tool and Node.js library for a popular "tunneling" workflow, like the proprietary [ngrok](https://ngrok.com/)
or the [`ssh -R` solution](https://www.ssh.com/academy/ssh/tunneling-example#remote-forwarding).

The client (localhost) establishes a tunnel to the server (public IP), and the server forwards incoming connections to
your local machine through this tunnel. In effect, your local server becomes publically available.

All this in [less than 500 LOC](https://github.com/boronine/h2tunnel/blob/main/src/h2tunnel.ts)
with no dependencies.

![Diagram](https://raw.githubusercontent.com/boronine/h2tunnel/main/diagram.drawio.svg)

## How does h2tunnel work?

h2tunnel is unique among [its many alternatives](https://github.com/anderspitman/awesome-tunneling) for the way it
leverages existing protocols:

1. The client initiates a TLS connection to the server and uses this socket to listen for HTTP/2 sessions
2. The server receives this TLS connection and initiates a persistent HTTP/2 session through the socket back to the client
3. The server takes incoming TCP connections, converts them into HTTP/2 streams, and forwards them to the client
4. The client receives these HTTP/2 streams, converts them back into TCP connections and forwards them to the local server

We use [HTTP/2](https://en.wikipedia.org/wiki/HTTP/2) to take advantage of its built-in multiplexing feature. This
allows simultaneous duplex streams to be processed on a single TCP connection (the "tunnel").

For authentication we use a self-signed [TLS](https://en.wikipedia.org/wiki/Transport_Layer_Security) certificate +
private key pair. This pair is used by both the client and the server, and both are configured to reject any other
credential. The pair is effectively a shared password. TLS has a ["pre-shared key" mode](https://en.wikipedia.org/wiki/TLS-PSK)
which would be more appropriate but Node.js documentation [warns against using it](https://github.com/boronine/h2tunnel/issues/5).

## Installation

You can add the [h2tunnel npm package](https://www.npmjs.com/package/h2tunnel) to your `package.json` or install
h2tunnel globally like so:

```bash
npm install -g h2tunnel
```

Minimum Node.js version: v18. Ubuntu 24.04+ and Debian 12+ have this version in their repositories:

```bash
sudo apt install nodejs npm
```

For other operating systems, you may need to [install Node.js another way](https://nodejs.org/en/download/package-manager).

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
  --tunnel-port <port>         Port for the tunnel server (default 15900)
  --origin-host <host>         Host for the local TCP server (default: localhost)
  --origin-port <port>         Port for the local TCP server

server options:
  --crt <path>                 Path to certificate file (.crt)
  --key <path>                 Path to private key file (.key)
  --tunnel-listen-ip <ip>      IP for the tunnel server to bind on (default: ::0)
  --tunnel-listen-port <port>  Port for the tunnel server to listen on (default 15900)
  --proxy-listen-ip <ip>       IP for the remote TCP proxy server to bind on (default: ::0)
  --proxy-listen-port <port>   Port for the remote TCP proxy server to listen on
  
The tunnel and proxy servers will bind to ::0 by default which will make them publically available. This requires
superuser permissions on Linux. You can change this setting to bind to a specific network interface, e.g. a VPN, but
this is advanced usage. Note that on most operating systems, binding to ::0 will also bind to 0.0.0.0.
```

Generate `h2tunnel.key` and `h2tunnel.crt` files using `openssl` command:

```bash
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:secp384r1 -days 3650 -nodes -keyout h2tunnel.key -out h2tunnel.crt -subj "/CN=localhost"
```

You can inspect your key and certificate files using these commands:

```bash
openssl ec -in h2tunnel.key -text -noout
openssl x509 -in h2tunnel.crt -text -noout
```

### Forward localhost:8000 to http://mysite.example.com

On your server (mysite.example.com), we will be listening for tunnel connections on port 15001, and providing an HTTP
proxy on port 80. Make sure these are open in your firewall.

```bash
# sudo is required to bind to ::0, which is necessary for public access
sudo h2tunnel server \
  --crt h2tunnel.crt \
  --key h2tunnel.key \
  --proxy-listen-port 80
```

On your local machine, we will connect to the tunnel and forward a local HTTP server on port 8000.

```bash
h2tunnel client \
  --crt h2tunnel.crt \
  --key h2tunnel.key \
  --tunnel-host mysite.example.com \
  --origin-port 8000
```

If you have python3 installed, you can test using this built-in HTTP server:

```bash
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
scp .env Caddyfile Dockerfile docker-compose.yml h2tunnel.crt h2tunnel.key myuser@mysite.example.com:/home/myuser
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
  tunnelPort: 15900, // optional
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
  tunnelListenIp: "::0", // optional
  tunnelListenPort: 15900, // optional
  proxyListenIp: "::0", // optional
  proxyListenPort: 80,
});

// Start the server
server.start();

// Wait until server is listening
await server.waitUntilListening();

// Wait until server is connected
await server.waitUntilConnected();

// Stop the server
await server.stop();
```

## Testing

```bash
npm run test
npm run coverage # See build/index.html
```

## CHANGELOG

See [CHANGELOG.md](./CHANGELOG.md) file for full text.

## LICENSE

See [LICENSE](./LICENSE) file for full text.
