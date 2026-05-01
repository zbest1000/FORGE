// OPC UA *server* smoke test — Phase 5.
//
// Boots `server/opcua-server.js` against a fresh seeded DB, then
// uses node-opcua's own `OPCUAClient` to:
//   1. Browse the address space and confirm the seeded
//      Enterprise → Location → Asset → Variable hierarchy is
//      reachable under the ObjectsFolder.
//   2. Read the Variable for an asset's binding and confirm the
//      value matches the binding's `last_value`.
//   3. Confirm `refreshOpcuaServerForBinding()` updates the
//      published value so a subsequent Read sees the new value
//      (which is what an OPC UA Subscribe would pick up).
//
// Listens on a random localhost port so multiple tests on the
// same CI box don't collide. node-opcua's boot is heavy (~5s) so
// we do the boot once and run all assertions against the same
// instance.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-opcua-srv-"));
process.env.FORGE_DATA_DIR = tmpDir;
process.env.FORGE_TENANT_KEY = "forge-opcua-srv-test";
process.env.FORGE_JWT_SECRET = "forge-opcua-srv-test-jwt";
process.env.FORGE_OPCUA_SERVER_ENABLED = "1";
// Random port discovered before boot — net.createServer().listen(0)
// returns a port; we close that listener and reuse the port for OPC.
const portProbe = net.createServer();
await new Promise(r => portProbe.listen(0, "127.0.0.1", r));
const opcPort = portProbe.address().port;
await new Promise(r => portProbe.close(r));
process.env.FORGE_OPCUA_SERVER_PORT = String(opcPort);
process.env.FORGE_OPCUA_SERVER_SECURITY_MODE = "None";
process.env.FORGE_OPCUA_SERVER_SECURITY_POLICY = "None";
process.env.LOG_LEVEL = "warn";

const { db } = await import("../server/db.js");
const ts = new Date().toISOString();

// Seed: enterprise → location → asset → binding.
db.prepare("INSERT INTO organizations (id, name, tenant_key, created_at) VALUES (?,?,?,?)").run("ORG-A", "Atlas", "atlas", ts);
db.prepare("INSERT INTO workspaces (id, org_id, name, region, created_at) VALUES (?,?,?,?,?)").run("WS-A", "ORG-A", "North", "us-east", ts);
db.prepare("INSERT INTO enterprises (id, org_id, workspace_id, name, description, sort_order, acl, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
  .run("ENT-1", "ORG-A", "WS-A", "Atlas Industrial", "Test enterprise", 0, "{}", ts, ts);
db.prepare("INSERT INTO locations (id, org_id, workspace_id, enterprise_id, parent_location_id, name, kind, sort_order, acl, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
  .run("LOC-1", "ORG-A", "WS-A", "ENT-1", null, "Plant 1", "site", 0, "{}", ts, ts);
db.prepare("INSERT INTO assets (id, org_id, workspace_id, name, type, hierarchy, status, mqtt_topics, opcua_nodes, doc_ids, acl, labels, enterprise_id, location_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
  .run("AS-1", "ORG-A", "WS-A", "Pump-A", "pump", "Atlas/Plant 1/Pump-A", "normal", "[]", "[]", "[]", "{}", "[]", "ENT-1", "LOC-1", ts, ts);
db.prepare("INSERT INTO historian_points (id, asset_id, source_id, tag, name, unit, data_type, historian, retention_policy_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
  .run("HP-T", "AS-1", null, "asset:AS-1:temperature", "temperature", "C", "number", "sqlite", null, ts, ts);
db.prepare(`INSERT INTO asset_point_bindings
  (id, org_id, asset_id, profile_version_id, profile_point_id, point_id, system_id,
   source_kind, source_path, template_vars, enabled, last_value, last_quality, last_seen,
   created_at, updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  .run("APB-T", "ORG-A", "AS-1", null, null, "HP-T", null, "mqtt", "Atlas/Plant 1/Pump-A/temperature", "{}", 1, 21.5, "Good", ts, ts, ts);

// Boot the OPC UA server.
const srvMod = await import("../server/opcua-server.js");
const startResult = await srvMod.startOpcuaServer({ logger: console });
if (!startResult?.ok) {
  console.error("OPC UA server failed to start:", startResult);
  throw new Error(`opcua server start failed: ${startResult?.reason}`);
}

// Build a node-opcua client that talks to it.
const opcuaPkg = await import("node-opcua");
const m = opcuaPkg.default || opcuaPkg;
const endpoint = startResult.endpoint || `opc.tcp://127.0.0.1:${opcPort}/forge`;

const client = m.OPCUAClient.create({
  applicationName: "FORGE-OPC-SMOKE",
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
});

// ----- tests -----

test("server is reachable + reports endpoints", () => {
  assert.equal(startResult.ok, true);
  assert.equal(startResult.port, opcPort);
});

test("address space includes the seeded enterprise/location/asset path", async () => {
  // Browse Objects → Enterprises folder. Walk down to our binding.
  // node-opcua's session.browse returns BrowseResult with references.
  const objectsFolder = "ns=0;i=85"; // OPC UA ObjectsFolder, well-known.
  const result = await session.browse(objectsFolder);
  const refs = result?.references || [];
  const enterprisesNode = refs.find(r => /Enterprises/.test(String(r.browseName?.name || "")));
  assert.ok(enterprisesNode, "Enterprises folder is browsable under ObjectsFolder");

  // Browse the Enterprises folder for our seeded enterprise.
  const ent = await session.browse(enterprisesNode.nodeId);
  const ourEnt = (ent.references || []).find(r => /Atlas_Industrial/.test(String(r.browseName?.name || "")));
  assert.ok(ourEnt, `seeded enterprise visible (got: ${(ent.references||[]).map(r => r.browseName?.name).join(",")})`);

  // Drill in: enterprise → location → asset → variable.
  const locs = await session.browse(ourEnt.nodeId);
  const ourLoc = (locs.references || []).find(r => /Plant_1/.test(String(r.browseName?.name || "")));
  assert.ok(ourLoc);
  const assets = await session.browse(ourLoc.nodeId);
  const ourAsset = (assets.references || []).find(r => /Pump-A/.test(String(r.browseName?.name || "")));
  assert.ok(ourAsset);
  const vars = await session.browse(ourAsset.nodeId);
  const ourVar = (vars.references || []).find(r => /temperature/.test(String(r.browseName?.name || "")));
  assert.ok(ourVar, `temperature variable is browsable (got: ${(vars.references||[]).map(r => r.browseName?.name).join(",")})`);
});

test("Read returns the binding's last_value", async () => {
  const objectsFolder = "ns=0;i=85";
  const e1 = await session.browse(objectsFolder);
  const ents = (await session.browse(e1.references.find(r => /Enterprises/.test(r.browseName?.name)).nodeId)).references;
  const ent = ents.find(r => /Atlas_Industrial/.test(r.browseName?.name));
  const locs = (await session.browse(ent.nodeId)).references;
  const loc = locs.find(r => /Plant_1/.test(r.browseName?.name));
  const assets = (await session.browse(loc.nodeId)).references;
  const asset = assets.find(r => /Pump-A/.test(r.browseName?.name));
  const vars = (await session.browse(asset.nodeId)).references;
  const variableRef = vars.find(r => /temperature/.test(r.browseName?.name));
  assert.ok(variableRef);

  // Read the value attribute.
  const dv = await session.read({ nodeId: variableRef.nodeId, attributeId: m.AttributeIds.Value });
  assert.ok(dv?.value);
  assert.equal(Number(dv.value.value), 21.5, "Read returns the seeded last_value");
});

test("refreshOpcuaServerForBinding updates the published value", async () => {
  // Simulate a sample arriving via the connector orchestrator's
  // dispatchSample path. The server's hook updates the closure-
  // captured value and the next Read should see it.
  const binding = db.prepare("SELECT * FROM asset_point_bindings WHERE id = 'APB-T'").get();
  srvMod.refreshOpcuaServerForBinding({
    binding,
    value: 99.9,
    ts: new Date().toISOString(),
    quality: "Good",
  });
  // Walk the address space again (cheaper than recomputing nodeIds).
  const objectsFolder = "ns=0;i=85";
  const e1 = await session.browse(objectsFolder);
  const ents = (await session.browse(e1.references.find(r => /Enterprises/.test(r.browseName?.name)).nodeId)).references;
  const ent = ents.find(r => /Atlas_Industrial/.test(r.browseName?.name));
  const locs = (await session.browse(ent.nodeId)).references;
  const loc = locs.find(r => /Plant_1/.test(r.browseName?.name));
  const assets = (await session.browse(loc.nodeId)).references;
  const asset = assets.find(r => /Pump-A/.test(r.browseName?.name));
  const vars = (await session.browse(asset.nodeId)).references;
  const variableRef = vars.find(r => /temperature/.test(r.browseName?.name));

  const dv = await session.read({ nodeId: variableRef.nodeId, attributeId: m.AttributeIds.Value });
  assert.equal(Number(dv.value.value), 99.9);
});
