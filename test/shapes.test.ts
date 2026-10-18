import assert from "node:assert/strict";
import { test } from "node:test";
import { CLAUDE_COLOR, region, shapesToStrokes } from "../src/daemon/shapes.ts";
import { Invalid } from "../src/daemon/store.ts";

test("shapes become Claude's strokes in pixels", () => {
  const [arrow, circle, rect, line] = shapesToStrokes(
    [
      { type: "arrow", from: [0.1, 0.5], to: [0.5, 0.5] },
      { type: "circle", center: [0.5, 0.5], radius: 0.1 },
      { type: "rect", x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
      { type: "line", points: [[0, 0], [1, 1]] },
    ],
    1000,
    500,
  );
  for (const s of [arrow, circle, rect, line]) {
    assert.equal(s!.author, "claude");
    assert.equal(s!.color, CLAUDE_COLOR);
    assert.equal(s!.size, 6); // 0.6% of the long side
  }
  assert.deepEqual(arrow!.points.slice(0, 2).map(([x, y]) => [x, y]), [[100, 250], [500, 250]]);
  assert.equal(arrow!.points.length, 5); // shaft, then the two sides of the head
  // A plain radius is a fraction of the long side, so circles stay round on wide images.
  const xs = circle!.points.map(([x]) => x);
  const ys = circle!.points.map(([, y]) => y);
  assert.equal(Math.round(Math.max(...xs) - Math.min(...xs)), 200);
  assert.equal(Math.round(Math.max(...ys) - Math.min(...ys)), 200);
  assert.deepEqual(rect!.points.map(([x, y]) => [x, y]), [[250, 125], [750, 125], [750, 375], [250, 375], [250, 125]]);
  assert.deepEqual(line!.points.map(([x, y]) => [x, y]), [[0, 0], [1000, 500]]);
});

test("bad shapes are refused with a reason", () => {
  assert.throws(() => shapesToStrokes([], 10, 10), Invalid);
  assert.throws(() => shapesToStrokes([{ type: "star" }], 10, 10), /arrow, circle, rect or line/);
  assert.throws(() => shapesToStrokes([{ type: "arrow", from: [0, 0], to: [500, 300] }], 10, 10), /fractions/);
  assert.throws(() => shapesToStrokes([{ type: "circle", center: [0.5, 0.5], radius: -1 }], 10, 10), /positive/);
  assert.throws(() => shapesToStrokes([{ type: "line", points: [[0, 0]] }], 10, 10), /2 to/);
});

test("regions are fractions of the image", () => {
  assert.deepEqual(region({ x: 0.2, y: 0.1, w: 0.3, h: 0.4 }), { x: 0.2, y: 0.1, w: 0.3, h: 0.4 });
  assert.throws(() => region({ x: 0.2, y: 0.1, w: 0, h: 0.4 }), /positive/);
  assert.throws(() => region({ x: 120, y: 80, w: 300, h: 200 }), /fractions/);
});
