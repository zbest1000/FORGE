// /api/ai — provider-routed Q&A. Server-side adapter pool with citation-
// backed retrieval over the FTS index.

import { db } from "../db.js";
import { require_ } from "../auth.js";
import { ask, listProviders } from "../ai.js";
import { sanitizeFtsTerm } from "../security/fts.js";
import { AiAskBody } from "../schemas/integrations.js";

export default async function aiRoutes(fastify) {
  fastify.get("/api/ai/providers", { preHandler: require_("view") }, async () => listProviders());

  fastify.post("/api/ai/ask", {
    preHandler: require_("view"),
    schema: { body: AiAskBody },
  }, async (req, reply) => {
    const { prompt, provider, scope = {} } = req.body || {};
    if (!prompt) return reply.code(400).send({ error: "prompt required" });

    // Pre-fetch a few citations from FTS so the response always has
    // anchors. The prompt is user-supplied free-form text; sanitise
    // before handing it to FTS5 (strip control chars + operators).
    // Citations are tenant-scoped: we JOIN through documents/revisions/
    // work_items → team_spaces → org_id and discard hits from other
    // orgs so the AI surface can't be used as a cross-tenant read.
    let cites = [];
    const phrase = sanitizeFtsTerm(prompt);
    const orgId = req.user?.org_id;
    if (phrase && orgId) {
      try {
        const docs = db.prepare(`
          SELECT f.id, f.kind FROM fts_docs f
          LEFT JOIN documents d  ON f.kind = 'Document' AND d.id  = f.id
          LEFT JOIN revisions  r ON f.kind = 'Revision' AND r.id  = f.id
          LEFT JOIN documents d2 ON f.kind = 'Revision' AND d2.id = r.doc_id
          LEFT JOIN team_spaces ts1 ON d.team_space_id  = ts1.id
          LEFT JOIN team_spaces ts2 ON d2.team_space_id = ts2.id
          WHERE fts_docs MATCH ?
            AND (ts1.org_id = ? OR ts2.org_id = ?)
          LIMIT 3
        `).all(phrase, orgId, orgId);
        const wis = db.prepare(`
          SELECT f.id FROM fts_workitems f
          JOIN work_items w ON w.id = f.id
          JOIN projects p   ON p.id = w.project_id
          JOIN team_spaces t ON t.id = p.team_space_id
          WHERE fts_workitems MATCH ?
            AND t.org_id = ?
          LIMIT 2
        `).all(phrase, orgId);
        cites = [...docs.map(r => r.id), ...wis.map(r => r.id)];
      } catch { /* invalid token */ }
    }

    const result = await ask({ prompt, provider, scope, citations: cites, userId: req.user.id });
    return result;
  });
}
