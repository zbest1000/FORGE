// FORGE app: online activation via the local license server.
//
// New model:
//   - Local LS issues a long-lived signed activation token.
//   - FORGE pulls it once, persists it under FORGE_DATA_DIR, and
//     re-verifies the signature + datetime on every read.
//   - A daily heartbeat (also routed through the local LS) detects
//     supersession / release / revoke and downgrades the FORGE app
//     to the Community plan if the seat is no longer ours.
//   - releaseActivation() returns the seat to the pool and clears
//     the persisted token.

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
process.env.FORGE_SKIP_FINGERPRINT = "1"; // tests don't model host binding

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
function signActivation(payload, privKey = privateKey) {
  const canonical = canonicalJSON(payload);
  const sig = crypto.sign(null, Buffer.from(canonical, "utf8"), privKey);
  return "entitlement1." + b64u(canonical) + "." + b64u(sig);
}

function buildPayload(over = {}) {
  return {
    v: 1,
    activation_id: "ACT-" + Math.random().toString(36).slice(2, 8).toUpperCase(),
    activation_token_id: "TOK-" + Math.random().toString(36).slice(2, 8).toUpperCase(),
    instance_id: "ULS-T",
    bound_fingerprint: {},
    customer_id: "CUST-1", customer_name: "Acme Corp",
    contact: "billing@acme.example",
    license_id: "LIC-T", tier: "team", edition: "team", term: "annual",
    seats: 25, deployment: "self_hosted",
    issued_at: new Date().toISOString(),
    starts_at: "2026-01-01T00:00:00Z",
    license_expires_at: "2099-01-01T00:00:00Z",
    maintenance_until: null,
    features: { add: [], remove: [] },
    ...over,
  };
}

async function startStubLocalLS({ payload, activationStatus = "active", supersededBy = null, releasedAt = null, revokedAt = null, customer = "CUST-1", releaseHandler = null, activateHandler = null }) {
  const app = Fastify({ logger: false });
  app.get("/api/v1/entitlement", async () => ({
    activation_token: signActivation(payload),
    activation_id: payload.activation_id,
    activation_token_id: payload.activation_token_id,
    issued_at: payload.issued_at,
    activation_status: activationStatus,
    superseded_by: supersededBy,
    released_at: releasedAt,
    revoked_at: revokedAt,
    customer: { id: customer, name: payload.customer_name },
    license: { id: payload.license_id, tier: payload.tier, term: payload.term, seats: payload.seats },
    last_heartbeat_at: new Date().toISOString(),
    instance_id: payload.instance_id,
  }));
  app.post("/api/v1/release", async () => releaseHandler ? releaseHandler() : ({ ok: true, status: "released", released_at: new Date().toISOString() }));
  app.post("/api/v1/activate-now", async () => activateHandler ? activateHandler() : ({ ok: true }));
  await app.listen({ port: 0, host: "127.0.0.1" });
  return { app, url: `http://127.0.0.1:${app.server.address().port}` };
}

function clearPersistedActivation() {
  try { fs.unlinkSync(path.join(tmpDir, "activation.json")); } catch {}
  lic._setOnlineMaterialisedForTest(null);
}

test("first activation: pulls token, persists it, materialises enterprise features", async () => {
  clearPersistedActivation();
  const stub = await startStubLocalLS({ payload: buildPayload({ tier: "enterprise", seats: 50 }) });
  process.env.FORGE_LOCAL_LS_URL = stub.url;
  process.env.FORGE_LOCAL_LS_TOKEN = "lan-shared-token-1234567890abcdef";
  try {
    const r = await lic.pollLocalLicenseServer();
    assert.ok(r);
    assert.equal(r.tier, "enterprise");
    assert.equal(r.seats, 50);
    assert.equal(r.activation_status, "active");
    assert.ok(r.activation_id?.startsWith("ACT-"));
    assert.ok(r.activation_token_id?.startsWith("TOK-"));
    // The token should now be persisted on disk so the next boot
    // works offline.
    assert.ok(fs.existsSync(path.join(tmpDir, "activation.json")));
    assert.ok(lic.hasFeature(lic.FEATURES.GRAPHQL_API, lic.getLicense({ skipCache: true })));
  } finally {
    await stub.app.close();
    delete process.env.FORGE_LOCAL_LS_URL;
    delete process.env.FORGE_LOCAL_LS_TOKEN;
    clearPersistedActivation();
  }
});

test("loadPersistedActivation: subsequent boots run fully offline", async () => {
  clearPersistedActivation();
  // Seed disk via a single online poll, then turn the network off.
  const stub = await startStubLocalLS({ payload: buildPayload({ tier: "enterprise" }) });
  process.env.FORGE_LOCAL_LS_URL = stub.url;
  process.env.FORGE_LOCAL_LS_TOKEN = "lan-shared-token-1234567890abcdef";
  await lic.pollLocalLicenseServer();
  await stub.app.close();
  // Drop in-memory state but keep the file.
  lic._setOnlineMaterialisedForTest(null);
  // Without re-touching the network, loadPersistedActivation should
  // reconstruct the verdict.
  const restored = lic.loadPersistedActivation();
  assert.ok(restored, "persisted activation restored");
  assert.equal(restored.tier, "enterprise");
  assert.equal(restored.activation_status, "active");
  delete process.env.FORGE_LOCAL_LS_URL;
  delete process.env.FORGE_LOCAL_LS_TOKEN;
  clearPersistedActivation();
});

test("heartbeat reports superseded → FORGE downgrades to Community", async () => {
  clearPersistedActivation();
  const payload = buildPayload({ tier: "enterprise", seats: 50 });
  const stub = await startStubLocalLS({
    payload, activationStatus: "superseded", supersededBy: "ACT-OTHER",
  });
  process.env.FORGE_LOCAL_LS_URL = stub.url;
  process.env.FORGE_LOCAL_LS_TOKEN = "lan-shared-token-1234567890abcdef";
  try {
    const r = await lic.pollLocalLicenseServer();
    assert.equal(r.status, "superseded");
    assert.equal(r.tier, "community");
    assert.equal(r.activation_status, "superseded");
    assert.equal(r.superseded_by, "ACT-OTHER");
    assert.equal(lic.hasFeature(lic.FEATURES.GRAPHQL_API, r), false);
  } finally {
    await stub.app.close();
    delete process.env.FORGE_LOCAL_LS_URL;
    delete process.env.FORGE_LOCAL_LS_TOKEN;
    clearPersistedActivation();
  }
});

test("heartbeat reports released → FORGE downgrades and reflects release", async () => {
  clearPersistedActivation();
  const payload = buildPayload({ tier: "enterprise" });
  const stub = await startStubLocalLS({
    payload, activationStatus: "released", releasedAt: new Date().toISOString(),
  });
  process.env.FORGE_LOCAL_LS_URL = stub.url;
  process.env.FORGE_LOCAL_LS_TOKEN = "lan-shared-token-1234567890abcdef";
  try {
    const r = await lic.pollLocalLicenseServer();
    assert.equal(r.status, "released");
    assert.equal(r.tier, "community");
    assert.ok(r.released_at);
  } finally {
    await stub.app.close();
    delete process.env.FORGE_LOCAL_LS_URL;
    delete process.env.FORGE_LOCAL_LS_TOKEN;
    clearPersistedActivation();
  }
});

test("heartbeat reports revoked → FORGE downgrades", async () => {
  clearPersistedActivation();
  const stub = await startStubLocalLS({
    payload: buildPayload({ tier: "team" }),
    activationStatus: "revoked", revokedAt: new Date().toISOString(),
  });
  process.env.FORGE_LOCAL_LS_URL = stub.url;
  process.env.FORGE_LOCAL_LS_TOKEN = "lan-shared-token-1234567890abcdef";
  try {
    const r = await lic.pollLocalLicenseServer();
    assert.equal(r.status, "revoked");
    assert.equal(r.tier, "community");
  } finally {
    await stub.app.close();
    delete process.env.FORGE_LOCAL_LS_URL;
    delete process.env.FORGE_LOCAL_LS_TOKEN;
    clearPersistedActivation();
  }
});

test("clock-back tampering: token issued in the future is refused", async () => {
  clearPersistedActivation();
  const future = new Date(Date.now() + 7 * 86_400_000).toISOString();
  const stub = await startStubLocalLS({
    payload: buildPayload({ tier: "enterprise", issued_at: future }),
  });
  process.env.FORGE_LOCAL_LS_URL = stub.url;
  process.env.FORGE_LOCAL_LS_TOKEN = "lan-shared-token-1234567890abcdef";
  try {
    const r = await lic.pollLocalLicenseServer();
    assert.equal(r.status, "clock_tampered");
    assert.equal(r.tier, "community");
    assert.equal(lic.hasFeature(lic.FEATURES.GRAPHQL_API, r), false);
  } finally {
    await stub.app.close();
    delete process.env.FORGE_LOCAL_LS_URL;
    delete process.env.FORGE_LOCAL_LS_TOKEN;
    clearPersistedActivation();
  }
});

test("license expired: downgrades to Community even with a valid signature", async () => {
  clearPersistedActivation();
  const stub = await startStubLocalLS({
    payload: buildPayload({ tier: "enterprise", license_expires_at: "2020-01-01T00:00:00Z" }),
  });
  process.env.FORGE_LOCAL_LS_URL = stub.url;
  process.env.FORGE_LOCAL_LS_TOKEN = "lan-shared-token-1234567890abcdef";
  try {
    const r = await lic.pollLocalLicenseServer();
    assert.equal(r.status, "expired");
    assert.equal(r.tier, "community");
  } finally {
    await stub.app.close();
    delete process.env.FORGE_LOCAL_LS_URL;
    delete process.env.FORGE_LOCAL_LS_TOKEN;
    clearPersistedActivation();
  }
});

test("forged signature is rejected and persisted file is not written", async () => {
  clearPersistedActivation();
  const { privateKey: rogue } = crypto.generateKeyPairSync("ed25519");
  const Fastify2 = (await import("fastify")).default;
  const app = Fastify2({ logger: false });
  app.get("/api/v1/entitlement", async () => ({
    activation_token: signActivation(buildPayload({ tier: "enterprise" }), rogue),
    activation_id: "ACT-FAKE",
    activation_token_id: "TOK-FAKE",
    issued_at: new Date().toISOString(),
    activation_status: "active",
    customer: { id: "CUST-1", name: "Forger" },
    license: { id: "LIC-X", tier: "enterprise" },
  }));
  await app.listen({ port: 0, host: "127.0.0.1" });
  process.env.FORGE_LOCAL_LS_URL = `http://127.0.0.1:${app.server.address().port}`;
  process.env.FORGE_LOCAL_LS_TOKEN = "lan-shared-token-1234567890abcdef";
  try {
    const r = await lic.pollLocalLicenseServer();
    assert.equal(r, null);
    assert.match(lic.localLicenseStatus().last_error || "", /signature_invalid/);
    assert.equal(fs.existsSync(path.join(tmpDir, "activation.json")), false, "no persisted file on rejected token");
  } finally {
    await app.close();
    delete process.env.FORGE_LOCAL_LS_URL;
    delete process.env.FORGE_LOCAL_LS_TOKEN;
    clearPersistedActivation();
  }
});

test("releaseActivation calls local LS and clears the persisted activation", async () => {
  clearPersistedActivation();
  let releaseCalled = false;
  const stub = await startStubLocalLS({
    payload: buildPayload({ tier: "enterprise" }),
    releaseHandler: () => { releaseCalled = true; return { ok: true, status: "released", released_at: new Date().toISOString() }; },
  });
  process.env.FORGE_LOCAL_LS_URL = stub.url;
  process.env.FORGE_LOCAL_LS_TOKEN = "lan-shared-token-1234567890abcdef";
  try {
    await lic.pollLocalLicenseServer();
    assert.ok(fs.existsSync(path.join(tmpDir, "activation.json")));
    assert.ok(lic.hasFeature(lic.FEATURES.GRAPHQL_API, lic.getLicense({ skipCache: true })));
    await lic.releaseActivation();
    assert.equal(releaseCalled, true);
    assert.equal(fs.existsSync(path.join(tmpDir, "activation.json")), false);
    const after = lic.getLicense({ skipCache: true });
    // Without a persisted activation and with the local LS still
    // configured, FORGE reports not_activated until a fresh activate
    // succeeds.
    assert.ok(after.tier === "community");
  } finally {
    await stub.app.close();
    delete process.env.FORGE_LOCAL_LS_URL;
    delete process.env.FORGE_LOCAL_LS_TOKEN;
    clearPersistedActivation();
  }
});

test("FORGE_EXPECTED_CUSTOMER_ID protects against a swapped local LS", async () => {
  clearPersistedActivation();
  const stub = await startStubLocalLS({
    payload: buildPayload({ customer_id: "CUST-WRONG" }),
    customer: "CUST-WRONG",
  });
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
    clearPersistedActivation();
  }
});

test("local LS HTTP failure with no cached token leaves FORGE on Community", async () => {
  clearPersistedActivation();
  process.env.FORGE_LOCAL_LS_URL = "http://127.0.0.1:1";
  process.env.FORGE_LOCAL_LS_TOKEN = "lan-shared-token-1234567890abcdef";
  try {
    const r = await lic.pollLocalLicenseServer();
    assert.equal(r, null);
    const verdict = lic.getLicense({ skipCache: true });
    assert.equal(verdict.status, "not_activated");
    assert.equal(verdict.source, "local_ls_unreachable");
    assert.equal(lic.hasFeature(lic.FEATURES.GRAPHQL_API, verdict), false);
  } finally {
    delete process.env.FORGE_LOCAL_LS_URL;
    delete process.env.FORGE_LOCAL_LS_TOKEN;
    clearPersistedActivation();
  }
});
