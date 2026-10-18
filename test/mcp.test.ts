// End to end: padd serve in-process, padd mcp as a real child process, driven by an MCP client
// the way Claude Code drives it.
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { initRepo, Registry } from "../src/daemon/registry.ts";
import { createPaddServer } from "../src/daemon/server.ts";
import type { Message, SessionState } from "../src/shared/types.ts";

const TOKEN = "mcp-test-token";
const SESSION = "11111111-2222-3333-4444-555555555555";
const auth = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
let server: Server;
let base = "";
let repo = "";
let image = "";
let client: Client;
const channel: { content: string; meta: Record<string, string> }[] = [];

const until = async (check: () => boolean | Promise<boolean>, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out");
};
const get = async <T>(path: string) => (await (await fetch(`${base}${path}`, { headers: auth })).json()) as T;
const tool = async (name: string, args: Record<string, unknown> = {}) => {
  const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  return { text: r.content[0]!.text, error: r.isError === true };
};
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a9d40000000049454e44ae426082", "hex");

before(async () => {
  const root = await mkdtemp(join(tmpdir(), "padd-mcp-"));
  repo = join(root, "tofu");
  await mkdir(repo);
  await initRepo(repo);
  const config = join(root, "config");
  await mkdir(join(config, "padd"), { recursive: true });
  await writeFile(join(config, "padd", "token"), TOKEN);
  const registry = new Registry(join(config, "padd", "projects.json"));
  const project = await registry.project(await registry.register(repo));
  await project.addSubproject("mood", "the look");
  image = join(root, "render.png");
  await writeFile(image, PNG);

  server = createPaddServer({
    token: TOKEN,
    registry,
    uiDir: root,
    jsDir: root,
    launch: { socket: `padd-mcp-test-${process.pid}`, command: () => ["true"], terminal: () => {} },
  }).server;
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;

  client = new Client({ name: "test", version: "0" });
  client.fallbackNotificationHandler = async (n) => {
    if (n.method === "notifications/claude/channel") channel.push(n.params as (typeof channel)[number]);
  };
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(import.meta.dirname, "..", "src", "cli.ts"), "mcp"],
      env: { ...process.env, XDG_CONFIG_HOME: config, PADD_PORT: String(port), CLAUDE_CODE_SESSION_ID: SESSION, CLAUDE_PROJECT_DIR: repo },
    }),
  );
});
after(async () => {
  await client.close();
  server.closeAllConnections();
  server.close();
});

test("the server declares itself a channel with instructions", () => {
  assert.ok(client.getServerCapabilities()?.experimental?.["claude/channel"]);
  assert.match(client.getInstructions() ?? "", /<channel source="padd"/);
});

const send = (body: Record<string, unknown>) =>
  fetch(`${base}/api/p/tofu/mood/send`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ snapshot: `data:image/png;base64,${PNG.toString("base64")}`, ...body }),
  });

test("an unlinked session is told to link; a Send made meanwhile waits for it", async () => {
  assert.match((await tool("reply", { text: "hi" })).text, /link this session/);
  const early = await send({ text: "made before Claude was here" });
  assert.equal(((await early.json()) as { delivered: boolean }).delivered, false);
  assert.equal((await get<SessionState>("/api/p/tofu/mood/session")).live, false);

  assert.match((await tool("link", { subproject: "mood" })).text, /Linked to tofu\/mood/);
  assert.equal((await get<SessionState>("/api/p/tofu/mood/session")).live, true);
  await until(() => channel.length === 1);
  assert.equal(channel[0]!.content, "made before Claude was here");
});

test("show puts images on the tablet once", async () => {
  const first = await tool("show", { paths: [image], title: "render" });
  assert.match(first.text, /render \(board /);
  await tool("show", { paths: [image] });
  assert.equal((await get<unknown[]>("/api/p/tofu/mood/boards")).length, 1);
  assert.equal((await tool("show", { paths: ["/no/such.png"] })).error, true);
});

test("a Send from the tablet arrives as a channel event, and reply answers it", async () => {
  const [board] = await get<{ id: string }[]>("/api/p/tofu/mood/boards");
  const res = await send({ board: board!.id, text: "rounder head" });
  assert.equal(res.status, 201);
  assert.equal(((await res.json()) as { delivered: boolean }).delivered, true);
  await until(() => channel.length === 2);
  const e = channel[1]!;
  assert.equal(e.content, "rounder head");
  assert.equal(e.meta.subproject, "mood");
  assert.equal(e.meta.board, board!.id);
  assert.match(e.meta.snapshot!, /\.padd\/data\/mood\/sends\/.+\.png$/);
  assert.match(e.meta.image!, /\.padd\/data\/mood\/boards\/.+\/image\.png$/);

  await tool("reply", { text: "Rounded it; new render is up.", board: board!.id });
  const talk = await get<Message[]>("/api/p/tofu/mood/messages");
  assert.deepEqual(talk.map((m) => [m.author, m.delivered ?? null]), [["me", true], ["me", true], ["claude", null]]);
});

test("bad Sends are refused", async () => {
  assert.equal((await send({ snapshot: undefined })).status, 400);
  assert.equal((await send({ snapshot: "data:image/png;base64,aGVsbG8=" })).status, 400);
  assert.equal((await send({ board: "zzzzzzzzzzzz" })).status, 404);
});

test("status tells Claude where it stands", async () => {
  const s = JSON.parse((await tool("status")).text) as { project: string; linked: string; boards: number };
  assert.deepEqual([s.project, s.linked, s.boards], ["tofu", "mood", 1]);
});

test("the tablet can't start a second copy of a session that is already connected", async () => {
  const start = await fetch(`${base}/api/p/tofu/mood/session/start`, { method: "POST", headers: auth, body: "{}" });
  assert.equal(start.status, 409);
  assert.match(((await start.json()) as { error: string }).error, /already connected from a terminal/);
  const window = await fetch(`${base}/api/p/tofu/mood/session/window`, { method: "POST", headers: auth, body: "{}" });
  assert.equal(window.status, 409);
});
