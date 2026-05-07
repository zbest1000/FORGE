// Outbound webhooks with HMAC-SHA256 signed callbacks (spec §9.1).
// A webhook row declares a URL, a list of event types, and a secret. Every
// dispatched payload is signed:
//     X-FORGE-Signature: sha256=<hex(HMAC(secret, body))>
//     X-FORGE-Event:     <event_type>
//     X-FORGE-Delivery:  <uuid>
//
// Failures update `last_error` and are visible in the admin UI; they do not
// block the emitting transaction. Retries can be driven by the DLQ.

import crypto from "node:crypto";
import { db, now, uuid } from "./db.js";
import { audit } from "./audit.js";
import { traceContextCarrier, withSpan } from "./tracing.js";
import { validateOutboundUrl } from "./security/outbound.js";

function sign(secret, body) {
  return "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
}

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

const insertPayload = db.prepare("INSERT OR REPLACE INTO webhook_delivery_payloads (delivery_id, body, created_at) VALUES (?, ?, ?)");
const selectPayload = db.prepare("SELECT body FROM webhook_delivery_payloads WHERE delivery_id = ?");
const deletePayload = db.prepare("DELETE FROM webhook_delivery_payloads WHERE delivery_id = ?");

export function listWebhooks() {
  return db.prepare("SELECT id, name, url, events, enabled, last_success_at, last_error, last_error_at, created_at, created_by FROM webhooks ORDER BY created_at DESC").all()
    .map(r => ({ ...r, events: JSON.parse(r.events || "[]"), enabled: !!r.enabled }));
}

export function createWebhook({ name, url, events = ["*"], secret = null, createdBy = null }) {
  const validated = validateOutboundUrl(url);
  if (!validated.ok) {
    const err = new Error(`webhook url rejected: ${validated.reason}`);
    err.statusCode = 400;
    err.code = validated.reason;
    throw err;
  }
  const id = uuid("WH");
  const row = {
    id, name, url,
    events: JSON.stringify(events),
    secret: secret || crypto.randomBytes(24).toString("hex"),
    enabled: 1,
    last_success_at: null, last_error: null, last_error_at: null,
    created_by: createdBy,
    created_at: now(),
  };
  db.prepare(`INSERT INTO webhooks (id, name, url, events, secret, enabled, last_success_at, last_error, last_error_at, created_by, created_at)
              VALUES (@id, @name, @url, @events, @secret, @enabled, @last_success_at, @last_error, @last_error_at, @created_by, @created_at)`).run(row);
  audit({ actor: createdBy || "system", action: "webhook.create", subject: id, detail: { url, events } });
  return { ...row, events, enabled: true };
}

export function toggleWebhook(id, enabled, actor) {
  // Re-enabling a webhook clears the breaker — the operator has manually
  // signalled they believe the endpoint is healthy again. Disabling
  // leaves the breaker state alone (it's harmless while disabled and
  // preserves diagnostic context if the webhook is re-enabled later
  // without intervention).
  if (enabled) {
    db.prepare("UPDATE webhooks SET enabled = 1, consecutive_failures = 0, circuit_open_until = NULL WHERE id = ?").run(id);
  } else {
    db.prepare("UPDATE webhooks SET enabled = 0 WHERE id = ?").run(id);
  }
  audit({ actor, action: "webhook.toggle", subject: id, detail: { enabled } });
}

export function deleteWebhook(id, actor) {
  db.prepare("DELETE FROM webhooks WHERE id = ?").run(id);
  audit({ actor, action: "webhook.delete", subject: id });
}

/**
 * Dispatch an event to all matching webhooks. Persists a delivery row per
 * matching webhook so a worker can retry with exponential back-off
 * (spec §9.1 "retries"). Returns immediately.
 */
export function dispatchEvent(eventType, payload) {
  const rows = db.prepare("SELECT * FROM webhooks WHERE enabled = 1").all();
  if (!rows.length) return;
  const match = (spec) => {
    const list = JSON.parse(spec || "[]");
    if (!list.length || list.includes("*")) return true;
    return list.includes(eventType);
  };
  const eventId = (payload && payload.event_id) || uuid("WHD");
  for (const row of rows) {
    if (!match(row.events)) continue;
    // Don't even queue against an open circuit — the operator gets a
    // single audit entry per breaker trip (above), not one per skipped
    // event, otherwise a busy stream of events generates pages of noise.
    if (circuitOpen(row)) continue;
    const id = uuid("delivery").toLowerCase();
    const ts = now();
    // Persist the delivery + payload in one transaction so the worker
    // can rely on the body being present whenever a delivery row is.
    db.transaction(() => {
      db.prepare(`INSERT INTO webhook_deliveries (id, webhook_id, event_id, event_type, attempt, status, last_error, next_attempt_at, delivered_at, created_at)
                  VALUES (@id, @wh, @ev, @type, 0, 'pending', NULL, @now, NULL, @now)`)
        .run({ id, wh: row.id, ev: eventId, type: eventType, now: ts });
      insertPayload.run(id, JSON.stringify(payload ?? {}), ts);
    })();
    // Audit the queueing event WITHOUT the body. The body lives in
    // webhook_delivery_payloads; only summary metadata enters the
    // immutable hash chain so it can be pruned on a normal retention
    // schedule.
    audit({ actor: "webhooks", action: "webhook.queued", subject: row.id, detail: { deliveryId: id, eventType, eventId } });
  }
  // Kick the worker if not already running.
  ensureWorker();
}

const MAX_ATTEMPTS = 6;
const BACKOFF_MS = [0, 5_000, 15_000, 60_000, 5*60_000, 30*60_000]; // 0s, 5s, 15s, 1m, 5m, 30m
// Circuit breaker tunables. After this many consecutive delivery failures
// the webhook's circuit opens for the configured cooldown — `dispatchEvent`
// + `tick()` both skip while open. A successful delivery resets the
// counter and clears the timestamp; toggling the webhook off+on via the
// admin UI also forcibly clears the breaker.
const BREAKER_THRESHOLD = Number(process.env.FORGE_WEBHOOK_BREAKER_THRESHOLD || 5);
const BREAKER_OPEN_MS = Number(process.env.FORGE_WEBHOOK_BREAKER_OPEN_MS || 24 * 60 * 60 * 1000);
let _workerHandle = null;

/** Returns true when the webhook is in an open-circuit state right now. */
function circuitOpen(wh) {
  const until = wh.circuit_open_until;
  if (!until) return false;
  if (new Date(until).getTime() > Date.now()) return true;
  // Cooldown elapsed — reset so the next attempt is allowed through.
  db.prepare("UPDATE webhooks SET circuit_open_until = NULL WHERE id = ?").run(wh.id);
  return false;
}

/** On successful delivery, reset the breaker bookkeeping. */
function noteSuccess(webhookId) {
  db.prepare("UPDATE webhooks SET consecutive_failures = 0, circuit_open_until = NULL, last_success_at = ?, last_error = NULL, last_error_at = NULL WHERE id = ?")
    .run(now(), webhookId);
}

/** On failure, bump the counter and open the circuit if we've crossed the threshold. */
function noteFailure(webhookId, errMsg) {
  const row = db.prepare("SELECT consecutive_failures FROM webhooks WHERE id = ?").get(webhookId);
  const next = (row?.consecutive_failures || 0) + 1;
  if (next >= BREAKER_THRESHOLD) {
    const openUntil = new Date(Date.now() + BREAKER_OPEN_MS).toISOString();
    db.prepare("UPDATE webhooks SET consecutive_failures = ?, circuit_open_until = ?, last_error = ?, last_error_at = ? WHERE id = ?")
      .run(next, openUntil, errMsg, now(), webhookId);
    audit({ actor: "webhooks", action: "webhook.circuit.opened", subject: webhookId, detail: { consecutiveFailures: next, openUntil, threshold: BREAKER_THRESHOLD } });
  } else {
    db.prepare("UPDATE webhooks SET consecutive_failures = ?, last_error = ?, last_error_at = ? WHERE id = ?")
      .run(next, errMsg, now(), webhookId);
  }
}

function ensureWorker() {
  if (_workerHandle) return;
  _workerHandle = setInterval(tick, 5_000);
  if (typeof _workerHandle.unref === "function") _workerHandle.unref();
}

/**
 * Stop the in-process delivery loop. Lets the current `tick()` finish so
 * any HTTP fetch in flight is awaited; the next tick simply will not
 * fire. Called from the graceful shutdown sequence.
 */
export function stopWebhookWorker() {
  if (_workerHandle) clearInterval(_workerHandle);
  _workerHandle = null;
}

async function tick() {
  // Pick up to 20 due deliveries in `pending` or `failed-retry` state.
  const due = db.prepare(`
    SELECT * FROM webhook_deliveries
    WHERE status IN ('pending','failed-retry')
      AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
    ORDER BY created_at
    LIMIT 20
  `).all(now());
  if (!due.length) return;
  for (const d of due) {
    const wh = db.prepare("SELECT * FROM webhooks WHERE id = ?").get(d.webhook_id);
    if (!wh || !wh.enabled) {
      db.prepare("UPDATE webhook_deliveries SET status = 'cancelled' WHERE id = ?").run(d.id);
      deletePayload.run(d.id);
      continue;
    }
    // Skip while circuit is open — the delivery row stays `pending` so
    // it'll be picked up automatically once the cooldown elapses (see
    // circuitOpen()'s self-clearing branch).
    if (circuitOpen(wh)) continue;
    // Recover the body from the dedicated payloads table. Falling back
    // to an empty object keeps the dispatcher robust if the row was
    // pruned out from underneath it (audit chain stays clean either
    // way).
    const stored = selectPayload.get(d.id);
    const payload = stored ? (safeParse(stored.body) ?? {}) : {};
    const wireBody = JSON.stringify({ id: uuid("WHD"), type: d.event_type, ts: new Date().toISOString(), payload });
    const signature = sign(wh.secret, wireBody);
    const attempt = d.attempt + 1;
    const validated = validateOutboundUrl(wh.url);
    if (!validated.ok) {
      db.prepare("UPDATE webhook_deliveries SET status = 'failed', attempt = ?, last_error = ? WHERE id = ?")
        .run(attempt, `unsafe_url:${validated.reason}`, d.id);
      deletePayload.run(d.id);
      audit({ actor: "webhooks", action: "webhook.failed", subject: wh.id, detail: { deliveryId: d.id, attempt, error: `unsafe_url:${validated.reason}` } });
      continue;
    }
    try {
      // Wrap the network leg in a custom span so operators can see
      // per-webhook delivery latency + status in their tracing
      // backend. No-ops cleanly when OTel isn't enabled.
      const t0 = Date.now();
      const res = await withSpan("webhook.deliver", {
        webhook_id: wh.id,
        event_type: d.event_type,
        attempt,
        delivery_id: d.id,
      }, async (span) => {
        const ac = new AbortController();
        const tmo = setTimeout(() => ac.abort(), 8000);
        try {
          const r = await fetch(wh.url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "X-FORGE-Signature": signature,
              "X-FORGE-Event": d.event_type,
              "X-FORGE-Delivery": d.id,
              "X-FORGE-Attempt": String(attempt),
              ...traceContextCarrier({ traceId: payload?.trace_id }),
            },
            body: wireBody,
            signal: ac.signal,
          });
          span.setAttribute("http.status_code", r.status);
          span.setAttribute("forge.latency_ms", Date.now() - t0);
          return r;
        } finally { clearTimeout(tmo); }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      db.prepare("UPDATE webhook_deliveries SET status = 'delivered', delivered_at = ?, attempt = ?, last_error = NULL WHERE id = ?")
        .run(now(), attempt, d.id);
      // Resets consecutive_failures + circuit_open_until in addition to
      // last_success_at / last_error fields.
      noteSuccess(wh.id);
      deletePayload.run(d.id);
      audit({ actor: "webhooks", action: "webhook.delivered", subject: wh.id, detail: { deliveryId: d.id, attempt, eventType: d.event_type } });
    } catch (err) {
      const errMsg = String(err?.message || err);
      if (attempt >= MAX_ATTEMPTS) {
        db.prepare("UPDATE webhook_deliveries SET status = 'failed', attempt = ?, last_error = ? WHERE id = ?").run(attempt, errMsg, d.id);
        // Move to DLQ for manual inspection. The payload table row is
        // dropped because the body now lives on the DLQ envelope.
        db.prepare("INSERT INTO dead_letters (id, ts, envelope, error, resolved) VALUES (?, ?, ?, ?, 0)")
          .run(uuid("DLQ"), now(), JSON.stringify({ kind: "webhook", deliveryId: d.id, webhookId: wh.id, body: payload }), errMsg);
        deletePayload.run(d.id);
        // A terminal failure also bumps the breaker counter — a webhook
        // that exhausts all 6 attempts is exactly the kind of broken
        // endpoint the breaker should react to.
        noteFailure(wh.id, errMsg);
        audit({ actor: "webhooks", action: "webhook.failed", subject: wh.id, detail: { deliveryId: d.id, attempt, error: errMsg } });
      } else {
        const wait = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
        const next = new Date(Date.now() + wait).toISOString();
        db.prepare("UPDATE webhook_deliveries SET status = 'failed-retry', attempt = ?, last_error = ?, next_attempt_at = ? WHERE id = ?")
          .run(attempt, errMsg, next, d.id);
        // Don't bump the breaker on intermediate retries — only on
        // terminal failures and successes — otherwise a flaky endpoint
        // would trip the breaker after one event cycle.
        db.prepare("UPDATE webhooks SET last_error = ?, last_error_at = ? WHERE id = ?").run(errMsg, now(), wh.id);
        audit({ actor: "webhooks", action: "webhook.retry", subject: wh.id, detail: { deliveryId: d.id, attempt, nextAttemptAt: next, error: errMsg } });
      }
    }
  }
}

/**
 * Drain due deliveries on demand. Used by tests and by anyone who wants
 * synchronous delivery semantics; the periodic `setInterval` worker is
 * the production driver.
 */
export async function processDueDeliveries() {
  await tick();
}

export function listDeliveries(webhookId, limit = 50) {
  if (webhookId) return db.prepare("SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC LIMIT ?").all(webhookId, limit);
  return db.prepare("SELECT * FROM webhook_deliveries ORDER BY created_at DESC LIMIT ?").all(limit);
}
