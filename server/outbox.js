import { db, now, uuid, jsonOrDefault } from "./db.js";
import { audit } from "./audit.js";

const MAX_ATTEMPTS = 6;
const BACKOFF_MS = [0, 5_000, 15_000, 60_000, 5 * 60_000, 30 * 60_000];
const subscribers = new Map();

function parse(row) {
  return row ? { ...row, payload: jsonOrDefault(row.payload, {}) } : null;
}

export function subscribeOutbox(topic, handler) {
  const list = subscribers.get(topic) || [];
  list.push(handler);
  subscribers.set(topic, list);
  return () => {
    const next = (subscribers.get(topic) || []).filter(h => h !== handler);
    subscribers.set(topic, next);
  };
}

export function enqueueOutbox({ topic, eventType, aggregateType = null, aggregateId = null, payload = {}, traceId = null }) {
  const id = uuid("OBX");
  const row = {
    id, topic, event_type: eventType, aggregate_type: aggregateType, aggregate_id: aggregateId,
    payload: JSON.stringify(payload || {}), trace_id: traceId || payload?.trace_id || uuid("TRACE"),
    status: "pending", attempts: 0, next_attempt_at: now(), created_at: now(), published_at: null, last_error: null,
  };
  db.prepare(`INSERT INTO outbox_events (id, topic, event_type, aggregate_type, aggregate_id, payload, trace_id, status, attempts, next_attempt_at, created_at, published_at, last_error)
              VALUES (@id, @topic, @event_type, @aggregate_type, @aggregate_id, @payload, @trace_id, @status, @attempts, @next_attempt_at, @created_at, @published_at, @last_error)`).run(row);
  return parse(row);
}

export function listOutbox({ status = null, limit = 100 } = {}) {
  const lim = Math.min(500, Number(limit || 100));
  const rows = status
    ? db.prepare("SELECT * FROM outbox_events WHERE status = ? ORDER BY created_at DESC LIMIT ?").all(status, lim)
    : db.prepare("SELECT * FROM outbox_events ORDER BY created_at DESC LIMIT ?").all(lim);
  return rows.map(parse);
}

export async function processOutboxBatch({ limit = 25 } = {}) {
  const due = db.prepare(`
    SELECT * FROM outbox_events
    WHERE status IN ('pending','retry')
      AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
    ORDER BY created_at
    LIMIT ?
  `).all(now(), limit);
  const results = [];
  for (const row of due) results.push(await processOne(row));
  return results;
}

async function processOne(row) {
  const event = parse(row);
  const handlers = [...(subscribers.get(event.topic) || []), ...(subscribers.get("*") || [])];
  const attempt = row.attempts + 1;
  try {
    for (const h of handlers) await h(event);
    db.prepare("UPDATE outbox_events SET status = 'published', attempts = ?, published_at = ?, last_error = NULL WHERE id = ?")
      .run(attempt, now(), row.id);
    return { id: row.id, status: "published" };
  } catch (err) {
    const error = String(err?.message || err);
    if (attempt >= MAX_ATTEMPTS) {
      db.prepare("UPDATE outbox_events SET status = 'failed', attempts = ?, last_error = ? WHERE id = ?").run(attempt, error, row.id);
      db.prepare("INSERT INTO dead_letters (id, ts, envelope, error, resolved) VALUES (?, ?, ?, ?, 0)")
        .run(uuid("DLQ"), now(), JSON.stringify(event), error);
      audit({ actor: "outbox", action: "outbox.failed", subject: row.id, detail: { topic: row.topic, error } });
      return { id: row.id, status: "failed", error };
    }
    const next = new Date(Date.now() + BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]).toISOString();
    db.prepare("UPDATE outbox_events SET status = 'retry', attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?")
      .run(attempt, next, error, row.id);
    return { id: row.id, status: "retry", error, next_attempt_at: next };
  }
}

let worker = null;
export function startOutboxWorker(logger = console) {
  if (worker) return worker;
  worker = setInterval(() => {
    processOutboxBatch().catch(err => logger.warn?.({ err: String(err?.message || err) }, "outbox worker failed"));
  }, 5_000);
  if (typeof worker.unref === "function") worker.unref();
  return worker;
}

export function stopOutboxWorker() {
  if (worker) clearInterval(worker);
  worker = null;
}
