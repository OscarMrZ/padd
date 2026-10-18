# Learnings

Rules learned the hard way. Each entry exists because something **cost real time**. Read the
section for an area before working in it.

## How to use

- **Add an entry** once the fix is known, in the same commit as the fix or right after it.
- **Lead with the rule.** The heading is the imperative to follow; the story explains why.
- **Be concrete.** Commands, versions, the file where the fix lives.
- **Group by area:** Sessions, Network, UI.
- **Keep it true.** Fix or delete an entry that stops applying. Settled *choices* belong in
  [`decisions.md`](decisions.md).

```
### L-NNN · <Rule, as an imperative> · YYYY-MM-DD
- **What happened:** the symptom and what we wrongly assumed.
- **Rule:** what to do instead, and where the fix lives.
```

## Sessions

### L-001 · Expect one keypress before a dev channel loads · 2026-10-18
- **What happened:** `claude --dangerously-load-development-channels server:padd` (v2.1.302) stops
  on a full-screen "Loading development channels" warning, again on every `--resume`. Option 1 is
  preselected.
- **Rule:** run it in tmux and send `Enter` once that screen shows (`tmux capture-pane -p`).
  The MCP approval prompt is skipped by `"enabledMcpjsonServers": ["padd"]` in
  `.claude/settings.local.json`. The folder-trust prompt shows only for untrusted folders, and its
  default is **No**: never auto-answer it.

### L-002 · Detach Ghostty fully when opening it from a script · 2026-10-18
- **What happened:** `ghostty -e … &` from a script that then exits opened no window.
- **Rule:** start it with `setsid -f ghostty --title=… -e tmux -L padd attach -t <name>`.

### L-003 · Read the session id from the MCP server's environment · 2026-10-18
- **What happened:** we needed to link an MCP server to its session.
- **Rule:** Claude Code passes `CLAUDE_CODE_SESSION_ID` (equal to `--session-id`) and
  `CLAUDE_PROJECT_DIR` to MCP servers, and inherits custom variables like `PADD_SUBPROJECT`.

### L-005 · Put `--dangerously-load-development-channels` before other arguments · 2026-10-18
- **What happened:** `claude --session-id … --dangerously-load-development-channels server:padd "<prompt>"`
  exited at once: the flag takes a list and swallowed the prompt as a second channel
  ("entries must be tagged"). The session id was already linked, so the next start tried to
  resume a conversation that never existed.
- **Rule:** the flag goes first, then options, then the prompt (`src/cli.ts`, `claude`). Resume a
  linked session only if `~/.claude/projects/*/<id>.jsonl` exists.

### L-006 · Log user services to a file on this machine · 2026-10-18
- **What happened:** `journalctl --user -u padd` showed systemd's own lines but none of padd's
  output (journals are volatile here; other user services show nothing either).
- **Rule:** `StandardOutput=append:~/.local/state/padd/padd.log` (`src/service.ts`). Never print
  the token there: `padd serve` prints tablet links only to a terminal.

## Network

### L-004 · Open port 8788 in ufw, or the tablet can't connect · 2026-10-18
- **What happened:** ufw is active with `DEFAULT_INPUT_POLICY="DROP"`; nothing allowed 8788.
- **Rule:** `sudo ufw allow from 192.168.1.0/24 to any port 8788 proto tcp comment padd`.
