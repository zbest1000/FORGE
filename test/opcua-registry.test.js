// OPC UA registry tests — Phase 5.
//
// node-opcua is heavyweight (native + 100s of MB of address-space
// machinery) so we don't spin up a real OPC UA endpoint here.
// Instead the test installs a fake `OPCUAClient` factory via
// `setOpcuaClientFactory()` and drives the dataValue.changed
// callbacks manually. That gives us full coverage of the
// registry's bucketing / batching / dispatch logic without paying
// the boot tax.
//
// What we assert:
//   1. Bucketing — bindings split into the right publishing-interval
//      buckets per their profile_version.source_template.
//   2. Batched create — ClientMonitoredItemGroup.create is called
//      with the right items per bucket.
//   3. Dispatch — simulating a `changed` event on a monitored item
//      lands a `historian_samples` row + updates the binding's
//      last_value/last_seen, like the SQL + MQTT subregistries.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-opcua-"));
process.env.FORGE_DATA_DIR = tmpDir;
process.env.FORGE_TENANT_KEY = "forge-opcua-test";
process.env.FORGE_JWT_SECRET = "forge-opcua-test-jwt";
process.env.LOG_LEVEL = "warn";

const { db, now } = await import("../server/db.js");
const ts = new Date().toISOString();

// Seed: org, workspace, asset, registered OPC UA system, a profile
// version + 3 bindings on different requested publishing intervals
// to exercise bucketing.
db.prepare("INSERT INTO organizations (id, name, tenant_key, created_at) VALUES (?,?,?,?)").run("ORG-A", "Atlas", "atlas", ts);
db.prepare("INSERT INTO workspaces (id, org_id, name, region, created_at) VALUES (?,?,?,?,?)").run("WS-A", "ORG-A", "North", "us-east", ts);
db.prepare("INSERT INTO assets (id, org_id, workspace_id, name, type, hierarchy, status, mqtt_topics, opcua_nodes, doc_ids, acl, labels, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
  .run("AS-1", "ORG-A", "WS-A", "Pump-A", "pump", "Atlas/North/Pump-A", "normal", "[]", "[]", "[]", "{}", "[]", ts, ts);
db.prepare("INSERT INTO historian_points (id, asset_id, source_id, tag, name, unit, data_type, historian, retention_policy_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
  .run("HP-T", "AS-1", null, "asset:AS-1:temperature", "temperature", "C", "number", "sqlite", null, ts, ts);
db.prepare("INSERT INTO historian_points (id, asset_id, source_id, tag, name, unit, data_type, historian, retention_policy_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
  .run("HP-V", "AS-1", null, "asset:AS-1:vibration", "vibration", "mm/s", "number", "sqlite", null, ts, ts);
db.prepare("INSERT INTO historian_points (id, asset_id, source_id, tag, name, unit, data_type, historian, retention_policy_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
  .run("HP-S", "AS-1", null, "asset:AS-1:speed", "speed", "rpm", "number", "sqlite", null, ts, ts);
db.prepare("INSERT INTO enterprise_systems (id, name, kind, category, vendor, base_url, auth_type, secret_ref, status, capabilities, owner_id, config, created_at, updated_at, org_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
  .run("ES-OPC-1", "Plant Kepware", "opcua", "iot.broker", "Kepware", "opc.tcp://kepware.acme:49320", "none", null, "configured", "[]", "U-X", "{}", ts, ts, "ORG-A");
db.prepare("INSERT INTO asset_profiles (id, org_id, workspace_id, name, source_kind, latest_version_id, status, owner_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
  .run("PROF-OPC", "ORG-A", "WS-A", "Pump", "opcua", "PVER-OPC-FAST", "active", "U-X", ts, ts);

// Fast bucket (250ms): temperature.
db.prepare("INSERT INTO asset_profile_versions (id, profile_id, version, source_template, status, notes, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)")
  .run("PVER-OPC-FAST", "PROF-OPC", 1, JSON.stringify({ publishing_interval_ms: 250 }), "active", "fast bucket", "U-X", ts);
// Slow bucket (1s): vibration.
db.prepare("INSERT INTO asset_profile_versions (id, profile_id, version, source_template, status, notes, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)")
  .run("PVER-OPC-SLOW", "PROF-OPC", 2, JSON.stringify({ publishing_interval_ms: 1000 }), "active", "slow bucket", "U-X", ts);

const bindings = [
  { id: "APB-T", point: "HP-T", node: "ns=2;s=plant.pump-a.temperature", versionId: "PVER-OPC-FAST" }, // 250ms
  { id: "APB-V", point: "HP-V", node: "ns=2;s=plant.pump-a.vibration",   versionId: "PVER-OPC-FAST" }, // 250ms
  { id: "APB-S", point: "HP-S", node: "ns=2;s=plant.pump-a.speed",       versionId: "PVER-OPC-SLOW" }, // 1000ms
];
for (const b of bindings) {
  db.prepare(`INSERT INTO asset_point_bindings
    (id, org_id, asset_id, profile_version_id, profile_point_id, point_id, system_id,
     source_kind, source_path, template_vars, enabled, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(b.id, "ORG-A", "AS-1", b.versionId, null, b.point, "ES-OPC-1",
         "opcua", b.node, "{}", 1, ts, ts);
}

// Build a fake node-opcua factory. Captures the items that get
// monitored so the test can simulate `changed` events later.
const fakeMonitoredItemsByBinding = new Map();
const subscriptionRequests = []; // { publishingInterval, items: [...] }

function makeFakeMonitoredItem(nodeId) {
  const item = new EventEmitter();
  item.nodeId = nodeId;
  return item;
}

function makeFakeSubscription(publishingInterval) {
  return { publishingInterval };
}

function makeFakeNodeOpcua() {
  const m = {
    AttributeIds: { Value: 13 },
    TimestampsToReturn: { Both: 2 },
    DataType: { Double: 11 },
    MessageSecurityMode: { None: 1, Sign: 2, SignAndEncrypt: 3 },
    SecurityPolicy: { None: "None", Basic256Sha256: "Basic256Sha256" },
    ClientSubscription: {
      create: (session, opts) => makeFakeSubscription(opts.requestedPublishingInterval),
    },
    ClientMonitoredItemGroup: {
      create: async (subscription, items, params, ts) => {
        const monitoredItems = items.map(it => {
          const monItem = makeFakeMonitoredItem(it.nodeId);
          return monItem;
        });
        // Map each item back to its binding by nodeId so the test
        // can fire `.emit('changed', dataValue)` later.
        for (const monItem of monitoredItems) {
          const binding = bindings.find(b => b.node === monItem.nodeId);
          if (binding) fakeMonitoredItemsByBinding.set(binding.id, monItem);
        }
        subscriptionRequests.push({
          publishingInterval: subscription.publishingInterval,
          items: items.map(i => i.nodeId),
        });
        return { monitoredItems };
      },
    },
    Variant: function ({ value }) { this.value = value; },
    OPCUAClient: {
      create: () => ({}),
    },
  };
  return m;
}

const fakeOpcua = makeFakeNodeOpcua();
const fakeFactory = async () => ({
  client: {
    connect: async () => {},
    createSession: async () => ({}),
    disconnect: async () => {},
  },
  node_opcua: fakeOpcua,
});

const opcuaRegistry = await import("../server/connectors/opcua-registry.js");
opcuaRegistry.setOpcuaClientFactory(fakeFactory);
const orchestrator = await import("../server/connectors/registry.js");
async function dispatchSample(args) { await orchestrator.dispatchSample(args); }
await opcuaRegistry.init({ logger: console, dispatchSample });

test.after(async () => {
  await opcuaRegistry.shutdown();
  opcuaRegistry.resetOpcuaClientFactory();
});

// ----- tests -----

test("bindings are bucketed by requested publishing interval", () => {
  // Two buckets: 250ms (fast: T+V) and 1000ms (slow: S).
  const fast = subscriptionRequests.find(r => r.publishingInterval === 250);
  const slow = subscriptionRequests.find(r => r.publishingInterval === 1000);
  assert.ok(fast, "250ms bucket created");
  assert.ok(slow, "1000ms bucket created");
  assert.deepEqual(fast.items.sort(), [
    "ns=2;s=plant.pump-a.temperature",
    "ns=2;s=plant.pump-a.vibration",
  ]);
  assert.deepEqual(slow.items, [ "ns=2;s=plant.pump-a.speed" ]);
});

test("batched ClientMonitoredItemGroup.create called once per bucket (one chunk for small N)", () => {
  // We staged 3 bindings across 2 buckets; each bucket is well
  // under the 500-item chunk size. Expect exactly 2 group-create
  // calls — one per bucket.
  assert.equal(subscriptionRequests.length, 2);
});

test("changed event dispatches a sample + updates binding last_value", async () => {
  const item = fakeMonitoredItemsByBinding.get("APB-T");
  assert.ok(item, "monitored item registered for APB-T");
  // Construct a node-opcua-shaped DataValue.
  const dv = {
    value: { value: 42.5, dataType: 11 },
    sourceTimestamp: new Date(),
    serverTimestamp: new Date(),
    statusCode: { name: "Good" },
  };
  const before = db.prepare("SELECT COUNT(*) AS n FROM historian_samples WHERE point_id = 'HP-T'").get().n;
  item.emit("changed", dv);
  // dispatch is async — wait briefly.
  await new Promise(r => setTimeout(r, 50));
  const after = db.prepare("SELECT COUNT(*) AS n FROM historian_samples WHERE point_id = 'HP-T'").get().n;
  assert.equal(after, before + 1, "historian sample inserted");

  const sample = db.prepare("SELECT * FROM historian_samples WHERE point_id = 'HP-T' ORDER BY ts DESC LIMIT 1").get();
  assert.equal(sample.value, 42.5);
  assert.equal(sample.quality, "Good");

  const binding = db.prepare("SELECT * FROM asset_point_bindings WHERE id = 'APB-T'").get();
  assert.equal(Number(binding.last_value), 42.5);
  assert.equal(binding.last_quality, "Good");
});

test("non-numeric dataValue lands with quality Uncertain", async () => {
  const item = fakeMonitoredItemsByBinding.get("APB-V");
  assert.ok(item);
  const dv = {
    value: { value: "not-a-number", dataType: 12 },
    sourceTimestamp: new Date(),
    statusCode: { name: "Good" },
  };
  const before = db.prepare("SELECT COUNT(*) AS n FROM historian_samples WHERE point_id = 'HP-V'").get().n;
  item.emit("changed", dv);
  await new Promise(r => setTimeout(r, 50));
  const after = db.prepare("SELECT COUNT(*) AS n FROM historian_samples WHERE point_id = 'HP-V'").get().n;
  assert.equal(after, before + 1);
  const sample = db.prepare("SELECT * FROM historian_samples WHERE point_id = 'HP-V' ORDER BY ts DESC LIMIT 1").get();
  assert.equal(sample.quality, "Uncertain");
});

test("pickBucket rounds up to the nearest supported publishing interval", () => {
  const { pickBucket, PUBLISHING_BUCKETS_MS } = opcuaRegistry._internals;
  assert.deepEqual(PUBLISHING_BUCKETS_MS, [250, 1000, 5000, 60000]);
  assert.equal(pickBucket(100), 250);
  assert.equal(pickBucket(250), 250);
  assert.equal(pickBucket(800), 1000);
  assert.equal(pickBucket(1500), 5000);
  assert.equal(pickBucket(9000), 60000);
  assert.equal(pickBucket(120_000), 60000); // clamps to the last bucket
});
