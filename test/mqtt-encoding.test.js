// Phase 7f — MQTT encoding selector + protocol version integration.
//
// Boots an in-process aedes broker, registers two enterprise systems
// pointing at it (one configured for `raw_json` + MQTT 3.1.1, one for
// `sparkplug_b` + MQTT 5.0) plus four bindings, and asserts:
//
//   1. The mqtt-registry honours `config.mqtt_protocol`: a system
//      flagged as 5.0 connects with `protocolVersion: 5` while the
//      default system stays on 4 (3.1.1).
//   2. A Sparkplug B NDATA frame published under spBv1.0/<group>/...
//      is decoded by the registry, matched to the binding's metric
//      name (extracted via metricNameForBinding) and dispatched as
//      a {value, ts, quality} historian sample.
//   3. The legacy raw_json path still works alongside the Sparkplug
//      system on the same broker (regression guard).
//   4. publishWriteback honours per-system encoding: a Sparkplug B
//      writeback round-trips through decodePayload and recovers the
//      written value, while a raw_json writeback recovers a JSON
//      object.
//
// We use `setMqttClientFactory` to inject a wrapper that records
// the connect-options shape, so the protocol-version assertion is
// independent of broker behaviour (aedes accepts any version).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-mqtt-encoding-"));
process.env.FORGE_DATA_DIR = tmpDir;
process.env.FORGE_TENANT_KEY = "forge-mqtt-encoding-test";
process.env.FORGE_JWT_SECRET = "forge-mqtt-encoding-test-jwt";
process.env.FORGE_MQTT_BACKPRESSURE_TPS = "100";
process.env.LOG_LEVEL = "warn";

const { db } = await import("../server/db.js");
const ts = new Date().toISOString();

// ────────────────────────────────────────────────────────────────────
// Seed: one org, one asset, four bindings (two per system).
// ────────────────────────────────────────────────────────────────────
db.prepare("INSERT INTO organizations (id, name, tenant_key, created_at) VALUES (?,?,?,?)").run("ORG-E", "Atlas", "atlas-e", ts);
db.prepare("INSERT INTO workspaces (id, org_id, name, region, created_at) VALUES (?,?,?,?,?)").run("WS-E", "ORG-E", "North", "us-east", ts);
db.prepare("INSERT INTO assets (id, org_id, workspace_id, name, type, hierarchy, status, mqtt_topics, opcua_nodes, doc_ids, acl, labels, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
  .run("AS-E", "ORG-E", "WS-E", "Pump-A", "pump", "Atlas/North/Pump-A", "normal", "[]", "[]", "[]", "{}", "[]", ts, ts);

const points = [
  { id: "HP-T-RAW", tag: "asset:AS-E:temperature.raw", name: "temperature" },
  { id: "HP-P-RAW", tag: "asset:AS-E:pressure.raw", name: "pressure" },
  { id: "HP-T-SPB", tag: "asset:AS-E:temperature.spb", name: "temperature" },
  { id: "HP-P-SPB", tag: "asset:AS-E:pressure.spb", name: "pressure" },
];
for (const p of points) {
  db.prepare("INSERT INTO historian_points (id, asset_id, source_id, tag, name, unit, data_type, historian, retention_policy_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(p.id, "AS-E", null, p.tag, p.name, "C", "number", "sqlite", null, ts, ts);
}

// Boot a single aedes broker that both systems share.
const aedesMod = await import("aedes");
const Aedes = aedesMod.Aedes;
const broker = await Aedes.createBroker({});
const server = net.createServer(broker.handle);
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const brokerUrl = `mqtt://127.0.0.1:${port}`;

// ────────────────────────────────────────────────────────────────────
// Two enterprise_systems rows: raw_json/3.1.1 (default) and
// sparkplug_b/5.0. The Sparkplug system points at the same broker —
// in real deployments these are typically different brokers, but
// aedes happily multiplexes both protocol versions on one socket.
// ────────────────────────────────────────────────────────────────────
// NOTE: aedes 1.0 (in-process broker used by these tests) supports
// only MQTT 3.1 and 3.1.1; no public Node.js in-process broker
// implements MQTT 5 yet. The protocol-version *negotiation* path is
// covered by a separate stubbed-factory test below; the live broker
// dialogue here pins both systems to 3.1.1 so the encoding round-trip
// (raw_json vs sparkplug_b) can run against the same aedes instance.
db.prepare("INSERT INTO enterprise_systems (id, name, kind, category, vendor, base_url, auth_type, secret_ref, status, capabilities, owner_id, config, created_at, updated_at, org_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
  .run("ES-RAW", "Raw broker", "mqtt", "iot.broker", "Aedes", brokerUrl, "none", null, "configured", "[]", "U-X",
       JSON.stringify({ mqtt_protocol: "3.1.1", mqtt_encoding: "raw_json" }), ts, ts, "ORG-E");

db.prepare("INSERT INTO enterprise_systems (id, name, kind, category, vendor, base_url, auth_type, secret_ref, status, capabilities, owner_id, config, created_at, updated_at, org_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
  .run("ES-SPB", "Sparkplug broker", "mqtt", "iot.broker", "Cirrus Link", brokerUrl, "none", null, "configured", "[]", "U-X",
       JSON.stringify({ mqtt_protocol: "3.1.1", mqtt_encoding: "sparkplug_b" }), ts, ts, "ORG-E");

// Bindings — raw_json topics on ES-RAW, Sparkplug B topics on ES-SPB.
// The Sparkplug source_path encodes the canonical NDATA topic; the
// metric name is implied by template_vars.
const bindings = [
  { id: "APB-T-RAW", point: "HP-T-RAW", system: "ES-RAW", topic: "atlas/north/pumpA/temperature", tv: {} },
  { id: "APB-P-RAW", point: "HP-P-RAW", system: "ES-RAW", topic: "atlas/north/pumpA/pressure", tv: {} },
  { id: "APB-T-SPB", point: "HP-T-SPB", system: "ES-SPB", topic: "spBv1.0/Atlas/NDATA/edge1/pumpA", tv: { metric_name: "temperature" } },
  { id: "APB-P-SPB", point: "HP-P-SPB", system: "ES-SPB", topic: "spBv1.0/Atlas/NDATA/edge1/pumpA", tv: { metric_name: "pressure" } },
];
for (const b of bindings) {
  db.prepare(`INSERT INTO asset_point_bindings
    (id, org_id, asset_id, profile_version_id, profile_point_id, point_id, system_id,
     source_kind, source_path, template_vars, enabled, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(b.id, "ORG-E", "AS-E", null, null, b.point, b.system, "mqtt", b.topic, JSON.stringify(b.tv), 1, ts, ts);
}

// ────────────────────────────────────────────────────────────────────
// Boot the registry with a recording client factory. The factory
// wraps the real `mqtt.connect()` so we keep the actual broker
// dialogue intact while capturing the connect-options shape for
// the protocolVersion assertion.
// ────────────────────────────────────────────────────────────────────
const mqttRegistry = await import("../server/connectors/mqtt-registry.js");
const registry = await import("../server/connectors/registry.js");
const sparkplugCodec = await import("../server/connectors/sparkplug-codec.js");
const mqttMod = await import("mqtt");
const mqtt = mqttMod.default || mqttMod;

const recordedConnects = [];
mqttRegistry.setMqttClientFactory((url, opts) => {
  recordedConnects.push({ url, opts });
  return mqtt.connect(url, opts);
});

async function dispatchSample(args) {
  await registry.dispatchSample(args);
}
await mqttRegistry.init({ logger: console, dispatchSample });

async function waitForReady(systemId, maxMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const sysState = mqttRegistry._internals.state.systems.get(systemId);
    if (sysState && sysState.status === "connected") return;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`mqtt-registry never reached connected state for ${systemId}`);
}
await waitForReady("ES-RAW");
await waitForReady("ES-SPB");
// Subscribe ACKs need a beat past connect.
await new Promise(r => setTimeout(r, 250));

// Independent publisher for the round-trip tests.
const publisher = mqtt.connect(brokerUrl, { reconnectPeriod: 5000, connectTimeout: 5000 });
await new Promise((resolve, reject) => {
  publisher.once("connect", resolve);
  publisher.once("error", reject);
  setTimeout(() => reject(new Error("publisher timeout")), 5000);
});

async function publish(topic, body, opts = {}) {
  return new Promise((resolve, reject) => {
    publisher.publish(topic, body, { qos: 1, ...opts }, (err) => {
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
  try { publisher.end(true); } catch { /* swallow */ }
  try { await mqttRegistry.shutdown(); } catch { /* swallow */ }
  mqttRegistry.resetMqttClientFactory();
  try { server.close(); } catch { /* swallow */ }
  try { await new Promise(r => broker.close(r)); } catch { /* swallow */ }
});

// ────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────

test("the mqtt-registry threads protocolVersion through to mqtt.connect()", () => {
  // Both seeded systems pin to 3.1.1 (so aedes can handshake) — the
  // assertion is that the version actually flows from system config
  // into the connect-options block, not the literal value.
  assert.equal(recordedConnects.length, 2, "exactly two connect() invocations");
  for (const r of recordedConnects) {
    assert.equal(r.url, brokerUrl);
    assert.equal(r.opts.connectTimeout, 10_000);
    assert.equal(r.opts.reconnectPeriod, 5000);
    assert.equal(r.opts.protocolVersion, 4, "3.1.1 maps to wire version 4");
  }
});

test("MQTT 5 protocolVersion is wired through when the system config asks for it", async () => {
  // aedes 1.0 doesn't understand MQTT 5, so we stub the factory and
  // assert the connect-options shape the registry would have used.
  // The stub returns a no-op client object that emits 'connect' on
  // the next tick — enough for the registry to mark the system
  // connected and stop racing the test.
  const seenOpts = [];
  const fakeFactory = (url, opts) => {
    seenOpts.push({ url, opts });
    const handlers = {};
    const fakeClient = {
      on(event, fn) { handlers[event] = fn; return fakeClient; },
      once(event, fn) { handlers[event] = fn; return fakeClient; },
      subscribe(_topic, _o, cb) { if (cb) cb(null); return fakeClient; },
      publish(_topic, _payload, _o, cb) { if (cb) cb(null); return fakeClient; },
      end() { return fakeClient; },
      removeAllListeners() { return fakeClient; },
    };
    // Fire 'connect' so the registry transitions to connected.
    setImmediate(() => handlers.connect?.());
    return fakeClient;
  };

  // Inject a fresh enterprise_systems row pinned to MQTT 5 + a
  // single dummy binding so rebuild() actually opens a client for it.
  db.prepare("INSERT INTO enterprise_systems (id, name, kind, category, vendor, base_url, auth_type, secret_ref, status, capabilities, owner_id, config, created_at, updated_at, org_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("ES-V5", "MQTT5 broker", "mqtt", "iot.broker", "stub", brokerUrl, "none", null, "configured", "[]", "U-X",
         JSON.stringify({ mqtt_protocol: "5.0", mqtt_encoding: "raw_json" }), ts, ts, "ORG-E");
  db.prepare("INSERT INTO historian_points (id, asset_id, source_id, tag, name, unit, data_type, historian, retention_policy_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run("HP-V5", "AS-E", null, "asset:AS-E:v5", "v5", "C", "number", "sqlite", null, ts, ts);
  db.prepare(`INSERT INTO asset_point_bindings
    (id, org_id, asset_id, profile_version_id, profile_point_id, point_id, system_id,
     source_kind, source_path, template_vars, enabled, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run("APB-V5", "ORG-E", "AS-E", null, null, "HP-V5", "ES-V5", "mqtt", "v5/test", "{}", 1, ts, ts);

  // Tear down the live aedes-backed registry, swap in the stub
  // factory, run a fresh init.
  await mqttRegistry.shutdown();
  mqttRegistry.setMqttClientFactory(fakeFactory);
  recordedConnects.length = 0;
  await mqttRegistry.init({ logger: console, dispatchSample });

  // Wait for ES-V5 (and the others) to flip to connected.
  const start = Date.now();
  while (Date.now() - start < 2000) {
    const v5state = mqttRegistry._internals.state.systems.get("ES-V5");
    if (v5state?.status === "connected") break;
    await new Promise(r => setTimeout(r, 25));
  }

  const v5 = seenOpts.find(s => s.opts.protocolVersion === 5);
  assert.ok(v5, "registry called factory with protocolVersion=5 for the v5-configured system");
  // Other systems should have called the factory with v4.
  assert.ok(seenOpts.some(s => s.opts.protocolVersion === 4), "v4 systems still negotiate v4");

  // Confirm the registry's state matches.
  const v5State = mqttRegistry._internals.state.systems.get("ES-V5");
  assert.equal(v5State?.protocolVersion, 5);
  assert.equal(v5State?.encoding, "raw_json");

  // Tear the stub down and restore the live aedes factory so the
  // remaining tests still hit a real broker.
  await mqttRegistry.shutdown();
  // Drop the dummy v5 row so rebuild() doesn't try to reach a fake host.
  db.prepare("DELETE FROM asset_point_bindings WHERE id = 'APB-V5'").run();
  db.prepare("DELETE FROM enterprise_systems WHERE id = 'ES-V5'").run();
  db.prepare("DELETE FROM historian_points WHERE id = 'HP-V5'").run();
  mqttRegistry.setMqttClientFactory((url, opts) => {
    recordedConnects.push({ url, opts });
    return mqtt.connect(url, opts);
  });
  await mqttRegistry.init({ logger: console, dispatchSample });
  await waitForReady("ES-RAW");
  await waitForReady("ES-SPB");
  await new Promise(r => setTimeout(r, 250));
});

test("registry surfaces per-system encoding in its state", () => {
  const raw = mqttRegistry._internals.state.systems.get("ES-RAW");
  assert.equal(raw?.encoding, "raw_json");
  assert.equal(raw?.protocolVersion, 4);

  const spb = mqttRegistry._internals.state.systems.get("ES-SPB");
  assert.equal(spb?.encoding, "sparkplug_b");
  assert.equal(spb?.protocolVersion, 4);
});

test("raw_json encoding still ingests JSON payloads end-to-end", async () => {
  await publish("atlas/north/pumpA/temperature", JSON.stringify({ value: 21.5, quality: "Good" }));
  await waitForRow(
    () => db.prepare("SELECT COUNT(*) AS n FROM historian_samples WHERE point_id = ?").get("HP-T-RAW")?.n > 0,
    "raw_json temperature sample landed",
  );
  const row = db.prepare("SELECT value, quality FROM historian_samples WHERE point_id = ? ORDER BY ts DESC LIMIT 1").get("HP-T-RAW");
  assert.equal(row.value, 21.5);
  assert.equal(row.quality, "Good");
});

test("sparkplug_b NDATA frame routes both metrics to their respective bindings", async () => {
  // Encode a single NDATA payload with two metrics; one binding
  // should pick "temperature", the other "pressure". Both targets
  // share the same source_path topic because Sparkplug B fans out
  // device-level NDATA frames.
  const payloadTs = Date.now();
  const buffer = sparkplugCodec.buildCommandPayload({
    metricName: "temperature",
    value: 88.5,
    timestamp: payloadTs,
  });
  // buildCommandPayload makes single-metric frames; emit a real
  // multi-metric NDATA via the underlying tahu encoder.
  const sparkplugPayload = (await import("sparkplug-payload")).default;
  const tahu = sparkplugPayload.get("spBv1.0");
  const nDataBuffer = tahu.encodePayload({
    timestamp: payloadTs,
    metrics: [
      { name: "temperature", value: 88.5, type: "Double", timestamp: payloadTs },
      { name: "pressure", value: 5.25, type: "Float", timestamp: payloadTs },
    ],
    seq: 1,
  });

  await publish("spBv1.0/Atlas/NDATA/edge1/pumpA", nDataBuffer);
  await waitForRow(
    () => db.prepare("SELECT COUNT(*) AS n FROM historian_samples WHERE point_id = ?").get("HP-T-SPB")?.n > 0,
    "sparkplug_b temperature sample landed",
  );
  await waitForRow(
    () => db.prepare("SELECT COUNT(*) AS n FROM historian_samples WHERE point_id = ?").get("HP-P-SPB")?.n > 0,
    "sparkplug_b pressure sample landed",
  );

  const tRow = db.prepare("SELECT value, quality FROM historian_samples WHERE point_id = ? ORDER BY ts DESC LIMIT 1").get("HP-T-SPB");
  assert.equal(tRow.value, 88.5, "temperature decoded as Double is bit-exact");

  const pRow = db.prepare("SELECT value, quality FROM historian_samples WHERE point_id = ? ORDER BY ts DESC LIMIT 1").get("HP-P-SPB");
  assert.equal(pRow.value, 5.25, "pressure decoded as Float (5.25 is exactly representable)");

  assert.equal(tRow.quality, "Good");
  assert.equal(pRow.quality, "Good");
});

test("sparkplug_b control frames (NDEATH, STATE) are dropped without dispatch", async () => {
  // Re-bind a temporary point on a STATE topic to confirm the
  // control-frame filter prevents control frames from polluting
  // historian samples. We assert by counting samples before/after.
  const before = db.prepare("SELECT COUNT(*) AS n FROM historian_samples").get().n;
  await publish("spBv1.0/Atlas/NDEATH/edge1", Buffer.from([0x00, 0x01, 0x02])); // garbage protobuf is fine — we drop pre-decode
  await publish("spBv1.0/Atlas/STATE/edge1", Buffer.from("offline", "utf8"));
  // Give the registry a few ms to have processed (or skipped).
  await new Promise(r => setTimeout(r, 200));
  const after = db.prepare("SELECT COUNT(*) AS n FROM historian_samples").get().n;
  assert.equal(after, before, "no historian rows added by control frames");
});

test("sparkplug_b decode failure is logged + no sample dispatched (graceful path)", async () => {
  // Send garbage bytes on a NDATA topic the registry has subscribed
  // to. The decoder will throw inside the message handler; the
  // expected behaviour is "log and return" — no sample row, no
  // unhandled-rejection crash.
  const before = db.prepare("SELECT COUNT(*) AS n FROM historian_samples WHERE point_id IN (?, ?)").get("HP-T-SPB", "HP-P-SPB").n;
  await publish("spBv1.0/Atlas/NDATA/edge1/pumpA", Buffer.from([0xff, 0xff, 0xff, 0x00, 0x42, 0x42]));
  await new Promise(r => setTimeout(r, 200));
  const after = db.prepare("SELECT COUNT(*) AS n FROM historian_samples WHERE point_id IN (?, ?)").get("HP-T-SPB", "HP-P-SPB").n;
  assert.equal(after, before, "garbage payload on sparkplug topic does not write a row");
});

test("publishWriteback emits Sparkplug B encoding for sparkplug_b systems", async () => {
  // Subscribe a sniffer on the Sparkplug source path so we can
  // capture the published payload bytes and verify their format.
  const sniffer = mqtt.connect(brokerUrl);
  await new Promise(r => sniffer.once("connect", r));
  const captured = [];
  sniffer.on("message", (topic, payload) => {
    if (topic === "spBv1.0/Atlas/NDATA/edge1/pumpA") captured.push(payload);
  });
  await new Promise(r => sniffer.subscribe("spBv1.0/Atlas/NDATA/edge1/pumpA", { qos: 1 }, r));

  const binding = db.prepare("SELECT * FROM asset_point_bindings WHERE id = ?").get("APB-T-SPB");
  const result = await mqttRegistry.publishWriteback({ binding, value: 42.5 });
  assert.equal(result.ok, true, "writeback publish succeeded");
  assert.equal(result.encoding, "sparkplug_b");

  await waitForRow(() => captured.length > 0, "captured at least one writeback payload");

  // The captured bytes must decode as a Sparkplug B payload with
  // the expected metric.
  const decoded = sparkplugCodec.decodePayload(captured[0]);
  const sample = sparkplugCodec.extractMetricSample(decoded, "temperature");
  assert.equal(sample.value, 42.5);

  await new Promise(r => sniffer.end(true, {}, r));
});

test("publishWriteback emits raw JSON for raw_json systems (regression)", async () => {
  const sniffer = mqtt.connect(brokerUrl);
  await new Promise(r => sniffer.once("connect", r));
  const captured = [];
  sniffer.on("message", (topic, payload) => {
    if (topic === "atlas/north/pumpA/temperature") captured.push(payload.toString("utf8"));
  });
  await new Promise(r => sniffer.subscribe("atlas/north/pumpA/temperature", { qos: 1 }, r));

  const binding = db.prepare("SELECT * FROM asset_point_bindings WHERE id = ?").get("APB-T-RAW");
  const result = await mqttRegistry.publishWriteback({ binding, value: 13.7 });
  assert.equal(result.ok, true);
  assert.equal(result.encoding, "raw_json");

  await waitForRow(() => captured.length > 0, "captured at least one raw_json writeback");

  const parsed = JSON.parse(captured[captured.length - 1]);
  assert.equal(parsed.value, 13.7);
  assert.equal(parsed.quality, "Good");
  assert.equal(parsed.source, "forge.writeback");

  await new Promise(r => sniffer.end(true, {}, r));
});

test("publishWriteback rejects non-finite values up-front", async () => {
  const binding = db.prepare("SELECT * FROM asset_point_bindings WHERE id = ?").get("APB-T-SPB");
  const result = await mqttRegistry.publishWriteback({ binding, value: NaN });
  assert.equal(result.ok, false);
  assert.equal(result.code, "invalid_value");
});
