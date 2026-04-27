// Per-tenant signing key history (B.2 #2/#3, B.8 #4).
//
// Two assertions:
//   1. Two orgs sign + verify their own packs independently.
//   2. After rotating to a new key id for an org, packs signed under
//      the previous key still verify (the registry preserves history).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-keys-"));
process.env.FORGE_DATA_DIR = tmpDir;
// Default global key. Each org also gets a dedicated key registered
// via the env name convention `FORGE_TENANT_KEY_<KEY_ID>` (uppercased,
// non-alphanumerics → `_`).
process.env.FORGE_TENANT_KEY = "global-tenant-key-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
process.env.FORGE_TENANT_KEY_KEY_ORG_ORG1_V1 = "org1-tenant-key-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
process.env.FORGE_TENANT_KEY_KEY_ORG_ORG1_V2 = "org1-tenant-key-cccccccccccccccccccccccccccccccc";
process.env.FORGE_TENANT_KEY_KEY_ORG_ORG2_V1 = "org2-tenant-key-dddddddddddddddddddddddddddddddd";
process.env.FORGE_JWT_SECRET = "forge-keys-test-jwt";
process.env.LOG_LEVEL = "warn";

const { db } = await import("../server/db.js");
const { rotateTenantKey, signHMAC, verifyHMAC, listTenantKeys } = await import("../server/crypto.js");

const ts = new Date().toISOString();
db.prepare("INSERT INTO organizations (id, name, tenant_key, created_at) VALUES ('ORG-1','Atlas','tk1',?)").run(ts);
db.prepare("INSERT INTO organizations (id, name, tenant_key, created_at) VALUES ('ORG-2','Beta','tk2',?)").run(ts);

test("schema_version reaches 13 and seeds the global key registry row", () => {
  const v = Number(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value);
  assert.ok(v >= 13);
  const row = db.prepare("SELECT * FROM tenant_keys WHERE id = 'key:forge:v1'").get();
  assert.ok(row, "default global key row missing");
  assert.equal(row.state, "active");
});

test("two orgs sign and verify their own packs with independent keys", async () => {
  rotateTenantKey({ orgId: "ORG-1", newKeyId: "key:org:org1:v1" });
  rotateTenantKey({ orgId: "ORG-2", newKeyId: "key:org:org2:v1" });

  const payload = '{"hello":"world"}';
  const sig1 = await signHMAC(payload, { orgId: "ORG-1" });
  const sig2 = await signHMAC(payload, { orgId: "ORG-2" });

  assert.equal(sig1.keyId, "key:org:org1:v1");
  assert.equal(sig2.keyId, "key:org:org2:v1");
  assert.notEqual(sig1.signature, sig2.signature, "different keys must produce different signatures");

  // Each pack verifies under its own key id.
  assert.equal(await verifyHMAC(payload, sig1.signature, { keyId: sig1.keyId }), true);
  assert.equal(await verifyHMAC(payload, sig2.signature, { keyId: sig2.keyId }), true);

  // And cross-verification fails — provenance is bound.
  assert.equal(await verifyHMAC(payload, sig1.signature, { keyId: sig2.keyId }), false);
  assert.equal(await verifyHMAC(payload, sig2.signature, { keyId: sig1.keyId }), false);
});

test("a rotation registers a new active key but old packs still verify", async () => {
  const payload = '{"id":"AUD-1"}';
  // Sign under ORG-1's current v1 key.
  const oldSig = await signHMAC(payload, { orgId: "ORG-1" });
  assert.equal(oldSig.keyId, "key:org:org1:v1");

  // Rotate ORG-1 to v2.
  rotateTenantKey({ orgId: "ORG-1", newKeyId: "key:org:org1:v2" });
  const history = listTenantKeys("ORG-1");
  assert.equal(history.length, 2);
  const states = Object.fromEntries(history.map((r) => [r.id, r.state]));
  assert.equal(states["key:org:org1:v1"], "retired");
  assert.equal(states["key:org:org1:v2"], "active");

  // New signs use v2.
  const newSig = await signHMAC(payload, { orgId: "ORG-1" });
  assert.equal(newSig.keyId, "key:org:org1:v2");

  // The old pack still verifies under its recorded keyId — that's the
  // whole point of the key history: rotations don't invalidate history.
  assert.equal(await verifyHMAC(payload, oldSig.signature, { keyId: oldSig.keyId }), true);
  // And the new pack verifies under its own keyId.
  assert.equal(await verifyHMAC(payload, newSig.signature, { keyId: newSig.keyId }), true);
});

test("a sign request without orgId falls back to the global key", async () => {
  const sig = await signHMAC("global", { orgId: null });
  assert.equal(sig.keyId, "key:forge:v1");
});

test("rotateTenantKey refuses to register a key with no env material", () => {
  assert.throws(
    () => rotateTenantKey({ orgId: "ORG-1", newKeyId: "key:org:org1:nope" }),
    /no material configured|env var .* is not set/,
  );
});
