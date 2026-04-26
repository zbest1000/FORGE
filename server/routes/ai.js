// /api/ai — provider-routed Q&A. Server-side adapter pool with citation-
// backed retrieval over the FTS index.

import { db } from "../db.js";
import { require_ } from "../auth.js";
import { ask, listProviders } from "../ai.js";

export default async function aiRoutes(fastify) {
  fastify.get("/api/ai/providers", { preHandler: require_("view") }, async () => listProviders());

  fastify.post("/api/ai/ask", { preHandler: require_("view") }, async (req, reply) => {
    const { prompt, provider, scope = {} } = req.body || {};
    if (!prompt) return reply.code(400).send({ error: "prompt required" });

    // Pre-fetch a few citations from FTS so the response always has anchors.
    const esc = String(prompt).replace(/"/g, '""');
    let cites = [];
    try {
      const docs = db.prepare("SELECT id FROM fts_docs WHERE fts_docs MATCH ? LIMIT 3").all(`"${esc}"*`);
      const wis  = db.prepare("SELECT id FROM fts_workitems WHERE fts_workitems MATCH ? LIMIT 2").all(`"${esc}"*`);
      cites = [...docs.map(r => r.id), ...wis.map(r => r.id)];
    } catch { /* invalid token */ }

    const result = await ask({ prompt, provider, scope, citations: cites, userId: req.user.id });
    return result;
  });
}
