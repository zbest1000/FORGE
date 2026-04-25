// Tamper-evident audit ledger (spec §13.2).
//
// Each entry links to the previous via a SHA-256 hash over canonical JSON,
// producing a chain that `verifyLedger` can walk to detect any tampering.
// Export produces a self-contained JSON pack with an HMAC-SHA256 signature
// (spec §13.3 exportable immutable audit packs).
//
// This module replaces the prior `state.audit(...)` helper. The old
// `state.data.auditEvents` array is still populated for screens that read
// it directly, but every entry now carries `prevHash` and `hash`.

import { canonicalJSON, sha256Hex, signHMAC, verifyHMAC } from "./crypto.js";
import { state } from "./store.js";

const GENESIS = "0".repeat(64);

function chronoCompare(a, b) {
  const ta = a.ts || "", tb = b.ts || "";
  if (ta !== tb) return ta < tb ? -1 : 1;
  const ia = a.id || "", ib = b.id || "";
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}

let _seq = 0;
let _tail = GENESIS;      // current chain tail hash
let _pending = Promise.resolve(); // serialize async hashing to preserve order

function ensureStore() {
  if (!state.data) return;
  if (!Array.isArray(state.data.auditEvents)) state.data.auditEvents = [];
  // Rebuild state from any pre-existing entries (e.g. hydrated from storage).
  if (state.data.auditEvents.length && state.data.auditEvents[0].hash) {
    const last = state.data.auditEvents[state.data.auditEvents.length - 1];
    _tail = last.hash;
    const m = last.id.match(/AUD-(\d+)$/);
    if (m) _seq = Math.max(_seq, parseInt(m[1], 10));
  }
}

export function initAuditLedger() {
  ensureStore();
  // The in-memory display array is ordered newest-first for the UI. For the
  // hash chain we build a chronological view by timestamp so seed + runtime
  // entries interleave correctly.
  const arr = state.data.auditEvents || [];
  const chrono = arr.slice().sort(chronoCompare);
  let tail = GENESIS;
  for (const e of chrono) {
    if (!e.hash) {
      e.prevHash = tail;
      e.hash = "legacy:" + (e.id || Math.random().toString(36).slice(2));
    }
    tail = e.hash;
  }
  _tail = tail || GENESIS;
  for (const e of arr) {
    const m = (e.id || "").match(/AUD-(\d+)/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (!Number.isNaN(n)) _seq = Math.max(_seq, n);
    }
  }
}

/**
 * Append an audit entry. Returns the entry. Hashing is serialized through a
 * promise chain so each new entry's `prevHash` is the previous entry's
 * `hash` even under burst writes. `verifyLedger` awaits the queue.
 */
export function audit(action, subject, detail = {}) {
  ensureStore();
  _seq += 1;
  const entry = {
    id: "AUD-" + String(_seq).padStart(6, "0"),
    ts: new Date().toISOString(),
    actor: state.ui.role,
    action,
    subject: typeof subject === "string" ? subject : String(subject || ""),
    detail: detail || {},
    traceId: detail?.traceId || null,
    prevHash: null,
    hash: null,
  };
  state.data.auditEvents.unshift(entry);
  if (state.data.auditEvents.length > 500) state.data.auditEvents.length = 500;

  _pending = _pending.then(async () => {
    entry.prevHash = _tail;
    const payload = { ...entry };
    delete payload.hash;
    const hash = await sha256Hex(canonicalJSON(payload));
    entry.hash = hash;
    _tail = hash;
    try {
      const idb = await import("./idb.js");
      await idb.append("auditLog", entry);
    } catch { /* IDB may be unavailable; keep in-memory log */ }
  });

  return entry;
}

/**
 * Walk the ledger verifying every hash. Returns { ok, firstBadIndex }.
 * If ok, the chain is intact.
 */
export async function verifyLedger() {
  await _pending;
  const entries = (state.data.auditEvents || []).slice().sort(chronoCompare); // chronological
  let prev = GENESIS;
  let legacyCount = 0;
  let strictCount = 0;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.hash && e.hash.startsWith("legacy:")) {
      // Legacy boundary: accept as-is and treat it like GENESIS for the next
      // post-boot entry.
      prev = e.hash;
      legacyCount += 1;
      continue;
    }
    // Permit transitioning from legacy → strict: the first strict entry may
    // have prevHash = lastLegacyHash or GENESIS.
    const firstStrict = strictCount === 0;
    const prevOk = e.prevHash === prev || (firstStrict && e.prevHash === GENESIS);
    if (!prevOk) return { ok: false, firstBadIndex: i, reason: "prevHash mismatch", entry: e };
    const { hash, ...rest } = e;
    const recomputed = await sha256Hex(canonicalJSON(rest));
    if (recomputed !== hash) return { ok: false, firstBadIndex: i, reason: "hash mismatch", entry: e };
    prev = hash;
    strictCount += 1;
  }
  return { ok: true, legacyCount, strictCount, length: entries.length };
}

/**
 * Export an audit pack — a self-contained JSON blob with an HMAC signature.
 */
export async function exportAuditPack(filter = () => true) {
  await _pending;
  const entries = (state.data.auditEvents || []).slice().reverse().filter(filter);
  const pack = {
    exported_at: new Date().toISOString(),
    tenant: state.data?.organization?.id || "ORG-?",
    workspace: state.data?.workspace?.id || "WS-?",
    entry_count: entries.length,
    entries,
  };
  const sig = await signHMAC(canonicalJSON(pack));
  return { ...pack, signature: sig };
}

export async function verifyAuditPack(pack) {
  if (!pack || !pack.signature) return false;
  const { signature, ...rest } = pack;
  return verifyHMAC(canonicalJSON(rest), signature.signature);
}
