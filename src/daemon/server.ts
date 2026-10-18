// The HTTP side of padd serve: the tablet UI, its static files and the board API.

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import type { Point, Stroke } from "../shared/types.ts";
import { COOKIE, presented, same } from "./auth.ts";
import { IMAGE_TYPES, Invalid, NotFound, newId, type Store } from "./store.ts";

export interface Options {
  token: string;
  store: Store;
  /** Folder holding index.html and style.css. */
  uiDir: string;
  /** Folder holding the compiled UI scripts, served under /js/. */
  jsDir: string;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ...IMAGE_TYPES,
};

const MAX_BODY = 4 * 1024 * 1024;

export function createPaddServer(opts: Options): Server {
  return createServer((req, res) => {
    handle(opts, req, res).catch((e: unknown) => {
      if (e instanceof NotFound) return send(res, 404, { error: e.message });
      if (e instanceof Invalid) return send(res, 400, { error: e.message });
      console.error(e);
      send(res, 500, { error: "internal error" });
    });
  });
}

async function handle(opts: Options, req: IncomingMessage, res: ServerResponse): Promise<void> {
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

  const path = url.pathname;
  const { store } = opts;
  let m: RegExpMatchArray | null;

  if (req.method === "GET" && path === "/") return file(res, join(opts.uiDir, "index.html"));
  if (req.method === "GET" && path === "/style.css") return file(res, join(opts.uiDir, "style.css"));
  if (req.method === "GET" && path.startsWith("/js/")) return file(res, inside(opts.jsDir, path.slice(4)));

  if (req.method === "GET" && path === "/api/boards") return send(res, 200, await store.boards());
  if ((m = path.match(/^\/api\/boards\/([^/]+)$/)) && req.method === "GET") {
    return send(res, 200, await store.ink(m[1]!));
  }
  if ((m = path.match(/^\/api\/boards\/([^/]+)\/image$/)) && req.method === "GET") {
    return file(res, await store.imagePath(m[1]!), "private, max-age=31536000, immutable");
  }
  if ((m = path.match(/^\/api\/boards\/([^/]+)\/strokes$/)) && req.method === "POST") {
    const stroke = parseStroke(await body(req));
    await store.addStroke(m[1]!, stroke);
    return send(res, 201, { id: stroke.id });
  }
  if ((m = path.match(/^\/api\/boards\/([^/]+)\/erase$/)) && req.method === "POST") {
    const ids = (await body(req) as { ids?: unknown }).ids;
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) throw new Invalid("ids must be strings");
    await store.erase(m[1]!, ids as string[]);
    return send(res, 200, { erased: ids.length });
  }

  send(res, 404, { error: `no route ${req.method} ${path}` });
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
<p style="max-width:28em;padding:24px">This PADD is locked. Open the link that <code>padd serve</code> printed in its terminal; it carries the access token.</p>`;
