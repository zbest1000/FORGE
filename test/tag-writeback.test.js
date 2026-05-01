// Tag writeback tests — Phase 7c.
//
// Real Fastify in-process; an in-process aedes broker stands in
// for the registered enterprise_systems row so the writeback path
// publishes a real PUBLISH packet (which a separate subscriber
// receives, proving the round-trip).
//
// Coverage matrix:
//   - device.write capability gate: Engineer 403, Integration
//     Admin (has integration.write but NOT device.write) 403,
//     Workspace Admin 200.
//   - Successful writeback publishes reaches the broker (subscriber
//     sees it) with QoS 2 + the JSON envelope shape.
//   - Audit chain has both `device.write.attempt` and
//     `device.write.success` rows.
//   - Disabled binding returns 409 `no_active_binding`.
//   - Missing pointId returns 404.
//   - Per-route rate limit: 10 / minute / user is enforced —
//     within 12 calls the route returns 429.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-writeback-"));
process.env.FORGE_DATA_DIR = tmpDir;
process.env.FORGE_TENANT_KEY = "forge-writeback-test";
process.env.FORGE_JWT_SECRET = "forge-writeback-test-jwt";
// Global limit kept generous; per-route 10/min override is what
// this suite exercises.
process.env.FORGE_RATELIMIT_MAX = "10000";
process.env.LOG_LEVEL = "warn";

const { db } = await import("../server/db.js");
const bcrypt = (await import("bcryptjs")).default;
const ts = new Date().toISOString();

// Two orgs not strictly needed for this suite, but seed enough so
// tenant scoping is exercised.
db.prepare("INSERT INTO organizations (id, name, tenant_key, created_at) VALUES ('ORG-A','Atlas','atlas',?)").run(ts);
db.prepare("INSERT INTO workspaces (id, org_id, name, region, created_at) VALUES ('WS-A','ORG-A','North','us-east',?)").run(ts);
const wsAdminHash = await bcrypt.hash("forge", 10);
const engHash = await bcrypt.hash("forge", 10);
const intAdminHash = await bcrypt.hash("forge", 10);
db.prepare("INSERT INTO users (id, org_id, email, name, role, password_hash, initials, disabled, created_at, updated_at) VALUES ('U-WSADM','ORG-A','wsadm@forge.local','WS Admin','Workspace Admin',?,'WA',0,?,?)").run(wsAdminHash, ts, ts);
db.prepare("INSERT INTO users (id, org_id, email, name, role, password_hash, initials, disabled, created_at, updated_at) VALUES ('U-ENG','ORG-A','eng@forge.local','Engineer','Engineer/Contributor',?,'EN',0,?,?)").run(engHash, ts, ts);
db.prepare("INSERT INTO users (id, org_id, email, name, role, password_hash, initials, disabled, created_at, updated_at) VALUES ('U-INTADM','ORG-A','intadm@forge.local','Int Admin','Integration Admin',?,'IA',0,?,?)").run(intAdminHash, ts, ts);

// Asset + historian point + binding pointing at our test broker.
db.prepare("INSERT INTO assets (id, org_id, workspace_id, name, type, hierarchy, status, mqtt_topics, opcua_nodes, doc_ids, acl, labels, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
  .run("AS-1", "ORG-A", "WS-A", "Pump-A", "pump", "Atlas/North/Pump-A", "normal", "[]", "[]", "[]", "{}", "[]", ts, ts);
db.prepare("INSERT INTO historian_points (id, asset_id, source_id, tag, name, unit, data_type, historian, retention_policy_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
  .run("HP-SP", "AS-1", null, "asset:AS-1:setpoint", "setpoint", "C", "number", "sqlite", null, ts, ts);

// Stand up the aedes broker.
const aedes = await import("aedes");
const broker = await aedes.Aedes.createBroker({});
const server = net.createServer(broker.handle);
await new Promise(r => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const brokerUrl = `mqtt://127.0.0.1:${port}`;

db.prepare("INSERT INTO enterprise_systems (id, name, kind, category, vendor, base_url, auth_type, secret_ref, status, capabilities, owner_id, config, created_at, updated_at, org_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
  .run("ES-MQTT-W", "Test broker", "mqtt", "iot.broker", "Aedes", brokerUrl, "none", null, "configured", "[]", "U-WSADM", "{}", ts, ts, "ORG-A");
db.prepare(`INSERT INTO asset_point_bindings
  (id, org_id, asset_id, profile_version_id, profile_point_id, point_id, system_id,
   source_kind, source_path, template_vars, enabled, created_at, updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  .run("APB-W", "ORG-A", "AS-1", null, null, "HP-SP", "ES-MQTT-W",
       "mqtt", "atlas/north/pump-a/setpoint", "{}", 1, ts, ts);

// Boot the connector orchestrator (mqtt-registry connects to the
// broker so publishWriteback can find a connected client).
const orchestrator = await import("../server/connectors/registry.js");
await orchestrator.init({ logger: console });
const mqttRegistry = await import("../server/connectors/mqtt-registry.js");
async function waitForConnected(timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const sys = mqttRegistry._internals.state.systems.get("ES-MQTT-W");
    if (sys && sys.status === "connected") return;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error("mqtt-registry never connected to test broker");
}
await waitForConnected();

// Independent subscriber so we can assert the writeback PUBLISH
// reaches the broker.
const mqttPkg = await import("mqtt");
const mqtt = mqttPkg.default || mqttPkg;
const sub = mqtt.connect(brokerUrl);
const received = [];
await new Promise((resolve, reject) => {
  sub.once("connect", resolve);
  sub.once("error", reject);
  setTimeout(() => reject(new Error("sub timeout")), 5000);
});
await new Promise((resolve) => sub.subscribe("atlas/north/pump-a/setpoint", { qos: 2 }, () => resolve()));
sub.on("message", (topic, payload) => received.push({ topic, payload: JSON.parse(payload.toString()) }));

// Boot Fastify with rate-limit + the writeback route.
const { default: Fastify } = await import("fastify");
const { default: jwt } = await import("@fastify/jwt");
const { default: cors } = await import("@fastify/cors");
const { default: rateLimit } = await import("@fastify/rate-limit");
const { userById } = await import("../server/auth.js");

const app = Fastify({ logger: false });
await app.register(cors, { origin: true });
await app.register(jwt, { secret: process.env.FORGE_JWT_SECRET });
await app.register(rateLimit, {
  global: true,
  max: 10000, // generous; per-route 10/min is what we test
  timeWindow: "1 minute",
  keyGenerator: (req) => (req.user?.id || req.ip || "anon"),
});
app.addHook("onRequest", async (req) => {
  const h = req.headers.authorization || "";
  const tok = h.startsWith("Bearer ") ? h.slice(7) : null;
  req.user = null;
  if (!tok) return;
  try {
    const d = app.jwt.verify(tok);
    if (!d?.sub) return;
    req.user = userById(d.sub);
  } catch { /* swallow */ }
});
await app.register((await import("../server/routes/auth.js")).default);
await app.register((await import("../server/routes/tag-writeback.js")).default);

await app.listen({ port: 0, host: "127.0.0.1" });
const addr = app.server.address();
const base = `http://127.0.0.1:${addr.port}`;

async function login(email) {
  const r = await fetch(base + "/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "forge" }),
  });
  return (await r.json()).token;
}
const TOKEN_WSADM = await login("wsadm@forge.local");
const TOKEN_ENG = await login("eng@forge.local");
const TOKEN_INTADM = await login("intadm@forge.local");

async function req(p, opts = {}) {
  const r = await fetch(base + p, opts);
  const ct = r.headers.get("content-type") || "";
  const body = ct.includes("application/json") ? await r.json() : await r.text();
  return { status: r.status, body, headers: r.headers };
}

test.after(async () => {
  try { sub.end(true); } catch {}
  try { await orchestrator.shutdown(); } catch {}
  try { server.close(); } catch {}
  try { await new Promise(r => broker.close(r)); } catch {}
  try { await app.close(); } catch {}
});

// ----- tests -----

test("Engineer/Contributor blocked at device.write capability gate (403)", async () => {
  const r = await req("/api/tags/HP-SP/write", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN_ENG}`, "content-type": "application/json" },
    body: JSON.stringify({ value: 50.0 }),
  });
  assert.equal(r.status, 403);
});

test("Integration Admin (integration.write but NOT device.write) is blocked (403)", async () => {
  const r = await req("/api/tags/HP-SP/write", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN_INTADM}`, "content-type": "application/json" },
    body: JSON.stringify({ value: 50.0 }),
  });
  assert.equal(r.status, 403);
});

test("Workspace Admin succeeds; PUBLISH reaches the broker; audit chain has attempt + success", async () => {
  const before = received.length;
  const r = await req("/api/tags/HP-SP/write", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN_WSADM}`, "content-type": "application/json" },
    body: JSON.stringify({ value: 75.5, quality: "Good" }),
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  assert.equal(r.body.dispatch.qos, 2);
  // Publish reached the broker (subscriber sees it).
  await new Promise(rsv => setTimeout(rsv, 200));
  assert.ok(received.length > before, "subscriber received writeback PUBLISH");
  const newest = received[received.length - 1];
  assert.equal(newest.topic, "atlas/north/pump-a/setpoint");
  assert.equal(newest.payload.value, 75.5);
  assert.equal(newest.payload.source, "forge.writeback");
  // Audit chain has both attempt + success rows.
  const { drain } = await import("../server/audit.js");
  await drain();
  const rows = db.prepare("SELECT action FROM audit_log WHERE subject = 'HP-SP' AND action LIKE 'device.write%' ORDER BY seq").all();
  assert.ok(rows.find(r => r.action === "device.write.attempt"));
  assert.ok(rows.find(r => r.action === "device.write.success"));
});

test("missing pointId returns 404 not_found", async () => {
  const r = await req("/api/tags/HP-DOES-NOT-EXIST/write", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN_WSADM}`, "content-type": "application/json" },
    body: JSON.stringify({ value: 1 }),
  });
  assert.equal(r.status, 404);
});

test("disabled binding returns 409 no_active_binding", async () => {
  db.prepare("UPDATE asset_point_bindings SET enabled = 0 WHERE id = 'APB-W'").run();
  const r = await req("/api/tags/HP-SP/write", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN_WSADM}`, "content-type": "application/json" },
    body: JSON.stringify({ value: 1 }),
  });
  assert.equal(r.status, 409);
  assert.equal(r.body.error?.code, "no_active_binding");
  db.prepare("UPDATE asset_point_bindings SET enabled = 1 WHERE id = 'APB-W'").run();
});

test("per-route rate limit caps device.write at 10/min/user", async () => {
  // Used 1 successful + 1 disabled-binding write in this run; we
  // have 8 more before the limit fires. Hammer 12 to be safe.
  let firstRateLimited = -1;
  for (let i = 0; i < 12; i++) {
    const r = await req("/api/tags/HP-SP/write", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN_WSADM}`, "content-type": "application/json" },
      body: JSON.stringify({ value: i }),
    });
    if (r.status === 429) { firstRateLimited = i; break; }
  }
  assert.ok(firstRateLimited >= 0 && firstRateLimited < 12, `expected 429 within 12 calls (got ${firstRateLimited})`);
});
