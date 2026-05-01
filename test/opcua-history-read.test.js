// OPC UA Historical Read (HA Read) — Phase 7b.
//
// Boots the lightweight FORGE OPC UA server against a fresh DB
// pre-seeded with historian samples in sqlite (the default
// backend), then a real `node-opcua` client performs a
// HistoryReadRaw request against the binding's Variable. The test
// asserts:
//
//   1. The server publishes the binding as a historizable Variable
//      (the AccessLevel includes HistoryRead).
//   2. The HA Read returns the seeded samples in order.
//   3. The samples carry numeric values matching what was inserted.
//
// We use sqlite as the backing historian since it's always wired
// (server/historians/index.js); the same code path is used for
// influxdb / timebase / mssql / postgresql / mysql by virtue of
// readHistorianSamples() routing per-point.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-opcua-ha-"));
process.env.FORGE_DATA_DIR = tmpDir;
process.env.FORGE_TENANT_KEY = "forge-opcua-ha-test";
process.env.FORGE_JWT_SECRET = "forge-opcua-ha-test-jwt";
process.env.FORGE_OPCUA_SERVER_ENABLED = "1";

// Discover a free port for the OPC UA server.
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

db.prepare("INSERT INTO organizations (id, name, tenant_key, created_at) VALUES ('ORG-A','Atlas','atlas',?)").run(ts);
db.prepare("INSERT INTO workspaces (id, org_id, name, region, created_at) VALUES ('WS-A','ORG-A','North','us-east',?)").run(ts);
db.prepare("INSERT INTO enterprises (id, org_id, workspace_id, name, description, sort_order, acl, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
  .run("ENT-1", "ORG-A", "WS-A", "Atlas", "ha-read seed", 0, "{}", ts, ts);
db.prepare("INSERT INTO locations (id, org_id, workspace_id, enterprise_id, parent_location_id, name, kind, sort_order, acl, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
  .run("LOC-1", "ORG-A", "WS-A", "ENT-1", null, "Plant", "site", 0, "{}", ts, ts);
db.prepare("INSERT INTO assets (id, org_id, workspace_id, name, type, hierarchy, status, mqtt_topics, opcua_nodes, doc_ids, acl, labels, enterprise_id, location_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
  .run("AS-1", "ORG-A", "WS-A", "Pump-A", "pump", "Atlas/Plant/Pump-A", "normal", "[]", "[]", "[]", "{}", "[]", "ENT-1", "LOC-1", ts, ts);
db.prepare("INSERT INTO historian_points (id, asset_id, source_id, tag, name, unit, data_type, historian, retention_policy_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
  .run("HP-T", "AS-1", null, "asset:AS-1:temperature", "temperature", "C", "number", "sqlite", null, ts, ts);
db.prepare(`INSERT INTO asset_point_bindings
  (id, org_id, asset_id, profile_version_id, profile_point_id, point_id, system_id,
   source_kind, source_path, template_vars, enabled, last_value, last_quality, last_seen,
   created_at, updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  .run("APB-T", "ORG-A", "AS-1", null, null, "HP-T", null, "mqtt", "Atlas/Plant/Pump-A/temperature", "{}", 1, 21.5, "Good", ts, ts, ts);

// Seed historian samples spanning the last hour. Each sample 5 min
// apart so the HA Read sees 12 ordered points.
const baseTs = Date.now() - 60 * 60 * 1000; // 1h ago
const insertSample = db.prepare(
  "INSERT INTO historian_samples (id, point_id, ts, value, quality, source_type, raw_payload) VALUES (?, ?, ?, ?, 'Good', 'seed', '{}')"
);
const seededValues = [];
for (let i = 0; i < 12; i++) {
  const sampleTs = new Date(baseTs + i * 5 * 60 * 1000).toISOString();
  const value = 20 + i * 0.5;
  seededValues.push(value);
  insertSample.run(`HS-HA-${i}`, "HP-T", sampleTs, value);
}

// Boot the OPC UA server.
const srvMod = await import("../server/opcua-server.js");
const startResult = await srvMod.startOpcuaServer({ logger: console });
if (!startResult?.ok) throw new Error(`opcua server start failed: ${startResult?.reason}`);

// Real OPC UA client.
const opcuaPkg = await import("node-opcua");
const m = opcuaPkg.default || opcuaPkg;
const endpoint = startResult.endpoint || `opc.tcp://127.0.0.1:${opcPort}/forge`;
const client = m.OPCUAClient.create({
  applicationName: "FORGE-OPC-HA-SMOKE",
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

async function findTemperatureNode() {
  const objectsFolder = "ns=0;i=85";
  const root = await session.browse(objectsFolder);
  const ents = (await session.browse(root.references.find(r => /Enterprises/.test(r.browseName?.name)).nodeId)).references;
  const ent = ents.find(r => /Atlas/.test(r.browseName?.name));
  const locs = (await session.browse(ent.nodeId)).references;
  const loc = locs.find(r => /Plant/.test(r.browseName?.name));
  const assets = (await session.browse(loc.nodeId)).references;
  const asset = assets.find(r => /Pump-A/.test(r.browseName?.name));
  const vars = (await session.browse(asset.nodeId)).references;
  return vars.find(r => /temperature/.test(r.browseName?.name));
}

// ----- tests -----

test("binding Variable advertises HistoryRead in its access level", async () => {
  const ref = await findTemperatureNode();
  assert.ok(ref);
  const accessLevelDv = await session.read({ nodeId: ref.nodeId, attributeId: m.AttributeIds.UserAccessLevel });
  // node-opcua exposes the AccessLevelFlag enum; HistoryRead = 0x04.
  const access = Number(accessLevelDv?.value?.value ?? 0);
  assert.ok((access & 0x04) === 0x04, `expected HistoryRead bit set, got ${access}`);
});

test("HistoryRead returns the seeded samples in order with matching values", async () => {
  const ref = await findTemperatureNode();
  // Use node-opcua's high-level `readHistoryValue(nodeId, start,
  // end, options)` API which builds the HistoryReadRequest +
  // ReadRawModifiedDetails on our behalf.
  const start = new Date(baseTs - 60 * 1000); // a minute before first
  const end = new Date(baseTs + 60 * 60 * 1000 + 60 * 1000); // a minute after last
  const result = await session.readHistoryValue(ref.nodeId, start, end, {
    numValuesPerNode: 1000,
    returnBounds: false,
    timestampsToReturn: m.TimestampsToReturn.Source,
  });
  const dvs = result?.historyData?.dataValues;
  assert.ok(Array.isArray(dvs), `expected dataValues array, got ${JSON.stringify(result).slice(0, 200)}`);
  assert.equal(dvs.length, 12, `expected 12 samples (got ${dvs.length})`);
  for (let i = 0; i < dvs.length; i++) {
    const got = Number(dvs[i].value?.value);
    assert.equal(got, seededValues[i], `sample ${i} value mismatch: got ${got} want ${seededValues[i]}`);
  }
});

test("HistoryRead with a tighter window returns the subset", async () => {
  const ref = await findTemperatureNode();
  // Ask for the middle 6 samples (indexes 3..8).
  const start = new Date(baseTs + 3 * 5 * 60 * 1000 - 1000);
  const end = new Date(baseTs + 8 * 5 * 60 * 1000 + 1000);
  const result = await session.readHistoryValue(ref.nodeId, start, end, {
    numValuesPerNode: 1000,
    returnBounds: false,
    timestampsToReturn: m.TimestampsToReturn.Source,
  });
  const dvs = result?.historyData?.dataValues;
  assert.ok(Array.isArray(dvs));
  assert.equal(dvs.length, 6);
  assert.equal(Number(dvs[0].value?.value), seededValues[3]);
  assert.equal(Number(dvs[5].value?.value), seededValues[8]);
});
