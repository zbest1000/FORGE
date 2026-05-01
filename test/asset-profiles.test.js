// Asset profile + version tests.
//
// Mirrors the bootstrap from `test/asset-hierarchy.test.js`. Two orgs
// so tenant isolation is real, plus an Engineer/Contributor login to
// exercise the integration.write capability gate.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-profiles-"));
process.env.FORGE_DATA_DIR = tmpDir;
process.env.FORGE_TENANT_KEY = "forge-profiles-test";
process.env.FORGE_JWT_SECRET = "forge-profiles-test-jwt";
process.env.FORGE_RATELIMIT_MAX = "10000";
process.env.LOG_LEVEL = "warn";

const { db } = await import("../server/db.js");
const bcrypt = (await import("bcryptjs")).default;
const ts = new Date().toISOString();

db.prepare("INSERT INTO organizations (id, name, tenant_key, created_at) VALUES (?,?,?,?)").run("ORG-A", "Atlas", "atlas", ts);
db.prepare("INSERT INTO organizations (id, name, tenant_key, created_at) VALUES (?,?,?,?)").run("ORG-B", "Borealis", "borealis", ts);
db.prepare("INSERT INTO workspaces (id, org_id, name, region, created_at) VALUES (?,?,?,?,?)").run("WS-A", "ORG-A", "North", "us-east", ts);
db.prepare("INSERT INTO workspaces (id, org_id, name, region, created_at) VALUES (?,?,?,?,?)").run("WS-B", "ORG-B", "South", "eu-west", ts);

const adminA = await bcrypt.hash("forge", 10);
const adminB = await bcrypt.hash("forge", 10);
const eng = await bcrypt.hash("forge", 10);
db.prepare("INSERT INTO users (id, org_id, email, name, role, password_hash, initials, disabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
  .run("U-ADMIN-A", "ORG-A", "admin-a@forge.local", "Admin A", "Organization Owner", adminA, "AA", 0, ts, ts);
db.prepare("INSERT INTO users (id, org_id, email, name, role, password_hash, initials, disabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
  .run("U-ADMIN-B", "ORG-B", "admin-b@forge.local", "Admin B", "Organization Owner", adminB, "AB", 0, ts, ts);
db.prepare("INSERT INTO users (id, org_id, email, name, role, password_hash, initials, disabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
  .run("U-ENG-A", "ORG-A", "eng-a@forge.local", "Engineer A", "Engineer/Contributor", eng, "EA", 0, ts, ts);

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

await app.listen({ port: 0, host: "127.0.0.1" });
const addr = app.server.address();
const base = `http://127.0.0.1:${addr.port}`;

let TOKEN_A;
let TOKEN_B;
let TOKEN_ENG;

async function req(p, opts = {}) {
  const r = await fetch(base + p, opts);
  const ct = r.headers.get("content-type") || "";
  const body = ct.includes("application/json") ? await r.json() : await r.text();
  return { status: r.status, body, headers: r.headers };
}
function withAuth(token) { return { authorization: `Bearer ${token}` }; }
function jsonHeaders(token) { return { ...withAuth(token), "content-type": "application/json" }; }
function bodyOf(obj) { return JSON.stringify(obj); }

test.after(async () => { await app.close(); });

test("login both tenants + engineer", async () => {
  const a = await req("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: bodyOf({ email: "admin-a@forge.local", password: "forge" }) });
  TOKEN_A = a.body.token;
  const b = await req("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: bodyOf({ email: "admin-b@forge.local", password: "forge" }) });
  TOKEN_B = b.body.token;
  const e = await req("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: bodyOf({ email: "eng-a@forge.local", password: "forge" }) });
  TOKEN_ENG = e.body.token;
  assert.ok(TOKEN_A && TOKEN_B && TOKEN_ENG);
});

test("create profile with N points → version 1 + latest_version_id wired", async () => {
  const r = await req("/api/asset-profiles", { method: "POST", headers: jsonHeaders(TOKEN_A), body: bodyOf({
    name: "Pump Profile",
    description: "Standard centrifugal pump",
    sourceKind: "mqtt",
    sourceTemplate: { topic_template: "forge/{enterprise}/{site}/{asset}/{point}", qos: 1 },
    points: [
      { name: "temperature", unit: "C", dataType: "number", sourcePathTemplate: "{enterprise}/{site}/{asset}/temperature" },
      { name: "pressure",    unit: "bar", dataType: "number", sourcePathTemplate: "{enterprise}/{site}/{asset}/pressure" },
      { name: "vibration",   unit: "mm/s", dataType: "number", sourcePathTemplate: "{enterprise}/{site}/{asset}/vibration" },
    ],
  })});
  assert.equal(r.status, 200);
  assert.equal(r.body.name, "Pump Profile");
  assert.equal(r.body.sourceKind, "mqtt");
  assert.equal(r.body.status, "active");
  assert.ok(r.body.id.startsWith("PROF-"));
  assert.ok(r.body.latestVersion);
  assert.equal(r.body.latestVersion.version, 1);
  assert.equal(r.body.points.length, 3);
  assert.equal(r.body.points.find(p => p.name === "temperature").unit, "C");
});

test("listing returns versionCount and bindingCount", async () => {
  const list = await req("/api/asset-profiles", { headers: withAuth(TOKEN_A) });
  assert.equal(list.status, 200);
  const p = list.body.find(x => x.name === "Pump Profile");
  assert.ok(p);
  assert.equal(p.versionCount, 1);
  assert.equal(p.bindingCount, 0);
});

test("filter by sourceKind", async () => {
  await req("/api/asset-profiles", { method: "POST", headers: jsonHeaders(TOKEN_A), body: bodyOf({
    name: "OPC UA pump", sourceKind: "opcua", sourceTemplate: { node_template: "ns=2;s={asset}.{point}" },
    points: [{ name: "rpm", unit: "rpm", sourcePathTemplate: "{asset}.rpm" }],
  })});
  const mqttOnly = await req("/api/asset-profiles?sourceKind=mqtt", { headers: withAuth(TOKEN_A) });
  assert.ok(mqttOnly.body.every(p => p.sourceKind === "mqtt"));
  const opcuaOnly = await req("/api/asset-profiles?sourceKind=opcua", { headers: withAuth(TOKEN_A) });
  assert.ok(opcuaOnly.body.every(p => p.sourceKind === "opcua"));
});

test("create new version increments and points belong to it", async () => {
  const list = await req("/api/asset-profiles", { headers: withAuth(TOKEN_A) });
  const profileId = list.body.find(p => p.name === "Pump Profile").id;
  const r = await req(`/api/asset-profiles/${profileId}/versions`, { method: "POST", headers: jsonHeaders(TOKEN_A), body: bodyOf({
    sourceTemplate: { topic_template: "forge/v2/{enterprise}/{site}/{asset}/{point}", qos: 1 },
    points: [
      { name: "temperature",  unit: "C",   dataType: "number", sourcePathTemplate: "{enterprise}/{site}/{asset}/temperature" },
      { name: "pressure",     unit: "bar", dataType: "number", sourcePathTemplate: "{enterprise}/{site}/{asset}/pressure" },
      { name: "vibration",    unit: "mm/s",dataType: "number", sourcePathTemplate: "{enterprise}/{site}/{asset}/vibration" },
      { name: "outlet_temp",  unit: "C",   dataType: "number", sourcePathTemplate: "{enterprise}/{site}/{asset}/outlet_temp" },
    ],
    notes: "added outlet temp",
  })});
  assert.equal(r.status, 200);
  assert.equal(r.body.version.version, 2);
  assert.equal(r.body.points.length, 4);
  assert.equal(r.body.profile.latestVersionId, r.body.version.id);

  const versions = await req(`/api/asset-profiles/${profileId}/versions`, { headers: withAuth(TOKEN_A) });
  assert.equal(versions.body.length, 2);
  assert.equal(versions.body[0].version, 2); // sorted DESC
  assert.equal(versions.body[1].version, 1);
});

test("PATCH only updates metadata; versioned content untouched", async () => {
  const list = await req("/api/asset-profiles", { headers: withAuth(TOKEN_A) });
  const p = list.body.find(x => x.name === "Pump Profile");
  const get = await req(`/api/asset-profiles/${p.id}`, { headers: withAuth(TOKEN_A) });
  const etag = get.headers.get("etag");
  const r = await req(`/api/asset-profiles/${p.id}`, { method: "PATCH", headers: { ...jsonHeaders(TOKEN_A), "if-match": etag }, body: bodyOf({ description: "updated desc" }) });
  assert.equal(r.status, 200);
  assert.equal(r.body.description, "updated desc");
  // Sanity: latest version pointer + point count unchanged.
  const after = await req(`/api/asset-profiles/${p.id}`, { headers: withAuth(TOKEN_A) });
  assert.equal(after.body.points.length, 4);
});

test("integration.write capability gate blocks Engineer/Contributor", async () => {
  const r = await req("/api/asset-profiles", { method: "POST", headers: jsonHeaders(TOKEN_ENG), body: bodyOf({
    name: "Eng tries", sourceKind: "mqtt", sourceTemplate: {}, points: [],
  })});
  assert.equal(r.status, 403);
  // Read works (the `view` capability is broader).
  const list = await req("/api/asset-profiles", { headers: withAuth(TOKEN_ENG) });
  assert.equal(list.status, 200);
});

test("invalid sourceKind rejected by schema", async () => {
  const r = await req("/api/asset-profiles", { method: "POST", headers: jsonHeaders(TOKEN_A), body: bodyOf({
    name: "Bad kind", sourceKind: "kafka", sourceTemplate: {}, points: [],
  })});
  assert.equal(r.status, 400);
});

test("DELETE returns 409 when bindings exist on any version", async () => {
  // Create a fresh profile, seed a binding referencing its latest
  // version, then attempt DELETE.
  const created = await req("/api/asset-profiles", { method: "POST", headers: jsonHeaders(TOKEN_A), body: bodyOf({
    name: "Has bindings", sourceKind: "mqtt", sourceTemplate: {},
    points: [{ name: "temp", sourcePathTemplate: "{asset}/temp" }],
  })});
  const versionId = created.body.latestVersion.id;
  const e = await req("/api/enterprises", { method: "POST", headers: jsonHeaders(TOKEN_A), body: bodyOf({ name: "Site for binding" }) });
  const a = await req("/api/assets", { method: "POST", headers: jsonHeaders(TOKEN_A), body: bodyOf({ name: "BindingHost", enterpriseId: e.body.id }) });
  db.prepare(`INSERT INTO asset_point_bindings
    (id, org_id, asset_id, profile_version_id, profile_point_id, point_id, system_id,
     source_kind, source_path, template_vars, enabled, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run("APB-PROF-DEL-1", "ORG-A", a.body.id, versionId, null, null, null,
         "mqtt", "x/y/z/temp", "{}", 1, ts, ts);

  const del = await req(`/api/asset-profiles/${created.body.id}`, { method: "DELETE", headers: withAuth(TOKEN_A) });
  assert.equal(del.status, 409);
  // Unified error envelope: details.bindingCount carries the cascade impact.
  assert.equal(del.body.error?.code, "profile_in_use");
  assert.equal(del.body.error?.details?.bindingCount, 1);

  // After clearing the binding, DELETE succeeds.
  db.prepare("DELETE FROM asset_point_bindings WHERE id = ?").run("APB-PROF-DEL-1");
  const del2 = await req(`/api/asset-profiles/${created.body.id}`, { method: "DELETE", headers: withAuth(TOKEN_A) });
  assert.equal(del2.status, 200);
});

test("PATCH status='archived' soft-archives without deletion; new versions blocked", async () => {
  const created = await req("/api/asset-profiles", { method: "POST", headers: jsonHeaders(TOKEN_A), body: bodyOf({
    name: "Archivable", sourceKind: "mqtt", sourceTemplate: {},
    points: [{ name: "temp", sourcePathTemplate: "{asset}/temp" }],
  })});
  const get = await req(`/api/asset-profiles/${created.body.id}`, { headers: withAuth(TOKEN_A) });
  const etag = get.headers.get("etag");
  const r = await req(`/api/asset-profiles/${created.body.id}`, { method: "PATCH", headers: { ...jsonHeaders(TOKEN_A), "if-match": etag }, body: bodyOf({ status: "archived" }) });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, "archived");
  // Adding a new version on an archived profile is rejected.
  const v = await req(`/api/asset-profiles/${created.body.id}/versions`, { method: "POST", headers: jsonHeaders(TOKEN_A), body: bodyOf({
    sourceTemplate: {}, points: [{ name: "x", sourcePathTemplate: "x" }],
  })});
  assert.equal(v.status, 409);
});

test("library scope (workspaceId=null) is visible to all workspaces in the org", async () => {
  const r = await req("/api/asset-profiles", { method: "POST", headers: jsonHeaders(TOKEN_A), body: bodyOf({
    name: "Lib profile", sourceKind: "mqtt", sourceTemplate: {}, workspaceId: null,
    points: [{ name: "temp", sourcePathTemplate: "{asset}/temp" }],
  })});
  assert.equal(r.status, 200);
  assert.equal(r.body.workspaceId, null);
  // Filter by scope=library should include it.
  const lib = await req("/api/asset-profiles?scope=library", { headers: withAuth(TOKEN_A) });
  assert.ok(lib.body.find(p => p.id === r.body.id));
});

test("tenant isolation: ORG-B sees no profiles from ORG-A", async () => {
  const list = await req("/api/asset-profiles", { headers: withAuth(TOKEN_B) });
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 0);
  // Direct GET on ORG-A's profile from ORG-B is 404 (not 403, to avoid
  // leaking existence).
  const aList = await req("/api/asset-profiles", { headers: withAuth(TOKEN_A) });
  const target = aList.body[0].id;
  const get = await req(`/api/asset-profiles/${target}`, { headers: withAuth(TOKEN_B) });
  assert.equal(get.status, 404);
});
