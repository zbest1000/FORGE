// GraphQL endpoint tests: schema introspection, deep query, auth gating,
// and a roundtrip mutation.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-graphql-"));
process.env.FORGE_DATA_DIR = tmpDir;
process.env.FORGE_TENANT_KEY = "graphql-key";
process.env.FORGE_JWT_SECRET = "graphql-jwt";
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
db.prepare("INSERT INTO documents (id, team_space_id, project_id, name, discipline, current_revision_id, sensitivity, acl, labels, created_at, updated_at) VALUES ('DOC-1','TS-1','PRJ-1','Doc 1','Process',NULL,'internal','{}','[]',?,?)").run(now, now);
db.prepare("INSERT INTO revisions (id, doc_id, label, status, summary, notes, created_at, updated_at) VALUES ('REV-1','DOC-1','A','IFR','init','',?,?)").run(now, now);

const { default: Fastify } = await import("fastify");
const { default: jwt } = await import("@fastify/jwt");
const { default: cors } = await import("@fastify/cors");
const mercurius = (await import("mercurius")).default;
const { typeDefs } = await import("../server/graphql/schema.js");
const { resolvers } = await import("../server/graphql/resolvers.js");
const { userById } = await import("../server/auth.js");

const app = Fastify({ logger: false });
await app.register(cors, { origin: true });
await app.register(jwt, { secret: process.env.FORGE_JWT_SECRET });
app.addHook("onRequest", async (req) => {
  const h = req.headers.authorization || "";
  const tok = h.startsWith("Bearer ") ? h.slice(7) : null;
  req.user = null;
  if (!tok) return;
  try { const d = app.jwt.verify(tok); req.user = d?.sub ? userById(d.sub) : null; } catch {}
});
await app.register(mercurius, { schema: typeDefs, resolvers, graphiql: false, context: (request) => ({ user: request.user }) });
await app.register((await import("../server/routes/auth.js")).default);

await app.listen({ port: 0, host: "127.0.0.1" });
const addr = app.server.address();
const base = `http://127.0.0.1:${addr.port}`;

async function gql(query, variables = {}, token = null) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(base + "/graphql", { method: "POST", headers, body: JSON.stringify({ query, variables }) });
  return { status: r.status, body: await r.json() };
}
let TOKEN;

test.after(async () => { await app.close(); });

test("login + me", async () => {
  const r = await fetch(base + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "x@x", password: "x" }) });
  const j = await r.json();
  TOKEN = j.token;
  const me = await gql("{ me { id name role } }", {}, TOKEN);
  assert.equal(me.body.data.me.id, "U-X");
});

test("deep traversal: document → revisions / project / teamSpace", async () => {
  const r = await gql(`{
    document(id:"DOC-1") {
      id name
      revisions { id label status }
      project { id name }
      teamSpace { id name }
    }
  }`, {}, TOKEN);
  assert.equal(r.body.data.document.id, "DOC-1");
  assert.equal(r.body.data.document.revisions.length, 1);
  assert.equal(r.body.data.document.project.id, "PRJ-1");
  assert.equal(r.body.data.document.teamSpace.id, "TS-1");
});

test("unauthenticated mutation is rejected", async () => {
  const r = await gql(`mutation { createWorkItem(projectId:"PRJ-1", type:"Task", title:"x") { id } }`);
  assert.equal(r.body.data, null);
  assert.ok(r.body.errors?.length);
  assert.equal(r.body.errors[0].extensions.code, "UNAUTHENTICATED");
});

test("createWorkItem mutation + transitionRevision", async () => {
  const r1 = await gql(`mutation { createWorkItem(projectId:"PRJ-1", type:"NCR", title:"gql NCR", severity:"high") { id status type } }`, {}, TOKEN);
  assert.equal(r1.body.data.createWorkItem.status, "Open");
  assert.equal(r1.body.data.createWorkItem.type, "NCR");

  const r2 = await gql(`mutation { transitionRevision(id:"REV-1", to:"Approved") { id status } }`, {}, TOKEN);
  assert.equal(r2.body.data.transitionRevision.status, "Approved");

  // Bad transition.
  const r3 = await gql(`mutation { transitionRevision(id:"REV-1", to:"Draft") { id status } }`, {}, TOKEN);
  assert.ok(r3.body.errors?.length);
});

test("introspection reports the schema (sanity)", async () => {
  const r = await gql(`{ __schema { queryType { name } mutationType { name } } }`, {}, TOKEN);
  assert.equal(r.body.data.__schema.queryType.name, "Query");
  assert.equal(r.body.data.__schema.mutationType.name, "Mutation");
});
