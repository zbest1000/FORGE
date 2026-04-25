// n8n integration helper.
//
// FORGE talks to n8n in three directions:
//
//   1. Inbound: n8n calls FORGE's REST and GraphQL APIs using a long-lived
//      `fgt_…` API token (created in Admin > API tokens).
//   2. Outbound: FORGE's signed webhooks (HMAC-SHA256, `X-FORGE-Signature`)
//      are consumed by n8n's Webhook trigger node. The receiver verifies
//      the signature against the per-webhook secret.
//   3. Bridge: this module proxies a small subset of n8n's REST API so the
//      FORGE Admin UI can list/activate workflows without leaving FORGE.
//
// Configuration:
//   FORGE_N8N_URL    e.g. http://n8n:5678   (the n8n server URL, internal)
//   FORGE_N8N_API_KEY  X-N8N-API-KEY for n8n's public API
//
// All proxy calls audit the actor + which workflow was touched.

import { audit } from "../audit.js";

function cfg() {
  return {
    url: (process.env.FORGE_N8N_URL || "").replace(/\/+$/, ""),
    apiKey: process.env.FORGE_N8N_API_KEY || "",
  };
}

export function isConfigured() { return !!cfg().url; }

async function call(path, { method = "GET", body = null } = {}) {
  const { url, apiKey } = cfg();
  if (!url) throw new Error("n8n not configured (FORGE_N8N_URL missing)");
  const headers = { "content-type": "application/json" };
  if (apiKey) headers["X-N8N-API-KEY"] = apiKey;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 10_000);
  try {
    const res = await fetch(url + path, {
      method, headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: ac.signal,
    });
    const text = await res.text();
    let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      const err = new Error(`n8n ${method} ${path} → HTTP ${res.status}`);
      err.status = res.status; err.body = data;
      throw err;
    }
    return data;
  } finally { clearTimeout(t); }
}

export async function listWorkflows() {
  const data = await call("/api/v1/workflows");
  return data?.data || data || [];
}
export async function getWorkflow(id) {
  return (await call(`/api/v1/workflows/${encodeURIComponent(id)}`))?.data || null;
}
export async function activate(id, actorId) {
  audit({ actor: actorId || "system", action: "n8n.workflow.activate", subject: id });
  return call(`/api/v1/workflows/${encodeURIComponent(id)}/activate`, { method: "POST" });
}
export async function deactivate(id, actorId) {
  audit({ actor: actorId || "system", action: "n8n.workflow.deactivate", subject: id });
  return call(`/api/v1/workflows/${encodeURIComponent(id)}/deactivate`, { method: "POST" });
}
export async function listExecutions(workflowId, { limit = 20 } = {}) {
  const path = workflowId
    ? `/api/v1/executions?workflowId=${encodeURIComponent(workflowId)}&limit=${limit}`
    : `/api/v1/executions?limit=${limit}`;
  return (await call(path))?.data || [];
}
