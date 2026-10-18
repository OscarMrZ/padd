import assert from "node:assert/strict";
import { test } from "node:test";
import { distToSegment, fit, hits, simplify, toImage, widthAt, zoomAt } from "../src/shared/ink.ts";
import type { Point, Stroke } from "../src/shared/types.ts";

test("widthAt keeps a light touch visible and clamps pressure", () => {
  assert.equal(widthAt(10, 0), 3);
  assert.equal(widthAt(10, 1), 12);
  assert.equal(widthAt(10, 5), 12);
});

test("simplify drops points on a straight line but keeps corners and pressure jumps", () => {
  const line: Point[] = [[0, 0, 0.5], [1, 0, 0.5], [2, 0, 0.5], [3, 0, 0.5]];
  assert.deepEqual(simplify(line, 0.1), [[0, 0, 0.5], [3, 0, 0.5]]);
  const corner: Point[] = [[0, 0, 0.5], [5, 0, 0.5], [5, 5, 0.5]];
  assert.equal(simplify(corner, 0.1).length, 3);
  const press: Point[] = [[0, 0, 0.1], [1, 0, 0.9], [2, 0, 0.1]];
  assert.equal(simplify(press, 0.1).length, 3);
});

test("distToSegment measures to the nearest point, including the ends", () => {
  assert.equal(distToSegment([5, 3, 0], [0, 0, 0], [10, 0, 0]), 3);
  assert.equal(distToSegment([13, 4, 0], [0, 0, 0], [10, 0, 0]), 5);
  assert.equal(distToSegment([3, 4, 0], [0, 0, 0], [0, 0, 0]), 5);
});

test("hits counts the stroke's own width", () => {
  const s: Stroke = { id: "a", author: "me", tool: "pen", color: "#ffffff", size: 4, points: [[0, 0, 1], [10, 0, 1]], t: 0 };
  assert.ok(hits(s, 5, 2.9, 1)); // 2.9 <= 1 + 4/2
  assert.ok(!hits(s, 5, 3.1, 1));
});

test("fit centres the image and never upscales past 2x", () => {
  const v = fit(100, 50, 1000, 1000, 0);
  assert.equal(v.scale, 2);
  assert.deepEqual([v.x, v.y], [400, 450]);
  const big = fit(2000, 1000, 1000, 1000, 0);
  assert.equal(big.scale, 0.5);
});

test("zoomAt keeps the point under the finger fixed", () => {
  const v = { x: 30, y: -20, scale: 1.5 };
  const before = toImage(v, 200, 120);
  const z = zoomAt(v, 200, 120, 2.5);
  const after = toImage(z, 200, 120);
  assert.ok(Math.abs(before[0] - after[0]) < 1e-9 && Math.abs(before[1] - after[1]) < 1e-9);
  assert.equal(zoomAt(v, 0, 0, 1e9).scale, 16);
});
