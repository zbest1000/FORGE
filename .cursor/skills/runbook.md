# FORGE Cloud Agent Runbook

Minimal starter skill for Cursor Cloud agents working on this repo. Read the
section that matches the area you're touching, run the matching test workflow,
and append new tricks to the **Updating this skill** section at the bottom.

If this is your first time in the repo, read **Quick start** and
**Run modes & "feature flag"** first.

---

## Quick start

```bash
node --version          # require >=20 (engines field in package.json)
npm install             # installs better-sqlite3 native binding (needs python3, make, g++)
npm run build           # optional production SPA bundle in ./dist/
npm run seed            # creates ./data/forge.db and demo users (idempotent)
npm start               # Fastify on http://localhost:3000
```

Demo users (password `forge` for all of them) are printed by `npm run seed`.
The default account for almost everything is:

```
admin@forge.local / forge      # Organization Owner — bypasses every capability gate
```

Useful endpoints once the server is up:

- `GET  http://localhost:3000/api/health` — liveness + schema version
- `POST http://localhost:3000/api/auth/login` — `{ email, password }` → `{ token, user }`
- `GET  http://localhost:3000/` — SPA client (same origin as the API)

When you finish, leave the server running so the user can keep poking at it
unless your test specifically needs a clean restart.

---

## Run modes & "feature flag" toggle

There is no formal feature-flag system. Behaviour switches on **how the client
is served**:

| Mode | How to start | What runs |
|---|---|---|
| **Server mode** (recommended) | `npm start` (or `npm run dev` for `--watch`) | Fastify + SQLite + SPA on `:3000`. If `dist/index.html` exists, Fastify serves the Vite production bundle; otherwise it serves source modules from the repo root. Client probes `/api/health`, sees a 200, and uses the real backend. |
| **Vite dev mode** | `npm run dev:client -- --host 0.0.0.0` | Vite serves the SPA on `:5173`; run `npm start` separately if you want server APIs. |
| **Demo mode** (client only) | `python3 -m http.server 8080` from repo root or `npm run dev:client` without the server | SPA only. `/api/health` 404s, `src/core/api.js` flips `_mode = "demo"`, all data lives in `localStorage`. |

How the toggle actually works (`src/core/api.js`, `app.js:147`):

- `probe()` does `fetch("/api/health")`. 200 → `mode() === "server"`. Anything
  else → `mode() === "demo"`.
- To **force demo mode while a server is running**, open the SPA from a
  different origin (e.g. the python http.server on `:8080` while Fastify is on
  `:3000`) — same-origin probe will fail.
- To **clear demo state**, in the browser DevTools console:
  `localStorage.clear()` then reload. The header's "Reset" button does the
  same thing for the seed.

### Role / permission gating

Roles are not auth claims in demo mode — they're a UI dropdown that flips
`state.ui.role`. The capability matrix lives in `src/core/permissions.js`.

To bypass capability gates while testing:

- **In the SPA**: use the role switcher in the header, pick `Organization Owner`.
- **Programmatically (DevTools)**:
  ```js
  // Same module instance the app uses (ESM modules are cached):
  const { state } = await import("./src/core/store.js");
  state.ui.role = "Organization Owner";
  // Trigger a re-render:
  (await import("./src/core/store.js")).notify?.();
  // Or just reload — role is persisted via the header role switcher.
  ```
  `window.forge` (set in `app.js`) exposes `{ mode, login, logout, api }` for
  quick API calls in server mode.
- **In server mode**: log in as `admin@forge.local`. The JWT carries the role;
  `server/auth.js` `CAPABILITIES["Organization Owner"] = ["*"]`.

### Required env vars

All optional for local dev — defaults in `server/main.js` and `server/db.js`
are sane. See `.env.example` for the full list. Most relevant:

| Var | When to set |
|---|---|
| `FORGE_JWT_SECRET` | Production. Dev defaults to `forge-dev-jwt-secret-please-rotate`. |
| `FORGE_TENANT_KEY` | Required if exercising audit pack signatures. Tests set this themselves. |
| `FORGE_DATA_DIR` | Point at a tmp dir to avoid clobbering `./data/forge.db` (the test suite already does this). |
| `FORGE_MQTT_URL` | Set to enable the MQTT bridge. Leave unset to keep tests fast. |
| `PORT`, `HOST` | Override port for parallel runs. |
| `LOG_LEVEL` | `debug` to see route logs while reproducing a bug. |

---

## By area

Each area lists: where the code lives, how to exercise it, and how to
verify a change.

### 1. Server — Fastify routes & SQLite (`server/`)

Code: `server/main.js`, `server/routes/{auth,core,i3x}.js`, `server/db.js`,
`server/auth.js`, `server/audit.js`, `server/sse.js`, `server/events.js`.

**Test workflow:**

```bash
# Use a throwaway DB so you don't touch ./data/forge.db.
export FORGE_DATA_DIR=$(mktemp -d)
export FORGE_TENANT_KEY=test-key

npm run seed
npm start &                              # or use a tmux session
SERVER_PID=$!
sleep 1

curl -s localhost:3000/api/health | jq .
TOKEN=$(curl -s -XPOST localhost:3000/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"admin@forge.local","password":"forge"}' | jq -r .token)
curl -s -H "Authorization: Bearer $TOKEN" localhost:3000/api/me | jq .

kill $SERVER_PID
```

Migrations run on boot from `server/db.js`. To reset the schema, delete the
DB file: `rm -rf "$FORGE_DATA_DIR"`. `npm run migrate` runs migrations only.

### 2. Audit ledger (`server/audit.js`, `test/audit-chain.test.js`)

The only existing automated test. Verifies the SHA-256 hash chain, tamper
detection, and HMAC-signed audit packs.

```bash
npm test
# → runs node --test on test/**/*.test.js
```

When changing audit code, also exercise it from the SPA: the header's
**Reset** button + any object mutation appends entries; `__forgeSelfTest()`
in DevTools verifies the in-browser ledger.

### 2.5 Hub, portals, view modes & groups (`src/core/groups.js`, `src/screens/hub.js`)

The default route is now `#/hub` (the FORGE Hub launcher). Each tile opens
in a new browser tab via `target="_blank"` with `?portal=<id>` appended to
the hash. In the new tab, `app.js:applyPortalFromUrl()` reads that query
and sets `state.ui.portalId`, which triggers:

- `body.portal-mode.portal-<id>` classes (CSS accent stripe + chip color).
- `src/shell/rail.js` filters its nav list to the portal's `items`.
- The header shows a portal chip and tints with the portal's `accent`.

Hierarchical group gating lives in `src/core/groups.js`:

```js
import { canAccessRoute, canSeePortal, canSeeAsset, currentUserId,
         effectiveGroupIds, isOrgOwner } from "./src/core/groups.js";
canAccessRoute("/admin");        // false unless in G-it (or Org Owner)
effectiveGroupIds("U-1");         // includes ancestors via parentId chain
```

To test gates from a specific user without logging in:

1. Navigate to `#/admin` and scroll to **Groups & memberships**.
2. Use the **Demo identity** dropdown to "become" any seed user.
3. The role dropdown in the header still overrides via `state.ui.role`,
   and `Organization Owner` bypasses every gate.

To force portal mode from the URL bar:

```
http://localhost:3000/#/home?portal=automation
http://localhost:3000/#/admin?portal=admin
```

View customization (in the header **View ▾** menu) writes
`state.ui.{showRail, showLeftPanel, showContextPanel, showHeader,
focusMode, dockVisible}`. These are persisted in `localStorage` via
`store.js#persist`. The floating "⛶" button at bottom-left is the escape
hatch when chrome is fully hidden.

### 3. Browser SPA — shell, screens, store (`app.js`, `src/`)

No build step. Edit a file, hard-reload the page. Modules are served directly
from disk by either `npm start` or `python3 -m http.server` when `dist/` is
absent. For production-style validation, run `npm run build` first; then
`npm start` serves the hashed Vite bundle from `dist/`.

**Smoke test in DevTools:**

```js
await window.__forgeSelfTest()           // returns table of pass/fail checks
forge.mode()                             // "server" | "demo"
location.hash = "#/home"                 // routes are hash-based
```

Routes are registered in `app.js:setupRoutes()`. State changes flow through
`src/core/store.js` (a tiny pub/sub) — every mutation re-renders the shell
and the current screen.

Demo-only operational values and canned narratives belong in
`src/core/simulation.js`, not inside screen renderers. Use that module for
simulated signal series, AI/demo summaries, generated demo IDs, and similar
placeholder behavior so real integrations can replace the simulation seam.

**For UI-touching changes you MUST do GUI testing.** Start the server, point
the `computerUse` subagent at `http://localhost:3000`, log in as
`admin@forge.local`, and walk the affected route. Capture a video.

### 4. i3X / Unified Namespace (`src/core/i3x/`, `server/routes/i3x.js`)

Mounted twice with identical envelopes:

- In-process (browser): `src/core/i3x/server.js` + `client.js`. Exercised at
  `#/i3x` (API explorer) and `#/uns` (browser).
- HTTP (server): same shapes under `/v1/*` (e.g. `/v1/info`,
  `/v1/objects/list`, `/v1/subscriptions/stream`).

**Quick check (server mode):**

```bash
curl -s localhost:3000/v1/info | jq .
curl -s localhost:3000/v1/namespaces | jq .
curl -s "localhost:3000/v1/objects?root=true&limit=3" | jq .
# /v1/objects/list returns []  unless you POST criteria — use ?root=true to
# get the ISA-95 root nodes seeded from the SQLite assets table.
```

For UI changes, open `#/i3x`, pick an endpoint, hit Send, and confirm the
response envelope matches `SuccessResponse` / `BulkResponse`. The UNS sparkline
ticks every 1.5 s — if it freezes, the in-process ticker (`server.js`) broke.

### 5. MQTT bridge (`server/connectors/mqtt.js`)

Disabled by default. Two ways to mock/exercise:

- **Real broker (docker compose):**
  ```bash
  docker compose up -d mosquitto
  FORGE_MQTT_URL=mqtt://localhost:1883 FORGE_MQTT_TOPICS='forge/#' npm start
  # In another shell:
  docker run --rm --network host eclipse-mosquitto:2 \
    mosquitto_pub -t forge/test -m '{"value":42}'
  curl -s localhost:3000/api/events | jq '.[0]'
  ```
- **Skip the broker entirely:** call `POST /api/events/ingest` directly with
  the same payload shape. The MQTT bridge is a thin adapter over `events.js`
  `ingest()`, so route-level testing exercises the same code.

If you don't need the bridge for your change, leave `FORGE_MQTT_URL` unset —
`server/main.js` logs `MQTT bridge disabled` and skips the connector.

### 6. Search (FTS5 + MiniSearch)

Server side: SQLite FTS5 virtual tables (`fts_docs`, `fts_messages`,
`fts_workitems`, `fts_assets`) populated by `npm run seed`. Test with:

```bash
curl -s "localhost:3000/api/search?q=valve" | jq .
```

Client side: `src/core/search.js` builds a MiniSearch index lazily from the
seed; `__forgeSelfTest()` asserts BM25 hits exist.

### 7. Docker / deployment (`Dockerfile`, `docker-compose.yml`)

```bash
docker compose build forge
docker compose up -d
docker compose run --rm forge node server/seed.js
curl -s localhost:3000/api/health | jq .
docker compose down
```

The image's `HEALTHCHECK` hits `/api/health`; if it never goes healthy, exec
in and check `LOG_LEVEL=debug` output.

---

## Common pitfalls

- **`better-sqlite3` install fails**: needs `python3 make g++`. The Dockerfile
  installs them in the builder stage; on a fresh VM run
  `apt-get install -y python3 make g++` before `npm install`.
- **Port 3000 already in use**: another agent left a server running. Find the
  PID with `lsof -ti:3000` and kill it with `kill <PID>` (never `pkill -f`).
- **Stale demo state**: `localStorage.clear()` in DevTools, or click the
  header "Reset" button.
- **Stale DB**: `rm -rf data/ && npm run seed`. Or use a temp `FORGE_DATA_DIR`.
- **Tests fail with "no such table"**: the test skipped a migration; clear
  the temp dir from the previous run.
- **CDN-loaded modules (esm.sh) blocked**: `index.html`'s import map fails
  gracefully — hand-rolled fallbacks in `src/core/*` take over. If a feature
  silently degrades, that's why.
- **CORS in dev**: `FORGE_CORS_ORIGIN` defaults to permissive; don't set it
  unless you're reproducing a CORS bug.

---

## Updating this skill

This file is a starter. Whenever you discover a non-obvious testing trick,
env-var requirement, mocking pattern, or repro recipe, add it here so the
next Cloud agent doesn't have to rediscover it.

**When to update:**

- You spent more than a few minutes figuring out an environment quirk
  (install, port, secret, fixture).
- You found a fast way to reproduce a class of bug.
- You added a new code area, route family, or connector that needs its own
  test workflow.
- An assumption in this file turned out to be wrong — fix it in place rather
  than working around it.

**How to update:**

1. Pick the closest existing section under **By area** or **Common
   pitfalls**, or add a new numbered area if none fits.
2. Keep entries concrete: exact commands, exact file paths, exact env vars.
   No prose-only tips.
3. If a tip only applies to one role / mode / OS, say so on the same line.
4. Commit the change with the substantive change it came from. Don't batch
   skill edits across unrelated PRs.
5. If a tip becomes obsolete (e.g. a workaround is no longer needed because
   the underlying bug was fixed), delete it instead of leaving stale advice.
