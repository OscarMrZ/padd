// Pure ink math: pressure, simplification, hit tests and the pan/zoom view.
// No DOM here, so the tests run it in Node and the UI runs it in the browser.

import type { Point, Stroke } from "./types.ts";

/** Pen width at a given pressure. A light touch still leaves a visible line. */
export function widthAt(size: number, pressure: number): number {
  const p = Math.min(1, Math.max(0, pressure));
  return size * (0.3 + 0.9 * p);
}

/** Drops points closer than `eps` to the line through their neighbours (Ramer–Douglas–Peucker). */
export function simplify(points: Point[], eps: number): Point[] {
  if (points.length < 3) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [a, b] = stack.pop()!;
    let worst = -1;
    let worstDist = eps;
    for (let i = a + 1; i < b; i++) {
      const d = distToSegment(points[i]!, points[a]!, points[b]!);
      // Keep pressure changes too: a point whose pressure jumps shapes the line's width.
      const dp = Math.abs(points[i]![2] - (points[a]![2] + points[b]![2]) / 2) * 10;
      if (Math.max(d, dp) > worstDist) {
        worst = i;
        worstDist = Math.max(d, dp);
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** Distance from point `p` to the segment `a`–`b`. */
export function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Whether a circle of `radius` at (x, y) touches the stroke's line. */
export function hits(stroke: Stroke, x: number, y: number, radius: number): boolean {
  const p: Point = [x, y, 0];
  const reach = radius + stroke.size / 2;
  const pts = stroke.points;
  if (pts.length === 1) return distToSegment(p, pts[0]!, pts[0]!) <= reach;
  for (let i = 1; i < pts.length; i++) {
    if (distToSegment(p, pts[i - 1]!, pts[i]!) <= reach) return true;
  }
  return false;
}

/** Maps image pixels to screen pixels: screen = image * scale + offset. */
export interface View {
  x: number;
  y: number;
  scale: number;
}

export function toImage(v: View, sx: number, sy: number): [number, number] {
  return [(sx - v.x) / v.scale, (sy - v.y) / v.scale];
}

/** Centres an image of `iw`×`ih` in a `w`×`h` screen with a margin, never upscaling past 2×. */
export function fit(iw: number, ih: number, w: number, h: number, margin = 24): View {
  const scale = Math.min((w - 2 * margin) / iw, (h - 2 * margin) / ih, 2);
  return { x: (w - iw * scale) / 2, y: (h - ih * scale) / 2, scale };
}

export const MIN_SCALE = 0.05;
export const MAX_SCALE = 16;

/** Zooms by `factor` keeping the screen point (sx, sy) fixed under the finger or cursor. */
export function zoomAt(v: View, sx: number, sy: number, factor: number): View {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * factor));
  const k = scale / v.scale;
  return { x: sx - (sx - v.x) * k, y: sy - (sy - v.y) * k, scale };
}
