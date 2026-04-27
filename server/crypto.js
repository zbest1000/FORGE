// Server-side crypto: SHA-256 chain + HMAC-SHA256 using Node's Web Crypto
// (identical to the client implementation so ledger entries produced on
// either side can be verified on either side, once a common tenant key
// is shared).
//
// Per-tenant signing key history (B.2 #2/#3, B.8 #4)
// --------------------------------------------------
//
// The audit pack signing key used to be a single `FORGE_TENANT_KEY`
// env var with a fixed `key:forge:v1` id. Rotating the key broke every
// previously-exported pack and we had no way to expose org-scoped
// provenance.
//
// Now signing keys are looked up via `getKey(orgId, keyId)`:
//
//   - At **sign** time: pick the org's currently-active key. If the
//     org has no per-org key configured, fall back to the global
//     `FORGE_TENANT_KEY` (`key:forge:v1`).
//   - At **verify** time: look up the exact `keyId` recorded on the
//     pack signature. Old packs signed under a retired key still
//     verify as long as the operator retains the env var.
//
// Key material continues to live in environment variables / KMS:
//
//   FORGE_TENANT_KEY                  → key:forge:v1 (default global)
//   FORGE_TENANT_KEY_<KEY_ID>         → arbitrary additional keys; the
//                                       env var name is uppercased,
//                                       `key:forge:v2` becomes
//                                       FORGE_TENANT_KEY_KEY_FORGE_V2
//   FORGE_TENANT_KEY_ORG_<ORG_ID>     → per-org default; uppercased,
//                                       hyphens removed.
//
// The `tenant_keys` SQLite table is the registry: it says which key id
// is active for which org, when it was created, and when it retired.
// Storing only key ids and fingerprints (never the secret) keeps the
// table safe to back up.

import { webcrypto, createHash } from "node:crypto";
import { db } from "./db.js";

const subtle = webcrypto.subtle;
const enc = new TextEncoder();

export function canonicalJSON(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJSON).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map(k => JSON.stringify(k) + ":" + canonicalJSON(value[k])).join(",") + "}";
}

function toHex(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

export async function sha256Hex(input) {
  const data = typeof input === "string" ? enc.encode(input) : input;
  return toHex(await subtle.digest("SHA-256", data));
}

const DEFAULT_KEY_ID = process.env.FORGE_TENANT_KEY_ID || "key:forge:v1";
const DEFAULT_MATERIAL = "forge-dev-tenant-key-please-rotate";

// Cache imported HMAC keys keyed by `keyId` so we don't pay the import
// cost on every sign / verify. The cache is process-local and clears
// on restart, which is fine — keys are re-imported lazily on first use.
const _keyCache = new Map();

const stmtActiveForOrg = db.prepare(
  "SELECT id, key_fingerprint FROM tenant_keys WHERE org_id = ? AND state = 'active' ORDER BY created_at DESC LIMIT 1",
);
const stmtById = db.prepare("SELECT id, org_id, state, key_fingerprint FROM tenant_keys WHERE id = ?");
const stmtUpdateFingerprint = db.prepare("UPDATE tenant_keys SET key_fingerprint = ? WHERE id = ? AND key_fingerprint = ''");
const stmtInsertOrgKey = db.prepare(`
  INSERT INTO tenant_keys (id, org_id, state, key_fingerprint, created_at)
  VALUES (@id, @org_id, 'active', @fp, @created_at)
`);
const stmtRetireKey = db.prepare("UPDATE tenant_keys SET state = 'retired', retired_at = ? WHERE id = ?");
const stmtListForOrg = db.prepare("SELECT id, state, key_fingerprint, created_at, retired_at FROM tenant_keys WHERE org_id IS ? ORDER BY created_at DESC");

/** Convert a key id to its env-var name. `key:forge:v1` →
 *  `FORGE_TENANT_KEY_KEY_FORGE_V1`. Lowercase + colon → underscore. */
function envNameForKeyId(keyId) {
  const safe = String(keyId || "").toUpperCase().replace(/[^A-Z0-9]/g, "_");
  return `FORGE_TENANT_KEY_${safe}`;
}

function fingerprint(material) {
  return createHash("sha256").update(String(material || "")).digest("hex").slice(0, 16);
}

/**
 * Read the raw key material for a given keyId. Resolution order:
 *   1. `FORGE_TENANT_KEY_<KEY_ID>` env var — wins if set.
 *   2. Default `FORGE_TENANT_KEY` env var when keyId === DEFAULT_KEY_ID.
 *   3. Documented dev fallback (only for tests / local dev).
 */
function readKeyMaterial(keyId) {
  const fromEnv = process.env[envNameForKeyId(keyId)];
  if (fromEnv) return fromEnv;
  if (keyId === DEFAULT_KEY_ID) {
    return process.env.FORGE_TENANT_KEY || DEFAULT_MATERIAL;
  }
  return null;
}

async function importKey(material) {
  return subtle.importKey(
    "raw", enc.encode(material),
    { name: "HMAC", hash: "SHA-256" },
    false, ["sign", "verify"],
  );
}

/**
 * Resolve the active signing key for `orgId` (or null for global).
 * Returns `{ key, keyId }`. Side effect: updates the empty
 * `key_fingerprint` on the registry row the first time the key is
 * loaded so admins can audit which env value matches which row.
 */
async function getActiveKey(orgId) {
  const row = orgId ? stmtActiveForOrg.get(orgId) : null;
  const keyId = row?.id || DEFAULT_KEY_ID;
  return getKeyById(keyId);
}

/**
 * Resolve a specific key by id, used by verify paths to look up the
 * key recorded on the pack signature.
 */
async function getKeyById(keyId) {
  const cached = _keyCache.get(keyId);
  if (cached) return { key: cached, keyId };
  const material = readKeyMaterial(keyId);
  if (!material) {
    const err = new Error(`tenant key '${keyId}' has no material configured`);
    err.code = "ERR_FORGE_KEY_MISSING";
    throw err;
  }
  const key = await importKey(material);
  _keyCache.set(keyId, key);
  // Lazily backfill the fingerprint into tenant_keys the first time we
  // load it. Empty fingerprint means "never seen at runtime"; we never
  // overwrite a non-empty value so an operator-driven rotation that
  // pre-populated the fingerprint stays intact.
  try { stmtUpdateFingerprint.run(fingerprint(material), keyId); }
  catch { /* table missing during very early boot */ }
  return { key, keyId };
}

/**
 * Sign a payload string with `orgId`'s active key (or the global key
 * when `orgId` is null). Returns `{ keyId, alg, signature }`.
 */
export async function signHMAC(payloadString, { orgId = null } = {}) {
  const { key, keyId } = await getActiveKey(orgId);
  const sig = await subtle.sign({ name: "HMAC" }, key, enc.encode(payloadString));
  return { keyId, alg: "HMAC-SHA256", signature: toHex(sig) };
}

/**
 * Verify a signature using the key identified by `keyId`. When
 * `keyId` is omitted we fall back to the default global key for
 * backward compatibility with packs produced before the registry
 * existed.
 */
export async function verifyHMAC(payloadString, signatureHex, { keyId = null } = {}) {
  const { key } = await getKeyById(keyId || DEFAULT_KEY_ID);
  const bytes = new Uint8Array(signatureHex.match(/.{1,2}/g).map(b => parseInt(b, 16)));
  return subtle.verify({ name: "HMAC" }, key, bytes, enc.encode(payloadString));
}

// ----------------------------------------------------------------------
// Operator-facing key registry helpers
// ----------------------------------------------------------------------

/**
 * Register a new active key for an org and retire the previous one in
 * the same transaction. The caller must have already populated the
 * env var named by `envNameForKeyId(keyId)`; this function only
 * records the lifecycle event.
 */
export function rotateTenantKey({ orgId = null, newKeyId, actor = "system" }) {
  if (!newKeyId) throw new Error("rotateTenantKey: newKeyId required");
  const material = readKeyMaterial(newKeyId);
  if (!material) {
    const err = new Error(`cannot rotate to '${newKeyId}': env var ${envNameForKeyId(newKeyId)} is not set`);
    err.code = "ERR_FORGE_KEY_MISSING";
    throw err;
  }
  const fp = fingerprint(material);
  const ts = new Date().toISOString();
  const txFn = db.transaction(() => {
    const previous = orgId ? stmtActiveForOrg.get(orgId) : null;
    if (previous) stmtRetireKey.run(ts, previous.id);
    stmtInsertOrgKey.run({ id: newKeyId, org_id: orgId, fp, created_at: ts });
  });
  txFn();
  // Drop the cached key for this id in case material was changed for
  // an existing keyId (operator typo / replacement).
  _keyCache.delete(newKeyId);
  return { keyId: newKeyId, orgId, fingerprint: fp, rotatedAt: ts, actor };
}

/** List signing-key history for an org (or globally when orgId is null). */
export function listTenantKeys(orgId = null) {
  return stmtListForOrg.all(orgId);
}

/** Inspect a specific key id without exposing material. */
export function describeTenantKey(keyId) {
  return stmtById.get(keyId);
}

/** Test-only escape hatch: clear the in-process key cache. */
export function _clearKeyCache() { _keyCache.clear(); }
