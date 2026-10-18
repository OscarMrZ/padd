import assert from "node:assert/strict";
import { appendFile, mkdtemp, writeFile } from "node:fs/promises";
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
