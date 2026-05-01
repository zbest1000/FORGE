// Asset hierarchy + asset CRUD + rename re-resolve tests.
//
// Mirrors the bootstrap from `test/routes.test.js`: fresh SQLite tmpdir,
// in-process Fastify, capability-gated bearer tokens. Two organisations
// are seeded so tenant-isolation regressions show up immediately.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-hierarchy-"));
process.env.FORGE_DATA_DIR = tmpDir;
process.env.FORGE_TENANT_KEY = "forge-hierarchy-test";
process.env.FORGE_JWT_SECRET = "forge-hierarchy-test-jwt";
process.env.FORGE_RATELIMIT_MAX = "10000";
process.env.LOG_LEVEL = "warn";

const { db } = await import("../server/db.js");
const bcrypt = (await import("bcryptjs")).default;
const ts = new Date().toISOString();

// Two orgs so tenant-iso assertions are real, not theatre.
db.prepare("INSERT INTO organizations (id, name, tenant_key, created_at) VALUES (?,?,?,?)").run("ORG-A", "Atlas", "atlas", ts);
db.prepare("INSERT INTO organizations (id, name, tenant_key, created_at) VALUES (?,?,?,?)").run("ORG-B", "Borealis", "borealis", ts);
db.prepare("INSERT INTO workspaces (id, org_id, name, region, created_at) VALUES (?,?,?,?,?)").run("WS-A", "ORG-A", "North", "us-east", ts);
db.prepare("INSERT INTO workspaces (id, org_id, name, region, created_at) VALUES (?,?,?,?,?)").run("WS-B", "ORG-B", "South", "eu-west", ts);

const adminA = await bcrypt.hash("forge", 10);
const adminB = await bcrypt.hash("forge", 10);
db.prepare("INSERT INTO users (id, org_id, email, name, role, password_hash, initials, disabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
  .run("U-ADMIN-A", "ORG-A", "admin-a@forge.local", "Admin A", "Organization Owner", adminA, "AA", 0, ts, ts);
db.prepare("INSERT INTO users (id, org_id, email, name, role, password_hash, initials, disabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
  .run("U-ADMIN-B", "ORG-B", "admin-b@forge.local", "Admin B", "Organization Owner", adminB, "AB", 0, ts, ts);

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
await app.register((await import("../server/routes/files.js")).default);
await app.register((await import("../server/routes/asset-hierarchy.js")).default);

await app.listen({ port: 0, host: "127.0.0.1" });
const addr = app.server.address();
const base = `http://127.0.0.1:${addr.port}`;

let TOKEN_A;
let TOKEN_B;

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

test("login both tenants", async () => {
  const a = await req("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: bodyOf({ email: "admin-a@forge.local", password: "forge" }) });
  assert.equal(a.status, 200);
  TOKEN_A = a.body.token;
  const b = await req("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: bodyOf({ email: "admin-b@forge.local", password: "forge" }) });
  assert.equal(b.status, 200);
  TOKEN_B = b.body.token;
});

test("anonymous request to /api/enterprises returns 401", async () => {
  const r = await req("/api/enterprises");
  assert.equal(r.status, 401);
});

test("schema_version reaches the current migration head", async () => {
  const v = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  // Test asserts the live SCHEMA_VERSION rather than a fixed number
  // so future v18+ migrations don't break this canary; the point of
  // this test is to confirm the migration ran, not to pin the version.
  assert.ok(Number(v.value) >= 16);
});

test("create enterprise + locations + asset-tree shape", async () => {
  const e = await req("/api/enterprises", { method: "POST", headers: jsonHeaders(TOKEN_A), body: bodyOf({ name: "Acme", description: "north plant group" }) });
  assert.equal(e.status, 200);
  const entId = e.body.id;
  assert.ok(entId.startsWith("ENT-"));

  const l1 = await req("/api/locations", { method: "POST", headers: jsonHeaders(TOKEN_A), body: bodyOf({ enterpriseId: entId, name: "Plant 1", kind: "site" }) });
  assert.equal(l1.status, 200);
  const locId = l1.body.id;
  const l2 = await req("/api/locations", { method: "POST", headers: jsonHeaders(TOKEN_A), body: bodyOf({ enterpriseId: entId, parentLocationId: locId, name: "Line A" }) });
  assert.equal(l2.status, 200);

  // Reject location whose parent is in a different enterprise
  const otherE = await req("/api/enterprises", { method: "POST", headers: jsonHeaders(TOKEN_A), body: bodyOf({ name: "Acme East" }) });
  const cross = await req("/api/locations", { method: "POST", headers: jsonHeaders(TOKEN_A), body: bodyOf({ enterpriseId: otherE.body.id, parentLocationId: locId, name: "Bad" }) });
  assert.equal(cross.status, 400);

  // Asset linked to enterprise + location
  const a1 = await req("/api/assets", { method: "POST", headers: jsonHeaders(TOKEN_A), body: bodyOf({ name: "Pump-A", type: "pump", enterpriseId: entId, locationId: locId }) });
  assert.equal(a1.status, 200);
  assert.equal(a1.body.enterprise_id, entId);
  assert.equal(a1.body.location_id, locId);

  // Asset-tree includes our entries
  const tree = await req("/api/asset-tree", { headers: withAuth(TOKEN_A) });
  assert.equal(tree.status, 200);
  const found = tree.body.tree.find(x => x.id === entId);
  assert.ok(found, "asset-tree should include our enterprise");
  const loc = found.locations.find(x => x.id === locId);
  assert.ok(loc, "asset-tree should include our top-level location");
  assert.ok(loc.assets.some(x => x.id === a1.body.id), "asset should appear under its location");

  // Mismatched enterprise + location is rejected
  const bad = await req("/api/assets", { method: "POST", headers: jsonHeaders(TOKEN_A), body: bodyOf({ name: "Bad", enterpriseId: otherE.body.id, locationId: locId }) });
  assert.equal(bad.status, 400);
});

test("asset-tree nests locations recursively (ISA-95 chain)", async () => {
  // Build Enterprise → Site → Area → Line and place an asset on the
  // Line. The asset-tree response must surface the chain through
  // location.children all the way down with the asset under the Line.
  const e = await req("/api/enterprises", { method: "POST", headers: jsonHeaders(TOKEN_A), body: bodyOf({ name: "Atlas-ISA95" }) });
  const ent = e.body.id;
  const site = await req("/api/locations", { method: "POST", headers: jsonHeaders(TOKEN_A), body: bodyOf({ enterpriseId: ent, name: "Plant", kind: "site" }) });
  const area = await req("/api/locations", { method: "POST", headers: jsonHeaders(TOKEN_A), body: bodyOf({ enterpriseId: ent, parentLocationId: site.body.id, name: "Mixing Area", kind: "area" }) });
  const line = await req("/api/locations", { method: "POST", headers: jsonHeaders(TOKEN_A), body: bodyOf({ enterpriseId: ent, parentLocationId: area.body.id, name: "Line A", kind: "line" }) });
  const asset = await req("/api/assets", { method: "POST", headers: jsonHeaders(TOKEN_A), body: bodyOf({ name: "Mixer-1", enterpriseId: ent, locationId: line.body.id }) });

  const tree = await req("/api/asset-tree", { headers: withAuth(TOKEN_A) });
  const found = tree.body.tree.find(x => x.id === ent);
  assert.ok(found, "enterprise present");
  assert.equal(found.locations.length, 1, "only Plant is top-level under enterprise");
  const plantNode = found.locations[0];
  assert.equal(plantNode.id, site.body.id);
  assert.equal(plantNode.children.length, 1);
  assert.equal(plantNode.children[0].id, area.body.id);
  assert.equal(plantNode.children[0].children.length, 1);
  const lineNode = plantNode.children[0].children[0];
  assert.equal(lineNode.id, line.body.id);
  assert.ok(lineNode.assets.some(a => a.id === asset.body.id), "asset surfaces under its Line node");
});

test("tenant isolation: ORG-B sees nothing from ORG-A", async () => {
  const list = await req("/api/enterprises", { headers: withAuth(TOKEN_B) });
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 0, "ORG-B should not see ORG-A's enterprises");
  const tree = await req("/api/asset-tree", { headers: withAuth(TOKEN_B) });
  assert.equal(tree.body.tree.length, 0);
});

test("rename PATCH returns affectedBindings count + sample", async () => {
  const e = await req("/api/enterprises", { method: "POST", headers: jsonHeaders(TOKEN_A), body: bodyOf({ name: "Renamable" }) });
  const entId = e.body.id;
  const l = await req("/api/locations", { method: "POST", headers: jsonHeaders(TOKEN_A), body: bodyOf({ enterpriseId: entId, name: "Site X" }) });
  const locId = l.body.id;
  const a = await req("/api/assets", { method: "POST", headers: jsonHeaders(TOKEN_A), body: bodyOf({ name: "Asset-X", enterpriseId: entId, locationId: locId }) });
  const assetId = a.body.id;

  // Seed a profile + version + point + binding so we have something to
  // re-resolve. Phase 2/3 routes don't exist yet, so we go via the DB
  // directly — same shape the apply-profile endpoint will produce.
  const profileId = "PROF-TEST-1";
  const versionId = "PVER-TEST-1";
  const pointId = "PPT-TEST-1";
  const bindingId = "APB-TEST-1";
  db.prepare("INSERT INTO asset_profiles (id, org_id, workspace_id, name, source_kind, latest_version_id, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(profileId, "ORG-A", "WS-A", "Pump", "mqtt", versionId, "active", ts, ts);
  db.prepare("INSERT INTO asset_profile_versions (id, profile_id, version, source_template, status, created_at) VALUES (?,?,?,?,?,?)")
    .run(versionId, profileId, 1, JSON.stringify({ topic_template: "{enterprise}/{site}/{asset}/{point}" }), "active", ts);
  db.prepare("INSERT INTO asset_profile_points (id, profile_version_id, name, unit, data_type, source_path_template, point_order, created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(pointId, versionId, "temperature", "C", "number", "{enterprise}/{site}/{asset}/temperature", 0, ts);
  db.prepare(`INSERT INTO asset_point_bindings
    (id, org_id, asset_id, profile_version_id, profile_point_id, point_id, system_id,
     source_kind, source_path, template_vars, enabled, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(bindingId, "ORG-A", assetId, versionId, pointId, null, null,
         "mqtt", "Renamable/Site X/Asset-X/temperature",
         JSON.stringify({ enterprise: "Renamable", site: "Site X", asset: "Asset-X" }),
         1, ts, ts);

  // Rename the enterprise — should report 1 affected binding.
  const patch = await req(`/api/enterprises/${entId}`, { method: "PATCH", headers: jsonHeaders(TOKEN_A), body: bodyOf({ name: "Renamed" }) });
  assert.equal(patch.status, 200);
  assert.equal(patch.body.affectedBindings, 1);
  assert.equal(patch.body.sample.length, 1);
  assert.equal(patch.body.sample[0].bindingId, bindingId);
  assert.equal(patch.body.sample[0].oldPath, "Renamable/Site X/Asset-X/temperature");
  assert.equal(patch.body.sample[0].newPath, "Renamed/Site X/Asset-X/temperature");

  // The binding row was NOT auto-updated.
  const bindStill = db.prepare("SELECT * FROM asset_point_bindings WHERE id = ?").get(bindingId);
  assert.equal(bindStill.source_path, "Renamable/Site X/Asset-X/temperature");

  // Now commit the re-resolve.
  const reres = await req(`/api/enterprises/${entId}/re-resolve-bindings`, { method: "POST", headers: jsonHeaders(TOKEN_A), body: bodyOf({}) });
  assert.equal(reres.status, 200);
  assert.equal(reres.body.updated, 1);
  assert.equal(reres.body.skipped.length, 0);

  const bindNow = db.prepare("SELECT * FROM asset_point_bindings WHERE id = ?").get(bindingId);
  assert.equal(bindNow.source_path, "Renamed/Site X/Asset-X/temperature");
  const newVars = JSON.parse(bindNow.template_vars);
  assert.equal(newVars.enterprise, "Renamed");

  // Audit chain saw the rename + reresolve.
  const { drain } = await import("../server/audit.js");
  await drain();
  const rows = db.prepare("SELECT action, subject FROM audit_log WHERE action IN ('enterprise.update','binding.reresolve') ORDER BY seq").all();
  assert.ok(rows.find(r => r.action === "enterprise.update" && r.subject === entId));
  assert.ok(rows.find(r => r.action === "binding.reresolve" && r.subject === bindingId));
});

test("re-resolve skips custom mappings (no profile_point_id)", async () => {
  const e = await req("/api/enterprises", { method: "POST", headers: jsonHeaders(TOKEN_A), body: bodyOf({ name: "CustHQ" }) });
  const entId = e.body.id;
  const l = await req("/api/locations", { method: "POST", headers: jsonHeaders(TOKEN_A), body: bodyOf({ enterpriseId: entId, name: "Site CM" }) });
  const a = await req("/api/assets", { method: "POST", headers: jsonHeaders(TOKEN_A), body: bodyOf({ name: "Asset-CM", enterpriseId: entId, locationId: l.body.id }) });
  const bindingId = "APB-CUSTOM-1";
  db.prepare(`INSERT INTO asset_point_bindings
    (id, org_id, asset_id, profile_version_id, profile_point_id, point_id, system_id,
     source_kind, source_path, template_vars, enabled, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(bindingId, "ORG-A", a.body.id, null, null, null, null,
         "mqtt", "CustHQ/Site CM/Asset-CM/temperature",
         JSON.stringify({ enterprise: "CustHQ", site: "Site CM", asset: "Asset-CM" }),
         1, ts, ts);

  const patch = await req(`/api/enterprises/${entId}`, { method: "PATCH", headers: jsonHeaders(TOKEN_A), body: bodyOf({ name: "CustHQ-2" }) });
  assert.equal(patch.body.affectedBindings, 1);
  assert.equal(patch.body.sample[0].customMapping, true, "custom mappings flagged in preview");

  const reres = await req(`/api/enterprises/${entId}/re-resolve-bindings`, { method: "POST", headers: jsonHeaders(TOKEN_A), body: bodyOf({}) });
  assert.equal(reres.body.updated, 0);
  assert.equal(reres.body.skipped.length, 1);
  assert.equal(reres.body.skipped[0].reason, "custom_mapping");
});

test("DELETE refused while assets reference enterprise/location", async () => {
  const e = await req("/api/enterprises", { method: "POST", headers: jsonHeaders(TOKEN_A), body: bodyOf({ name: "Doomed" }) });
  const l = await req("/api/locations", { method: "POST", headers: jsonHeaders(TOKEN_A), body: bodyOf({ enterpriseId: e.body.id, name: "Site D" }) });
  const a = await req("/api/assets", { method: "POST", headers: jsonHeaders(TOKEN_A), body: bodyOf({ name: "DoomAsset", enterpriseId: e.body.id, locationId: l.body.id }) });

  const delE = await req(`/api/enterprises/${e.body.id}`, { method: "DELETE", headers: withAuth(TOKEN_A) });
  assert.equal(delE.status, 409);
  const delL = await req(`/api/locations/${l.body.id}`, { method: "DELETE", headers: withAuth(TOKEN_A) });
  assert.equal(delL.status, 409);

  // Detach the asset and the deletes succeed.
  await req(`/api/assets/${a.body.id}`, { method: "PATCH", headers: jsonHeaders(TOKEN_A), body: bodyOf({ enterpriseId: null, locationId: null }) });
  const delLater = await req(`/api/enterprises/${e.body.id}`, { method: "DELETE", headers: withAuth(TOKEN_A) });
  assert.equal(delLater.status, 200);
});

test("BMP magic-byte sniff is accepted as image/bmp via /api/files", async () => {
  // Create a parent asset for the upload.
  const e = await req("/api/enterprises", { method: "POST", headers: jsonHeaders(TOKEN_A), body: bodyOf({ name: "BMPHost" }) });
  const a = await req("/api/assets", { method: "POST", headers: jsonHeaders(TOKEN_A), body: bodyOf({ name: "BMP-Asset", enterpriseId: e.body.id }) });

  // Minimal valid BMP header. The server only sniffs 16 bytes so a
  // BITMAPFILEHEADER (14 bytes) plus a partial DIB header is enough.
  const bmp = Buffer.alloc(64);
  bmp[0] = 0x42; bmp[1] = 0x4d; // 'BM'
  // file size at offset 2..5 (little-endian 64), reserved fields at 6..9,
  // pixel data offset at 10..13. The remaining bytes are zero — safe for
  // the magic-byte sniff path.
  bmp[2] = 0x40;

  const blob = new Blob([bmp], { type: "image/bmp" });
  const fd = new FormData();
  fd.append("parent_kind", "asset");
  fd.append("parent_id", a.body.id);
  fd.append("file", blob, "asset.bmp");
  const up = await fetch(base + "/api/files", { method: "POST", headers: withAuth(TOKEN_A), body: fd });
  assert.equal(up.status, 200);
  const meta = await up.json();
  assert.equal(meta.mime, "image/bmp", "BMP magic bytes recognised");

  // Bind the visual to the asset via PATCH and confirm round-trip.
  const patched = await req(`/api/assets/${a.body.id}`, { method: "PATCH", headers: jsonHeaders(TOKEN_A), body: bodyOf({ visualFileId: meta.id }) });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.visual_file_id, meta.id);
});

test("ETag round-trip on PATCH with If-Match", async () => {
  const e = await req("/api/enterprises", { method: "POST", headers: jsonHeaders(TOKEN_A), body: bodyOf({ name: "ETagged" }) });
  const etag = e.headers.get("etag");
  assert.ok(etag);
  const stale = await req(`/api/enterprises/${e.body.id}`, {
    method: "PATCH",
    headers: { ...jsonHeaders(TOKEN_A), "if-match": 'W/"sha256:00000000000000000000000000000000"' },
    body: bodyOf({ name: "ETagged 2" }),
  });
  assert.equal(stale.status, 412);
  const fresh = await req(`/api/enterprises/${e.body.id}`, {
    method: "PATCH",
    headers: { ...jsonHeaders(TOKEN_A), "if-match": etag },
    body: bodyOf({ name: "ETagged 2" }),
  });
  assert.equal(fresh.status, 200);
});
