// Admin-only CRUD for webhooks.

import { require_ } from "../auth.js";
import { listWebhooks, createWebhook, toggleWebhook, deleteWebhook } from "../webhooks.js";

export default async function webhookRoutes(fastify) {
  fastify.get("/api/webhooks", { preHandler: require_("admin.view") }, async () => listWebhooks());

  fastify.post("/api/webhooks", { preHandler: require_("admin.view") }, async (req, reply) => {
    const { name, url, events, secret } = req.body || {};
    if (!name || !url) return reply.code(400).send({ error: "name and url required" });
    const created = createWebhook({ name, url, events: Array.isArray(events) ? events : ["*"], secret, createdBy: req.user.id });
    // Return secret exactly once so callers can configure the receiver.
    return { ...created, secret: created.secret };
  });

  fastify.patch("/api/webhooks/:id", { preHandler: require_("admin.view") }, async (req, reply) => {
    if ("enabled" in (req.body || {})) toggleWebhook(req.params.id, !!req.body.enabled, req.user.id);
    return { ok: true };
  });

  fastify.delete("/api/webhooks/:id", { preHandler: require_("admin.view") }, async (req, reply) => {
    deleteWebhook(req.params.id, req.user.id);
    return { ok: true };
  });
}
