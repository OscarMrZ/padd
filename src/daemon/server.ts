// The HTTP side of padd serve: the tablet UI, its static files, the project API and live events.

import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, extname, isAbsolute, join, normalize, sep } from "node:path";
import type { Author, Board, Note, Place, Point, ProjectSummary, SessionState, Stroke } from "../shared/types.ts";
import { Agents } from "./agents.ts";
import { Launcher, type LauncherOptions } from "./launcher.ts";
import { COOKIE, presented, same } from "./auth.ts";
import { Events } from "./events.ts";
import { findRepo, PADD_DIR, slug, type Project, type Registry } from "./registry.ts";
import { hashFile, IMAGE_TYPES, Invalid, NotFound, newId, type Store } from "./store.ts";
import { region, shapesToStrokes } from "./shapes.ts";
import { thumbnail } from "./thumbs.ts";

export interface Options {
  token: string;
  registry: Registry;
  /** Folder holding index.html and style.css. */
  uiDir: string;
  /** Folder holding the compiled UI scripts, served under /js/. */
  jsDir: string;
  /** How to start sessions from the tablet; without it, the tablet can't start them. */
  launch?: Omit<LauncherOptions, "onTrust" | "onChange">;
}

export interface PaddServer {
  server: Server;
  events: Events;
  agents: Agents;
}

interface Ctx {
  opts: Options;
  events: Events;
  agents: Agents;
  launcher?: Launcher;
  /** The board each subproject's tablet shows right now: Claude's tools default to it. */
  viewing: Map<string, string>;
}

const placeKey = (p: Place) => `${p.project}/${p.sub}`;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ...IMAGE_TYPES,
};

const MAX_BODY = 4 * 1024 * 1024;
const MAX_SEND = 40 * 1024 * 1024; // a Send carries a full-size PNG snapshot
const MAX_MESSAGE = 4000;
const IMMUTABLE = "private, max-age=31536000, immutable";

export class Forbidden extends Error {}
export class Conflict extends Error {}

export function createPaddServer(opts: Options): PaddServer {
  const events = new Events();
  const agents = new Agents(events);
  const ctx: Ctx = { opts, events, agents, viewing: new Map() };
  if (opts.launch) {
    ctx.launcher = new Launcher({
      ...opts.launch,
      onTrust: (place) => void announce(ctx, place, { needsTrust: true }),
      onChange: (place) => void announce(ctx, place),
    });
  }
  const server = createServer((req, res) => {
    handle(ctx, req, res).catch((e: unknown) => {
      if (res.headersSent) return void res.end();
      if (e instanceof NotFound) return send(res, 404, { error: e.message });
      if (e instanceof Invalid) return send(res, 400, { error: e.message });
      if (e instanceof Forbidden) return send(res, 403, { error: e.message });
      if (e instanceof Conflict) return send(res, 409, { error: e.message });
      console.error(e);
      send(res, 500, { error: "internal error" });
    });
  });
  server.on("close", () => {
    agents.closeAll();
    events.close();
  });
  return { server, events, agents };
}

async function handle(ctx: Ctx, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { opts, events } = ctx;
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
  if (method === "GET" && path === "/api/projects") return send(res, 200, await summaries(ctx));
  if (method === "POST" && path === "/api/debug") {
    // The tablet's input readout (?debug), written to padd's log for diagnosing a device.
    const { lines, agent } = (await body(req)) as { lines?: unknown; agent?: unknown };
    if (!Array.isArray(lines)) throw new Invalid("lines must be a list");
    console.log(`tablet input log (${String(agent).slice(0, 200)}):`);
    for (const line of lines.slice(-400)) console.log(`  ${String(line).slice(0, 300)}`);
    return send(res, 200, { logged: Math.min(lines.length, 400) });
  }
  if (path.startsWith("/api/agent/")) return agentRoute(ctx, req, res, url);

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

  // /api/p/<project>/<sub>/messages|session|send
  const [sub, boards, boardId, part, ...extra] = rest;
  if (sub && rest.length === 2) {
    const store = await project.store(sub);
    const place = { project: project.id, sub };
    if (method === "GET" && boards === "messages") return send(res, 200, await store.messages());
    if (method === "GET" && boards === "session") return send(res, 200, await sessionState(ctx, place));
    if (method === "POST" && boards === "send") return sendToClaude(ctx, req, res, place, store);
    if (method === "POST" && boards === "viewing") {
      const { board } = (await body(req)) as { board?: unknown };
      if (typeof board === "string") ctx.viewing.set(placeKey(place), (await store.board(board)).id);
      return send(res, 200, { viewing: board });
    }
  }
  // /api/p/<project>/<sub>/session/start|window: run the session in a window on the computer.
  if (sub && rest.length === 3 && boards === "session" && method === "POST") {
    await project.store(sub);
    const place = { project: project.id, sub };
    const launcher = ctx.launcher;
    if (!launcher) throw new Conflict("this PADD can't start sessions");
    const state = await sessionState(ctx, place);
    if (boardId === "start") {
      if (state.live && !state.running) {
        throw new Conflict("Claude is already connected from a terminal you started; continue there");
      }
      const result = await launcher.start(place, project.path);
      await announce(ctx, place);
      return send(res, 200, { result });
    }
    if (boardId === "window") {
      if (!state.running) throw new Conflict("this session isn't running in a PADD window");
      return send(res, 200, { result: (await launcher.show(place)) ? "opened" : "already open" });
    }
  }

  // /api/p/<project>/<sub>/boards[/<board>[/<part>]]
  if (!sub || boards !== "boards" || extra.length > 0) return send(res, 404, { error: `no route ${method} ${path}` });
  const store = await project.store(sub);
  const place = { project: project.id, sub };

  if (!boardId) {
    if (method === "GET") return send(res, 200, await store.boards());
    if (method === "POST") {
      const b = (await body(req, MAX_SEND)) as { path?: unknown; title?: unknown; author?: unknown; image?: unknown };
      // An image uploaded from the tablet: a photo or a picture from its gallery.
      if (b.image !== undefined) {
        const { bytes, ext } = decodeImage(b.image);
        const title = typeof b.title === "string" && b.title.trim() ? b.title.trim().slice(0, 80) : "Photo";
        const board = await store.addBoardBytes(bytes, ext, title, "me");
        events.emit({ type: "board", ...place, board });
        return send(res, 201, board);
      }
      // Adding by path reads a file on this machine: only for local callers (CLI, Claude's MCP server).
      if (!isLoopback(req)) throw new Forbidden("boards can be added by path only from this computer");
      const { path: image, title, author } = b;
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
  } else if (part === "notes" && method === "POST") {
    const { x, y, text } = (await body(req)) as { x?: unknown; y?: unknown; text?: unknown };
    if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Invalid("x and y must be numbers");
    }
    const note: Note = { id: newId(), author: "me", x, y, text: noteText(text), t: Date.now() };
    await store.addNote(boardId, note);
    events.emit({ type: "note", ...place, board: boardId, note, origin: origin(req) });
    return send(res, 201, note);
  } else if (part === "erase" && method === "POST") {
    const ids = ((await body(req)) as { ids?: unknown }).ids;
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) throw new Invalid("ids must be strings");
    await store.erase(boardId, ids as string[]);
    events.emit({ type: "erase", ...place, board: boardId, ids: ids as string[], origin: origin(req) });
    return send(res, 200, { erased: ids.length });
  }

  send(res, 404, { error: `no route ${method} ${path}` });
}

async function summaries(ctx: Ctx): Promise<ProjectSummary[]> {
  return Promise.all(
    (await ctx.opts.registry.projects()).map(async (p) => {
      const boards: Record<string, number> = {};
      const live: Record<string, boolean> = {};
      for (const s of p.subprojects) {
        boards[s.id] = await countBoards(join(p.path, PADD_DIR, "data", s.id));
        live[s.id] = ctx.agents.liveFor({ project: p.id, sub: s.id }) !== undefined;
      }
      return { ...p, boards, live };
    }),
  );
}

async function sessionState(ctx: Ctx, place: Place): Promise<SessionState> {
  const store = await (await ctx.opts.registry.project(place.project)).store(place.sub);
  return {
    live: ctx.agents.liveFor(place) !== undefined,
    session: await store.session(),
    running: ctx.launcher ? await ctx.launcher.running(place) : false,
  };
}

/** Tells the tablets a session's state changed. */
async function announce(ctx: Ctx, place: Place, extra: Partial<SessionState> = {}): Promise<void> {
  try {
    ctx.events.emit({ type: "session", ...place, state: { ...(await sessionState(ctx, place)), ...extra } });
  } catch {
    // the subproject went away meanwhile
  }
}

/** The tablet's Send: save what Claude will see, log it, and hand it to the linked session. */
async function sendToClaude(ctx: Ctx, req: IncomingMessage, res: ServerResponse, place: Place, store: Store): Promise<void> {
  const { board, text, snapshot, answering } = (await body(req, MAX_SEND)) as {
    board?: unknown;
    text?: unknown;
    snapshot?: unknown;
    answering?: unknown;
  };
  const message = typeof text === "string" ? text.trim().slice(0, MAX_MESSAGE) : "";
  const prefix = "data:image/png;base64,";
  if (typeof snapshot !== "string" || !snapshot.startsWith(prefix)) throw new Invalid("snapshot must be a PNG data URL");
  const png = Buffer.from(snapshot.slice(prefix.length), "base64");
  if (png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Invalid("snapshot is not a PNG");
  let boardId: string | undefined;
  if (typeof board === "string") boardId = (await store.board(board)).id;
  let question: string | undefined;
  if (typeof answering === "string") {
    const q = (await store.messages()).find((m) => m.id === answering && m.question);
    if (!q) throw new NotFound(`no question ${answering}`);
    question = q.id;
  }
  const saved = await store.addMessage({
    author: "me",
    text: message,
    board: boardId,
    snapshot: await store.saveSnapshot(png),
    delivered: false,
    ...(question ? { answering: question } : {}),
  });
  ctx.events.emit({ type: "message", ...place, message: saved });
  const delivered = await ctx.agents.deliver(place, saved, store);
  send(res, 201, { message: { ...saved, delivered }, delivered });
}

// ---------- the agent side: padd mcp, running inside a Claude Code session ----------

const SESSION = /^[0-9a-zA-Z-]{8,64}$/;

async function agentRoute(ctx: Ctx, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  // Agents read and write files on this machine by path: never from the network.
  if (!isLoopback(req)) throw new Forbidden("only Claude sessions on this computer use /api/agent");
  const { registry } = ctx.opts;
  const method = req.method ?? "GET";
  const route = url.pathname.slice("/api/agent/".length);

  if (method === "GET" && route === "stream") {
    const session = url.searchParams.get("session") ?? "";
    if (!SESSION.test(session)) throw new Invalid("session must be a Claude Code session id");
    const project = await projectAt(registry, url.searchParams.get("repo"));
    ctx.agents.attach(session, res, project?.id);
    let place: Place | undefined;
    if (project) {
      const wanted = url.searchParams.get("sub");
      const sub = wanted ? await findSub(project, wanted) : await linkedSub(project, session);
      if (sub) {
        place = { project: project.id, sub };
        await ctx.agents.link(session, place, await project.store(sub));
      }
    }
    return ctx.agents.say(session, { type: "hello", project: project?.id, place });
  }

  if (method === "GET" && route === "status") {
    const session = url.searchParams.get("session") ?? "";
    return send(res, 200, await status(ctx, session));
  }

  if (method !== "POST") return send(res, 404, { error: `no route ${method} ${url.pathname}` });
  const b = (await body(req)) as Record<string, unknown>;
  const session = typeof b.session === "string" ? b.session : "";
  if (!ctx.agents.has(session)) throw new Conflict("this session isn't connected to padd");

  if (route === "link") {
    const projectId = ctx.agents.projectOf(session);
    if (!projectId) throw new Conflict("this session's folder isn't a padd project; run padd init there");
    const project = await registry.project(projectId);
    if (typeof b.subproject !== "string" || !b.subproject.trim()) throw new Invalid("subproject must be a name");
    let sub = await findSub(project, b.subproject);
    if (!sub) {
      const created = await project.addSubproject(b.subproject, typeof b.brief === "string" ? b.brief : "");
      ctx.events.emit({ type: "subproject", project: project.id, subproject: created });
      sub = created.id;
    }
    const place = { project: project.id, sub };
    await ctx.agents.link(session, place, await project.store(sub));
    return send(res, 200, { place });
  }

  const place = ctx.agents.placeOf(session);
  if (!place) throw new Conflict("link this session to a subproject first (the link tool)");
  const store = await (await registry.project(place.project)).store(place.sub);

  if (route === "reply") {
    if (typeof b.text !== "string" || !b.text.trim()) throw new Invalid("text must not be empty");
    const board = typeof b.board === "string" ? (await store.board(b.board)).id : undefined;
    const message = await store.addMessage({ author: "claude", text: b.text.trim().slice(0, MAX_MESSAGE), board });
    ctx.events.emit({ type: "message", ...place, message });
    return send(res, 201, message);
  }

  if (route === "draw" || route === "note" || route === "ask") {
    const boardId = await pickBoard(ctx, place, store, b.board);
    if (route === "draw") {
      const { w, h } = await store.size(boardId);
      const strokes = shapesToStrokes(b.shapes, w, h);
      for (const stroke of strokes) {
        await store.addStroke(boardId, stroke);
        ctx.events.emit({ type: "stroke", ...place, board: boardId, stroke });
      }
      ctx.events.emit({ type: "focus", ...place, board: boardId });
      return send(res, 201, { board: boardId, strokes: strokes.map((x) => x.id) });
    }
    if (route === "note") {
      const [x, y] = [b.x, b.y];
      if (typeof x !== "number" || typeof y !== "number" || x < -0.1 || x > 1.1 || y < -0.1 || y > 1.1) {
        throw new Invalid("x and y must be fractions of the image (0 to 1)");
      }
      const { w, h } = await store.size(boardId);
      const note: Note = { id: newId(), author: "claude", x: x * w, y: y * h, text: noteText(b.text), t: Date.now() };
      await store.addNote(boardId, note);
      ctx.events.emit({ type: "note", ...place, board: boardId, note });
      ctx.events.emit({ type: "focus", ...place, board: boardId });
      return send(res, 201, { board: boardId, note: note.id });
    }
    if (typeof b.question !== "string" || !b.question.trim()) throw new Invalid("question must not be empty");
    const message = await store.addMessage({
      author: "claude",
      text: b.question.trim().slice(0, MAX_MESSAGE),
      board: boardId,
      question: true,
      ...(b.region === undefined ? {} : { region: region(b.region) }),
    });
    ctx.events.emit({ type: "message", ...place, message });
    ctx.events.emit({ type: "focus", ...place, board: boardId });
    return send(res, 201, { board: boardId, question: message.id });
  }

  if (route === "show") {
    const paths = b.paths;
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > 50) throw new Invalid("paths must list 1 to 50 images");
    const shown: Board[] = [];
    const byHash = new Map((await store.boards()).map((x) => [x.hash, x]));
    for (const p of paths) {
      if (typeof p !== "string" || !isAbsolute(p)) throw new Invalid("each path must be an absolute file path");
      // An image already on the tablet is brought forward instead of copied again.
      let board = byHash.get(await hashOrThrow(p));
      if (!board) {
        const title = paths.length === 1 && typeof b.title === "string" && b.title.trim() ? b.title.trim().slice(0, 80) : basename(p, extname(p));
        board = await store.addBoard(p, title, "claude");
        byHash.set(board.hash, board);
        ctx.events.emit({ type: "board", ...place, board });
      }
      shown.push(board);
    }
    ctx.events.emit({ type: "focus", ...place, board: shown[0]!.id });
    return send(res, 200, shown);
  }

  send(res, 404, { error: `no route ${method} ${url.pathname}` });
}

/** Reads an image data URL, checking the bytes really are the image type it claims. */
export function decodeImage(raw: unknown): { bytes: Buffer; ext: string } {
  const m = typeof raw === "string" ? raw.match(/^data:image\/(png|jpeg|webp);base64,/) : null;
  if (!m) throw new Invalid("image must be a PNG, JPEG or WebP data URL");
  const bytes = Buffer.from((raw as string).slice(m[0].length), "base64");
  const magic: Record<string, (b: Buffer) => boolean> = {
    png: (b) => b.subarray(0, 8).toString("hex") === "89504e470d0a1a0a",
    jpeg: (b) => b.subarray(0, 3).toString("hex") === "ffd8ff",
    webp: (b) => b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP",
  };
  if (!magic[m[1]!]!(bytes)) throw new Invalid(`that isn't a ${m[1]} image`);
  return { bytes, ext: m[1] === "jpeg" ? ".jpg" : `.${m[1]}` };
}

/** The board Claude means: the one given, else the one the tablet shows, else the newest. */
async function pickBoard(ctx: Ctx, place: Place, store: Store, given: unknown): Promise<string> {
  if (typeof given === "string" && given) return (await store.board(given)).id;
  const viewing = ctx.viewing.get(placeKey(place));
  if (viewing) {
    try {
      return (await store.board(viewing)).id;
    } catch {
      // that board is gone
    }
  }
  const latest = (await store.boards()).at(-1);
  if (!latest) throw new Conflict("there are no images in this subproject yet; show one first");
  return latest.id;
}

function noteText(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) throw new Invalid("text must not be empty");
  return raw.trim().slice(0, 500);
}

async function hashOrThrow(path: string): Promise<string> {
  try {
    return await hashFile(path);
  } catch {
    throw new Invalid(`can't read ${path}`);
  }
}

async function projectAt(registry: Registry, dir: string | null): Promise<Project | undefined> {
  if (!dir || !isAbsolute(dir)) return undefined;
  try {
    return await registry.project(await registry.register(await findRepo(dir)));
  } catch {
    return undefined; // not a padd project
  }
}

/** A subproject by id or by name. */
async function findSub(project: Project, name: string): Promise<string | undefined> {
  const subs = (await project.config()).subprojects;
  return subs.find((s) => s.id === name || s.id === slug(name))?.id;
}

/** The subproject this session was linked to before, if any. */
async function linkedSub(project: Project, session: string): Promise<string | undefined> {
  for (const s of (await project.config()).subprojects) {
    if ((await (await project.store(s.id)).session()) === session) return s.id;
  }
  return undefined;
}

async function status(ctx: Ctx, session: string): Promise<unknown> {
  const projectId = ctx.agents.projectOf(session);
  if (!projectId) return { connected: ctx.agents.has(session), project: null };
  const project = await ctx.opts.registry.project(projectId);
  const config = await project.config();
  const place = ctx.agents.placeOf(session);
  const out: Record<string, unknown> = {
    connected: true,
    project: project.id,
    subprojects: config.subprojects.map((s) => ({ id: s.id, title: s.title, brief: s.brief, watch: s.watch ?? [] })),
    linked: place?.sub ?? null,
    tablets: ctx.events.size(),
  };
  if (place) {
    const store = await project.store(place.sub);
    const boards = await store.boards();
    out.boards = boards.length;
    out.viewing = ctx.viewing.get(placeKey(place)) ?? null;
    out.latest = await Promise.all(
      boards.slice(-10).reverse().map(async (x) => ({ id: x.id, title: x.title, author: x.author, image: await store.imagePath(x.id) })),
    );
  }
  return out;
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

async function body(req: IncomingMessage, max = MAX_BODY): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > max) throw new Invalid("body too large");
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
