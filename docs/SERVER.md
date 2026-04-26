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

### Enterprise integration & compliance
| Method | Path | Notes |
|---|---|---|
| GET/POST/PATCH | `/api/enterprise-systems` | Typed registry for ERP, MES, CMMS/EAM, EDMS/DMS, historian, identity, and compliance platforms. Secrets are references only (`secret_ref`) and are never returned. |
| POST | `/api/enterprise-systems/:id/test` | Audited dry-run connector test; records a connector run. |
| POST | `/api/enterprise-systems/:id/sync` | Queues/records an integration sync run. |
| GET | `/api/enterprise-systems/:id/runs` | Connector run history. |
| GET/POST | `/api/external-links` | Maps external records to FORGE object ids. |
| GET/POST | `/api/compliance/processing-activities` | GDPR/ROPA processing records. |
| GET/POST | `/api/compliance/dsar` | Data subject requests. |
| GET | `/api/compliance/dsar/:id/export` | JSON DSAR bundle for a subject user. |
| GET/POST/PATCH | `/api/compliance/legal-holds` | eDiscovery/legal hold tracking. |
| GET/POST | `/api/compliance/evidence` | SOC 2 / ISO 27001 / NIS2 / DORA evidence records. |
| GET/POST/PATCH | `/api/compliance/subprocessors` | Vendor/subprocessor risk register. |
| GET/POST/PATCH | `/api/compliance/risks` | Cross-framework risk register. |
| GET/POST | `/api/compliance/ai-systems` | EU AI Act / ISO 42001-oriented AI system inventory. |
| POST | `/api/compliance/incidents/:id/regulatory-report` | Draft regulatory incident report with deadlines. |

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

### Files
| Method | Path |
|---|---|
| POST | `/api/files` — multipart upload (`file`, `parent_kind`, `parent_id`) |
| GET  | `/api/files?parent_kind=&parent_id=` — list |
| GET  | `/api/files/:id` — download (honors parent ACL; `X-Content-SHA256` header) |
| DELETE | `/api/files/:id` — soft delete |

Content is stored on disk under `<FORGE_DATA_DIR>/files/<sha256[:2]>/<sha256>` with dedupe; metadata lives in SQLite.

### API tokens
| Method | Path |
|---|---|
| GET  | `/api/tokens` — list own tokens |
| POST | `/api/tokens` — issue (plaintext returned once; server stores SHA-256) |
| DELETE | `/api/tokens/:id` — revoke |

API tokens are long-lived machine bearer credentials (`fgt_…`). They are accepted on every `Authorization: Bearer …` header alongside JWTs; the server tries the token format first and falls through to JWT verification.

### Webhooks
| Method | Path |
|---|---|
| GET  | `/api/webhooks` |
| POST | `/api/webhooks` — returns the signing `secret` exactly once |
| PATCH | `/api/webhooks/:id` — toggle enabled |
| DELETE | `/api/webhooks/:id` |

Outbound deliveries carry `X-FORGE-Signature: sha256=<hex>`, `X-FORGE-Event`, and `X-FORGE-Delivery` headers. The rule engine fans events out after they pass dedupe and routing.

### Metrics
| Method | Path |
|---|---|
| GET  | `/metrics` — Prometheus text format (`forge_up`, `forge_audit_ledger_entries`, `forge_events_total`, `forge_http_requests_total`, `forge_http_request_seconds_bucket`) |

### Health
`GET /api/health` → `{ status, version, schema_version, uptime_s, ts }`

### i3X (CESMII 1.0-Beta)
Identical envelope/VQT shapes as the spec and as the browser engine. All 20+ endpoints are mounted under `/v1` — `/info`, `/namespaces`, `/objecttypes`, `/relationshiptypes`, `/objects(/list|/related|/value|/history)`, `/objects/:id/history`, `/objects/:id/value`, `/subscriptions(/register|/unregister|/sync|/list|/delete|/stream)`.

### GraphQL
`POST /graphql` — Mercurius. Read across the whole object graph in one
round-trip; mutate with `createWorkItem`, `updateWorkItem`, `postMessage`,
`transitionRevision` (cascades IFR→Approved→IFC + auto-supersede),
`decideApproval` (HMAC-signed chain-of-custody), `ingestEvent`. Auth is
the same Bearer header as REST (JWT or `fgt_…` API token). GraphiQL is
exposed at `/graphiql` when `NODE_ENV !== "production"`.

### Automations (n8n)

| Method | Path | Notes |
|---|---|---|
| GET  | `/api/automations/n8n/status`            | `{ configured, url }` |
| GET  | `/api/automations/n8n/workflows`         | List |
| GET  | `/api/automations/n8n/workflows/:id`     | Detail |
| POST | `/api/automations/n8n/workflows/:id/activate`   | Audited |
| POST | `/api/automations/n8n/workflows/:id/deactivate` | Audited |
| GET  | `/api/automations/n8n/executions`        | Recent execution log |

The proxy uses `FORGE_N8N_URL` + `FORGE_N8N_API_KEY` from env so the browser
never holds the n8n key. The bundled `docker-compose.yml` brings up n8n on
`:5678` and mounts `deploy/n8n-templates/` read-only into the container.

## Authentication and authorization

- **JWT bearer tokens** (HS256, 12h expiry). `@fastify/jwt` handles signing; configure `FORGE_JWT_SECRET` in production.
- **Role → capability** mapping lives in `server/auth.js`. The same role matrix is used by the client for UI gating.
- **ABAC attributes** (site, discipline, clearance) live in the `users.abac` JSON column and can be layered on top of role checks (next iteration).

## Security

- **Tamper-evident audit log**: SHA-256 hash chain in the `audit_log` table; `verify_ledger()` walks the chain.
- **Signed approval decisions and audit packs**: HMAC-SHA256 over canonical JSON. `FORGE_TENANT_KEY` provides key material; `FORGE_TENANT_KEY_ID` labels it for rotation.
- **Signed outbound webhooks**: HMAC-SHA256 with a per-webhook secret; `X-FORGE-Signature` header.
- **API token storage**: only the SHA-256 of each token is stored; plaintext returned to the caller exactly once.
- **Password hashing**: bcrypt with cost 10.
- **Rate limiting**: `@fastify/rate-limit` (defaults 600 req/min per user/IP on API routes).
- **Secure headers**: `@fastify/helmet` (CSP, HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy).
- **Request size limits**: 10 MB JSON, 50 MB multipart.
- **CORS**: configurable via `FORGE_CORS_ORIGIN`; defaults to permissive for local dev.
- **Trust proxy**: enabled so the server behind nginx/traefik sees real client IPs.
- **Object-level ACL + ABAC**: `server/acl.js` `allows(user, acl, capability)` combines role membership, explicit user grants, and ABAC attribute equality. File downloads resolve the parent record and its ACL.

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

- **MQTT bridge** (`server/connectors/mqtt.js`): optional. Set `FORGE_MQTT_URL` (and optionally `FORGE_MQTT_TOPICS`, `FORGE_MQTT_USERNAME`, `FORGE_MQTT_PASSWORD`) and FORGE subscribes and routes inbound messages through the canonical event envelope and rule engine. Works with any MQTT 3.1.1/5 broker (EMQX, HiveMQ, Mosquitto).
- **OPC UA bridge** (`server/connectors/opcua.js`): optional, uses `node-opcua` (an optional dependency). Set `FORGE_OPCUA_URL` and `FORGE_OPCUA_NODES` (comma-separated node IDs) to subscribe to value changes and emit `state_change` events. If `node-opcua` isn't installed the bridge skips cleanly and the server keeps running.
- **REST webhooks (inbound)**: `POST /api/events/ingest` accepts any external source.
- **REST webhooks (outbound)**: admins configure URLs via `/api/webhooks`; every event is HMAC-signed and delivered asynchronously.

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

The Node test runner executes:
- `test/audit-chain.test.js` — hash-chain integrity, tamper detection, pack sign+verify.
- `test/routes.test.js` — boots Fastify in-process against a fresh DB and exercises login, `/api/me`, work-item CRUD, revision transition cascade (IFR → Approved → IFC with auto-supersede), file upload + SHA-256 round-trip, API token issue + use + revoke.

All test runs use isolated `FORGE_DATA_DIR` directories so they never touch production data.

## Backup / restore

```bash
npm run backup                 # → ./forge-backup-YYYY-MM-DDTHH-MM-SS.tar.gz
npm run restore -- <archive>   # replaces ./data/forge.db and ./data/files/
```

The backup uses SQLite's `VACUUM INTO` for a consistent point-in-time snapshot without blocking writers, then tars the snapshot alongside the `files/` directory. Restore unpacks and swaps the live files aside (keeping `.pre-restore` copies); restart the server afterwards.

## Migrations

The `server/db.js` module runs migrations on boot from `SCHEMA_VERSION`. Append
new versions inside the `migrate()` function; keep each version idempotent.

## Roadmap toward Postgres

All SQL in `server/` is portable **except** the FTS5 virtual tables. A
Postgres adapter would swap `better-sqlite3` for `pg` and replace FTS5 with
Postgres `tsvector` + `@@` / `ts_rank` (or OpenSearch). The route layer is
untouched.
