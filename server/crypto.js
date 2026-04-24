// Server-side crypto: SHA-256 chain + HMAC-SHA256 using Node's Web Crypto
// (identical to the client implementation so ledger entries produced on
// either side can be verified on either side, once a common tenant key
// is shared).

import { webcrypto } from "node:crypto";

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

let _hmacKey = null;
let _hmacKeyId = null;

/**
 * Acquire the HMAC signing key. In production this is backed by a KMS/HSM;
 * for self-hosted dev, `FORGE_TENANT_KEY` env var provides the material.
 */
async function getKey() {
  if (_hmacKey) return { key: _hmacKey, keyId: _hmacKeyId };
  const material = process.env.FORGE_TENANT_KEY || "forge-dev-tenant-key-please-rotate";
  _hmacKey = await subtle.importKey(
    "raw", enc.encode(material),
    { name: "HMAC", hash: "SHA-256" },
    false, ["sign", "verify"]
  );
  _hmacKeyId = process.env.FORGE_TENANT_KEY_ID || "key:forge:v1";
  return { key: _hmacKey, keyId: _hmacKeyId };
}

export async function signHMAC(payloadString) {
  const { key, keyId } = await getKey();
  const sig = await subtle.sign({ name: "HMAC" }, key, enc.encode(payloadString));
  return { keyId, alg: "HMAC-SHA256", signature: toHex(sig) };
}

export async function verifyHMAC(payloadString, signatureHex) {
  const { key } = await getKey();
  const bytes = new Uint8Array(signatureHex.match(/.{1,2}/g).map(b => parseInt(b, 16)));
  return subtle.verify({ name: "HMAC" }, key, bytes, enc.encode(payloadString));
}
