// Phase 4: dual-hash chain on audit_log.
//
// Verifies that:
//   1. Every entry written via audit() carries an `org_hash` column
//   2. verifyOrgChain() recomputes that hash and returns ok
//   3. Tampering with org_id on a row WITHOUT recomputing org_hash is
//      detected — the chain catches retroactive tenant reassignment
//   4. Pre-v20 entries (org_hash NULL) are reported as `missing`, not
//      failure — preserves back-compat with historic ledgers
//
// All assertions live in a single test() because the audit module's
// `_tail` and `_seq` state isn't resettable from outside; restarting
// the chain mid-test would invalidate it.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-audit-org-"));
process.env.FORGE_DATA_DIR = dataDir;
process.env.FORGE_TENANT_KEY ||= Buffer.alloc(32, 1).toString("base64");
process.env.FORGE_JWT_SECRET ||= "test";

const { db } = await import("../server/db.js");
const { audit, verifyLedger, verifyOrgChain, drain } = await import("../server/audit.js");

after(() => {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
});

test("dual-hash chain: write, verify, tamper-detect, back-compat", async () => {
  // 1) Three writes with mixed tenants.
  audit({ actor: "U-1", action: "test.a", subject: "S-1", orgId: "ORG-A" });
  audit({ actor: "U-2", action: "test.b", subject: "S-2", orgId: "ORG-B" });
  audit({ actor: "system", action: "boot", subject: "server", orgId: null });
  await drain();

  // Every row has a non-null sha256-shaped org_hash.
  const rows = db.prepare("SELECT id, org_id, org_hash FROM audit_log ORDER BY seq").all();
  assert.equal(rows.length >= 3, true);
  for (const r of rows) {
    assert.ok(r.org_hash, `expected org_hash on row ${r.id}`);
    assert.match(r.org_hash, /^[a-f0-9]{64}$/);
  }

  // 2) Both chains verify cleanly.
  const cleanLedger = await verifyLedger();
  const cleanOrg = await verifyOrgChain();
  assert.equal(cleanLedger.ok, true);
  assert.equal(cleanOrg.ok, true);
  assert.equal(cleanOrg.missing, 0);

  // 3) ORG-A scoped verification covers ORG-A entries + system events.
  const aOnly = await verifyOrgChain({ orgId: "ORG-A" });
  assert.equal(aOnly.ok, true);
  assert.ok(aOnly.count >= 2);

  // 4) Tamper: rewrite the ORG-B entry's org_id to ORG-EVIL.
  //    The legacy `hash` chain doesn't include org_id so verifyLedger
  //    still passes; verifyOrgChain catches the tamper.
  const orgBRow = db.prepare("SELECT seq FROM audit_log WHERE org_id = 'ORG-B' LIMIT 1").get();
  assert.ok(orgBRow, "test setup: ORG-B row should exist");
  db.prepare("UPDATE audit_log SET org_id = 'ORG-EVIL' WHERE seq = ?").run(orgBRow.seq);

  const tamperedLedger = await verifyLedger();
  const tamperedOrg = await verifyOrgChain();
  assert.equal(tamperedLedger.ok, true, "legacy hash chain unaffected by org_id tamper");
  assert.equal(tamperedOrg.ok, false, "org_hash chain detects retroactive reassignment");
  assert.equal(tamperedOrg.reason, "org_hash mismatch");

  // 5) Restore the tampered row + simulate a pre-v20 entry (NULL org_hash).
  //    Pre-v20 entries should be reported as `missing`, not `bad`.
  db.prepare("UPDATE audit_log SET org_id = 'ORG-B' WHERE seq = ?").run(orgBRow.seq);
  // Pick the system-event row (org_id IS NULL) — set its org_hash to NULL
  // to simulate a row written before the v20 migration ran.
  const sysRow = db.prepare("SELECT seq FROM audit_log WHERE actor = 'system' LIMIT 1").get();
  assert.ok(sysRow);
  db.prepare("UPDATE audit_log SET org_hash = NULL WHERE seq = ?").run(sysRow.seq);

  const backCompat = await verifyOrgChain();
  assert.equal(backCompat.ok, true, "NULL org_hash entries are missing, not failures");
  assert.equal(backCompat.missing, 1);
});
