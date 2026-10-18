# Roadmap

Where PADD is and what comes next. Update it when a step lands.

1. ✅ **Ink on one board** (checked in headless Chromium; pen feel on the tablet pending). Pen with pressure, palm rejection, pan and pinch, eraser, undo; strokes
   saved as drawn; LAN with token.
2. ✅ **Projects and subprojects.** `padd init` installs a repo (`.padd/config.json`); the tablet
   picks project and subproject, creates subprojects, and shows a live filmstrip of every image.
3. ✅ **Send to Claude.** `padd mcp` is a channel: Send wakes the linked session with a snapshot
   (or waits until one connects); Claude answers with `reply` and puts images up with `show`.
   `padd claude <sub>` launches the session. Watched folders turn new renders into boards.
4. ✅ **Sessions from the tablet.** Start or resume a subproject's session in the background from
   the tablet; `padd sessions` and `padd attach` on the computer.
5. **Claude drives the review.** `show`, `ask_feedback`, `draw`, `note`, `reply`.
6. ✅ **Service.** `padd service install`: a systemd user unit that starts with the desktop session.

**Next step:** 5. Claude drives the review (`ask_feedback`, `draw`, `note`).
