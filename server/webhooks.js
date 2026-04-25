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

function sign(secret, body) {
  return "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
}

export function listWebhooks() {
  return db.prepare("SELECT id, name, url, events, enabled, last_success_at, last_error, last_error_at, created_at, created_by FROM webhooks ORDER BY created_at DESC").all()
    .map(r => ({ ...r, events: JSON.parse(r.events || "[]"), enabled: !!r.enabled }));
}

export function createWebhook({ name, url, events = ["*"], secret = null, createdBy = null }) {
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
  db.prepare("UPDATE webhooks SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
  audit({ actor, action: "webhook.toggle", subject: id, detail: { enabled } });
}

export function deleteWebhook(id, actor) {
  db.prepare("DELETE FROM webhooks WHERE id = ?").run(id);
  audit({ actor, action: "webhook.delete", subject: id });
}

/**
 * Dispatch an event to all matching webhooks. Fire-and-forget: we don't
 * await network calls from inside a SQLite transaction. Results land in
 * `last_success_at` / `last_error` for operator visibility.
 */
export function dispatchEvent(eventType, payload) {
  const rows = db.prepare("SELECT * FROM webhooks WHERE enabled = 1").all();
  if (!rows.length) return;
  const match = (spec) => {
    const list = JSON.parse(spec || "[]");
    if (!list.length || list.includes("*")) return true;
    return list.includes(eventType);
  };
  const body = JSON.stringify({ id: uuid("WHD"), type: eventType, ts: new Date().toISOString(), payload });
  for (const row of rows) {
    if (!match(row.events)) continue;
    const delivery = uuid("delivery").toLowerCase();
    const signature = sign(row.secret, body);
    send(row, eventType, delivery, signature, body);
  }
}

async function send(row, eventType, delivery, signature, body) {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 8000);
    const res = await fetch(row.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-FORGE-Signature": signature,
        "X-FORGE-Event": eventType,
        "X-FORGE-Delivery": delivery,
      },
      body,
      signal: ac.signal,
    });
    clearTimeout(t);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    db.prepare("UPDATE webhooks SET last_success_at = ?, last_error = NULL, last_error_at = NULL WHERE id = ?").run(now(), row.id);
    audit({ actor: "webhooks", action: "webhook.delivered", subject: row.id, detail: { eventType, delivery } });
  } catch (err) {
    db.prepare("UPDATE webhooks SET last_error = ?, last_error_at = ? WHERE id = ?").run(String(err?.message || err), now(), row.id);
    audit({ actor: "webhooks", action: "webhook.failed", subject: row.id, detail: { eventType, delivery, error: String(err?.message || err) } });
  }
}
