// Minimal Web Crypto helpers used for:
//   - tamper-evident audit ledger (SHA-256 hash chain)
//   - signed approvals and audit-pack exports (HMAC-SHA256)
//
// Deliberate choices:
//   - No external dependency. `crypto.subtle` is available in every modern
//     browser and (with a small polyfill for Node) in the test harness.
//   - We use HMAC-SHA256 with a per-session "demo tenant key" so signatures
//     are verifiable within a session. A real deployment would replace
//     `getSigningKey()` with a KMS/HSM call; the shape stays identical.
//   - JSON inputs are serialized with `canonicalJSON()` so tiny key-ordering
//     differences never change the hash.

const enc = new TextEncoder();

function getSubtle() {
  if (typeof globalThis.crypto !== "undefined" && globalThis.crypto.subtle) {
    return globalThis.crypto.subtle;
  }
  // Node fallback (only used by the self-test harness).
  // eslint-disable-next-line global-require
  return require("crypto").webcrypto.subtle;
}

function toHex(buf) {
  const bytes = new Uint8Array(buf);
  const out = new Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[i].toString(16).padStart(2, "0");
  return out.join("");
}

export function canonicalJSON(value) {
  // Stable stringify: sorted keys, no extra whitespace. Handles primitives,
  // arrays, plain objects. Dates/Maps/Sets are not expected inside ledger
  // entries.
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJSON).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map(k => JSON.stringify(k) + ":" + canonicalJSON(value[k])).join(",") + "}";
}

export async function sha256Hex(input) {
  const data = typeof input === "string" ? enc.encode(input) : input;
  const buf = await getSubtle().digest("SHA-256", data);
  return toHex(buf);
}

// HMAC key management. In a real deployment `getSigningKey` calls KMS.
let _hmacKey = null;
let _hmacKeyId = null;

export async function getSigningKey() {
  if (_hmacKey) return { key: _hmacKey, keyId: _hmacKeyId };
  const raw = enc.encode("forge-demo-tenant-key-please-rotate-in-production");
  _hmacKey = await getSubtle().importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  _hmacKeyId = "key:forge-demo:v1";
  return { key: _hmacKey, keyId: _hmacKeyId };
}

export async function signHMAC(input) {
  const { key, keyId } = await getSigningKey();
  const data = typeof input === "string" ? enc.encode(input) : input;
  const sig = await getSubtle().sign({ name: "HMAC" }, key, data);
  return { keyId, alg: "HMAC-SHA256", signature: toHex(sig) };
}

export async function verifyHMAC(input, signatureHex) {
  const { key } = await getSigningKey();
  const data = typeof input === "string" ? enc.encode(input) : input;
  const sigBytes = new Uint8Array(signatureHex.match(/.{1,2}/g).map(b => parseInt(b, 16)));
  return getSubtle().verify({ name: "HMAC" }, key, sigBytes, data);
}
