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
db.prepare("INSERT INTO team_spaces (id, org_id, workspace_id, name, summary, status, acl, labels, created_at, updated_at) VALUES ('TS-1','ORG-1','WS-1','Engineering','',?,'{}','[]',?,?)")
  .run("active", now, now);
db.prepare("INSERT INTO projects (id, team_space_id, name, status, milestones, acl, labels, created_at, updated_at) VALUES ('PRJ-1','TS-1','Project 1','active','[]','{}','[]',?,?)").run(now, now);
db.prepare("INSERT INTO documents (id, team_space_id, project_id, name, discipline, current_revision_id, sensitivity, acl, labels, created_at, updated_at) VALUES ('DOC-1','TS-1','PRJ-1','Doc 1','Controls',NULL,'internal','{}','[]',?,?)").run(now, now);
db.prepare("INSERT INTO revisions (id, doc_id, label, status, summary, notes, created_at, updated_at) VALUES ('REV-1','DOC-1','A','IFR','initial','',?,?)").run(now, now);
db.prepare("INSERT INTO work_items (id, project_id, type, title, assignee_id, status, severity, blockers, labels, acl, created_at, updated_at) VALUES ('WI-1','PRJ-1','Task','First','U-ADMIN','Open','medium','[]','[]','{}',?,?)").run(now, now);
db.prepare("INSERT INTO channels (id, team_space_id, name, kind, acl, created_at, updated_at) VALUES ('CH-1','TS-1','general','team','{}',?,?)").run(now, now);

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

test("login with bad password is rejected", async () => {
  const r = await req("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "admin@forge.local", password: "wrong" }) });
  assert.equal(r.status, 401);
});

test("CRUD on work items (create, patch, list)", async () => {
  const create = await req("/api/work-items", { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ projectId: "PRJ-1", title: "test WI", severity: "high" }) });
  assert.equal(create.status, 200);
  const id = create.body.id;
  assert.ok(id);

  const patched = await req(`/api/work-items/${id}`, { method: "PATCH", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ status: "In Review" }) });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.status, "In Review");

  const list = await req("/api/work-items?projectId=PRJ-1");
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

  const doc = await req("/api/documents/DOC-1");
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
