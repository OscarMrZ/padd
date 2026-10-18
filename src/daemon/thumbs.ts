// Small previews for the filmstrip. Renders are often 1-2 MB each; dozens of them over Wi-Fi
// would make the strip crawl, so each board gets a ~30 kB WebP made once with ImageMagick.

import { execFile } from "node:child_process";
import { rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const SIZE = 360; // px on the long side: sharp on a 2x screen at the strip's height
let missing = false;
const making = new Map<string, Promise<string>>();

/** Path of the board's thumbnail, made on first use; the full image if ImageMagick is absent. */
export async function thumbnail(image: string): Promise<string> {
  if (missing) return image;
  const thumb = join(dirname(image), "thumb.webp");
  try {
    await stat(thumb);
    return thumb;
  } catch {
    // not made yet
  }
  // A filmstrip asks for many at once; make each one only once.
  let job = making.get(thumb);
  if (!job) {
    job = make(image, thumb).finally(() => making.delete(thumb));
    making.set(thumb, job);
  }
  return job;
}

async function make(image: string, thumb: string): Promise<string> {
  const tmp = `${thumb}.${process.pid}.tmp.webp`;
  try {
    await run("magick", [image, "-auto-orient", "-thumbnail", `${SIZE}x${SIZE}>`, "-quality", "80", tmp]);
    await rename(tmp, thumb);
    return thumb;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      missing = true;
      console.warn("padd: ImageMagick (magick) not found; the filmstrip will load full images");
    } else {
      console.warn(`padd: no thumbnail for ${image}: ${(e as Error).message}`);
    }
    return image;
  }
}
