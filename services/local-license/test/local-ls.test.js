// Local license server: verifier roundtrip, state cache lifecycle,
// and end-to-end activation against a stub central server (under
// the new long-lived activation model).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-localls-"));
process.env.LOCAL_LICENSE_DATA_DIR = tmp;
process.env.LOG_LEVEL = "warn";

const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
process.env.FORGE_LICENSE_PUBLIC_KEY = publicKey.export({ type: "spki", format: "pem" }).toString();

function canonicalJSON(obj) {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return "[" + obj.map(canonicalJSON).join(",") + "]";
  const keys = Object.keys(obj).sort();
  return "{" + keys.map(k => JSON.stringify(k) + ":" + canonicalJSON(obj[k])).join(",") + "}";
}
function b64u(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function signActivation(payload) {
  const canonical = canonicalJSON(payload);
  const sig = crypto.sign(null, Buffer.from(canonical, "utf8"), privateKey);
  return "entitlement1." + b64u(canonical) + "." + b64u(sig);
}

const { verifyEntitlement } = await import("../verify.js");
const stateMod = await import("../state.js");

test("verifyEntitlement round-trips a freshly signed activation token", () => {
  const payload = {
    v: 1, activation_id: "ACT-1", activation_token_id: "TOK-1",
    instance_id: "ULS-T", bound_fingerprint: {},
    customer_id: "CUST-1", customer_name: "Acme",
    license_id: "LIC-1", tier: "team", term: "annual", seats: 10,
    issued_at: new Date().toISOString(),
    starts_at: new Date().toISOString(),
    license_expires_at: "2099-01-01T00:00:00Z",
    features: { add: [], remove: [] }, deployment: "self_hosted",
  };
  const token = signActivation(payload);
  const v = verifyEntitlement(token);
  assert.equal(v.ok, true);
  assert.equal(v.payload.tier, "team");
  assert.equal(v.payload.activation_id, "ACT-1");
});

test("verifyEntitlement rejects tampered payloads", () => {
  const payload = { v: 1, customer_id: "CUST-X", tier: "community" };
  const token = signActivation(payload);
  const [prefix, body, sig] = [token.slice(0, 13), token.slice(13).split(".")[0], token.slice(13).split(".")[1]];
  const tampered = prefix + body.slice(0, -2) + "AA." + sig;
  const v = verifyEntitlement(tampered);
  assert.equal(v.ok, false);
});

test("state lifecycle: save → heartbeat → release", () => {
  stateMod.saveActivation({
    activation_token: "entitlement1.aaa.bbb",
    activation_id: "ACT-A",
    activation_token_id: "TOK-A",
    customer: { id: "CUST-A", name: "A" },
    license: { id: "LIC-A", tier: "team" },
    issued_at: "2026-01-01T00:00:00Z",
    instance_id: "ULS-A",
  });
  let s = stateMod.getState();
  assert.equal(s.activation_id, "ACT-A");
  assert.equal(s.activation_status, "active");

  stateMod.applyHeartbeatResult({ active: false, status: "superseded", superseded_by: "ACT-B", last_seen_at: "2026-01-02T00:00:00Z" });
  s = stateMod.getState();
  assert.equal(s.activation_status, "superseded");
  assert.equal(s.superseded_by, "ACT-B");
  // Token stays cached even when superseded — downstream tooling can
  // still inspect it.
  assert.ok(s.activation_token);

  stateMod.markReleased();
  s = stateMod.getState();
  assert.equal(s.activation_status, "released");
  assert.equal(s.activation_token, null);
});

test("end-to-end: local LS activates against a stub central server", async () => {
  const Fastify = (await import("fastify")).default;
  const central = Fastify({ logger: false });
  central.post("/api/v1/activate", async (req) => {
    const payload = {
      v: 1,
      activation_id: "ACT-E2E",
      activation_token_id: "TOK-E2E",
      instance_id: req.body.instance_id,
      bound_fingerprint: req.body.fingerprint || {},
      customer_id: req.body.customer_id, customer_name: "Acme",
      license_id: "LIC-E2E", tier: "enterprise", term: "annual", seats: 50,
      issued_at: new Date().toISOString(),
      starts_at: new Date().toISOString(),
      license_expires_at: "2099-01-01T00:00:00Z",
      features: { add: [], remove: [] }, deployment: "self_hosted",
    };
    return {
      activation_token: signActivation(payload),
      activation_id: payload.activation_id,
      activation_token_id: payload.activation_token_id,
      issued_at: payload.issued_at,
      customer: { id: req.body.customer_id, name: "Acme" },
      license: { id: "LIC-E2E", tier: "enterprise", term: "annual", seats: 50 },
    };
  });
  await central.listen({ port: 0, host: "127.0.0.1" });
  const port = central.server.address().port;

  process.env.FORGE_LLC_URL = `http://127.0.0.1:${port}`;
  process.env.FORGE_CUSTOMER_ID = "CUST-X";
  process.env.FORGE_ACTIVATION_KEY = "fla_e2e_test_key";

  const { activate } = await import("../central-client.js?cb=" + Date.now());
  const r = await activate({ instance_id: "ULS-test", customer_id: "CUST-X" });
  assert.equal(r.ok, true);
  assert.ok(r.body.activation_token.startsWith("entitlement1."));
  const v = verifyEntitlement(r.body.activation_token);
  assert.equal(v.ok, true);
  assert.equal(v.payload.tier, "enterprise");
  assert.equal(v.payload.seats, 50);
  await central.close();
});
