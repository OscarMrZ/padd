// Claude's drawings: shapes given as fractions of the image (0 = left/top, 1 = right/bottom),
// turned into ordinary strokes in pixels, in Claude's colour. Fractions spare Claude from
// knowing image sizes, and work on any render it looks at.

import type { Point, Region, Stroke } from "../shared/types.ts";
import { Invalid, newId } from "./store.ts";

export const CLAUDE_COLOR = "#b9a3f0";

export type Shape =
  | { type: "arrow"; from: [number, number]; to: [number, number] }
  | { type: "circle"; center: [number, number]; radius: number | [number, number] }
  | { type: "rect"; x: number; y: number; w: number; h: number }
  | { type: "line"; points: [number, number][] };

const MAX_SHAPES = 40;
const MAX_POINTS = 2000;
const PRESSURE = 0.6;

/** Validates Claude's shapes and turns them into strokes for an image of w×h pixels. */
export function shapesToStrokes(raw: unknown, w: number, h: number): Stroke[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_SHAPES) {
    throw new Invalid(`shapes must list 1 to ${MAX_SHAPES} shapes`);
  }
  // A line about 0.6% of the image's long side: clear even when the image is shown small.
  const size = Math.max(2, Math.round(Math.max(w, h) * 0.006));
  const px = ([x, y]: [number, number]): Point => [x * w, y * h, PRESSURE];
  return raw.map((shape: unknown) => ({
    id: newId(),
    author: "claude" as const,
    tool: "pen" as const,
    color: CLAUDE_COLOR,
    size,
    points: outline(shape, w, h).map(px),
    t: Date.now(),
  }));
}

function outline(raw: unknown, w: number, h: number): [number, number][] {
  const s = raw as Record<string, unknown>;
  switch (s?.type) {
    case "arrow": {
      const from = pair(s.from, "arrow.from");
      const to = pair(s.to, "arrow.to");
      // The head: two short strokes back from the tip, ±28° off the shaft, in pixel space.
      const [dx, dy] = [(to[0] - from[0]) * w, (to[1] - from[1]) * h];
      const len = Math.hypot(dx, dy) || 1;
      const head = Math.min(len * 0.35, Math.max(w, h) * 0.035);
      const wing = (turn: number): [number, number] => {
        const a = Math.atan2(dy, dx) + Math.PI + turn;
        return [to[0] + (Math.cos(a) * head) / w, to[1] + (Math.sin(a) * head) / h];
      };
      return [from, to, wing(0.5), to, wing(-0.5)];
    }
    case "circle": {
      const c = pair(s.center, "circle.center");
      const [rx, ry] = typeof s.radius === "number" ? [s.radius * Math.max(w, h) / w, s.radius * Math.max(w, h) / h] : pair(s.radius, "circle.radius");
      if (!(rx > 0 && ry > 0)) throw new Invalid("circle.radius must be positive");
      return Array.from({ length: 49 }, (_, i): [number, number] => {
        const a = (i / 48) * Math.PI * 2;
        return [c[0] + Math.cos(a) * rx, c[1] + Math.sin(a) * ry];
      });
    }
    case "rect": {
      const r = region(s, "rect");
      return [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h], [r.x, r.y]];
    }
    case "line": {
      if (!Array.isArray(s.points) || s.points.length < 2 || s.points.length > MAX_POINTS) {
        throw new Invalid(`line.points must hold 2 to ${MAX_POINTS} points`);
      }
      return s.points.map((p) => pair(p, "line.points"));
    }
    default:
      throw new Invalid("each shape's type must be arrow, circle, rect or line");
  }
}

/** A part of the image, checked: fractions, inside (or just around) the image, not empty. */
export function region(raw: unknown, what = "region"): Region {
  const r = raw as Record<string, unknown>;
  const [x, y, w, h] = [r?.x, r?.y, r?.w, r?.h].map((v) => (typeof v === "number" && Number.isFinite(v) ? v : NaN));
  if ([x, y, w, h].some(Number.isNaN)) throw new Invalid(`${what} needs numbers x, y, w and h`);
  if (!(w! > 0 && h! > 0)) throw new Invalid(`${what}.w and .h must be positive`);
  if (x! < -0.1 || y! < -0.1 || x! + w! > 1.1 || y! + h! > 1.1) throw new Invalid(`${what} must be fractions of the image (0 to 1)`);
  return { x: x!, y: y!, w: w!, h: h! };
}

function pair(raw: unknown, what: string): [number, number] {
  if (!Array.isArray(raw) || raw.length !== 2 || !raw.every((n) => typeof n === "number" && Number.isFinite(n))) {
    throw new Invalid(`${what} must be [x, y]`);
  }
  const [x, y] = raw as [number, number];
  if (x < -0.1 || x > 1.1 || y < -0.1 || y > 1.1) throw new Invalid(`${what} must be fractions of the image (0 to 1)`);
  return [x, y];
}
