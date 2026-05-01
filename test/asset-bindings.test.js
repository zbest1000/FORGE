// Asset binding tests: apply-profile, custom-mapping, list, delete,
// test, plus tenant isolation + capability gates.
//
// These tests don't spin up a real broker / database — the SQL
// connector registry's polling timers are explicitly disabled via
// `FORGE_DISABLE_CONNECTOR_REGISTRY=1` so the in-process Fastify
// stays deterministic. Phase 4/5 will add the live-data fixtures.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-bindings-"));
process.env.FORGE_DATA_DIR = tmpDir;
process.env.FORGE_TENANT_KEY = "forge-bindings-test";
process.env.FORGE_JWT_SECRET = "forge-bindings-test-jwt";
process.env.FORGE_RATELIMIT_MAX = "10000";
process.env.FORGE_DISABLE_CONNECTOR_REGISTRY = "1";
process.env.LOG_LEVEL = "warn";

const { db } = await import("../server/db.js");
const bcrypt = (await import("bcryptjs")).default;
const ts = new Date().toISOString();

// Two orgs + a Workspace Admin (gets `historian.sql.raw`) and a
// non-admin Engineer/Contributor (does not).
db.prepare("INSERT INTO organizations (id, name, tenant_key, created_at) VALUES (?,?,?,?)").run("ORG-A", "Atlas", "atlas", ts);
db.prepare("INSERT INTO organizations (id, name, tenant_key, created_at) VALUES (?,?,?,?)").run("ORG-B", "Borealis", "borealis", ts);
db.prepare("INSERT INTO workspaces (id, org_id, name, region, created_at) VALUES (?,?,?,?,?)").run("WS-A", "ORG-A", "North", "us-east", ts);
db.prepare("INSERT INTO workspaces (id, org_id, name, region, created_at) VALUES (?,?,?,?,?)").run("WS-B", "ORG-B", "South", "eu-west", ts);

const ownerHash = await bcrypt.hash("forge", 10);
const wsAdminHash = await bcrypt.hash("forge", 10);
const engHash = await bcrypt.hash("forge", 10);
db.prepare("INSERT INTO users (id, org_id, email, name, role, password_hash, initials, disabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
  .run("U-OWNER-A", "ORG-A", "owner-a@forge.local", "Owner A", "Organization Owner", ownerHash, "OA", 0, ts, ts);
db.prepare("INSERT INTO users (id, org_id, email, name, role, password_hash, initials, disabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
  .run("U-WSADM-A", "ORG-A", "wsadm-a@forge.local", "WS Admin A", "Workspace Admin", wsAdminHash, "WA", 0, ts, ts);
db.prepare("INSERT INTO users (id, org_id, email, name, role, password_hash, initials, disabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
  .run("U-ENG-A", "ORG-A", "eng-a@forge.local", "Engineer A", "Engineer/Contributor", engHash, "EA", 0, ts, ts);
db.prepare("INSERT INTO users (id, org_id, email, name, role, password_hash, initials, disabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
  .run("U-INTADM-A", "ORG-A", "intadm-a@forge.local", "Int Admin A", "Integration Admin", wsAdminHash, "IA", 0, ts, ts);
db.prepare("INSERT INTO users (id, org_id, email, name, role, password_hash, initials, disabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
  .run("U-OWNER-B", "ORG-B", "owner-b@forge.local", "Owner B", "Organization Owner", ownerHash, "OB", 0, ts, ts);

const { default: Fastify } = await import("fastify");
const { default: jwt } = await import("@fastify/jwt");
const { default: cors } = await import("@fastify/cors");
const { default: multipart } = await import("@fastify/multipart");
const { userById } = await import("../server/auth.js");

const app = Fastify({ logger: false });
await app.register(cors, { origin: true });
await app.register(jwt, { secret: process.env.FORGE_JWT_SECRET });
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
  } catch { /* swallow */ }
});

await app.register((await import("../server/routes/auth.js")).default);
await app.register((await import("../server/routes/core.js")).default);
await app.register((await import("../server/routes/asset-hierarchy.js")).default);
await app.register((await import("../server/routes/asset-profiles.js")).default);
await app.register((await import("../server/routes/asset-bindings.js")).default);

await app.listen({ port: 0, host: "127.0.0.1" });
const addr = app.server.address();
const base = `http://127.0.0.1:${addr.port}`;

let TOKEN_OWNER_A;
let TOKEN_WSADM_A;
let TOKEN_ENG_A;
let TOKEN_INTADM_A;
let TOKEN_OWNER_B;

async function req(p, opts = {}) {
  const r = await fetch(base + p, opts);
  const ct = r.headers.get("content-type") || "";
  const body = ct.includes("application/json") ? await r.json() : await r.text();
  return { status: r.status, body, headers: r.headers };
}
function withAuth(token) { return { authorization: `Bearer ${token}` }; }
function jsonHeaders(token) { return { ...withAuth(token), "content-type": "application/json" }; }
function bodyOf(obj) { return JSON.stringify(obj); }
async function login(email) {
  const r = await req("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: bodyOf({ email, password: "forge" }) });
  return r.body.token;
}

test.after(async () => { await app.close(); });

test("login all roles + tenants", async () => {
  TOKEN_OWNER_A = await login("owner-a@forge.local");
  TOKEN_WSADM_A = await login("wsadm-a@forge.local");
  TOKEN_ENG_A = await login("eng-a@forge.local");
  TOKEN_INTADM_A = await login("intadm-a@forge.local");
  TOKEN_OWNER_B = await login("owner-b@forge.local");
  assert.ok(TOKEN_OWNER_A && TOKEN_WSADM_A && TOKEN_ENG_A && TOKEN_INTADM_A && TOKEN_OWNER_B);
});

// ----- Fixture builder -----------------------------------------------------

let ENT_A, LOC_A, AS_A, MQTT_SYSTEM_A, SQL_SYSTEM_A, OPCUA_SYSTEM_A;
let PROFILE_MQTT, PVER_MQTT, PROFILE_SQL, PVER_SQL;

test("seed enterprise/location/asset + register MQTT + SQL + OPC UA systems", async () => {
  const e = await req("/api/enterprises", { method: "POST", headers: jsonHeaders(TOKEN_OWNER_A), body: bodyOf({ name: "Atlas Industrial" }) });
  assert.equal(e.status, 200);
  ENT_A = e.body.id;
  const l = await req("/api/locations", { method: "POST", headers: jsonHeaders(TOKEN_OWNER_A), body: bodyOf({ enterpriseId: ENT_A, name: "North Plant", kind: "site" }) });
  LOC_A = l.body.id;
  const a = await req("/api/assets", { method: "POST", headers: jsonHeaders(TOKEN_OWNER_A), body: bodyOf({ name: "Pump-A", type: "pump", enterpriseId: ENT_A, locationId: LOC_A }) });
  AS_A = a.body.id;

  // Register systems directly via DB so the test doesn't depend on
  // the enterprise-systems plugin (which is feature-flag gated).
  const tsNow = new Date().toISOString();
  db.prepare("INSERT INTO enterprise_systems (id, name, kind, category, vendor, base_url, auth_type, secret_ref, status, capabilities, owner_id, config, created_at, updated_at, org_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("ES-MQTT-1", "Plant Mosquitto", "mqtt", "iot.broker", "Mosquitto", "mqtt://broker.acme:1883", "none", null, "configured", "[]", "U-OWNER-A", "{}", tsNow, tsNow, "ORG-A");
  MQTT_SYSTEM_A = "ES-MQTT-1";
  db.prepare("INSERT INTO enterprise_systems (id, name, kind, category, vendor, base_url, auth_type, secret_ref, status, capabilities, owner_id, config, created_at, updated_at, org_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("ES-SQL-1", "PI Historian", "sql", "historian", "OSIsoft PI", "Server=pi.acme;Database=PI", "none", null, "configured", "[]", "U-OWNER-A", "{}", tsNow, tsNow, "ORG-A");
  SQL_SYSTEM_A = "ES-SQL-1";
  db.prepare("INSERT INTO enterprise_systems (id, name, kind, category, vendor, base_url, auth_type, secret_ref, status, capabilities, owner_id, config, created_at, updated_at, org_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("ES-OPC-1", "Plant OPC UA", "opcua", "iot.broker", "Kepware", "opc.tcp://kepware.acme:49320", "none", null, "configured", "[]", "U-OWNER-A", "{}", tsNow, tsNow, "ORG-A");
  OPCUA_SYSTEM_A = "ES-OPC-1";

  // ORG-B has its own MQTT system to test cross-tenant rejection.
  db.prepare("INSERT INTO enterprise_systems (id, name, kind, category, vendor, base_url, auth_type, secret_ref, status, capabilities, owner_id, config, created_at, updated_at, org_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("ES-MQTT-B", "Borealis Mosquitto", "mqtt", "iot.broker", "Mosquitto", "mqtt://b.acme:1883", "none", null, "configured", "[]", "U-OWNER-B", "{}", tsNow, tsNow, "ORG-B");
});

test("create MQTT profile (Pump) + SQL profile (Boiler)", async () => {
  const m = await req("/api/asset-profiles", { method: "POST", headers: jsonHeaders(TOKEN_OWNER_A), body: bodyOf({
    name: "Centrifugal Pump",
    sourceKind: "mqtt",
    sourceTemplate: { topic_template: "forge/{enterprise}/{site}/{asset}/{point}", qos: 1 },
    points: [
      { name: "temperature", unit: "C", dataType: "number", sourcePathTemplate: "{enterprise}/{site}/{asset}/temperature" },
      { name: "pressure",    unit: "bar", dataType: "number", sourcePathTemplate: "{enterprise}/{site}/{asset}/pressure" },
      { name: "vibration",   unit: "mm/s", dataType: "number", sourcePathTemplate: "{enterprise}/{site}/{asset}/vibration" },
    ],
  })});
  assert.equal(m.status, 200);
  PROFILE_MQTT = m.body.id;
  PVER_MQTT = m.body.latestVersion.id;

  const s = await req("/api/asset-profiles", { method: "POST", headers: jsonHeaders(TOKEN_OWNER_A), body: bodyOf({
    name: "Industrial Boiler",
    sourceKind: "sql",
    sourceTemplate: {
      table: "boiler_samples", ts_column: "ts", value_column: "value",
      point_column: "tag", asset_filter_column: "asset_path", poll_interval_ms: 5000,
    },
    points: [
      { name: "steam_pressure", unit: "bar",  dataType: "number", sourcePathTemplate: "{asset}.steam_pressure" },
      { name: "stack_temp",     unit: "C",    dataType: "number", sourcePathTemplate: "{asset}.stack_temp" },
    ],
  })});
  assert.equal(s.status, 200);
  PROFILE_SQL = s.body.id;
  PVER_SQL = s.body.latestVersion.id;
});

// ----- apply-profile -------------------------------------------------------

test("apply MQTT profile creates N historian_points + N bindings", async () => {
  const r = await req(`/api/assets/${AS_A}/apply-profile`, { method: "POST", headers: jsonHeaders(TOKEN_OWNER_A), body: bodyOf({
    profileVersionId: PVER_MQTT,
    sourceSystemId: MQTT_SYSTEM_A,
  })});
  assert.equal(r.status, 200);
  assert.equal(r.body.inserted, 3);
  assert.equal(r.body.bindings.length, 3);
  // Source paths must be fully resolved against the asset's hierarchy.
  for (const b of r.body.bindings) {
    assert.equal(b.sourcePath.startsWith("Atlas Industrial/North Plant/Pump-A/"), true, `path resolved: ${b.sourcePath}`);
    assert.equal(b.sourceKind, "mqtt");
    assert.equal(b.systemId, MQTT_SYSTEM_A);
    assert.ok(b.pointId);
  }
  // Idempotency: applying again should update, not duplicate.
  const r2 = await req(`/api/assets/${AS_A}/apply-profile`, { method: "POST", headers: jsonHeaders(TOKEN_OWNER_A), body: bodyOf({
    profileVersionId: PVER_MQTT, sourceSystemId: MQTT_SYSTEM_A,
  })});
  assert.equal(r2.status, 200);
  assert.equal(r2.body.inserted, 0);
  assert.equal(r2.body.updated, 3);
  assert.equal(r2.body.bindings.length, 3);
});

test("apply-profile rejects MQTT-illegal characters in resolved path", async () => {
  // The wildcard check fires when an ENTIRE topic segment is `+` or
  // `#`. We engineer that condition by giving the asset a single-`+`
  // name and supplying enterprise + location so all placeholders
  // resolve cleanly except for the asset segment, which becomes the
  // wildcard.
  const e = await req("/api/enterprises", { method: "POST", headers: jsonHeaders(TOKEN_OWNER_A), body: bodyOf({ name: "WildEnt" }) });
  const l = await req("/api/locations", { method: "POST", headers: jsonHeaders(TOKEN_OWNER_A), body: bodyOf({ enterpriseId: e.body.id, name: "Plant W", kind: "site" }) });
  const a = await req("/api/assets", { method: "POST", headers: jsonHeaders(TOKEN_OWNER_A), body: bodyOf({
    name: "+", type: "pump", enterpriseId: e.body.id, locationId: l.body.id,
  })});
  const r = await req(`/api/assets/${a.body.id}/apply-profile`, { method: "POST", headers: jsonHeaders(TOKEN_OWNER_A), body: bodyOf({
    profileVersionId: PVER_MQTT, sourceSystemId: MQTT_SYSTEM_A,
  })});
  assert.equal(r.status, 400);
  assert.equal(r.body.error?.code, "mqtt_wildcard_in_path");
});

test("apply-profile rejects unresolved placeholder in template", async () => {
  // Create a custom profile with a placeholder we won't supply.
  const p = await req("/api/asset-profiles", { method: "POST", headers: jsonHeaders(TOKEN_OWNER_A), body: bodyOf({
    name: "Needs Custom Var", sourceKind: "mqtt", sourceTemplate: {},
    points: [{ name: "temp", sourcePathTemplate: "{plc_subnet}/{enterprise}/{site}/{asset}/temp" }],
  })});
  const versionId = p.body.latestVersion.id;
  const r = await req(`/api/assets/${AS_A}/apply-profile`, { method: "POST", headers: jsonHeaders(TOKEN_OWNER_A), body: bodyOf({
    profileVersionId: versionId, sourceSystemId: MQTT_SYSTEM_A,
  })});
  assert.equal(r.status, 400);
  assert.equal(r.body.error?.code, "unresolved_placeholder");
});

test("apply-profile cross-tenant: ORG-B can't apply ORG-A's profile to ORG-A's asset", async () => {
  const r = await req(`/api/assets/${AS_A}/apply-profile`, { method: "POST", headers: jsonHeaders(TOKEN_OWNER_B), body: bodyOf({
    profileVersionId: PVER_MQTT, sourceSystemId: MQTT_SYSTEM_A,
  })});
  assert.equal(r.status, 404, "no existence leak across tenants");
});

test("apply-profile refused while profile is archived", async () => {
  // Archive PROFILE_SQL via PATCH then attempt apply.
  const get = await req(`/api/asset-profiles/${PROFILE_SQL}`, { headers: withAuth(TOKEN_OWNER_A) });
  await req(`/api/asset-profiles/${PROFILE_SQL}`, {
    method: "PATCH",
    headers: { ...jsonHeaders(TOKEN_OWNER_A), "if-match": get.headers.get("etag") },
    body: bodyOf({ status: "archived" }),
  });
  const r = await req(`/api/assets/${AS_A}/apply-profile`, { method: "POST", headers: jsonHeaders(TOKEN_OWNER_A), body: bodyOf({
    profileVersionId: PVER_SQL, sourceSystemId: SQL_SYSTEM_A,
  })});
  assert.equal(r.status, 409);
  assert.equal(r.body.error?.code, "profile_archived");
  // Reactivate for downstream tests.
  const fresh = await req(`/api/asset-profiles/${PROFILE_SQL}`, { headers: withAuth(TOKEN_OWNER_A) });
  await req(`/api/asset-profiles/${PROFILE_SQL}`, {
    method: "PATCH",
    headers: { ...jsonHeaders(TOKEN_OWNER_A), "if-match": fresh.headers.get("etag") },
    body: bodyOf({ status: "active" }),
  });
});

test("apply SQL profile (schema-defined) creates SQL bindings", async () => {
  const r = await req(`/api/assets/${AS_A}/apply-profile`, { method: "POST", headers: jsonHeaders(TOKEN_OWNER_A), body: bodyOf({
    profileVersionId: PVER_SQL, sourceSystemId: SQL_SYSTEM_A,
    sqlMode: "schema_defined",
  })});
  assert.equal(r.status, 200);
  // We earlier applied the MQTT profile (3 bindings) — applying the
  // SQL profile creates 2 new bindings on different point names. The
  // 3 MQTT bindings stay (different points → different historian
  // points → different binding rows; UNIQUE is on (asset_id, point_id)).
  const list = await req(`/api/assets/${AS_A}/bindings`, { headers: withAuth(TOKEN_OWNER_A) });
  const sqlBindings = list.body.filter(b => b.sourceKind === "sql");
  assert.equal(sqlBindings.length, 2);
  for (const b of sqlBindings) {
    assert.equal(b.sourceKind, "sql");
    assert.equal(b.sqlMode, "schema_defined");
    assert.equal(b.queryTemplate, null);
  }
});

// ----- free-form SQL gate --------------------------------------------------

test("free-form SQL: Engineer/Contributor blocked even with a valid template", async () => {
  const r = await req(`/api/assets/${AS_A}/custom-mapping`, { method: "POST", headers: jsonHeaders(TOKEN_ENG_A), body: bodyOf({
    mappings: [{
      pointName: "feedwater_flow", unit: "m3/h", dataType: "number",
      sourceKind: "sql", sourceSystemId: SQL_SYSTEM_A,
      sourcePath: "boiler_samples.feedwater_flow",
      queryTemplate: "SELECT TOP 100 ts, value, quality FROM boiler_samples WHERE point_id = :point_id AND ts > :since LIMIT 100",
      sqlMode: "free_form",
    }],
  })});
  // Engineer/Contributor lacks `integration.write` (the route's
  // preHandler) — that's the first gate. We expect 403.
  assert.equal(r.status, 403);
});

test("free-form SQL: Integration Admin holds integration.write but lacks historian.sql.raw → 403", async () => {
  const r = await req(`/api/assets/${AS_A}/custom-mapping`, { method: "POST", headers: jsonHeaders(TOKEN_INTADM_A), body: bodyOf({
    mappings: [{
      pointName: "feedwater_flow", unit: "m3/h", dataType: "number",
      sourceKind: "sql", sourceSystemId: SQL_SYSTEM_A,
      sourcePath: "boiler_samples.feedwater_flow",
      queryTemplate: "SELECT TOP 100 ts, value, quality FROM boiler_samples WHERE point_id = :point_id AND ts > :since LIMIT 100",
      sqlMode: "free_form",
    }],
  })});
  assert.equal(r.status, 403);
  assert.equal(r.body.error?.code, "forbidden");
  assert.match(r.body.error?.message || "", /historian\.sql\.raw/);
});

test("free-form SQL: Workspace Admin authors a valid template — accepted + persisted", async () => {
  const r = await req(`/api/assets/${AS_A}/custom-mapping`, { method: "POST", headers: jsonHeaders(TOKEN_WSADM_A), body: bodyOf({
    mappings: [{
      pointName: "feedwater_flow", unit: "m3/h", dataType: "number",
      sourceKind: "sql", sourceSystemId: SQL_SYSTEM_A,
      sourcePath: "boiler_samples.feedwater_flow",
      queryTemplate: "SELECT TOP 100 ts, value, quality FROM boiler_samples WHERE point_id = :point_id AND ts > :since LIMIT 100",
      sqlMode: "free_form",
    }],
  })});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.inserted, 1);
  const persisted = r.body.bindings.find(b => b.sourcePath === "boiler_samples.feedwater_flow");
  assert.ok(persisted);
  assert.equal(persisted.sqlMode, "free_form");
  assert.match(persisted.queryTemplate, /SELECT TOP 100/);
});

test("free-form SQL: validator rejects DDL even from Workspace Admin", async () => {
  const r = await req(`/api/assets/${AS_A}/custom-mapping`, { method: "POST", headers: jsonHeaders(TOKEN_WSADM_A), body: bodyOf({
    mappings: [{
      pointName: "evil", unit: null, dataType: "number",
      sourceKind: "sql", sourceSystemId: SQL_SYSTEM_A,
      sourcePath: "boiler_samples.evil",
      queryTemplate: "DROP TABLE users",
      sqlMode: "free_form",
    }],
  })});
  assert.equal(r.status, 400);
  assert.equal(r.body.error?.code, "sql_validation_failed");
});

test("free-form SQL: validator rejects INFORMATION_SCHEMA enumeration", async () => {
  const r = await req(`/api/assets/${AS_A}/custom-mapping`, { method: "POST", headers: jsonHeaders(TOKEN_WSADM_A), body: bodyOf({
    mappings: [{
      pointName: "spy", unit: null, dataType: "number",
      sourceKind: "sql", sourceSystemId: SQL_SYSTEM_A,
      sourcePath: "x.y",
      queryTemplate: "SELECT TOP 10 table_name FROM information_schema.tables WHERE table_name = :point_id LIMIT :limit",
      sqlMode: "free_form",
    }],
  })});
  assert.equal(r.status, 400);
  assert.equal(r.body.error?.code, "sql_validation_failed");
  assert.equal(r.body.error?.details?.reason, "forbidden_namespace");
});

test("free-form SQL: validator rejects unknown bind parameter", async () => {
  const r = await req(`/api/assets/${AS_A}/custom-mapping`, { method: "POST", headers: jsonHeaders(TOKEN_WSADM_A), body: bodyOf({
    mappings: [{
      pointName: "typo", unit: null, dataType: "number",
      sourceKind: "sql", sourceSystemId: SQL_SYSTEM_A,
      sourcePath: "x.y",
      queryTemplate: "SELECT TOP 10 ts, value FROM t WHERE point = :pointid LIMIT :limit",
      sqlMode: "free_form",
    }],
  })});
  assert.equal(r.status, 400);
  assert.equal(r.body.error?.code, "sql_validation_failed");
  assert.equal(r.body.error?.details?.reason, "unknown_parameter");
});

// ----- custom-mapping tenancy ----------------------------------------------

test("custom-mapping: cross-tenant system rejected (system belongs to ORG-B)", async () => {
  const r = await req(`/api/assets/${AS_A}/custom-mapping`, { method: "POST", headers: jsonHeaders(TOKEN_OWNER_A), body: bodyOf({
    mappings: [{
      pointName: "rogue", unit: null, dataType: "number",
      sourceKind: "mqtt",
      sourceSystemId: "ES-MQTT-B",
      sourcePath: "borealis/test/rogue",
    }],
  })});
  assert.equal(r.status, 404);
  assert.match(r.body.error?.message || "", /source system not found/);
});

// ----- delete + test -------------------------------------------------------

test("DELETE /api/assets/:id/bindings/:bid removes the binding + audits", async () => {
  const list = await req(`/api/assets/${AS_A}/bindings`, { headers: withAuth(TOKEN_OWNER_A) });
  const target = list.body[0];
  const r = await req(`/api/assets/${AS_A}/bindings/${target.id}`, { method: "DELETE", headers: withAuth(TOKEN_OWNER_A) });
  assert.equal(r.status, 200);
  const after = await req(`/api/assets/${AS_A}/bindings`, { headers: withAuth(TOKEN_OWNER_A) });
  assert.equal(after.body.length, list.body.length - 1);
  // Audit chain saw it.
  const { drain } = await import("../server/audit.js");
  await drain();
  const seen = db.prepare("SELECT 1 FROM audit_log WHERE action = 'binding.delete' AND subject = ? LIMIT 1").get(target.id);
  assert.ok(seen, "binding.delete audit row exists");
});

test("POST /api/asset-point-bindings/:id/test returns ok for a healthy binding", async () => {
  const list = await req(`/api/assets/${AS_A}/bindings`, { headers: withAuth(TOKEN_OWNER_A) });
  const target = list.body[0];
  const r = await req(`/api/asset-point-bindings/${target.id}/test`, { method: "POST", headers: jsonHeaders(TOKEN_OWNER_A), body: "{}" });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.bindingId, target.id);
});
