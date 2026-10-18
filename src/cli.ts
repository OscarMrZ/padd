#!/usr/bin/env node
// padd: draw feedback for Claude Code sessions from a tablet.

import { networkInterfaces, homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadToken } from "./daemon/auth.ts";
import { createPaddServer } from "./daemon/server.ts";
import { Store } from "./daemon/store.ts";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const CONFIG = process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, "padd") : join(homedir(), ".config", "padd");

const USAGE = `usage:
  padd serve [--port 8788] [--host 0.0.0.0] [--data <dir>] [--board <image>]...
  padd link [--port 8788]     print the links to open on the tablet
`;

async function serve(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: "string", default: "8788" },
      host: { type: "string", default: "0.0.0.0" },
      data: { type: "string", default: join(CONFIG, "scratch") },
      board: { type: "string", multiple: true, default: [] },
    },
  });
  const token = await loadToken(join(CONFIG, "token"));
  const store = new Store(resolve(values.data));
  for (const image of values.board) {
    const board = await store.addBoard(resolve(image), basename(image, extname(image)), "me");
    console.log(`added board ${board.title}`);
  }
  const server = createPaddServer({ token, store, uiDir: join(ROOT, "ui"), jsDir: join(ROOT, "dist", "web") });
  const port = Number(values.port);
  server.listen(port, values.host, () => {
    console.log("PADD online.");
    printLinks(token, port);
  });
}

async function link(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { port: { type: "string", default: "8788" } } });
  printLinks(await loadToken(join(CONFIG, "token")), Number(values.port));
}

function printLinks(token: string, port: number): void {
  console.log("Open one of these on the tablet (once; it remembers):");
  for (const host of lanAddresses()) console.log(`  http://${host}:${port}/?token=${token}`);
}

/** IPv4 addresses other devices on the LAN can reach this machine at. */
function lanAddresses(): string[] {
  const out: string[] = [];
  for (const nics of Object.values(networkInterfaces())) {
    for (const nic of nics ?? []) if (nic.family === "IPv4" && !nic.internal) out.push(nic.address);
  }
  return out.length > 0 ? out : ["localhost"];
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case "serve":
    await serve(rest);
    break;
  case "link":
    await link(rest);
    break;
  default:
    process.stderr.write(USAGE);
    process.exit(command === undefined || command === "help" ? 0 : 2);
}
