// The Claude sessions connected right now. Each session's `padd mcp` holds an event stream open
// here; a Send from the tablet travels down the stream of the session linked to its subproject.

import type { ServerResponse } from "node:http";
import type { Board, Message, Place } from "../shared/types.ts";
import type { Events } from "./events.ts";
import type { Store } from "./store.ts";

/** What `padd mcp` receives for a Send. */
export interface Delivery {
  type: "send";
  place: Place;
  message: Message;
  board?: Board & { path: string };
  /** For an answer: the question it answers. */
  question?: string;
}

interface Agent {
  session: string;
  res: ServerResponse;
  /** The padd project of the session's folder, if it is one. */
  project?: string;
  place?: Place;
}

const key = (p: Place) => `${p.project}/${p.sub}`;

export class Agents {
  private readonly bySession = new Map<string, Agent>();
  private readonly events: Events;

  constructor(events: Events) {
    this.events = events;
  }

  /** Holds a session's stream open until it disconnects. */
  attach(session: string, res: ServerResponse, project?: string): void {
    this.bySession.get(session)?.res.end(); // a reconnect replaces the old stream
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    res.write(": connected\n\n");
    const agent: Agent = { session, res, project };
    this.bySession.set(session, agent);
    const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
    res.on("close", () => {
      clearInterval(ping);
      if (this.bySession.get(session) !== agent) return;
      this.bySession.delete(session);
      if (agent.place && !this.liveFor(agent.place)) {
        this.events.emit({ type: "session", ...agent.place, state: { live: false, session } });
      }
    });
  }

  has(session: string): boolean {
    return this.bySession.has(session);
  }

  placeOf(session: string): Place | undefined {
    return this.bySession.get(session)?.place;
  }

  projectOf(session: string): string | undefined {
    return this.bySession.get(session)?.project;
  }

  /** Writes one event down a session's stream. */
  say(session: string, data: unknown): void {
    this.bySession.get(session)?.res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  /** Links a connected session to a subproject and hands it any Sends that waited for it. */
  async link(session: string, place: Place, store: Store): Promise<void> {
    const agent = this.bySession.get(session);
    if (!agent) throw new Error("session is not connected");
    const before = agent.place;
    agent.place = place;
    await store.setSession(session);
    if (before && `${before.project}/${before.sub}` !== `${place.project}/${place.sub}` && !this.liveFor(before)) {
      this.events.emit({ type: "session", ...before, state: { live: false, session } });
    }
    this.events.emit({ type: "session", ...place, state: { live: true, session } });
    const waiting = (await store.messages()).filter((m) => m.author === "me" && m.snapshot && !m.delivered);
    for (const message of waiting) await this.deliver(place, message, store);
  }

  /** The newest session linked to a subproject that is connected now. */
  liveFor(place: Place): string | undefined {
    let found: string | undefined;
    for (const a of this.bySession.values()) if (a.place && key(a.place) === key(place)) found = a.session;
    return found;
  }

  /** Sends a message to the subproject's session. False if none is connected; it waits then. */
  async deliver(place: Place, message: Message, store: Store): Promise<boolean> {
    const session = this.liveFor(place);
    if (!session) return false;
    let board: Delivery["board"];
    if (message.board) {
      try {
        const b = await store.board(message.board);
        board = { ...b, path: await store.imagePath(b.id) };
      } catch {
        // the board is gone; deliver the message anyway
      }
    }
    const question = message.answering ? (await store.messages()).find((m) => m.id === message.answering)?.text : undefined;
    const delivery: Delivery = { type: "send", place, message, board, ...(question ? { question } : {}) };
    this.say(session, delivery);
    await store.markDelivered([message.id]);
    this.events.emit({ type: "message", ...place, message: { ...message, delivered: true } });
    return true;
  }

  closeAll(): void {
    for (const a of this.bySession.values()) a.res.end();
    this.bySession.clear();
  }
}
