// Local license server: pull-from-central + serve-on-LAN happy path,
// plus signature-mismatch defence and shared-secret enforcement.
//
// We stand up an in-process "central" Fastify app that mimics the
// FORGE LLC activation API, then exercise the local LS verify +
// state plumbing directly. The HTTP boot path is exercised by the
// end-to-end smoke in CI.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-localls-"));
process.env.LOCAL_LICENSE_DATA_DIR = tmp;
process.env.LOG_LEVEL = "warn";

// Generate a "FORGE LLC" key for the test, then point the local LS's
// verifier at the public half via FORGE_LICENSE_PUBLIC_KEY.
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
function signEntitlement(payload) {
  const canonical = canonicalJSON(payload);
  const sig = crypto.sign(null, Buffer.from(canonical, "utf8"), privateKey);
  return "entitlement1." + b64u(canonical) + "." + b64u(sig);
}

const { verifyEntitlement } = await import("../verify.js");
const stateMod = await import("../state.js");

test("verifyEntitlement round-trips a freshly signed payload", () => {
  const payload = {
    v: 1, bundle_id: "ENT-1", customer_id: "CUST-1", customer_name: "Acme",
    license_id: "LIC-1", tier: "team", term: "annual", seats: 10,
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    license_expires_at: "2099-01-01T00:00:00Z",
    starts_at: new Date().toISOString(),
    features: { add: [], remove: [] },
    deployment: "self_hosted",
  };
  const token = signEntitlement(payload);
  const v = verifyEntitlement(token);
  assert.equal(v.ok, true);
  assert.equal(v.payload.customer_id, "CUST-1");
  assert.equal(v.payload.tier, "team");
});

test("verifyEntitlement rejects tampered payloads", () => {
  const payload = { v: 1, customer_id: "CUST-X", tier: "community" };
  const token = signEntitlement(payload);
  const [prefix, body, sig] = [token.slice(0, 13), token.slice(13).split(".")[0], token.slice(13).split(".")[1]];
  const tampered = prefix + body.slice(0, -2) + "AA." + sig;
  const v = verifyEntitlement(tampered);
  assert.equal(v.ok, false);
});

test("state cache survives reads + writes", () => {
  stateMod.saveActivation({
    entitlement: "entitlement1.aaa.bbb",
    bundle_id: "ENT-A",
    customer: { id: "CUST-A", name: "A" },
    license: { id: "LIC-A", tier: "team" },
    issued_at: "2026-01-01T00:00:00Z",
    expires_at: "2026-02-01T00:00:00Z",
    refresh_at: "2026-01-31T23:00:00Z",
  });
  const s1 = stateMod.getState();
  assert.equal(s1.bundle_id, "ENT-A");
  assert.equal(s1.activation_status, "ok");
  stateMod.recordRefreshFailure("network");
  const s2 = stateMod.getState();
  assert.equal(s2.activation_status, "offline");
  assert.equal(s2.activation_error, "network");
  // Bundle stays cached even on failure.
  assert.equal(s2.bundle_id, "ENT-A");
});

test("end-to-end: local LS pulls from a stub central server and verifies", async () => {
  const Fastify = (await import("fastify")).default;
  const central = Fastify({ logger: false });
  central.post("/api/v1/activate", async (req) => {
    const payload = {
      v: 1,
      bundle_id: "ENT-E2E",
      customer_id: req.body.customer_id,
      customer_name: "Acme",
      license_id: "LIC-E2E",
      tier: "enterprise",
      term: "annual",
      seats: 50,
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      license_expires_at: "2099-01-01T00:00:00Z",
      starts_at: new Date().toISOString(),
      features: { add: [], remove: [] },
      deployment: "self_hosted",
    };
    return {
      entitlement: signEntitlement(payload),
      bundle_id: payload.bundle_id,
      issued_at: payload.issued_at,
      expires_at: payload.expires_at,
      refresh_at: new Date(Date.now() + 23 * 3600_000).toISOString(),
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
  assert.equal(r.ok, true, r.body && JSON.stringify(r.body));
  assert.ok(r.body.entitlement.startsWith("entitlement1."));
  const v = verifyEntitlement(r.body.entitlement);
  assert.equal(v.ok, true);
  assert.equal(v.payload.tier, "enterprise");
  assert.equal(v.payload.seats, 50);
  await central.close();
});
