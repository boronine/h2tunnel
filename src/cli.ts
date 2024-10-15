#!/usr/bin/env node
import { parseArgs } from "node:util";
import { TunnelClient, TunnelServer } from "./h2tunnel.js";
import * as fs from "node:fs";

const { positionals, values } = parseArgs({
  options: {
    crt: {
      type: "string",
    },
    key: {
      type: "string",
    },
    // Server
    "tunnel-listen-ip": {
      type: "string",
    },
    "tunnel-listen-port": {
      type: "string",
    },
    "proxy-listen-ip": {
      type: "string",
    },
    "proxy-listen-port": {
      type: "string",
    },
    "mux-listen-port": {
      type: "string",
    },
    // Client
    "tunnel-host": {
      type: "string",
    },
    "tunnel-port": {
      type: "string",
    },
    "local-http-port": {
      type: "string",
    },
    "demux-listen-port": {
      type: "string",
    },
  },
  allowPositionals: true,
});

type Param = keyof typeof values;

function getString(k: Param): string {
  const s = values[k];
  if (!s) {
    process.stderr.write(`Missing argument --${k}\n`);
    process.exit(1);
  }
  return s;
}

function getInt(k: Param) {
  const s = getString(k);
  const i = parseInt(s);
  if (isNaN(i)) {
    process.stderr.write(`Invalid integer --${k} ${s}\n`);
    process.exit(1);
  }
  return i;
}

const HELP_TEXT = `
h2tunnel - https://github.com/boronine/h2tunnel

usage: h2tunnel <command> [options]

commands:
  client
  server
 
client options:
  --${"crt" satisfies Param} <path>                 Path to certificate file (.crt)
  --${"key" satisfies Param} <path>                 Path to private key file (.key)
  --${"tunnel-host" satisfies Param} <host>         Host for the tunnel server
  --${"tunnel-port" satisfies Param} <port>         Port for the tunnel server
  --${"local-http-port" satisfies Param} <port>     Port for the local HTTP server
  --${"demux-listen-port" satisfies Param} <port>   Port for the HTTP2 server to listen on

server options:
  --${"crt" satisfies Param} <path>                 Path to certificate file (.crt)
  --${"key" satisfies Param} <path>                 Path to private key file (.key)
  --${"tunnel-listen-ip" satisfies Param} <ip>      IP for the tunnel server to bind on (use 0.0.0.0 for all interfaces)
  --${"tunnel-listen-port" satisfies Param} <port>  Port for the tunnel server to listen on
  --${"proxy-listen-ip" satisfies Param} <port>     Host for the remote HTTP server (use 0.0.0.0 for all interfaces)
  --${"proxy-listen-port" satisfies Param} <port>   Port for the remote HTTP server
  --${"mux-listen-port" satisfies Param} <port>     Port for the HTTP2 server to listen on
`;

const command = positionals[0];
if (command === "client") {
  const client = new TunnelClient({
    tunnelHost: getString("tunnel-host"),
    tunnelPort: getInt("tunnel-port"),
    key: fs.readFileSync(getString("key"), "utf8"),
    cert: fs.readFileSync(getString("crt"), "utf8"),
    localHttpPort: getInt("local-http-port"),
    demuxListenPort: getInt("demux-listen-port"),
  });
  process.on("SIGINT", () => client.stop());
  process.on("SIGTERM", () => client.stop());
  client.start();
} else if (command === "server") {
  const server = new TunnelServer({
    tunnelListenIp: getString("tunnel-listen-ip"),
    tunnelListenPort: getInt("tunnel-listen-port"),
    key: fs.readFileSync(getString("key"), "utf8"),
    cert: fs.readFileSync(getString("crt"), "utf8"),
    proxyListenPort: getInt("proxy-listen-port"),
    proxyListenIp: getString("proxy-listen-ip"),
    muxListenPort: getInt("mux-listen-port"),
  });
  process.on("SIGINT", () => server.stop());
  process.on("SIGTERM", () => server.stop());
  server.start();
} else {
  process.stdout.write(HELP_TEXT);
}
