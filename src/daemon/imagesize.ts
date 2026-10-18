// The displayed size of a PNG, JPEG or WebP from its header, so Claude's drawings (given as
// fractions of the image) can be placed in pixels. JPEG's camera rotation (EXIF orientation 5-8)
// swaps width and height, as browsers display it.

export function imageSize(b: Buffer): { w: number; h: number } | undefined {
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b.length >= 30 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return webp(b);
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) return jpeg(b);
  return undefined;
}

function webp(b: Buffer): { w: number; h: number } | undefined {
  const chunk = b.toString("latin1", 12, 16);
  if (chunk === "VP8 ") return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
  if (chunk === "VP8L") {
    const bits = b.readUInt32LE(21);
    return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
  return undefined;
}

function jpeg(b: Buffer): { w: number; h: number } | undefined {
  let rotated = false;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return undefined;
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i++; // fill byte
      continue;
    }
    const len = b.readUInt16BE(i + 2);
    if (marker === 0xe1 && b.toString("latin1", i + 4, i + 10) === "Exif\0\0") rotated = exifRotated(b.subarray(i + 10, i + 2 + len));
    // Start-of-frame markers carry the size; C4, C8 and CC share the range but aren't frames.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const h = b.readUInt16BE(i + 5);
      const w = b.readUInt16BE(i + 7);
      return rotated ? { w: h, h: w } : { w, h };
    }
    i += 2 + len;
  }
  return undefined;
}

/** Whether the EXIF orientation turns the picture a quarter turn (values 5 to 8). */
function exifRotated(tiff: Buffer): boolean {
  if (tiff.length < 8) return false;
  const le = tiff.toString("latin1", 0, 2) === "II";
  const u16 = (o: number) => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
  const u32 = (o: number) => (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
  const ifd = u32(4);
  if (ifd + 2 > tiff.length) return false;
  const entries = u16(ifd);
  for (let k = 0; k < entries; k++) {
    const e = ifd + 2 + k * 12;
    if (e + 12 > tiff.length) return false;
    if (u16(e) === 0x0112) return u16(e + 8) >= 5 && u16(e + 8) <= 8;
  }
  return false;
}
