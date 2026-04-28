// /api/automations — admin-scoped n8n proxy. The browser should not hold
// the n8n API key directly; it goes through this proxy so we can audit and
// future-proof rate limits.

import { require_ } from "../auth.js";
import { isConfigured, listWorkflows, getWorkflow, activate, deactivate, listExecutions } from "../connectors/n8n.js";
import { IdParam } from "../schemas/common.js";

export default async function automationRoutes(fastify) {
  fastify.get("/api/automations/n8n/status", { preHandler: require_("admin.view") }, async () => ({
    configured: isConfigured(),
    url: process.env.FORGE_N8N_URL || null,
  }));

  fastify.get("/api/automations/n8n/workflows", { preHandler: require_("admin.view") }, async (req, reply) => {
    if (!isConfigured()) return [];
    try { return await listWorkflows(); }
    catch (err) { return reply.code(502).send({ error: String(err?.message || err) }); }
  });

  fastify.get("/api/automations/n8n/workflows/:id", { preHandler: require_("admin.view") }, async (req, reply) => {
    if (!isConfigured()) return reply.code(503).send({ error: "n8n not configured" });
    try { return await getWorkflow(req.params.id); }
    catch (err) { return reply.code(502).send({ error: String(err?.message || err) }); }
  });

  fastify.post("/api/automations/n8n/workflows/:id/activate", {
    preHandler: require_("admin.edit"),
    schema: { params: IdParam },
  }, async (req, reply) => {
    if (!isConfigured()) return reply.code(503).send({ error: "n8n not configured" });
    try { return await activate(req.params.id, req.user.id); }
    catch (err) { return reply.code(502).send({ error: String(err?.message || err) }); }
  });

  fastify.post("/api/automations/n8n/workflows/:id/deactivate", {
    preHandler: require_("admin.edit"),
    schema: { params: IdParam },
  }, async (req, reply) => {
    if (!isConfigured()) return reply.code(503).send({ error: "n8n not configured" });
    try { return await deactivate(req.params.id, req.user.id); }
    catch (err) { return reply.code(502).send({ error: String(err?.message || err) }); }
  });

  fastify.get("/api/automations/n8n/executions", { preHandler: require_("admin.view") }, async (req, reply) => {
    if (!isConfigured()) return [];
    try { return await listExecutions(req.query?.workflowId, { limit: Number(req.query?.limit || 20) }); }
    catch (err) { return reply.code(502).send({ error: String(err?.message || err) }); }
  });
}
