// Daily roll-ups for the §19 success metrics. Stored in `metrics_daily`
// keyed by (day, metric). A worker recomputes the current and previous day
// roll-ups every 5 min so the Dashboards screen can plot a trend.

import { db } from "./db.js";

let _handle = null;

const METRICS = [
  // Adoption
  { name: "wau",                 sql: "SELECT COUNT(DISTINCT actor) AS v FROM audit_log WHERE ts >= datetime(?, '-7 days') AND ts < datetime(?, '+1 day')" },
  { name: "messages_with_links", sql: "SELECT COUNT(*) AS v FROM messages WHERE ts >= ? AND ts < datetime(?, '+1 day') AND text LIKE '%[%-%]%'" },
  // Execution
  { name: "open_workitems",      sql: "SELECT COUNT(*) AS v FROM work_items WHERE status NOT IN ('Done','Approved') AND created_at < datetime(?, '+1 day')" },
  { name: "approved_revisions",  sql: "SELECT COUNT(*) AS v FROM revisions WHERE status IN ('Approved','IFC') AND created_at >= ? AND created_at < datetime(?, '+1 day')" },
  // Quality / safety
  { name: "incidents_active",    sql: "SELECT COUNT(*) AS v FROM incidents WHERE status = 'active' AND started_at < datetime(?, '+1 day')" },
  // Data reliability
  { name: "events_total",        sql: "SELECT COUNT(*) AS v FROM events WHERE received_at >= ? AND received_at < datetime(?, '+1 day')" },
  { name: "dlq_open",            sql: "SELECT COUNT(*) AS v FROM dead_letters WHERE resolved = 0" },
  // AI trust
  { name: "ai_calls",            sql: "SELECT COUNT(*) AS v FROM ai_log WHERE ts >= ? AND ts < datetime(?, '+1 day')" },
  { name: "ai_with_citations",   sql: "SELECT COUNT(*) AS v FROM ai_log WHERE ts >= ? AND ts < datetime(?, '+1 day') AND citations != '[]'" },
];

function dateKey(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

export function rollupOnce(days = 14) {
  const today = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - i);
    const key = dateKey(d);
    for (const m of METRICS) {
      try {
        // Single-arg or two-arg shape: pass key for both placeholders.
        const placeholders = (m.sql.match(/\?/g) || []).length;
        const args = new Array(placeholders).fill(key);
        const v = db.prepare(m.sql).get(...args)?.v ?? 0;
        db.prepare(`INSERT INTO metrics_daily (day, metric, value) VALUES (@day, @metric, @value)
                    ON CONFLICT(day, metric) DO UPDATE SET value = excluded.value`)
          .run({ day: key, metric: m.name, value: Number(v) });
      } catch { /* skip metric */ }
    }
  }
}

export function startRollupWorker(logger, intervalMs = 5 * 60_000) {
  if (_handle) return;
  rollupOnce(); // immediate
  _handle = setInterval(() => {
    try { rollupOnce(); }
    catch (err) { logger?.warn?.({ err: String(err?.message || err) }, "metrics rollup failed"); }
  }, intervalMs);
  if (typeof _handle.unref === "function") _handle.unref();
}

export function stopRollupWorker() { if (_handle) clearInterval(_handle); _handle = null; }

export function readSeries(metric, days = 14) {
  return db.prepare("SELECT day, value FROM metrics_daily WHERE metric = ? ORDER BY day DESC LIMIT ?").all(metric, days).reverse();
}

export function listDailySnapshot(day = dateKey()) {
  return db.prepare("SELECT metric, value FROM metrics_daily WHERE day = ?").all(day);
}
