// CESMII i3X 1.0-Beta REST endpoints — mounted on top of the same engine
// the browser uses. Single source of truth.

import { createI3XServer } from "../../src/core/i3x/server.js";
import { db, jsonOrDefault } from "../db.js";

// Build the same "forgeData" shape the client engine expects, from SQLite.
function loadForgeData() {
  const organization = db.prepare("SELECT * FROM organizations LIMIT 1").get() || { id: "ORG-1", name: "Atlas" };
  const workspace = db.prepare("SELECT * FROM workspaces LIMIT 1").get() || { id: "WS-1", name: "Workspace" };
  const users = db.prepare("SELECT * FROM users").all();
  const teamSpaces = db.prepare("SELECT * FROM team_spaces").all();
  const projects = db.prepare("SELECT * FROM projects").all();
  const channels = db.prepare("SELECT * FROM channels").all();
  const messages = db.prepare("SELECT * FROM messages").all();
  const documents = db.prepare("SELECT * FROM documents").all().map(d => ({
    ...d,
    teamSpaceId: d.team_space_id,
    projectId: d.project_id,
    currentRevisionId: d.current_revision_id,
    revisionIds: db.prepare("SELECT id FROM revisions WHERE doc_id = ? ORDER BY created_at").all(d.id).map(r => r.id),
  }));
  const revisions = db.prepare("SELECT * FROM revisions").all().map(r => ({
    ...r, docId: r.doc_id, createdAt: r.created_at,
  }));
  const drawings = db.prepare("SELECT * FROM drawings").all().map(d => ({
    ...d, docId: d.doc_id, teamSpaceId: d.team_space_id, projectId: d.project_id,
    sheets: jsonOrDefault(d.sheets, []),
  }));
  const markups = db.prepare("SELECT * FROM markups").all().map(m => ({ ...m, drawingId: m.drawing_id, sheetId: m.sheet_id }));
  const assets = db.prepare("SELECT * FROM assets").all().map(a => ({
    ...a,
    mqttTopics: jsonOrDefault(a.mqtt_topics, []),
    opcuaNodes: jsonOrDefault(a.opcua_nodes, []),
    docIds: jsonOrDefault(a.doc_ids, []),
  }));
  const workItems = db.prepare("SELECT * FROM work_items").all().map(w => ({ ...w, projectId: w.project_id }));
  const incidents = db.prepare("SELECT * FROM incidents").all().map(i => ({ ...i, assetId: i.asset_id, commanderId: i.commander_id, channelId: i.channel_id, startedAt: i.started_at }));
  const dataSources = db.prepare("SELECT * FROM data_sources").all().map(d => ({ ...d, integrationId: d.integration_id, assetId: d.asset_id }));
  return {
    organization, workspace, users, teamSpaces, projects, channels, messages,
    documents, revisions, drawings, markups, assets, workItems, incidents, dataSources,
    threads: [], approvals: [], forms: [], integrations: [], dashboards: [], aiAgents: [],
    auditEvents: [], notifications: [], comments: [], transmittals: [], eventLog: [],
    deadLetters: [], aiLog: [], savedSearches: [], subscriptions: [], retentionPolicies: [],
    policyViolations: [], files: [],
  };
}

let _engine = null;
export function getEngine() {
  if (!_engine) {
    _engine = createI3XServer(loadForgeData());
    _engine.tickN(20);
    _engine.startTicker(2000);
  }
  return _engine;
}

// Invalidate cache on mutations (called from routes when DB changes).
export function invalidateEngine() {
  try { _engine?.stopTicker?.(); } catch {}
  _engine = null;
}

export default async function i3xRoutes(fastify) {
  fastify.get("/v1/info",              async () => getEngine().getInfo());
  fastify.get("/v1/namespaces",        async () => getEngine().getNamespaces());
  fastify.get("/v1/objecttypes",       async (req) => getEngine().getObjectTypes(req.query.namespaceUri || null));
  fastify.post("/v1/objecttypes/query",async (req) => getEngine().queryObjectTypesById(req.body || {}));
  fastify.get("/v1/relationshiptypes", async (req) => getEngine().getRelationshipTypes(req.query.namespaceUri || null));
  fastify.post("/v1/relationshiptypes/query", async (req) => getEngine().queryRelationshipTypesById(req.body || {}));
  fastify.get("/v1/objects",           async (req) => getEngine().getObjects({
    typeElementId: req.query.typeElementId || null,
    includeMetadata: !!req.query.includeMetadata,
    root: req.query.root != null ? /^(1|true|yes)$/i.test(req.query.root) : null,
  }));
  fastify.post("/v1/objects/list",     async (req) => getEngine().listObjectsById(req.body || {}));
  fastify.post("/v1/objects/related",  async (req) => getEngine().queryRelatedObjects(req.body || {}));
  fastify.post("/v1/objects/value",    async (req) => getEngine().queryLastKnownValues(req.body || {}));
  fastify.post("/v1/objects/history",  async (req) => getEngine().queryHistoricalValues(req.body || {}));
  fastify.get("/v1/objects/:id/history", async (req) => getEngine().getHistoricalValues(req.params.id, {
    startTime: req.query.startTime, endTime: req.query.endTime,
    maxDepth: req.query.maxDepth != null ? Number(req.query.maxDepth) : 1,
  }));
  fastify.put("/v1/objects/:id/value", async (req, reply) => {
    const r = getEngine().updateObjectValue(req.params.id, req.body);
    if (!r.success) return reply.code(r.error?.code || 500).send(r);
    return r;
  });

  fastify.post("/v1/subscriptions",         async (req) => getEngine().createSubscription(req.body || {}));
  fastify.post("/v1/subscriptions/register",async (req) => getEngine().registerMonitoredItems(req.body || {}));
  fastify.post("/v1/subscriptions/unregister", async (req) => getEngine().removeMonitoredItems(req.body || {}));
  fastify.post("/v1/subscriptions/sync",    async (req) => getEngine().syncSubscription(req.body || {}));
  fastify.post("/v1/subscriptions/list",    async (req) => getEngine().listSubscriptions(req.body || {}));
  fastify.post("/v1/subscriptions/delete",  async (req) => getEngine().deleteSubscriptions(req.body || {}));

  // SSE stream of a subscription.
  fastify.post("/v1/subscriptions/stream", async (req, reply) => {
    const sid = req.body?.subscriptionId;
    if (!sid) return reply.code(400).send({ error: "subscriptionId required" });
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    const res = getEngine().streamSubscription({ subscriptionId: sid, onEvent: (u) => {
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
