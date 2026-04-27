import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-compliance-"));
process.env.FORGE_DATA_DIR = tmpDir;
process.env.FORGE_TENANT_KEY = "compliance-key";
process.env.FORGE_JWT_SECRET = "compliance-jwt";
process.env.LOG_LEVEL = "warn";

const { db } = await import("../server/db.js");
const bcrypt = (await import("bcryptjs")).default;
const now = new Date().toISOString();
db.prepare("INSERT INTO organizations (id, name, tenant_key, created_at) VALUES ('ORG-1','A','a',?)").run(now);
db.prepare("INSERT INTO workspaces (id, org_id, name, region, created_at) VALUES ('WS-1','ORG-1','WS','eu-west',?)").run(now);
db.prepare("INSERT INTO users (id, org_id, email, name, role, password_hash, initials, disabled, created_at, updated_at) VALUES ('U-ADMIN','ORG-1','admin@x','Admin','Organization Owner',?, 'AD',0,?,?)")
  .run(await bcrypt.hash("forge", 10), now, now);
db.prepare("INSERT INTO users (id, org_id, email, name, role, password_hash, initials, disabled, created_at, updated_at) VALUES ('U-VIEW','ORG-1','view@x','View','Viewer/Auditor',?, 'VW',0,?,?)")
  .run(await bcrypt.hash("forge", 10), now, now);
db.prepare("INSERT INTO team_spaces (id, org_id, workspace_id, name, summary, status, acl, labels, created_at, updated_at) VALUES ('TS-1','ORG-1','WS-1','TS','','active','{}','[]',?,?)").run(now, now);
db.prepare("INSERT INTO projects (id, team_space_id, name, status, milestones, acl, labels, created_at, updated_at) VALUES ('PRJ-1','TS-1','P','active','[]','{}','[]',?,?)").run(now, now);
db.prepare("INSERT INTO work_items (id, project_id, type, title, assignee_id, status, severity, blockers, labels, acl, created_at, updated_at) VALUES ('WI-1','PRJ-1','Task','Subject linked work','U-VIEW','Open','medium','[]','[]','{}',?,?)").run(now, now);

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
await app.register((await import("../server/routes/compliance.js")).default);
await app.listen({ port: 0, host: "127.0.0.1" });
const base = `http://127.0.0.1:${app.server.address().port}`;

async function req(p, opts = {}) {
  const r = await fetch(base + p, opts);
  const body = (r.headers.get("content-type") || "").includes("json") ? await r.json() : await r.text();
  if (r.status >= 500) console.error("server error", p, body);
  return { status: r.status, body };
}
let ADMIN;
let VIEWER;

test.after(async () => { await app.close(); });

test("login tokens", async () => {
  const admin = await req("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "admin@x", password: "forge" }) });
  const viewer = await req("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "view@x", password: "forge" }) });
  assert.equal(admin.status, 200);
  assert.equal(viewer.status, 200);
  ADMIN = admin.body.token;
  VIEWER = viewer.body.token;
});

test("compliance endpoints require admin/audit access", async () => {
  const anon = await req("/api/compliance/processing-activities");
  assert.equal(anon.status, 401);
  // Body is schema-valid so the request reaches the capability gate;
  // a minimal `{ name: "Denied" }` would 400 on body validation
  // before the auth check ever ran.
  const viewerDenied = await req("/api/compliance/processing-activities", {
    method: "POST",
    headers: { authorization: `Bearer ${VIEWER}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "Denied", purpose: "auth-only", lawfulBasis: "test" }),
  });
  assert.equal(viewerDenied.status, 403);
});

test("ROPA, legal hold, AI system and DSAR flows are auditable", async () => {
  const ropa = await req("/api/compliance/processing-activities", { method: "POST", headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: JSON.stringify({ name: "Work execution", purpose: "Deliver engineering work", lawfulBasis: "contract", dataCategories: ["identity","work-items"], retentionDays: 1825, region: "EU" }) });
  assert.equal(ropa.status, 200);
  assert.ok(ropa.body.id.startsWith("ROPA-"));

  const hold = await req("/api/compliance/legal-holds", { method: "POST", headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: JSON.stringify({ name: "Litigation hold", scope: "work_items", objectIds: ["WI-1"], reason: "Matter A" }) });
  assert.equal(hold.status, 200);
  assert.ok(hold.body.id.startsWith("LH-"));

  const ai = await req("/api/compliance/ai-systems", { method: "POST", headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: JSON.stringify({ name: "Engineering assistant", provider: "local", model: "deterministic-rag", riskTier: "limited", purpose: "Document Q&A", humanOversight: "Engineer approves outputs", dataCategories: ["documents","work-items"] }) });
  assert.equal(ai.status, 200);
  assert.ok(ai.body.id.startsWith("AIS-"));

  const dsar = await req("/api/compliance/dsar", { method: "POST", headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: JSON.stringify({ subjectUserId: "U-VIEW", requestType: "access" }) });
  assert.equal(dsar.status, 200);
  const bundle = await req(`/api/compliance/dsar/${dsar.body.id}/export`, { headers: { authorization: `Bearer ${ADMIN}` } });
  assert.equal(bundle.status, 200);
  assert.equal(bundle.body.subject.id, "U-VIEW");
  assert.ok(bundle.body.records.workItems.find(w => w.id === "WI-1"));
  assert.ok(bundle.body.records.auditEvents.length >= 1);
});
