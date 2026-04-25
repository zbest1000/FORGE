// AI provider adapters with policy-driven routing (spec §14).
//
// Three adapters:
//   - "local"      : deterministic in-process responder (always available;
//                    citations come from the search index)
//   - "openai"     : OpenAI-compatible chat-completions HTTP adapter
//   - "ollama"     : Ollama HTTP adapter (http://localhost:11434 by default)
//
// Routing is decided per-request from a tenant policy. The policy is
// stored in env (FORGE_AI_POLICY) so a deployment can keep keys + routing
// outside the database. Every call appends an `ai_log` row tagged with
// `retention: no-training-by-default`.

import { db, now, uuid } from "./db.js";
import { audit } from "./audit.js";

function getPolicy() {
  const raw = process.env.FORGE_AI_POLICY;
  if (!raw) return { default: "local", allow: ["local"] };
  try {
    const p = JSON.parse(raw);
    return { default: p.default || "local", allow: p.allow || [p.default || "local"], providers: p.providers || {} };
  } catch {
    return { default: "local", allow: ["local"] };
  }
}

export function listProviders() {
  const p = getPolicy();
  return p.allow.map(name => ({
    name,
    default: name === p.default,
    configured: !!(p.providers?.[name]),
  }));
}

export async function ask({ prompt, provider, scope, citations = [], userId }) {
  const policy = getPolicy();
  const chosen = policy.allow.includes(provider) ? provider : policy.default;
  const traceId = uuid("trace-ai");
  let output, model = chosen;
  try {
    if (chosen === "openai") {
      const r = await callOpenAI(prompt, policy.providers?.openai || {});
      output = r.text;
      model = r.model || "openai";
    } else if (chosen === "ollama") {
      const r = await callOllama(prompt, policy.providers?.ollama || {});
      output = r.text;
      model = r.model || "ollama";
    } else {
      output = localResponder(prompt, citations);
    }
  } catch (err) {
    audit({ actor: userId || "system", action: "ai.error", subject: "ai.workspace", detail: { provider: chosen, error: String(err?.message || err), traceId } });
    output = `[provider ${chosen} failed: ${String(err?.message || err)}] (falling back to deterministic responder)`;
    output = output + "\n\n" + localResponder(prompt, citations);
    model = `${chosen}-fallback`;
  }
  const id = uuid("AI");
  db.prepare(`INSERT INTO ai_log (id, ts, actor, prompt, output, citations, model, scope, trace_id, retention)
              VALUES (@id, @ts, @actor, @prompt, @output, @citations, @model, @scope, @trace_id, 'no-training-by-default')`)
    .run({
      id, ts: now(), actor: userId || "anonymous", prompt, output,
      citations: JSON.stringify(citations), model, scope: JSON.stringify(scope || {}), trace_id: traceId,
    });
  audit({ actor: userId || "system", action: "ai.call", subject: "ai.workspace", detail: { provider: chosen, citations: citations.length, traceId } });
  return { output, model, citations, traceId };
}

function localResponder(prompt, citations) {
  // Same shape as the client's deterministic responder; lives here so the
  // server has a non-LLM fallback that always works in air-gapped runs.
  const q = String(prompt || "").toLowerCase();
  if (q.includes("incident")) return `Active incidents are listed at /incidents. Citations: ${citations.slice(0, 4).join(", ")}.`;
  if (q.includes("revision") || q.includes("rev "))
    return `Revisions follow Draft→IFR→Approved→IFC→Superseded/Archived; promotions cascade automatic supersede. Citations: ${citations.slice(0, 4).join(", ")}.`;
  return `Searched the FORGE index for "${prompt}". Top citations: ${citations.slice(0, 4).join(", ") || "(none — refine your query or scope)"}.`;
}

async function callOpenAI(prompt, cfg) {
  const url = (cfg.baseUrl || "https://api.openai.com/v1") + "/chat/completions";
  const apiKey = cfg.apiKey || process.env.FORGE_AI_OPENAI_KEY;
  if (!apiKey) throw new Error("OpenAI provider not configured (FORGE_AI_OPENAI_KEY missing)");
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 20_000);
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: cfg.model || "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are FORGE, a citation-strict engineering assistant. Always cite element ids when supplied." },
        { role: "user", content: prompt },
      ],
      temperature: cfg.temperature ?? 0.2,
    }),
    signal: ac.signal,
  });
  clearTimeout(t);
  if (!res.ok) throw new Error(`openai HTTP ${res.status}`);
  const j = await res.json();
  return { text: j.choices?.[0]?.message?.content || "", model: j.model };
}

async function callOllama(prompt, cfg) {
  const url = (cfg.baseUrl || "http://localhost:11434") + "/api/chat";
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 30_000);
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: cfg.model || "llama3.1",
      messages: [
        { role: "system", content: "You are FORGE, a citation-strict engineering assistant." },
        { role: "user", content: prompt },
      ],
      stream: false,
    }),
    signal: ac.signal,
  });
  clearTimeout(t);
  if (!res.ok) throw new Error(`ollama HTTP ${res.status}`);
  const j = await res.json();
  return { text: j.message?.content || "", model: j.model };
}
