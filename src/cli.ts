#!/usr/bin/env node
// padd: draw feedback for Claude Code sessions from a tablet.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { homedir, networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadToken } from "./daemon/auth.ts";
import { findRepo, initRepo, installMcp, PADD_DIR, Registry } from "./daemon/registry.ts";
import { ghostty, Launcher, SOCKET, tmuxName } from "./daemon/launcher.ts";
import { createPaddServer } from "./daemon/server.ts";
import { Watcher } from "./daemon/watch.ts";
import { runMcp, sessionFromEnv } from "./mcp/server.ts";
import { install, state, uninstall } from "./service.ts";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const CONFIG = process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, "padd") : join(homedir(), ".config", "padd");
const PORT = "8788";

const USAGE = `usage:
  padd service install|uninstall|status       run PADD in the background (systemd user service)
  padd serve [--port ${PORT}] [--host 0.0.0.0]   run PADD in this terminal instead
  padd link [--port ${PORT}]                     print the links to open on the tablet

  padd sessions                       every subproject's Claude session, across projects
  padd attach [<project>/]<subproject>  talk to a session here (starts it in the background if needed)

  in a repo:
  padd init [--name <name>]           make it a padd project (${PADD_DIR}/, .mcp.json)
  padd claude <subproject> [--new]    run the subproject's session in this terminal (not in the background)
  padd board <subproject> <image>...  show images on the tablet
  padd watch <subproject> [<dir>...]  images saved in these folders show up on their own (none: stop)
  padd session <subproject> [<id>]    show or set the Claude session linked to a subproject

  padd mcp                            the MCP server Claude Code runs (from .mcp.json)
`;

const registry = new Registry(join(CONFIG, "projects.json"));

async function init(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { name: { type: "string" } } });
  const repo = process.cwd();
  const created = await initRepo(repo, values.name);
  const id = await registry.register(repo);
  const wired = await installMcp(repo);
  console.log(created ? `${repo} is now padd project "${id}".` : `${repo} is padd project "${id}".`);
  if (wired.length > 0) console.log(`Wired Claude Code to padd: ${wired.join(", ")}.`);
  console.log(`Commit ${PADD_DIR}/config.json, ${PADD_DIR}/.gitignore and .mcp.json; boards stay local in ${PADD_DIR}/data/.`);
}

async function serve(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { port: { type: "string", default: PORT }, host: { type: "string", default: "0.0.0.0" } },
  });
  const token = await loadToken(join(CONFIG, "token"));
  const { server, events } = createPaddServer({
    token,
    registry,
    uiDir: join(ROOT, "ui"),
    jsDir: join(ROOT, "dist", "web"),
    // Sessions run `padd claude <sub>` with this very node and padd, whatever the PATH.
    launch: {
      socket: SOCKET,
      command: (place) => [process.execPath, join(ROOT, "src", "cli.ts"), "claude", place.sub],
      terminal: ghostty,
      scope: true,
    },
  });
  const watcher = new Watcher(registry, events);
  const port = Number(values.port);
  server.listen(port, values.host, () => {
    console.log(`PADD online on ${values.host}:${port}.`);
    // The links carry the token: show them in a terminal, never in the journal.
    if (process.stdout.isTTY) printLinks(token, port);
    else console.log("Tablet links: run padd link.");
    void watcher.sync();
  });
}

async function service(argv: string[]): Promise<void> {
  const [action] = argv;
  if (action === "install") {
    const path = await install({ node: process.execPath, cli: join(ROOT, "src", "cli.ts"), root: ROOT });
    console.log(`PADD now runs in the background (${path}): ${await state()}.`);
    console.log("It starts with your desktop session. Logs: journalctl --user -u padd -f");
  } else if (action === "uninstall") {
    await uninstall();
    console.log("PADD no longer runs in the background.");
  } else if (action === "status" || action === undefined) {
    console.log(`padd.service: ${await state()}. Logs: journalctl --user -u padd -f`);
  } else {
    throw new Error("usage: padd service install|uninstall|status");
  }
}

async function mcp(): Promise<void> {
  await runMcp({
    token: await loadToken(join(CONFIG, "token")),
    port: Number(process.env.PADD_PORT ?? PORT),
    session: sessionFromEnv(),
    repo: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
    sub: process.env.PADD_SUBPROJECT || undefined,
  });
}

/** Runs claude here, in this terminal, as the subproject's session with the padd channel on. */
async function claude(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { new: { type: "boolean" } } });
  const [subId] = positionals;
  if (!subId) throw new Error("usage: padd claude <subproject> [--new]");
  const repo = await findRepo(process.cwd());
  const project = await registry.project(await registry.register(repo));
  const sub = await project.subproject(subId);
  const store = await project.store(sub.id);
  const linked = values.new ? undefined : await store.session();
  // A linked session that never got going (Claude quit at a prompt) has no transcript to resume.
  const resume = linked !== undefined && (await transcriptExists(linked));
  // The channel flag takes a list: it goes first, so it can't swallow the prompt at the end.
  const args = ["--dangerously-load-development-channels", "server:padd"];
  if (resume) {
    args.push("--resume", linked);
  } else {
    const id = linked ?? randomUUID();
    await store.setSession(id);
    args.push("--session-id", id, "--name", `${project.id}/${sub.id}`);
  }
  if (!resume) args.push(firstPrompt(project.id, sub.title, sub.brief));
  console.log(resume ? `Resuming ${project.id}/${sub.id} (${linked}).` : `Starting ${project.id}/${sub.id}.`);
  console.log("Claude Code asks once to confirm the development channel: choose option 1.");
  const child = spawn("claude", args, { cwd: repo, stdio: "inherit", env: { ...process.env, PADD_SUBPROJECT: sub.id } });
  await new Promise<void>((done) => child.on("exit", (code) => {
    process.exitCode = code ?? 0;
    done();
  }));
}

/** Whether Claude Code has a transcript for a session (~/.claude/projects/<folder>/<id>.jsonl). */
async function transcriptExists(id: string): Promise<boolean> {
  const root = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
  let folders: string[];
  try {
    folders = await readdir(root);
  } catch {
    return false;
  }
  for (const folder of folders) {
    try {
      await stat(join(root, folder, `${id}.jsonl`));
      return true;
    } catch {
      // not in this folder
    }
  }
  return false;
}

function firstPrompt(project: string, title: string, brief: string): string {
  return [
    `You're working on "${title}" in ${project}. The user reviews your work on PADD, their drawing tablet: show them images with the padd show tool, read their Sends (marked-up snapshots), and answer with padd reply.`,
    brief ? `Brief: ${brief}` : "",
    "Start with padd status, then tell the user on the tablet what you plan to do first.",
  ].filter(Boolean).join("\n\n");
}

// ---------- sessions on this computer ----------

const tmux = new Launcher({ socket: SOCKET, command: () => [], terminal: () => {} });

/** Calls padd serve; undefined if it isn't running. */
async function daemon<T>(path: string, body?: unknown): Promise<T | undefined> {
  const token = await loadToken(join(CONFIG, "token"));
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${process.env.PADD_PORT ?? PORT}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    return undefined;
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `padd answered ${res.status}`);
  return data;
}

interface Row {
  project: string;
  sub: string;
  state: string;
  session: string;
  active?: number;
}

async function rows(): Promise<Row[]> {
  const live = new Map<string, boolean>();
  for (const p of (await daemon<{ id: string; live: Record<string, boolean> }[]>("/api/projects")) ?? []) {
    for (const [sub, on] of Object.entries(p.live)) live.set(`${p.id}/${sub}`, on);
  }
  const out: Row[] = [];
  for (const p of await registry.projects()) {
    const project = await registry.project(p.id);
    for (const s of p.subprojects) {
      const place = { project: p.id, sub: s.id };
      const session = await (await project.store(s.id)).session();
      const running = await tmux.running(place);
      const here = live.get(`${p.id}/${s.id}`) ?? false;
      const state = running
        ? (await tmux.attached(place)) ? "open" : "background"
        : here ? "terminal" : session ? "stopped" : "none";
      out.push({ project: p.id, sub: s.id, state, session: session ?? "", active: session ? await lastActive(session) : undefined });
    }
  }
  return out;
}

const STATES: Record<string, string> = {
  open: "running, window open",
  background: "running in the background",
  terminal: "running in your own terminal",
  stopped: "stopped (attach resumes it)",
  none: "no session yet",
};

async function sessions(): Promise<void> {
  const all = await rows();
  if (all.length === 0) return console.log("No subprojects yet. Run padd init in a repo, then create one on the tablet.");
  const tty = process.stdout.isTTY;
  const paint = (code: string, text: string) => (tty ? `\x1b[${code}m${text}\x1b[0m` : text);
  const color: Record<string, string> = { open: "35", background: "35", terminal: "35", stopped: "33", none: "2" };
  const place = (r: Row) => `${r.project}/${r.sub}`;
  const width = Math.max(...all.map((r) => place(r).length));
  for (const r of all) {
    const when = r.active ? ago(r.active) : "";
    const id = r.session ? paint("2", r.session.slice(0, 8)) : "";
    console.log(`${place(r).padEnd(width)}  ${paint(color[r.state] ?? "0", (STATES[r.state] ?? r.state).padEnd(30))}  ${id}  ${paint("2", when)}`);
  }
  console.log(paint("2", "\npadd attach <project>/<subproject> talks to one here."));
}

function ago(t: number): string {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return "active now";
  if (m < 60) return `active ${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `active ${h} h ago` : `active ${Math.round(h / 24)} days ago`;
}

async function lastActive(id: string): Promise<number | undefined> {
  const root = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
  for (const folder of await readdir(root).catch(() => [] as string[])) {
    try {
      return (await stat(join(root, folder, `${id}.jsonl`))).mtimeMs;
    } catch {
      // not in this folder
    }
  }
  return undefined;
}

/** Attaches this terminal to a session, starting it in the background first if it's stopped. */
async function attach(argv: string[]): Promise<void> {
  const [target] = argv;
  if (!target) throw new Error("usage: padd attach [<project>/]<subproject>");
  let [projectId, subId] = target.includes("/") ? target.split("/", 2) : [undefined, target];
  if (!projectId) projectId = await registry.register(await findRepo(process.cwd()));
  const project = await registry.project(projectId);
  const sub = await project.subproject(subId!);
  const place = { project: project.id, sub: sub.id };
  if (!(await tmux.running(place))) {
    const state = await daemon<{ live: boolean }>(`/api/p/${place.project}/${place.sub}/session`);
    if (state?.live) throw new Error(`${place.project}/${place.sub} runs in a terminal you started yourself; switch to that one`);
    const started = await daemon<{ result: string }>(`/api/p/${place.project}/${place.sub}/session/start`, {});
    if (!started) throw new Error("padd isn't running (padd service status); or run padd claude here instead");
    for (let i = 0; i < 50 && !(await tmux.running(place)); i++) await new Promise((r) => setTimeout(r, 100));
  }
  // Detach with Ctrl-b d: the session keeps running in the background.
  const child = spawn("tmux", ["-L", SOCKET, "attach", "-t", `=${tmuxName(place)}`], { stdio: "inherit" });
  await new Promise<void>((done) => child.on("exit", (code) => {
    process.exitCode = code ?? 0;
    done();
  }));
}

async function watchCmd(argv: string[]): Promise<void> {
  const [subId, ...dirs] = argv;
  if (!subId) throw new Error("usage: padd watch <subproject> [<dir>...]");
  const project = await registry.project(await registry.register(await findRepo(process.cwd())));
  const sub = await project.setWatch(subId, dirs.map((d) => resolve(d)));
  console.log(sub.watch ? `${project.id}/${sub.id} watches ${sub.watch.join(", ")}.` : `${project.id}/${sub.id} watches nothing.`);
  console.log(`Commit ${PADD_DIR}/config.json to keep it. A running padd serve picks it up now.`);
}

async function session(argv: string[]): Promise<void> {
  const [subId, id] = argv;
  if (!subId) throw new Error("usage: padd session <subproject> [<id>]");
  const project = await registry.project(await registry.register(await findRepo(process.cwd())));
  const store = await project.store((await project.subproject(subId)).id);
  if (id) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("a Claude Code session id looks like 48751088-e4c7-43f5-8db7-650b95022522");
    await store.setSession(id);
  }
  const linked = await store.session();
  console.log(linked ? `${project.id}/${subId} is linked to session ${linked}.` : `${project.id}/${subId} has no session yet.`);
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

const commands: Record<string, (argv: string[]) => Promise<void>> = {
  init,
  service,
  serve,
  link,
  board,
  claude,
  sessions,
  ls: sessions,
  attach,
  watch: watchCmd,
  session,
  mcp,
};
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
