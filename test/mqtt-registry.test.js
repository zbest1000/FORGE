// MQTT registry tests — Phase 4.
//
// Spins up an in-process aedes broker on a random port + a real
// `mqtt` client connecting to it. Asserts the full ingest path:
// publish on a binding's resolved topic → registry routes the
// message to the right binding → orchestrator persists a
// `historian_samples` row → SSE event broadcasts → binding's
// last_seen / last_value update.
//
// Token-bucket backpressure: send a flood and confirm the burst is
// coalesced as `quality='Substituted'` per spec §2.1.
//
// We deliberately do NOT exercise the connector orchestrator's
// other subregistries here. The SQL registry is disabled via
// FORGE_DISABLE_CONNECTOR_REGISTRY=1 (we drive the MQTT registry
// directly through its public init/dispatch hooks instead).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-mqtt-"));
process.env.FORGE_DATA_DIR = tmpDir;
process.env.FORGE_TENANT_KEY = "forge-mqtt-test";
process.env.FORGE_JWT_SECRET = "forge-mqtt-test-jwt";
process.env.FORGE_MQTT_BACKPRESSURE_TPS = "5"; // small bucket for the burst test
process.env.LOG_LEVEL = "warn";

const { db, now } = await import("../server/db.js");
const ts = new Date().toISOString();

// Minimal seed: an org/workspace, an asset, a registered MQTT
// system, and three bindings under that system.
db.prepare("INSERT INTO organizations (id, name, tenant_key, created_at) VALUES (?,?,?,?)").run("ORG-A", "Atlas", "atlas", ts);
db.prepare("INSERT INTO workspaces (id, org_id, name, region, created_at) VALUES (?,?,?,?,?)").run("WS-A", "ORG-A", "North", "us-east", ts);
db.prepare("INSERT INTO assets (id, org_id, workspace_id, name, type, hierarchy, status, mqtt_topics, opcua_nodes, doc_ids, acl, labels, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
  .run("AS-1", "ORG-A", "WS-A", "Pump-A", "pump", "Atlas/North/Pump-A", "normal", "[]", "[]", "[]", "{}", "[]", ts, ts);

// Pre-create historian points (apply-profile would do this in
// production; we shortcut for a unit test).
db.prepare("INSERT INTO historian_points (id, asset_id, source_id, tag, name, unit, data_type, historian, retention_policy_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
  .run("HP-T", "AS-1", null, "asset:AS-1:temperature", "temperature", "C", "number", "sqlite", null, ts, ts);
db.prepare("INSERT INTO historian_points (id, asset_id, source_id, tag, name, unit, data_type, historian, retention_policy_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
  .run("HP-P", "AS-1", null, "asset:AS-1:pressure", "pressure", "bar", "number", "sqlite", null, ts, ts);
db.prepare("INSERT INTO historian_points (id, asset_id, source_id, tag, name, unit, data_type, historian, retention_policy_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
  .run("HP-V", "AS-1", null, "asset:AS-1:vibration", "vibration", "mm/s", "number", "sqlite", null, ts, ts);

// Boot an aedes broker on a random localhost port.
const aedesMod = await import("aedes");
const Aedes = aedesMod.Aedes;
const broker = await Aedes.createBroker({});
const server = net.createServer(broker.handle);
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const brokerUrl = `mqtt://127.0.0.1:${port}`;

// Register the broker as an enterprise system + 3 bindings.
db.prepare("INSERT INTO enterprise_systems (id, name, kind, category, vendor, base_url, auth_type, secret_ref, status, capabilities, owner_id, config, created_at, updated_at, org_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
  .run("ES-MQTT-1", "Test broker", "mqtt", "iot.broker", "Aedes", brokerUrl, "none", null, "configured", "[]", "U-X", "{}", ts, ts, "ORG-A");

const bindings = [
  { id: "APB-T", point: "HP-T", topic: "atlas/north/pump-a/temperature" },
  { id: "APB-P", point: "HP-P", topic: "atlas/north/pump-a/pressure" },
  { id: "APB-V", point: "HP-V", topic: "atlas/north/+/vibration" }, // wildcard sub
];
for (const b of bindings) {
  db.prepare(`INSERT INTO asset_point_bindings
    (id, org_id, asset_id, profile_version_id, profile_point_id, point_id, system_id,
     source_kind, source_path, template_vars, enabled, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(b.id, "ORG-A", "AS-1", null, null, b.point, "ES-MQTT-1",
         "mqtt", b.topic, "{}", 1, ts, ts);
}

// SSE broadcast assertions are covered by `test/routes.test.js` —
// the orchestrator's `dispatchSample` is a 1-line forward to
// `broadcast()` from sse.js. Here we focus on the load-bearing
// dispatch correctness: every relevant binding sees its sample
// land in `historian_samples` + `last_seen` updates.

// Boot the registry directly. We bypass the orchestrator's init so
// the subregistry's connect path runs synchronously inside the test.
const registry = await import("../server/connectors/registry.js");
const mqttRegistry = await import("../server/connectors/mqtt-registry.js");

// Wire dispatch like the orchestrator would.
async function dispatchSample(args) {
  await registry.dispatchSample(args);
}

await mqttRegistry.init({ logger: console, dispatchSample });

// Wait for the registry's mqtt client to actually connect before
// publishing — `init()` returns once the client is created but
// subscribes happen on the `connect` event.
async function waitForReady(maxMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const sysState = mqttRegistry._internals.state.systems.get("ES-MQTT-1");
    if (sysState && sysState.status === "connected") return;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error("mqtt-registry never reached connected state");
}
await waitForReady();
// Subscribe latency: aedes broker accepts subscribe immediately but
// we want a beat before publishing so the SUBSCRIBE ACK is round-
// tripped.
await new Promise(r => setTimeout(r, 200));

// Set up a separate mqtt publisher (independent of the registry's
// own client) so our test doesn't rely on the registry exposing a
// publish API.
const mqttMod = await import("mqtt");
const mqtt = mqttMod.default || mqttMod;
const publisher = mqtt.connect(brokerUrl, { reconnectPeriod: 5000, connectTimeout: 5000 });
await new Promise((resolve, reject) => {
  publisher.once("connect", resolve);
  publisher.once("error", reject);
  setTimeout(() => reject(new Error("publisher timeout")), 5000);
});

async function publish(topic, body) {
  return new Promise((resolve, reject) => {
    publisher.publish(topic, typeof body === "string" ? body : JSON.stringify(body), { qos: 1 }, (err) => {
      if (err) reject(err); else resolve();
    });
  });
}

async function waitForRow(predicate, label, maxMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (predicate()) return;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

test.after(async () => {
  try { publisher.end(true); } catch {}
  try { await mqttRegistry.shutdown(); } catch {}
  try { server.close(); } catch {}
  try { await new Promise(r => broker.close(r)); } catch {}
});

// ----- tests -----

test("publishing on a binding's exact topic dispatches a historian sample", async () => {
  const before = db.prepare("SELECT COUNT(*) AS n FROM historian_samples WHERE point_id = 'HP-T'").get().n;
  await publish("atlas/north/pump-a/temperature", { value: 42.5, ts: now(), quality: "Good" });

  await waitForRow(
    () => db.prepare("SELECT COUNT(*) AS n FROM historian_samples WHERE point_id = 'HP-T'").get().n > before,
    "historian sample for HP-T",
  );

  const sample = db.prepare("SELECT * FROM historian_samples WHERE point_id = 'HP-T' ORDER BY ts DESC LIMIT 1").get();
  assert.equal(sample.value, 42.5);
  assert.equal(sample.quality, "Good");

  const binding = db.prepare("SELECT * FROM asset_point_bindings WHERE id = 'APB-T'").get();
  assert.equal(Number(binding.last_value), 42.5, "binding last_value updated");
  assert.equal(binding.last_quality, "Good");
  assert.ok(binding.last_seen);
});

test("wildcard subscription matches and dispatches", async () => {
  const before = db.prepare("SELECT COUNT(*) AS n FROM historian_samples WHERE point_id = 'HP-V'").get().n;
  // Binding subscribed `atlas/north/+/vibration` (wildcard segment),
  // we publish on a literal that matches.
  await publish("atlas/north/pump-a/vibration", "1.234");
  await waitForRow(
    () => db.prepare("SELECT COUNT(*) AS n FROM historian_samples WHERE point_id = 'HP-V'").get().n > before,
    "wildcard-matched sample",
  );
  const sample = db.prepare("SELECT value FROM historian_samples WHERE point_id = 'HP-V' ORDER BY ts DESC LIMIT 1").get();
  assert.equal(sample.value, 1.234);
});

test("token-bucket backpressure coalesces a burst and tags as Substituted", async () => {
  // Bucket is 5 tps (FORGE_MQTT_BACKPRESSURE_TPS=5). Burst 25 messages
  // back-to-back; expect ~5 with Good quality and the rest tagged
  // Substituted. Token regen is 5 tokens/sec so timing is forgiving.
  const before = db.prepare("SELECT COUNT(*) AS n FROM historian_samples WHERE point_id = 'HP-P'").get().n;
  for (let i = 0; i < 25; i++) {
    await publish("atlas/north/pump-a/pressure", String(i));
  }
  await waitForRow(
    () => db.prepare("SELECT COUNT(*) AS n FROM historian_samples WHERE point_id = 'HP-P'").get().n >= before + 25,
    "all 25 burst samples written",
    5000,
  );
  const rows = db.prepare("SELECT quality FROM historian_samples WHERE point_id = 'HP-P' ORDER BY ts DESC LIMIT 25").all();
  const substituted = rows.filter(r => r.quality === "Substituted").length;
  const good = rows.filter(r => r.quality === "Good").length;
  // We expect at LEAST one "Substituted" — backpressure kicked in
  // somewhere during the 25-message burst.
  assert.ok(substituted > 0, `expected some 'Substituted' quality, got good=${good} sub=${substituted}`);
  assert.ok(good > 0, "expected some 'Good' quality samples too");
});

test("non-matching topic is dropped silently", async () => {
  const before = db.prepare("SELECT COUNT(*) AS n FROM historian_samples").get().n;
  // No binding subscribes here.
  await publish("atlas/elsewhere/garbage", "1");
  await new Promise(r => setTimeout(r, 200));
  const after = db.prepare("SELECT COUNT(*) AS n FROM historian_samples").get().n;
  assert.equal(after, before, "no sample written for unrelated topic");
});

test("non-numeric payloads land with quality Uncertain", async () => {
  const before = db.prepare("SELECT COUNT(*) AS n FROM historian_samples WHERE point_id = 'HP-T'").get().n;
  await publish("atlas/north/pump-a/temperature", "not-a-number");
  await waitForRow(
    () => db.prepare("SELECT COUNT(*) AS n FROM historian_samples WHERE point_id = 'HP-T'").get().n > before,
    "uncertain sample written",
  );
  const sample = db.prepare("SELECT * FROM historian_samples WHERE point_id = 'HP-T' ORDER BY ts DESC LIMIT 1").get();
  assert.equal(sample.quality, "Uncertain");
});

test("dedupeTopics drops literals covered by a same-set wildcard", () => {
  const set = new Set([
    "atlas/north/pump-a/temperature",
    "atlas/north/pump-a/pressure",
    "atlas/north/+/vibration",
    "atlas/north/pump-b/vibration", // covered by the wildcard above
  ]);
  const out = mqttRegistry._internals.dedupeTopics(set);
  assert.ok(out.includes("atlas/north/+/vibration"));
  assert.ok(!out.includes("atlas/north/pump-b/vibration"), `wildcard covered literal kept: ${out.join(",")}`);
  // Literals that aren't covered remain.
  assert.ok(out.includes("atlas/north/pump-a/temperature"));
});

test("patternToRegex enforces single-segment + matching", () => {
  const re = mqttRegistry._internals.patternToRegex("atlas/north/+/vibration");
  assert.ok(re.test("atlas/north/pump-a/vibration"));
  // `+` cannot match across `/` boundaries.
  assert.ok(!re.test("atlas/north/pump-a/extra/vibration"));
  // `#` matches the rest.
  const reHash = mqttRegistry._internals.patternToRegex("atlas/north/#");
  assert.ok(reHash.test("atlas/north/anything/here"));
});
