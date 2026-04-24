// Hash-chained audit ledger backed by SQLite. Appends are serialized through
// an async queue so the chain is deterministic.

import { db } from "./db.js";
import { canonicalJSON, sha256Hex, signHMAC, verifyHMAC } from "./crypto.js";

const GENESIS = "0".repeat(64);

const stmtLast = db.prepare("SELECT hash, seq FROM audit_log ORDER BY seq DESC LIMIT 1");
const stmtInsert = db.prepare(`
  INSERT INTO audit_log (id, ts, actor, action, subject, detail, trace_id, prev_hash, hash, seq)
  VALUES (@id, @ts, @actor, @action, @subject, @detail, @trace_id, @prev_hash, @hash, @seq)
`);

let _tail = null;
let _seq = 0;
let _pending = Promise.resolve();

function initState() {
  if (_tail !== null) return;
  const row = stmtLast.get();
  if (row) { _tail = row.hash; _seq = row.seq; }
  else     { _tail = GENESIS; _seq = 0; }
}

/**
 * Append an audit entry. Returns the entry synchronously (with placeholder
 * hash) and finalizes hashing on the queue. `verifyLedger` awaits the queue.
 */
export function audit({ actor, action, subject, detail = {}, traceId = null }) {
  initState();
  _seq += 1;
  const entry = {
    id: "AUD-" + String(_seq).padStart(8, "0"),
    ts: new Date().toISOString(),
    actor: String(actor || "system"),
    action: String(action),
    subject: String(subject || ""),
    detail,
    trace_id: traceId,
    prev_hash: null,
    hash: null,
    seq: _seq,
  };

  _pending = _pending.then(async () => {
    entry.prev_hash = _tail;
    const payload = {
      id: entry.id, ts: entry.ts, actor: entry.actor, action: entry.action,
      subject: entry.subject, detail: entry.detail, trace_id: entry.trace_id,
      prev_hash: entry.prev_hash, seq: entry.seq,
    };
    entry.hash = await sha256Hex(canonicalJSON(payload));
    _tail = entry.hash;
    try {
      stmtInsert.run({
        id: entry.id, ts: entry.ts, actor: entry.actor, action: entry.action,
        subject: entry.subject, detail: JSON.stringify(entry.detail || {}),
        trace_id: entry.trace_id, prev_hash: entry.prev_hash,
        hash: entry.hash, seq: entry.seq,
      });
    } catch (err) {
      console.error("audit insert failed", err, entry);
    }
  });

  return entry;
}

/**
 * Wait for all pending hash computations to flush.
 */
export async function drain() { await _pending; }

/**
 * Walk the ledger verifying each hash and `prev_hash` pointer.
 */
export async function verifyLedger() {
  await drain();
  const rows = db.prepare("SELECT * FROM audit_log ORDER BY seq").all();
  let prev = GENESIS;
  for (let i = 0; i < rows.length; i++) {
    const e = rows[i];
    if (e.prev_hash !== prev) {
      return { ok: false, firstBadIndex: i, reason: "prev_hash mismatch", entry: e };
    }
    const payload = {
      id: e.id, ts: e.ts, actor: e.actor, action: e.action, subject: e.subject,
      detail: JSON.parse(e.detail || "{}"),
      trace_id: e.trace_id, prev_hash: e.prev_hash, seq: e.seq,
    };
    const recomputed = await sha256Hex(canonicalJSON(payload));
    if (recomputed !== e.hash) {
      return { ok: false, firstBadIndex: i, reason: "hash mismatch", entry: e };
    }
    prev = e.hash;
  }
  return { ok: true, count: rows.length };
}

/**
 * Produce an exportable audit pack signed with HMAC-SHA256.
 */
export async function exportAuditPack({ since = null, until = null } = {}) {
  await drain();
  let sql = "SELECT * FROM audit_log";
  const params = {};
  const wheres = [];
  if (since) { wheres.push("ts >= @since"); params.since = since; }
  if (until) { wheres.push("ts <= @until"); params.until = until; }
  if (wheres.length) sql += " WHERE " + wheres.join(" AND ");
  sql += " ORDER BY seq";
  const rows = db.prepare(sql).all(params).map(r => ({
    ...r,
    detail: JSON.parse(r.detail || "{}"),
  }));
  const pack = {
    exported_at: new Date().toISOString(),
    entry_count: rows.length,
    entries: rows,
  };
  const sig = await signHMAC(canonicalJSON(pack));
  return { ...pack, signature: sig };
}

export async function verifyAuditPack(pack) {
  if (!pack || !pack.signature) return false;
  const { signature, ...rest } = pack;
  return verifyHMAC(canonicalJSON(rest), signature.signature);
}

export function recent(limit = 100) {
  return db.prepare("SELECT * FROM audit_log ORDER BY seq DESC LIMIT ?").all(limit).map(r => ({
    ...r,
    detail: JSON.parse(r.detail || "{}"),
  }));
}
