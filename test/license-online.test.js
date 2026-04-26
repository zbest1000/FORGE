// FORGE app: online activation via the local license server.
//
// Stands up a Fastify app that mimics the customer's local license
// server, points the FORGE app at it via FORGE_LOCAL_LS_URL +
// FORGE_LOCAL_LS_TOKEN, and exercises the whole pull→verify→
// materialise→getLicense pipeline. Uses a custom signing key for
// the test only, by overriding FORGE_LICENSE_PUBLIC_KEY.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-online-"));
process.env.FORGE_DATA_DIR = tmpDir;
process.env.FORGE_TENANT_KEY = "online-tenant-key-0123456789abcdef0123456789abcd";
process.env.FORGE_JWT_SECRET = "online-jwt-secret-0123456789abcdef0123456789abcd";
process.env.LOG_LEVEL = "warn";

// Generate an ad-hoc signing key for this test, then point the FORGE
// app's verifier at the matching public key.
const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
const pubPem = publicKey.export({ type: "spki", format: "pem" }).toString();
process.env.FORGE_LICENSE_PUBLIC_KEY = pubPem;

const { db } = await import("../server/db.js");
const now = new Date().toISOString();
db.prepare("INSERT INTO organizations (id, name, tenant_key, created_at) VALUES ('ORG-1','Org','tk',?)").run(now);
db.prepare("INSERT INTO workspaces (id, org_id, name, region, created_at) VALUES ('WS-1','ORG-1','WS','eu',?)").run(now);

const lic = await import("../server/license.js");
const { default: Fastify } = await import("fastify");

function canonicalJSON(obj) {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return "[" + obj.map(canonicalJSON).join(",") + "]";
  const k = Object.keys(obj).sort();
  return "{" + k.map(x => JSON.stringify(x) + ":" + canonicalJSON(obj[x])).join(",") + "}";
}
function b64u(b) { return Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function signEntitlement(payload, privKey = privateKey) {
  const canonical = canonicalJSON(payload);
  const sig = crypto.sign(null, Buffer.from(canonical, "utf8"), privKey);
  return "entitlement1." + b64u(canonical) + "." + b64u(sig);
}

async function startStubLocalLS({ payload, online = true, graceExpired = false, statusOverride = null, customer = "CUST-1" }) {
  const app = Fastify({ logger: false });
  app.get("/api/v1/entitlement", async (req, reply) => {
    if (statusOverride) {
      reply.code(statusOverride);
      return { error: "stub", message: "stub error" };
    }
    return {
      entitlement: signEntitlement(payload),
      bundle_id: payload.bundle_id,
      issued_at: payload.issued_at,
      expires_at: payload.expires_at,
      refresh_at: payload.refresh_at,
      online,
      grace_until: graceExpired ? new Date(Date.now() - 86_400_000).toISOString() : new Date(Date.now() + 86_400_000).toISOString(),
      grace_expired: graceExpired,
      customer: { id: customer, name: payload.customer_name },
      license: { id: payload.license_id, tier: payload.tier, term: payload.term, seats: payload.seats },
      last_central_at: new Date().toISOString(),
    };
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = app.server.address().port;
  return { app, url: `http://127.0.0.1:${port}` };
}

function buildPayload(over = {}) {
  return {
    v: 1, bundle_id: "ENT-T-" + Math.random().toString(36).slice(2, 8),
    customer_id: "CUST-1", customer_name: "Acme Corp",
    contact: "billing@acme.example",
    license_id: "LIC-T", tier: "team", edition: "team", term: "annual",
    seats: 25, deployment: "self_hosted",
    issued_at: new Date().toISOString(),
    starts_at: "2026-01-01T00:00:00Z",
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    license_expires_at: "2099-01-01T00:00:00Z",
    refresh_at: new Date(Date.now() + 1800_000).toISOString(),
    maintenance_until: null,
    features: { add: [], remove: [] },
    instance_id: "ULS-T",
    ...over,
  };
}

test("pollLocalLicenseServer activates the FORGE app from a stub local LS", async () => {
  lic._setOnlineMaterialisedForTest(null);
  const stub = await startStubLocalLS({ payload: buildPayload({ tier: "enterprise", seats: 50 }) });
  process.env.FORGE_LOCAL_LS_URL = stub.url;
  process.env.FORGE_LOCAL_LS_TOKEN = "lan-shared-token-1234567890abcdef";
  try {
    const r = await lic.pollLocalLicenseServer();
    assert.ok(r, "poll returned a verdict");
    assert.equal(r.source, "local_ls");
    assert.equal(r.tier, "enterprise");
    assert.equal(r.seats, 50);
    assert.equal(r.customer, "Acme Corp");
    assert.ok(lic.hasFeature(lic.FEATURES.GRAPHQL_API, lic.getLicense({ skipCache: true })));
  } finally {
    await stub.app.close();
    delete process.env.FORGE_LOCAL_LS_URL;
    delete process.env.FORGE_LOCAL_LS_TOKEN;
    lic._setOnlineMaterialisedForTest(null);
  }
});

test("pollLocalLicenseServer rejects entitlements signed by the wrong vendor key", async () => {
  lic._setOnlineMaterialisedForTest(null);
  const { privateKey: rogue } = crypto.generateKeyPairSync("ed25519");
  const Fastify2 = (await import("fastify")).default;
  const app = Fastify2({ logger: false });
  app.get("/api/v1/entitlement", async () => ({
    entitlement: signEntitlement(buildPayload(), rogue),
    bundle_id: "ENT-FORGED",
    customer: { id: "CUST-1", name: "Forger" },
    license: { id: "LIC-X", tier: "enterprise" },
    online: true,
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    refresh_at: new Date(Date.now() + 1800_000).toISOString(),
  }));
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = app.server.address().port;
  process.env.FORGE_LOCAL_LS_URL = `http://127.0.0.1:${port}`;
  process.env.FORGE_LOCAL_LS_TOKEN = "lan-shared-token-1234567890abcdef";
  try {
    const r = await lic.pollLocalLicenseServer();
    assert.equal(r, null, "poll returned null on signature mismatch");
    const status = lic.localLicenseStatus();
    assert.match(status.last_error || "", /signature_invalid/);
  } finally {
    await app.close();
    delete process.env.FORGE_LOCAL_LS_URL;
    delete process.env.FORGE_LOCAL_LS_TOKEN;
    lic._setOnlineMaterialisedForTest(null);
  }
});

test("FORGE_EXPECTED_CUSTOMER_ID protects against a swapped local LS", async () => {
  lic._setOnlineMaterialisedForTest(null);
  const stub = await startStubLocalLS({ payload: buildPayload(), customer: "CUST-WRONG" });
  process.env.FORGE_LOCAL_LS_URL = stub.url;
  process.env.FORGE_LOCAL_LS_TOKEN = "lan-shared-token-1234567890abcdef";
  process.env.FORGE_EXPECTED_CUSTOMER_ID = "CUST-1";
  try {
    const r = await lic.pollLocalLicenseServer();
    assert.equal(r, null);
    assert.match(lic.localLicenseStatus().last_error || "", /customer_id_mismatch/);
  } finally {
    await stub.app.close();
    delete process.env.FORGE_LOCAL_LS_URL;
    delete process.env.FORGE_LOCAL_LS_TOKEN;
    delete process.env.FORGE_EXPECTED_CUSTOMER_ID;
    lic._setOnlineMaterialisedForTest(null);
  }
});

test("offline grace expiry downgrades to community feature set", async () => {
  lic._setOnlineMaterialisedForTest(null);
  const stub = await startStubLocalLS({
    payload: buildPayload({ tier: "enterprise", seats: 100 }),
    online: false,
    graceExpired: true,
  });
  process.env.FORGE_LOCAL_LS_URL = stub.url;
  process.env.FORGE_LOCAL_LS_TOKEN = "lan-shared-token-1234567890abcdef";
  try {
    const r = await lic.pollLocalLicenseServer();
    assert.equal(r.status, "offline_grace_expired");
    assert.equal(r.tier, "community");
    assert.equal(lic.hasFeature(lic.FEATURES.GRAPHQL_API, r), false);
  } finally {
    await stub.app.close();
    delete process.env.FORGE_LOCAL_LS_URL;
    delete process.env.FORGE_LOCAL_LS_TOKEN;
    lic._setOnlineMaterialisedForTest(null);
  }
});

test("local LS HTTP failure leaves FORGE in 'not_activated' state", async () => {
  lic._setOnlineMaterialisedForTest(null);
  // Point at an unused port so the connect fails quickly.
  process.env.FORGE_LOCAL_LS_URL = "http://127.0.0.1:1";
  process.env.FORGE_LOCAL_LS_TOKEN = "lan-shared-token-1234567890abcdef";
  try {
    const r = await lic.pollLocalLicenseServer();
    assert.equal(r, null);
    const verdict = lic.getLicense({ skipCache: true });
    assert.equal(verdict.status, "not_activated");
    assert.equal(verdict.source, "local_ls_unreachable");
    // While not activated, gated features must be unavailable.
    assert.equal(lic.hasFeature(lic.FEATURES.GRAPHQL_API, verdict), false);
  } finally {
    delete process.env.FORGE_LOCAL_LS_URL;
    delete process.env.FORGE_LOCAL_LS_TOKEN;
    lic._setOnlineMaterialisedForTest(null);
  }
});
