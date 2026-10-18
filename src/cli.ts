#!/usr/bin/env node
// padd: draw feedback for Claude Code sessions from a tablet.

import { homedir, networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadToken } from "./daemon/auth.ts";
import { findRepo, initRepo, PADD_DIR, Registry } from "./daemon/registry.ts";
import { createPaddServer } from "./daemon/server.ts";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const CONFIG = process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, "padd") : join(homedir(), ".config", "padd");
const PORT = "8788";

const USAGE = `usage:
  padd init [--name <name>]           make this repo a padd project (writes ${PADD_DIR}/)
  padd serve [--port ${PORT}] [--host 0.0.0.0]
  padd link [--port ${PORT}]           print the links to open on the tablet
  padd board <subproject> <image>...  show images on the tablet (padd serve must be running)
`;

const registry = new Registry(join(CONFIG, "projects.json"));

async function init(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { name: { type: "string" } } });
  const repo = process.cwd();
  const created = await initRepo(repo, values.name);
  const id = await registry.register(repo);
  console.log(created ? `${repo} is now padd project "${id}".` : `${repo} is padd project "${id}" (already set up).`);
  console.log(`Commit ${PADD_DIR}/config.json and ${PADD_DIR}/.gitignore; boards stay local in ${PADD_DIR}/data/.`);
}

async function serve(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { port: { type: "string", default: PORT }, host: { type: "string", default: "0.0.0.0" } },
  });
  const token = await loadToken(join(CONFIG, "token"));
  const { server } = createPaddServer({ token, registry, uiDir: join(ROOT, "ui"), jsDir: join(ROOT, "dist", "web") });
  const port = Number(values.port);
  server.listen(port, values.host, () => {
    console.log("PADD online.");
    printLinks(token, port);
  });
}

async function link(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { port: { type: "string", default: PORT } } });
  printLinks(await loadToken(join(CONFIG, "token")), Number(values.port));
}

async function board(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { port: { type: "string", default: PORT }, title: { type: "string" } },
  });
  const [sub, ...images] = positionals;
  if (!sub || images.length === 0) throw new Error("usage: padd board <subproject> <image>...");
  const project = await registry.register(await findRepo(process.cwd()));
  const token = await loadToken(join(CONFIG, "token"));
  for (const image of images) {
    const url = `http://127.0.0.1:${values.port}/api/p/${project}/${sub}/boards`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ path: resolve(image), title: images.length === 1 ? values.title : undefined }),
      });
    } catch {
      throw new Error(`padd isn't running on port ${values.port}; start it with padd serve`);
    }
    const data = (await res.json()) as { title?: string; error?: string };
    if (!res.ok) throw new Error(`${image}: ${data.error ?? res.status}`);
    console.log(`${project}/${sub}: added ${data.title}`);
  }
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

const commands: Record<string, (argv: string[]) => Promise<void>> = { init, serve, link, board };
const [command, ...rest] = process.argv.slice(2);
const run = command ? commands[command] : undefined;
if (!run) {
  process.stderr.write(USAGE);
  process.exit(command === undefined || command === "help" ? 0 : 2);
}
try {
  await run(rest);
} catch (e) {
  console.error(`padd: ${(e as Error).message}`);
  process.exit(1);
}
