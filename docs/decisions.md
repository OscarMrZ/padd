# Decisions

Design choices that are **settled**. Read this before re-opening one. If a choice here looks
wrong, say so and propose a new entry instead of quietly working around it.

## How to use

- **Add an entry** when a choice is made that later work depends on and that would be expensive
  to reverse. Small local choices don't belong here.
- **Commit the entry with the change** it enables.
- **Never rewrite history.** To change a decision, add a new entry and mark the old one
  `Superseded by D-NNN`.
- **Keep entries short.** Four lines, and the **Why** carries the most weight.

```
## D-NNN · Title · YYYY-MM-DD
- **Decision:** what we do.
- **Why:** the reason(s) that settled it.
- **Rejected:** alternatives and the one-line reason against each.
```

## D-001 · Our own web app on the PC, served to the tablet's browser · 2026-10-18
- **Decision:** PADD is a local web app reached from the tablet's browser over the LAN.
- **Why:** works with any tablet; runs where the repos and Claude sessions are; no cloud in between.
- **Rejected:** Samsung Notes sync (no API, no Linux client); a claude.ai artifact (the user wants
  it local); existing tools like Trayce or FigJam (no project/subproject/session model).

## D-002 · Claude Code channels carry Send into a session · 2026-10-18
- **Decision:** each session runs the `padd` MCP server, which is a channel: Send becomes a
  `notifications/claude/channel` event in that session. Claude talks back through MCP tools.
- **Why:** wakes an idle interactive session the user can also watch and type into.
- **Rejected:** `claude -p --resume` per Send (no live terminal, clashes with an open session);
  hooks (only fire when the user prompts).

## D-003 · Sessions run in tmux, shown in a Ghostty window · 2026-10-18 · Superseded by D-010
- **Decision:** PADD starts `claude` in a detached tmux session (socket `-L padd`), answers the
  dev-channel warning with `send-keys`, then opens Ghostty attached to it.
- **Why:** the warning needs a keypress (L-001); tmux keeps the session alive when the window
  closes; the user wanted Ghostty windows.
- **Rejected:** Ghostty alone (nothing can answer the warning).

## D-004 · TypeScript on Node, no framework · 2026-10-18
- **Decision:** server, MCP server and UI in TypeScript; Node ≥ 26 runs it directly; the UI is
  compiled by `tsc`; no framework or bundler.
- **Why:** the channel API is documented for the TypeScript MCP SDK; one language and shared types
  from server to tablet.
- **Rejected:** Python (custom channel notifications undocumented in its SDK); Rust (heavy for a
  web app plus MCP server).

## D-005 · Config committed in the repo, data local · 2026-10-18
- **Decision:** a repo gets `.padd/config.json`, `.padd/.gitignore` and a `padd` entry in
  `.mcp.json`, all committed; boards, strokes, snapshots and session ids live in `.padd/data/`,
  which `.padd/.gitignore` keeps out of git (the repo's own `.gitignore` is untouched).
- **Why:** subprojects are part of the project; images and session ids are generated and machine-local.
- **Rejected:** committing everything (binaries pile up in git).

## D-006 · Every request carries a token · 2026-10-18
- **Decision:** a random token in `~/.config/padd/token`; the tablet presents it once as `?token=`
  and then as an HttpOnly cookie; scripts use `Authorization: Bearer`.
- **Why:** PADD listens on the LAN, and Send puts text in front of a Claude session: an open port
  would be a prompt-injection path.
- **Rejected:** trusting the LAN; loopback-only plus a tunnel (the user wants direct LAN access).

## D-007 · A re-rendered image is a new board · 2026-10-18
- **Decision:** a watched folder's new or changed image becomes a new board; an image whose bytes
  match an existing board (SHA-1) is skipped. `show` of a known image brings its board forward.
- **Why:** ink belongs to the pixels it was drawn on; renders change fast and the history of
  versions is what the filmstrip is for.
- **Rejected:** replacing the image in place (old marks would sit on a new picture).

## D-008 · Repos call `padd` from the PATH · 2026-10-18
- **Decision:** `.mcp.json` runs `padd mcp`; `npm link` in this repo puts `padd` on the PATH.
- **Why:** the committed `.mcp.json` stays free of machine paths.
- **Rejected:** an absolute path to `src/cli.ts` (breaks on any other machine or checkout).

## D-009 · PADD runs as a systemd user service in the desktop session · 2026-10-18
- **Decision:** `padd service install` writes `padd.service`, wanted by `graphical-session.target`,
  restarting on failure, logging to the journal as `padd` (`journalctl --user -u padd`).
- **Why:** no terminal to keep open; the desktop session's environment (`WAYLAND_DISPLAY`, PATH
  with mise shims) is what padd needs to open Ghostty windows for sessions.
- **Rejected:** `default.target` (may start before the compositor exports Wayland); lingering at
  boot (nothing to review before logging in).

## D-010 · Sessions start headless; you attach when you want to talk · 2026-10-18
- **Decision:** a session started from the tablet runs `padd claude <sub>` in padd's tmux
  (`-L padd`), in its own systemd scope, with no window. `padd attach <project>/<sub>` opens it in
  any terminal (starting it first if stopped); the tablet can also open a Ghostty window on it.
  `padd sessions` lists them all.
- **Why:** the user wants sessions working in the background and talks to them mostly from the
  tablet; a window per session clutters the desktop. tmux keeps them alive across closed windows
  and padd restarts (L-007).
- **Rejected:** a Ghostty window per session (D-003); `claude -p` per Send (no live session to
  attach to).

## D-011 · Claude places marks in fractions of the image · 2026-10-18
- **Decision:** `ask`, `draw` and `note` take positions as fractions (0 to 1) of the image; padd
  turns them into pixels from the size in the image's header. Claude's marks are lilac, the
  user's amber.
- **Why:** Claude estimates positions from the image it Read and never knows pixel sizes;
  fractions hold for any render size.
- **Rejected:** pixels (Claude would need the size first, and guesses badly); boxes from an
  object detector (a dependency for a guess Claude makes well enough).
