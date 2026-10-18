# Roadmap

Where PADD is and what comes next. Update it when a step lands.

1. ✅ **Ink on one board** (checked in headless Chromium; pen feel on the tablet pending). Pen with pressure, palm rejection, pan and pinch, eraser, undo; strokes
   saved as drawn; LAN with token.
2. **Projects and subprojects.** `padd init` installs a repo (`.padd/config.json`, `.mcp.json`);
   the tablet picks project and subproject.
3. **Send to Claude.** `padd` MCP server as a channel: Send wakes the linked session with a snapshot.
4. **Sessions from the tablet.** New subproject spawns a session in Ghostty; resume offline ones.
5. **Claude drives the review.** `show`, `ask_feedback`, `draw`, `note`, `reply`.
6. **Service.** `padd serve` as a systemd user unit.

**Next step:** 2. Projects and subprojects.
