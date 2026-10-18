// ?debug in the address: a readout of every input event that reaches the page, to see how a new
// device (an S Pen, its side button) reports itself. "Send log" writes it to padd's journal.

import { api, toast } from "./api.ts";

const TYPES = [
  "pointerdown", "pointermove", "pointerup", "pointercancel", "pointerover", "pointerout",
  "gotpointercapture", "lostpointercapture", "contextmenu", "auxclick", "click", "dblclick",
  "mousedown", "mouseup", "touchstart", "touchend", "touchcancel", "keydown", "keyup", "selectstart",
] as const;
const SHOWN = 12;
const KEPT = 400;

export function startDebug(): void {
  if (!new URLSearchParams(location.search).has("debug")) return;
  const box = document.createElement("div");
  box.className = "input-debug";
  const pre = document.createElement("pre");
  const send = document.createElement("button");
  send.textContent = "Send log to the computer";
  box.append(pre, send);
  document.body.append(box);

  const log: string[] = [];
  let lastMove = "";
  let lastMoveAt = 0;
  const describe = (e: Event): string => {
    const t = Math.round(e.timeStamp);
    if (e instanceof PointerEvent) {
      return `${t} ${e.type} ${e.pointerType} id=${e.pointerId} button=${e.button} buttons=${e.buttons} p=${e.pressure.toFixed(2)} on=${(e.target as Element).tagName?.toLowerCase()}`;
    }
    if (e instanceof MouseEvent) return `${t} ${e.type} button=${e.button} buttons=${e.buttons}`;
    if (e instanceof TouchEvent) {
      const touch = e.changedTouches[0] as (Touch & { touchType?: string }) | undefined;
      return `${t} ${e.type} touches=${e.touches.length} type=${touch?.touchType ?? "?"} force=${touch?.force?.toFixed(2) ?? "?"}`;
    }
    if (e instanceof KeyboardEvent) return `${t} ${e.type} key=${e.key} code=${e.code}`;
    return `${t} ${e.type}`;
  };
  const render = () => (pre.textContent = `${log.length} events\n` + log.slice(-SHOWN).reverse().join("\n"));
  for (const type of TYPES) {
    window.addEventListener(
      type,
      (e) => {
        let line = describe(e);
        if (e.type === "pointermove") {
          // Hover and drags send moves constantly: keep one when its buttons change, else one per 300 ms.
          const shape = line.replace(/^\d+ /, "").replace(/ p=\S+/, "");
          if (shape === lastMove && e.timeStamp - lastMoveAt < 300) return;
          lastMove = shape;
          lastMoveAt = e.timeStamp;
        }
        if (box.contains(e.target as Node)) return;
        log.push(line);
        if (log.length > KEPT) log.shift();
        render();
      },
      { capture: true, passive: true },
    );
  }
  render();
  send.addEventListener("click", async () => {
    try {
      await api("/api/debug", { lines: log.slice(), agent: navigator.userAgent });
      toast(`Sent ${log.length} events`, "ok");
    } catch (err) {
      toast(`Not sent: ${(err as Error).message}`);
    }
  });
}
