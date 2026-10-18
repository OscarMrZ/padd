import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findRepo, initRepo, Registry, slug } from "../src/daemon/registry.ts";
import { Invalid, NotFound } from "../src/daemon/store.ts";

async function repo(name: string): Promise<{ root: string; registry: Registry }> {
  const root = await mkdtemp(join(tmpdir(), "padd-reg-"));
  const path = join(root, name);
  await mkdir(path);
  await initRepo(path);
  return { root: path, registry: new Registry(join(root, "config", "projects.json")) };
}

test("slug keeps letters, digits and single dashes", () => {
  assert.equal(slug("Mood & Look  v2"), "mood-look-v2");
  assert.equal(slug("  --Héad--  "), "head");
  assert.equal(slug("!!!"), "");
});

test("init writes the config and keeps data out of git", async () => {
  const { root } = await repo("tofu");
  const config = JSON.parse(await readFile(join(root, ".padd", "config.json"), "utf8"));
  assert.deepEqual(config, { name: "tofu", subprojects: [] });
  assert.match(await readFile(join(root, ".padd", ".gitignore"), "utf8"), /^data\/$/m);
  assert.equal(await initRepo(root), false); // second run changes nothing
});

test("register is idempotent and keeps ids unique", async () => {
  const { root, registry } = await repo("tofu");
  assert.equal(await registry.register(root), "tofu");
  assert.equal(await registry.register(root), "tofu");
  const other = join(root, "..", "elsewhere");
  await mkdir(other);
  await initRepo(other, "tofu");
  assert.equal(await registry.register(other), "tofu-2");
  assert.deepEqual((await registry.projects()).map((p) => p.id), ["tofu", "tofu-2"]);
});

test("subprojects are created once, with a clean id", async () => {
  const { root, registry } = await repo("tofu");
  const project = await registry.project(await registry.register(root));
  const sub = await project.addSubproject("  Mood board ", "the look of tofu");
  assert.deepEqual(sub, { id: "mood-board", title: "Mood board", brief: "the look of tofu" });
  await assert.rejects(project.addSubproject("mood board", ""), Invalid);
  await assert.rejects(project.addSubproject("???", ""), Invalid);
  assert.match((await project.store("mood-board")).dir, /\.padd\/data\/mood-board$/);
  await assert.rejects(project.store("nope"), NotFound);
});

test("findRepo walks up to the nearest .padd", async () => {
  const { root } = await repo("tofu");
  const deep = join(root, "mood", "renders");
  await mkdir(deep, { recursive: true });
  assert.equal(await findRepo(deep), root);
  await assert.rejects(findRepo(tmpdir()), NotFound);
});
