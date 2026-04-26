// Central license server: activation flow tests under the new model
// (one-time online activation + long-lived signed token + last-writer-wins
// supersession + voluntary release + operator reclaim).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-cls-"));
process.env.LICENSE_SERVER_DATA_DIR = tmp;

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
function decodeToken(token) {
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

async function activate(app, key, customerId, instanceId) {
  return app.inject({
    method: "POST", url: "/api/v1/activate",
    headers: bearer(key),
    payload: { customer_id: customerId, instance_id: instanceId, fingerprint: { hostname_hash: "h-" + instanceId } },
  });
}

test("operator API rejects unauthenticated requests", async () => {
  const app = makeApp();
  await app.register(operatorRoutes, { prefix: "/admin/v1" });
  const r = await app.inject({ method: "GET", url: "/admin/v1/customers" });
  assert.equal(r.statusCode, 401);
  await app.close();
});

test("activate roundtrip: signs token with vendor key + records activation row", async () => {
  const app = makeApp();
  await app.register(operatorRoutes, { prefix: "/admin/v1" });
  await app.register(activationRoutes, { prefix: "/api/v1" });
  const setup = await setupCustomer(app, { tier: "enterprise", seats: 100 });

  const r = await activate(app, setup.activation_key, setup.customer.id, "ULS-A");
  assert.equal(r.statusCode, 200);
  const body = JSON.parse(r.body);
  assert.ok(body.activation_token.startsWith("entitlement1."));
  assert.ok(body.activation_id?.startsWith("ACT-"));
  assert.ok(body.activation_token_id?.startsWith("TOK-"));
  const dec = decodeToken(body.activation_token);
  assert.equal(dec.sig_ok, true);
  assert.equal(dec.json.tier, "enterprise");
  assert.equal(dec.json.seats, 100);
  assert.equal(dec.json.activation_token_id, body.activation_token_id);
  await app.close();
});

test("activate rejects bad activation keys", async () => {
  const app = makeApp();
  await app.register(operatorRoutes, { prefix: "/admin/v1" });
  await app.register(activationRoutes, { prefix: "/api/v1" });
  const setup = await setupCustomer(app);
  const r = await activate(app, "fla_garbage", setup.customer.id, "ULS-X");
  assert.equal(r.statusCode, 401);
  await app.close();
});

test("activate over seat budget supersedes the oldest activation (last-writer-wins)", async () => {
  const app = makeApp();
  await app.register(operatorRoutes, { prefix: "/admin/v1" });
  await app.register(activationRoutes, { prefix: "/api/v1" });
  const setup = await setupCustomer(app, { tier: "team", seats: 2 });

  // Activate two machines under a 2-seat license.
  const a = await activate(app, setup.activation_key, setup.customer.id, "ULS-A");
  await new Promise(r => setTimeout(r, 5));
  const b = await activate(app, setup.activation_key, setup.customer.id, "ULS-B");
  assert.equal(a.statusCode, 200);
  assert.equal(b.statusCode, 200);

  // Now a third machine should evict the oldest (ULS-A).
  await new Promise(r => setTimeout(r, 5));
  const c = await activate(app, setup.activation_key, setup.customer.id, "ULS-C");
  assert.equal(c.statusCode, 200);
  const cBody = JSON.parse(c.body);
  assert.ok(cBody.superseded_activation_ids.length >= 1, "the over-cap activation supersedes the oldest");

  // Heartbeat from ULS-A's prior token should now report superseded.
  const aBody = JSON.parse(a.body);
  const hb = await app.inject({
    method: "POST", url: "/api/v1/heartbeat",
    headers: bearer(setup.activation_key),
    payload: { activation_token_id: aBody.activation_token_id, instance_id: "ULS-A" },
  });
  assert.equal(hb.statusCode, 200);
  const hbBody = JSON.parse(hb.body);
  assert.equal(hbBody.status, "superseded");
  assert.equal(hbBody.active, false);
  await app.close();
});

test("re-activate from the same instance reuses the activation row", async () => {
  const app = makeApp();
  await app.register(operatorRoutes, { prefix: "/admin/v1" });
  await app.register(activationRoutes, { prefix: "/api/v1" });
  const setup = await setupCustomer(app);

  const a1 = JSON.parse((await activate(app, setup.activation_key, setup.customer.id, "ULS-X")).body);
  const a2 = JSON.parse((await activate(app, setup.activation_key, setup.customer.id, "ULS-X")).body);
  assert.equal(a1.activation_id, a2.activation_id, "same instance_id reuses the row");
  assert.notEqual(a1.activation_token_id, a2.activation_token_id, "but a fresh token is issued");
  await app.close();
});

test("voluntary release returns the seat to the pool", async () => {
  const app = makeApp();
  await app.register(operatorRoutes, { prefix: "/admin/v1" });
  await app.register(activationRoutes, { prefix: "/api/v1" });
  const setup = await setupCustomer(app);

  const a = JSON.parse((await activate(app, setup.activation_key, setup.customer.id, "ULS-Y")).body);
  const r = await app.inject({
    method: "POST", url: "/api/v1/release",
    headers: bearer(setup.activation_key),
    payload: { activation_token_id: a.activation_token_id },
  });
  assert.equal(r.statusCode, 200);
  assert.equal(JSON.parse(r.body).status, "released");

  // Heartbeat now reports released.
  const hb = await app.inject({
    method: "POST", url: "/api/v1/heartbeat",
    headers: bearer(setup.activation_key),
    payload: { activation_token_id: a.activation_token_id, instance_id: "ULS-Y" },
  });
  assert.equal(JSON.parse(hb.body).status, "released");
  await app.close();
});

test("operator-initiated reclaim (POST /admin/v1/activations/:id/release)", async () => {
  const app = makeApp();
  await app.register(operatorRoutes, { prefix: "/admin/v1" });
  await app.register(activationRoutes, { prefix: "/api/v1" });
  const setup = await setupCustomer(app);

  const a = JSON.parse((await activate(app, setup.activation_key, setup.customer.id, "ULS-DEAD")).body);
  // Simulate a lost laptop: customer can't reach this machine, so they
  // ask the operator to reclaim the seat.
  const r = await app.inject({
    method: "POST", url: `/admin/v1/activations/${a.activation_id}/release`,
    headers: bearer(process.env.OPERATOR_API_TOKEN),
    payload: { reason: "lost laptop" },
  });
  assert.equal(r.statusCode, 200);
  assert.equal(JSON.parse(r.body).status, "released");

  // Now the customer can re-use the seat on a fresh machine.
  const b = await activate(app, setup.activation_key, setup.customer.id, "ULS-NEW");
  assert.equal(b.statusCode, 200);

  // The released activation list shows up for auditing.
  const list = await app.inject({
    method: "GET", url: `/admin/v1/customers/${setup.customer.id}/activations?status=released`,
    headers: bearer(process.env.OPERATOR_API_TOKEN),
  });
  const rows = JSON.parse(list.body);
  assert.ok(rows.find(x => x.id === a.activation_id), "released row still exists in audit history");
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
  const r = await activate(app, setup.activation_key, setup.customer.id, "ULS-Z");
  assert.equal(r.statusCode, 403);
  assert.equal(JSON.parse(r.body).error, "customer_disabled");
  await app.close();
});

test("expired license returns 410", async () => {
  const app = makeApp();
  await app.register(operatorRoutes, { prefix: "/admin/v1" });
  await app.register(activationRoutes, { prefix: "/api/v1" });
  const setup = await setupCustomer(app, { expires_at: "2020-01-01T00:00:00Z" });
  const r = await activate(app, setup.activation_key, setup.customer.id, "ULS-Q");
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
  const expect = pubPem.toString().replace(/\r/g, "").trim();
  const actual = body.pem.replace(/\r/g, "").trim();
  assert.equal(actual, expect);
  await app.close();
});
