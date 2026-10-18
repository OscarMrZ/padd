# PADD

Draw feedback for Claude Code sessions from a tablet. Claude shows you images; you mark them up with
the pen; **Send to Claude** hands the marked-up image and your note to the session working on it,
and its reply comes back to the tablet. Drawing never prompts Claude, only Send does.

Runs on your computer and serves the tablet over the LAN. Status and next steps:
[`docs/roadmap.md`](docs/roadmap.md).

## Run

Needs Node ≥ 26.

```sh
npm install && npm run build && npm link   # dependencies, tablet UI, `padd` on your PATH
padd service install                       # run PADD in the background on :8788, from login on
padd link                                  # the tablet links (they carry the access token)
npm test && npm run check                  # tests, types
```

After changing PADD: `npm run build && systemctl --user restart padd`. Logs:
`journalctl --user -u padd -f`. `padd serve` runs it in a terminal instead (stop the service first).

```sh
In a repo:

```sh
padd init                     # make it a project: .padd/config.json, .mcp.json (commit both)
padd claude mood              # start or resume the "mood" session, wired to the tablet
padd watch mood mood/renders  # images saved there show up on the tablet on their own
padd board mood shot.png      # show one image by hand
```

Subprojects are created on the tablet (tap the project name in the top bar) or by Claude's
`link` tool. A session gets the `padd` tools in any case (`show`, `reply`, `link`, `status`); it
receives your Sends only when started with `padd claude` (Claude Code needs its channel flag).

If the tablet can't connect, open the port to your LAN (ufw example):
`sudo ufw allow from 192.168.1.0/24 to any port 8788 proto tcp comment padd`.

## Where to look

- [`docs/roadmap.md`](docs/roadmap.md): where we are, what's next
- [`docs/decisions.md`](docs/decisions.md): what's settled, and why
- [`docs/learnings.md`](docs/learnings.md): things that took time to figure out
