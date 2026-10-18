// Projects are repos with a .padd/ folder. The registry (~/.config/padd/projects.json) lists them;
// each repo's .padd/config.json (committed) names the project and its subprojects, and
// .padd/data/ (gitignored) holds the boards.

import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { ProjectConfig, ProjectInfo, Subproject } from "../shared/types.ts";
import { Store, Invalid, NotFound } from "./store.ts";

export const PADD_DIR = ".padd";
const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;

interface Entry {
  id: string;
  path: string;
}

/** Turns a name into an id: lowercase letters, digits and dashes. */
export function slug(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "") // accents left over from é → e
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export class Registry {
  readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  private async entries(): Promise<Entry[]> {
    try {
      return JSON.parse(await readFile(this.file, "utf8")) as Entry[];
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
  }

  /** Adds a repo (idempotent) and returns its project id. */
  async register(repo: string): Promise<string> {
    const path = resolve(repo);
    const entries = await this.entries();
    const known = entries.find((e) => e.path === path);
    if (known) return known.id;
    const config = await readConfig(path);
    const base = slug(config.name) || "project";
    let id = base;
    for (let n = 2; entries.some((e) => e.id === id); n++) id = `${base}-${n}`;
    entries.push({ id, path });
    await writeJson(this.file, entries);
    return id;
  }

  /** Every registered project that still has its config, in registration order. */
  async projects(): Promise<ProjectInfo[]> {
    const out: ProjectInfo[] = [];
    for (const { id, path } of await this.entries()) {
      try {
        out.push({ id, path, ...(await readConfig(path)) });
      } catch {
        // A repo that moved or lost .padd/ is skipped, not fatal.
      }
    }
    return out;
  }

  async project(id: string): Promise<Project> {
    const entry = (await this.entries()).find((e) => e.id === id);
    if (!entry) throw new NotFound(`no project ${id}`);
    return new Project(id, entry.path);
  }
}

export class Project {
  readonly id: string;
  readonly path: string;

  constructor(id: string, path: string) {
    this.id = id;
    this.path = path;
  }

  config(): Promise<ProjectConfig> {
    return readConfig(this.path);
  }

  async subproject(id: string): Promise<Subproject> {
    const sub = (await this.config()).subprojects.find((s) => s.id === id);
    if (!sub) throw new NotFound(`no subproject ${id} in ${this.id}`);
    return sub;
  }

  /** The boards of a subproject. */
  async store(sub: string): Promise<Store> {
    await this.subproject(sub);
    return new Store(join(this.path, PADD_DIR, "data", sub));
  }

  async addSubproject(title: string, brief: string): Promise<Subproject> {
    const clean = title.trim();
    const id = slug(clean);
    if (!SLUG.test(id)) throw new Invalid("a subproject needs a name with letters or digits");
    if (clean.length > 60) throw new Invalid("keep the name under 60 characters");
    if (brief.length > 4000) throw new Invalid("keep the brief under 4000 characters");
    const config = await this.config();
    if (config.subprojects.some((s) => s.id === id)) throw new Invalid(`${id} already exists`);
    const sub: Subproject = { id, title: clean, brief: brief.trim() };
    config.subprojects.push(sub);
    await writeJson(configPath(this.path), config);
    return sub;
  }

  /** Sets the repo folders whose images become boards of a subproject on their own. */
  async setWatch(sub: string, dirs: string[]): Promise<Subproject> {
    const config = await this.config();
    const found = config.subprojects.find((s) => s.id === sub);
    if (!found) throw new NotFound(`no subproject ${sub} in ${this.id}`);
    const rel = dirs.map((d) => relative(this.path, resolve(this.path, d)) || ".");
    if (rel.some((d) => d.startsWith(".."))) throw new Invalid("watched folders must be inside the repo");
    if (rel.length > 0) found.watch = [...new Set(rel)];
    else delete found.watch;
    await writeJson(configPath(this.path), config);
    return found;
  }
}

function configPath(repo: string): string {
  return join(repo, PADD_DIR, "config.json");
}

export async function readConfig(repo: string): Promise<ProjectConfig> {
  const raw = JSON.parse(await readFile(configPath(repo), "utf8")) as Partial<ProjectConfig>;
  return {
    name: typeof raw.name === "string" && raw.name ? raw.name : basename(repo),
    subprojects: Array.isArray(raw.subprojects)
      ? raw.subprojects
          .filter((s) => s && SLUG.test(s.id))
          .map((s) => ({ ...s, title: s.title || s.id, brief: s.brief ?? "", watch: Array.isArray(s.watch) ? s.watch.filter((w) => typeof w === "string") : undefined }))
      : [],
  };
}

/** The server entry Claude Code needs in a repo's .mcp.json to start padd mcp. */
export const MCP_ENTRY = { command: "padd", args: ["mcp"] };

/**
 * Adds padd to the repo's .mcp.json (committed: every session in the repo gets the tools) and
 * pre-approves it in .claude/settings.local.json (personal, so Claude Code doesn't ask).
 * Other servers and settings are kept. Returns the files it changed.
 */
export async function installMcp(repo: string): Promise<string[]> {
  const changed: string[] = [];
  const mcpPath = join(repo, ".mcp.json");
  const mcp = await readJson<{ mcpServers?: Record<string, unknown> }>(mcpPath, {});
  if (JSON.stringify(mcp.mcpServers?.padd) !== JSON.stringify(MCP_ENTRY)) {
    mcp.mcpServers = { ...mcp.mcpServers, padd: MCP_ENTRY };
    await writeJson(mcpPath, mcp);
    changed.push(".mcp.json");
  }
  const settingsPath = join(repo, ".claude", "settings.local.json");
  const settings = await readJson<{ enabledMcpjsonServers?: string[] }>(settingsPath, {});
  if (!settings.enabledMcpjsonServers?.includes("padd")) {
    settings.enabledMcpjsonServers = [...(settings.enabledMcpjsonServers ?? []), "padd"];
    await writeJson(settingsPath, settings);
    changed.push(".claude/settings.local.json");
  }
  return changed;
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw new Invalid(`${path} isn't valid JSON; fix it by hand first`);
  }
}

/** Creates .padd/ in a repo if missing. Returns whether anything was created. */
export async function initRepo(repo: string, name?: string): Promise<boolean> {
  const dir = join(repo, PADD_DIR);
  let created = false;
  try {
    await stat(configPath(repo));
  } catch {
    const config: ProjectConfig = { name: name ?? basename(resolve(repo)), subprojects: [] };
    await writeJson(configPath(repo), config);
    created = true;
  }
  try {
    await stat(join(dir, ".gitignore"));
  } catch {
    await writeFile(join(dir, ".gitignore"), "# Boards, ink and snapshots are local; only config.json is shared.\ndata/\n");
    created = true;
  }
  return created;
}

/** The nearest folder at or above `from` that has .padd/config.json. */
export async function findRepo(from: string): Promise<string> {
  let dir = resolve(from);
  for (;;) {
    try {
      await stat(configPath(dir));
      return dir;
    } catch {
      const up = dirname(dir);
      if (up === dir) throw new NotFound("not inside a padd project; run padd init in the repo first");
      dir = up;
    }
  }
}

/** Writes JSON atomically, so a reader never sees half a file. */
async function writeJson(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n");
  await rename(tmp, path);
}
