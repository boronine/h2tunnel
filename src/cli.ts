#!/usr/bin/env node
import { parseArgs } from "node:util";
import {
  AbstractTunnel,
  DEFAULT_LISTEN_IP,
  DEFAULT_ORIGIN_HOST,
  TunnelClient,
  TunnelServer,
} from "./h2tunnel.js";
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
    // Client
    "tunnel-host": {
      type: "string",
    },
    "tunnel-port": {
      type: "string",
    },
    "origin-host": {
      type: "string",
    },
    "origin-port": {
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
  --${"origin-host" satisfies Param} <host>         Host for the local TCP server (default: ${DEFAULT_ORIGIN_HOST})
  --${"origin-port" satisfies Param} <port>         Port for the local TCP server

server options:
  --${"crt" satisfies Param} <path>                 Path to certificate file (.crt)
  --${"key" satisfies Param} <path>                 Path to private key file (.key)
  --${"tunnel-listen-ip" satisfies Param} <ip>      IP for the tunnel server to bind on (default: ${DEFAULT_LISTEN_IP})
  --${"tunnel-listen-port" satisfies Param} <port>  Port for the tunnel server to listen on
  --${"proxy-listen-ip" satisfies Param} <ip>       IP for the remote TCP proxy server to bind on (default: ${DEFAULT_LISTEN_IP})
  --${"proxy-listen-port" satisfies Param} <port>   Port for the remote TCP proxy server to listen on
  
The tunnel and proxy servers will bind to ::0 by default which will make them publically available. This requires
superuser permissions on Linux. You can change this setting to bind to a specific network interface, e.g. a VPN, but
this is advanced usage. Note that on most operating systems, binding to ::0 will also bind to 0.0.0.0.
`;

if (positionals.length === 0) {
  process.stdout.write(HELP_TEXT);
} else {
  const command = positionals[0];
  let tunnel: AbstractTunnel<any, any>;
  if (command === "client") {
    tunnel = new TunnelClient({
      key: fs.readFileSync(getString("key"), "utf8"),
      cert: fs.readFileSync(getString("crt"), "utf8"),
      tunnelHost: getString("tunnel-host"),
      tunnelPort: getInt("tunnel-port"),
      originHost: values["origin-host" satisfies Param],
      originPort: getInt("origin-port"),
    });
  } else if (command === "server") {
    tunnel = new TunnelServer({
      key: fs.readFileSync(getString("key"), "utf8"),
      cert: fs.readFileSync(getString("crt"), "utf8"),
      tunnelListenIp: values["tunnel-listen-ip" satisfies Param],
      tunnelListenPort: getInt("tunnel-listen-port"),
      proxyListenIp: values["proxy-listen-ip" satisfies Param],
      proxyListenPort: getInt("proxy-listen-port"),
    });
  } else {
    throw new Error(`Unknown command: ${command}`);
  }

  process.on("SIGINT", () => tunnel.stop());
  process.on("SIGTERM", () => tunnel.stop());
  tunnel.start();
  await tunnel.waitUntilState("stopped");
}
