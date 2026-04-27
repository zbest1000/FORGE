// Retention sweep worker.
//
// Walks `retention_policies` and prunes data older than `days`, unless an
// active legal hold covers the row. The worker is conservative:
//
// - It only soft-deletes when a column allows it (e.g. `messages.deleted`),
//   and hard-deletes only when there is no soft-delete fallback.
// - Audit log is **never pruned** by this worker — operator policy
//   removes audit data only via a separate, human-invoked CLI. The audit
//   ledger is a hash chain; mid-chain deletes break verification.
// - Work runs in a transaction; failures roll back.
//
// Policy rows look like:
//
//   { id, name, scope, days, legal_hold }
//
// `scope` is the table name to sweep. `legal_hold = 1` means *the policy
// itself* is overridden by an active legal hold — i.e. retention is
// indefinite while held.

import { db, now } from "./db.js";
import { audit } from "./audit.js";
import { isHeld } from "./compliance.js";
import { sweepIdempotency } from "./idempotency.js";

const SCOPE_HANDLERS = {
  messages: pruneMessages,
  notifications: pruneNotifications,
  events: pruneEvents,
  ai_log: pruneAiLog,
  webhook_deliveries: pruneWebhookDeliveries,
};

function cutoff(days) {
  return new Date(Date.now() - Number(days) * 86_400_000).toISOString();
}

function pruneMessages(c, holdActive) {
  if (holdActive) return { skipped: true, reason: "legal_hold" };
  const r = db.prepare("UPDATE messages SET deleted = 1, deleted_at = ?, deleted_by = 'retention' WHERE deleted = 0 AND ts < ?").run(now(), c);
  return { changes: r.changes, mode: "soft" };
}

function pruneNotifications(c, holdActive) {
  if (holdActive) return { skipped: true, reason: "legal_hold" };
  const r = db.prepare("DELETE FROM notifications WHERE ts < ? AND read = 1").run(c);
  return { changes: r.changes, mode: "hard" };
}

function pruneEvents(c, holdActive) {
  if (holdActive) return { skipped: true, reason: "legal_hold" };
  const r = db.prepare("DELETE FROM events WHERE received_at < ?").run(c);
  return { changes: r.changes, mode: "hard" };
}

function pruneAiLog(c, holdActive) {
  if (holdActive) return { skipped: true, reason: "legal_hold" };
  const r = db.prepare("DELETE FROM ai_log WHERE ts < ?").run(c);
  return { changes: r.changes, mode: "hard" };
}

function pruneWebhookDeliveries(c, holdActive) {
  if (holdActive) return { skipped: true, reason: "legal_hold" };
  const r = db.prepare("DELETE FROM webhook_deliveries WHERE created_at < ? AND status IN ('delivered','cancelled')").run(c);
  return { changes: r.changes, mode: "hard" };
}

/**
 * Run all enabled retention policies once. Returns a summary of what was
 * pruned per policy. Safe to call from a cron, a worker tick, or a unit
 * test. Does not throw on a single-policy failure — collects per-policy
 * errors instead so one broken row does not block the rest.
 */
export function runRetentionOnce() {
  const policies = db.prepare("SELECT * FROM retention_policies").all();
  const out = [];
  // Always sweep expired idempotency keys; not driven by retention_policies
  // because the TTL is operator-tuned via env, not per-tenant policy.
  try {
    const r = sweepIdempotency();
    out.push({ id: "system:idempotency", scope: "idempotency_keys", ...r });
  } catch (err) {
    out.push({ id: "system:idempotency", scope: "idempotency_keys", error: String(err?.message || err) });
  }
  for (const p of policies) {
    const handler = SCOPE_HANDLERS[p.scope];
    if (!handler) {
      out.push({ id: p.id, scope: p.scope, skipped: true, reason: "no_handler" });
      continue;
    }
    const c = cutoff(p.days);
    // The policy `legal_hold` flag means "respect active holds for this
    // scope". A hold covering the same scope blocks pruning entirely. A
    // future iteration will narrow per-row, but blocking the whole
    // scope keeps the implementation conservative.
    const blocked = !!p.legal_hold && isHeld({ scope: p.scope });
    try {
      const r = handler(c, blocked);
      audit({ actor: "retention", action: "retention.sweep", subject: p.id, detail: { scope: p.scope, days: p.days, ...r } });
      out.push({ id: p.id, scope: p.scope, ...r });
    } catch (err) {
      audit({ actor: "retention", action: "retention.sweep.error", subject: p.id, detail: { scope: p.scope, error: String(err?.message || err) } });
      out.push({ id: p.id, scope: p.scope, error: String(err?.message || err) });
    }
  }
  return out;
}

let _handle = null;
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function startRetentionWorker(logger, intervalMs = Number(process.env.FORGE_RETENTION_INTERVAL_MS || DEFAULT_INTERVAL_MS)) {
  if (_handle || intervalMs <= 0) return;
  _handle = setInterval(() => {
    try {
      const summary = runRetentionOnce();
      const total = summary.reduce((acc, r) => acc + (r.changes || 0), 0);
      if (total) logger?.info?.({ swept: total, summary }, "retention sweep");
    } catch (err) {
      logger?.error?.({ err: String(err?.message || err) }, "retention worker failed");
    }
  }, intervalMs);
  if (typeof _handle.unref === "function") _handle.unref();
  logger?.info?.({ intervalMs }, "retention worker started");
}

export function stopRetentionWorker() {
  if (_handle) clearInterval(_handle);
  _handle = null;
}
