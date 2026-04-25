# FORGE × n8n workflow templates

These three workflows demonstrate the FORGE/n8n integration patterns.
Import them into n8n via **Workflows → Import → from file** (or copy from
the mounted `/templates` volume in `docker-compose.yml`).

## 1. `forge-incident-to-slack.json`

n8n receives FORGE's signed outbound webhook, **verifies the
HMAC-SHA256 signature** against `FORGE_WEBHOOK_SECRET`, filters for
`event_type == "alarm"`, and posts to Slack.

Required env on the n8n side:
- `FORGE_WEBHOOK_SECRET` — copied from FORGE Admin → Webhooks → secret
- `SLACK_WEBHOOK_URL`     — Slack incoming-webhook URL

Setup in FORGE:
1. Admin → Webhooks → **+ Add**
   - URL: `http://n8n:5678/webhook/forge-incident`
   - Events: `*` (or `alarm`)
2. Copy the secret shown once → set as `FORGE_WEBHOOK_SECRET` in n8n.

## 2. `erp-po-to-workitem.json`

ERP system POSTs a PO event to n8n's webhook. n8n calls FORGE's
**GraphQL** mutation `createWorkItem` with the ERP fields mapped to
type/title/severity.

Required env on the n8n side:
- `FORGE_URL`         — e.g. `http://forge:3000`
- `FORGE_API_TOKEN`   — long-lived `fgt_…` token from FORGE Admin → API tokens
- `FORGE_PROJECT_ID`  — destination project for new tasks

## 3. `mqtt-alarm-to-incident.json`

n8n's MQTT trigger subscribes to `plant/+/alarm/#`, then ingests each
message into FORGE's **canonical event pipeline** (which routes to
incident/work item/asset timeline per spec §9.3).

Required env on the n8n side:
- `FORGE_URL` and `FORGE_API_TOKEN`
- An MQTT credential pointing at your broker (Mosquitto, EMQX, …).

## Why both directions?

- **Inbound (n8n → FORGE)**: 400+ pre-built connectors (SAP, ServiceNow,
  Jira, M365, etc.) drop into FORGE's REST + GraphQL surface, so an
  operator can wire any external system to the canonical event pipeline
  without writing code.
- **Outbound (FORGE → n8n)**: signed webhooks let n8n's no-code editor
  branch on FORGE events (incidents, approvals, revision transitions)
  and post to Slack/Email/PagerDuty/Teams/etc.
