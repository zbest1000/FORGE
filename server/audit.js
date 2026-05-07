// Hash-chained audit ledger backed by SQLite. Appends are serialized through
// an async queue so the chain is deterministic.

import { db } from "./db.js";
import { canonicalJSON, sha256Hex, signHMAC, verifyHMAC } from "./crypto.js";

const GENESIS = "0".repeat(64);

const stmtLast = db.prepare("SELECT hash, seq FROM audit_log ORDER BY seq DESC LIMIT 1");
const stmtInsert = db.prepare(`
  INSERT INTO audit_log (id, ts, actor, action, subject, detail, trace_id, prev_hash, hash, seq, org_id, org_hash)
  VALUES (@id, @ts, @actor, @action, @subject, @detail, @trace_id, @prev_hash, @hash, @seq, @org_id, @org_hash)
`);
const stmtUserOrg = db.prepare("SELECT org_id FROM users WHERE id = ?");

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
 *
 * `orgId` tags the entry with its tenant for `/api/audit` filtering. When
 * not supplied, the writer's org is looked up from `users` if the actor
 * is a known user id; otherwise the entry stays `org_id = NULL` and is
 * visible to every tenant (used for system events: boot, shutdown,
 * retention, webhook delivery, license rotation, etc.).
 */
export function audit({ actor, action, subject, detail = {}, traceId = null, orgId = null }) {
  initState();
  _seq += 1;
  const actorStr = String(actor || "system");
  let resolvedOrg = orgId || null;
  if (!resolvedOrg) {
    try { resolvedOrg = stmtUserOrg.get(actorStr)?.org_id || null; }
    catch { /* ignore — meta query failure should not break audit append */ }
  }
  const entry = {
    id: "AUD-" + String(_seq).padStart(8, "0"),
    ts: new Date().toISOString(),
    actor: actorStr,
    action: String(action),
    subject: String(subject || ""),
    detail,
    trace_id: traceId,
    org_id: resolvedOrg,
    prev_hash: null,
    hash: null,
    seq: _seq,
  };

  _pending = _pending.then(async () => {
    entry.prev_hash = _tail;
    // The canonical payload deliberately excludes `org_id` so historic
    // entries (which never carried one) keep verifying after the v11
    // schema bump. `org_id` is metadata, not part of the chain.
    const payload = {
      id: entry.id, ts: entry.ts, actor: entry.actor, action: entry.action,
      subject: entry.subject, detail: entry.detail, trace_id: entry.trace_id,
      prev_hash: entry.prev_hash, seq: entry.seq,
    };
    entry.hash = await sha256Hex(canonicalJSON(payload));
    _tail = entry.hash;
    // Dual-hash chain (v20): bind (entry, org_id) so an attacker can't
    // retroactively reassign tenant ownership without breaking
    // org_hash. The original chain is unchanged — org_hash hashes the
    // existing `hash` alongside the org_id, so verifying it is a single
    // hash recomputation rather than a separate chain walk.
    entry.org_hash = await sha256Hex(canonicalJSON({ hash: entry.hash, org_id: entry.org_id || null }));
    try {
      stmtInsert.run({
        id: entry.id, ts: entry.ts, actor: entry.actor, action: entry.action,
        subject: entry.subject, detail: JSON.stringify(entry.detail || {}),
        trace_id: entry.trace_id, prev_hash: entry.prev_hash,
        hash: entry.hash, seq: entry.seq, org_id: entry.org_id,
        org_hash: entry.org_hash,
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
 * Phase 4 forensics: walk the dual-hash org_hash chain. Returns
 * `{ ok, count, missing, mismatched }`. Pre-v20 entries (no org_hash
 * stored) are counted in `missing` rather than failing — the chain is
 * lazy-bound for historic data and only protects entries written
 * after the migration.
 *
 * When `orgId` is supplied, only entries for that tenant (plus
 * `org_id IS NULL` system events) are inspected. This is the path the
 * compliance UI calls per tenant — small audit slices verify in
 * milliseconds, full-table walks scale linearly with the ledger size.
 */
export async function verifyOrgChain({ orgId = null } = {}) {
  await drain();
  let sql = "SELECT * FROM audit_log";
  const params = {};
  if (orgId) {
    sql += " WHERE org_id = @org_id OR org_id IS NULL";
    params.org_id = orgId;
  }
  sql += " ORDER BY seq";
  const rows = db.prepare(sql).all(params);
  let missing = 0;
  for (let i = 0; i < rows.length; i++) {
    const e = rows[i];
    if (!e.org_hash) { missing++; continue; }
    const expected = await sha256Hex(canonicalJSON({ hash: e.hash, org_id: e.org_id || null }));
    if (expected !== e.org_hash) {
      return { ok: false, firstBadIndex: i, reason: "org_hash mismatch", entry: e, missing };
    }
  }
  return { ok: true, count: rows.length, missing };
}

/**
 * Produce an exportable audit pack signed with HMAC-SHA256.
 *
 * When `orgId` is supplied, only entries belonging to that tenant
 * (plus `org_id = NULL` system events) are included AND the pack is
 * signed with the org's active tenant key (per-tenant key history,
 * see `server/crypto.js`). Passing `orgId = null` (the default)
 * produces a global pack signed with the system key.
 */
export async function exportAuditPack({ since = null, until = null, orgId = null } = {}) {
  await drain();
  let sql = "SELECT * FROM audit_log";
  const params = {};
  const wheres = [];
  if (since) { wheres.push("ts >= @since"); params.since = since; }
  if (until) { wheres.push("ts <= @until"); params.until = until; }
  if (orgId) { wheres.push("(org_id = @org_id OR org_id IS NULL)"); params.org_id = orgId; }
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
    // Tag the pack itself with the requesting org so a future
    // verifier without filesystem access can see what scope the
    // export covers.
    org_id: orgId,
  };
  const sig = await signHMAC(canonicalJSON(pack), { orgId });
  return { ...pack, signature: sig };
}

export async function verifyAuditPack(pack) {
  if (!pack || !pack.signature) return false;
  const { signature, ...rest } = pack;
  // Use the keyId recorded on the pack signature so packs signed
  // under a since-rotated key still verify. If the signature pre-dates
  // the registry (`keyId` missing), `verifyHMAC` falls back to the
  // global default.
  return verifyHMAC(canonicalJSON(rest), signature.signature, { keyId: signature.keyId || null });
}

export function recent(limit = 100, { orgId = null } = {}) {
  const sql = orgId
    ? "SELECT * FROM audit_log WHERE org_id = ? OR org_id IS NULL ORDER BY seq DESC LIMIT ?"
    : "SELECT * FROM audit_log ORDER BY seq DESC LIMIT ?";
  const params = orgId ? [orgId, limit] : [limit];
  return db.prepare(sql).all(...params).map(r => ({
    ...r,
    detail: JSON.parse(r.detail || "{}"),
  }));
}
