// One subproject's data on disk (<repo>/.padd/data/<sub>/):
//   boards/<id>/board.json   the Board
//   boards/<id>/image.<ext>  the image
//   boards/<id>/ink.jsonl    append-only log of ink operations
//   messages.jsonl           append-only log of the conversation with Claude
//   sends/<id>.png           what each Send showed Claude
//   session.json             the Claude Code session linked to the subproject
// Logs are replayed on read, so a crash loses at most the line being written.

import { createHash, randomBytes } from "node:crypto";
import { appendFile, copyFile, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { Author, Board, BoardInk, Message, Stroke } from "../shared/types.ts";

type InkOp = { op: "add"; stroke: Stroke } | { op: "erase"; ids: string[]; t: number };
type MessageOp = { op: "add"; message: Message } | { op: "delivered"; ids: string[] };

export const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

let lastMs = 0;

/**
 * A sortable, unique id: time first, so a plain sort is chronological. Ids made in the same
 * millisecond borrow the next one, so they still sort in creation order.
 */
export function newId(): string {
  lastMs = Math.max(Date.now(), lastMs + 1);
  return lastMs.toString(36).padStart(9, "0") + randomBytes(3).toString("hex");
}

const ID = /^[0-9a-z]{9,32}$/;

export class Store {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private boardDir(id: string): string {
    if (!ID.test(id)) throw new NotFound(`no board ${id}`);
    return join(this.dir, "boards", id);
  }

  async addBoard(imagePath: string, title: string, author: Author): Promise<Board> {
    const ext = extname(imagePath).toLowerCase();
    if (!IMAGE_TYPES[ext]) throw new Invalid(`unsupported image type ${ext || "(none)"}`);
    let hash: string;
    try {
      hash = await hashFile(imagePath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new Invalid(`no such file ${imagePath}`);
      throw e;
    }
    const board: Board = { id: newId(), title, image: `image${ext}`, author, t: Date.now(), hash, source: imagePath };
    const dir = this.boardDir(board.id);
    await mkdir(dir, { recursive: true });
    await copyFile(imagePath, join(dir, board.image));
    await writeFile(join(dir, "ink.jsonl"), "");
    await writeFile(join(dir, "board.json"), JSON.stringify(board, null, 2));
    return board;
  }

  /** Hashes of every board's image, filling in any that older boards lack. */
  async hashes(): Promise<Set<string>> {
    const out = new Set<string>();
    for (const board of await this.boards()) {
      if (!board.hash) {
        board.hash = await hashFile(join(this.boardDir(board.id), board.image));
        await writeFile(join(this.boardDir(board.id), "board.json"), JSON.stringify(board, null, 2));
      }
      out.add(board.hash);
    }
    return out;
  }

  /** All boards, oldest first. */
  async boards(): Promise<Board[]> {
    let ids: string[];
    try {
      ids = await readdir(join(this.dir, "boards"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    const boards = await Promise.all(ids.filter((id) => ID.test(id)).sort().map((id) => this.board(id)));
    return boards;
  }

  async board(id: string): Promise<Board> {
    try {
      return JSON.parse(await readFile(join(this.boardDir(id), "board.json"), "utf8")) as Board;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new NotFound(`no board ${id}`);
      throw e;
    }
  }

  async imagePath(id: string): Promise<string> {
    const board = await this.board(id);
    return join(this.boardDir(id), board.image);
  }

  /** The board with its strokes as they stand now (adds minus erases). */
  async ink(id: string): Promise<BoardInk> {
    const board = await this.board(id);
    const strokes = new Map<string, Stroke>();
    for (const op of await readLog<InkOp>(join(this.boardDir(id), "ink.jsonl"))) {
      if (op.op === "add") strokes.set(op.stroke.id, op.stroke);
      else for (const sid of op.ids) strokes.delete(sid);
    }
    return { board, strokes: [...strokes.values()] };
  }

  async addStroke(id: string, stroke: Stroke): Promise<void> {
    await this.board(id);
    await this.append(id, { op: "add", stroke });
  }

  async erase(id: string, ids: string[]): Promise<void> {
    await this.board(id);
    await this.append(id, { op: "erase", ids, t: Date.now() });
  }

  private async append(id: string, op: InkOp): Promise<void> {
    await appendFile(join(this.boardDir(id), "ink.jsonl"), JSON.stringify(op) + "\n");
  }

  // ---------- conversation ----------

  /** The conversation, oldest first. */
  async messages(): Promise<Message[]> {
    const messages = new Map<string, Message>();
    for (const op of await readLog<MessageOp>(join(this.dir, "messages.jsonl"))) {
      if (op.op === "add") messages.set(op.message.id, op.message);
      else for (const id of op.ids) {
        const m = messages.get(id);
        if (m) m.delivered = true;
      }
    }
    return [...messages.values()];
  }

  async addMessage(m: Omit<Message, "id" | "t">): Promise<Message> {
    const message: Message = { id: newId(), t: Date.now(), ...m };
    await this.appendMessage({ op: "add", message });
    return message;
  }

  async markDelivered(ids: string[]): Promise<void> {
    if (ids.length > 0) await this.appendMessage({ op: "delivered", ids });
  }

  private async appendMessage(op: MessageOp): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await appendFile(join(this.dir, "messages.jsonl"), JSON.stringify(op) + "\n");
  }

  /** Saves what a Send showed Claude; returns the file's absolute path. */
  async saveSnapshot(png: Buffer): Promise<string> {
    const dir = join(this.dir, "sends");
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${newId()}.png`);
    await writeFile(path, png);
    return path;
  }

  // ---------- linked session ----------

  async session(): Promise<string | undefined> {
    try {
      return (JSON.parse(await readFile(join(this.dir, "session.json"), "utf8")) as { id?: string }).id;
    } catch {
      return undefined;
    }
  }

  async setSession(id: string): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const path = join(this.dir, "session.json");
    await writeFile(`${path}.tmp`, JSON.stringify({ id, linked: Date.now() }) + "\n");
    await rename(`${path}.tmp`, path);
  }
}

export async function hashFile(path: string): Promise<string> {
  return createHash("sha1").update(await readFile(path)).digest("hex");
}

async function readLog<T>(path: string): Promise<T[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const out: T[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // a torn last line from a crash
    }
  }
  return out;
}

export class NotFound extends Error {}
export class Invalid extends Error {}
