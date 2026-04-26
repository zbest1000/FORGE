// End-to-end route tests: auth, work-items CRUD, revision transition cascade,
// file upload/download, API token create/revoke.
//
// Starts Fastify in-process on a random port, seeds a fresh DB, runs HTTP
// calls via fetch(), and asserts behaviour.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Fresh DB per run.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-routes-"));
process.env.FORGE_DATA_DIR = tmpDir;
process.env.FORGE_TENANT_KEY = "forge-routes-test";
process.env.FORGE_JWT_SECRET = "forge-routes-test-jwt";
process.env.FORGE_RATELIMIT_MAX = "10000";
process.env.LOG_LEVEL = "warn";

// Importing db triggers migrations.
const { db } = await import("../server/db.js");

// Minimal seed: org, workspace, admin user, one document+revision, one project+WI.
const bcrypt = (await import("bcryptjs")).default;
const now = new Date().toISOString();
db.prepare("INSERT INTO organizations (id, name, tenant_key, created_at) VALUES ('ORG-1','Atlas','atlas',?)").run(now);
db.prepare("INSERT INTO workspaces (id, org_id, name, region, created_at) VALUES ('WS-1','ORG-1','North Plant','us-east',?)").run(now);
db.prepare("INSERT INTO users (id, org_id, email, name, role, password_hash, initials, disabled, created_at, updated_at) VALUES ('U-ADMIN','ORG-1','admin@forge.local','Admin','Organization Owner',?,'AD',0,?,?)")
  .run(await bcrypt.hash("forge", 10), now, now);
db.prepare("INSERT INTO users (id, org_id, email, name, role, password_hash, initials, disabled, created_at, updated_at) VALUES ('U-ENG','ORG-1','eng@forge.local','Engineer','Engineer/Contributor',?,'EN',0,?,?)")
  .run(await bcrypt.hash("forge", 10), now, now);
db.prepare("INSERT INTO team_spaces (id, org_id, workspace_id, name, summary, status, acl, labels, created_at, updated_at) VALUES ('TS-1','ORG-1','WS-1','Engineering','',?,'{}','[]',?,?)")
  .run("active", now, now);
db.prepare("INSERT INTO projects (id, team_space_id, name, status, milestones, acl, labels, created_at, updated_at) VALUES ('PRJ-1','TS-1','Project 1','active','[]','{}','[]',?,?)").run(now, now);
db.prepare("INSERT INTO documents (id, team_space_id, project_id, name, discipline, current_revision_id, sensitivity, acl, labels, created_at, updated_at) VALUES ('DOC-1','TS-1','PRJ-1','Doc 1','Controls',NULL,'internal','{}','[]',?,?)").run(now, now);
db.prepare("INSERT INTO revisions (id, doc_id, label, status, summary, notes, created_at, updated_at) VALUES ('REV-1','DOC-1','A','IFR','initial','',?,?)").run(now, now);
db.prepare("INSERT INTO work_items (id, project_id, type, title, assignee_id, status, severity, blockers, labels, acl, created_at, updated_at) VALUES ('WI-1','PRJ-1','Task','First','U-ADMIN','Open','medium','[]','[]','{}',?,?)").run(now, now);
db.prepare("INSERT INTO work_items (id, project_id, type, title, assignee_id, status, severity, blockers, labels, acl, created_at, updated_at) VALUES ('WI-SECRET','PRJ-1','Task','Secret','U-ADMIN','Open','high','[]','[]',?, ?, ?)")
  .run(JSON.stringify({ roles: ["Reviewer/Approver"], users: [], abac: {} }), now, now);
db.prepare("INSERT INTO channels (id, team_space_id, name, kind, acl, created_at, updated_at) VALUES ('CH-1','TS-1','general','team','{}',?,?)").run(now, now);
db.prepare("INSERT INTO assets (id, org_id, workspace_id, name, type, hierarchy, status, mqtt_topics, opcua_nodes, doc_ids, acl, labels, created_at, updated_at) VALUES ('AS-1','ORG-1','WS-1','Feeder A1','motor','North Plant > Line A > Feeder A1','normal','[]','[]','[]','{}','[]',?,?)").run(now, now);
db.prepare("INSERT INTO integrations (id, name, kind, status, last_event, events_per_min, config) VALUES ('INT-MODBUS','Modbus TCP','modbus','connected',?,0,'{}')").run(now);
db.prepare("INSERT INTO data_sources (id, integration_id, endpoint, asset_id, kind, unit, sampling, qos, retain) VALUES ('DS-1','INT-MODBUS','10.0.0.5:502/unit/1/hr/40001','AS-1','modbus_register','A','1s',1,0)").run();

// Boot fastify in-process.
const { default: Fastify } = await import("fastify");
const { default: jwt } = await import("@fastify/jwt");
const { default: cors } = await import("@fastify/cors");
const { default: multipart } = await import("@fastify/multipart");
const { userById } = await import("../server/auth.js");
const { resolveToken } = await import("../server/tokens.js");

const app = Fastify({ logger: false });
await app.register(cors, { origin: true });
await app.register(jwt, { secret: process.env.FORGE_JWT_SECRET });
await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });

app.addHook("onRequest", async (req) => {
  const h = req.headers.authorization || "";
  const tok = h.startsWith("Bearer ") ? h.slice(7) : null;
  req.user = null;
  if (!tok) return;
  if (tok.startsWith("fgt_")) { const r = resolveToken(tok, userById); req.user = r?.user || null; return; }
  try { const d = app.jwt.verify(tok); req.user = d?.sub ? userById(d.sub) : null; } catch {}
});

await app.register((await import("../server/routes/auth.js")).default);
await app.register((await import("../server/routes/core.js")).default);
await app.register((await import("../server/routes/operations.js")).default);
await app.register((await import("../server/routes/files.js")).default);
await app.register((await import("../server/routes/tokens.js")).default);

await app.listen({ port: 0, host: "127.0.0.1" });
const addr = app.server.address();
const base = `http://127.0.0.1:${addr.port}`;

async function req(path, opts = {}) {
  const r = await fetch(base + path, opts);
  const ct = r.headers.get("content-type") || "";
  const body = ct.includes("application/json") ? await r.json() : await r.text();
  return { status: r.status, body, headers: r.headers };
}
let TOKEN;
let ENG_TOKEN;

test.after(async () => { await app.close(); });

test("login returns JWT + /api/me resolves it", async () => {
  const login = await req("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "admin@forge.local", password: "forge" }) });
  assert.equal(login.status, 200);
  assert.ok(login.body.token);
  TOKEN = login.body.token;
  const me = await req("/api/me", { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(me.status, 200);
  assert.equal(me.body.user.email, "admin@forge.local");
  assert.deepEqual(me.body.capabilities, ["*"]);
});

test("login returns non-owner token for ACL regression checks", async () => {
  const login = await req("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "eng@forge.local", password: "forge" }) });
  assert.equal(login.status, 200);
  ENG_TOKEN = login.body.token;
});

test("login with bad password is rejected", async () => {
  const r = await req("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "admin@forge.local", password: "wrong" }) });
  assert.equal(r.status, 401);
});

test("tenant data endpoints require auth and filter object ACLs", async () => {
  const anon = await req("/api/work-items?projectId=PRJ-1");
  assert.equal(anon.status, 401);

  const engList = await req("/api/work-items?projectId=PRJ-1", { headers: { authorization: `Bearer ${ENG_TOKEN}` } });
  assert.equal(engList.status, 200);
  assert.ok(engList.body.find(w => w.id === "WI-1"));
  assert.equal(engList.body.some(w => w.id === "WI-SECRET"), false);

  const adminList = await req("/api/work-items?projectId=PRJ-1", { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(adminList.status, 200);
  assert.ok(adminList.body.find(w => w.id === "WI-SECRET"));

  const deniedPatch = await req("/api/work-items/WI-SECRET", { method: "PATCH", headers: { authorization: `Bearer ${ENG_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ status: "In Review" }) });
  assert.equal(deniedPatch.status, 403);
});

test("CRUD on work items (create, patch, list)", async () => {
  const create = await req("/api/work-items", { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ projectId: "PRJ-1", title: "test WI", severity: "high" }) });
  assert.equal(create.status, 200);
  const id = create.body.id;
  assert.ok(id);

  const patched = await req(`/api/work-items/${id}`, { method: "PATCH", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ status: "In Review" }) });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.status, "In Review");

  const list = await req("/api/work-items?projectId=PRJ-1", { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(list.status, 200);
  assert.ok(list.body.find(w => w.id === id));
});

test("revision transition cascades IFR → Approved → IFC with auto-supersede", async () => {
  const t1 = await req("/api/revisions/REV-1/transition", { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ to: "Approved" }) });
  assert.equal(t1.status, 200);
  assert.equal(t1.body.status, "Approved");

  const t2 = await req("/api/revisions/REV-1/transition", { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ to: "IFC" }) });
  assert.equal(t2.status, 200);
  assert.equal(t2.body.status, "IFC");

  const doc = await req("/api/documents/DOC-1", { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(doc.body.current_revision_id, "REV-1");

  const badJump = await req("/api/revisions/REV-1/transition", { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ to: "Draft" }) });
  assert.equal(badJump.status, 400); // IFC → Draft not allowed
});

test("file upload/download round-trip with SHA-256", async () => {
  const blob = new Blob(["forge test payload " + Math.random()], { type: "text/plain" });
  const fd = new FormData();
  fd.append("parent_kind", "document");
  fd.append("parent_id", "DOC-1");
  fd.append("file", blob, "payload.txt");
  const up = await fetch(base + "/api/files", { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: fd });
  assert.equal(up.status, 200);
  const meta = await up.json();
  assert.ok(meta.sha256 && meta.sha256.length === 64);

  const down = await fetch(base + "/api/files/" + meta.id, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(down.status, 200);
  assert.equal(down.headers.get("x-content-sha256"), meta.sha256);
  const text = await down.text();
  assert.ok(text.startsWith("forge test payload"));
});

test("API token issuance, use, and revoke", async () => {
  const create = await req("/api/tokens", { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ name: "test", scopes: ["view"] }) });
  assert.equal(create.status, 200);
  const plain = create.body.token;
  assert.ok(plain.startsWith("fgt_"));

  const me = await req("/api/me", { headers: { authorization: `Bearer ${plain}` } });
  assert.equal(me.status, 200);

  const revoke = await req(`/api/tokens/${create.body.id}`, { method: "DELETE", headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(revoke.status, 200);

  const me2 = await req("/api/me", { headers: { authorization: `Bearer ${plain}` } });
  assert.equal(me2.status, 401);
});

test("historian points store samples and return trend summaries", async () => {
  const point = await req("/api/historian/points", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ assetId: "AS-1", sourceId: "DS-1", tag: "NP.LINEA.FEEDER_A1.CURRENT", name: "Feeder A1 current", unit: "A" }),
  });
  assert.equal(point.status, 200);
  assert.equal(point.body.asset_id, "AS-1");

  const first = await req("/api/historian/samples", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ pointId: point.body.id, ts: "2026-04-26T00:00:00.000Z", value: 40.5, quality: "Good" }),
  });
  assert.equal(first.status, 200);
  const second = await req("/api/historian/samples", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ tag: "NP.LINEA.FEEDER_A1.CURRENT", ts: "2026-04-26T00:05:00.000Z", value: 43.5, quality: "Good" }),
  });
  assert.equal(second.status, 200);

  const trend = await req(`/api/historian/trends?assetId=AS-1&since=2026-04-25T00:00:00.000Z`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(trend.status, 200);
  assert.equal(trend.body.series[0].summary.count, 2);
  assert.equal(trend.body.series[0].summary.avg, 42);
});

test("historian adapters expose configured backends and cache external points locally", async () => {
  const backends = await req("/api/historian/backends", { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(backends.status, 200);
  assert.ok(backends.body.backends.find(b => b.name === "sqlite" && b.configured));
  assert.ok(backends.body.backends.find(b => b.name === "influxdb" && b.configured === false));
  assert.ok(backends.body.backends.find(b => b.name === "timebase" && b.configured === false));
  assert.ok(backends.body.backends.find(b => b.name === "mssql" && b.configured === false));

  const point = await req("/api/historian/points", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ assetId: "AS-1", tag: "NP.LINEA.FEEDER_A1.INFLUX_READY", name: "Influx-ready current", unit: "A", historian: "influxdb" }),
  });
  assert.equal(point.status, 200);
  assert.equal(point.body.historian, "influxdb");

  const sample = await req("/api/historian/samples", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ pointId: point.body.id, ts: "2026-04-26T01:00:00.000Z", value: 51.5 }),
  });
  assert.equal(sample.status, 200);
  assert.equal(sample.body.backend.backend, "influxdb");
  assert.equal(sample.body.backend.written, false);
  assert.equal(sample.body.backend.reason, "not_configured");
  assert.equal(sample.body.backend.cached, true);

  const cached = await req(`/api/historian/samples?pointId=${point.body.id}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(cached.status, 200);
  assert.equal(cached.body.backend, "sqlite");
  assert.equal(cached.body.fallbackFrom, "influxdb");
  assert.equal(cached.body.samples[0].value, 51.5);
});

test("recipes create versions and activate an approved version", async () => {
  const recipe = await req("/api/recipes", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ assetId: "AS-1", name: "Feeder startup", parameters: { rampRateHzPerSec: 1.1 }, notes: "initial" }),
  });
  assert.equal(recipe.status, 200);
  assert.equal(recipe.body.versions.length, 1);

  const versioned = await req(`/api/recipes/${recipe.body.id}/versions`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ parameters: { rampRateHzPerSec: 0.9 }, notes: "lower ramp from trend" }),
  });
  assert.equal(versioned.status, 200);
  assert.equal(versioned.body.versions[0].version, 2);

  const activated = await req(`/api/recipes/${recipe.body.id}/activate`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ versionId: versioned.body.current_version_id }),
  });
  assert.equal(activated.status, 200);
  assert.equal(activated.body.status, "active");
  assert.equal(activated.body.versions.find(v => v.id === activated.body.current_version_id).state, "active");
});

test("Modbus register reads update register state and append historian samples", async () => {
  const point = await req("/api/historian/points", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ assetId: "AS-1", tag: "NP.LINEA.FEEDER_A1.MODBUS_CURRENT", name: "Modbus current", unit: "A" }),
  });
  assert.equal(point.status, 200);
  const device = await req("/api/modbus/devices", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "PLC-A1", host: "10.0.0.5", unitId: 1 }),
  });
  assert.equal(device.status, 200);
  const register = await req("/api/modbus/registers", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ deviceId: device.body.id, assetId: "AS-1", pointId: point.body.id, name: "Current", address: 40001, scale: 0.1, unit: "A" }),
  });
  assert.equal(register.status, 200);

  const read = await req(`/api/modbus/registers/${register.body.id}/read`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ rawValue: 462, ts: "2026-04-26T00:10:00.000Z" }),
  });
  assert.equal(read.status, 200);
  assert.equal(read.body.last_value, 46.2);

  const samples = await req(`/api/historian/samples?pointId=${point.body.id}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(samples.status, 200);
  assert.equal(samples.body.samples.length, 1);
  assert.equal(samples.body.samples[0].source_type, "modbus_tcp");
});
