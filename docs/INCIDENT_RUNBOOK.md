# FORGE incident response runbook

Operational playbook for FORGE service incidents. Audience: SREs and
on-call engineers running a self-hosted FORGE deployment. For the
in-app incident workflow (the user-facing engineering / industrial
incident management surface) see the `Incidents` screen in the SPA.

This runbook is intentionally short. Each section follows the same
structure: **Detect → Contain → Eradicate → Recover → Post-incident**.

## Severity levels

| Sev | Rough criterion                                    | Initial response |
|-----|----------------------------------------------------|------------------|
| 1   | Total outage or data integrity at risk             | Page on-call, escalate to engineering lead immediately |
| 2   | Major feature degraded; some tenants impacted      | Page on-call, status page notice within 30 min |
| 3   | Single tenant impacted or single feature degraded  | Ticket; on-call works during business hours |
| 4   | Cosmetic / observability issue                     | Backlog |

## Common alerts

The Prometheus alert names referenced below are the recommended
defaults — see `docs/SLO.md` for full PromQL.

### A. Audit-ledger tamper alert (`forge_audit_chain_ok == 0`)

**Severity:** 1 (data integrity)

**Detect.** The periodic verifier (`server/audit-tamper.js`) flips
the `forge_audit_chain_ok` gauge to 0 and emits a
`audit.tamper.detected` row. Alert fires after 5 minutes of `== 0`.
The pino log line carries `reason` (`prev_hash mismatch`,
`hash mismatch`) and `firstBadIndex` (the bad row's seq).

**Contain.**
1. Snapshot the live DB immediately:
   ```bash
   sqlite3 ./data/forge.db ".backup ./data/forge.db.tamper-$(date +%s)"
   ```
2. Stop new writes that depend on the chain — easiest via reverse
   proxy: 503 every `/api/*` route except `/api/health`.
3. Capture the last 24 h of pino logs and `/metrics` snapshot.

**Eradicate.**
1. Open the tampered row by `seq`:
   ```bash
   sqlite3 forge.db "SELECT * FROM audit_log WHERE seq = <firstBadIndex>"
   ```
2. Compare with the most recent backup (the migration snapshot
   `forge.db.bak-*` produced before the schema upgrade is a good
   baseline; the nightly tar archive is another).
3. Identify intent: storage corruption, a debugger reaching into
   SQLite directly, or an actual breach? The hash chain only tells
   you tampering occurred; correlate with `auth.login` rows around
   the same `ts`, OS-level audit, and reverse-proxy logs.

**Recover.**
- If the breach is confirmed and the bad row was inserted by a
  user with write access: rotate the JWT secret + tenant key
  (`FORGE_JWT_SECRET`, `FORGE_TENANT_KEY`), revoke every API
  token, force-logout every session via
  `POST /api/auth/sessions/revoke-all`, then unfreeze the
  service.
- If the breach is storage-level: restore from the nearest clean
  backup. The hash chain is append-only — there is no in-place
  repair without losing tamper-evidence.

**Post-incident.**
- File a regulatory-incident record via
  `POST /api/compliance/incidents/:id/regulatory-report`.
- Add a public-relations note to the status page if any tenant data
  was exposed.
- Add a regression test to `test/audit-tamper.test.js` that
  reproduces the tampering pattern.

### B. Webhook DLQ build-up

**Detect.** `forge_dlq_open` gauge > 100 for 15 min, OR
`X-FORGE-Delivery` failing repeatedly in webhook receiver logs.

**Contain.**
1. Disable the noisy webhook:
   `PATCH /api/webhooks/<id>` body `{ enabled: false }`.
2. Confirm the receiver isn't the actual victim — many DLQ rows
   from one webhook usually means the receiver is down.

**Eradicate.**
1. Inspect the DLQ envelopes:
   ```bash
   curl -H "Authorization: Bearer $TOKEN" \
        http://localhost:3000/api/dlq | jq .
   ```
2. Replay any envelope whose root cause is now resolved:
   `POST /api/dlq/<id>/replay`.
3. For rate-limit / 5xx storms: keep the webhook disabled until the
   receiver SLO recovers, then re-enable.

**Recover.** Re-enable the webhook. The dispatcher's per-attempt
back-off (5s → 5m → 30m) means the queue drains gracefully.

**Post-incident.** Add the receiver's `X-FORGE-Delivery` ID range to
the postmortem. Consider opening a circuit breaker against that
receiver (B.5 #4 in the audit doc).

### C. SSE backplane full

**Detect.** SSE clients receive
`event: dropped\ndata: { count: …, reason: "queue_overflow" }` and
the dashboard goes blank. `forge_up == 1` but several clients hit
DRAIN_TIMEOUT.

**Contain.** Increase the per-client queue cap on the next restart:
```
FORGE_SSE_MAX_QUEUE=1024 FORGE_SSE_DRAIN_TIMEOUT_MS=60000 npm start
```
Restart the server with these envs. Existing clients will reconnect
automatically (the SPA's `EventSource` retries every 3 s).

**Eradicate.** Identify the slow consumer in pino logs (look for
`drain_timeout` reasons). Usually a paused tab in DevTools or a
proxy doing buffering. Disconnect and restart the offender.

**Recover.** The default queue size is `256`. Most deployments don't
need more than that — only raise it if you're broadcasting a high
volume of small events (>1 event/s).

**Post-incident.** If raising the cap is permanent, document the
new value in your deployment readme and AGENTS.md.

### D. OPC UA bridge auth failure

**Detect.** pino warning `OPC UA bridge: connect failed` repeated.

**Contain.** Confirm the bridge is intentionally enabled:
`FORGE_OPCUA_URL` + `FORGE_OPCUA_SECURITY_POLICY != None` in the
env. Without these, FORGE refuses to start in production strict
mode (`server/connectors/opcua.js`).

**Eradicate.** Common causes:
1. Certificate expired / not trusted by the OPC UA server. Reissue
   via `node-opcua-pki create_certificate ...`.
2. Server requires a different SecurityPolicy. Try `Basic256Sha256`.
3. Network ACL blocks the FORGE pod's egress.

**Recover.** Bridge reconnects automatically once the underlying
issue is fixed.

### E. Database corruption

**Detect.** Server startup fails with `database disk image is
malformed` or `PRAGMA integrity_check` returns errors.

**Contain.** Stop the server. Do not write to the DB.

**Eradicate.**
1. Try `sqlite3 forge.db .recover > recovered.sql`.
2. Restore the most recent migration snapshot
   (`./data/forge.db.bak-*`) or your nightly tar backup.
3. If neither is available, run `sqlite3 forge.db "PRAGMA
   integrity_check"` to identify the bad pages and selectively
   re-create them.

**Recover.** Replay any audit pack you exported since the last
backup so the chain stays consistent.

**Post-incident.** Move to nightly `VACUUM INTO` snapshots if you
were not already running them. See `server/backup.js`.

### F. License-server tamper / supersession

**Detect.** `/api/license` returns `status: superseded` or
`status: revoked`, or signature verification fails on boot.

**Contain.** Capabilities downgrade to the Community plan
automatically; the SPA shows a warning banner. Paid features (RBAC,
graphQL, webhooks, …) start returning 402.

**Eradicate.**
1. Confirm with the license server operator that this is intended
   (a customer activated the same license elsewhere).
2. If unintended (clock skew, stolen key), rotate the activation
   token and re-install the license.

**Recover.** Restart with the new license; activation re-pulls
within one heartbeat (default 24 h, override with
`FORGE_LOCAL_LS_HEARTBEAT_S`).

## On-call checklist

When you're paged, the first 10 minutes look like this:

1. Acknowledge the page.
2. Open the dashboard for the relevant SLO. Confirm scope (single
   tenant / global, single instance / fleet-wide).
3. Open the audit ledger:
   `curl … /api/audit?limit=200 | jq .`
4. Cross-reference the most recent `audit.*` rows with the alerting
   timeline. The `actor` field tells you who/what did the last
   write; for system events the `actor` is `system` /
   `webhooks` / `retention`.
5. Decide severity, communicate, and proceed to the matching
   playbook above.

## Communication templates

**Status page initial post (Sev 1/2):**

> We are investigating an issue affecting <SCOPE>. The team is
> engaged. Next update in 15 min.

**Resolution post:**

> The issue affecting <SCOPE> has been resolved at <UTC TIME>. Root
> cause: <ONE LINE>. We will publish a full postmortem within 5
> business days at <LINK>.

## Postmortem template

A postmortem is required for every Sev 1, recommended for Sev 2.
File at `docs/postmortems/YYYY-MM-DD-<short-title>.md`.

```
# Postmortem: <title>

- Date: YYYY-MM-DD
- Duration: <start> → <end> (UTC)
- Severity: 1 / 2
- Author(s): <names>

## Summary

One paragraph.

## Impact

Who saw what, for how long.

## Timeline (UTC)

- HH:MM — first symptom
- HH:MM — paged
- HH:MM — diagnosis
- HH:MM — mitigation
- HH:MM — resolution

## Root cause

What broke and why.

## What went well

## What went poorly

## Action items

| # | Item | Owner | Due | Tracking |
|---|------|-------|-----|----------|
| 1 | …    | …     | …   | …        |
```
