# FORGE Server

FORGE ships as a **self-hostable server** plus a browser client. The server is
a Node.js 20+ process backed by SQLite; it exposes the full HTTP API that the
spec describes (§1.1 self-hostable, §13 RBAC/ABAC, §9 event pipeline, §13.2
tamper-evident audit, i3X on `/v1`), and serves the SPA client from the same
origin.

## Run modes

| Mode | Command | What runs |
|---|---|---|
| Demo (no backend) | `python3 -m http.server 8080` | Client only — everything is in-browser |
| Dev (with server) | `npm run seed && npm run dev` | Fastify + SQLite, live reload |
| Production | `npm start` (or `docker compose up -d`) | Fastify + SQLite + optional MQTT bridge |

## Endpoints

Base: `/api` (FORGE) and `/v1` (CESMII i3X 1.0-Beta).

### Auth
| Method | Path | Notes |
|---|---|---|
| POST | `/api/auth/login` | `{ email, password }` → `{ token, user }` |
| POST | `/api/auth/logout` | |
| GET  | `/api/me` | JWT-gated; returns user + capabilities |

### Collaboration / Records
| Method | Path |
|---|---|
| GET  | `/api/team-spaces`, `/api/team-spaces/:id` |
| GET  | `/api/projects?teamSpaceId=` |
| GET  | `/api/channels?teamSpaceId=` |
| GET  | `/api/channels/:id/messages?limit=` |
| POST | `/api/channels/:id/messages` |
| GET  | `/api/documents`, `/api/documents/:id` |
| GET  | `/api/revisions/:id` |
| POST | `/api/revisions/:id/transition` (`{ to, notes }`) — auto-supersede on IFC |
| GET  | `/api/assets` |
| GET  | `/api/work-items?projectId=` |
| POST | `/api/work-items` |
| PATCH| `/api/work-items/:id` |
| GET  | `/api/incidents` |
| POST | `/api/incidents/:id/entry` |
| GET  | `/api/approvals` |
| POST | `/api/approvals/:id/decide` (`{ outcome, notes }`) — HMAC-SHA256 signed |

### Search / Events / Audit
| Method | Path |
|---|---|
| GET  | `/api/search?q=` — SQLite FTS5 over docs, messages, work items, assets |
| GET  | `/api/events` — recent normalized envelopes |
| POST | `/api/events/ingest` — REST event ingress |
| GET  | `/api/dlq` |
| POST | `/api/dlq/:id/replay` |
| GET  | `/api/audit` — hash-chained ledger |
| GET  | `/api/audit/verify` — walk + verify chain |
| GET  | `/api/audit/export?since=&until=` — HMAC-SHA256 signed audit pack |
| GET  | `/api/events/stream` — SSE firehose |

### i3X (CESMII 1.0-Beta)
Identical envelope/VQT shapes as the spec and as the browser engine. All 20+ endpoints are mounted under `/v1` — `/info`, `/namespaces`, `/objecttypes`, `/relationshiptypes`, `/objects(/list|/related|/value|/history)`, `/objects/:id/history`, `/objects/:id/value`, `/subscriptions(/register|/unregister|/sync|/list|/delete|/stream)`.

### Health
`GET /api/health` → `{ status, version, schema_version, uptime_s, ts }`

## Authentication and authorization

- **JWT bearer tokens** (HS256, 12h expiry). `@fastify/jwt` handles signing; configure `FORGE_JWT_SECRET` in production.
- **Role → capability** mapping lives in `server/auth.js`. The same role matrix is used by the client for UI gating.
- **ABAC attributes** (site, discipline, clearance) live in the `users.abac` JSON column and can be layered on top of role checks (next iteration).

## Security

- **Tamper-evident audit log**: SHA-256 hash chain in the `audit_log` table; `verify_ledger()` walks the chain.
- **Signed approval decisions and audit packs**: HMAC-SHA256 over canonical JSON. `FORGE_TENANT_KEY` provides key material; `FORGE_TENANT_KEY_ID` labels it for rotation.
- **Password hashing**: bcrypt with cost 10.
- **CORS**: configurable via `FORGE_CORS_ORIGIN`; defaults to permissive for local dev.
- **Trust proxy**: enabled so the server behind nginx/traefik sees real client IPs.

## Data model

Core tables in `server/db.js`:
- `organizations`, `workspaces`, `users`
- `team_spaces`, `projects`, `channels`, `messages`
- `documents`, `revisions`, `drawings`, `markups`, `comments`, `transmittals`
- `assets`, `data_sources`, `integrations`, `events`, `dead_letters`
- `work_items`, `incidents`, `approvals`, `files`
- `subscriptions`, `notifications`, `saved_searches`, `retention_policies`, `ai_log`
- `audit_log` (hash-chained)
- FTS5 virtual tables: `fts_docs`, `fts_messages`, `fts_workitems`, `fts_assets`

`PRAGMA journal_mode=WAL` is on so readers don't block writers. A `--migrate-only` flag on `server/db.js` is useful for container ops.

## Integrations

- **MQTT bridge** (`server/connectors/mqtt.js`): optional. Set `FORGE_MQTT_URL` and FORGE subscribes and routes inbound messages through the canonical event envelope and rule engine. Works with any MQTT 3.1.1/5 broker (EMQX, HiveMQ, Mosquitto).
- **OPC UA**: `node-opcua` is listed as an optional dependency so installs stay fast; a bridge can be added as a sibling module when target endpoints exist.
- **REST webhooks**: `POST /api/events/ingest` accepts any external source.

## Deployment

### Docker

```bash
docker compose up -d
docker compose run --rm forge node server/seed.js
open http://localhost:3000
# admin@forge.local / forge
```

The compose file brings up a Mosquitto broker as a convenient sibling for MQTT development. Remove it for production and point `FORGE_MQTT_URL` at your real broker.

### Bare metal / VM

```bash
npm install --omit=dev
npm run seed           # once
FORGE_JWT_SECRET=$(openssl rand -hex 32) \
FORGE_TENANT_KEY=$(openssl rand -hex 32) \
npm start
```

Put it behind nginx / traefik with TLS termination. Mount `./data` to a durable volume (SQLite WAL + `*.db`).

## Observability

- `pino` structured JSON logs (`LOG_LEVEL=info` by default).
- `/api/health` is the probe endpoint.
- Every request gets a `trace_id` propagated through event envelopes and audit entries.

## Testing

```bash
npm test
```

Tests (see `test/audit-chain.test.js`) verify the hash chain appends correctly, tampers are detected, audit packs export and verify, and pack mutations break verification.

## Migrations

The `server/db.js` module runs migrations on boot from `SCHEMA_VERSION`. Append
new versions inside the `migrate()` function; keep each version idempotent.

## Roadmap toward Postgres

All SQL in `server/` is portable **except** the FTS5 virtual tables. A
Postgres adapter would swap `better-sqlite3` for `pg` and replace FTS5 with
Postgres `tsvector` + `@@` / `ts_rank` (or OpenSearch). The route layer is
untouched.
