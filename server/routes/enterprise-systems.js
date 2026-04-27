import { require_ } from "../auth.js";
import {
  createSystem,
  listSystems,
  updateSystem,
  recordRun,
  listRuns,
  createExternalLink,
  listExternalLinks,
  CONNECTOR_TYPES,
} from "../integrations/registry.js";
import {
  EnterpriseSystemCreateBody,
  EnterpriseSystemPatchBody,
  EnterpriseSystemSyncBody,
  ExternalLinkCreateBody,
} from "../schemas/integrations.js";

export default async function enterpriseSystemRoutes(fastify) {
  fastify.get("/api/enterprise-systems/types", { preHandler: require_("integration.read") }, async () => CONNECTOR_TYPES);

  fastify.get("/api/enterprise-systems", { preHandler: require_("integration.read") }, async (req) =>
    listSystems({ category: req.query.category, status: req.query.status }));

  fastify.post("/api/enterprise-systems", {
    preHandler: require_("integration.write"),
    schema: { body: EnterpriseSystemCreateBody },
  }, async (req, reply) => {
    const { name, category, vendor = null, baseUrl = null, authType = "none", secretRef = null, capabilities = [], dataResidency = null, ownerId = null, config = {} } = req.body || {};
    if (!name || !category) return reply.code(400).send({ error: "name and category required" });
    return createSystem({ name, category, vendor, baseUrl, authType, secretRef, capabilities, dataResidency, ownerId, config, actor: req.user.id });
  });

  fastify.patch("/api/enterprise-systems/:id", {
    preHandler: require_("integration.write"),
    schema: { body: EnterpriseSystemPatchBody },
  }, async (req, reply) => {
    const updated = updateSystem(req.params.id, req.body || {}, req.user.id);
    if (!updated) return reply.code(404).send({ error: "not found" });
    return updated;
  });

  fastify.post("/api/enterprise-systems/:id/test", { preHandler: require_("integration.write") }, async (req, reply) => {
    const run = recordRun({ systemId: req.params.id, runType: "test", requestedBy: req.user.id, stats: { mode: "dry-run" } });
    if (!run) return reply.code(404).send({ error: "not found" });
    return run;
  });

  fastify.post("/api/enterprise-systems/:id/sync", {
    preHandler: require_("integration.write"),
    schema: { body: EnterpriseSystemSyncBody },
  }, async (req, reply) => {
    const run = recordRun({ systemId: req.params.id, runType: "sync", requestedBy: req.user.id, stats: { requested: req.body || {} } });
    if (!run) return reply.code(404).send({ error: "not found" });
    return run;
  });

  fastify.get("/api/enterprise-systems/:id/runs", { preHandler: require_("integration.read") }, async (req) => listRuns(req.params.id));

  fastify.get("/api/external-links", { preHandler: require_("integration.read") }, async (req) =>
    listExternalLinks({ forgeKind: req.query.forgeKind, forgeId: req.query.forgeId, systemId: req.query.systemId }));

  fastify.post("/api/external-links", {
    preHandler: require_("integration.write"),
    schema: { body: ExternalLinkCreateBody },
  }, async (req, reply) => {
    const { systemId, externalKind, externalId, forgeKind, forgeId, direction = "bidirectional", metadata = {} } = req.body || {};
    if (!systemId || !externalKind || !externalId || !forgeKind || !forgeId) {
      return reply.code(400).send({ error: "systemId, externalKind, externalId, forgeKind, forgeId required" });
    }
    const link = createExternalLink({ systemId, externalKind, externalId, forgeKind, forgeId, direction, metadata, actor: req.user.id });
    if (!link) return reply.code(404).send({ error: "system not found" });
    return link;
  });
}
