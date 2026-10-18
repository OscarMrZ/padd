import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Invalid, NotFound, Store } from "../src/daemon/store.ts";
import type { Stroke } from "../src/shared/types.ts";

async function fixture(): Promise<{ store: Store; image: string }> {
  const dir = await mkdtemp(join(tmpdir(), "padd-store-"));
  const image = join(dir, "render.png");
  await writeFile(image, "not really a png");
  return { store: new Store(join(dir, "data")), image };
}

const stroke = (id: string): Stroke => ({ id, author: "me", tool: "pen", color: "#f2a65a", size: 2, points: [[1, 2, 0.5]], t: 1 });

test("a new store has no boards", async () => {
  const { store } = await fixture();
  assert.deepEqual(await store.boards(), []);
});

test("boards keep their image and list oldest first", async () => {
  const { store, image } = await fixture();
  const a = await store.addBoard(image, "front", "me");
  const b = await store.addBoard(image, "side", "claude");
  assert.deepEqual((await store.boards()).map((x) => x.title), ["front", "side"]);
  assert.equal((await store.board(b.id)).author, "claude");
  assert.match(await store.imagePath(a.id), /image\.png$/);
});

test("ink replays adds and erases", async () => {
  const { store, image } = await fixture();
  const { id } = await store.addBoard(image, "front", "me");
  await store.addStroke(id, stroke("s1"));
  await store.addStroke(id, stroke("s2"));
  await store.erase(id, ["s1"]);
  assert.deepEqual((await store.ink(id)).strokes.map((s) => s.id), ["s2"]);
});

test("a torn last line is skipped, not fatal", async () => {
  const { store, image } = await fixture();
  const { id } = await store.addBoard(image, "front", "me");
  await store.addStroke(id, stroke("s1"));
  await appendFile(join(store.dir, "boards", id, "ink.jsonl"), '{"op":"add","stro');
  assert.equal((await store.ink(id)).strokes.length, 1);
});

test("unknown boards, bad ids and odd images are refused", async () => {
  const { store, image } = await fixture();
  await assert.rejects(store.ink("zzzzzzzzzzzz"), NotFound);
  await assert.rejects(store.ink("../../etc"), NotFound);
  await assert.rejects(store.addBoard(image.replace(".png", ".gif"), "x", "me"), Invalid);
});

test("messages log adds and deliveries", async () => {
  const { store } = await fixture();
  assert.deepEqual(await store.messages(), []);
  const a = await store.addMessage({ author: "me", text: "rounder head", snapshot: "/x.png", delivered: false });
  await store.addMessage({ author: "claude", text: "on it" });
  await store.markDelivered([a.id]);
  const all = await store.messages();
  assert.deepEqual(all.map((m) => [m.author, m.text, m.delivered]), [["me", "rounder head", true], ["claude", "on it", undefined]]);
});

test("the linked session survives a restart", async () => {
  const { store } = await fixture();
  assert.equal(await store.session(), undefined);
  await store.setSession("48751088-e4c7-43f5-8db7-650b95022522");
  assert.equal(await new Store(store.dir).session(), "48751088-e4c7-43f5-8db7-650b95022522");
});

test("hashes cover old boards too", async () => {
  const { store, image } = await fixture();
  const b = await store.addBoard(image, "front", "me");
  // A board from before hashes existed:
  const path = join(store.dir, "boards", b.id, "board.json");
  const { hash, ...old } = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify(old));
  assert.deepEqual([...(await store.hashes())], [hash]);
  assert.equal(JSON.parse(await readFile(path, "utf8")).hash, hash);
});
