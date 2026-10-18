// padd mcp: the MCP server Claude Code starts inside a session (from the repo's .mcp.json).
// It is a channel: a Send from the tablet arrives in the session as a <channel source="padd">
// event. Its tools let Claude put images on the tablet, reply, and link the session to a
// subproject. All state lives in padd serve; this process only relays.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type { Delivery } from "../daemon/agents.ts";
import type { Place } from "../shared/types.ts";

export interface McpOptions {
  token: string;
  port: number;
  /** The Claude Code session this process belongs to. */
  session: string;
  /** The session's project folder. */
  repo: string;
  /** Subproject to link at start (set by padd when it launches a session). */
  sub?: string;
}

const INSTRUCTIONS = `PADD is the user's drawing tablet. They review images there, draw on them with a pen and write notes, then press Send.

A Send arrives as <channel source="padd" ...>. Its body is the user's message (it may be empty: then the marks are the message). Attributes:
- snapshot: a PNG of the image with the user's marks drawn on it. Always Read it: the marks (pen lines, circles, arrows, translucent highlighter, handwriting) are the feedback.
- image: the original image without marks, to compare.
- board_title, subproject, project: what was being reviewed.
Act on the feedback, then answer with the padd reply tool (that's how the user, at the tablet, reads you; your terminal text does not reach them). Keep replies short and concrete.

To put images in front of the user (renders, plots, screenshots, sketches you made), call padd show with absolute paths; the tablet jumps to them. Images in watched folders appear on their own. If padd status says the session isn't linked, ask the user which subproject this work belongs to and call padd link.`;

const TOOLS = [
  {
    name: "show",
    description:
      "Show images on the user's tablet (PADD), in this session's subproject, and bring the first one to the front. Use it for anything you want the user to look at or mark up: renders, plots, screenshots, diagrams. Images already there are brought forward, not duplicated.",
    inputSchema: {
      type: "object",
      properties: {
        paths: { type: "array", items: { type: "string" }, description: "Absolute paths of PNG, JPEG or WebP images" },
        title: { type: "string", description: "Title for the image, when showing just one" },
      },
      required: ["paths"],
    },
  },
  {
    name: "reply",
    description:
      "Answer the user on their tablet. Use it after a Send to say what you understood and what you changed, or to ask a question about an image.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Plain text, a few sentences at most" },
        board: { type: "string", description: "Id of the image the reply is about (the board attribute of the Send)" },
      },
      required: ["text"],
    },
  },
  {
    name: "link",
    description:
      "Link this Claude session to a subproject of the project, so the user's Sends from that subproject come here. Creates the subproject if it doesn't exist.",
    inputSchema: {
      type: "object",
      properties: {
        subproject: { type: "string", description: "Subproject id or name, e.g. mood" },
        brief: { type: "string", description: "For a new subproject: what the work is about" },
      },
      required: ["subproject"],
    },
  },
  {
    name: "status",
    description: "Where this session stands in PADD: project, linked subproject, its latest images, and whether a tablet is open.",
    inputSchema: { type: "object", properties: {} },
  },
];

export async function runMcp(opts: McpOptions): Promise<void> {
  const mcp = new Server(
    { name: "padd", version: "0.1.0" },
    { capabilities: { experimental: { "claude/channel": {} }, tools: {} }, instructions: INSTRUCTIONS },
  );
  const daemon = `http://127.0.0.1:${opts.port}/api/agent`;
  let place: Place | undefined;

  async function call(route: string, body: Record<string, unknown>): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${daemon}/${route}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${opts.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ session: opts.session, ...body }),
      });
    } catch {
      throw new Error("PADD isn't running on this computer. The user can start it with: padd serve");
    }
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new Error(data.error ?? `padd answered ${res.status}`);
    return data;
  }

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    try {
      switch (req.params.name) {
        case "show": {
          const paths = Array.isArray(args.paths) ? args.paths.map((p) => (typeof p === "string" && !isAbsolute(p) ? resolve(opts.repo, p) : p)) : args.paths;
          const shown = (await call("show", { paths, title: args.title })) as { id: string; title: string }[];
          return text(`On the tablet now: ${shown.map((b) => `${b.title} (board ${b.id})`).join(", ")}.`);
        }
        case "reply":
          await call("reply", { text: args.text, board: args.board });
          return text("Sent to the tablet.");
        case "link": {
          const { place: linked } = (await call("link", { subproject: args.subproject, brief: args.brief })) as { place: Place };
          place = linked;
          return text(`Linked to ${linked.project}/${linked.sub}. Sends from there now come to this session.`);
        }
        case "status": {
          const res = await fetch(`${daemon}/status?session=${encodeURIComponent(opts.session)}`, {
            headers: { Authorization: `Bearer ${opts.token}` },
          }).catch(() => null);
          if (!res) throw new Error("PADD isn't running on this computer. The user can start it with: padd serve");
          return text(JSON.stringify(await res.json(), null, 2));
        }
        default:
          throw new Error(`unknown tool ${req.params.name}`);
      }
    } catch (e) {
      return { content: [{ type: "text", text: (e as Error).message }], isError: true };
    }
  });

  await mcp.connect(new StdioServerTransport());

  // Hold the event stream to padd serve open, reconnecting with backoff when it restarts.
  const query = new URLSearchParams({ session: opts.session, repo: opts.repo, ...(opts.sub ? { sub: opts.sub } : {}) });
  let wait = 1000;
  for (;;) {
    try {
      await stream(`${daemon}/stream?${query}`, opts.token, async (event) => {
        wait = 1000;
        if (event.type === "hello") place = (event as { place?: Place }).place ?? place;
        if (event.type === "send") await forward(mcp, event as Delivery);
      });
    } catch {
      // padd serve is down or restarting
    }
    await new Promise((r) => setTimeout(r, wait));
    wait = Math.min(wait * 2, 30_000);
    // Once linked, reconnect to the same subproject even if the session started unlinked.
    if (place) query.set("sub", place.sub);
  }
}

/** Turns a Send into a channel event in the session. */
async function forward(mcp: Server, d: Delivery): Promise<void> {
  const meta: Record<string, string> = {
    project: d.place.project,
    subproject: d.place.sub,
    message_id: d.message.id,
  };
  if (d.message.snapshot) meta.snapshot = d.message.snapshot;
  if (d.board) {
    meta.board = d.board.id;
    meta.board_title = d.board.title;
    meta.image = d.board.path;
  }
  await mcp.notification({
    method: "notifications/claude/channel",
    params: { content: d.message.text || "(no message: the marks on the snapshot are the feedback)", meta },
  });
}

/** Reads a Server-Sent Events stream until it ends. */
async function stream(url: string, token: string, onEvent: (e: { type: string }) => Promise<void>): Promise<void> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok || !res.body) throw new Error(`stream refused: ${res.status}`);
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of block.split("\n")) {
        if (line.startsWith("data: ")) await onEvent(JSON.parse(line.slice(6)) as { type: string });
      }
    }
  }
}

function text(t: string) {
  return { content: [{ type: "text", text: t }] };
}

/** The session id Claude Code gives its MCP servers; a fresh one when run by hand. */
export function sessionFromEnv(): string {
  return process.env.CLAUDE_CODE_SESSION_ID || `manual-${randomUUID()}`;
}
