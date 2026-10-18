// Fans live changes out to every open tablet view as Server-Sent Events.

import type { ServerResponse } from "node:http";
import type { PaddEvent } from "../shared/types.ts";

const HEARTBEAT_MS = 25_000;

export class Events {
  private readonly clients = new Set<ServerResponse>();
  private readonly timer: NodeJS.Timeout;

  constructor() {
    // A comment line now and then keeps proxies and sleepy Wi-Fi from closing the stream.
    this.timer = setInterval(() => {
      for (const res of this.clients) res.write(": ping\n\n");
    }, HEARTBEAT_MS);
    this.timer.unref();
  }

  /** Turns a response into an event stream until the client goes away. */
  attach(res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(": connected\n\n");
    this.clients.add(res);
    res.on("close", () => this.clients.delete(res));
  }

  /** How many tablet views are open. */
  size(): number {
    return this.clients.size;
  }

  emit(event: PaddEvent): void {
    const chunk = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of this.clients) res.write(chunk);
  }

  close(): void {
    clearInterval(this.timer);
    for (const res of this.clients) res.end();
    this.clients.clear();
  }
}
