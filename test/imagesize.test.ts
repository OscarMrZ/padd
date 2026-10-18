import assert from "node:assert/strict";
import { test } from "node:test";
import { imageSize } from "../src/daemon/imagesize.ts";

const png = (w: number, h: number) => {
  const b = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").copy(b);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
};

/** A JPEG header: optional EXIF orientation, then a baseline frame of w×h. */
const jpeg = (w: number, h: number, orientation?: number) => {
  const parts = [Buffer.from("ffd8", "hex")];
  if (orientation) {
    const tiff = Buffer.alloc(26);
    tiff.write("MM", 0, "latin1");
    tiff.writeUInt16BE(42, 2);
    tiff.writeUInt32BE(8, 4); // IFD0 at 8
    tiff.writeUInt16BE(1, 8); // one entry
    tiff.writeUInt16BE(0x0112, 10); // Orientation
    tiff.writeUInt16BE(3, 12); // SHORT
    tiff.writeUInt32BE(1, 14);
    tiff.writeUInt16BE(orientation, 18);
    const app1 = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
    const head = Buffer.alloc(4);
    head.writeUInt16BE(0xffe1, 0);
    head.writeUInt16BE(app1.length + 2, 2);
    parts.push(head, app1);
  }
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(h, 5);
  sof.writeUInt16BE(w, 7);
  parts.push(sof);
  return Buffer.concat(parts);
};

const webpX = (w: number, h: number) => {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0, "latin1");
  b.write("WEBPVP8X", 8, "latin1");
  b.writeUIntLE(w - 1, 24, 3);
  b.writeUIntLE(h - 1, 27, 3);
  return b;
};

test("reads PNG, JPEG and WebP sizes from their headers", () => {
  assert.deepEqual(imageSize(png(1000, 750)), { w: 1000, h: 750 });
  assert.deepEqual(imageSize(jpeg(4000, 3000)), { w: 4000, h: 3000 });
  assert.deepEqual(imageSize(webpX(1600, 900)), { w: 1600, h: 900 });
});

test("a camera JPEG turned a quarter turn reports its displayed size", () => {
  assert.deepEqual(imageSize(jpeg(4000, 3000, 6)), { w: 3000, h: 4000 });
  assert.deepEqual(imageSize(jpeg(4000, 3000, 3)), { w: 4000, h: 3000 }); // upside down: same size
});

test("anything else has no size", () => {
  assert.equal(imageSize(Buffer.from("<svg/>")), undefined);
  assert.equal(imageSize(Buffer.from("ffd8ffd9", "hex")), undefined);
});
