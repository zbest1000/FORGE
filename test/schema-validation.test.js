// Per-route JSON schema validation. Malformed bodies should be
// rejected with a 400 + structured error envelope before the handler
// ever runs.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-schema-"));
process.env.FORGE_DATA_DIR = tmpDir;
process.env.FORGE_TENANT_KEY = "forge-schema-test";
process.env.FORGE_JWT_SECRET = "forge-schema-test-jwt";
process.env.FORGE_RATELIMIT_MAX = "10000";
process.env.LOG_LEVEL = "warn";

const { db } = await import("../server/db.js");
const bcrypt = (await import("bcryptjs")).default;
const now = new Date().toISOString();
db.prepare("INSERT INTO organizations (id, name, tenant_key, created_at) VALUES ('ORG-1','Atlas','sch',?)").run(now);
db.prepare("INSERT INTO workspaces (id, org_id, name, region, created_at) VALUES ('WS-1','ORG-1','N','us',?)").run(now);
db.prepare("INSERT INTO users (id, org_id, email, name, role, password_hash, initials, disabled, created_at, updated_at) VALUES ('U-OWN','ORG-1','o@s.test','Own','Organization Owner',?,'OW',0,?,?)")
  .run(await bcrypt.hash("forge", 10), now, now);
db.prepare("INSERT INTO team_spaces (id, org_id, workspace_id, name, summary, status, acl, labels, created_at, updated_at) VALUES ('TS-1','ORG-1','WS-1','t','','active','{}','[]',?,?)").run(now, now);
db.prepare("INSERT INTO projects (id, team_space_id, name, status, milestones, acl, labels, created_at, updated_at) VALUES ('PRJ-1','TS-1','p','active','[]','{}','[]',?,?)").run(now, now);

const { default: Fastify } = await import("fastify");
const { default: jwt } = await import("@fastify/jwt");
const { errorHandler } = await import("../server/errors.js");
const { userById } = await import("../server/auth.js");

const app = Fastify({ logger: false });
await app.register(jwt, { secret: process.env.FORGE_JWT_SECRET });
app.setErrorHandler(errorHandler());
app.addHook("onRequest", async (req) => {
  const h = req.headers.authorization || "";
  const tok = h.startsWith("Bearer ") ? h.slice(7) : null;
  req.user = null;
  if (!tok) return;
  try {
    const d = app.jwt.verify(tok);
    if (!d?.sub) return;
    req.user = userById(d.sub);
  } catch {}
});
await app.register((await import("../server/routes/auth.js")).default);
await app.register((await import("../server/routes/core.js")).default);

await app.listen({ port: 0, host: "127.0.0.1" });
const addr = app.server.address();
const base = `http://127.0.0.1:${addr.port}`;
test.after(async () => { await app.close(); });

async function login() {
  const r = await fetch(base + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "o@s.test", password: "forge" }),
  });
  return (await r.json()).token;
}

test("login with empty body returns 400 envelope", async () => {
  const r = await fetch(base + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.equal(body.error?.code, "validation_error");
  assert.ok(body.error?.message);
  // Details should describe which fields were missing/invalid.
  assert.ok(body.error?.details?.issues, "expected validation issues array");
});

test("login with non-email rejected by pattern", async () => {
  const r = await fetch(base + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "not-an-email", password: "abc" }),
  });
  assert.equal(r.status, 400);
});

test("work-items create missing required projectId returns 400", async () => {
  const token = await login();
  const r = await fetch(base + "/api/work-items", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ title: "no project" }),
  });
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.equal(body.error?.code, "validation_error");
});

test("work-items create with valid body succeeds", async () => {
  const token = await login();
  const r = await fetch(base + "/api/work-items", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ projectId: "PRJ-1", title: "valid" }),
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(body.id);
});

test("work-items create with invalid severity enum returns 400", async () => {
  const token = await login();
  const r = await fetch(base + "/api/work-items", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ projectId: "PRJ-1", title: "bad-sev", severity: "BLOCKER" }),
  });
  assert.equal(r.status, 400);
});
