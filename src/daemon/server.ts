// The HTTP side of padd serve: the tablet UI, its static files, the project API and live events.

import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, extname, isAbsolute, join, normalize, sep } from "node:path";
import type { Author, Point, ProjectSummary, Stroke } from "../shared/types.ts";
import { COOKIE, presented, same } from "./auth.ts";
import { Events } from "./events.ts";
import { PADD_DIR, type Registry } from "./registry.ts";
import { IMAGE_TYPES, Invalid, NotFound, newId, type Store } from "./store.ts";
import { thumbnail } from "./thumbs.ts";

export interface Options {
  token: string;
  registry: Registry;
  /** Folder holding index.html and style.css. */
  uiDir: string;
  /** Folder holding the compiled UI scripts, served under /js/. */
  jsDir: string;
}

export interface PaddServer {
  server: Server;
  events: Events;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ...IMAGE_TYPES,
};

const MAX_BODY = 4 * 1024 * 1024;
const IMMUTABLE = "private, max-age=31536000, immutable";

export class Forbidden extends Error {}

export function createPaddServer(opts: Options): PaddServer {
  const events = new Events();
  const server = createServer((req, res) => {
    handle(opts, events, req, res).catch((e: unknown) => {
      if (e instanceof NotFound) return send(res, 404, { error: e.message });
      if (e instanceof Invalid) return send(res, 400, { error: e.message });
      if (e instanceof Forbidden) return send(res, 403, { error: e.message });
      console.error(e);
      send(res, 500, { error: "internal error" });
    });
  });
  server.on("close", () => events.close());
  return { server, events };
}

async function handle(opts: Options, events: Events, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://padd");

  // The printed link: trade the query token for a cookie and drop it from the address bar.
  const query = url.searchParams.get("token");
  if (query !== null) {
    if (!same(query, opts.token)) return send(res, 401, { error: "wrong token" });
    url.searchParams.delete("token");
    res.writeHead(303, {
      "Set-Cookie": `${COOKIE}=${encodeURIComponent(query)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
      Location: url.pathname + url.search,
    });
    return void res.end();
  }

  const token = presented(req);
  if (token === undefined || !same(token, opts.token)) {
    if (url.pathname.startsWith("/api/")) return send(res, 401, { error: "missing or wrong token" });
    res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
    return void res.end(LOCKED);
  }

  const method = req.method ?? "GET";
  const path = url.pathname;

  if (method === "GET" && path === "/") return file(res, join(opts.uiDir, "index.html"));
  if (method === "GET" && path === "/style.css") return file(res, join(opts.uiDir, "style.css"));
  if (method === "GET" && path.startsWith("/js/")) return file(res, inside(opts.jsDir, path.slice(4)));
  if (method === "GET" && path === "/api/events") return events.attach(res);
  if (method === "GET" && path === "/api/projects") return send(res, 200, await summaries(opts.registry));

  // /api/p/<project>/... : everything inside one project.
  const seg = path.split("/").slice(1).map(decodeURIComponent);
  if (seg[0] !== "api" || seg[1] !== "p" || !seg[2]) return send(res, 404, { error: `no route ${method} ${path}` });
  const project = await opts.registry.project(seg[2]);
  const rest = seg.slice(3);

  if (method === "POST" && rest.length === 1 && rest[0] === "subprojects") {
    const { title, brief } = (await body(req)) as { title?: unknown; brief?: unknown };
    if (typeof title !== "string") throw new Invalid("title must be a string");
    const subproject = await project.addSubproject(title, typeof brief === "string" ? brief : "");
    events.emit({ type: "subproject", project: project.id, subproject });
    return send(res, 201, subproject);
  }

  // /api/p/<project>/<sub>/boards[/<board>[/<part>]]
  const [sub, boards, boardId, part, ...extra] = rest;
  if (!sub || boards !== "boards" || extra.length > 0) return send(res, 404, { error: `no route ${method} ${path}` });
  const store = await project.store(sub);
  const place = { project: project.id, sub };

  if (!boardId) {
    if (method === "GET") return send(res, 200, await store.boards());
    if (method === "POST") {
      // Adding by path reads a file on this machine: only for local callers (CLI, Claude's MCP server).
      if (!isLoopback(req)) throw new Forbidden("boards can be added by path only from this computer");
      const { path: image, title, author } = (await body(req)) as { path?: unknown; title?: unknown; author?: unknown };
      if (typeof image !== "string" || !isAbsolute(image)) throw new Invalid("path must be an absolute file path");
      const who: Author = author === "claude" ? "claude" : "me";
      const name = typeof title === "string" && title.trim() ? title.trim().slice(0, 80) : basename(image, extname(image));
      const board = await store.addBoard(image, name, who);
      events.emit({ type: "board", ...place, board });
      return send(res, 201, board);
    }
  } else if (!part && method === "GET") {
    return send(res, 200, await store.ink(boardId));
  } else if (part === "image" && method === "GET") {
    return file(res, await store.imagePath(boardId), IMMUTABLE);
  } else if (part === "thumb" && method === "GET") {
    return file(res, await thumbnail(await store.imagePath(boardId)), IMMUTABLE);
  } else if (part === "strokes" && method === "POST") {
    const stroke = parseStroke(await body(req));
    await store.addStroke(boardId, stroke);
    events.emit({ type: "stroke", ...place, board: boardId, stroke, origin: origin(req) });
    return send(res, 201, { id: stroke.id });
  } else if (part === "erase" && method === "POST") {
    const ids = ((await body(req)) as { ids?: unknown }).ids;
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) throw new Invalid("ids must be strings");
    await store.erase(boardId, ids as string[]);
    events.emit({ type: "erase", ...place, board: boardId, ids: ids as string[], origin: origin(req) });
    return send(res, 200, { erased: ids.length });
  }

  send(res, 404, { error: `no route ${method} ${path}` });
}

async function summaries(registry: Registry): Promise<ProjectSummary[]> {
  return Promise.all(
    (await registry.projects()).map(async (p) => {
      const boards: Record<string, number> = {};
      for (const s of p.subprojects) boards[s.id] = await countBoards(join(p.path, PADD_DIR, "data", s.id));
      return { ...p, boards };
    }),
  );
}

async function countBoards(dir: string): Promise<number> {
  try {
    return (await readdir(join(dir, "boards"))).length;
  } catch {
    return 0;
  }
}

/** Validates a stroke from the tablet. The server, not the client, sets id, author and time. */
export function parseStroke(raw: unknown): Stroke {
  const s = raw as Partial<Stroke>;
  if (s === null || typeof s !== "object") throw new Invalid("stroke must be an object");
  if (s.tool !== "pen" && s.tool !== "highlighter") throw new Invalid("tool must be pen or highlighter");
  if (typeof s.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(s.color)) throw new Invalid("color must be #rrggbb");
  if (typeof s.size !== "number" || !(s.size > 0 && s.size <= 500)) throw new Invalid("size must be in (0, 500]");
  if (!Array.isArray(s.points) || s.points.length === 0 || s.points.length > 20000) {
    throw new Invalid("points must hold 1 to 20000 points");
  }
  const points: Point[] = s.points.map((p: unknown) => {
    if (!Array.isArray(p) || p.length !== 3 || !p.every((n) => typeof n === "number" && Number.isFinite(n))) {
      throw new Invalid("each point must be [x, y, pressure]");
    }
    return [p[0], p[1], Math.min(1, Math.max(0, p[2]))];
  });
  return { id: newId(), author: "me", tool: s.tool, color: s.color, size: s.size, points, t: Date.now() };
}

export function isLoopback(req: IncomingMessage): boolean {
  const a = req.socket.remoteAddress ?? "";
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}

/** The tablet view that sent a write, so its own echo can be skipped. */
function origin(req: IncomingMessage): string | undefined {
  const id = req.headers["x-padd-client"];
  return typeof id === "string" && /^[a-z0-9]{1,32}$/.test(id) ? id : undefined;
}

async function body(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Invalid("body too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Invalid("body must be JSON");
  }
}

function send(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}

/** Resolves `rel` under `root`, refusing paths that climb out of it. */
function inside(root: string, rel: string): string {
  const path = normalize(join(root, decodeURIComponent(rel)));
  if (!path.startsWith(normalize(root) + sep)) throw new NotFound("no such file");
  return path;
}

async function file(res: ServerResponse, path: string, cache = "no-cache"): Promise<void> {
  try {
    if (!(await stat(path)).isFile()) throw new NotFound("no such file");
  } catch (e) {
    if (e instanceof NotFound || (e as NodeJS.ErrnoException).code === "ENOENT") throw new NotFound("no such file");
    throw e;
  }
  res.writeHead(200, {
    "Content-Type": TYPES[extname(path).toLowerCase()] ?? "application/octet-stream",
    "Cache-Control": cache,
  });
  createReadStream(path).pipe(res);
}

const LOCKED = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width">
<title>PADD locked</title>
<body style="background:#0e1424;color:#e6e4ef;font:18px/1.5 system-ui;display:grid;place-items:center;height:100vh;margin:0">
<p style="max-width:28em;padding:24px">This PADD is locked. Open the link that <code>padd link</code> prints on the computer; it carries the access token.</p>`;
