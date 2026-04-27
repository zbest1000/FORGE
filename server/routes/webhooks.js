// Admin-only CRUD for webhooks.

import { require_ } from "../auth.js";
import { listWebhooks, createWebhook, toggleWebhook, deleteWebhook, listDeliveries } from "../webhooks.js";
import { WebhookCreateBody, WebhookPatchBody } from "../schemas/webhooks.js";

export default async function webhookRoutes(fastify) {
  fastify.get("/api/webhooks", { preHandler: require_("admin.view") }, async () => listWebhooks());

  fastify.post("/api/webhooks", {
    preHandler: require_("webhook.write"),
    schema: { body: WebhookCreateBody },
  }, async (req, reply) => {
    const { name, url, events, secret } = req.body || {};
    if (!name || !url) return reply.code(400).send({ error: "name and url required" });
    try {
      const created = createWebhook({ name, url, events: Array.isArray(events) ? events : ["*"], secret, createdBy: req.user.id });
      return { ...created, secret: created.secret };
    } catch (err) {
      if (err?.statusCode === 400) return reply.code(400).send({ error: "url rejected", reason: err.code });
      throw err;
    }
  });

  fastify.patch("/api/webhooks/:id", {
    preHandler: require_("webhook.write"),
    schema: { body: WebhookPatchBody },
  }, async (req, reply) => {
    if ("enabled" in (req.body || {})) toggleWebhook(req.params.id, !!req.body.enabled, req.user.id);
    return { ok: true };
  });

  fastify.delete("/api/webhooks/:id", { preHandler: require_("webhook.write") }, async (req, reply) => {
    deleteWebhook(req.params.id, req.user.id);
    return { ok: true };
  });

  fastify.get("/api/webhooks/:id/deliveries", { preHandler: require_("admin.view") }, async (req) => {
    return listDeliveries(req.params.id, Number(req.query?.limit || 50));
  });
}
