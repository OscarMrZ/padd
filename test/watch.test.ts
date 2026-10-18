import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Events } from "../src/daemon/events.ts";
import { initRepo, Registry } from "../src/daemon/registry.ts";
import { Watcher } from "../src/daemon/watch.ts";
import type { PaddEvent } from "../src/shared/types.ts";

const until = async (check: () => boolean, ms = 5000) => {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out");
};

test("images saved in a watched folder become boards once per picture", async () => {
  const root = await mkdtemp(join(tmpdir(), "padd-watch-"));
  const repo = join(root, "tofu");
  const renders = join(repo, "mood", "renders");
  await mkdir(renders, { recursive: true });
  await writeFile(join(renders, "old.png"), "already there");
  await initRepo(repo);
  const registry = new Registry(join(root, "projects.json"));
  const project = await registry.project(await registry.register(repo));
  await project.addSubproject("mood", "");
  await project.setWatch("mood", [renders]);

  const events = new Events();
  const seen: PaddEvent[] = [];
  events.emit = (e) => void seen.push(e);
  const watcher = new Watcher(registry, events);
  await watcher.sync();
  try {
    await until(() => seen.length === 1); // the image already in the folder
    await writeFile(join(renders, "head.png"), "v1");
    await writeFile(join(renders, "notes.txt"), "not an image");
    await until(() => seen.length === 2);
    await writeFile(join(renders, "head.png"), "v2"); // a re-render: new board
    await until(() => seen.length === 3);
    await writeFile(join(renders, "copy.png"), "v2"); // same pixels again: skipped
    await new Promise((r) => setTimeout(r, 1500));
    const titles = seen.map((e) => (e.type === "board" ? e.board.title : e.type));
    assert.deepEqual(titles, ["old", "head", "head"]);
    assert.equal((await (await project.store("mood")).boards()).length, 3);
  } finally {
    watcher.close();
    events.close();
  }
});

test("projects set up while padd runs are watched too", async () => {
  const root = await mkdtemp(join(tmpdir(), "padd-watch-late-"));
  const registry = new Registry(join(root, "config", "projects.json"));
  const events = new Events();
  const seen: PaddEvent[] = [];
  events.emit = (e) => void seen.push(e);
  const watcher = new Watcher(registry, events);
  await mkdir(join(root, "config"), { recursive: true });
  await watcher.sync(); // nothing registered yet
  try {
    const repo = join(root, "late");
    await mkdir(join(repo, "out"), { recursive: true });
    await initRepo(repo);
    const project = await registry.project(await registry.register(repo));
    await project.addSubproject("plots", "");
    await project.setWatch("plots", [join(repo, "out")]);
    await new Promise((r) => setTimeout(r, 600)); // let the config change land
    await writeFile(join(repo, "out", "loss.png"), "a plot");
    await until(() => seen.length === 1);
    assert.equal(seen[0]!.type === "board" && seen[0]!.board.title, "loss");
  } finally {
    watcher.close();
    events.close();
  }
});
