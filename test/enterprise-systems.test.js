import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-enterprise-"));
process.env.FORGE_DATA_DIR = tmpDir;
process.env.FORGE_TENANT_KEY = "enterprise-key";
process.env.FORGE_JWT_SECRET = "enterprise-jwt";
process.env.LOG_LEVEL = "warn";

const { db } = await import("../server/db.js");
const bcrypt = (await import("bcryptjs")).default;
const now = new Date().toISOString();
db.prepare("INSERT INTO organizations (id, name, tenant_key, created_at) VALUES ('ORG-1','A','a',?)").run(now);
db.prepare("INSERT INTO workspaces (id, org_id, name, region, created_at) VALUES ('WS-1','ORG-1','WS','us-east',?)").run(now);
db.prepare("INSERT INTO users (id, org_id, email, name, role, password_hash, initials, disabled, created_at, updated_at) VALUES ('U-ADMIN','ORG-1','admin@x','Admin','Organization Owner',?, 'AD',0,?,?)")
  .run(await bcrypt.hash("forge", 10), now, now);
db.prepare("INSERT INTO users (id, org_id, email, name, role, password_hash, initials, disabled, created_at, updated_at) VALUES ('U-VIEW','ORG-1','view@x','View','Viewer/Auditor',?, 'VW',0,?,?)")
  .run(await bcrypt.hash("forge", 10), now, now);

const { default: Fastify } = await import("fastify");
const { default: jwt } = await import("@fastify/jwt");
const { userById } = await import("../server/auth.js");
const app = Fastify({ logger: false });
await app.register(jwt, { secret: process.env.FORGE_JWT_SECRET });
app.addHook("onRequest", async (req) => {
  const h = req.headers.authorization || "";
  const tok = h.startsWith("Bearer ") ? h.slice(7) : null;
  req.user = null;
  if (!tok) return;
  try { const d = app.jwt.verify(tok); req.user = d?.sub ? userById(d.sub) : null; } catch {}
});
await app.register((await import("../server/routes/auth.js")).default);
await app.register((await import("../server/routes/enterprise-systems.js")).default);
await app.listen({ port: 0, host: "127.0.0.1" });
const base = `http://127.0.0.1:${app.server.address().port}`;

async function req(p, opts = {}) {
  const r = await fetch(base + p, opts);
  const body = (r.headers.get("content-type") || "").includes("json") ? await r.json() : await r.text();
  return { status: r.status, body };
}
let ADMIN;
let VIEWER;
test.after(async () => { await app.close(); });

test("login tokens", async () => {
  const admin = await req("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "admin@x", password: "forge" }) });
  const viewer = await req("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "view@x", password: "forge" }) });
  ADMIN = admin.body.token;
  VIEWER = viewer.body.token;
});

test("enterprise system registry gates access and redacts secrets", async () => {
  const denied = await req("/api/enterprise-systems", { method: "POST", headers: { authorization: `Bearer ${VIEWER}`, "content-type": "application/json" }, body: JSON.stringify({ name: "SAP", category: "erp" }) });
  assert.equal(denied.status, 403);

  const created = await req("/api/enterprise-systems", {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
    body: JSON.stringify({
      name: "SAP S/4HANA",
      category: "erp",
      vendor: "SAP",
      baseUrl: "https://sap.example",
      authType: "oauth2",
      secretRef: "vault://sap/prod",
      capabilities: ["purchase-orders", "materials"],
      dataResidency: "EU",
      config: { clientIdRef: "vault://sap/client-id" },
    }),
  });
  assert.equal(created.status, 200);
  assert.ok(created.body.id.startsWith("ES-"));
  assert.equal(created.body.secret_ref, undefined);
  assert.equal(created.body.has_secret, true);

  const list = await req("/api/enterprise-systems", { headers: { authorization: `Bearer ${ADMIN}` } });
  assert.equal(list.status, 200);
  assert.equal(list.body[0].secret_ref, undefined);

  const testRun = await req(`/api/enterprise-systems/${created.body.id}/test`, { method: "POST", headers: { authorization: `Bearer ${ADMIN}` } });
  assert.equal(testRun.status, 200);
  assert.equal(testRun.body.status, "succeeded");

  const syncRun = await req(`/api/enterprise-systems/${created.body.id}/sync`, { method: "POST", headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: JSON.stringify({ dryRun: true }) });
  assert.equal(syncRun.status, 200);
  assert.equal(syncRun.body.run_type, "sync");

  const runs = await req(`/api/enterprise-systems/${created.body.id}/runs`, { headers: { authorization: `Bearer ${ADMIN}` } });
  assert.equal(runs.status, 200);
  assert.equal(runs.body.length, 2);
});

test("external object links map enterprise records to FORGE objects", async () => {
  const system = await req("/api/enterprise-systems", { method: "POST", headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: JSON.stringify({ name: "ServiceNow", category: "cmms", vendor: "ServiceNow" }) });
  const link = await req("/api/external-links", {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
    body: JSON.stringify({ systemId: system.body.id, externalKind: "incident", externalId: "INC001", forgeKind: "incident", forgeId: "INC-1", metadata: { priority: "P1" } }),
  });
  assert.equal(link.status, 200);
  assert.ok(link.body.id.startsWith("XLINK-"));

  const list = await req("/api/external-links?forgeKind=incident&forgeId=INC-1", { headers: { authorization: `Bearer ${ADMIN}` } });
  assert.equal(list.status, 200);
  assert.equal(list.body[0].metadata.priority, "P1");
});
