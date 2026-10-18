// The tablet UI: draw on a board with the pen, pan and zoom with fingers.
// Every finished stroke is saved at once; nothing here talks to Claude.

import { fit, hits, simplify, toImage, widthAt, zoomAt, type View } from "../src/shared/ink.ts";
import type { Board, BoardInk, Point, Stroke, Tool } from "../src/shared/types.ts";

const COLORS = [
  { name: "Amber", value: "#f2a65a" },
  { name: "White", value: "#f2f0f7" },
  { name: "Rose", value: "#e8707e" },
  { name: "Ice", value: "#7cc8ee" },
];
const HIGHLIGHT_ALPHA = 0.35;
const HIGHLIGHT_SCALE = 4;
const ERASER_RADIUS = 14; // screen px
const PALM_GUARD_MS = 600; // ignore touches this long after the pen was near

const $ = <T extends Element>(sel: string) => document.querySelector<T>(sel)!;
const stage = $<HTMLElement>(".stage");
const inkCanvas = $<HTMLCanvasElement>("canvas.ink");
const liveCanvas = $<HTMLCanvasElement>("canvas.live");
const ink = inkCanvas.getContext("2d")!;
const live = liveCanvas.getContext("2d")!;

type Mode = Tool | "eraser";
type Undo = { kind: "add"; id: string } | { kind: "erase"; strokes: Stroke[] };

const state = {
  boards: [] as Board[],
  board: null as Board | null,
  image: null as HTMLImageElement | null,
  strokes: [] as Stroke[],
  view: { x: 0, y: 0, scale: 1 } as View,
  fitted: false,
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
  if (!state.fitted) fitView();
  redraw();
}

function fitView(): void {
  if (!state.image) return;
  const { width, height } = stage.getBoundingClientRect();
  state.view = fit(state.image.naturalWidth, state.image.naturalHeight, width, height);
  state.fitted = true;
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
  for (const s of state.strokes) drawStroke(ink, s);
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
let erasing: { id: number; erased: Stroke[] } | null = null;
const touches = new Map<number, { x: number; y: number }>();
let gesture: { view: View; dist: number; mid: { x: number; y: number } } | null = null;
let mousePan: { id: number; x: number; y: number } | null = null;

function local(e: { clientX: number; clientY: number }): { x: number; y: number } {
  const r = stage.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function pressure(e: PointerEvent): number {
  return e.pointerType === "pen" ? e.pressure : 0.5;
}

/** The S Pen's side button, or a pen's eraser end, erases whatever tool is chosen. */
function wantsEraser(e: PointerEvent): boolean {
  return state.mode === "eraser" || (e.pointerType === "pen" && (e.buttons & (2 | 32)) !== 0);
}

stage.addEventListener("pointerdown", (e) => {
  if (e.pointerType === "touch") return touchDown(e);
  if (e.pointerType === "pen") {
    state.penSeen = performance.now();
    cancelGesture(); // a palm that landed first must not keep panning
  }
  if (e.pointerType === "mouse" && e.button !== 0) {
    mousePan = { id: e.pointerId, x: e.clientX, y: e.clientY };
    stage.setPointerCapture(e.pointerId);
    return;
  }
  if (!state.board || drawing || erasing) return;
  stage.setPointerCapture(e.pointerId);
  if (wantsEraser(e)) {
    erasing = { id: e.pointerId, erased: [] };
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
    state.view = { ...state.view, x: state.view.x + e.clientX - mousePan.x, y: state.view.y + e.clientY - mousePan.y };
    mousePan = { ...mousePan, x: e.clientX, y: e.clientY };
    return redraw();
  }
  if (erasing?.id === e.pointerId) return eraseAt(e);
  if (drawing?.id !== e.pointerId) return;
  const pts = drawing.stroke.points;
  const minStep = 0.75 / state.view.scale;
  for (const ce of e.getCoalescedEvents?.() ?? [e]) {
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
    if (erasing?.id === e.pointerId) return finishErase();
    if (drawing?.id === e.pointerId) return type === "pointerup" ? finishStroke() : dropStroke();
  });
}

stage.addEventListener("contextmenu", (e) => e.preventDefault());

stage.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
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
  const board = state.board!;
  const stroke = drawing!.stroke;
  drawing = null;
  stroke.points = simplify(stroke.points, 0.35 / state.view.scale);
  state.strokes.push(stroke);
  clear(live);
  redraw();
  try {
    const { id } = await api<{ id: string }>(`/api/boards/${board.id}/strokes`, stroke);
    stroke.id = id;
    state.undo.push({ kind: "add", id });
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
  if (gone.length === 0) return;
  erasing!.erased.push(...gone);
  state.strokes = state.strokes.filter((s) => !gone.includes(s));
  redraw();
}

async function finishErase(): Promise<void> {
  const { erased } = erasing!;
  erasing = null;
  if (erased.length === 0) return;
  try {
    await api(`/api/boards/${state.board!.id}/erase`, { ids: erased.map((s) => s.id) });
    state.undo.push({ kind: "erase", strokes: erased });
  } catch (err) {
    state.strokes.push(...erased);
    redraw();
    toast(`Not erased: ${(err as Error).message}`);
  }
}

async function undo(): Promise<void> {
  const step = state.undo.pop();
  if (!step || !state.board) return;
  const board = state.board.id;
  try {
    if (step.kind === "add") {
      await api(`/api/boards/${board}/erase`, { ids: [step.id] });
      state.strokes = state.strokes.filter((s) => s.id !== step.id);
    } else {
      // Bring erased strokes back as new strokes.
      for (const s of step.strokes) {
        const { id } = await api<{ id: string }>(`/api/boards/${board}/strokes`, s);
        state.strokes.push({ ...s, id });
      }
    }
    redraw();
  } catch (err) {
    toast(`Undo failed: ${(err as Error).message}`);
  }
}

// Touch: one finger pans, two pinch. Touches near a pen are palms and are ignored.

function touchDown(e: PointerEvent): void {
  if (drawing || erasing || performance.now() - state.penSeen < PALM_GUARD_MS) return;
  stage.setPointerCapture(e.pointerId);
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

// ---------- toolbar ----------

function setMode(mode: Mode): void {
  state.mode = mode;
  stage.dataset.tool = mode;
  for (const b of document.querySelectorAll<HTMLButtonElement>(".tool")) {
    b.setAttribute("aria-pressed", String(b.dataset.tool === mode));
  }
}

function setColor(color: string): void {
  state.color = color;
  for (const b of document.querySelectorAll<HTMLButtonElement>(".swatch")) {
    b.setAttribute("aria-checked", String(b.dataset.color === color));
  }
  if (state.mode === "eraser") setMode("pen");
}

function setSize(size: number): void {
  state.size = size;
  for (const b of document.querySelectorAll<HTMLButtonElement>(".size")) {
    b.setAttribute("aria-checked", String(Number(b.dataset.size) === size));
  }
}

const swatches = $<HTMLElement>(".swatches");
for (const c of COLORS) {
  const b = document.createElement("button");
  b.className = "swatch";
  b.dataset.color = c.value;
  b.style.setProperty("--c", c.value);
  b.setAttribute("role", "radio");
  b.setAttribute("aria-label", c.name);
  swatches.append(b);
}
for (const b of document.querySelectorAll<HTMLButtonElement>(".size")) b.setAttribute("role", "radio");

document.addEventListener("click", (e) => {
  const b = (e.target as Element).closest<HTMLButtonElement>("button");
  if (!b) return;
  if (b.dataset.tool) setMode(b.dataset.tool as Mode);
  else if (b.dataset.color) setColor(b.dataset.color);
  else if (b.dataset.size) setSize(Number(b.dataset.size));
  else if (b.dataset.act === "undo") void undo();
  else if (b.dataset.act === "fit") {
    fitView();
    redraw();
  } else if (b.dataset.board) void openBoard(b.dataset.board);
});

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "z") {
    e.preventDefault();
    void undo();
  }
});

// ---------- boards ----------

function renderBoards(): void {
  const nav = $<HTMLElement>(".boards");
  nav.replaceChildren(
    ...state.boards.map((b) => {
      const btn = document.createElement("button");
      btn.dataset.board = b.id;
      btn.textContent = b.title;
      btn.setAttribute("aria-current", String(b.id === state.board?.id));
      return btn;
    }),
  );
}

async function openBoard(id: string): Promise<void> {
  const { board, strokes } = await api<BoardInk>(`/api/boards/${id}`);
  const image = new Image();
  image.src = `/api/boards/${id}/image`;
  await image.decode();
  Object.assign(state, { board, strokes, image, fitted: false, undo: [] });
  try {
    localStorage.setItem("padd.board", id);
  } catch {
    // storage may be off; the latest board opens instead
  }
  renderBoards();
  resize();
}

async function api<T = unknown>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body === undefined ? {} : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

let toastTimer = 0;
function toast(text: string): void {
  const el = $<HTMLElement>(".toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.hidden = true), 5000);
}

function setStatus(text: string, s: "live" | "error" | "idle"): void {
  const el = $<HTMLElement>(".status");
  el.textContent = text;
  el.dataset.state = s;
}

async function start(): Promise<void> {
  setMode("pen");
  setColor(state.color);
  setSize(state.size);
  new ResizeObserver(resize).observe(stage);
  try {
    state.boards = await api<Board[]>("/api/boards");
    setStatus("Connected", "live");
  } catch (err) {
    setStatus("Offline", "error");
    toast(`Can't reach padd: ${(err as Error).message}`);
    return;
  }
  $<HTMLElement>(".empty").hidden = state.boards.length > 0;
  let saved: string | null = null;
  try {
    saved = localStorage.getItem("padd.board");
  } catch {
    // ignore
  }
  const pick = state.boards.find((b) => b.id === saved) ?? state.boards.at(-1);
  if (pick) await openBoard(pick.id);
  else renderBoards();
}

void start();
