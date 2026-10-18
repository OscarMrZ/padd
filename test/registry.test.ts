import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findRepo, initRepo, installMcp, MCP_ENTRY, Registry, slug } from "../src/daemon/registry.ts";
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

test("installMcp adds padd, keeps other servers, and keeps the personal settings out of git", async (t) => {
  const { root } = await repo("tofu");
  // A clean git, without the user's global config or excludes (~/.config/git/ignore).
  for (const [key, value] of Object.entries({ GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", XDG_CONFIG_HOME: root })) {
    const saved = process.env[key];
    process.env[key] = value;
    t.after(() => (saved === undefined ? delete process.env[key] : (process.env[key] = saved)));
  }
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
  git("init", "-q");
  await writeFile(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }));
  assert.deepEqual(await installMcp(root), [".mcp.json", ".claude/settings.local.json"]);
  assert.deepEqual(await installMcp(root), []); // second run changes nothing
  const mcp = JSON.parse(await readFile(join(root, ".mcp.json"), "utf8"));
  assert.deepEqual(mcp.mcpServers, { other: { command: "x" }, padd: MCP_ENTRY });
  assert.equal(git("status", "--porcelain", "--untracked-files=all").includes("settings.local.json"), false);
  assert.equal((await readFile(join(root, ".git", "info", "exclude"), "utf8")).match(/settings\.local\.json/g)?.length, 1);
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
