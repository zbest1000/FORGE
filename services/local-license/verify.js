// Local license server — entitlement bundle verifier.
//
// Parses and verifies entitlement1.<payload>.<sig> tokens issued by
// the FORGE LLC central server, against the bundled vendor public key
// (or a locally overridden one).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_PREFIX = "entitlement1.";

function canonicalJSON(obj) {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return "[" + obj.map(canonicalJSON).join(",") + "]";
  const keys = Object.keys(obj).sort();
  return "{" + keys.map(k => JSON.stringify(k) + ":" + canonicalJSON(obj[k])).join(",") + "}";
}

function b64uDecode(s) {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  return Buffer.from((s + pad).replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function loadPublicKey() {
  const envValue = process.env.FORGE_LICENSE_PUBLIC_KEY;
  if (envValue && envValue.trim()) {
    return crypto.createPublicKey({ key: envValue.trim(), format: "pem" });
  }
  // Fall back to the FORGE app's bundled key — we expect the local LS
  // to be deployed alongside FORGE binaries that share the same vendor.
  const candidates = [
    path.resolve(__dirname, "..", "..", "config", "license-pubkey.pem"),
    path.resolve(__dirname, "license-pubkey.pem"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return crypto.createPublicKey({ key: fs.readFileSync(c, "utf8"), format: "pem" });
    }
  }
  throw new Error("FORGE_LICENSE_PUBLIC_KEY not configured and no bundled key found");
}

let _pubKey = null;
function pubKey() { return _pubKey || (_pubKey = loadPublicKey()); }

export function verifyEntitlement(token) {
  const out = { ok: false, payload: null, error: null };
  if (!token || typeof token !== "string" || !token.startsWith(TOKEN_PREFIX)) {
    out.error = "malformed: missing prefix"; return out;
  }
  const rest = token.slice(TOKEN_PREFIX.length);
  const parts = rest.split(".");
  if (parts.length !== 2) { out.error = "malformed: expected payload.signature"; return out; }
  let payload;
  try { payload = JSON.parse(b64uDecode(parts[0]).toString("utf8")); }
  catch { out.error = "malformed: payload not JSON"; return out; }
  out.payload = payload;
  let sig;
  try { sig = b64uDecode(parts[1]); }
  catch { out.error = "malformed: signature not base64url"; return out; }
  const canonical = canonicalJSON(payload);
  let key;
  try { key = pubKey(); } catch (err) { out.error = "no_pubkey: " + err.message; return out; }
  try {
    out.ok = crypto.verify(null, Buffer.from(canonical, "utf8"), key, sig);
  } catch (err) {
    out.error = "verify_failed: " + err.message; return out;
  }
  if (!out.ok) out.error = "signature mismatch";
  return out;
}
