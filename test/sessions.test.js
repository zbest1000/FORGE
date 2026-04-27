// Session, refresh-token, and logout tests.
//
// Boots Fastify with the auth route, signs in via password to receive an
// access JWT + refresh token, then exercises rotation, reuse-detection,
// logout, list, and revoke-all.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sessions-"));
process.env.FORGE_DATA_DIR = tmpDir;
process.env.FORGE_TENANT_KEY = "forge-sessions-test-0123456789abcdef0123456789abcdef";
process.env.FORGE_JWT_SECRET = "forge-sessions-test-jwt-0123456789abcdef0123456789abcdef";
process.env.FORGE_RATELIMIT_MAX = "10000";
process.env.LOG_LEVEL = "warn";

const { db } = await import("../server/db.js");
const bcrypt = (await import("bcryptjs")).default;
const now = new Date().toISOString();
const ph = await bcrypt.hash("forge", 10);

db.prepare("INSERT INTO organizations (id, name, tenant_key, created_at) VALUES ('ORG-1','Atlas','atlas',?)").run(now);
db.prepare("INSERT INTO workspaces (id, org_id, name, region, created_at) VALUES ('WS-1','ORG-1','North','us-east',?)").run(now);
db.prepare("INSERT INTO users (id, org_id, email, name, role, password_hash, initials, disabled, created_at, updated_at) VALUES ('U-S','ORG-1','sess@forge.local','Sess','Engineer/Contributor',?,'SS',0,?,?)").run(ph, now, now);

const { default: Fastify } = await import("fastify");
const { default: jwt } = await import("@fastify/jwt");
const { default: cors } = await import("@fastify/cors");
const { userById } = await import("../server/auth.js");
const { resolveToken } = await import("../server/tokens.js");
const { authenticateAccess, listSessions } = await import("../server/sessions.js");

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
      const session = authenticateAccess({ sid: d.sid, jti: d.jti });
      if (!session) return;
      req.sessionId = session.id;
    }
    req.user = userById(d.sub);
  } catch {}
});
await app.register((await import("../server/routes/auth.js")).default);

await app.listen({ port: 0, host: "127.0.0.1" });
const addr = app.server.address();
const base = `http://127.0.0.1:${addr.port}`;
test.after(async () => { await app.close(); });

async function req(p, opts = {}) {
  const r = await fetch(base + p, opts);
  const ct = r.headers.get("content-type") || "";
  return { status: r.status, body: ct.includes("application/json") ? await r.json() : await r.text() };
}
const auth = (t) => ({ authorization: `Bearer ${t}` });

async function login() {
  const r = await req("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "sess@forge.local", password: "forge" }),
  });
  assert.equal(r.status, 200);
  return r.body;
}

test("login returns access JWT, refresh token, session id, and expiries", async () => {
  const body = await login();
  assert.ok(body.token);
  assert.match(body.refreshToken, /^fsr_SID-[A-Z0-9]+_/);
  assert.match(body.sessionId, /^SID-/);
  assert.ok(body.accessExpiresAt && body.refreshExpiresAt);
  assert.ok(Date.parse(body.accessExpiresAt) > Date.now());
  assert.ok(Date.parse(body.refreshExpiresAt) > Date.parse(body.accessExpiresAt));
});

test("access JWT is valid against /api/auth/sessions and lists current=true", async () => {
  const { token, sessionId } = await login();
  const r = await req("/api/auth/sessions", { headers: auth(token) });
  assert.equal(r.status, 200);
  const cur = r.body.find((s) => s.current);
  assert.ok(cur);
  assert.equal(cur.id, sessionId);
});

test("refresh rotates the access JWT and invalidates the old one", async () => {
  const first = await login();
  const r = await req("/api/auth/refresh", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshToken: first.refreshToken }),
  });
  assert.equal(r.status, 200);
  assert.ok(r.body.token);
  assert.notEqual(r.body.token, first.token);
  assert.notEqual(r.body.refreshToken, first.refreshToken);
  assert.equal(r.body.sessionId, first.sessionId);

  // Old access token must now fail because its jti has been rotated.
  const stale = await req("/api/auth/sessions", { headers: auth(first.token) });
  assert.equal(stale.status, 401);

  // New access token works.
  const fresh = await req("/api/auth/sessions", { headers: auth(r.body.token) });
  assert.equal(fresh.status, 200);
});

test("replaying a stale refresh token revokes the entire session", async () => {
  const first = await login();
  const rotated = await req("/api/auth/refresh", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshToken: first.refreshToken }),
  });
  assert.equal(rotated.status, 200);

  // Replay the original (now stale) refresh token. This is the
  // theft-detection path: the legitimate user has rotated, so a replay
  // proves the token leaked. Expected: rejection AND the session row
  // becomes revoked.
  const reuse = await req("/api/auth/refresh", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshToken: first.refreshToken }),
  });
  assert.equal(reuse.status, 400);

  // The legitimate (rotated) refresh now also fails because the session
  // was revoked as part of the reuse-detection response.
  const next = await req("/api/auth/refresh", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshToken: rotated.body.refreshToken }),
  });
  assert.equal(next.status, 401);
  assert.equal(next.body.error, "session_revoked");

  // And the rotated access JWT is dead too.
  const sessAfter = await req("/api/auth/sessions", { headers: auth(rotated.body.token) });
  assert.equal(sessAfter.status, 401);
});

test("logout revokes the current session: subsequent requests are 401", async () => {
  const body = await login();
  const out = await req("/api/auth/logout", {
    method: "POST",
    headers: auth(body.token),
  });
  assert.equal(out.status, 200);

  const after = await req("/api/auth/sessions", { headers: auth(body.token) });
  assert.equal(after.status, 401);

  // Refresh after logout fails too.
  const r = await req("/api/auth/refresh", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshToken: body.refreshToken }),
  });
  assert.equal(r.status, 401);
});

test("revoke-all kills every active session for the caller", async () => {
  const a = await login();
  const b = await login();

  // Both should be active.
  const list = await req("/api/auth/sessions", { headers: auth(b.token) });
  assert.equal(list.status, 200);
  const live = list.body.filter((s) => !s.revoked_at);
  assert.ok(live.length >= 2);

  const all = await req("/api/auth/sessions/revoke-all", { method: "POST", headers: auth(b.token) });
  assert.equal(all.status, 200);
  assert.ok(all.body.revoked >= 2);

  // Both tokens are dead.
  for (const t of [a.token, b.token]) {
    const r = await req("/api/auth/sessions", { headers: auth(t) });
    assert.equal(r.status, 401);
  }
});

test("DELETE /sessions/:id revokes a specific session and 404s for foreign sessions", async () => {
  const a = await login();
  const b = await login();
  const del = await req(`/api/auth/sessions/${a.sessionId}`, { method: "DELETE", headers: auth(b.token) });
  assert.equal(del.status, 200);

  const stale = await req("/api/auth/sessions", { headers: auth(a.token) });
  assert.equal(stale.status, 401);

  // Non-existent id: 404.
  const ghost = await req("/api/auth/sessions/SID-ZZZZZZZZZZZZ", { method: "DELETE", headers: auth(b.token) });
  assert.equal(ghost.status, 404);
});

test("invalid refresh tokens return 400 without revealing whether the session exists", async () => {
  const r = await req("/api/auth/refresh", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshToken: "fsr_BOGUS_xxxxxx" }),
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "invalid_refresh");

  const r2 = await req("/api/auth/refresh", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshToken: "garbage" }),
  });
  assert.equal(r2.status, 400);
});
