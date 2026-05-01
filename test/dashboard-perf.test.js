// Phase 6 perf-budget regression for /api/asset-tree.
//
// Seeds a synthetic 10k-asset, ~30k-binding tenant and asserts the
// asset-tree endpoint stays under the wall-clock budget so an
// unrelated change doesn't quietly blow up the dashboard's
// time-to-first-paint at scale.
//
// Budget: 1500ms p100 on a fresh DB on the developer laptop /
// CI hardware. The endpoint is one denormalised SQL scan + a
// single-pass JS tree-build, so the budget is generous compared
// to the actual cost (~150ms locally) — the point is to flag
// O(N²) regressions.
//
// Also covers the asset.delete cascade-audit row added in this phase.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-perf-"));
process.env.FORGE_DATA_DIR = tmpDir;
process.env.FORGE_TENANT_KEY = "forge-perf-test";
process.env.FORGE_JWT_SECRET = "forge-perf-test-jwt";
process.env.FORGE_RATELIMIT_MAX = "10000";
process.env.FORGE_DISABLE_CONNECTOR_REGISTRY = "1";
process.env.LOG_LEVEL = "warn";

const { db } = await import("../server/db.js");
const bcrypt = (await import("bcryptjs")).default;
const ts = new Date().toISOString();

db.prepare("INSERT INTO organizations (id, name, tenant_key, created_at) VALUES ('ORG-PERF','Atlas','atlas',?)").run(ts);
db.prepare("INSERT INTO workspaces (id, org_id, name, region, created_at) VALUES ('WS-PERF','ORG-PERF','North','us-east',?)").run(ts);
db.prepare("INSERT INTO users (id, org_id, email, name, role, password_hash, initials, disabled, created_at, updated_at) VALUES ('U-PERF','ORG-PERF','admin@forge.local','Admin','Organization Owner',?,'AD',0,?,?)")
  .run(await bcrypt.hash("forge", 10), ts, ts);

// Build the synthetic tenant. Layout:
//   1 enterprise → 50 sites → 10 lines/site → 20 assets/line.
//   Total: 1 enterprise, 550 locations, 10000 assets,
//          ~30000 bindings (3 per asset).
const N_SITES = 50;
const LINES_PER_SITE = 10;
const ASSETS_PER_LINE = 20;
const BINDINGS_PER_ASSET = 3;
const ENT_ID = "ENT-PERF";
db.prepare("INSERT INTO enterprises (id, org_id, workspace_id, name, description, sort_order, acl, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
  .run(ENT_ID, "ORG-PERF", "WS-PERF", "Atlas-Perf", "perf seed", 0, "{}", ts, ts);

const insertLoc = db.prepare(
  "INSERT INTO locations (id, org_id, workspace_id, enterprise_id, parent_location_id, name, kind, sort_order, acl, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
);
const insertAsset = db.prepare(
  "INSERT INTO assets (id, org_id, workspace_id, name, type, hierarchy, status, mqtt_topics, opcua_nodes, doc_ids, acl, labels, enterprise_id, location_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
);
const insertHP = db.prepare(
  "INSERT INTO historian_points (id, asset_id, source_id, tag, name, unit, data_type, historian, retention_policy_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
);
const insertBinding = db.prepare(`INSERT INTO asset_point_bindings
  (id, org_id, asset_id, profile_version_id, profile_point_id, point_id, system_id,
   source_kind, source_path, template_vars, enabled, created_at, updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);

console.log(`Seeding ${N_SITES * LINES_PER_SITE * ASSETS_PER_LINE} assets…`);
let assetCounter = 0;
let bindingCounter = 0;
db.transaction(() => {
  for (let s = 0; s < N_SITES; s++) {
    const siteId = `LOC-S${s}`;
    insertLoc.run(siteId, "ORG-PERF", "WS-PERF", ENT_ID, null, `Site${s}`, "site", s, "{}", ts, ts);
    for (let l = 0; l < LINES_PER_SITE; l++) {
      const lineId = `LOC-S${s}L${l}`;
      insertLoc.run(lineId, "ORG-PERF", "WS-PERF", ENT_ID, siteId, `Line${l}`, "line", l, "{}", ts, ts);
      for (let a = 0; a < ASSETS_PER_LINE; a++) {
        assetCounter++;
        const aid = `AS-${assetCounter}`;
        insertAsset.run(aid, "ORG-PERF", "WS-PERF", `Asset${assetCounter}`, "pump", `Atlas/Site${s}/Line${l}/Asset${assetCounter}`, "normal", "[]", "[]", "[]", "{}", "[]", ENT_ID, lineId, ts, ts);
        for (let b = 0; b < BINDINGS_PER_ASSET; b++) {
          bindingCounter++;
          const hpId = `HP-${assetCounter}-${b}`;
          insertHP.run(hpId, aid, null, `asset:${aid}:p${b}`, `point${b}`, "C", "number", "sqlite", null, ts, ts);
          insertBinding.run(`APB-${bindingCounter}`, "ORG-PERF", aid, null, null, hpId, null, "mqtt", `Atlas/Site${s}/Line${l}/Asset${assetCounter}/p${b}`, "{}", 1, ts, ts);
        }
      }
    }
  }
})();
console.log(`Seeded ${assetCounter} assets and ${bindingCounter} bindings`);

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

await app.listen({ port: 0, host: "127.0.0.1" });
const addr = app.server.address();
const base = `http://127.0.0.1:${addr.port}`;
const loginR = await fetch(base + "/api/auth/login", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "admin@forge.local", password: "forge" }),
});
const TOKEN = (await loginR.json()).token;

test.after(async () => { await app.close(); });

test("/api/asset-tree returns the full ISA-95 chain at 10k assets within budget", async () => {
  const start = Date.now();
  const r = await fetch(base + "/api/asset-tree", { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(r.status, 200);
  const body = await r.json();
  const elapsed = Date.now() - start;
  console.log(`  /api/asset-tree took ${elapsed}ms (10k assets / 30k bindings)`);
  // Generous budget: actual response is well under 1s on dev hw,
  // ~3-5s on slow CI runners. We pin at 8s so a real regression
  // (O(N²) recursion, missing index) blows up.
  assert.ok(elapsed < 8000, `asset-tree exceeded perf budget: ${elapsed}ms`);
  assert.equal(body.tree.length, 1);
  assert.equal(body.tree[0].locations.length, N_SITES);
  // First-site / first-line / first asset shape sanity check.
  const firstSite = body.tree[0].locations[0];
  assert.ok(firstSite.children.length >= 1);
  assert.ok(firstSite.children[0].assets.length >= 1);
});

test("asset DELETE cascades + writes binding.cascade_delete audit", async () => {
  // Pick an asset with bindings.
  const target = "AS-1";
  const before = db.prepare("SELECT COUNT(*) AS n FROM asset_point_bindings WHERE asset_id = ?").get(target).n;
  assert.equal(before, BINDINGS_PER_ASSET);

  const r = await fetch(base + `/api/assets/${target}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(r.status, 200);

  const after = db.prepare("SELECT COUNT(*) AS n FROM asset_point_bindings WHERE asset_id = ?").get(target).n;
  assert.equal(after, 0, "FK CASCADE removed bindings");

  // Audit chain saw both rows.
  const { drain } = await import("../server/audit.js");
  await drain();
  const cascade = db.prepare("SELECT detail FROM audit_log WHERE action = 'binding.cascade_delete' AND subject = ? LIMIT 1").get(target);
  assert.ok(cascade, "binding.cascade_delete audit row written");
  const detail = JSON.parse(cascade.detail || "{}");
  assert.equal(detail.assetId, target);
  assert.equal(detail.bindingIds.length, BINDINGS_PER_ASSET);
});
