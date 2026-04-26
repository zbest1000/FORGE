// Cross-tenant isolation test. Spins up two organizations, signs in as
// a user from each, and asserts that no list/get/search call surfaces
// the other tenant's rows.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-tenant-"));
process.env.FORGE_DATA_DIR = tmpDir;
process.env.FORGE_TENANT_KEY = "forge-tenant-test-0123456789abcdef0123456789abcdef";
process.env.FORGE_JWT_SECRET = "forge-tenant-test-jwt-0123456789abcdef0123456789abcdef";
process.env.FORGE_RATELIMIT_MAX = "10000";
process.env.LOG_LEVEL = "warn";

const { db } = await import("../server/db.js");
const bcrypt = (await import("bcryptjs")).default;
const now = new Date().toISOString();

// Seed two orgs with overlapping names so a missing tenant filter would
// definitely show up.
db.prepare("INSERT INTO organizations (id, name, tenant_key, created_at) VALUES ('ORG-1','Atlas','atlas',?)").run(now);
db.prepare("INSERT INTO organizations (id, name, tenant_key, created_at) VALUES ('ORG-2','Bravo','bravo',?)").run(now);
db.prepare("INSERT INTO workspaces (id, org_id, name, region, created_at) VALUES ('WS-1','ORG-1','North','us-east',?)").run(now);
db.prepare("INSERT INTO workspaces (id, org_id, name, region, created_at) VALUES ('WS-2','ORG-2','South','us-east',?)").run(now);

const ph = await bcrypt.hash("forge", 10);
db.prepare("INSERT INTO users (id, org_id, email, name, role, password_hash, initials, disabled, created_at, updated_at) VALUES ('U-A','ORG-1','a@forge.local','Owner A','Organization Owner',?,'OA',0,?,?)").run(ph, now, now);
db.prepare("INSERT INTO users (id, org_id, email, name, role, password_hash, initials, disabled, created_at, updated_at) VALUES ('U-B','ORG-2','b@forge.local','Owner B','Organization Owner',?,'OB',0,?,?)").run(ph, now, now);

db.prepare("INSERT INTO team_spaces (id, org_id, workspace_id, name, summary, status, acl, labels, created_at, updated_at) VALUES ('TS-A','ORG-1','WS-1','Eng A','','active','{}','[]',?,?)").run(now, now);
db.prepare("INSERT INTO team_spaces (id, org_id, workspace_id, name, summary, status, acl, labels, created_at, updated_at) VALUES ('TS-B','ORG-2','WS-2','Eng B','','active','{}','[]',?,?)").run(now, now);
db.prepare("INSERT INTO projects (id, team_space_id, name, status, milestones, acl, labels, created_at, updated_at) VALUES ('PRJ-A','TS-A','Proj A','active','[]','{}','[]',?,?)").run(now, now);
db.prepare("INSERT INTO projects (id, team_space_id, name, status, milestones, acl, labels, created_at, updated_at) VALUES ('PRJ-B','TS-B','Proj B','active','[]','{}','[]',?,?)").run(now, now);
db.prepare("INSERT INTO documents (id, team_space_id, project_id, name, discipline, current_revision_id, sensitivity, acl, labels, created_at, updated_at) VALUES ('DOC-A','TS-A','PRJ-A','Doc A','Controls',NULL,'internal','{}','[]',?,?)").run(now, now);
db.prepare("INSERT INTO documents (id, team_space_id, project_id, name, discipline, current_revision_id, sensitivity, acl, labels, created_at, updated_at) VALUES ('DOC-B','TS-B','PRJ-B','Doc B','Controls',NULL,'internal','{}','[]',?,?)").run(now, now);
db.prepare("INSERT INTO revisions (id, doc_id, label, status, summary, notes, created_at, updated_at) VALUES ('REV-A','DOC-A','A','IFR','','',?,?)").run(now, now);
db.prepare("INSERT INTO revisions (id, doc_id, label, status, summary, notes, created_at, updated_at) VALUES ('REV-B','DOC-B','A','IFR','','',?,?)").run(now, now);
db.prepare("INSERT INTO assets (id, org_id, workspace_id, name, type, hierarchy, status, mqtt_topics, opcua_nodes, doc_ids, acl, labels, created_at, updated_at) VALUES ('AST-A','ORG-1','WS-1','Asset A','pump','/A','normal','[]','[]','[]','{}','[]',?,?)").run(now, now);
db.prepare("INSERT INTO assets (id, org_id, workspace_id, name, type, hierarchy, status, mqtt_topics, opcua_nodes, doc_ids, acl, labels, created_at, updated_at) VALUES ('AST-B','ORG-2','WS-2','Asset B','pump','/B','normal','[]','[]','[]','{}','[]',?,?)").run(now, now);
db.prepare("INSERT INTO work_items (id, project_id, type, title, assignee_id, status, severity, blockers, labels, acl, created_at, updated_at) VALUES ('WI-A','PRJ-A','Task','Task A','U-A','Open','medium','[]','[]','{}',?,?)").run(now, now);
db.prepare("INSERT INTO work_items (id, project_id, type, title, assignee_id, status, severity, blockers, labels, acl, created_at, updated_at) VALUES ('WI-B','PRJ-B','Task','Task B','U-B','Open','medium','[]','[]','{}',?,?)").run(now, now);
db.prepare("INSERT INTO incidents (id, org_id, workspace_id, title, severity, status, asset_id, commander_id, channel_id, timeline, checklist_state, roster, started_at, created_at, updated_at) VALUES ('INC-A','ORG-1','WS-1','Inc A','SEV-2','active','AST-A',NULL,NULL,'[]','{}','{}',?,?,?)").run(now, now, now);
db.prepare("INSERT INTO incidents (id, org_id, workspace_id, title, severity, status, asset_id, commander_id, channel_id, timeline, checklist_state, roster, started_at, created_at, updated_at) VALUES ('INC-B','ORG-2','WS-2','Inc B','SEV-2','active','AST-B',NULL,NULL,'[]','{}','{}',?,?,?)").run(now, now, now);
db.prepare("INSERT INTO channels (id, team_space_id, name, kind, acl, created_at, updated_at) VALUES ('CH-A','TS-A','general','team','{}',?,?)").run(now, now);
db.prepare("INSERT INTO channels (id, team_space_id, name, kind, acl, created_at, updated_at) VALUES ('CH-B','TS-B','general','team','{}',?,?)").run(now, now);

// Repopulate FTS so search across tenants is exercised.
db.prepare("INSERT INTO fts_docs (id, kind, title, body) VALUES ('DOC-A','Document','Doc A','controls internal')").run();
db.prepare("INSERT INTO fts_docs (id, kind, title, body) VALUES ('DOC-B','Document','Doc B','controls internal')").run();
db.prepare("INSERT INTO fts_workitems (id, project_id, title, description, labels) VALUES ('WI-A','PRJ-A','Task A','','')").run();
db.prepare("INSERT INTO fts_workitems (id, project_id, title, description, labels) VALUES ('WI-B','PRJ-B','Task B','','')").run();
db.prepare("INSERT INTO fts_assets (id, name, hierarchy, type) VALUES ('AST-A','Asset A','/A','pump')").run();
db.prepare("INSERT INTO fts_assets (id, name, hierarchy, type) VALUES ('AST-B','Asset B','/B','pump')").run();

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
  if (tok.startsWith("fgt_")) {
    const r = resolveToken(tok, userById);
    req.user = r?.user || null;
    if (r) { req.tokenId = r.tokenId; req.tokenScopes = r.scopes; }
    return;
  }
  try {
    const d = app.jwt.verify(tok);
    if (!d?.sub) return;
    if (d.sid) {
      const { authenticateAccess } = await import("../server/sessions.js");
      const session = authenticateAccess({ sid: d.sid, jti: d.jti });
      if (!session) return;
      req.sessionId = session.id;
    }
    req.user = userById(d.sub);
  } catch {}
});

await app.register((await import("../server/routes/auth.js")).default);
await app.register((await import("../server/routes/core.js")).default);
await app.listen({ port: 0, host: "127.0.0.1" });
const addr = app.server.address();
const base = `http://127.0.0.1:${addr.port}`;

async function req(p, opts = {}) {
  const r = await fetch(base + p, opts);
  const ct = r.headers.get("content-type") || "";
  return { status: r.status, body: ct.includes("application/json") ? await r.json() : await r.text() };
}
async function login(email) {
  const r = await req("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "forge" }) });
  return r.body.token;
}

let tokA, tokB;
test("seed orgs sign in", async () => {
  tokA = await login("a@forge.local");
  tokB = await login("b@forge.local");
  assert.ok(tokA && tokB);
});

const auth = (t) => ({ authorization: `Bearer ${t}` });

test("team-spaces are tenant-scoped", async () => {
  const a = await req("/api/team-spaces", { headers: auth(tokA) });
  assert.equal(a.status, 200);
  assert.ok(a.body.find(r => r.id === "TS-A"));
  assert.equal(a.body.find(r => r.id === "TS-B"), undefined);
});

test("documents list is tenant-scoped", async () => {
  const a = await req("/api/documents", { headers: auth(tokA) });
  assert.ok(a.body.find(r => r.id === "DOC-A"));
  assert.equal(a.body.find(r => r.id === "DOC-B"), undefined);
});

test("cross-tenant document GET returns 404", async () => {
  const r = await req("/api/documents/DOC-B", { headers: auth(tokA) });
  assert.equal(r.status, 404);
});

test("cross-tenant revision GET returns 404", async () => {
  const r = await req("/api/revisions/REV-B", { headers: auth(tokA) });
  assert.equal(r.status, 404);
});

test("cross-tenant work-item PATCH returns 404", async () => {
  const r = await req("/api/work-items/WI-B", { method: "PATCH", headers: { ...auth(tokA), "content-type": "application/json" }, body: JSON.stringify({ status: "Closed" }) });
  assert.equal(r.status, 404);
});

test("cross-tenant work-item create against foreign project returns 404", async () => {
  const r = await req("/api/work-items", { method: "POST", headers: { ...auth(tokA), "content-type": "application/json" }, body: JSON.stringify({ projectId: "PRJ-B", title: "leak" }) });
  assert.equal(r.status, 404);
});

test("assets list is tenant-scoped", async () => {
  const a = await req("/api/assets", { headers: auth(tokA) });
  assert.ok(a.body.find(r => r.id === "AST-A"));
  assert.equal(a.body.find(r => r.id === "AST-B"), undefined);
});

test("incidents list is tenant-scoped", async () => {
  const a = await req("/api/incidents", { headers: auth(tokA) });
  assert.ok(a.body.find(r => r.id === "INC-A"));
  assert.equal(a.body.find(r => r.id === "INC-B"), undefined);
});

test("/api/users is tenant-scoped", async () => {
  const a = await req("/api/users", { headers: auth(tokA) });
  assert.ok(a.body.find(u => u.id === "U-A"));
  assert.equal(a.body.find(u => u.id === "U-B"), undefined);
});

test("search hits do not leak across tenants", async () => {
  const a = await req("/api/search?q=Doc", { headers: auth(tokA) });
  assert.equal(a.status, 200);
  for (const h of a.body.hits) assert.notEqual(h.id, "DOC-B");
  for (const h of a.body.hits) assert.notEqual(h.id, "WI-B");
  for (const h of a.body.hits) assert.notEqual(h.id, "AST-B");
});

test.after(async () => { await app.close(); });
