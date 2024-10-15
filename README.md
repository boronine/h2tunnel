# h2tunnel

![NPM Version](https://img.shields.io/npm/v/h2tunnel)
![GitHub Actions Workflow Status](https://img.shields.io/github/actions/workflow/status/boronine/h2tunnel/node.js.yml)

A low level tool for a popular "tunneling" workflow, similar to the proprietary [ngrok](https://ngrok.com/)
or the openssh-based `ssh -L` solution. All in [less than 600 LOC](https://github.com/boronine/h2tunnel/blob/main/src/h2tunnel.ts)
with no dependencies.

![Diagram](https://raw.githubusercontent.com/boronine/h2tunnel/main/diagram.drawio.svg)]

## The "tunneling" workflow

This workflow allows exposing your localhost development server to the internet. This requires a server component 
hosted on a public IP address, and a client component running on your local machine. The client establishes a tunnel
to the server, and the server acts as a reverse proxy, tunneling requests back to your local machine.

## Usage

### Forward localhost:8000 to http://example.com

Generate `.key` and `.crt` files. These will be used by both client and server to authenticate each other.

```bash
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:secp384r1 -days 3650 -nodes -keyout h2tunnel.key -out h2tunnel.crt -subj "/CN=example.com"
```

On your server (example.com), we will be listening for tunnel connections on port 15001, and providing an HTTP proxy 
on port 80. Make sure these are open in your firewall. `--mux-listen-port` can be any available port, it is necessary
to run an HTTP2 multiplexer on localhost.

```bash
sudo h2tunnel server --crt h2tunnel.crt --key h2tunnel.key --tunnel-listen-ip 0.0.0.0 --tunnel-listen-port 15001 --proxy-listen-port 80 --proxy-listen-ip 0.0.0.0 --mux-listen-port=15002
````

On your local machine, we will connect to the tunnel and forward a local HTTP server on port 8000. `--demux-listen-port`
can be any available port, it is necessary to run an HTTP2 demultiplexer on localhost.

```bash
python3 -m http.server # runs on port 8000
h2tunnel client --key h2tunnel.key --crt h2tunnel.crt --tunnel-host=example.com --tunnel-port=15001 --local-http-port=8000 --demux-listen-port=15004
```

### Forward localhost:8000 to https://example.com

This is the same as the previous example, but with an extra layer: a [Caddy](https://caddyserver.com/) reverse proxy
that will auto-provision TLS certificates for your domain. This is useful if you want to expose an HTTPS server.

The client command line is the same as before, but for the server we will use a docker compose setup.

Specify your domain in the `.env` file:

```
TUNNEL_DOMAIN=example.com
```

Push the necessary files to the server:

```bash
scp .env Caddyfile Dockerfile docker-compose.yml h2tunnel.crt h2tunnel.key example.com:/home/myuser
```

Start the server:

```bash
docker compose up 
```

### Use as a library

You can integrate h2tunnel into your own Node.js application by importing the `TunnelServer` and `TunnelClient` classes.

```typescript
import {TunnelClient} from "h2tunnel";

const client = new TunnelClient({
    logger: (line) => console.log(line), // optional
    key: `-----BEGIN PRIVATE KEY----- ...`,
    cert: `-----BEGIN CERTIFICATE----- ...`,
    demuxListenPort: 15002,
    localHttpPort: 8000,
    tunnelHost: `mysite.example.com`,
    tunnelPort: 15001,
});

// Start the client
client.start();

// Stop the client
await client.stop();
```

## Testing

```bash
npm run test
```
