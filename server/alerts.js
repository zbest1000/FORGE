// Saved-search alert poller (spec §15 "alert subscriptions").
// Periodically runs each saved query against FTS5 and emits notifications
// to the owning user for any new hit ids.

import { db, now, uuid } from "./db.js";
import { audit } from "./audit.js";

let _handle = null;

export function startAlertWorker(logger, intervalMs = 60_000) {
  if (_handle) return;
  _handle = setInterval(() => tick(logger), intervalMs);
  if (typeof _handle.unref === "function") _handle.unref();
  logger?.info?.({ intervalMs }, "search alert worker started");
}

export function stopAlertWorker() { if (_handle) clearInterval(_handle); _handle = null; }

/** Run alerts once (used by tests and the cron-like ticker). */
export function runOnce() {
  const alerts = db.prepare("SELECT * FROM search_alerts").all();
  let total = 0;
  for (const a of alerts) {
    try {
      const seen = new Set(JSON.parse(a.last_seen_ids || "[]"));
      const hits = matchHits(a.query);
      const newOnes = hits.filter(h => !seen.has(h.id));
      if (newOnes.length) {
        const tsNow = now();
        const insert = db.prepare(`INSERT INTO notifications (id, ts, kind, text, route, user_id, subject, read)
                                   VALUES (@id, @ts, 'search', @text, @route, @uid, @subject, 0)`);
        const tx = db.transaction((rows) => { for (const r of rows) insert.run(r); });
        tx(newOnes.map(h => ({
          id: uuid("N"),
          ts: tsNow,
          text: `${a.name}: new hit · ${h.title}`,
          route: h.route,
          uid: a.user_id,
          subject: h.id,
        })));
        const allIds = hits.map(h => h.id).slice(0, 200);
        db.prepare("UPDATE search_alerts SET last_run_at = ?, last_seen_ids = ? WHERE id = ?")
          .run(tsNow, JSON.stringify(allIds), a.id);
        audit({ actor: "search.alerts", action: "search.alert.fired", subject: a.id, detail: { count: newOnes.length } });
        total += newOnes.length;
      } else {
        db.prepare("UPDATE search_alerts SET last_run_at = ? WHERE id = ?").run(now(), a.id);
      }
    } catch (err) {
      audit({ actor: "search.alerts", action: "search.alert.error", subject: a.id, detail: { error: String(err?.message || err) } });
    }
  }
  return total;
}

async function tick(logger) {
  try {
    const fired = runOnce();
    if (fired) logger?.debug?.({ fired }, "search alerts fired");
  } catch (err) {
    logger?.error?.({ err: String(err?.message || err) }, "alert worker tick failed");
  }
}

function matchHits(query) {
  const esc = (query || "").replace(/"/g, '""');
  const out = [];
  for (const stmt of [
    [`SELECT id, kind, title FROM fts_docs WHERE fts_docs MATCH ? LIMIT 50`, (r) => ({ id: r.id, route: `/doc/${r.id}`, title: r.title })],
    [`SELECT id, channel_id, text FROM fts_messages WHERE fts_messages MATCH ? LIMIT 50`, (r) => ({ id: r.id, route: `/channel/${r.channel_id}`, title: (r.text || "").slice(0, 60) })],
    [`SELECT id, project_id, title FROM fts_workitems WHERE fts_workitems MATCH ? LIMIT 50`, (r) => ({ id: r.id, route: `/work-board/${r.project_id}`, title: r.title })],
    [`SELECT id, name FROM fts_assets WHERE fts_assets MATCH ? LIMIT 50`, (r) => ({ id: r.id, route: `/asset/${r.id}`, title: r.name })],
  ]) {
    try {
      const rows = db.prepare(stmt[0]).all(`"${esc}"*`);
      for (const r of rows) out.push(stmt[1](r));
    } catch { /* invalid FTS query token */ }
  }
  return out;
}
