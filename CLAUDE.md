# Working on PADD

PADD is a tablet web app for drawing feedback to Claude Code sessions. It is built
**iteratively**: [`docs/roadmap.md`](docs/roadmap.md) says where we are, and
[`docs/decisions.md`](docs/decisions.md) says what's settled.

## How we work

- **Small, verifiable iterations.** One concern per change. Finish and verify a step before the next.
- **Keep the user in the loop.** Say what you'll do before a non-trivial step; report after it.
- **Don't over-engineer.** No framework, bundler or dependency until something real needs it.
- **Short docs.** A bullet, not a paragraph. Each fact lives in one page; others link to it.
- **Security matters.** PADD listens on the LAN and its Send puts text in front of a Claude session:
  every route checks the token, and every input is validated on the server.

## Code

- TypeScript run directly by Node (type stripping): erasable syntax only (no enums, no parameter
  properties), relative imports end in `.ts`.
- `src/daemon/` server side, `src/shared/` pure code used by the server and the UI, `ui/` the tablet
  UI compiled by `tsc -p ui` to `dist/web/` (never committed).
- `npm test` (node:test) and `npm run check` (tsc) pass before every commit.

## Git

- Conventional Commits: `feat(ui): …`, `fix(daemon): …`, `docs: …`, `chore: …`. Scopes: `daemon`,
  `ui`, `mcp`, `cli`.
- Small, atomic commits after each verified step. Local only: don't push or add remotes unless asked.
