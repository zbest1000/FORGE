# FORGE threat model

STRIDE per surface. Each section names the assets behind the
boundary, identifies the most plausible threats, and links to the
mitigations already in place (with file paths) or to backlog items
in `docs/ENTERPRISE_READINESS_AUDIT.md`.

This document is a starting point for a security review; it is not
a formal certification artefact. Update it whenever a new external
surface is added (a new connector, a new public endpoint, a new
file format ingested).

## Trust boundaries

```
   ┌─────────────────────┐
   │   public internet   │
   └──────────┬──────────┘
              │
   ┌──────────┴──────────┐
   │ reverse proxy / CDN │  ← TLS terminates here
   └──────────┬──────────┘
              │
   ┌──────────┴──────────┐
   │  FORGE container    │  ← node:bookworm-slim, tini PID-1
   │  - Fastify          │
   │  - SQLite (WAL)     │
   │  - workers          │
   └──┬───────────────┬──┘
      │               │
  ┌───┴────┐    ┌─────┴──────┐
  │  MQTT  │    │  webhooks  │  ← outbound to receivers
  │ broker │    │   AI APIs  │
  └────────┘    └────────────┘
```

The dashed lines are trust boundaries. Anything inside the FORGE
container is trusted; everything outside is not, including the
operator's own MQTT broker and AI provider.

## A. Web client surface

**Assets.** SPA bundle, session JWT, refresh token, login email,
license token (server-bound).

| STRIDE | Threat | Mitigation |
|---|---|---|
| **S** Spoofing | Stolen access JWT replayed | Sessions table (v8) binds `sid + jti`; `revoke-all` invalidates outstanding tokens. |
| **T** Tampering | XSS injects HTML/JS via uploaded file | `Content-Disposition: attachment` for non-image/pdf, server-side magic-byte sniff. CSP allows `unsafe-inline` (B.7 #1; backlog). |
| **R** Repudiation | User denies an action | Hash-chained audit ledger (`server/audit.js`); HMAC-signed approvals (`server/crypto.js`). Periodic verifyLedger worker (`server/audit-tamper.js`). |
| **I** Info disclosure | Cross-tenant data via unscoped queries | Tenant scope on every list/get (`server/tenant.js`); audit_log.org_id added in v11. |
| **D** Denial of service | Mass login attempts | Per-account login lockout (`server/security/lockout.js`) + global rate-limit. |
| **E** Elevation | Token-scope bypass | `require_(capability)` checks both role caps AND token scopes (`server/auth.js`). |

## B. REST + GraphQL API

**Assets.** Domain data, audit log, license state, integration
secrets.

| STRIDE | Threat | Mitigation |
|---|---|---|
| **S** | Forged JWT | `FORGE_JWT_SECRET` strictly required in production (`server/config.js`). |
| **T** | Mass-assignment via PATCH | PATCH endpoints whitelist allowed columns; body schema validates types (Phase 4). |
| **R** | Modify-after-the-fact | ETag / If-Match returns 412 on stale writes. |
| **I** | DSAR exports leaking third-party PII | Redaction in `server/compliance.js` masks third-party user ids; other users' messages excluded. |
| **D** | Deeply nested GraphQL query | `queryDepth` + alias cap in `server/main.js`. |
| **E** | Schema introspection in prod | GraphIQL is opt-in via `FORGE_GRAPHIQL=1` only. |

## C. Audit ledger

**Assets.** Hash-chained `audit_log`, HMAC-signed export packs.

| STRIDE | Threat | Mitigation |
|---|---|---|
| **T** | Direct SQL UPDATE on a row mid-chain | `verifyLedger()` walks the chain; periodic worker exposes `forge_audit_chain_ok` gauge; `audit.tamper.detected` marker is appended on detection. |
| **T** | Re-export pack with mutated content | Pack signature uses HMAC-SHA256 with `FORGE_TENANT_KEY`; `verifyAuditPack` re-derives the signature. |
| **I** | `actor = email plaintext` for failed logins | Email is hashed via SHA-256 prefix before audit (`server/routes/auth.js#hashEmailForAudit`). |
| **D** | Append-only growth | Retention worker (B.4 #6) is intentionally NOT applied to `audit_log`; operators prune via a separate signed CLI. |

## D. SSE backplane

**Assets.** Real-time event stream.

| STRIDE | Threat | Mitigation |
|---|---|---|
| **S** | Token leak via `?token=` in proxy logs | `?token=` accepted ONLY on `/api/events/stream` and `/v1/subscriptions/stream` (`server/main.js`). |
| **D** | Slow consumer holds the heap | Per-client bounded queue + drain timeout in `server/sse.js`; queue overflow drops oldest events with a `dropped` notice. |
| **D** | Many concurrent connections | Default queue 256 events × ~256 bytes = ~65 KB per client; tunable via `FORGE_SSE_MAX_QUEUE`. |

## E. MQTT bridge

**Assets.** Industrial telemetry, broker credentials.

| STRIDE | Threat | Mitigation |
|---|---|---|
| **S** | Credential theft | Creds in env (`FORGE_MQTT_USERNAME` / `FORGE_MQTT_PASSWORD`); rotation is operator-driven. Backlog: per-tenant creds + rotation UI (B.9 #3). |
| **T** | Message replay | `dedupe_key` opt-in by producer (`server/events.js`). |
| **D** | Topic flood | No back-pressure on the bridge today (B.5 #4 backlog). |

## F. OPC UA bridge

**Assets.** Plant telemetry, industrial system identity.

| STRIDE | Threat | Mitigation |
|---|---|---|
| **S** | MITM | Production strict mode rejects `SecurityPolicy.None` (`server/connectors/opcua.js`); operator must configure cert chain. |
| **T** | Forged variable updates | Bridge reads only; node ids checked against `assets.opcua_nodes`. |

## G. Webhook dispatcher

**Assets.** Outbound webhook secret, receiver URL.

| STRIDE | Threat | Mitigation |
|---|---|---|
| **S** | Receiver spoof | HMAC-SHA256 signature in `X-FORGE-Signature` header — receivers verify. |
| **T** | Tampered payload | Signature covers the entire body. |
| **R** | Receiver denies receipt | DLQ envelope captures attempts + last error. |
| **I** | SSRF to cloud metadata | URL validated by `server/security/outbound.js`: rejects loopback, link-local, private ranges, internal hostnames; production strict mode requires HTTPS. |
| **D** | Receiver drops 5xx storm | Per-attempt back-off (5s → 30m), max 6 attempts, then DLQ. |

## H. License surface

**Assets.** ed25519-signed license token, activation token, customer
identity.

| STRIDE | Threat | Mitigation |
|---|---|---|
| **S** | Forged license | ed25519 verification on parse (`server/license.js`). |
| **T** | Mutated token | Tampered token fails `verify()`; the test suite has the regression coverage. |
| **R** | Customer denies activation | Activation token + last-writer-wins reclaim recorded by the local license server. |

## I. File uploads

**Assets.** Stored blobs (`./data/uploads`), associated metadata.

| STRIDE | Threat | Mitigation |
|---|---|---|
| **T** | Polyglot file (HTML inside .pdf) | Magic-byte sniff before accept; `Content-Disposition: attachment` for non-image/non-pdf MIME. |
| **I** | Path traversal in `name` | `name` is taken from the multipart header but never used as a path component server-side. |
| **D** | 50 MB upload spam | `bodyLimit: 10 MB` on JSON; `multipart.fileSize: 50 MB`; rate-limit applies. |

## J. Database surface (operator)

**Assets.** SQLite file on disk.

| STRIDE | Threat | Mitigation |
|---|---|---|
| **T** | Direct SQL update bypassing the API | Audit chain detects mid-chain mutation. Backlog: row-level encryption (B.4 #8). |
| **I** | Backup file leak | Backup CLI today produces unencrypted tar. Backlog: encrypt with operator-supplied key (B.5 #11). |

## K. Build / supply chain

**Assets.** npm dependency tree, container image, GitHub Actions
workflow definitions.

| STRIDE | Threat | Mitigation |
|---|---|---|
| **T** | Compromised npm package | `package-lock.json` pinned; Dependabot opens PRs (B.10 #9 backlog: enable broader Renovate). |
| **T** | Compromised CI step | All third-party actions pinned by SHA in `.github/workflows/*`. |
| **I** | Container leaks docs | Dockerfile drops `docs/` from the runtime image. |
| **R** | Build provenance | Backlog (B.10 #2): SLSA + cosign on releases. |

## Future surfaces (not yet shipped)

When the following surfaces are added, extend this document before
release:

- SSO / SAML / OIDC IdP integration (B.1 #2).
- SCIM 2.0 user provisioning.
- ClamAV / sandboxed virus scanning of uploads.
- Postgres engine path (B.5 #2).
- External pub/sub (Redis / NATS) for SSE backplane (B.5 #3).
