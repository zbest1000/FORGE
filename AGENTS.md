# Agent guidance

This repo is a Node 20+ Fastify + SQLite server with a no-build static SPA
client (see `README.md` and `docs/SERVER.md` for a feature overview).

## Skills

- **`.cursor/skills/runbook.md`** — Cloud agent starter runbook. Read this
  before running, testing, or modifying the codebase. It covers login,
  starting the app, run modes (the "feature flag" toggle between server and
  demo mode), capability/role bypass, env vars, and per-area test workflows
  (server routes, audit ledger, SPA, i3X, MQTT bridge, search, Docker).
- **`.claude/skills/enterprise-ux-audit/SKILL.md`** — Enterprise UI/UX audit
  skill. Use it when reviewing FORGE's information architecture, product
  experience, accessibility, design system, or frontend component direction.
  The baseline report lives at `docs/ENTERPRISE_UX_REDESIGN_AUDIT.md`.

When you discover new testing tricks or runbook knowledge, update
`.cursor/skills/runbook.md` in the same PR — see its **Updating this skill**
section.

## Testing expectations

- `npm test` runs the Node test runner against `test/**/*.test.js`. Run it
  for any change touching `server/` or `src/core/audit.js`.
- For UI-visible changes (`index.html`, `styles.css`, `src/screens/*`,
  `src/shell/*`), perform manual GUI testing against `npm start` on
  `http://localhost:3000` and capture a video walkthrough.
- For server-only API changes, `curl` against the running server is
  sufficient evidence; include the request/response in the walkthrough.
