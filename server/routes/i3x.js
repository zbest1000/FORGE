// CESMII i3X 1.0-Beta REST endpoints — mounted on top of the same engine
// the browser uses. Single source of truth, but each org gets its OWN
// engine instance with data filtered to that org so the i3x surface can't
// be used as a cross-tenant read primitive.

import { createI3XServer } from "../../src/core/i3x/server.js";
import { db, jsonOrDefault } from "../db.js";

// Build the same "forgeData" shape the client engine expects, scoped to
// `orgId`. Without an orgId we return null so callers refuse the request
// rather than silently leak everything.
function loadForgeData(orgId) {
  if (!orgId) return null;
  const organization = db.prepare("SELECT * FROM organizations WHERE id = ?").get(orgId);
  if (!organization) return null;
  const workspace = db.prepare("SELECT * FROM workspaces WHERE org_id = ? LIMIT 1").get(orgId)
    || { id: "WS-1", name: "Workspace", org_id: orgId };
  const users = db.prepare("SELECT * FROM users WHERE org_id = ?").all(orgId);
  const teamSpaces = db.prepare("SELECT * FROM team_spaces WHERE org_id = ?").all(orgId);
  const teamSpaceIds = teamSpaces.map(t => t.id);
  const tsPlaceholders = teamSpaceIds.length ? teamSpaceIds.map(() => "?").join(",") : "''";
  const projects = teamSpaceIds.length
    ? db.prepare(`SELECT * FROM projects WHERE team_space_id IN (${tsPlaceholders})`).all(...teamSpaceIds)
    : [];
  const channels = teamSpaceIds.length
    ? db.prepare(`SELECT * FROM channels WHERE team_space_id IN (${tsPlaceholders})`).all(...teamSpaceIds)
    : [];
  const channelIds = channels.map(c => c.id);
  const chPlaceholders = channelIds.length ? channelIds.map(() => "?").join(",") : "''";
  const messages = channelIds.length
    ? db.prepare(`SELECT * FROM messages WHERE channel_id IN (${chPlaceholders})`).all(...channelIds)
    : [];
  const documents = teamSpaceIds.length
    ? db.prepare(`SELECT * FROM documents WHERE team_space_id IN (${tsPlaceholders})`).all(...teamSpaceIds).map(d => ({
        ...d,
        teamSpaceId: d.team_space_id,
        projectId: d.project_id,
        currentRevisionId: d.current_revision_id,
        revisionIds: db.prepare("SELECT id FROM revisions WHERE doc_id = ? ORDER BY created_at").all(d.id).map(r => r.id),
      }))
    : [];
  const docIds = documents.map(d => d.id);
  const docPlaceholders = docIds.length ? docIds.map(() => "?").join(",") : "''";
  const revisions = docIds.length
    ? db.prepare(`SELECT * FROM revisions WHERE doc_id IN (${docPlaceholders})`).all(...docIds).map(r => ({
        ...r, docId: r.doc_id, createdAt: r.created_at,
      }))
    : [];
  const drawings = docIds.length
    ? db.prepare(`SELECT * FROM drawings WHERE doc_id IN (${docPlaceholders})`).all(...docIds).map(d => ({
        ...d, docId: d.doc_id, teamSpaceId: d.team_space_id, projectId: d.project_id,
        sheets: jsonOrDefault(d.sheets, []),
      }))
    : [];
  const drawingIds = drawings.map(d => d.id);
  const dwPlaceholders = drawingIds.length ? drawingIds.map(() => "?").join(",") : "''";
  const markups = drawingIds.length
    ? db.prepare(`SELECT * FROM markups WHERE drawing_id IN (${dwPlaceholders})`).all(...drawingIds).map(m => ({ ...m, drawingId: m.drawing_id, sheetId: m.sheet_id }))
    : [];
  const assets = db.prepare("SELECT * FROM assets WHERE org_id = ?").all(orgId).map(a => ({
    ...a,
    mqttTopics: jsonOrDefault(a.mqtt_topics, []),
    opcuaNodes: jsonOrDefault(a.opcua_nodes, []),
    docIds: jsonOrDefault(a.doc_ids, []),
  }));
  const projectIds = projects.map(p => p.id);
  const prPlaceholders = projectIds.length ? projectIds.map(() => "?").join(",") : "''";
  const workItems = projectIds.length
    ? db.prepare(`SELECT * FROM work_items WHERE project_id IN (${prPlaceholders})`).all(...projectIds).map(w => ({ ...w, projectId: w.project_id }))
    : [];
  const assetIds = assets.map(a => a.id);
  const asPlaceholders = assetIds.length ? assetIds.map(() => "?").join(",") : "''";
  const incidents = assetIds.length
    ? db.prepare(`SELECT * FROM incidents WHERE asset_id IN (${asPlaceholders})`).all(...assetIds).map(i => ({ ...i, assetId: i.asset_id, commanderId: i.commander_id, channelId: i.channel_id, startedAt: i.started_at }))
    : [];
  const dataSources = assetIds.length
    ? db.prepare(`SELECT * FROM data_sources WHERE asset_id IN (${asPlaceholders})`).all(...assetIds).map(d => ({ ...d, integrationId: d.integration_id, assetId: d.asset_id }))
    : [];
  return {
    organization, workspace, users, teamSpaces, projects, channels, messages,
    documents, revisions, drawings, markups, assets, workItems, incidents, dataSources,
    threads: [], approvals: [], forms: [], integrations: [], dashboards: [], aiAgents: [],
    auditEvents: [], notifications: [], comments: [], transmittals: [], eventLog: [],
    deadLetters: [], aiLog: [], savedSearches: [], subscriptions: [], retentionPolicies: [],
    policyViolations: [], files: [],
  };
}

// Per-org engine cache. The engine ticks live values in memory, so we keep
// one per org rather than rebuilding for every request.
const _engines = new Map();
export function getEngine(orgId) {
  if (!orgId) return null;
  const cached = _engines.get(orgId);
  if (cached) return cached;
  const data = loadForgeData(orgId);
  if (!data) return null;
  const engine = createI3XServer(data);
  engine.tickN(20);
  engine.startTicker(2000);
  _engines.set(orgId, engine);
  return engine;
}

// Invalidate cache on mutations (called from routes when DB changes).
// Without an orgId we invalidate every cached engine — safe but coarser.
export function invalidateEngine(orgId) {
  if (orgId) {
    const eng = _engines.get(orgId);
    if (eng) {
      try { eng.stopTicker?.(); } catch {}
      _engines.delete(orgId);
    }
    return;
  }
  for (const eng of _engines.values()) {
    try { eng.stopTicker?.(); } catch {}
  }
  _engines.clear();
}

export default async function i3xRoutes(fastify) {
  // Tenant-scope every i3x route. Without an authenticated user we refuse;
  // with one, the engine is loaded for that user's org so cross-tenant
  // reads through this surface are not possible. The org-scoped engines
  // are cached in `_engines` (above) so the per-request cost is just the
  // map lookup after the first hit per org.
  fastify.addHook("preHandler", async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: "unauthenticated" });
    const orgId = req.user.org_id;
    const engine = getEngine(orgId);
    if (!engine) return reply.code(403).send({ error: "no engine for org", orgId });
    req.engine = engine;
  });

  fastify.get("/v1/info",              async (req) => req.engine.getInfo());
  fastify.get("/v1/namespaces",        async (req) => req.engine.getNamespaces());
  fastify.get("/v1/objecttypes",       async (req) => req.engine.getObjectTypes(req.query.namespaceUri || null));
  fastify.post("/v1/objecttypes/query",async (req) => req.engine.queryObjectTypesById(req.body || {}));
  fastify.get("/v1/relationshiptypes", async (req) => req.engine.getRelationshipTypes(req.query.namespaceUri || null));
  fastify.post("/v1/relationshiptypes/query", async (req) => req.engine.queryRelationshipTypesById(req.body || {}));
  fastify.get("/v1/objects",           async (req) => req.engine.getObjects({
    typeElementId: req.query.typeElementId || null,
    includeMetadata: !!req.query.includeMetadata,
    root: req.query.root != null ? /^(1|true|yes)$/i.test(req.query.root) : null,
  }));
  fastify.post("/v1/objects/list",     async (req) => req.engine.listObjectsById(req.body || {}));
  fastify.post("/v1/objects/related",  async (req) => req.engine.queryRelatedObjects(req.body || {}));
  fastify.post("/v1/objects/value",    async (req) => req.engine.queryLastKnownValues(req.body || {}));
  fastify.post("/v1/objects/history",  async (req) => req.engine.queryHistoricalValues(req.body || {}));
  fastify.get("/v1/objects/:id/history", async (req) => req.engine.getHistoricalValues(req.params.id, {
    startTime: req.query.startTime, endTime: req.query.endTime,
    maxDepth: req.query.maxDepth != null ? Number(req.query.maxDepth) : 1,
  }));
  fastify.put("/v1/objects/:id/value", async (req, reply) => {
    const r = req.engine.updateObjectValue(req.params.id, req.body);
    if (!r.success) return reply.code(r.error?.code || 500).send(r);
    return r;
  });

  fastify.post("/v1/subscriptions",         async (req) => req.engine.createSubscription(req.body || {}));
  fastify.post("/v1/subscriptions/register",async (req) => req.engine.registerMonitoredItems(req.body || {}));
  fastify.post("/v1/subscriptions/unregister", async (req) => req.engine.removeMonitoredItems(req.body || {}));
  fastify.post("/v1/subscriptions/sync",    async (req) => req.engine.syncSubscription(req.body || {}));
  fastify.post("/v1/subscriptions/list",    async (req) => req.engine.listSubscriptions(req.body || {}));
  fastify.post("/v1/subscriptions/delete",  async (req) => req.engine.deleteSubscriptions(req.body || {}));

  // SSE stream of a subscription.
  fastify.post("/v1/subscriptions/stream", async (req, reply) => {
    const sid = req.body?.subscriptionId;
    if (!sid) return reply.code(400).send({ error: "subscriptionId required" });
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    const res = req.engine.streamSubscription({ subscriptionId: sid, onEvent: (u) => {
      try { reply.raw.write(`event: update\ndata: ${JSON.stringify(u)}\n\n`); } catch {}
    }});
    if (!res.success) {
      reply.raw.write(`event: error\ndata: ${JSON.stringify(res.error)}\n\n`);
      reply.raw.end();
      return reply;
    }
    const ka = setInterval(() => { try { reply.raw.write(":keepalive\n\n"); } catch {} }, 25000);
    req.raw.on("close", () => { clearInterval(ka); try { res.data.close(); } catch {} });
  });
}
