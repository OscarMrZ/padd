// Watched folders: a subproject can list repo folders (e.g. tofu's mood/renders) whose new or
// changed images become boards on their own. A re-render with new pixels is a new board, so its
// old ink stays with the old picture; a file that comes back unchanged is skipped by its hash.

import { watch, type FSWatcher } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import type { Place } from "../shared/types.ts";
import type { Events } from "./events.ts";
import { PADD_DIR, type Registry } from "./registry.ts";
import { hashFile, IMAGE_TYPES, type Store } from "./store.ts";

const QUIET_MS = 700; // wait this long after the last change before reading a file
const SETTLE_MS = 300; // a file whose size still moves is still being written
const MAX_TRIES = 40; // ~40 s of "still being written" and we give up on the file

export class Watcher {
  private readonly registry: Registry;
  private readonly events: Events;
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly queues = new Map<string, Promise<void>>();
  private resync: NodeJS.Timeout | undefined;

  constructor(registry: Registry, events: Events) {
    this.registry = registry;
    this.events = events;
  }

  /** Matches the watches to every project's config: starts new ones, stops removed ones. */
  async sync(): Promise<void> {
    const wanted = new Map<string, () => void>();
    // A new project (padd init) or a config edit (a watch folder, a subproject) re-syncs.
    const registryDir = dirname(this.registry.file);
    wanted.set("registry", () => this.open("registry", registryDir, (f) => {
      if (f === basename(this.registry.file)) this.later();
    }));
    for (const p of await this.registry.projects()) {
      wanted.set(`config:${p.id}`, () => this.open(`config:${p.id}`, join(p.path, PADD_DIR), (f) => {
        if (f === "config.json") this.later();
      }));
      for (const sub of p.subprojects) {
        for (const rel of sub.watch ?? []) {
          const dir = resolve(p.path, rel);
          if (dir !== p.path && !dir.startsWith(p.path + sep)) {
            console.warn(`padd: ${p.id}/${sub.id} watches ${rel}, which is outside the repo; skipped`);
            continue;
          }
          const place = { project: p.id, sub: sub.id };
          const id = `${p.id}/${sub.id}:${dir}`;
          wanted.set(id, () => {
            if (this.open(id, dir, (f) => this.changed(place, join(dir, f)))) void this.scan(place, dir);
          });
        }
      }
    }
    for (const [id, w] of this.watchers) {
      if (!wanted.has(id)) {
        w.close();
        this.watchers.delete(id);
      }
    }
    for (const [id, start] of wanted) if (!this.watchers.has(id)) start();
  }

  /** Re-syncs once a burst of config writes is over. */
  private later(): void {
    clearTimeout(this.resync);
    this.resync = setTimeout(() => void this.sync().catch((e: unknown) => console.warn(`padd: watch: ${(e as Error).message}`)), 200);
  }

  close(): void {
    clearTimeout(this.resync);
    for (const w of this.watchers.values()) w.close();
    for (const t of this.timers.values()) clearTimeout(t);
    this.watchers.clear();
  }

  /** Starts one fs watch. False if the folder isn't there (yet). */
  private open(id: string, dir: string, onFile: (file: string) => void): boolean {
    try {
      const w = watch(dir, (_kind, file) => {
        if (file) onFile(file.toString());
      });
      w.on("error", () => {
        w.close();
        this.watchers.delete(id);
      });
      this.watchers.set(id, w);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`padd: can't watch ${dir}: ${(e as Error).message}`);
      return false;
    }
  }

  /** Picks up images already in a folder when its watch starts. */
  private async scan(place: Place, dir: string): Promise<void> {
    for (const f of (await readdir(dir)).sort()) this.changed(place, join(dir, f));
  }

  private changed(place: Place, file: string, tries = 0): void {
    if (!IMAGE_TYPES[extname(file).toLowerCase()] || basename(file).startsWith(".")) return;
    if (tries > MAX_TRIES) return console.warn(`padd: ${file} never finished writing; skipped`);
    clearTimeout(this.timers.get(file));
    this.timers.set(
      file,
      setTimeout(() => {
        this.timers.delete(file);
        // One file at a time per subproject, so two copies of one image can't both get in.
        const key = `${place.project}/${place.sub}`;
        const next = (this.queues.get(key) ?? Promise.resolve()).then(() => this.consider(place, file, tries));
        this.queues.set(key, next.catch((e: unknown) => console.warn(`padd: ${file}: ${(e as Error).message}`)));
      }, QUIET_MS),
    );
  }

  private async consider(place: Place, file: string, tries: number): Promise<void> {
    const state = await settle(file);
    if (state === "gone") return;
    if (state === "busy") return this.changed(place, file, tries + 1); // still being written: look again later
    let store: Store;
    try {
      store = await (await this.registry.project(place.project)).store(place.sub);
    } catch {
      return; // the subproject went away
    }
    if ((await store.hashes()).has(await hashFile(file))) return;
    const board = await store.addBoard(file, basename(file, extname(file)), "me");
    this.events.emit({ type: "board", ...place, board });
  }
}

/** "ready" once a file's size and time stop changing; "gone" if it was deleted or renamed away. */
async function settle(file: string): Promise<"ready" | "busy" | "gone"> {
  try {
    const a = await stat(file);
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    const b = await stat(file);
    return a.size > 0 && a.size === b.size && a.mtimeMs === b.mtimeMs ? "ready" : "busy";
  } catch {
    return "gone";
  }
}
