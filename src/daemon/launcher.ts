// Starts a subproject's Claude session from the tablet. The session runs `padd claude <sub>` in a
// detached tmux session, headless: nothing opens on the computer. padd presses Enter on Claude
// Code's development-channel warning (L-001). To talk to it directly, `padd attach <sub>` in any
// terminal, or "Show its window" on the tablet (a Ghostty window attached to it).
// The folder-trust prompt is never answered for the user: the tablet says to confirm it there.

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { Place } from "../shared/types.ts";

const run = promisify(execFile);

const WARNING = "Loading development channels";
const TRUST = "trust this folder";
const READY = "Channels (experimental)";
const TEND_MS = 5 * 60_000; // watch a new session's prompts this long (the user may be confirming trust)
const POLL_MS = 400;

export interface LauncherOptions {
  /** tmux socket name (-L), so padd's sessions stay apart from the user's own tmux. */
  socket: string;
  /** The command a session runs, e.g. [node, cli.ts, "claude", sub]. */
  command: (place: Place) => string[];
  /** Opens a window on the computer running `argv` (attaching to the tmux session). */
  terminal: (title: string, argv: string[]) => void;
  /** Told when a starting session needs the user at the computer (the folder-trust prompt). */
  onTrust?: (place: Place) => void;
  /** Told when a session's tmux session appears or ends. */
  onChange?: (place: Place) => void;
  /**
   * Start tmux in its own systemd scope. Under padd.service this is what lets sessions outlive a
   * restart of padd: systemd stops everything in a service's cgroup (L-007).
   */
  scope?: boolean;
}

/** padd's own tmux socket (-L), apart from the user's tmux. */
export const SOCKET = "padd";

/** tmux session names can't hold "." or ":"; project and subproject ids are slugs already. */
export function tmuxName(place: Place): string {
  return `padd_${place.project}_${place.sub}`.replace(/[^A-Za-z0-9_-]/g, "-");
}

/** Prefix that runs a command in its own transient systemd scope, outside padd's cgroup. */
export const SCOPE = ["systemd-run", "--user", "--scope", "--collect", "--quiet", "--"];

/** Opens Ghostty in its own scope and session, so it outlives padd (L-002, L-007). */
export function ghostty(title: string, argv: string[]): void {
  const [cmd, ...args] = [...SCOPE, "ghostty", `--title=${title}`, "-e", ...argv];
  spawn(cmd!, args, { detached: true, stdio: "ignore" }).unref();
}

export class Launcher {
  private readonly o: LauncherOptions;
  private readonly tending = new Set<string>();

  constructor(o: LauncherOptions) {
    this.o = o;
  }

  private tmux(...args: string[]): Promise<{ stdout: string }> {
    return run("tmux", ["-L", this.o.socket, ...args]);
  }

  /** Whether the subproject's session is running in padd's tmux. */
  async running(place: Place): Promise<boolean> {
    try {
      await this.tmux("has-session", "-t", `=${tmuxName(place)}`);
      return true;
    } catch {
      return false;
    }
  }

  /** Whether a window is attached to the session right now. */
  async attached(place: Place): Promise<boolean> {
    try {
      return (await this.tmux("list-clients", "-t", `=${tmuxName(place)}`, "-F", "x")).stdout.trim() !== "";
    } catch {
      return false;
    }
  }

  /** Starts the session in the background, unless it already runs. */
  async start(place: Place, repo: string): Promise<"started" | "running"> {
    const name = tmuxName(place);
    if (await this.running(place)) return "running";
    // Given as separate arguments, tmux runs the command directly, with no shell in between.
    const args = ["-L", this.o.socket, "new-session", "-d", "-s", name, "-x", "160", "-y", "48", "-c", repo, "--", ...this.o.command(place)];
    if (this.o.scope) await run(SCOPE[0]!, [...SCOPE.slice(1), "tmux", ...args]);
    else await run("tmux", args);
    void this.tend(place);
    this.o.onChange?.(place);
    return "started";
  }

  /** Opens the session's window, unless one is open already. False if it was. */
  async show(place: Place): Promise<boolean> {
    if (await this.attached(place)) return false;
    this.window(place);
    return true;
  }

  /** Opens a window on the computer attached to the session. */
  window(place: Place): void {
    this.o.terminal(`padd: ${place.project}/${place.sub}`, ["tmux", "-L", this.o.socket, "attach", "-t", `=${tmuxName(place)}`]);
  }

  /** Answers the development-channel warning; reports the trust prompt; notices an early exit. */
  private async tend(place: Place): Promise<void> {
    const name = tmuxName(place);
    if (this.tending.has(name)) return;
    this.tending.add(name);
    let answered = false;
    let asked = false;
    try {
      for (const end = Date.now() + TEND_MS; Date.now() < end; ) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        let screen: string;
        try {
          screen = (await this.tmux("capture-pane", "-p", "-t", `=${name}:`)).stdout;
        } catch {
          this.o.onChange?.(place); // the session ended (Claude quit)
          return;
        }
        // The warning comes after the trust prompt, whose text may linger above it: check it first.
        if (screen.includes(WARNING) && !answered) {
          await this.tmux("send-keys", "-t", `=${name}:`, "Enter");
          answered = true;
        } else if (screen.includes(TRUST) && !answered) {
          // Keep watching: once the user confirms, the channel warning still needs its Enter.
          if (!asked) this.o.onTrust?.(place);
          asked = true;
        } else if (screen.includes(READY)) {
          return;
        }
      }
    } finally {
      this.tending.delete(name);
    }
  }
}
