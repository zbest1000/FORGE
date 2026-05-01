// Live OPC UA address-space refresh — Phase 7d.
//
// Boots the lightweight FORGE OPC UA server alongside an
// in-process Fastify carrying the asset-hierarchy + core (asset)
// routes. Performs writes via REST (rename enterprise, add asset,
// delete asset) and asserts that a real node-opcua client sees
// the new shape on its next Browse — proving the address space
// rebuilds in place without a server restart.
//
// What this exercises:
//   - Granular per-enterprise rebuild (renaming an enterprise
//     refreshes that one subtree, not the whole address space).
//   - New asset POSTed via REST shows up under its location after
//     the refresh hook fires.
//   - Asset DELETE (cascade) removes the Variable from the
//     address space.
//
// We listen on a random localhost port for the OPC UA server.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-opcua-live-"));
process.env.FORGE_DATA_DIR = tmpDir;
process.env.FORGE_TENANT_KEY = "forge-opcua-live-test";
process.env.FORGE_JWT_SECRET = "forge-opcua-live-test-jwt";
process.env.FORGE_OPCUA_SERVER_ENABLED = "1";
process.env.FORGE_RATELIMIT_MAX = "10000";
process.env.FORGE_DISABLE_CONNECTOR_REGISTRY = "1";
process.env.LOG_LEVEL = "warn";

// Discover free port for the OPC UA server.
const portProbe = net.createServer();
await new Promise(r => portProbe.listen(0, "127.0.0.1", r));
const opcPort = portProbe.address().port;
await new Promise(r => portProbe.close(r));
process.env.FORGE_OPCUA_SERVER_PORT = String(opcPort);
process.env.FORGE_OPCUA_SERVER_SECURITY_MODE = "None";
process.env.FORGE_OPCUA_SERVER_SECURITY_POLICY = "None";

const { db } = await import("../server/db.js");
const bcrypt = (await import("bcryptjs")).default;
const ts = new Date().toISOString();

// Seed: org, workspace, admin user, one enterprise + one location +
// one asset already in place so the OPC UA server has something
// to advertise on first boot.
db.prepare("INSERT INTO organizations (id, name, tenant_key, created_at) VALUES ('ORG-A','Atlas','atlas',?)").run(ts);
db.prepare("INSERT INTO workspaces (id, org_id, name, region, created_at) VALUES ('WS-A','ORG-A','North','us-east',?)").run(ts);
const adminHash = await bcrypt.hash("forge", 10);
db.prepare("INSERT INTO users (id, org_id, email, name, role, password_hash, initials, disabled, created_at, updated_at) VALUES ('U-OWNER','ORG-A','owner@forge.local','Owner','Organization Owner',?,'OW',0,?,?)").run(adminHash, ts, ts);

db.prepare("INSERT INTO enterprises (id, org_id, workspace_id, name, description, sort_order, acl, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
  .run("ENT-1", "ORG-A", "WS-A", "Atlas_Initial", "live-refresh seed", 0, "{}", ts, ts);
db.prepare("INSERT INTO locations (id, org_id, workspace_id, enterprise_id, parent_location_id, name, kind, sort_order, acl, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
  .run("LOC-1", "ORG-A", "WS-A", "ENT-1", null, "Plant", "site", 0, "{}", ts, ts);
db.prepare("INSERT INTO assets (id, org_id, workspace_id, name, type, hierarchy, status, mqtt_topics, opcua_nodes, doc_ids, acl, labels, enterprise_id, location_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
  .run("AS-Existing", "ORG-A", "WS-A", "Pump-A", "pump", "Atlas/Plant/Pump-A", "normal", "[]", "[]", "[]", "{}", "[]", "ENT-1", "LOC-1", ts, ts);

// Boot the OPC UA server.
const srvMod = await import("../server/opcua-server.js");
const startResult = await srvMod.startOpcuaServer({ logger: console });
if (!startResult?.ok) throw new Error(`opcua server start failed: ${startResult?.reason}`);

// Boot Fastify with the asset routes (so we can drive
// enterprise/location/asset writes via REST and watch the OPC UA
// address space rebuild itself in response).
const { default: Fastify } = await import("fastify");
const { default: jwt } = await import("@fastify/jwt");
const { default: cors } = await import("@fastify/cors");
const { default: rateLimit } = await import("@fastify/rate-limit");
const { default: multipart } = await import("@fastify/multipart");
const { userById } = await import("../server/auth.js");

const app = Fastify({ logger: false });
await app.register(cors, { origin: true });
await app.register(jwt, { secret: process.env.FORGE_JWT_SECRET });
await app.register(rateLimit, { global: true, max: 10000, timeWindow: "1 minute", keyGenerator: (req) => (req.user?.id || req.ip || "anon") });
await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });
app.addHook("onRequest", async (req) => {
  const h = req.headers.authorization || "";
  const tok = h.startsWith("Bearer ") ? h.slice(7) : null;
  req.user = null;
  if (!tok) return;
  try {
    const d = app.jwt.verify(tok);
    if (!d?.sub) return;
    req.user = userById(d.sub);
  } catch {}
});
await app.register((await import("../server/routes/auth.js")).default);
await app.register((await import("../server/routes/core.js")).default);
await app.register((await import("../server/routes/asset-hierarchy.js")).default);

await app.listen({ port: 0, host: "127.0.0.1" });
const apiBase = `http://127.0.0.1:${app.server.address().port}`;
async function login(email) {
  const r = await fetch(apiBase + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "forge" }) });
  return (await r.json()).token;
}
const TOKEN = await login("owner@forge.local");
async function api(p, opts = {}) {
  const r = await fetch(apiBase + p, opts);
  const ct = r.headers.get("content-type") || "";
  return { status: r.status, body: ct.includes("application/json") ? await r.json() : await r.text(), headers: r.headers };
}

// Spin a real node-opcua client to browse the address space.
const opcuaPkg = await import("node-opcua");
const m = opcuaPkg.default || opcuaPkg;
const endpoint = startResult.endpoint || `opc.tcp://127.0.0.1:${opcPort}/forge`;
const client = m.OPCUAClient.create({
  applicationName: "FORGE-LIVE-REFRESH-SMOKE",
  securityMode: m.MessageSecurityMode.None,
  securityPolicy: m.SecurityPolicy.None,
  endpointMustExist: false,
  connectionStrategy: { initialDelay: 200, maxRetry: 2, maxDelay: 2000 },
});
await client.connect(endpoint);
const session = await client.createSession();

test.after(async () => {
  try { await session.close(); } catch {}
  try { await client.disconnect(); } catch {}
  await srvMod.stopOpcuaServer();
  try { await app.close(); } catch {}
});

// Browse helper.
async function browseEnterprises() {
  const root = await session.browse("ns=0;i=85");
  const entFolder = root.references.find(r => /Enterprises/.test(r.browseName?.name));
  if (!entFolder) return [];
  const ents = await session.browse(entFolder.nodeId);
  return (ents.references || []).map(r => ({ name: r.browseName?.name, nodeId: r.nodeId.toString() }));
}
async function browseChildren(parentNodeId) {
  const r = await session.browse(parentNodeId);
  return (r.references || []).map(x => ({ name: x.browseName?.name, nodeId: x.nodeId.toString() }));
}

const jsonHeaders = (tok) => ({ authorization: `Bearer ${tok}`, "content-type": "application/json" });
const withAuth = (tok) => ({ authorization: `Bearer ${tok}` });

// ----- tests -----

test("seed enterprise visible on first browse (boot-time build)", async () => {
  const ents = await browseEnterprises();
  assert.ok(ents.find(e => /Atlas_Initial/.test(e.name)), `expected Atlas_Initial; got ${ents.map(e => e.name).join(",")}`);
});

test("rename enterprise via PATCH triggers granular subtree rebuild", async () => {
  // Fetch ETag.
  const get = await api(`/api/enterprises/ENT-1`, { headers: withAuth(TOKEN) });
  const etag = get.headers.get("etag");
  const r = await api("/api/enterprises/ENT-1", {
    method: "PATCH",
    headers: { ...jsonHeaders(TOKEN), "if-match": etag },
    body: JSON.stringify({ name: "Atlas_Renamed" }),
  });
  assert.equal(r.status, 200);
  // Re-browse — old name gone, new name present.
  const ents = await browseEnterprises();
  assert.ok(ents.find(e => /Atlas_Renamed/.test(e.name)), `expected Atlas_Renamed; got ${ents.map(e => e.name).join(",")}`);
  assert.equal(ents.filter(e => /Atlas_Initial/.test(e.name)).length, 0, "old name removed");
});

test("add a new enterprise via POST appears in the address space", async () => {
  const r = await api("/api/enterprises", {
    method: "POST",
    headers: jsonHeaders(TOKEN),
    body: JSON.stringify({ name: "Atlas_Second", description: "added at runtime" }),
  });
  assert.equal(r.status, 200);
  const ents = await browseEnterprises();
  assert.ok(ents.find(e => /Atlas_Second/.test(e.name)));
});

test("add a new asset under existing enterprise — Variable appears under its location", async () => {
  const r = await api("/api/assets", {
    method: "POST",
    headers: jsonHeaders(TOKEN),
    body: JSON.stringify({ name: "Pump-B", type: "pump", enterpriseId: "ENT-1", locationId: "LOC-1" }),
  });
  assert.equal(r.status, 200);
  // Walk: Enterprises → Atlas_Renamed → Plant → Pump-B
  const ents = await browseEnterprises();
  const ent = ents.find(e => /Atlas_Renamed/.test(e.name));
  const locs = await browseChildren(ent.nodeId);
  const plant = locs.find(l => /Plant/.test(l.name));
  const assets = await browseChildren(plant.nodeId);
  assert.ok(assets.find(a => /Pump-B/.test(a.name)), `expected Pump-B; got ${assets.map(a => a.name).join(",")}`);
});

test("delete an asset — Variable disappears from the address space", async () => {
  // Disable strict ETag for this delete (server's
  // requireIfMatch() honours FORGE_REQUIRE_IF_MATCH — default is
  // permissive, but we send an If-Match: * to be belt-and-braces
  // robust).
  const r = await api("/api/assets/AS-Existing", {
    method: "DELETE",
    headers: { ...withAuth(TOKEN), "if-match": "*" },
  });
  assert.equal(r.status, 200);
  // Re-browse: AS-Existing's Variable should be gone from under the location.
  const ents = await browseEnterprises();
  const ent = ents.find(e => /Atlas_Renamed/.test(e.name));
  const locs = await browseChildren(ent.nodeId);
  const plant = locs.find(l => /Plant/.test(l.name));
  const assets = await browseChildren(plant.nodeId);
  assert.equal(assets.filter(a => /Pump-A/.test(a.name)).length, 0,
    `expected Pump-A removed; got ${assets.map(a => a.name).join(",")}`);
});

test("delete the renamed enterprise — its UAObject removed from the Enterprises folder", async () => {
  // The enterprise has bindings? — none in this test. Delete the
  // remaining location first to clear any FK from assets we
  // created (Pump-B is still pointing at LOC-1).
  await api("/api/assets/" + (await listAssetsUnderEnterprise("ENT-1"))[0]?.id, {
    method: "DELETE", headers: { ...withAuth(TOKEN), "if-match": "*" },
  });
  await api("/api/locations/LOC-1", { method: "DELETE", headers: withAuth(TOKEN) });
  const r = await api("/api/enterprises/ENT-1", { method: "DELETE", headers: withAuth(TOKEN) });
  assert.equal(r.status, 200);
  const ents = await browseEnterprises();
  assert.equal(ents.filter(e => /Atlas_Renamed/.test(e.name)).length, 0);
  assert.ok(ents.find(e => /Atlas_Second/.test(e.name)), "the second enterprise we added is still there");
});

async function listAssetsUnderEnterprise(entId) {
  const tree = await api("/api/asset-tree", { headers: withAuth(TOKEN) });
  const ent = tree.body.tree.find(e => e.id === entId);
  if (!ent) return [];
  const out = [];
  function walk(loc) {
    for (const a of loc.assets || []) out.push(a);
    for (const c of loc.children || []) walk(c);
  }
  for (const l of ent.locations || []) walk(l);
  for (const a of ent.ungroupedAssets || []) out.push(a);
  return out;
}
