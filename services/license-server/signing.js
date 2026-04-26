// Ed25519 signing of entitlement bundles.
//
// Format:
//   entitlement1.<base64url(canonical-payload)>.<base64url(ed25519-signature)>
//
// The signing private key MUST be supplied at runtime via env so
// secrets never live in the source tree or the database file:
//
//   FORGE_LICENSE_SIGNING_KEY        — PEM blob (recommended for k8s)
//   FORGE_LICENSE_SIGNING_KEY_PATH   — absolute path to a PEM file
//
// The matching public key is bundled into every FORGE deployment and
// every customer's local license server (config/license-pubkey.pem in
// the FORGE repo). The same public key the server prints on /pubkey
// MUST match — see scripts/admin.js print-pubkey.

import crypto from "node:crypto";
import fs from "node:fs";

let cachedPriv = null;

export function loadSigningKey() {
  if (cachedPriv) return cachedPriv;
  let pem = process.env.FORGE_LICENSE_SIGNING_KEY;
  const p = process.env.FORGE_LICENSE_SIGNING_KEY_PATH;
  if (!pem && p && fs.existsSync(p)) pem = fs.readFileSync(p, "utf8");
  if (!pem || !pem.trim()) {
    throw new Error("license signing key not configured: set FORGE_LICENSE_SIGNING_KEY or FORGE_LICENSE_SIGNING_KEY_PATH");
  }
  cachedPriv = crypto.createPrivateKey({ key: pem, format: "pem" });
  if (cachedPriv.asymmetricKeyType !== "ed25519") {
    throw new Error("license signing key must be an Ed25519 private key");
  }
  return cachedPriv;
}

export function publicKeyPem() {
  const priv = loadSigningKey();
  const pub = crypto.createPublicKey(priv);
  return pub.export({ type: "spki", format: "pem" }).toString().trim();
}

// Canonical JSON: stable key order so re-encoding never changes the digest.
function canonicalJSON(obj) {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return "[" + obj.map(canonicalJSON).join(",") + "]";
  const keys = Object.keys(obj).sort();
  return "{" + keys.map(k => JSON.stringify(k) + ":" + canonicalJSON(obj[k])).join(",") + "}";
}

function b64u(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const TOKEN_PREFIX = "entitlement1.";

/**
 * Sign an entitlement payload. The payload structure is fixed by the
 * protocol spec — see `services/PROTOCOL.md`.
 */
export function signEntitlement(payload) {
  const key = loadSigningKey();
  const canonical = canonicalJSON(payload);
  const sig = crypto.sign(null, Buffer.from(canonical, "utf8"), key);
  return TOKEN_PREFIX + b64u(canonical) + "." + b64u(sig);
}
