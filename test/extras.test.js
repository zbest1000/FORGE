// Tests for the routes added in the gap-closing slice.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-extras-"));
process.env.FORGE_DATA_DIR = tmpDir;
process.env.FORGE_TENANT_KEY = "extras-key";
process.env.FORGE_JWT_SECRET = "extras-jwt";
process.env.FORGE_RATELIMIT_MAX = "10000";
process.env.LOG_LEVEL = "warn";

const { db } = await import("../server/db.js");

const bcrypt = (await import("bcryptjs")).default;
const now = new Date().toISOString();
db.prepare("INSERT INTO organizations (id, name, tenant_key, created_at) VALUES ('ORG-1','A','a',?)").run(now);
db.prepare("INSERT INTO workspaces (id, org_id, name, region, created_at) VALUES ('WS-1','ORG-1','WS','us-east',?)").run(now);
db.prepare("INSERT INTO users (id, org_id, email, name, role, password_hash, initials, disabled, created_at, updated_at) VALUES ('U-X','ORG-1','x@x','X','Organization Owner',?, 'X',0,?,?)")
  .run(await bcrypt.hash("x", 10), now, now);
db.prepare("INSERT INTO team_spaces (id, org_id, workspace_id, name, summary, status, acl, labels, created_at, updated_at) VALUES ('TS-1','ORG-1','WS-1','TS','','active','{}','[]',?,?)").run(now, now);
db.prepare("INSERT INTO projects (id, team_space_id, name, status, milestones, acl, labels, created_at, updated_at) VALUES ('PRJ-1','TS-1','P','active','[]','{}','[]',?,?)").run(now, now);
db.prepare("INSERT INTO documents (id, team_space_id, project_id, name, discipline, current_revision_id, sensitivity, acl, labels, created_at, updated_at) VALUES ('DOC-1','TS-1','PRJ-1','D1','Process',NULL,'internal','{}','[]',?,?)").run(now, now);
db.prepare("INSERT INTO revisions (id, doc_id, label, status, summary, notes, created_at, updated_at) VALUES ('REV-1','DOC-1','A','IFR','init','',?,?)").run(now, now);
db.prepare("INSERT INTO drawings (id, doc_id, team_space_id, project_id, name, discipline, sheets, acl, labels, created_at, updated_at) VALUES ('DRW-1','DOC-1','TS-1','PRJ-1','D','Process','[]','{}','[]',?,?)").run(now, now);
db.prepare("INSERT INTO work_items (id, project_id, type, title, assignee_id, status, severity, blockers, labels, acl, created_at, updated_at) VALUES ('WI-RFI','PRJ-1','RFI','my rfi','U-X','Open','low','[]','[]','{}',?,?)").run(now, now);

const { default: Fastify } = await import("fastify");
const { default: jwt } = await import("@fastify/jwt");
const { default: cors } = await import("@fastify/cors");
const { default: multipart } = await import("@fastify/multipart");
const { userById } = await import("../server/auth.js");
const { resolveToken } = await import("../server/tokens.js");

const app = Fastify({ logger: false });
await app.register(cors, { origin: true });
await app.register(jwt, { secret: process.env.FORGE_JWT_SECRET });
await app.register(multipart);

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
await app.register((await import("../server/routes/extras.js")).default);

await app.listen({ port: 0, host: "127.0.0.1" });
const addr = app.server.address();
const base = `http://127.0.0.1:${addr.port}`;

async function req(p, opts = {}) {
  const r = await fetch(base + p, opts);
  const ct = r.headers.get("content-type") || "";
  const body = ct.includes("application/json") ? await r.json() : await r.text();
  return { status: r.status, body };
}
let TOKEN;

test.after(async () => { await app.close(); });

test("login", async () => {
  const r = await req("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "x@x", password: "x" }) });
  assert.equal(r.status, 200);
  TOKEN = r.body.token;
});

test("review cycle: create, list, close", async () => {
  const c = await req("/api/review-cycles", { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ docId: "DOC-1", revId: "REV-1", name: "cycle 1", reviewers: ["U-X"] }) });
  assert.equal(c.status, 200);
  const list = await req("/api/review-cycles?docId=DOC-1");
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].status, "open");
  const close = await req(`/api/review-cycles/${c.body.id}/close`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(close.status, 200);
  const list2 = await req("/api/review-cycles?docId=DOC-1");
  assert.equal(list2.body[0].status, "closed");
});

test("form submission: signed and listed", async () => {
  const r = await req("/api/form-submissions", { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ formId: "FRM-1", parentKind: "work_item", parentId: "WI-RFI", answers: { ok: true } }) });
  assert.equal(r.status, 200);
  assert.ok(r.body.signature?.signature?.length === 64);
  const list = await req("/api/form-submissions?formId=FRM-1");
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].submitter_id, "U-X");
});

test("commissioning: create + check + uncheck", async () => {
  const c = await req("/api/commissioning", { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ name: "cc", projectId: "PRJ-1", system: "PLC", panel: "A", package: "P3", items: ["a","b","c"] }) });
  assert.equal(c.status, 200);
  const id = c.body.id;
  const ck1 = await req(`/api/commissioning/${id}/check`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ index: 1, checked: true }) });
  assert.equal(ck1.body.completed.length, 1);
  const ck2 = await req(`/api/commissioning/${id}/check`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ index: 1, checked: false }) });
  assert.equal(ck2.body.completed.length, 0);
});

test("RFI links: add + list + delete", async () => {
  const a = await req("/api/rfi/WI-RFI/links", { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ targetKind: "drawing", targetId: "DRW-1", relation: "references" }) });
  assert.equal(a.status, 200);
  const list = await req("/api/rfi/WI-RFI/links");
  assert.equal(list.body.length, 1);

  // DELETE without query params must reject (previously returned ok with no
  // rows touched, hiding caller bugs).
  const badDel = await req("/api/rfi/WI-RFI/links", { method: "DELETE", headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(badDel.status, 400);
  const stillThere = await req("/api/rfi/WI-RFI/links");
  assert.equal(stillThere.body.length, 1);

  const del = await req("/api/rfi/WI-RFI/links?targetKind=drawing&targetId=DRW-1", { method: "DELETE", headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(del.status, 200);
  assert.equal(del.body.removed, 1);
  const list2 = await req("/api/rfi/WI-RFI/links");
  assert.equal(list2.body.length, 0);
});

test("drawing ingest rejects when drawing has no parent document", async () => {
  // Drawing inserted in fixtures has doc_id=DOC-1; a fresh drawing with no
  // parent must NOT silently create a revision pointing at the drawing id.
  const tsNow = new Date().toISOString();
  db.prepare("INSERT INTO drawings (id, doc_id, team_space_id, project_id, name, discipline, sheets, acl, labels, created_at, updated_at) VALUES ('DRW-ORPH', NULL, NULL, NULL, 'Orphan', 'Process', '[]', '{}', '[]', ?, ?)").run(tsNow, tsNow);
  db.prepare("INSERT INTO files (id, parent_kind, parent_id, name, mime, size, sha256, path, created_by, created_at) VALUES ('F-ING','drawing','DRW-ORPH','D-100-Rev-C.pdf','application/pdf',1,'h','/tmp/x','U-X',?)").run(tsNow);

  const r = await req("/api/drawings/DRW-ORPH/ingest", { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ fileId: "F-ING" }) });
  assert.equal(r.status, 409);
  // No revision created.
  const orph = db.prepare("SELECT COUNT(*) AS n FROM revisions WHERE doc_id = ?").get("DRW-ORPH").n;
  assert.equal(orph, 0);
});

test("model pin: create + list", async () => {
  const c = await req("/api/model-pins", { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ drawingId: "DRW-1", elementId: "EQ-HX01", text: "check tube integrity" }) });
  assert.equal(c.status, 200);
  const list = await req("/api/model-pins?drawingId=DRW-1");
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].element_id, "EQ-HX01");
});
