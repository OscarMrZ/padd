import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { initRepo, Registry } from "../src/daemon/registry.ts";
import { createPaddServer } from "../src/daemon/server.ts";
import type { Board, PaddEvent, ProjectSummary } from "../src/shared/types.ts";

const TOKEN = "test-token-123";
const auth = { Authorization: `Bearer ${TOKEN}` };
let base = "";
let api = "";
let image = "";
let server: Server;

before(async () => {
  const root = await mkdtemp(join(tmpdir(), "padd-server-"));
  const repo = join(root, "tofu");
  await mkdir(repo);
  await initRepo(repo);
  const registry = new Registry(join(root, "projects.json"));
  const project = await registry.project(await registry.register(repo));
  await project.addSubproject("mood", "");
  await writeFile(join(root, "index.html"), "<p>padd</p>");
  image = join(root, "r.png");
  await writeFile(image, "png");
  server = createPaddServer({ token: TOKEN, registry, uiDir: root, jsDir: root }).server;
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  api = `${base}/api/p/tofu/mood/boards`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: "POST", headers: { ...auth, ...headers }, body: JSON.stringify(body) });

async function addBoard(): Promise<Board> {
  const res = await post(api, { path: image, title: "front", author: "claude" });
  assert.equal(res.status, 201);
  return (await res.json()) as Board;
}

/** Collects events from /api/events until `n` arrive. */
async function nextEvents(n: number, during: () => Promise<unknown>): Promise<PaddEvent[]> {
  const res = await fetch(`${base}/api/events`, { headers: auth });
  const reader = res.body!.getReader();
  const got: PaddEvent[] = [];
  await during();
  let buf = "";
  while (got.length < n) {
    const { value } = await reader.read();
    buf += new TextDecoder().decode(value);
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (chunk.startsWith("data: ")) got.push(JSON.parse(chunk.slice(6)) as PaddEvent);
    }
  }
  await reader.cancel();
  return got;
}

test("requests without the token are refused", async () => {
  assert.equal((await fetch(`${base}/`)).status, 401);
  assert.equal((await fetch(`${base}/api/projects`)).status, 401);
  assert.equal((await fetch(`${base}/api/events`)).status, 401);
  assert.equal((await fetch(`${base}/api/projects`, { headers: { Authorization: "Bearer nope" } })).status, 401);
  assert.equal((await fetch(`${base}/?token=nope`, { redirect: "manual" })).status, 401);
});

test("the printed link trades the token for a cookie and hides it", async () => {
  const res = await fetch(`${base}/?token=${TOKEN}`, { redirect: "manual" });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/");
  const cookie = res.headers.get("set-cookie")!;
  assert.match(cookie, /HttpOnly/);
  const page = await fetch(`${base}/`, { headers: { Cookie: cookie.split(";")[0]! } });
  assert.equal(await page.text(), "<p>padd</p>");
});

test("projects list their subprojects and board counts", async () => {
  await addBoard();
  const projects = (await (await fetch(`${base}/api/projects`, { headers: auth })).json()) as ProjectSummary[];
  assert.equal(projects[0]!.name, "tofu");
  assert.deepEqual(projects[0]!.subprojects.map((s) => s.id), ["mood"]);
  assert.ok(projects[0]!.boards.mood! >= 1);
});

test("a new board is announced to every open view", async () => {
  let board: Board | undefined;
  const [e] = await nextEvents(1, async () => (board = await addBoard()));
  assert.deepEqual(e, { type: "board", project: "tofu", sub: "mood", board });
});

test("strokes round-trip and are broadcast with their origin", async () => {
  const board = await addBoard();
  let id = "";
  const [e] = await nextEvents(1, async () => {
    const res = await post(`${api}/${board.id}/strokes`, {
      id: "mine", author: "claude", tool: "pen", color: "#f2a65a", size: 3, points: [[1, 2, 7]],
    }, { "X-Padd-Client": "tab1" });
    assert.equal(res.status, 201);
    id = ((await res.json()) as { id: string }).id;
  });
  assert.equal(e!.type, "stroke");
  assert.equal((e as { origin?: string }).origin, "tab1");
  const ink = (await (await fetch(`${api}/${board.id}`, { headers: auth })).json()) as {
    strokes: { id: string; author: string; points: number[][] }[];
  };
  const s = ink.strokes.find((x) => x.id === id)!;
  assert.equal(s.author, "me");
  assert.deepEqual(s.points, [[1, 2, 1]]);
});

test("subprojects can be created from the tablet", async () => {
  const res = await post(`${base}/api/p/tofu/subprojects`, { title: "Hip bracket", brief: "print-in-place hinge" });
  assert.equal(res.status, 201);
  assert.equal(((await res.json()) as { id: string }).id, "hip-bracket");
  assert.equal((await post(`${base}/api/p/tofu/subprojects`, { title: "hip bracket" })).status, 400);
});

test("bad input and unknown places are rejected", async () => {
  const board = await addBoard();
  assert.equal((await post(`${api}/${board.id}/strokes`, { tool: "laser", color: "#fff", size: 3, points: [] })).status, 400);
  assert.equal((await post(api, { path: "relative.png" })).status, 400);
  assert.equal((await post(api, { path: "/etc/passwd" })).status, 400);
  assert.equal((await fetch(`${base}/js/..%2f..%2fetc%2fpasswd`, { headers: auth })).status, 404);
  assert.equal((await fetch(`${base}/api/p/nope/mood/boards`, { headers: auth })).status, 404);
  assert.equal((await fetch(`${base}/api/p/tofu/nope/boards`, { headers: auth })).status, 404);
  assert.equal((await fetch(`${api}/zzzzzzzzzzzz`, { headers: auth })).status, 404);
});
