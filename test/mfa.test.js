// MFA flow tests:
//   1. TOTP / HOTP / base32 round-trips against published RFC test vectors.
//   2. Enrolment → activate → login challenge → verify happy path.
//   3. Recovery codes are accepted exactly once.
//   4. Sensitive endpoints (disable, regenerate) require a fresh code.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-mfa-"));
process.env.FORGE_DATA_DIR = tmpDir;
process.env.FORGE_TENANT_KEY = "forge-mfa-test-0123456789abcdef0123456789abcdef";
// IMPORTANT: the challenge token signs with this secret; set BEFORE
// importing mfa.js so its baseline configuration matches.
process.env.FORGE_JWT_SECRET = "forge-mfa-test-jwt-0123456789abcdef0123456789abcdef";
process.env.FORGE_RATELIMIT_MAX = "10000";
process.env.LOG_LEVEL = "warn";

const { db } = await import("../server/db.js");
const bcrypt = (await import("bcryptjs")).default;
const now = new Date().toISOString();
const ph = await bcrypt.hash("forge", 10);

db.prepare("INSERT INTO organizations (id, name, tenant_key, created_at) VALUES ('ORG-1','Atlas','atlas',?)").run(now);
db.prepare("INSERT INTO workspaces (id, org_id, name, region, created_at) VALUES ('WS-1','ORG-1','North','us-east',?)").run(now);
db.prepare("INSERT INTO users (id, org_id, email, name, role, password_hash, initials, disabled, created_at, updated_at) VALUES ('U-MFA','ORG-1','mfa@forge.local','MFA User','Engineer/Contributor',?,'MU',0,?,?)").run(ph, now, now);

const mfa = await import("../server/mfa.js");

// ---------------- Pure-function tests ----------------

test("totpAt produces a stable 6-digit code for a fixed timestamp", () => {
  // RFC 6238 reference uses the secret "12345678901234567890" (ASCII).
  // Base32 of that ASCII is "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ".
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  const code = mfa.totpAt(secret, 59);
  assert.match(code, /^\d{6}$/);
  // SHA-1 RFC 6238 vector at t=59 → 94287082; we use the same algorithm.
  assert.equal(code, "287082");
});

test("verifyTotp accepts ±30s skew and rejects unrelated codes", () => {
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  const t = 1_111_111_109; // arbitrary
  const code = mfa.totpAt(secret, t);
  assert.notEqual(mfa.verifyTotp(secret, code, t), null);
  assert.notEqual(mfa.verifyTotp(secret, code, t + 29), null);
  assert.notEqual(mfa.verifyTotp(secret, code, t - 29), null);
  assert.equal(mfa.verifyTotp(secret, code, t + 120), null);
  assert.equal(mfa.verifyTotp(secret, "000000", t), null);
  assert.equal(mfa.verifyTotp(secret, "abcdef", t), null);
});

test("issued challenge round-trips and is bound to the user", () => {
  const tok = mfa.issueChallenge("U-MFA");
  const decoded = mfa.consumeChallenge(tok);
  assert.equal(decoded.sub, "U-MFA");
  assert.equal(decoded.mfa, true);
  // Tampering with the signature must invalidate the token. Flip the
  // last char to a value guaranteed to differ — a blanket
  // `tok.replace(/.$/, "0")` is a no-op when the sig already ends in
  // `0` (~1/16 of all runs in hex), which used to flake the macOS CI.
  const last = tok.slice(-1);
  const tampered = tok.slice(0, -1) + (last === "0" ? "1" : "0");
  assert.equal(mfa.consumeChallenge(tampered), null);
  assert.equal(mfa.consumeChallenge("mfa1.bogus.deadbeef"), null);
});

// ---------------- Live HTTP flow ----------------

const { default: Fastify } = await import("fastify");
const { default: jwt } = await import("@fastify/jwt");
const { default: cors } = await import("@fastify/cors");
const { userById } = await import("../server/auth.js");
const { resolveToken } = await import("../server/tokens.js");

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

let JWT;
let MFA_SECRET;
let RECOVERY;

test("login without MFA enabled returns a JWT directly", async () => {
  const r = await req("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "mfa@forge.local", password: "forge" }),
  });
  assert.equal(r.status, 200);
  assert.ok(r.body.token);
  assert.equal(r.body.mfaRequired, undefined);
  JWT = r.body.token;
});

test("status reports 'not enabled' before enrolment", async () => {
  const r = await req("/api/auth/mfa/status", { headers: auth(JWT) });
  assert.equal(r.status, 200);
  assert.equal(r.body.enabled, false);
  assert.equal(r.body.pending, false);
});

test("enrol → activate completes with a fresh TOTP code and returns recovery codes", async () => {
  const enrol = await req("/api/auth/mfa/enrol", { method: "POST", headers: auth(JWT) });
  assert.equal(enrol.status, 200);
  assert.match(enrol.body.secret, /^[A-Z2-7]+$/);
  assert.match(enrol.body.otpauthUrl, /^otpauth:\/\/totp\//);
  MFA_SECRET = enrol.body.secret;

  // Activate must reject a wrong code.
  const bad = await req("/api/auth/mfa/activate", {
    method: "POST",
    headers: { ...auth(JWT), "content-type": "application/json" },
    body: JSON.stringify({ code: "000000" }),
  });
  assert.equal(bad.status, 400);

  const code = mfa.totpAt(MFA_SECRET, Date.now() / 1000);
  const ok = await req("/api/auth/mfa/activate", {
    method: "POST",
    headers: { ...auth(JWT), "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.recoveryCodes.length, 10);
  RECOVERY = ok.body.recoveryCodes;

  const status = await req("/api/auth/mfa/status", { headers: auth(JWT) });
  assert.equal(status.body.enabled, true);
  assert.equal(status.body.recovery_count, 10);
});

test("login now returns mfaRequired + challenge, no JWT", async () => {
  const r = await req("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "mfa@forge.local", password: "forge" }),
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.mfaRequired, true);
  assert.ok(r.body.challenge);
  assert.equal(r.body.token, undefined);
});

test("verify with the right TOTP code mints a JWT", async () => {
  const login = await req("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "mfa@forge.local", password: "forge" }),
  });
  const code = mfa.totpAt(MFA_SECRET, Date.now() / 1000);
  const r = await req("/api/auth/mfa/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ challenge: login.body.challenge, mfaCode: code }),
  });
  assert.equal(r.status, 200);
  assert.ok(r.body.token);
});

test("verify with an invalid code is rejected", async () => {
  const login = await req("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "mfa@forge.local", password: "forge" }),
  });
  const r = await req("/api/auth/mfa/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ challenge: login.body.challenge, mfaCode: "000000" }),
  });
  assert.equal(r.status, 401);
});

test("recovery codes are accepted exactly once", async () => {
  const login = await req("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "mfa@forge.local", password: "forge" }),
  });
  const code = RECOVERY[0];
  const r = await req("/api/auth/mfa/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ challenge: login.body.challenge, recoveryCode: code }),
  });
  assert.equal(r.status, 200);

  // Re-using the same recovery code on a fresh challenge must fail.
  const login2 = await req("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "mfa@forge.local", password: "forge" }),
  });
  const r2 = await req("/api/auth/mfa/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ challenge: login2.body.challenge, recoveryCode: code }),
  });
  assert.equal(r2.status, 401);
});

test("sensitive MFA management requires a fresh code", async () => {
  // Disable without code → 401.
  const noCode = await req("/api/auth/mfa/disable", {
    method: "POST",
    headers: { ...auth(JWT), "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(noCode.status, 401);

  // Disable with a fresh TOTP code → 200, MFA is removed.
  const code = mfa.totpAt(MFA_SECRET, Date.now() / 1000);
  const ok = await req("/api/auth/mfa/disable", {
    method: "POST",
    headers: { ...auth(JWT), "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  assert.equal(ok.status, 200);
  const after = await req("/api/auth/mfa/status", { headers: auth(JWT) });
  assert.equal(after.body.enabled, false);
});

test("login.body shape is unchanged when caller supplies mfaCode in the original POST", async () => {
  // Re-enrol to set up MFA again.
  const enrol = await req("/api/auth/mfa/enrol", { method: "POST", headers: auth(JWT) });
  const sec = enrol.body.secret;
  const c1 = mfa.totpAt(sec, Date.now() / 1000);
  await req("/api/auth/mfa/activate", { method: "POST", headers: { ...auth(JWT), "content-type": "application/json" }, body: JSON.stringify({ code: c1 }) });

  const c2 = mfa.totpAt(sec, Date.now() / 1000);
  const r = await req("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "mfa@forge.local", password: "forge", mfaCode: c2 }),
  });
  assert.equal(r.status, 200);
  assert.ok(r.body.token);
  assert.equal(r.body.mfaRequired, undefined);
});
