// The tablet reaches padd over the LAN, and a Send puts text in front of a Claude session, so
// every request must carry the token: once as ?token=… (the link padd prints), then as a cookie.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { dirname } from "node:path";

export const COOKIE = "padd_token";

/** Reads the token at `path`, creating a fresh one (owner-only) on first run. */
export async function loadToken(path: string): Promise<string> {
  try {
    const token = (await readFile(path, "utf8")).trim();
    if (token) return token;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const token = randomBytes(24).toString("base64url");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, token + "\n", { mode: 0o600 });
  await chmod(path, 0o600);
  return token;
}

export function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** The token a request carries in its cookie or Authorization header, if any. */
export function presented(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, v] = part.trim().split("=");
    if (k === COOKIE && v) return decodeURIComponent(v);
  }
  return undefined;
}
