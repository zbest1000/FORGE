// Periodic audit ledger verification: metrics flip when tampering is
// detected, and a marker entry is appended to the (broken) ledger.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-tamper-"));
process.env.FORGE_DATA_DIR = tmpDir;
process.env.FORGE_TENANT_KEY = "forge-tamper-test";
process.env.FORGE_JWT_SECRET = "forge-tamper-test-jwt";
process.env.LOG_LEVEL = "warn";
// Disable the boot-time worker — tests drive runVerifyOnce manually.
process.env.FORGE_AUDIT_VERIFY_INTERVAL_S = "0";

const { db } = await import("../server/db.js");
const { audit, drain } = await import("../server/audit.js");
const { runVerifyOnce } = await import("../server/audit-tamper.js");
const { register } = await import("prom-client");

async function metricValue(name, labels = {}) {
  const m = register.getSingleMetric(name);
  if (!m) return null;
  const json = await m.get();
  const target = json.values.find((v) =>
    Object.entries(labels).every(([k, val]) => v.labels[k] === val),
  );
  return target?.value ?? null;
}

test("verify on a clean chain reports ok=true and metric=1", async () => {
  for (let i = 0; i < 5; i++) {
    audit({ actor: "test", action: "tamper.seed", subject: "OBJ-" + i });
  }
  await drain();
  const result = await runVerifyOnce();
  assert.equal(result.ok, true);
  assert.equal(await metricValue("forge_audit_chain_ok"), 1);
  const lastOk = await metricValue("forge_audit_chain_last_ok_seconds");
  assert.ok(lastOk > 0, "lastOk should be set");
});

test("tampering trips the metric, increments the failure counter, and writes a marker entry", async () => {
  // Mutate a row in the middle of the chain so verifyLedger detects it.
  db.prepare("UPDATE audit_log SET detail = ? WHERE seq = 2").run('{"hacked":true}');
  const result = await runVerifyOnce();
  assert.equal(result.ok, false);
  assert.equal(await metricValue("forge_audit_chain_ok"), 0);
  const failuresAny = await metricValue("forge_audit_chain_failures_total", { reason: result.reason });
  assert.ok(failuresAny >= 1, `expected failures counter to increment, got ${failuresAny}`);
  await drain();
  const marker = db.prepare("SELECT * FROM audit_log WHERE action = 'audit.tamper.detected' ORDER BY seq DESC LIMIT 1").get();
  assert.ok(marker, "expected an audit.tamper.detected marker row");
  const detail = JSON.parse(marker.detail);
  assert.equal(typeof detail.reason, "string");
});
