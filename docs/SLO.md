# FORGE service-level objectives

This document records the availability and integrity targets the
FORGE server commits to. Operators of self-hosted deployments can
copy these as a starting point and tighten them per their own
infrastructure.

> Status: **draft / aspirational**. The SLIs below are exposed today
> via Prometheus; the SLO targets are recommendations until
> validated against six months of production data.

## Service-level indicators

| SLI | Source | What it measures |
|---|---|---|
| HTTP 5xx rate | `forge_http_requests_total{status=~"5.."}` / `forge_http_requests_total` | Server errors per request |
| HTTP p95 latency | `histogram_quantile(0.95, sum by (le, route) (rate(forge_http_request_seconds_bucket[5m])))` | Tail latency for API calls |
| Audit chain integrity | `forge_audit_chain_ok` | Tamper-detection canary |
| SSE drop rate | Number of `dropped` events emitted / total broadcasts | Real-time fan-out backpressure |
| Outbox lag | `outbox_events.created_at` - `published_at` | Event delivery latency |
| Webhook delivery success rate | `(delivered) / (delivered + failed)` from `webhook_deliveries` | Outbound integration health |

## Service-level objectives

### Availability

- **REST + GraphQL** ≥ **99.5%** monthly. Error budget: ~3 h 39 min
  per 30-day month.
  - 5xx rate < 0.5% of total requests over a rolling 5-min window.
  - p95 latency < 500ms for `/api/work-items`, `/api/documents`,
    `/api/search`. p99 < 2s.
- **Auth** ≥ **99.9%** monthly. The `/api/auth/login`,
  `/api/auth/refresh`, and `/api/auth/mfa/verify` endpoints are
  the most painful to fail. Error budget: ~43 min/month.

### Integrity

- **Audit chain integrity** ≥ **100%** monthly. Any
  `forge_audit_chain_ok == 0` is a paging incident, not an SLO
  burn.
- **Tenant isolation** ≥ **100%** — there is no acceptable rate of
  cross-tenant data leakage. Every confirmed cross-tenant read or
  write is a Sev-1 security incident, regardless of impact.

### Real-time

- **SSE drop rate** < **1%** monthly. Drops are bounded per-client
  (`FORGE_SSE_MAX_QUEUE`), so this measures clients hitting the
  cap and silently re-syncing via REST.

### Webhook delivery

- **Delivery success rate** ≥ **98%** monthly excluding receiver
  outages > 1h. Delivery is reattempted at 5s/15s/1m/5m/30m
  back-off; anything that doesn't succeed in 6 attempts ends up in
  the DLQ.

## Recommended Prometheus alerts

```yaml
# Audit chain tamper — Sev 1 / page immediately.
- alert: ForgeAuditChainTampered
  expr: forge_audit_chain_ok == 0
  for: 5m
  labels: { severity: critical }
  annotations:
    summary: "FORGE audit ledger tampering detected"
    runbook: "docs/INCIDENT_RUNBOOK.md#a-audit-ledger-tamper-alert"

# 5xx burn — Sev 2.
- alert: ForgeHigh5xxRate
  expr: |
    sum(rate(forge_http_requests_total{status=~"5.."}[5m]))
      / sum(rate(forge_http_requests_total[5m])) > 0.005
  for: 10m
  labels: { severity: warning }
  annotations:
    summary: "FORGE 5xx rate above 0.5% for 10m"

# Auth latency.
- alert: ForgeAuthSlow
  expr: |
    histogram_quantile(0.95,
      sum by (le, route) (rate(forge_http_request_seconds_bucket{route=~"/api/auth/.*"}[5m]))
    ) > 1.0
  for: 10m
  labels: { severity: warning }

# DLQ backlog.
- alert: ForgeDlqBackup
  expr: forge_dlq_open > 100
  for: 15m
  labels: { severity: warning }
  annotations:
    runbook: "docs/INCIDENT_RUNBOOK.md#b-webhook-dlq-build-up"

# Liveness.
- alert: ForgeDown
  expr: up{job="forge"} == 0 OR forge_up == 0
  for: 5m
  labels: { severity: critical }
```

## Error-budget policy

When an SLO burns through more than 50% of its monthly budget, the
team:

1. Pauses non-essential change (no new feature deploys; bug fixes
   and security patches still ship).
2. Opens a focused remediation ticket against the SLO and
   prioritises it ahead of new work.
3. Reviews the SLO target itself — if the budget is exhausted in
   normal-load months, the target is too aggressive for the
   current architecture.

When the budget is exhausted (100% burn), incident response shifts:

- Sev-2 issues become Sev-1 for paging purposes.
- Sev-3 issues escalate to Sev-2.
- The next regular release is held until the budget recovers.

## How the SLOs connect to other docs

- **Detection** is wired in `server/audit-tamper.js` (chain),
  `server/metrics.js` (HTTP), `server/sse.js` (drops),
  `server/outbox.js` and `server/webhooks.js` (delivery).
- **Response** is captured in `docs/INCIDENT_RUNBOOK.md`.
- **Threat model** lives in `docs/THREAT_MODEL.md`.
- **Findings backlog** is in `docs/ENTERPRISE_READINESS_AUDIT.md`.
