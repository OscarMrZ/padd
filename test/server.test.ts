import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { after, before, test } from "node:test";
import { createPaddServer } from "../src/daemon/server.ts";
import { Store } from "../src/daemon/store.ts";

const TOKEN = "test-token-123";
let base = "";
let board = "";
let server: Server;

before(async () => {
  const dir = await mkdtemp(join(tmpdir(), "padd-server-"));
  await writeFile(join(dir, "index.html"), "<p>padd</p>");
  await writeFile(join(dir, "r.png"), "png");
  const store = new Store(join(dir, "data"));
  board = (await store.addBoard(join(dir, "r.png"), "r", "me")).id;
  server = createPaddServer({ token: TOKEN, store, uiDir: dir, jsDir: dir });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const auth = { Authorization: `Bearer ${TOKEN}` };

test("requests without the token are refused", async () => {
  assert.equal((await fetch(`${base}/`)).status, 401);
  assert.equal((await fetch(`${base}/api/boards`)).status, 401);
  assert.equal((await fetch(`${base}/api/boards`, { headers: { Authorization: "Bearer nope" } })).status, 401);
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

test("strokes round-trip, with the server choosing id and author", async () => {
  const post = await fetch(`${base}/api/boards/${board}/strokes`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ id: "mine", author: "claude", tool: "pen", color: "#f2a65a", size: 3, points: [[1, 2, 7]] }),
  });
  assert.equal(post.status, 201);
  const { id } = (await post.json()) as { id: string };
  const ink = (await (await fetch(`${base}/api/boards/${board}`, { headers: auth })).json()) as {
    strokes: { id: string; author: string; points: number[][] }[];
  };
  const s = ink.strokes.find((x) => x.id === id)!;
  assert.equal(s.author, "me");
  assert.deepEqual(s.points, [[1, 2, 1]]);
});

test("bad strokes and paths are rejected", async () => {
  const bad = await fetch(`${base}/api/boards/${board}/strokes`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ tool: "laser", color: "#fff", size: 3, points: [] }),
  });
  assert.equal(bad.status, 400);
  assert.equal((await fetch(`${base}/js/..%2f..%2fetc%2fpasswd`, { headers: auth })).status, 404);
  assert.equal((await fetch(`${base}/api/boards/zzzzzzzzzzzz`, { headers: auth })).status, 404);
});
