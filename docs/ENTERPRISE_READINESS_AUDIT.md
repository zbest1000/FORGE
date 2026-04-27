# FORGE Enterprise Readiness Audit

> Full-codebase review of what is **not** enterprise-ready in the current
> FORGE server + client. Focused on security, multi-tenancy, reliability,
> compliance, observability, and operations. UX gaps are tracked
> separately in `docs/ENTERPRISE_UX_REDESIGN_AUDIT.md`; this report avoids
> duplicating them.
>
> Branch: `cursor/enterprise-readiness-audit-603f` ·
> Date: Apr 2026 ·
> Codebase scope: `server/`, `src/core/`, `src/shell/`, `src/screens/`,
> infra (`Dockerfile`, `docker-compose.yml`, `.github/workflows/*`).

## Status (current branch)

Tasks marked **DONE** in this branch (`cursor/enterprise-readiness-audit-603f`):

| Task | Commit | Coverage |
|---|---|---|
| Idempotency-Key contract on writes (B.5 #7) | (this commit) | `server/idempotency.js` (new), `server/main.js`, `server/retention.js`, `server/db.js` schema v10 |
| Graceful shutdown + SSE backlog cap (B.5 #1, #5) | `14acb09` | `server/main.js`, `server/sse.js`, `server/webhooks.js` |
| Webhook payloads moved off the audit ledger (B.4 #11) | `688d96e` | `server/webhooks.js`, `server/db.js` schema v9 |
| Refresh tokens + session revocation + sign-out-everywhere (B.1 #5) | `8624a4b` | `server/sessions.js` (new), `server/routes/auth.js`, `server/main.js`, `server/db.js` schema v8 |
| E4 MFA (TOTP + recovery codes + two-step login) | `1a3a027` | `server/mfa.js` (new), `server/routes/auth.js` |
| E1 Tenant scoping (REST + GraphQL) | `143f0e0` | `server/routes/core.js`, `server/graphql/resolvers.js`, `server/routes/files.js`, new `server/tenant.js` |
| E3 Token scope enforcement | `ce3450d` | `server/auth.js`, `server/acl.js` |
| E5 Webhook SSRF guard | `ce3450d` | `server/security/outbound.js`, `server/webhooks.js` |
| E6 `crypto.randomUUID` | `ce3450d` | `server/db.js` |
| E10 `?token=` only on SSE | `ce3450d` | `server/main.js` |
| E12 Upload disposition + sniff | `ce3450d` | `server/routes/files.js` |
| E15 Retention sweep worker | `f4436f0` | `server/retention.js`, `server/main.js` |
| E16 OPC UA security in prod | `ce3450d` | `server/connectors/opcua.js` |
| E17 Login lockout | `ce3450d` | `server/security/lockout.js`, `server/routes/auth.js` |
| E19 Drop docs from container | `ce3450d` | `Dockerfile` |
| GraphIQL opt-in + GraphQL depth | `ce3450d` | `server/main.js` |
| Login.fail audit no-leak | `ce3450d` | `server/routes/auth.js` |
| Legal-hold interlock on file delete | `f4436f0` | `server/routes/files.js` |
| Pagination on list endpoints | `f4436f0` | `server/routes/core.js` |

### Follow-on batch (`cursor/enterprise-readiness-batches-7a2c`)

| Task | Coverage |
|---|---|
| CI fix: Windows path portability (audit-chain) + skip POSIX shutdown test on Windows | `test/audit-chain.test.js`, `test/shutdown.test.js` |
| CI fix: gitleaks allowlist for deterministic test fixtures | `.gitleaks.toml` |
| CI fix: de-flake MFA challenge tamper assertion (last-char hex 1/16 collision) | `test/mfa.test.js` |
| CI fix: CodeQL config that excludes `js/missing-rate-limiting` (Fastify global limiter not traceable) | `.github/codeql/codeql-config.yml`, `.github/workflows/codeql.yml` |
| CI fix: Docker runtime image copies `src/core/fsm`, `src/core/i3x`, `src/data` (server imports) | `Dockerfile` |
| CI fix: Docker smoke step uses 32+ char strict-mode secrets | `.github/workflows/ci.yml` |
| B.11 #1 — `/api/v1/*` versioning shim with deprecation header | `server/main.js` (rewriteUrl + onRequest), new `test/api-versioning.test.js` |
| B.11 #2 — Unified error envelope + X-Request-Id | `server/errors.js` (new), `server/main.js`, new `test/error-envelope.test.js` |
| B.11 #4 — ETag / If-Match optimistic concurrency on PATCH | `server/etag.js` (new), `server/routes/core.js`, `server/routes/compliance.js`, new `test/etag.test.js` |
| B.11 #5 — Tenant scope on /api/audit* | `audit_log.org_id` (v11), `server/audit.js`, `server/routes/core.js` |
| B.4 #1, #3 — Foreign-key sweep with ON DELETE policies + pre-migrate snapshot + `--integrity` CLI | `server/db.js` v12, new `test/foreign-keys.test.js` |
| B.6 #5, B.8 #6 — Periodic verifyLedger worker + Prometheus tamper metrics | `server/audit-tamper.js` (new), `server/main.js`, new `test/audit-tamper.test.js` |
| B.7 #10 — Per-route Fastify JSON-schema validation on auth/core/webhook writes | `server/schemas/{common,auth,core,webhooks}.js` (new), every write route, new `test/schema-validation.test.js` |
| B.3 #6 — `webhook.write` capability separates from `admin.view` | `server/auth.js`, `server/routes/webhooks.js` |
| B.3 #7 — Event ingest requires `integration.write` | `server/routes/core.js`, `server/graphql/resolvers.js` |
| B.3 #8 — Compliance writes require `admin.edit`; reads keep `admin.view` | `server/auth.js`, `server/routes/compliance.js` |
| B.6 #4 — Pino redaction for secrets / passwords / tokens / Authorization | `server/main.js` |
| B.8 #1 — DSAR third-party PII redaction with stable mask + summary | `server/compliance.js`, new `test/dsar-redaction.test.js` |
| B.7 #11 — FTS5 query sanitisation (control chars, operator surface, length cap) | `server/security/fts.js` (new), `server/routes/core.js`, `server/routes/ai.js`, `server/alerts.js`, `server/graphql/resolvers.js`, new `test/fts-injection.test.js` |
| B.13 #1 — `SECURITY.md` with coordinated disclosure window | repo root |
| B.13 #3 — `docs/INCIDENT_RUNBOOK.md` for the FORGE service | docs/ |
| B.13 #2 — `docs/SLO.md` with SLIs + Prometheus alerts | docs/ |
| B.13 #4 — `docs/SCHEMA_UPGRADE.md` covering v8–v12 | docs/ |
| B.13 #5 — `docs/THREAT_MODEL.md` (STRIDE per surface) | docs/ |

Test suite: 168/168 passing locally on Linux (Windows runs all but
the POSIX-signal shutdown test; macOS runs the full suite). New
regression files: `api-versioning`, `etag`, `error-envelope`,
`foreign-keys`, `audit-tamper`, `schema-validation`,
`authz-tightening`, `dsar-redaction`, `fts-injection`.

Remaining tasks are tracked in the developer-ready list (Section E)
and in the prioritized roadmap.

## A. Executive summary

FORGE is structurally well laid out for an enterprise self-host: Fastify
+ helmet + JWT + rate-limit + `@fastify/multipart`, hash-chained audit
ledger, HMAC-signed approvals, transactional outbox, signed webhook
deliveries, FTS5 search, ed25519-signed licensing, OpenTelemetry hook,
prom-client metrics, CycloneDX SBOM, multi-OS CI matrix, container
HEALTHCHECK, online backup tooling. The skeleton is production-shaped.

The gap to **enterprise-ready** is concentrated in five areas:

1. **Identity & sessions** — no MFA enforcement (table exists, no code
   path), no SSO/SAML/OIDC, no refresh tokens, no login-failure
   lockout, no password policy / rotation / reset, JWT secret has
   insecure default outside strict mode, role is embedded in JWT and
   never re-checked against the DB.
2. **Multi-tenancy is nominal** — schema has `org_id` / `workspace_id`
   columns and an `organizations.tenant_key`, but **no route filters by
   tenant**. Any authenticated user can read any org's data subject to
   ACLs that default to `roles: ["*"]`. Tenant key for HMAC is global,
   not per-org.
3. **Reliability primitives are partially wired** — outbox + webhooks
   exist but the webhook body recovery scheme reads from the audit log
   (anti-pattern); SSE has no backpressure or per-client buffer cap; no
   graceful drain of in-flight requests on `SIGTERM`; DB has WAL but no
   replica/failover story; SQLite single-writer constrains horizontal
   scale; in-memory engine cache (`server/routes/i3x.js`
   `_engine`) is process-local.
4. **Compliance surface looks complete but is largely admin-curated
   data** — DSAR, legal-hold, ROPA, evidence routes exist, but the
   server never actually enforces `legal_hold`, never deletes per
   `retention_policies.days`, and DSAR `export` does not redact related
   users' PII.
5. **Operations & supply chain** — Docker image runs as `node` user
   (good) but the bundle includes `docs/` and `PRODUCT_SPEC.md` (info
   leak), CSP keeps `'unsafe-inline'` + `'unsafe-eval'` in production,
   `npm audit` is gated only at `--audit-level=high`, no signed
   container images / provenance attestations, `release.yml` exists but
   no SBOM attached to GitHub Release, no SLO doc, no runbook for
   incident response, no alerting rules shipped with the metrics.

The rest of this document enumerates concrete findings with file paths
and remediation tasks. Severity scale: **P0** (block enterprise
deployment), **P1** (must fix before paying customers), **P2**
(important hardening), **P3** (nice-to-have polish).

## B. Findings by domain

### B.1 Identity, authentication, sessions

| # | Finding | Code | Severity |
|---|---|---|---|
| 1 | **No MFA enforcement.** `user_mfa` table exists (`server/db.js:446-453`) but no route reads or writes it; the `MFA_ENFORCEMENT` license feature flag (`server/license.js:106,267`) is referenced but never gates login. `verifyPassword` returns a token immediately. | `server/routes/auth.js:7-18`, `server/auth.js:38-44` | P0 |
| 2 | **No SSO/SAML/OIDC.** Only email + password. Enterprise customers expect IdP-driven SCIM provisioning + SAML/OIDC. Spec mentions SSO but no implementation. | `server/auth.js`, `server/routes/auth.js` | P0 |
| 3 | **JWT default secret is insecure.** `DEFAULTS.jwtSecret = "forge-dev-jwt-secret-please-rotate"`. Strict mode rejects it, but `NODE_ENV=development` (the docker-compose default) keeps it. | `server/config.js:11,19-27,76-89` | P1 |
| 4 | **Role is captured in the JWT and never re-checked.** `jwtSign({ sub, role })` (`routes/auth.js:15`); on every request the user is reloaded by `userById(decoded.sub)` so role *is* refreshed there, but the cookie/SSE `?token=` path also accepts JWTs as query params (`server/main.js:141`) which logs them in proxy access logs and CDN caches. | `server/main.js:139-165` | P1 |
| 5 | **No refresh tokens, no session revocation, no idle timeout.** Tokens last 12 h with no server-side store. Logout is a no-op (`server/routes/auth.js:20-23`) — the JWT remains valid until expiry. | `server/routes/auth.js:20-23` | P1 |
| 6 | **No login-failure rate limit / lockout.** Fastify rate-limit applies globally but bucketed by `req.user?.id || req.ip` (`server/main.js:130`); a botnet hitting `/api/auth/login` with empty `req.user` falls into per-IP buckets only. There is no per-account threshold or progressive delay. Failed logins are audited (`auth.login.fail`) but not acted on. | `server/main.js:120-131`, `server/routes/auth.js:11-13` | P1 |
| 7 | **No password policy or rotation.** `bcrypt.hash(password, 10)` with no minimum length / complexity / breach-list check. Seed users all share `forge`. | `server/auth.js:31`, `server/seed.js:33` | P1 |
| 8 | **No password reset / recovery flow.** | — | P1 |
| 9 | **Token can be passed as `?token=…`** for SSE — and accepted on **every** route (`server/main.js:141`), not just the SSE one. Web servers/proxies log query strings. | `server/main.js:141` | P1 |
| 10 | **API tokens (`fgt_…`) are not scope-enforced** at handler level. `resolveToken` returns `scopes` (`server/tokens.js:48-58`) but `require_(capability)` only checks `user.role`'s capabilities — token scopes are ignored. A `view`-scoped token still authorizes `edit`/`approve` if the underlying user has the role. | `server/auth.js:99-107`, `server/tokens.js`, `server/main.js:139-165` | P0 |
| 11 | **Token rotation has no admin tooling.** Tokens are user-scoped and revocable per token, but there is no admin "revoke all tokens for user X" endpoint, and tokens survive role downgrades. | `server/tokens.js`, `server/routes/tokens.js` | P2 |
| 12 | **`audit.login.fail` records the **email plaintext** as actor** (`server/routes/auth.js:12`) — not catastrophic, but the audit ledger is not redactable, so a flood of failed logins permanently writes guessable emails into a hash chain that customers will export. | `server/routes/auth.js:12` | P2 |

### B.2 Multi-tenancy

| # | Finding | Code | Severity |
|---|---|---|---|
| 1 | **No tenant isolation in queries.** Schema has `organizations`, `workspaces`, and every domain table carries `org_id` or `team_space_id`, but `coreRoutes` issues `SELECT * FROM team_spaces` / `documents` / `assets` / `incidents` with no `WHERE org_id = ?` or `workspace_id = ?` predicate (`server/routes/core.js:67-91, 118-128, 163-176, 215-218`). Isolation is delegated to `acl.allows`, whose default (`{ roles: ["*"] }` in `server/acl.js:17,21-23`) is wide-open. Combined with seed data using `acl: '{}'` everywhere, a guest/external role would in practice see every tenant's row that the parser falls back on. | `server/routes/core.js:67-368`, `server/acl.js:16-23`, `server/seed.js` | P0 |
| 2 | **`organizations.tenant_key` is set but unused.** Audit pack signing (`server/crypto.js:30-47`) uses a single global `FORGE_TENANT_KEY` env var. Multi-tenant deployments cannot prove provenance per tenant. | `server/crypto.js:36-46`, `server/db.js:42-47` | P0 |
| 3 | **Approval HMAC chain is global.** Same single-key issue: a stolen `FORGE_TENANT_KEY` forges signatures for every tenant. No KMS / per-tenant key rotation. | `server/crypto.js:30-58`, `server/routes/core.js:247-275` | P1 |
| 4 | **`/api/users` lists every user across the org table without org filter.** | `server/routes/core.js:64`, `server/auth.js:51-53` | P1 |
| 5 | **Search returns hits across all tenants** then filters by ACL. ACL-bypassing data (`title`, `snippet`) still touches the user before filtering — minor info leak. | `server/routes/core.js:305-365` | P2 |
| 6 | **GraphQL `organization` returns the first row only.** No way for a multi-tenant deployment to expose more than one. | `server/graphql/resolvers.js:102-103` | P1 |
| 7 | **i3X engine cache (`_engine`) loads `forgeData` once per process** without tenant scoping, so its in-memory view stays fixed at one workspace. | `server/routes/i3x.js:50-58` | P1 |

### B.3 Authorization (RBAC + ABAC + ACL)

| # | Finding | Code | Severity |
|---|---|---|---|
| 1 | **Role list is hardcoded in two places** that can drift: client `src/core/permissions.js` and server `server/auth.js:8-19`. Adding a role server-side will silently fail capability checks on the client. | `src/core/permissions.js`, `server/auth.js:8-19` | P2 |
| 2 | **Capabilities are coarse.** Ten roles share ~9 capability strings; no ability to scope a user to a workspace/team-space without inventing a new role or mucking with `abac`. | `server/auth.js:8-19`, `server/acl.js:24-39` | P1 |
| 3 | **`Organization Owner` bypasses ACL universally** including own-tenant guard rails. There is no four-eyes / break-glass audit on bypass. | `server/acl.js:27` | P1 |
| 4 | **ACL fallback is `roles: ["*"]`** when stored ACL is missing/invalid (`server/acl.js:17,19,21-23`). Combined with seed `acl: '{}'`, this means almost every demo row is world-readable for any authenticated role with `view` cap. | `server/acl.js:16-23`, `server/seed.js` (every `acl: '{}'`) | P0 |
| 5 | **No per-field ABAC.** ABAC is a flat key/value match (discipline/site/clearance) — no inheritance, no expression language, no time-bound access. | `server/acl.js:34-37` | P2 |
| 6 | **Webhook admin caps reuse `admin.view`** (`server/routes/webhooks.js`) — read and write share the same capability. A read-only auditor with `admin.view` can create + delete webhooks. | `server/routes/webhooks.js:7-30` | P1 |
| 7 | **`integration.read` allows ingesting events** (`server/routes/core.js:301`). Read capability should not enable arbitrary event injection into the rule engine. | `server/routes/core.js:301` | P1 |
| 8 | **Compliance routes are gated by `admin.view` only** — DSAR export, legal-hold creation, ROPA writes (`server/routes/compliance.js:24-77`). A user who can *view* admin data can also *modify* compliance state. | `server/routes/compliance.js` (entire file) | P1 |

### B.4 Data, schema, and integrity

| # | Finding | Code | Severity |
|---|---|---|---|
| 1 | **Foreign keys are inconsistent.** `users.org_id REFERENCES organizations(id)` exists, but `team_spaces`, `projects`, `channels`, `messages`, `documents`, `revisions`, `drawings`, `assets`, `work_items`, `approvals`, `incidents`, `events`, `audit_log` declare none. `PRAGMA foreign_keys = ON` (`server/db.js:16`) is therefore a no-op for most tables. | `server/db.js:42-870` | P1 |
| 2 | **`uuid()` uses `Math.random()`** for short IDs. Not cryptographic — collision risk grows with table size and an attacker can guess the next ID space. Should use `crypto.randomUUID()` or `crypto.randomBytes`. | `server/db.js:851-854` | P1 |
| 3 | **Migrations are forward-only with no rollback.** Schema versions 1-7 live in `migrate()` as monolithic `db.exec`. Failed migration leaves the DB at intermediate state because each `setVersion` is per branch but the outer `db.transaction` covers the whole `migrate()` body — that *should* roll back, but in practice schema changes during ALTER are partially DDL-transactional in SQLite. v7 (`server/db.js:761-841`) silently re-creates tables that already exist with different columns; this is dangerous. | `server/db.js:34-870` | P1 |
| 4 | **JSON-blob columns are pervasive.** `acl`, `labels`, `mqtt_topics`, `opcua_nodes`, `doc_ids`, `roster`, `timeline`, `chain`, `approvers`, `events`, `last_seen_ids`, etc., are all `TEXT` JSON. Cannot index, cannot query, cannot enforce shape. Equivalent of a NoSQL leak inside a relational store. | `server/db.js` (most tables) | P2 |
| 5 | **Soft-delete is not consistent.** `messages` has `deleted` flag + `deleted_at`/`deleted_by`. `files` is hard-deleted in the route but kept on disk by the comment ("retention sweep") that does not exist anywhere in the codebase. `documents`, `revisions`, `assets`, `incidents` have **no** delete handler. | `server/routes/files.js:118-126`, `server/routes/core.js`, no retention sweep code | P1 |
| 6 | **Retention policies are stored but not enforced.** `retention_policies` rows are seeded (`server/seed.js:151-157`) and listable, but no worker prunes data. | `server/seed.js:151-157`, no enforcement code | P1 |
| 7 | **Legal holds are stored but not enforced.** A row in `legal_holds` does not block delete operations on covered objects. | `server/routes/compliance.js:46-60`, no interlock | P0 (compliance) |
| 8 | **No row-level encryption.** Everything is at-rest plaintext in SQLite. Not catastrophic for self-host with disk encryption, but document control + PII columns expect at-rest crypto in many enterprise procurements. | — | P2 |
| 9 | **Search index can leak across ACL boundaries before filter.** FTS hits are computed first, ACL filtered after (`server/routes/core.js:346`). Snippet text passes through. | `server/routes/core.js:308-365` | P2 |
| 10 | **Audit ledger queue is in-process and memory-resident.** `_pending` (`server/audit.js:17`) is a chained promise; if the process crashes between insert and hash compute, the entry is lost or written with a stale `prev_hash`. Multi-process deployments would race the chain. | `server/audit.js:9-68` | P1 |
| 11 | **Webhook payload recovery from audit log is an anti-pattern.** `tick()` re-reads the body via `json_extract(detail, '$.deliveryId')` over `audit_log`. Loses the delivery on log retention pruning, and bloats the ledger with payload data forever. | `server/webhooks.js:75-78,110-115` | P1 |

### B.5 Reliability and operations

| # | Finding | Code | Severity |
|---|---|---|---|
| 1 | **No graceful shutdown of in-flight requests.** `shutdown()` calls `app.close()` then `process.exit(0)` immediately (`server/main.js:346-352`). Outbox / webhook / alert workers are not stopped, MQTT/OPC UA bridges leak open sockets, audit `_pending` may still hold un-flushed entries. | `server/main.js:346-352` | P1 |
| 2 | **SQLite single-writer constrains scale-out.** No read replica, no PITR (only `VACUUM INTO` snapshots), no automated backup schedule. README claims "production-grade"; for HA install footprint this is the single biggest operational risk. | `server/db.js:14-17`, `server/backup.js` | P1 |
| 3 | **In-memory state breaks if you run more than one process.** Audit chain `_tail` (`server/audit.js:15-23`), webhook `_workerHandle`, alerts `_handle`, outbox `worker`, i3X `_engine`, MQTT `_client`, OPC UA `_client`, SSE `clients` set — all module-level. A second replica would double-deliver webhooks, double-fire alerts, race the audit chain, and have a different SSE backplane. | various | P0 for HA |
| 4 | **No circuit breaker / connect timeouts on outbound connectors.** Webhook delivery has 8 s abort (`server/webhooks.js:121`), but n8n proxy and AI providers do not all set timeouts uniformly. No retry budget per minute, no global breaker on 5xx storms. | `server/ai.js:85-99`, `server/routes/automations.js`, `server/webhooks.js:120-134` | P2 |
| 5 | **SSE has no per-client backlog cap.** `broadcast()` writes to every client with `try { write } catch { delete }`; a slow client backs up Node socket buffers until OOM. | `server/sse.js:28-33` | P1 |
| 6 | **No request-id / correlation-id middleware.** Some traces add `trace_id`, audit entries take `traceId`, but Fastify's default request id is not propagated as `X-Request-Id` to clients, and not echoed in pino logs. | `server/main.js:63-73` | P2 |
| 7 | **No HTTP retry / idempotency-key contract.** POSTs with the same payload create duplicates (work items, channel messages). Event ingest has `dedupe_key` but it is opt-in by the producer. | `server/routes/core.js:102-115, 177-189`, `server/events.js:47-53` | P1 |
| 8 | **No alerting / SLO config.** Prom-client metrics exist (`server/metrics.js`) but `deploy/` ships only `mosquitto.conf` + `otel-collector.yaml`; no Prometheus rules, no Grafana dashboards, no PagerDuty/Alertmanager templates. | `deploy/`, `server/metrics.js` | P2 |
| 9 | **Logs are pino but not structured for SIEM.** Default pino with `pino/file` to stdout in dev; no fields-stable JSON envelope (`event_type`, `tenant_id`, `actor_id`) for downstream log-pipeline ingest. | `server/main.js:64-70` | P2 |
| 10 | **HEALTHCHECK in Dockerfile** uses `fetch()` from inside the container — Node 20 has it, but no separate `/api/ready` endpoint distinguishes "process is up" (`/api/health`) from "DB writable + workers running". | `Dockerfile:63-64`, `server/main.js:167-173` | P2 |
| 11 | **Backup CLI requires `tar` binary on PATH.** Windows containers / minimal images break. No checksumming/encryption of the produced archive. | `server/backup.js:20-31` | P2 |
| 12 | **`docker-compose.yml`** likely does not pin image digests; defaults push live images on update. (Confirm in file.) | `docker-compose.yml` | P2 |

### B.6 Observability

| # | Finding | Code | Severity |
|---|---|---|---|
| 1 | **Tracing must be opt-in (`FORGE_OTEL_ENABLED=1`).** Out of the box, OTel SDK is loaded and *disabled*. The cost of always-on with sampling is small; default-on (with low sample rate) catches more bugs in support cases. | `server/tracing.js:10-17` | P3 |
| 2 | **`forge_http_requests_total` cardinality is unbounded** if `routeOptions.url` resolves to `unknown` for SPA routes — every dynamic path becomes its own time series. | `server/metrics.js:78-83` | P2 |
| 3 | **No business KPIs surfaced.** Approval lead time, incident MTTR, revision throughput — these belong in `metrics-rollup.js` but the only series there is `wau`. | `server/metrics-rollup.js`, `server/main.js:223-229` | P3 |
| 4 | **No log redaction.** Secrets in request bodies (`webhooks.create` returns the secret in the response and the request body lands in pino if a downstream throws). | `server/main.js:64-70`, `server/routes/webhooks.js:13-15` | P1 |
| 5 | **Audit ledger errors are `console.error` only** (`server/audit.js:62-64`). They do not increment a metric or trip an alert. Tampering or write failures are invisible to ops. | `server/audit.js:62-64` | P1 |

### B.7 Security headers, web, and input validation

| # | Finding | Code | Severity |
|---|---|---|---|
| 1 | **CSP keeps `'unsafe-inline'` and `'unsafe-eval'` in production.** `CSP_PROD` (`server/main.js:97-103`) admits inline scripts, blob:, wasm-unsafe-eval *and* unsafe-eval. The comment notes web-ifc requires WASM streaming; that justifies `'wasm-unsafe-eval'` only, not `'unsafe-eval'`. Inline scripts could be migrated to nonces. | `server/main.js:97-103` | P1 |
| 2 | **No CSRF protection** for cookie-based auth. Currently auth is bearer-only, so the surface is small, but if a future cookie is added, helmet does not include `samesite` or anti-CSRF middleware. | `server/main.js:75-119` | P3 |
| 3 | **CORS origin defaults to `true`** (reflect any origin) outside strict mode. Many self-hosters will run with `NODE_ENV=development` and inadvertently expose credentialed endpoints to any origin. | `server/config.js:8-17,80-82`, `server/main.js:75-78` | P1 |
| 4 | **Content-Disposition is `inline` on file download.** A maliciously named SVG or HTML uploaded file could be rendered in-browser. The MIME pass-through (`row.mime`) is set from `part.mimetype` without server-side sniffing. | `server/routes/files.js:97-101` | P1 |
| 5 | **No magic-byte validation on uploads.** `mime` field is taken from the multipart header. Maliciously labeled `application/pdf` could be a HTML payload; combined with finding 4 it lets an attacker drop XSS bait into a tenant. | `server/routes/files.js:38-85` | P1 |
| 6 | **No virus / malware scan on uploads.** No ClamAV or signature lookup. | `server/routes/files.js` | P2 |
| 7 | **Webhook URL is not validated against private IP space (SSRF).** `dispatchEvent` → `fetch(wh.url)` will happily POST to `http://169.254.169.254/...` (cloud metadata) or RFC1918 addresses. Should require https + DNS pinning + allowlist. | `server/webhooks.js:117-134`, `server/routes/webhooks.js:9-15` | P0 |
| 8 | **AI provider URLs and Ollama default to `http://localhost:11434`.** A misconfigured policy can be forced to a private address; combined with the FORGE_AI_POLICY env-only configuration, a tenant admin cannot scope this. | `server/ai.js:106-127` | P2 |
| 9 | **`bodyLimit: 10 MB` for all routes.** Multipart caps at 50 MB. There is no per-route limit (e.g. `/api/auth/login` should be tiny). | `server/main.js:71`, `server/main.js:133` | P3 |
| 10 | **No request-schema validation.** Routes accept `req.body` and `req.query` ad-hoc, often `String(...)`-ing values; Fastify's JSON schema is not used (`schema:` is absent on every handler). Easy XSS on, e.g., `name` fields, easy ReDoS on user-supplied search regex. | every `server/routes/*.js` handler | P1 |
| 11 | **FTS5 query is interpolated** (`'"' + esc + '"*'`) but `esc` only doubles `"`; control chars / FTS operators / NULL bytes pass through. | `server/routes/core.js:308`, `server/alerts.js:66`, `server/routes/ai.js:18-20` | P2 |
| 12 | **`innerHTML` in client.** `src/core/ui.js` exposes an `html: string` prop that sets `innerHTML` directly (`src/core/ui.js:12-13`). Other call sites (`src/screens/uns.js:238`, `src/core/charts.js:59`, `src/core/cad-viewer.js`, `src/core/mermaid.js:39`, `src/core/md.js:31`) write SVG / mermaid / markdown via `innerHTML` — only `md.js` uses DOMPurify. The `html:` escape hatch is the riskiest because it accepts arbitrary callers. | `src/core/ui.js:7-15`, all the above | P1 |
| 13 | **Rate-limit key falls back to `req.ip`,** which on `trustProxy: true` is taken from `X-Forwarded-For`. If the proxy is misconfigured, an attacker can rotate `X-Forwarded-For` to bypass per-IP buckets. | `server/main.js:72,130` | P2 |
| 14 | **`dompurify` is shipped via `import` in the SPA, but the static bundle uses ESM imports without DOMPurify on every HTML insertion path.** Markdown is sanitized; mermaid and uns SVGs rely on DOMPurify only loosely. | `src/core/md.js:30-31`, `src/core/mermaid.js:38-40` | P2 |

### B.8 Compliance and audit

| # | Finding | Code | Severity |
|---|---|---|---|
| 1 | **DSAR export does not redact other subjects.** `compliance.js exportDsarBundle` (referenced in `routes/compliance.js:39-43`) — confirm in the implementation; it pulls all rows where `actor = subject` or `subject = subject` from the audit log, which can include third-party messages and IDs. | `server/compliance.js:33-39` | P1 |
| 2 | **No data-residency enforcement.** `enterprise_systems.data_residency` and `processing_activities.residency_region` are stored as strings, but no read path checks that requested data complies. | `server/db.js:646-663,778-810` | P2 |
| 3 | **No audit-log retention enforcement.** Default policy is 2555 days (`server/seed.js:152`), but no pruning sweep runs against `audit_log`. Indefinite retention on a hash chain can outgrow disk. | `server/seed.js:151-157` | P2 |
| 4 | **No automated audit-log signing key rotation.** `FORGE_TENANT_KEY_ID` is fixed at `key:forge:v1` and there is no `verify` against a key history table, which would be required for a multi-year ledger after a rotation. | `server/crypto.js:30-46`, `server/audit.js` | P1 |
| 5 | **`signed_at` for approvals is computed by the server clock,** never asserted via NTP / monotonic source. Skew between processes corrupts ordering when scaled out. | `server/routes/core.js:248`, `server/db.js:849` | P3 |
| 6 | **No tamper-detection alerting.** `verifyLedger()` exists (`server/audit.js:78-99`) but is only called from the `/api/audit/verify` endpoint on demand. No periodic worker calls it and no metric is exported. | `server/audit.js:78-99` | P1 |
| 7 | **Audit `subject` is free-form** (`server/audit.js:38`). A misconfigured caller can write empty subjects; there is no enum or referential check. | `server/audit.js` | P3 |

### B.9 Integrations and external surfaces

| # | Finding | Code | Severity |
|---|---|---|---|
| 1 | **Webhook secrets are returned in plaintext on creation** (`server/routes/webhooks.js:13-15`) — that's expected, but the same row also stores `secret` plaintext in SQLite; rotating compromised webhook secrets is admin-only with no UI flow. | `server/routes/webhooks.js:13-15`, `server/webhooks.js:32` | P2 |
| 2 | **n8n proxy uses static API key** in `FORGE_N8N_API_KEY`. No per-user impersonation, no scope. | `.env.example:54-58`, `server/routes/automations.js` | P2 |
| 3 | **MQTT credentials in env vars**, no rotation, no per-tenant separation. | `server/connectors/mqtt.js:7-23` | P2 |
| 4 | **OPC UA bridge defaults to `SecurityMode.None` and `SecurityPolicy.None`.** No certificate verification. | `server/connectors/opcua.js:33-39` | P0 |
| 5 | **MQTT bridge subscribes with `qos: 1` but publishes back nothing** — there is no Sparkplug / state birth/death support. Reconnect with topic re-subscribe relies on `mqtt.js`'s default `clean: true`, dropping retained alarms. | `server/connectors/mqtt.js` | P2 |
| 6 | **Connector `recordRun` has no real connector** — it just inserts a `connector_runs` row. The "test" and "sync" endpoints are placeholders. | `server/integrations/registry.js`, `server/routes/enterprise-systems.js:31-43` | P1 |
| 7 | **GraphQL has no query depth / cost limit.** `mercurius` is registered with no `queryDepth` / `complexityLimit` plugin (`server/main.js:179-191`). Authenticated user can DoS via deeply nested queries. | `server/main.js:179-191` | P1 |
| 8 | **GraphIQL is enabled outside `production`** (`server/main.js:184-185`). If a customer runs without `NODE_ENV=production`, schema introspection and an interactive client are exposed. | `server/main.js:184-185` | P2 |

### B.10 Build, supply chain, and CI

| # | Finding | Code | Severity |
|---|---|---|---|
| 1 | **`npm audit --audit-level=high` is non-blocking for moderate.** Moderate CVEs accumulate. | `.github/workflows/ci.yml:144-167`, `package.json` | P2 |
| 2 | **No SLSA / cosign / image signing.** Container is built and pushed (release.yml not shown in detail) but no provenance attestation. | `.github/workflows/release.yml`, `Dockerfile` | P1 |
| 3 | **CSP unsafe-inline indicates legacy inline handlers** (`app.js`) that were never migrated. | `server/main.js:97-103`, `app.js`, `index.html` | P1 |
| 4 | **Dockerfile copies `docs/` and `PRODUCT_SPEC.md` into the runtime image** (`Dockerfile:56-57`). Information leak: spec describes auth/audit internals; docs include `AUDIT_REPORT.md`, `LICENSING.md`. | `Dockerfile:56-57` | P1 |
| 5 | **Runtime image is `node:20-bookworm-slim`, not distroless.** Base image carries `apt`, shell, ssl tools — large attack surface for a single Node binary. | `Dockerfile:35-50` | P2 |
| 6 | **`tini` is good** but no `--init` fallback; the image relies on PID-1 signal handling working. | `Dockerfile:46-66` | — |
| 7 | **CI does not run a SAST tool** (CodeQL is set up at `.github/workflows/codeql.yml`, but the JS rule pack is the default — no semgrep or eslint-security). | `.github/workflows/codeql.yml` | P2 |
| 8 | **`HUSKY: "0"` disables hooks in CI** but pre-commit is not configured locally either. | `.github/workflows/ci.yml:23` | P3 |
| 9 | **No automated dependency update bot configured** (no `dependabot.yml` / `renovate.json` in repo root). | `.github/` | P2 |
| 10 | **Vite 8.x is at the bleeding edge** (current package). For an enterprise build that needs reproducibility, pin minor versions and avoid pre-1.0 / very recent majors. | `package.json` | P3 |

### B.11 API design and versioning

| # | Finding | Code | Severity |
|---|---|---|---|
| 1 | **No API version on `/api/*`.** REST endpoints have no `/v1/api` prefix; only the i3X surface is `/v1/*`. Forcing a breaking change later requires `/v2`. | `server/routes/*.js` | P1 |
| 2 | **Inconsistent error shapes.** Some return `{ error: "..." }`, some `{ error: "...", capability: "..." }`, some `{ error: "...", path: ... }`. No `code`/`type`/`requestId` envelope. | `server/main.js:261-272`, `server/routes/*.js` | P2 |
| 3 | **No pagination on list endpoints.** `/api/team-spaces`, `/api/projects`, `/api/documents`, `/api/assets`, `/api/incidents`, `/api/work-items` all `SELECT *`. At 10k incidents, this OOMs the SPA. | `server/routes/core.js:67-218` | P1 |
| 4 | **No `If-Match` / ETag concurrency control.** `PATCH /api/work-items/:id` overwrites without optimistic-lock; concurrent edits silently clobber. | `server/routes/core.js:191-212` | P1 |
| 5 | **Audit `recent` and `verify` ignore tenant scope** even when verify becomes per-tenant. | `server/audit.js:78-138` | P1 |

### B.12 Testing

| # | Finding | Code | Severity |
|---|---|---|---|
| 1 | **Coverage is good for audit / FSM / license** but thin on the request → response path of routes (most route handlers are not exercised). `routes.test.js` is one file. | `test/*.test.js` | P2 |
| 2 | **No load / soak / chaos test.** Cannot answer "how many concurrent SSE clients", "how does the outbox behave at 1k events/s", "what happens when SQLite is replaced by a corrupt file". | — | P2 |
| 3 | **No security regression suite.** No tests for "user without `view` cannot read row", "expired token rejected", "ACL forbid still rejects after Org Owner override", "rate-limit kicks in at N+1". | `test/` | P1 |
| 4 | **No contract test against the i3X spec.** Hand-rolled engine + RapiDoc docs ⇒ drift over time. | `src/core/i3x/`, `server/routes/i3x.js` | P2 |
| 5 | **Tests run sequentially (`--test-concurrency=1`)** because of the singleton DB. This is technically correct, but a multi-tenant refactor would let parallel tests run and dramatically cut CI time. | `package.json` | P3 |

### B.13 Documentation gaps

| # | Finding | Severity |
|---|---|---|
| 1 | No SECURITY.md (or only stub). No coordinated disclosure window, no `security@` contact. | P1 |
| 2 | No SLO / availability target document. | P2 |
| 3 | No incident-response runbook for the FORGE service itself (only the in-app incident workflow). | P1 |
| 4 | No "How to upgrade across schema versions" doc. | P2 |
| 5 | No threat model. | P2 |

## C. Cross-cutting risk register

| Risk | Severity | Likelihood | Where |
|---|---|---|---|
| SSRF via webhook URL | High | Medium | `server/webhooks.js` |
| Cross-tenant data leak via missing `WHERE org_id` filter | Critical | High in multi-tenant deploy | `server/routes/core.js`, `server/acl.js` defaults |
| API token scopes ignored | High | High (any `fgt_…` user) | `server/auth.js`, `server/tokens.js` |
| Login bruteforce | High | High | `server/routes/auth.js` |
| Inline-served HTML upload (XSS) | High | Medium | `server/routes/files.js` |
| OPC UA bridge ships unauthenticated | High | Medium when enabled | `server/connectors/opcua.js` |
| Audit chain in-memory `_pending` race | Medium | Low single-process / High multi-process | `server/audit.js` |
| Docker image leaks docs | Low | High | `Dockerfile` |
| GraphIQL exposed if not `NODE_ENV=production` | Medium | High by default | `server/main.js` |
| In-process workers cannot scale beyond 1 process | High for HA | High | many module-level singletons |

## D. Prioritized roadmap

### Phase 1 — Block enterprise sale (P0)

1. **Tenant-scope every list/get query.** Add `org_id`/`workspace_id`
   filters in `server/routes/core.js`, `server/routes/files.js`,
   `server/routes/extras.js`, GraphQL `Query.*`, and the i3X engine
   loader. Make ACL fallback `roles: []` (deny-by-default) instead of
   `["*"]`.
2. **Enforce token scopes.** Plumb `req.tokenScopes` through
   `require_(capability)` and error 403 when scope missing.
3. **Implement MFA enforcement.** TOTP enrolment, recovery codes,
   `MFA_ENFORCEMENT` license gate, `/api/auth/login` returns
   `{ mfaRequired: true, challenge }`.
4. **Block SSRF in webhooks.** `https://` only by default, DNS
   resolution to public IP space only, allowlist on creation.
5. **Disable GraphIQL whenever `nodeEnv !== "production"` *and*
   `FORGE_STRICT_CONFIG=1`** isn't enough — flip to opt-in via
   `FORGE_GRAPHIQL=1`.
6. **OPC UA: require `SecurityPolicy` ≠ `None`** when the bridge is
   enabled in production.

### Phase 2 — Must-fix before production traffic (P1)

7. **SSO / OIDC.** Mount `@fastify/oauth2` or external proxy IdP doc;
   add `users.external_id` + SCIM-min subset.
8. **Login lockout** (per email + per IP, exponential backoff,
   exposed via metric).
9. **Schema validation** on every route handler using Fastify's
   built-in JSON-schema — covers query, body, params; auto-rejects
   invalid input.
10. **API versioning** — move `/api/*` under `/api/v1/*` with redirect.
11. **Pagination** with `limit`/`cursor` on every list endpoint.
12. **Optimistic concurrency** — add `updated_at` to `If-Match`.
13. **Foreign keys + cascade** across all child tables in `db.js`.
14. **Retention / legal-hold workers** that actually prune.
15. **CSP without `'unsafe-inline'` / `'unsafe-eval'`** — migrate inline
   handlers in `app.js` and `index.html` to a nonce.
16. **Inline file disposition** → `attachment` for non-image, non-pdf
   MIMEs; magic-byte sniff before storing.
17. **Audit ledger durability** — fsync `_pending`, surface tamper-
   detection metric, alert on `audit insert failed`.
18. **GraphQL depth + complexity limits.**
19. **`uuid()`** → `crypto.randomUUID()`.
20. **Webhook payload storage** — separate `webhook_delivery_payloads`
   table; stop reading from audit log.
21. **Per-tenant signing key** — derive `FORGE_TENANT_KEY` per
   `organizations.tenant_key`; key history table.
22. **CORS default to `false`** outside dev; force operator to set.
23. **Drop `?token=` query auth** for non-SSE routes; SSE-only.

### Phase 3 — Operational hardening (P2)

24. **Externalize singletons** — Redis pub/sub for SSE, Postgres or
   BullMQ for outbox/workers; or document "single-replica only".
25. **Replace SQLite single-writer for HA tier** with Postgres
   (already explicit in `db.js` header comment).
26. **Distroless / chiseled runtime image**, drop `docs/` from copy.
27. **Cosign signature + SLSA provenance** in `release.yml`.
28. **Prometheus alerting rules + Grafana dashboards** in `deploy/`.
29. **Structured log envelope** with `tenant_id`, `actor_id`,
    `request_id`, `route` for SIEM ingest.
30. **Per-route body limits**, especially auth.
31. **Add `dependabot.yml`** (or Renovate) and bump `audit-level` to
    `moderate`.
32. **DOMPurify on every `innerHTML` write site.**
33. **Pin all base images by digest.**

### Phase 4 — Ongoing polish (P3)

34. Idempotency-key contract for POSTs.
35. Refresh tokens / sliding sessions.
36. Threat model + SECURITY.md + SLO doc.
37. Default-on tracing with low sample rate.
38. Audit-log signing-key rotation runbook.
39. Connector-level unit tests + i3X contract test.

## E. Developer-ready task list (selected)

Each task names a concrete file, the change, and a measurable acceptance
criterion.

| # | Task | File(s) | Acceptance |
|---|---|---|---|
| E1 | Add `where org_id = @org` to every `core.js` list query and accept `org_id` from `req.user.org_id` | `server/routes/core.js` (every `db.prepare("SELECT * FROM <table>")`) | Test: a U-1 from ORG-1 cannot see a row inserted with `org_id='ORG-2'` |
| E2 | Default ACL deny | `server/acl.js:16-23` | `parseAcl(null)` returns `{ roles: [], users: [], abac: {} }`; `allows(...)` returns `false` |
| E3 | Enforce token scopes in `require_` | `server/auth.js:99-107`, `server/main.js:139-165` | Test: `fgt_…` token with `["view"]` scope is denied on `POST /api/work-items` |
| E4 | Implement MFA challenge | new `server/mfa.js`, `server/routes/auth.js`, `server/db.js` migrations | Test: enabling MFA on a user causes `/api/auth/login` to return `{ mfaRequired: true }`; second-step accepts TOTP |
| E5 | Webhook SSRF guard | `server/webhooks.js`, `server/routes/webhooks.js` | Test: creating a webhook with URL `http://169.254.169.254/...` returns 400 |
| E6 | Replace `Math.random` `uuid()` with `crypto.randomUUID` | `server/db.js:851-854` | All inserts succeed; ids stay <= 36 chars |
| E7 | Add `WHERE org_id` to GraphQL resolvers | `server/graphql/resolvers.js:96-150` | Mirror E1 across GraphQL |
| E8 | Pagination: every `*list*` route accepts `limit` (≤200) and `cursor` (created_at) | `server/routes/core.js`, `server/routes/extras.js`, `server/routes/compliance.js` | Hits cap |
| E9 | Per-route Fastify schema | `server/routes/*.js` | `npm test` adds assertion: invalid bodies rejected |
| E10 | Drop `?token=` for non-SSE routes | `server/main.js:139-165`, `server/auth.js:89-94` | Bearer-only on `/api/*` except `/api/events/stream` |
| E11 | Move CSP to nonce-based, drop `'unsafe-inline'` | `server/main.js:97-110`, `app.js`, `index.html` | Lighthouse + manual: SPA loads with `script-src 'self' 'nonce-…'` |
| E12 | `uploads`: server-side magic-byte sniff + `Content-Disposition: attachment` for non-image/non-pdf | `server/routes/files.js:38-103` | Test: HTML upload served with `attachment`; SVG sanitized |
| E13 | Per-tenant audit signing key | `server/crypto.js`, `server/audit.js`, new `tenant_keys` table | Two tenants verify independently |
| E14 | Outbox payload table | new `outbox_payloads` table; remove `webhooks.js` audit-log lookup | Webhook deliveries succeed even with empty audit log |
| E15 | Retention sweep worker | new `server/retention.js` | Test: messages older than 1825 days hard-deleted unless under legal hold |
| E16 | OPC UA: require non-`None` security in production | `server/connectors/opcua.js:33-39`, `server/config.js` | Startup error if `nodeEnv === "production"` and policy is None |
| E17 | Login lockout | `server/routes/auth.js`, new `login_attempts` table | After 5 failures in 15 min, returns 429 |
| E18 | Foreign keys with `ON DELETE` for child tables | `server/db.js` | DB integrity check (`PRAGMA foreign_key_check`) returns 0 rows |
| E19 | Drop `docs/` and `PRODUCT_SPEC.md` from runtime image | `Dockerfile:56-57` | Image size shrinks; `docker run … cat docs/` 404s |
| E20 | Add `SECURITY.md`, `SECURITY.md`-linked `security@` and CVE coordination | repo root | File present; CI fails if missing |

## F. What's already enterprise-grade

For balance — features that already meet the bar:

- Hash-chained audit ledger with HMAC pack export and a verify endpoint.
- HMAC-signed approval decisions with chain-of-custody.
- Transactional outbox with bounded retries.
- Webhook dispatch with HMAC signatures + delivery state machine.
- ed25519-signed offline license tokens with feature flags.
- Helmet + HSTS + strict-origin-when-cross-origin referrer.
- CycloneDX SBOM published per CI run.
- Multi-OS / multi-Node CI matrix with explicit version pinning of
  third-party actions by SHA.
- Container HEALTHCHECK and tini PID-1.
- Pino structured logging, prom-client metrics, OpenTelemetry hook.

These are kept as the baseline; the gaps above are the delta to reach
"enterprise-ready" in procurement / SecOps / compliance reviews.

## G. Methodology

Read `AGENTS.md`, `.cursor/skills/runbook.md`, and the enterprise UX
audit baseline. Inspected: `package.json`, `server/main.js`,
`server/config.js`, `server/db.js`, `server/auth.js`, `server/acl.js`,
`server/audit.js`, `server/crypto.js`, `server/tokens.js`,
`server/sse.js`, `server/events.js`, `server/outbox.js`,
`server/webhooks.js`, `server/ai.js`, `server/alerts.js`,
`server/backup.js`, `server/license.js`, `server/metrics.js`,
`server/tracing.js`, `server/seed.js`, all of `server/routes/*.js`,
`server/connectors/*.js`, `server/graphql/resolvers.js`,
`server/integrations/registry.js`, `Dockerfile`, `docker-compose.yml`,
`.github/workflows/ci.yml`, `.env.example`,
`src/core/{ui,acl,groups,permissions,api,audit,store,search}.js`, all of
`src/shell/*.js`, and a representative slice of `src/screens/*.js`.

No code is changed in this audit; it is a reference for follow-up PRs
that should each tackle a single P0/P1 task end-to-end with tests.
