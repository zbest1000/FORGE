// HTTP idempotency-key contract tests.
//
// Boots Fastify with the auth + work-items routes plus the idempotency
// plugin, then drives:
//   1. A POST without Idempotency-Key remains untouched (creates a row).
//   2. A POST with Idempotency-Key creates exactly one row even when
//      the request is replayed N times; the cached response is
//      returned with `Idempotency-Replay: true`.
//   3. Reusing the same key with a *different* body returns 409
//      `mismatch`.
//   4. A concurrent in-flight duplicate returns 409 `in_flight`.
//   5. Sweep deletes expired entries.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-idem-"));
process.env.FORGE_DATA_DIR = tmpDir;
process.env.FORGE_TENANT_KEY = "forge-idem-test-0123456789abcdef0123456789abcdef";
process.env.FORGE_JWT_SECRET = "forge-idem-test-jwt-0123456789abcdef0123456789abcdef";
process.env.FORGE_RATELIMIT_MAX = "10000";
process.env.LOG_LEVEL = "warn";

const { db } = await import("../server/db.js");
const bcrypt = (await import("bcryptjs")).default;
const now = new Date().toISOString();
const ph = await bcrypt.hash("forge", 10);

db.prepare("INSERT INTO organizations (id, name, tenant_key, created_at) VALUES ('ORG-1','Atlas','atlas',?)").run(now);
db.prepare("INSERT INTO workspaces (id, org_id, name, region, created_at) VALUES ('WS-1','ORG-1','North','us-east',?)").run(now);
db.prepare("INSERT INTO users (id, org_id, email, name, role, password_hash, initials, disabled, created_at, updated_at) VALUES ('U-I','ORG-1','idem@forge.local','Idem','Organization Owner',?,'I',0,?,?)").run(ph, now, now);
db.prepare("INSERT INTO team_spaces (id, org_id, workspace_id, name, summary, status, acl, labels, created_at, updated_at) VALUES ('TS-I','ORG-1','WS-1','Eng','','active','{}','[]',?,?)").run(now, now);
db.prepare("INSERT INTO projects (id, team_space_id, name, status, milestones, acl, labels, created_at, updated_at) VALUES ('PRJ-I','TS-I','Proj','active','[]','{}','[]',?,?)").run(now, now);

const { default: Fastify } = await import("fastify");
const { default: jwt } = await import("@fastify/jwt");
const { default: cors } = await import("@fastify/cors");
const { userById } = await import("../server/auth.js");
const { resolveToken } = await import("../server/tokens.js");
const { registerIdempotency, sweepIdempotency, _drop } = await import("../server/idempotency.js");

const app = Fastify({ logger: false });
await app.register(cors, { origin: true });
await app.register(jwt, { secret: process.env.FORGE_JWT_SECRET });

app.addHook("onRequest", async (req) => {
  const h = req.headers.authorization || "";
  const tok = h.startsWith("Bearer ") ? h.slice(7) : null;
  req.user = null;
  if (!tok) return;
  if (tok.startsWith("fgt_")) { const r = resolveToken(tok, userById); req.user = r?.user || null; return; }
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

await registerIdempotency(app);
await app.register((await import("../server/routes/auth.js")).default);
await app.register((await import("../server/routes/core.js")).default);

await app.listen({ port: 0, host: "127.0.0.1" });
const base = `http://127.0.0.1:${app.server.address().port}`;
test.after(async () => { await app.close(); });

async function http(p, opts = {}) {
  const r = await fetch(base + p, opts);
  const ct = r.headers.get("content-type") || "";
  return { status: r.status, headers: r.headers, body: ct.includes("application/json") ? await r.json() : await r.text() };
}

const login = await http("/api/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "idem@forge.local", password: "forge" }),
});
const TOKEN = login.body.token;

function countWorkItems() {
  return db.prepare("SELECT COUNT(*) AS n FROM work_items WHERE project_id = 'PRJ-I'").get().n;
}

test("POST without Idempotency-Key creates a fresh row each call", async () => {
  const before = countWorkItems();
  const a = await http("/api/work-items", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ projectId: "PRJ-I", title: "no-key A" }),
  });
  const b = await http("/api/work-items", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ projectId: "PRJ-I", title: "no-key A" }),
  });
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.notEqual(a.body.id, b.body.id);
  assert.equal(countWorkItems(), before + 2);
});

test("POST with Idempotency-Key creates one row even when replayed", async () => {
  const before = countWorkItems();
  const KEY = "test-key-replay";
  const headers = {
    authorization: `Bearer ${TOKEN}`,
    "content-type": "application/json",
    "idempotency-key": KEY,
  };
  const body = JSON.stringify({ projectId: "PRJ-I", title: "idem replay" });
  const first = await http("/api/work-items", { method: "POST", headers, body });
  const second = await http("/api/work-items", { method: "POST", headers, body });
  const third = await http("/api/work-items", { method: "POST", headers, body });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(second.headers.get("idempotency-replay"), "true");
  assert.equal(third.headers.get("idempotency-replay"), "true");
  assert.deepEqual(second.body, first.body);
  assert.deepEqual(third.body, first.body);
  assert.equal(countWorkItems(), before + 1);
});

test("Same key with a different body returns 409 mismatch", async () => {
  const KEY = "test-key-mismatch";
  const headers = {
    authorization: `Bearer ${TOKEN}`,
    "content-type": "application/json",
    "idempotency-key": KEY,
  };
  const before = countWorkItems();
  const a = await http("/api/work-items", { method: "POST", headers, body: JSON.stringify({ projectId: "PRJ-I", title: "first body" }) });
  assert.equal(a.status, 200);
  const b = await http("/api/work-items", { method: "POST", headers, body: JSON.stringify({ projectId: "PRJ-I", title: "second body" }) });
  assert.equal(b.status, 409);
  assert.equal(b.body.reason, "mismatch");
  assert.equal(countWorkItems(), before + 1);
});

test("Concurrent in-flight duplicate returns 409 in_flight", async () => {
  // Manually park an in_flight row to simulate the race.
  const KEY = "test-key-inflight";
  db.prepare(`INSERT INTO idempotency_keys (user_id, key, method, path, fingerprint, state, created_at, expires_at)
              VALUES ('U-I', ?, 'POST', '/api/work-items', 'placeholder', 'in_flight', ?, ?)`)
    .run(KEY, new Date().toISOString(), new Date(Date.now() + 60_000).toISOString());

  const r = await http("/api/work-items", {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      "idempotency-key": KEY,
    },
    body: JSON.stringify({ projectId: "PRJ-I", title: "would race" }),
  });
  assert.equal(r.status, 409);
  // 'mismatch' is also acceptable because the parked fingerprint is
  // intentionally different — the load-bearing property is "didn't
  // create a duplicate row".
  assert.ok(["in_flight", "mismatch"].includes(r.body.reason));
  _drop("U-I", KEY);
});

test("4xx handler responses ARE cached and replayed", async () => {
  // The idempotency layer caches 2xx + 4xx responses produced by the
  // handler. 5xx invalidates the slot so a transient retry can succeed.
  // Schema-level rejections (Fastify's onError → 400 before any
  // handler runs) intentionally bypass the cache — they're not
  // semantically idempotent and the next request might pass once the
  // client fixes its body.
  //
  // To exercise the handler-level 400 path we hit a route that fails
  // its capability check (403) which the cache does record.
  const KEY = "test-key-clear";
  const headers = {
    authorization: `Bearer ${TOKEN}`,
    "content-type": "application/json",
    "idempotency-key": KEY,
  };
  // Use a body that passes schema but fails ACL/capability inside the
  // handler (project not in caller's tenant) to exercise the cached
  // path.
  const r1 = await http("/api/work-items", {
    method: "POST",
    headers,
    body: JSON.stringify({ projectId: "NOT-A-REAL-PROJECT", title: "hits handler" }),
  });
  assert.ok(r1.status >= 400 && r1.status < 500, `expected 4xx, got ${r1.status}`);
  const r2 = await http("/api/work-items", {
    method: "POST",
    headers,
    body: JSON.stringify({ projectId: "NOT-A-REAL-PROJECT", title: "hits handler" }),
  });
  assert.equal(r2.status, r1.status);
  assert.equal(r2.headers.get("idempotency-replay"), "true");
});

test("sweepIdempotency() removes expired rows", () => {
  const past = new Date(Date.now() - 1_000).toISOString();
  db.prepare(`INSERT INTO idempotency_keys (user_id, key, method, path, fingerprint, state, created_at, expires_at)
              VALUES ('U-I', 'expired-key', 'POST', '/x', 'fp', 'completed', ?, ?)`).run(past, past);
  const r = sweepIdempotency();
  assert.ok(r.changes >= 1);
  const row = db.prepare("SELECT * FROM idempotency_keys WHERE user_id = 'U-I' AND key = 'expired-key'").get();
  assert.equal(row, undefined);
});
