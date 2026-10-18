import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Launcher, terminalCommand, tmuxName } from "../src/daemon/launcher.ts";
import type { Place } from "../src/shared/types.ts";

const SOCKET = `padd-test-${process.pid}`;
after(() => {
  try {
    execFileSync("tmux", ["-L", SOCKET, "kill-server"], { stdio: "ignore" });
  } catch {
    // no server left
  }
});

const until = async (check: () => boolean | Promise<boolean>, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("timed out");
};
const screen = (place: Place) => execFileSync("tmux", ["-L", SOCKET, "capture-pane", "-p", "-t", `=${tmuxName(place)}:`], { encoding: "utf8" });

/** A stand-in for claude: shows the prompts padd must handle, in order. */
async function fakeClaude(trust: boolean): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "padd-launch-"));
  const script = join(dir, "claude.sh");
  await writeFile(script, [
    trust ? 'echo "Yes, I trust this folder"; read _' : "",
    'echo "WARNING: Loading development channels"; read _',
    'echo "Channels (experimental) messages inject directly"; sleep 600',
  ].join("\n"));
  return script;
}

test("the window opens in Ghostty, or the terminal PADD_TERMINAL names", async () => {
  const bin = await mkdtemp(join(tmpdir(), "padd-bin-"));
  for (const name of ["ghostty", "kitty"]) {
    await writeFile(join(bin, name), "");
    await chmod(join(bin, name), 0o755);
  }
  const attach = ["tmux", "attach"];
  assert.deepEqual(terminalCommand({ PATH: bin }, "padd: a/b", attach), ["ghostty", "--title=padd: a/b", "-e", "tmux", "attach"]);
  assert.deepEqual(terminalCommand({ PATH: bin, PADD_TERMINAL: " kitty  --single-instance " }, "t", attach), ["kitty", "--single-instance", "tmux", "attach"]);
  assert.throws(() => terminalCommand({ PATH: bin, PADD_TERMINAL: "alacritty -e" }, "t", attach), /alacritty isn't installed.*padd attach/);
  assert.throws(() => terminalCommand({ PATH: "" }, "t", attach), /ghostty isn't installed/);
});

test("tmux names are safe for any place", () => {
  assert.equal(tmuxName({ project: "tofu", sub: "mood" }), "padd_tofu_mood");
  assert.equal(tmuxName({ project: "a.b", sub: "c:d" }), "padd_a-b_c-d");
});

test("start runs the command headless in tmux and answers the channel warning", async () => {
  const script = await fakeClaude(false);
  const windows: string[][] = [];
  const launcher = new Launcher({ socket: SOCKET, command: () => ["sh", script], terminal: (_t, argv) => void windows.push(argv) });
  const place = { project: "tofu", sub: "mood" };
  assert.equal(await launcher.running(place), false);
  assert.equal(await launcher.start(place, tmpdir()), "started");
  assert.equal(await launcher.running(place), true);
  await until(() => screen(place).includes("Channels (experimental)"));
  assert.equal(windows.length, 0); // headless
  // Starting again doesn't start a second copy of the same conversation.
  assert.equal(await launcher.start(place, tmpdir()), "running");
  // Showing it opens one window, attached to the session.
  assert.equal(await launcher.attached(place), false);
  assert.equal(await launcher.show(place), true);
  assert.deepEqual(windows[0], ["tmux", "-L", SOCKET, "attach", "-t", "=padd_tofu_mood"]);
});

test("the folder-trust prompt is left to the user, then the warning still gets its Enter", async () => {
  const script = await fakeClaude(true);
  const trusted: Place[] = [];
  const launcher = new Launcher({ socket: SOCKET, command: () => ["sh", script], terminal: () => {}, onTrust: (p) => void trusted.push(p) });
  const place = { project: "tofu", sub: "head" };
  await launcher.start(place, tmpdir());
  await until(() => trusted.length === 1);
  await new Promise((r) => setTimeout(r, 1000));
  assert.match(screen(place), /trust this folder/); // still waiting: padd didn't answer it
  assert.doesNotMatch(screen(place), /Loading development channels/);
  execFileSync("tmux", ["-L", SOCKET, "send-keys", "-t", `=${tmuxName(place)}:`, "Enter"]); // the user confirms
  await until(() => screen(place).includes("Channels (experimental)"));
});
