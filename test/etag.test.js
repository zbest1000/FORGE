// ETag / If-Match optimistic concurrency on PATCH endpoints.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-etag-"));
process.env.FORGE_DATA_DIR = tmpDir;
process.env.FORGE_TENANT_KEY = "forge-etag-test";
process.env.FORGE_JWT_SECRET = "forge-etag-test-jwt";
process.env.FORGE_RATELIMIT_MAX = "10000";
process.env.LOG_LEVEL = "warn";

const { db } = await import("../server/db.js");

const bcrypt = (await import("bcryptjs")).default;
const now = new Date().toISOString();
db.prepare("INSERT INTO organizations (id, name, tenant_key, created_at) VALUES ('ORG-1','Atlas','etag',?)").run(now);
db.prepare("INSERT INTO workspaces (id, org_id, name, region, created_at) VALUES ('WS-1','ORG-1','North','us-east',?)").run(now);
db.prepare("INSERT INTO users (id, org_id, email, name, role, password_hash, initials, disabled, created_at, updated_at) VALUES ('U-OWN','ORG-1','owner@etag.test','Owner','Organization Owner',?,'OW',0,?,?)")
  .run(await bcrypt.hash("forge", 10), now, now);
db.prepare("INSERT INTO team_spaces (id, org_id, workspace_id, name, summary, status, acl, labels, created_at, updated_at) VALUES ('TS-1','ORG-1','WS-1','Eng','','active','{}','[]',?,?)").run(now, now);
db.prepare("INSERT INTO projects (id, team_space_id, name, status, milestones, acl, labels, created_at, updated_at) VALUES ('PRJ-1','TS-1','Project','active','[]','{}','[]',?,?)").run(now, now);
db.prepare("INSERT INTO work_items (id, project_id, type, title, assignee_id, status, severity, blockers, labels, acl, created_at, updated_at) VALUES ('WI-1','PRJ-1','Task','First','U-OWN','Open','medium','[]','[]','{}',?,?)").run(now, now);

// Boot Fastify in-process with the same auth wiring as routes.test.js.
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
    body: JSON.stringify({ email: "owner@etag.test", password: "forge" }),
  });
  const body = await r.json();
  return body.token;
}

test("GET work-item returns weak ETag", async () => {
  const token = await login();
  const r = await fetch(base + "/api/work-items/WI-1", {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(r.status, 200);
  const tag = r.headers.get("etag");
  assert.ok(tag, "missing ETag");
  assert.match(tag, /^W\/"sha256:[0-9a-f]{32}"$/);
});

test("PATCH without If-Match succeeds and returns new ETag", async () => {
  const token = await login();
  const get1 = await fetch(base + "/api/work-items/WI-1", {
    headers: { authorization: `Bearer ${token}` },
  });
  const tag1 = get1.headers.get("etag");
  const r = await fetch(base + "/api/work-items/WI-1", {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ title: "Renamed" }),
  });
  assert.equal(r.status, 200);
  const tag2 = r.headers.get("etag");
  assert.ok(tag2, "PATCH response missing ETag");
  assert.notEqual(tag1, tag2, "ETag should change after update");
});

test("PATCH with current If-Match succeeds", async () => {
  const token = await login();
  const get1 = await fetch(base + "/api/work-items/WI-1", {
    headers: { authorization: `Bearer ${token}` },
  });
  const tag = get1.headers.get("etag");
  const r = await fetch(base + "/api/work-items/WI-1", {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "If-Match": tag,
    },
    body: JSON.stringify({ title: "RenamedAgain" }),
  });
  assert.equal(r.status, 200);
});

test("PATCH with stale If-Match returns 412", async () => {
  const token = await login();
  // Use the previous ETag (from before the prior PATCH) — guaranteed stale.
  const stale = 'W/"sha256:00000000000000000000000000000000"';
  const r = await fetch(base + "/api/work-items/WI-1", {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "If-Match": stale,
    },
    body: JSON.stringify({ title: "Should Fail" }),
  });
  assert.equal(r.status, 412);
  const body = await r.json();
  assert.equal(body.error?.code, "etag_mismatch");
  assert.ok(body.error?.requestId);
});

test("PATCH with If-Match: * succeeds when row exists", async () => {
  const token = await login();
  const r = await fetch(base + "/api/work-items/WI-1", {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "If-Match": "*",
    },
    body: JSON.stringify({ title: "Wildcard" }),
  });
  assert.equal(r.status, 200);
});
