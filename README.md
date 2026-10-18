# PADD

Draw feedback for Claude Code sessions from a tablet. Claude shows you images; you mark them up with
the pen; **Send to Claude** hands the marked-up image and your note to the session working on it,
and its reply comes back to the tablet. Drawing never prompts Claude, only Send does. Claude can
also put images up, draw on them, pin notes and ask you about part of an image.

PADD runs on your computer and serves any tablet browser on your LAN. It's a hobby project, built
for designing a robot ([`docs/roadmap.md`](docs/roadmap.md)); it works, but expect rough edges.

## Needs

- Linux with systemd (user services) and **tmux**: sessions run in the background in tmux.
- **Node ≥ 26** (it runs the TypeScript directly).
- **Claude Code ≥ 2.1.80**: Sends arrive through
  [channels](https://code.claude.com/docs/en/channels-reference), a research preview.
- Optional: **ImageMagick 7** (`magick`) for light filmstrip thumbnails; **Ghostty** or another
  terminal for "Show its window" (see [Settings](#settings)).

## Install

```sh
git clone https://github.com/OscarMrZ/padd && cd padd
npm install && npm link       # dependencies, the tablet UI, `padd` on your PATH
padd service install          # run PADD in the background on :8788, from login on
padd link                     # the links to open on the tablet (once; they carry the access token)
```

If the tablet can't connect, open port 8788 to your LAN, e.g. with ufw:
`sudo ufw allow from 192.168.1.0/24 to any port 8788 proto tcp comment padd` (use your subnet).

## Add it to a project

In any git repo you work on with Claude Code:

```sh
padd init                     # .padd/config.json, .padd/.gitignore, .mcp.json: commit all three
```

It also enables the `padd` MCP server in your personal `.claude/settings.local.json`. Images,
ink and session ids stay local in `.padd/data/` (gitignored).

A project holds **subprojects**, each with its own images and Claude session. Create them on the
tablet (tap the project name in the top bar), or in `.padd/config.json`:

```json
{
  "name": "tofu",
  "subprojects": [
    { "id": "mood", "title": "mood", "brief": "The look of the robot.", "watch": ["mood/renders"] }
  ]
}
```

`brief` is the first prompt of the subproject's session. `watch` lists repo folders whose new or
changed images show up on the tablet on their own.

## Use it

On the tablet:

- Open a subproject and tap **Claude away** to start its session in the background. The first
  time, Claude Code may ask at the computer whether you trust the folder: `padd attach` to answer.
- Draw with the pen; touch pans and pinches. The S Pen button toggles the eraser. **T** pins a
  text note. **Add image** takes a photo or picks images from the gallery.
- **Send to Claude** with an optional message. Claude's marks are lilac; yours are amber.

On the computer:

```sh
padd sessions                 # every subproject's session and its state
padd attach tofu/mood         # talk to it here (Ctrl-b d leaves it running in the background)
padd claude mood              # or run it in this terminal instead
padd watch mood mood/renders  # watch a folder (same as `watch` in the config)
padd board mood shot.png      # put one image up by hand
padd help                     # everything else
```

Every Claude session in the repo gets the `padd` tools (`show`, `reply`, `ask`, `draw`, `note`,
`link`, `status`). Only sessions padd starts (the tablet, `padd attach`, `padd claude`) receive
Sends: they need Claude Code's `--dangerously-load-development-channels server:padd` flag,
whose warning padd accepts for you.

## Security

- Anyone with the link (it carries the token) can draw, and Send text into your Claude sessions.
  Keep the link to yourself, and PADD to a network you trust: it's plain HTTP, so never expose
  port 8788 to the internet.
- `~/.config/padd/token` holds the token. To change it, delete the file, `systemctl --user restart
  padd`, and open the new `padd link` on the tablet.

## Settings

- **Terminal:** "Show its window" opens Ghostty. For another terminal, set `PADD_TERMINAL` to the
  command that runs a program in a new window, e.g. `kitty`, `alacritty -e` or
  `gnome-terminal --`: run `systemctl --user edit padd`, add `[Service]` and
  `Environment=PADD_TERMINAL=kitty`, then `systemctl --user restart padd`.
- **Port:** `padd serve --port <n>` (and `padd link --port <n>`); the service uses 8788.

## Develop

```sh
npm test && npm run check     # tests (they need tmux), types
npm run build && systemctl --user restart padd   # after a change; logs: journalctl --user -u padd -f
padd serve                    # or run it in a terminal (stop the service first)
```

- [`docs/roadmap.md`](docs/roadmap.md): where it is, what's next
- [`docs/decisions.md`](docs/decisions.md): what's settled, and why
- [`docs/learnings.md`](docs/learnings.md): things that took time to figure out

## License

[MIT](LICENSE)
