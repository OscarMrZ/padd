// One board on screen: the image, its ink, and the pen, finger and mouse input that edits it.
// Every finished stroke is saved at once; nothing here talks to Claude.

import { fit, hits, simplify, toImage, widthAt, zoomAt, type View } from "../src/shared/ink.ts";
import type { BoardInk, Note, Region, Stroke, Tool } from "../src/shared/types.ts";
import { api, toast } from "./api.ts";

export const COLORS = [
  { name: "Amber", value: "#f2a65a" },
  { name: "White", value: "#f2f0f7" },
  { name: "Rose", value: "#e8707e" },
  { name: "Ice", value: "#7cc8ee" },
];
const HIGHLIGHT_ALPHA = 0.35;
const HIGHLIGHT_SCALE = 4;
const ERASER_RADIUS = 14; // screen px
const PALM_GUARD_MS = 600; // ignore touches this long after the pen was near
const SNAPSHOT_MAX = 2400; // px on the long side of what Claude sees
const PEN_AS_MOUSE_MS = 400; // a "mouse" event this soon after the pen is the pen
const LONG_PRESS_SLOP = 8; // screen px a stroke must have moved for a mid-stroke press to count

export type Mode = Tool | "eraser" | "text";
type Undo = { kind: "add"; id: string } | { kind: "erase"; strokes: Stroke[]; notes: Note[] };

const AUTHOR_COLOR = { me: "#f2a65a", claude: "#b9a3f0" };

export interface BoardView {
  /** Shows a board; `base` is its API path. */
  open(base: string, ink: BoardInk, image: HTMLImageElement): void;
  close(): void;
  /** Applies a change another view made. */
  remoteStroke(stroke: Stroke): void;
  remoteNote(note: Note): void;
  remoteErase(ids: string[]): void;
  /** Highlights the part of the image Claude asks about (null: none). */
  setRegion(region: Region | null): void;
  /** True while the pen or eraser is down: don't swap the board under it. */
  busy(): boolean;
  /** The image with all its ink, as a PNG data URL: what a Send shows Claude. */
  snapshot(): string | null;
  fit(): void;
  undo(): Promise<void>;
  setMode(mode: Mode): void;
  setColor(color: string): void;
  setSize(size: number): void;
}

export interface BoardHooks {
  /** The view changed the tool itself (the S Pen side button): update the toolbar. */
  onMode?: (mode: Mode) => void;
}

export function createBoardView(stage: HTMLElement, hooks: BoardHooks = {}): BoardView {
  const inkCanvas = stage.querySelector<HTMLCanvasElement>("canvas.ink")!;
  const liveCanvas = stage.querySelector<HTMLCanvasElement>("canvas.live")!;
  const ink = inkCanvas.getContext("2d")!;
  const live = liveCanvas.getContext("2d")!;

  const state = {
    base: "",
    image: null as HTMLImageElement | null,
    strokes: [] as Stroke[],
    notes: [] as Note[],
    region: null as Region | null,
    view: { x: 0, y: 0, scale: 1 } as View,
    /** Keep the image fitted as the stage resizes, until the user pans or zooms. */
    autoFit: true,
    mode: "pen" as Mode,
    color: COLORS[0]!.value,
    size: 4,
    undo: [] as Undo[],
    penSeen: 0,
  };

  // ---------- drawing ----------

  function resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const { width, height } = stage.getBoundingClientRect();
    for (const c of [inkCanvas, liveCanvas]) {
      c.width = Math.round(width * dpr);
      c.height = Math.round(height * dpr);
    }
    if (state.autoFit) fitView();
    redraw();
  }

  function fitView(): void {
    if (!state.image) return;
    const { width, height } = stage.getBoundingClientRect();
    if (width === 0 || height === 0) return;
    state.view = fit(state.image.naturalWidth, state.image.naturalHeight, width, height);
  }

  /** Sets the context so drawing happens in image pixels. */
  function toImageSpace(ctx: CanvasRenderingContext2D): void {
    const dpr = window.devicePixelRatio || 1;
    const { x, y, scale } = state.view;
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * x, dpr * y);
  }

  function clear(ctx: CanvasRenderingContext2D): void {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  }

  function redraw(): void {
    clear(ink);
    if (!state.image) return;
    toImageSpace(ink);
    ink.imageSmoothingQuality = "high";
    ink.drawImage(state.image, 0, 0);
    if (state.region) drawRegion(ink, state.region, 1 / state.view.scale);
    for (const s of state.strokes) drawStroke(ink, s);
    placeNotes();
  }

  /** Claude's question region: a dashed lilac frame, its line width in screen pixels via `px`. */
  function drawRegion(ctx: CanvasRenderingContext2D, r: Region, px: number): void {
    const { naturalWidth: w, naturalHeight: h } = state.image!;
    ctx.save();
    ctx.fillStyle = "rgba(185, 163, 240, 0.14)";
    ctx.strokeStyle = AUTHOR_COLOR.claude;
    ctx.lineWidth = 2.5 * px;
    ctx.setLineDash([10 * px, 7 * px]);
    ctx.fillRect(r.x * w, r.y * h, r.w * w, r.h * h);
    ctx.strokeRect(r.x * w, r.y * h, r.w * w, r.h * h);
    ctx.restore();
  }

  // ---------- notes: DOM labels over the canvas, so they stay readable at any zoom ----------

  const notesLayer = document.createElement("div");
  notesLayer.className = "notes";
  stage.append(notesLayer);

  function placeNotes(): void {
    const els = new Map([...notesLayer.children].map((el) => [(el as HTMLElement).dataset.id!, el as HTMLElement]));
    for (const n of state.notes) {
      let el = els.get(n.id);
      if (!el) {
        el = document.createElement("div");
        el.className = `note ${n.author}`;
        el.dataset.id = n.id;
        el.textContent = n.text;
        notesLayer.append(el);
      }
      els.delete(n.id);
      el.style.left = `${state.view.x + n.x * state.view.scale}px`;
      el.style.top = `${state.view.y + n.y * state.view.scale}px`;
    }
    for (const el of els.values()) el.remove();
  }

  /** Writes notes into a snapshot, scaled to the image, so Claude reads them too. */
  function drawNotes(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const font = Math.max(14, Math.round(Math.max(w, h) * 0.018));
    const pad = font * 0.5;
    const maxWidth = w * 0.4;
    ctx.save();
    ctx.font = `500 ${font}px Barlow, sans-serif`;
    ctx.textBaseline = "top";
    for (const n of state.notes) {
      const lines = wrap(ctx, n.text, maxWidth);
      const width = Math.max(...lines.map((l) => ctx.measureText(l).width)) + pad * 2;
      const height = lines.length * font * 1.25 + pad * 2;
      const x = Math.min(n.x, w - width);
      const y = Math.min(n.y, h - height);
      ctx.fillStyle = "rgba(20, 26, 46, 0.88)";
      ctx.fillRect(x, y, width, height);
      ctx.fillStyle = AUTHOR_COLOR[n.author];
      ctx.fillRect(x, y, pad * 0.5, height);
      ctx.beginPath();
      ctx.arc(n.x, n.y, font * 0.3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#e6e4ef";
      lines.forEach((l, i) => ctx.fillText(l, x + pad, y + pad + i * font * 1.25));
    }
    ctx.restore();
  }

  function wrap(ctx: CanvasRenderingContext2D, text: string, max: number): string[] {
    const lines: string[] = [];
    for (const para of text.split("\n")) {
      let line = "";
      for (const word of para.split(/\s+/)) {
        const next = line ? `${line} ${word}` : word;
        if (ctx.measureText(next).width > max && line) {
          lines.push(line);
          line = word;
        } else line = next;
      }
      lines.push(line);
    }
    return lines;
  }

  // ---------- the text tool: tap to place a note, then type (or write with the keyboard) ----------

  let placing: { id: number; x: number; y: number } | null = null;
  /** Saves (or drops) the note being typed, if any. */
  let finishEditing: ((save: boolean) => Promise<void>) | null = null;

  function openEditor(sx: number, sy: number): void {
    closeEditor(true);
    const [ix, iy] = toImage(state.view, sx, sy);
    const base = state.base;
    const box = document.createElement("textarea");
    box.className = "note-editor";
    box.maxLength = 500;
    box.placeholder = "Note";
    box.style.left = `${sx}px`;
    box.style.top = `${sy}px`;
    let done = false;
    const commit = async (save: boolean) => {
      if (done) return;
      done = true;
      const text = box.value.trim();
      box.remove();
      if (finishEditing === commit) finishEditing = null;
      if (!save || !text || state.base !== base) return;
      try {
        const note = await api<Note>(`${base}/notes`, { x: ix, y: iy, text });
        state.notes.push(note);
        state.undo.push({ kind: "add", id: note.id });
        placeNotes();
      } catch (err) {
        toast(`Note not saved: ${(err as Error).message}`);
      }
    };
    box.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void commit(true);
      } else if (e.key === "Escape") void commit(false);
    });
    box.addEventListener("blur", () => void commit(true));
    finishEditing = commit;
    stage.append(box);
    box.focus();
  }

  function closeEditor(save: boolean): void {
    void finishEditing?.(save);
  }

  function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke): void {
    const pts = s.points;
    ctx.save();
    ctx.strokeStyle = ctx.fillStyle = s.color;
    ctx.lineCap = ctx.lineJoin = "round";
    if (s.tool === "highlighter") {
      // One path, so the overlaps inside a stroke don't darken.
      ctx.globalAlpha = HIGHLIGHT_ALPHA;
      ctx.lineWidth = s.size;
      ctx.beginPath();
      ctx.moveTo(pts[0]![0], pts[0]![1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]![0], pts[i]![1]);
      if (pts.length === 1) ctx.lineTo(pts[0]![0] + 0.01, pts[0]![1]);
      ctx.stroke();
    } else if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(pts[0]![0], pts[0]![1], widthAt(s.size, pts[0]![2]) / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // Each piece runs between the midpoints around a point, curving through it,
      // with the width of that point's pressure. Round caps hide the joins.
      let [mx, my] = [pts[0]![0], pts[0]![1]];
      for (let i = 1; i < pts.length; i++) {
        const p = pts[i]!;
        const next = pts[i + 1];
        const [nx, ny] = next ? [(p[0] + next[0]) / 2, (p[1] + next[1]) / 2] : [p[0], p[1]];
        ctx.lineWidth = widthAt(s.size, (pts[i - 1]![2] + p[2]) / 2);
        ctx.beginPath();
        ctx.moveTo(mx, my);
        ctx.quadraticCurveTo(p[0], p[1], nx, ny);
        ctx.stroke();
        [mx, my] = [nx, ny];
      }
    }
    ctx.restore();
  }

  // ---------- input ----------

  let drawing: { id: number; stroke: Stroke } | null = null;
  let erasing: { id: number; erased: Stroke[]; notes: Note[] } | null = null;
  const touches = new Map<number, { x: number; y: number }>();
  let gesture: { view: View; dist: number; mid: { x: number; y: number } } | null = null;
  let mousePan: { id: number; x: number; y: number } | null = null;

  function local(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = stage.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /** Keeps a pointer's events coming here; harmless if the browser has already let it go. */
  function capture(id: number): void {
    try {
      stage.setPointerCapture(id);
    } catch {
      // the pointer is gone (lifted, or cancelled by the browser)
    }
  }

  function pressure(e: PointerEvent): number {
    return e.pointerType === "pen" ? e.pressure : 0.5;
  }

  /**
   * The S Pen's side button (or a pen's eraser end) erases whatever tool is chosen. Browsers
   * report it differently: the barrel (2) or eraser (32) bit in `buttons`, `button` 2 or 5, or,
   * on some Android browsers, a mouse right-click right after the pen was near.
   */
  function penButton(e: PointerEvent): boolean {
    const pen = e.pointerType === "pen" || (e.pointerType === "mouse" && performance.now() - state.penSeen < PEN_AS_MOUSE_MS);
    return pen && ((e.buttons & (2 | 32)) !== 0 || e.button === 2 || e.button === 5);
  }

  /** The pen is on the glass, not hovering. */
  function touching(e: PointerEvent): boolean {
    return (e.buttons & 1) !== 0 || e.pressure > 0;
  }

  function wantsEraser(e: PointerEvent): boolean {
    return state.mode === "eraser" || penButton(e);
  }

  stage.addEventListener("pointerdown", (e) => {
    // Cards and the note editor sit on the stage: taps on them aren't ink.
    if ((e.target as Element).closest(".question, .note-editor")) return;
    if (e.pointerType === "touch") return touchDown(e);
    if (e.pointerType === "pen") {
      state.penSeen = performance.now();
      cancelGesture(); // a palm that landed first must not keep panning
    }
    if (e.pointerType === "mouse" && e.button !== 0 && !penButton(e)) {
      lastRightClick = performance.now();
      mousePan = { id: e.pointerId, x: e.clientX, y: e.clientY };
      capture(e.pointerId);
      return;
    }
    if (!state.image || drawing || erasing) return;
    if (state.mode === "text" && !penButton(e)) {
      // Open the editor when the tap ends: focusing during pointerdown loses the keyboard on Android.
      const { x, y } = local(e);
      placing = { id: e.pointerId, x, y };
      return;
    }
    capture(e.pointerId);
    if (wantsEraser(e)) {
      erasing = { id: e.pointerId, erased: [], notes: [] };
      eraseAt(e);
      return;
    }
    const { x, y } = local(e);
    const [ix, iy] = toImage(state.view, x, y);
    const highlighter = state.mode === "highlighter";
    drawing = {
      id: e.pointerId,
      stroke: {
        id: "",
        author: "me",
        tool: highlighter ? "highlighter" : "pen",
        color: state.color,
        size: (state.size * (highlighter ? HIGHLIGHT_SCALE : 1)) / state.view.scale,
        points: [[ix, iy, pressure(e)]],
        t: Date.now(),
      },
    };
    drawLive();
  });

  stage.addEventListener("pointermove", (e) => {
    if (e.pointerType === "pen") state.penSeen = performance.now();
    if (e.pointerType === "touch") return touchMove(e);
    if (mousePan?.id === e.pointerId) {
      state.autoFit = false;
      state.view = { ...state.view, x: state.view.x + e.clientX - mousePan.x, y: state.view.y + e.clientY - mousePan.y };
      mousePan = { ...mousePan, x: e.clientX, y: e.clientY };
      return redraw();
    }
    // A pen that moves without touching has lifted, even if its pointerup went missing.
    if (e.pointerType === "pen" && !touching(e)) {
      if (erasing?.id === e.pointerId) return void finishErase();
      if (drawing?.id === e.pointerId) return void finishStroke();
      return;
    }
    if (erasing?.id === e.pointerId) return eraseAt(e);
    // The side button pressed while the pen touches arrives as a move (a button chord), with or
    // without a pointerdown before it. Start erasing there, dropping any line in progress.
    if (penButton(e) && touching(e) && state.image && (!drawing || drawing.id === e.pointerId)) {
      if (drawing) dropStroke();
      capture(e.pointerId);
      erasing = { id: e.pointerId, erased: [], notes: [] };
      return eraseAt(e);
    }
    if (drawing?.id !== e.pointerId) return;
    const pts = drawing.stroke.points;
    const minStep = 0.75 / state.view.scale;
    const coalesced = e.getCoalescedEvents?.() ?? [];
    for (const ce of coalesced.length > 0 ? coalesced : [e]) {
      const { x, y } = local(ce);
      const [ix, iy] = toImage(state.view, x, y);
      const last = pts[pts.length - 1]!;
      if (Math.hypot(ix - last[0], iy - last[1]) < minStep) continue;
      pts.push([ix, iy, pressure(ce)]);
    }
    drawLive();
  });

  for (const type of ["pointerup", "pointercancel"] as const) {
    stage.addEventListener(type, (e) => {
      if (e.pointerType === "touch") return touchUp(e);
      if (mousePan?.id === e.pointerId) mousePan = null;
      if (placing?.id === e.pointerId) {
        const { x, y } = placing;
        placing = null;
        if (type === "pointerup") openEditor(x, y);
        return;
      }
      if (erasing?.id === e.pointerId) return void finishErase();
      if (drawing?.id === e.pointerId) return type === "pointerup" ? void finishStroke() : dropStroke();
    });
  }

  // In Android WebView browsers (DuckDuckGo, many in-app browsers) the S Pen side button never
  // shows in pointer events: each press arrives as a contextmenu event, with no release (L-008).
  // So a press toggles the eraser; pressed mid-stroke, the rest of that stroke erases.
  let lastRightClick = -Infinity;
  let toolBeforeEraser: Mode = "pen";
  window.addEventListener("contextmenu", (e) => {
    if ((e.target as Element).closest?.("input, textarea")) return; // keep copy and paste there
    e.preventDefault();
    const kind = (e as PointerEvent).pointerType ?? "";
    if (kind === "touch") return; // a finger's long press
    if (performance.now() - lastRightClick < 1500) return; // a desktop right-click (it pans)
    if (drawing) {
      // A pen held still also fires contextmenu (a long press): only a moving stroke counts.
      const pts = drawing.stroke.points;
      const [x0, y0] = pts[0]!;
      const moved = pts.some(([x, y]) => Math.hypot(x - x0, y - y0) * state.view.scale > LONG_PRESS_SLOP);
      if (!moved) return;
      const id = drawing.id;
      dropStroke();
      erasing = { id, erased: [], notes: [] };
    }
    toggleEraser();
  });

  function toggleEraser(): void {
    if (state.mode === "eraser") setMode(toolBeforeEraser);
    else {
      toolBeforeEraser = state.mode;
      setMode("eraser");
    }
    hooks.onMode?.(state.mode);
  }

  function setMode(mode: Mode): void {
    if (mode !== "text") closeEditor(true);
    state.mode = mode;
    stage.dataset.tool = mode;
  }

  stage.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      state.autoFit = false;
      const { x, y } = local(e);
      if (e.ctrlKey || !e.shiftKey) state.view = zoomAt(state.view, x, y, Math.exp(-e.deltaY * 0.0015));
      else state.view = { ...state.view, x: state.view.x - e.deltaY, y: state.view.y };
      redraw();
    },
    { passive: false },
  );

  function drawLive(): void {
    clear(live);
    if (!drawing) return;
    toImageSpace(live);
    drawStroke(live, drawing.stroke);
  }

  function dropStroke(): void {
    drawing = null;
    clear(live);
  }

  async function finishStroke(): Promise<void> {
    const base = state.base;
    const stroke = drawing!.stroke;
    drawing = null;
    stroke.points = simplify(stroke.points, 0.35 / state.view.scale);
    state.strokes.push(stroke);
    clear(live);
    redraw();
    try {
      const { id } = await api<{ id: string }>(`${base}/strokes`, stroke);
      stroke.id = id;
      if (state.base === base) state.undo.push({ kind: "add", id });
    } catch (err) {
      state.strokes = state.strokes.filter((s) => s !== stroke);
      redraw();
      toast(`Stroke not saved: ${(err as Error).message}`);
    }
  }

  function eraseAt(e: PointerEvent): void {
    const { x, y } = local(e);
    const [ix, iy] = toImage(state.view, x, y);
    const r = ERASER_RADIUS / state.view.scale;
    const gone = state.strokes.filter((s) => s.id && hits(s, ix, iy, r));
    // A note goes when the eraser touches its label.
    const goneNotes = state.notes.filter((n) => {
      const box = notesLayer.querySelector<HTMLElement>(`[data-id="${n.id}"]`)?.getBoundingClientRect();
      return box && e.clientX > box.left - ERASER_RADIUS && e.clientX < box.right + ERASER_RADIUS &&
        e.clientY > box.top - ERASER_RADIUS && e.clientY < box.bottom + ERASER_RADIUS;
    });
    if (gone.length === 0 && goneNotes.length === 0) return;
    erasing!.erased.push(...gone);
    erasing!.notes.push(...goneNotes);
    state.strokes = state.strokes.filter((s) => !gone.includes(s));
    state.notes = state.notes.filter((n) => !goneNotes.includes(n));
    redraw();
  }

  async function finishErase(): Promise<void> {
    const { erased, notes } = erasing!;
    const base = state.base;
    erasing = null;
    if (erased.length === 0 && notes.length === 0) return;
    try {
      await api(`${base}/erase`, { ids: [...erased.map((s) => s.id), ...notes.map((n) => n.id)] });
      if (state.base === base) state.undo.push({ kind: "erase", strokes: erased, notes });
    } catch (err) {
      if (state.base === base) {
        state.strokes.push(...erased);
        state.notes.push(...notes);
        redraw();
      }
      toast(`Not erased: ${(err as Error).message}`);
    }
  }

  async function undo(): Promise<void> {
    const step = state.undo.pop();
    if (!step) return;
    const base = state.base;
    try {
      if (step.kind === "add") {
        await api(`${base}/erase`, { ids: [step.id] });
        state.strokes = state.strokes.filter((s) => s.id !== step.id);
        state.notes = state.notes.filter((n) => n.id !== step.id);
      } else {
        // Bring erased strokes and notes back as new ones.
        for (const s of step.strokes) {
          const { id } = await api<{ id: string }>(`${base}/strokes`, s);
          state.strokes.push({ ...s, id });
        }
        for (const n of step.notes) state.notes.push(await api<Note>(`${base}/notes`, { x: n.x, y: n.y, text: n.text }));
      }
      redraw();
    } catch (err) {
      toast(`Undo failed: ${(err as Error).message}`);
    }
  }

  // Touch: one finger pans, two pinch. Touches near a pen are palms and are ignored.

  function touchDown(e: PointerEvent): void {
    if (drawing || erasing || performance.now() - state.penSeen < PALM_GUARD_MS) return;
    capture(e.pointerId);
    touches.set(e.pointerId, local(e));
    startGesture();
  }

  function touchMove(e: PointerEvent): void {
    if (!touches.has(e.pointerId)) return;
    if (performance.now() - state.penSeen < PALM_GUARD_MS) return cancelGesture();
    touches.set(e.pointerId, local(e));
    if (!gesture) return;
    const { dist, mid } = measure();
    const g = gesture;
    const k = g.dist > 0 && dist > 0 ? dist / g.dist : 1;
    // Zoom about the gesture's start midpoint, then follow the midpoint as it moves.
    const zoomed = zoomAt(g.view, g.mid.x, g.mid.y, k);
    state.autoFit = false;
    state.view = { ...zoomed, x: zoomed.x + mid.x - g.mid.x, y: zoomed.y + mid.y - g.mid.y };
    redraw();
  }

  function touchUp(e: PointerEvent): void {
    if (!touches.delete(e.pointerId)) return;
    startGesture();
  }

  function startGesture(): void {
    if (touches.size === 0 || touches.size > 2) {
      gesture = null;
      return;
    }
    const { dist, mid } = measure();
    gesture = { view: state.view, dist, mid };
  }

  function cancelGesture(): void {
    touches.clear();
    gesture = null;
  }

  function measure(): { dist: number; mid: { x: number; y: number } } {
    const [a, b] = [...touches.values()];
    if (!b) return { dist: 0, mid: { ...a! } };
    return { dist: Math.hypot(b.x - a!.x, b.y - a!.y), mid: { x: (a!.x + b.x) / 2, y: (a!.y + b.y) / 2 } };
  }

  new ResizeObserver(resize).observe(stage);

  return {
    open(base, data, image) {
      dropStroke();
      closeEditor(true);
      Object.assign(state, { base, image, strokes: data.strokes, notes: data.notes ?? [], region: null, autoFit: true, undo: [] });
      resize();
    },
    close() {
      dropStroke();
      closeEditor(true);
      Object.assign(state, { base: "", image: null, strokes: [], notes: [], region: null, undo: [] });
      redraw();
    },
    remoteNote(note) {
      if (state.notes.some((n) => n.id === note.id)) return;
      state.notes.push(note);
      placeNotes();
    },
    setRegion(region) {
      state.region = region;
      redraw();
    },
    remoteStroke(stroke) {
      if (state.strokes.some((s) => s.id === stroke.id)) return;
      state.strokes.push(stroke);
      redraw();
    },
    remoteErase(ids) {
      state.strokes = state.strokes.filter((s) => !ids.includes(s.id));
      state.notes = state.notes.filter((n) => !ids.includes(n.id));
      redraw();
    },
    busy: () => drawing !== null || erasing !== null,
    snapshot() {
      if (!state.image) return null;
      const { naturalWidth: w, naturalHeight: h } = state.image;
      const k = Math.min(1, SNAPSHOT_MAX / Math.max(w, h));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(w * k);
      canvas.height = Math.round(h * k);
      const ctx = canvas.getContext("2d")!;
      ctx.scale(k, k);
      ctx.drawImage(state.image, 0, 0);
      if (state.region) drawRegion(ctx, state.region, Math.max(w, h) / 1000);
      for (const s of state.strokes) drawStroke(ctx, s);
      drawNotes(ctx, w, h);
      return canvas.toDataURL("image/png");
    },
    fit() {
      state.autoFit = true;
      fitView();
      redraw();
    },
    undo,
    setMode,
    setColor(color) {
      state.color = color;
    },
    setSize(size) {
      state.size = size;
    },
  };
}
