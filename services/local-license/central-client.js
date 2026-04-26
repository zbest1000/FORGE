// Local license server → FORGE LLC central server client.
//
// One outbound HTTPS connection per local LS. Configured by env:
//
//   FORGE_LLC_URL           default https://license.forge.llc
//   FORGE_CUSTOMER_ID       customer identifier (CUST-…)
//   FORGE_ACTIVATION_KEY    bearer credential
//   FORGE_LLC_TIMEOUT_MS    default 15000
//
// The client is intentionally tiny: no third-party HTTP library, just
// global fetch with a timeout AbortController. It returns the raw
// JSON envelope from the central server for downstream handling.

import os from "node:os";
import crypto from "node:crypto";

const DEFAULT_URL = process.env.FORGE_LLC_URL || "https://license.forge.llc";
const TIMEOUT_MS  = Number(process.env.FORGE_LLC_TIMEOUT_MS || 15_000);

function joinUrl(base, p) {
  return base.replace(/\/+$/, "") + "/" + p.replace(/^\/+/, "");
}

async function call(method, urlPath, body, env = {}) {
  const url = joinUrl(env.url || DEFAULT_URL, urlPath);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error("timeout")), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        "Authorization": "Bearer " + (env.activation_key || process.env.FORGE_ACTIVATION_KEY || ""),
        "Content-Type": "application/json",
        "User-Agent": "forge-local-ls/0.4.0",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* keep null */ }
    return { status: res.status, ok: res.ok, body: json, raw: text };
  } finally {
    clearTimeout(t);
  }
}

function fingerprint() {
  return {
    node_version: process.version,
    platform: process.platform + "-" + process.arch,
    hostname_hash: crypto.createHash("sha256").update(os.hostname()).digest("hex"),
    pid: process.pid,
  };
}

export async function activate({ instance_id, customer_id }) {
  return call("POST", "/api/v1/activate", {
    customer_id,
    instance_id,
    fingerprint: fingerprint(),
    client_version: "0.4.0",
  });
}

export async function refresh({ instance_id, customer_id, prior_bundle_id }) {
  return call("POST", "/api/v1/refresh", {
    customer_id,
    instance_id,
    prior_bundle_id,
    fingerprint: fingerprint(),
    client_version: "0.4.0",
  });
}

export async function heartbeat({ instance_id, customer_id }) {
  return call("POST", "/api/v1/heartbeat", {
    customer_id,
    instance_id,
    fingerprint: fingerprint(),
    client_version: "0.4.0",
  });
}
