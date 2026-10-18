// Boards on disk, one folder per board:
//   <dir>/boards/<id>/board.json   the Board
//   <dir>/boards/<id>/image.<ext>  the image
//   <dir>/boards/<id>/ink.jsonl    append-only log of ink operations
// The log is replayed on read, so a crash loses at most the line being written.

import { randomBytes } from "node:crypto";
import { appendFile, copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { Author, Board, BoardInk, Stroke } from "../shared/types.ts";

type InkOp = { op: "add"; stroke: Stroke } | { op: "erase"; ids: string[]; t: number };

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
    const board: Board = { id: newId(), title, image: `image${ext}`, author, t: Date.now() };
    const dir = this.boardDir(board.id);
    await mkdir(dir, { recursive: true });
    await copyFile(imagePath, join(dir, board.image));
    await writeFile(join(dir, "ink.jsonl"), "");
    await writeFile(join(dir, "board.json"), JSON.stringify(board, null, 2));
    return board;
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
    const log = await readFile(join(this.boardDir(id), "ink.jsonl"), "utf8");
    const strokes = new Map<string, Stroke>();
    for (const line of log.split("\n")) {
      if (!line) continue;
      let op: InkOp;
      try {
        op = JSON.parse(line) as InkOp;
      } catch {
        continue; // a torn last line from a crash
      }
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
}

export class NotFound extends Error {}
export class Invalid extends Error {}
