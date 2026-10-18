# PADD

Draw feedback for Claude Code sessions from a tablet. Claude shows you images; you mark them up with
the pen and write notes; **Send** hands it all to the session working on it. Drawing never prompts
Claude, only Send does.

Runs on your computer and serves the tablet over the LAN. Status and next steps:
[`docs/roadmap.md`](docs/roadmap.md).

## Run

Needs Node ≥ 26.

```sh
npm install && npm run build      # dependencies, then compile the tablet UI
node src/cli.ts serve             # serve on :8788 (leave it running)
node src/cli.ts link              # print the tablet links (they carry the access token)

cd ~/Projects/tofu                # in any repo:
node ~/Projects/padd/src/cli.ts init                        # make it a padd project
node ~/Projects/padd/src/cli.ts board mood renders/*.png    # show images in subproject "mood"

npm test && npm run check         # tests, types
```

`npm link` puts `padd` on your PATH instead of `node …/src/cli.ts`. Subprojects are created on the
tablet (the project name in the top bar).

If the tablet can't connect, open the port to your LAN (ufw example):
`sudo ufw allow from 192.168.1.0/24 to any port 8788 proto tcp comment padd`.

## Where to look

- [`docs/roadmap.md`](docs/roadmap.md): where we are, what's next
- [`docs/decisions.md`](docs/decisions.md): what's settled, and why
- [`docs/learnings.md`](docs/learnings.md): things that took time to figure out
