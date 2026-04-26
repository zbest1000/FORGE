// License module + /api/license endpoint + feature gating tests.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-license-"));
process.env.FORGE_DATA_DIR = tmpDir;
process.env.FORGE_TENANT_KEY = "license-key-0123456789abcdef0123456789abcdef";
process.env.FORGE_JWT_SECRET = "license-jwt-0123456789abcdef0123456789abcdef";
process.env.LOG_LEVEL = "warn";

const { db } = await import("../server/db.js");
const bcrypt = (await import("bcryptjs")).default;
const now = new Date().toISOString();

db.prepare("INSERT INTO organizations (id, name, tenant_key, created_at) VALUES ('ORG-1','A','a',?)").run(now);
db.prepare("INSERT INTO workspaces (id, org_id, name, region, created_at) VALUES ('WS-1','ORG-1','WS','us-east',?)").run(now);
db.prepare("INSERT INTO users (id, org_id, email, name, role, password_hash, initials, disabled, created_at, updated_at) VALUES ('U-OWNER','ORG-1','owner@x','Owner','Organization Owner',?, 'OW',0,?,?)")
  .run(await bcrypt.hash("forge", 10), now, now);
db.prepare("INSERT INTO users (id, org_id, email, name, role, password_hash, initials, disabled, created_at, updated_at) VALUES ('U-VIEW','ORG-1','view@x','View','Viewer/Auditor',?, 'VW',0,?,?)")
  .run(await bcrypt.hash("forge", 10), now, now);

const lic = await import("../server/license.js");
const {
  signLicense, verifyLicense, installLicense, uninstallLicense,
  getLicense, hasFeature, requireFeature, publicEntitlements,
  FEATURES, TIERS, DEV_PRIVATE_KEY_PEM, clearLicenseCache,
  canAddUser, activeUserCount,
} = lic;

test("sign + verify roundtrip succeeds with the dev key", () => {
  const token = signLicense({
    license_id: "T-1", customer: "Acme", tier: "team", term: "annual",
    seats: 5, issued_at: "2026-01-01T00:00:00Z", expires_at: "2027-01-01T00:00:00Z",
  }, DEV_PRIVATE_KEY_PEM);
  const v = verifyLicense(token);
  assert.equal(v.signature_ok, true);
  assert.equal(v.payload.customer, "Acme");
  assert.equal(v.payload.tier, "team");
});

test("tampered token fails signature verification", () => {
  const token = signLicense({
    license_id: "T-2", customer: "Acme", tier: "team", term: "annual",
    seats: 5, issued_at: "2026-01-01T00:00:00Z", expires_at: "2027-01-01T00:00:00Z",
  }, DEV_PRIVATE_KEY_PEM);
  // Flip a byte in the payload portion.
  const [prefix, body, sig] = [token.slice(0, 7), token.slice(7).split(".")[0], token.slice(7).split(".")[1]];
  const tampered = prefix + body.slice(0, -2) + "AA" + "." + sig;
  const v = verifyLicense(tampered);
  assert.equal(v.signature_ok, false);
});

test("installLicense persists token and getLicense materialises features", () => {
  clearLicenseCache();
  uninstallLicense();
  const token = signLicense({
    license_id: "T-3", customer: "Acme", tier: "enterprise", term: "annual",
    seats: 100, issued_at: "2026-01-01T00:00:00Z", expires_at: "2099-01-01T00:00:00Z",
  }, DEV_PRIVATE_KEY_PEM);
  installLicense(token, { actor: "U-OWNER" });
  const live = getLicense({ skipCache: true });
  assert.equal(live.tier, "enterprise");
  assert.equal(live.customer, "Acme");
  assert.equal(live.status, "ok");
  assert.ok(hasFeature(FEATURES.GRAPHQL_API, live), "enterprise has graphql");
  assert.ok(hasFeature(FEATURES.HA_DEPLOYMENT, live), "enterprise has HA");
});

test("annual license expired falls back to community tier", () => {
  clearLicenseCache();
  uninstallLicense();
  const past = "2020-01-01T00:00:00Z";
  const token = signLicense({
    license_id: "T-4", customer: "Lapsed", tier: "team", term: "annual",
    seats: 5, issued_at: "2019-01-01T00:00:00Z", expires_at: past,
  }, DEV_PRIVATE_KEY_PEM);
  installLicense(token, { actor: "U-OWNER" });
  const live = getLicense({ skipCache: true });
  assert.equal(live.status, "expired");
  assert.equal(live.tier, "community");
  assert.equal(hasFeature(FEATURES.GRAPHQL_API, live), false, "expired license loses GraphQL");
  assert.equal(hasFeature(FEATURES.PDF_VIEWER, live), true, "community keeps PDF viewer");
});

test("perpetual license never expires; maintenance window tracked separately", () => {
  clearLicenseCache();
  uninstallLicense();
  const token = signLicense({
    license_id: "T-5", customer: "Forever", tier: "enterprise", term: "perpetual",
    seats: 10, issued_at: "2026-01-01T00:00:00Z",
    maintenance_until: "2027-01-01T00:00:00Z",
  }, DEV_PRIVATE_KEY_PEM);
  installLicense(token, { actor: "U-OWNER" });
  const live = getLicense({ skipCache: true });
  assert.equal(live.status, "ok");
  assert.equal(live.term, "perpetual");
  assert.equal(live.expires_at, null);
  assert.equal(live.maintenance_until, "2027-01-01T00:00:00Z");
  assert.ok(hasFeature(FEATURES.HA_DEPLOYMENT, live));
});

test("features.add and features.remove modify tier defaults", () => {
  clearLicenseCache();
  uninstallLicense();
  const token = signLicense({
    license_id: "T-6", customer: "Custom", tier: "team", term: "annual",
    seats: 5, issued_at: "2026-01-01T00:00:00Z", expires_at: "2099-01-01T00:00:00Z",
    features: { add: [FEATURES.HA_DEPLOYMENT], remove: [FEATURES.MQTT_BRIDGE] },
  }, DEV_PRIVATE_KEY_PEM);
  installLicense(token, { actor: "U-OWNER" });
  const live = getLicense({ skipCache: true });
  assert.ok(hasFeature(FEATURES.HA_DEPLOYMENT, live), "added feature is present");
  assert.equal(hasFeature(FEATURES.MQTT_BRIDGE, live), false, "removed feature is gone");
});

test("seat count enforcement: soft + hard caps", () => {
  clearLicenseCache();
  uninstallLicense();
  const token = signLicense({
    license_id: "T-7", customer: "Tight", tier: "team", term: "annual",
    seats: 2, issued_at: "2026-01-01T00:00:00Z", expires_at: "2099-01-01T00:00:00Z",
  }, DEV_PRIVATE_KEY_PEM);
  installLicense(token, { actor: "U-OWNER" });
  const live = getLicense({ skipCache: true });
  assert.equal(live.seats, 2);

  // 2 active users in the seed for this test (U-OWNER, U-VIEW). 3rd hits soft cap.
  const a = canAddUser(live);
  assert.equal(a.used, 2);
  assert.equal(a.allowed, true, "still allowed because hard cap on team is 30");
});

test("requireFeature pre-handler blocks with 402 when feature absent", async () => {
  clearLicenseCache();
  uninstallLicense();
  // No license installed → community tier, GraphQL absent.
  const live = getLicense({ skipCache: true });
  assert.equal(hasFeature(FEATURES.GRAPHQL_API, live), false);

  const Fastify = (await import("fastify")).default;
  const app = Fastify({ logger: false });
  app.get("/gated", { onRequest: requireFeature(FEATURES.GRAPHQL_API) }, async () => "ok");
  app.get("/open", { onRequest: requireFeature(FEATURES.PDF_VIEWER) }, async () => "ok");

  const r1 = await app.inject({ method: "GET", url: "/gated" });
  assert.equal(r1.statusCode, 402);
  assert.equal(JSON.parse(r1.body).error, "feature_not_licensed");
  assert.equal(JSON.parse(r1.body).feature, FEATURES.GRAPHQL_API);

  const r2 = await app.inject({ method: "GET", url: "/open" });
  assert.equal(r2.statusCode, 200);
  await app.close();
});

test("/api/license endpoint reads + installs + uninstalls", async () => {
  clearLicenseCache();
  uninstallLicense();
  const Fastify = (await import("fastify")).default;
  const fjwt = (await import("@fastify/jwt")).default;
  const { userById } = await import("../server/auth.js");
  const licenseRoutes = (await import("../server/routes/license.js")).default;

  const app = Fastify({ logger: false });
  await app.register(fjwt, { secret: process.env.FORGE_JWT_SECRET });
  app.addHook("onRequest", async (req) => {
    const h = req.headers.authorization || "";
    const tok = h.startsWith("Bearer ") ? h.slice(7) : null;
    req.user = null;
    if (!tok) return;
    try { const d = app.jwt.verify(tok); req.user = d?.sub ? userById(d.sub) : null; } catch {}
  });
  await app.register(licenseRoutes);

  const ownerToken = app.jwt.sign({ sub: "U-OWNER" });
  const viewerToken = app.jwt.sign({ sub: "U-VIEW" });

  // Unauthenticated → 401.
  let r = await app.inject({ method: "GET", url: "/api/license" });
  assert.equal(r.statusCode, 401);

  // Authenticated → community fallback summary.
  r = await app.inject({ method: "GET", url: "/api/license", headers: { authorization: "Bearer " + viewerToken } });
  assert.equal(r.statusCode, 200);
  let body = JSON.parse(r.body);
  assert.equal(body.tier, "community");
  assert.equal(body.source, "fallback");

  // Viewer cannot install.
  r = await app.inject({
    method: "POST", url: "/api/license",
    headers: { authorization: "Bearer " + viewerToken, "content-type": "application/json" },
    payload: { token: "anything" },
  });
  assert.equal(r.statusCode, 403);

  // Owner can install a real signed token.
  const token = signLicense({
    license_id: "T-API", customer: "API Test", tier: "team", term: "annual",
    seats: 5, issued_at: "2026-01-01T00:00:00Z", expires_at: "2099-01-01T00:00:00Z",
  }, DEV_PRIVATE_KEY_PEM);
  r = await app.inject({
    method: "POST", url: "/api/license",
    headers: { authorization: "Bearer " + ownerToken, "content-type": "application/json" },
    payload: { token },
  });
  assert.equal(r.statusCode, 200);
  body = JSON.parse(r.body);
  assert.equal(body.tier, "team");
  assert.equal(body.customer, "API Test");

  // Owner can uninstall.
  r = await app.inject({
    method: "DELETE", url: "/api/license",
    headers: { authorization: "Bearer " + ownerToken },
  });
  assert.equal(r.statusCode, 200);
  body = JSON.parse(r.body);
  assert.equal(body.source, "fallback");

  await app.close();
});

test("invalid token returns 422 with reasons", async () => {
  clearLicenseCache();
  uninstallLicense();
  const Fastify = (await import("fastify")).default;
  const fjwt = (await import("@fastify/jwt")).default;
  const { userById } = await import("../server/auth.js");
  const licenseRoutes = (await import("../server/routes/license.js")).default;

  const app = Fastify({ logger: false });
  await app.register(fjwt, { secret: process.env.FORGE_JWT_SECRET });
  app.addHook("onRequest", async (req) => {
    const h = req.headers.authorization || "";
    const tok = h.startsWith("Bearer ") ? h.slice(7) : null;
    req.user = null;
    if (!tok) return;
    try { const d = app.jwt.verify(tok); req.user = d?.sub ? userById(d.sub) : null; } catch {}
  });
  await app.register(licenseRoutes);

  const ownerToken = app.jwt.sign({ sub: "U-OWNER" });
  // Forge a payload but sign with a different key.
  const crypto = await import("node:crypto");
  const { privateKey: rogue } = crypto.generateKeyPairSync("ed25519");
  const forged = signLicense({
    license_id: "FAKE", customer: "Forger", tier: "enterprise", term: "perpetual",
    seats: 9999, issued_at: "2026-01-01T00:00:00Z",
  }, rogue);

  const r = await app.inject({
    method: "POST", url: "/api/license",
    headers: { authorization: "Bearer " + ownerToken, "content-type": "application/json" },
    payload: { token: forged },
  });
  assert.equal(r.statusCode, 422);
  const body = JSON.parse(r.body);
  assert.equal(body.error, "license_invalid");
  assert.ok(Array.isArray(body.reasons));

  await app.close();
});
