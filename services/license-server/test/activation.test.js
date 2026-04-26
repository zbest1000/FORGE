// Central license server: activation flow tests. End-to-end through
// real Fastify .inject() calls with an ephemeral SQLite + a freshly
// generated Ed25519 signing key.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-cls-"));
process.env.LICENSE_SERVER_DATA_DIR = tmp;

// Generate a signing key for this test run.
const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
const privPem = privateKey.export({ type: "pkcs8", format: "pem" });
const pubPem = publicKey.export({ type: "spki", format: "pem" });
const privPath = path.join(tmp, "priv.pem");
fs.writeFileSync(privPath, privPem);
process.env.FORGE_LICENSE_SIGNING_KEY_PATH = privPath;
process.env.OPERATOR_API_TOKEN = "test-operator-api-token-1234567890";
process.env.LOG_LEVEL = "warn";

const { db, uuid, now } = await import("../db.js");
const { signEntitlement, publicKeyPem } = await import("../signing.js");
const { default: Fastify } = await import("fastify");
const activationRoutes = (await import("../routes/activation.js")).default;
const operatorRoutes = (await import("../routes/operator.js")).default;

function makeApp() {
  const app = Fastify({ logger: false });
  app.decorate("config", {
    db, uuid, now,
    signEntitlement,
    publicKeyPem,
    ENTITLEMENT_TTL_S: 3600,
    HEARTBEAT_TTL_S: 300,
  });
  return app;
}

function bearer(t) { return { authorization: "Bearer " + t }; }

function b64uDecode(s) {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  return Buffer.from((s + pad).replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function decodeEntitlement(token) {
  assert.ok(token.startsWith("entitlement1."), "missing entitlement1. prefix");
  const [_, payload, sig] = token.split(".");
  const json = JSON.parse(b64uDecode(payload).toString("utf8"));
  const canonical = canonicalJSON(json);
  const ok = crypto.verify(null, Buffer.from(canonical, "utf8"),
    crypto.createPublicKey({ key: pubPem, format: "pem" }), b64uDecode(sig));
  return { json, sig_ok: ok };
}
function canonicalJSON(o) {
  if (o === null || typeof o !== "object") return JSON.stringify(o);
  if (Array.isArray(o)) return "[" + o.map(canonicalJSON).join(",") + "]";
  const k = Object.keys(o).sort();
  return "{" + k.map(x => JSON.stringify(x) + ":" + canonicalJSON(o[x])).join(",") + "}";
}

async function setupCustomer(app, opts = {}) {
  const c = await app.inject({
    method: "POST", url: "/admin/v1/customers",
    headers: bearer(process.env.OPERATOR_API_TOKEN),
    payload: { name: opts.name || "Test Customer", contact_email: "ops@test.example" },
  });
  assert.equal(c.statusCode, 200, c.body);
  const customer = JSON.parse(c.body);

  const k = await app.inject({
    method: "POST", url: `/admin/v1/customers/${customer.id}/keys`,
    headers: bearer(process.env.OPERATOR_API_TOKEN),
    payload: { label: "main" },
  });
  assert.equal(k.statusCode, 200, k.body);
  const key = JSON.parse(k.body);

  const l = await app.inject({
    method: "POST", url: `/admin/v1/customers/${customer.id}/licenses`,
    headers: bearer(process.env.OPERATOR_API_TOKEN),
    payload: {
      tier: opts.tier || "team",
      term: opts.term || "annual",
      seats: opts.seats || 25,
      expires_at: opts.expires_at || "2099-01-01T00:00:00Z",
      ...opts.licenseExtra,
    },
  });
  assert.equal(l.statusCode, 200, l.body);
  return { customer, activation_key: key.activation_key, license: JSON.parse(l.body) };
}

test("operator API rejects unauthenticated requests", async () => {
  const app = makeApp();
  await app.register(operatorRoutes, { prefix: "/admin/v1" });
  const r = await app.inject({ method: "GET", url: "/admin/v1/customers" });
  assert.equal(r.statusCode, 401);
  assert.equal(JSON.parse(r.body).error, "operator_auth_invalid");
  await app.close();
});

test("create customer + key + license + activate roundtrip", async () => {
  const app = makeApp();
  await app.register(operatorRoutes, { prefix: "/admin/v1" });
  await app.register(activationRoutes, { prefix: "/api/v1" });
  const setup = await setupCustomer(app, { tier: "enterprise", seats: 100 });

  const r = await app.inject({
    method: "POST", url: "/api/v1/activate",
    headers: bearer(setup.activation_key),
    payload: { customer_id: setup.customer.id, instance_id: "ULS-test-1", fingerprint: { hostname_hash: "x" }, client_version: "0.4.0" },
  });
  assert.equal(r.statusCode, 200, r.body);
  const body = JSON.parse(r.body);
  assert.ok(body.entitlement);
  const dec = decodeEntitlement(body.entitlement);
  assert.equal(dec.sig_ok, true, "central server signed payload verifies with the public key");
  assert.equal(dec.json.customer_id, setup.customer.id);
  assert.equal(dec.json.tier, "enterprise");
  assert.equal(dec.json.seats, 100);
  assert.equal(dec.json.term, "annual");
  await app.close();
});

test("activation rejects bad activation keys", async () => {
  const app = makeApp();
  await app.register(operatorRoutes, { prefix: "/admin/v1" });
  await app.register(activationRoutes, { prefix: "/api/v1" });
  const setup = await setupCustomer(app);
  const r = await app.inject({
    method: "POST", url: "/api/v1/activate",
    headers: bearer("fla_garbage"),
    payload: { customer_id: setup.customer.id, instance_id: "x" },
  });
  assert.equal(r.statusCode, 401);
  assert.equal(JSON.parse(r.body).error, "auth_invalid");
  await app.close();
});

test("activation key revocation blocks future activations", async () => {
  const app = makeApp();
  await app.register(operatorRoutes, { prefix: "/admin/v1" });
  await app.register(activationRoutes, { prefix: "/api/v1" });
  const setup = await setupCustomer(app);

  // Sanity: activation works.
  let r = await app.inject({
    method: "POST", url: "/api/v1/activate",
    headers: bearer(setup.activation_key),
    payload: { customer_id: setup.customer.id, instance_id: "x" },
  });
  assert.equal(r.statusCode, 200);

  // Revoke the key.
  const keys = JSON.parse((await app.inject({
    method: "GET", url: `/admin/v1/customers/${setup.customer.id}/keys`,
    headers: bearer(process.env.OPERATOR_API_TOKEN),
  })).body);
  const r2 = await app.inject({
    method: "DELETE", url: `/admin/v1/keys/${keys[0].id}`,
    headers: bearer(process.env.OPERATOR_API_TOKEN),
  });
  assert.equal(r2.statusCode, 200);

  // Subsequent activation fails.
  r = await app.inject({
    method: "POST", url: "/api/v1/activate",
    headers: bearer(setup.activation_key),
    payload: { customer_id: setup.customer.id, instance_id: "x" },
  });
  assert.equal(r.statusCode, 401);
  assert.equal(JSON.parse(r.body).error, "auth_revoked");
  await app.close();
});

test("license revocation invalidates in-flight refreshes", async () => {
  const app = makeApp();
  await app.register(operatorRoutes, { prefix: "/admin/v1" });
  await app.register(activationRoutes, { prefix: "/api/v1" });
  const setup = await setupCustomer(app);

  const a = await app.inject({
    method: "POST", url: "/api/v1/activate",
    headers: bearer(setup.activation_key),
    payload: { customer_id: setup.customer.id, instance_id: "x" },
  });
  const issued = JSON.parse(a.body);

  await app.inject({
    method: "POST", url: `/admin/v1/licenses/${setup.license.id}/revoke`,
    headers: bearer(process.env.OPERATOR_API_TOKEN),
  });

  const r = await app.inject({
    method: "POST", url: "/api/v1/refresh",
    headers: bearer(setup.activation_key),
    payload: { customer_id: setup.customer.id, instance_id: "x", prior_bundle_id: issued.bundle_id },
  });
  // Either auth_revoked (because we revoked the prior bundle) or
  // license_not_found (no active license remains) — both prove revocation works.
  assert.ok([401, 404].includes(r.statusCode), `expected 401|404, got ${r.statusCode}: ${r.body}`);
  await app.close();
});

test("disabled customer cannot activate", async () => {
  const app = makeApp();
  await app.register(operatorRoutes, { prefix: "/admin/v1" });
  await app.register(activationRoutes, { prefix: "/api/v1" });
  const setup = await setupCustomer(app);

  await app.inject({
    method: "PATCH", url: `/admin/v1/customers/${setup.customer.id}`,
    headers: bearer(process.env.OPERATOR_API_TOKEN),
    payload: { status: "disabled" },
  });

  const r = await app.inject({
    method: "POST", url: "/api/v1/activate",
    headers: bearer(setup.activation_key),
    payload: { customer_id: setup.customer.id, instance_id: "x" },
  });
  assert.equal(r.statusCode, 403);
  assert.equal(JSON.parse(r.body).error, "customer_disabled");
  await app.close();
});

test("expired license returns 410", async () => {
  const app = makeApp();
  await app.register(operatorRoutes, { prefix: "/admin/v1" });
  await app.register(activationRoutes, { prefix: "/api/v1" });
  const setup = await setupCustomer(app, { expires_at: "2020-01-01T00:00:00Z" });
  const r = await app.inject({
    method: "POST", url: "/api/v1/activate",
    headers: bearer(setup.activation_key),
    payload: { customer_id: setup.customer.id, instance_id: "x" },
  });
  assert.equal(r.statusCode, 410);
  assert.equal(JSON.parse(r.body).error, "license_expired");
  await app.close();
});

test("/pubkey returns the matching public key", async () => {
  const app = makeApp();
  app.get("/pubkey", async () => ({ algorithm: "ed25519", pem: publicKeyPem() }));
  const r = await app.inject({ method: "GET", url: "/pubkey" });
  assert.equal(r.statusCode, 200);
  const body = JSON.parse(r.body);
  // Compare normalised PEMs (line-ending differences trip naive compares).
  const expect = pubPem.toString().replace(/\r/g, "").trim();
  const actual = body.pem.replace(/\r/g, "").trim();
  assert.equal(actual, expect);
  await app.close();
});
