// Server audit ledger: append → verify → tamper → export/verify pack.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// Isolate each run to its own DB.
const tmp = fs.mkdtempSync(path.join("/tmp", "forge-test-"));
process.env.FORGE_DATA_DIR = tmp;
process.env.FORGE_TENANT_KEY = "forge-test-key";

const { db } = await import("../server/db.js");
const audit = await import("../server/audit.js");

test("hash chain: verifies, detects tamper, pack verifies", async () => {
  for (let i = 0; i < 10; i++) {
    audit.audit({ actor: "test", action: "demo.action", subject: "OBJ-" + i, detail: { i } });
  }
  const first = await audit.verifyLedger();
  assert.equal(first.ok, true, "chain should verify after 10 appends");
  assert.equal(first.count, 10);

  const pack = await audit.exportAuditPack();
  assert.equal(pack.entry_count, 10);
  assert.ok(pack.signature?.signature?.length === 64);
  const verified = await audit.verifyAuditPack(pack);
  assert.equal(verified, true, "exported pack should verify with its own signature");

  // Tamper with a detail — recompute hash should differ.
  db.prepare("UPDATE audit_log SET detail = ? WHERE subject = 'OBJ-3'").run(JSON.stringify({ i: 999 }));
  const tampered = await audit.verifyLedger();
  assert.equal(tampered.ok, false, "tampered chain should fail");

  // Fix it back.
  db.prepare("UPDATE audit_log SET detail = ? WHERE subject = 'OBJ-3'").run(JSON.stringify({ i: 3 }));
  const repaired = await audit.verifyLedger();
  assert.equal(repaired.ok, true, "restoring the tamper should pass");
});

test("pack signature detects out-of-band mutation", async () => {
  const pack = await audit.exportAuditPack();
  pack.entries[0].detail = { hacked: true };
  const verified = await audit.verifyAuditPack(pack);
  assert.equal(verified, false, "modified pack must not verify");
});
