// padd serve as a systemd user service: it starts with the desktop session, restarts if it
// crashes, and logs to the journal (journalctl --user -u padd).

import { execFile } from "node:child_process";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
export const UNIT = "padd.service";

export interface UnitOptions {
  /** Absolute path of the node binary. */
  node: string;
  /** Absolute path of src/cli.ts. */
  cli: string;
  /** The padd repo. */
  root: string;
}

/**
 * The unit file. It hangs off graphical-session.target rather than default.target so it starts
 * after the compositor has exported WAYLAND_DISPLAY: padd opens Ghostty windows for sessions.
 */
export function unit(o: UnitOptions): string {
  return `[Unit]
Description=PADD: draw feedback for Claude Code sessions from a tablet
Documentation=file://${o.root}/README.md
After=graphical-session.target network-online.target
PartOf=graphical-session.target

[Service]
ExecStart=${o.node} ${o.cli} serve
WorkingDirectory=${o.root}
Restart=on-failure
RestartSec=3
SyslogIdentifier=padd

[Install]
WantedBy=graphical-session.target
`;
}

function unitPath(): string {
  const config = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(config, "systemd", "user", UNIT);
}

async function systemctl(...args: string[]): Promise<string> {
  const { stdout } = await run("systemctl", ["--user", ...args]);
  return stdout.trim();
}

/** Writes the unit, enables it and (re)starts it. */
export async function install(o: UnitOptions): Promise<string> {
  try {
    await stat(join(o.root, "dist", "web", "ui", "app.js"));
  } catch {
    throw new Error(`the tablet UI isn't built yet: run npm run build in ${o.root}`);
  }
  const path = unitPath();
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, unit(o));
  await systemctl("daemon-reload");
  await systemctl("enable", UNIT);
  await systemctl("restart", UNIT);
  return path;
}

export async function uninstall(): Promise<void> {
  await systemctl("disable", "--now", UNIT).catch(() => "");
  await rm(unitPath(), { force: true });
  await systemctl("daemon-reload");
}

/** "active", "inactive", "failed"… as systemd says. */
export async function state(): Promise<string> {
  return systemctl("is-active", UNIT).catch((e: { stdout?: string }) => e.stdout?.trim() || "unknown");
}
