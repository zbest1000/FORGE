// Periodic audit-ledger tamper detection.
//
// The audit chain is hash-linked (`server/audit.js`), but `verifyLedger`
// only ran on demand from `/api/audit/verify`. A silent tampering of an
// older row would not be detected until a human happened to ask. This
// worker walks the chain on a schedule, reports the result via Prometheus
// metrics, and writes a `audit.tamper.detected` ledger entry on failure
// so an alerting pipeline can page on a single boolean condition.
//
// Metrics:
//   - `forge_audit_chain_ok`             gauge (1 = chain verified, 0 = tampered)
//   - `forge_audit_chain_failures_total` counter (label: reason)
//   - `forge_audit_chain_last_check_seconds`     gauge (Unix ts of last attempt)
//   - `forge_audit_chain_last_ok_seconds`        gauge (Unix ts of last successful verify)
//
// Default cadence is hourly. `FORGE_AUDIT_VERIFY_INTERVAL_S` overrides
// it; setting it to 0 disables the worker (used by tests that drive
// `runVerifyOnce` directly).

import { Counter, Gauge, register } from "prom-client";
import { verifyLedger, audit } from "./audit.js";

const chainOk = new Gauge({
  name: "forge_audit_chain_ok",
  help: "1 when the latest verifyLedger() succeeded, 0 when tampering was detected",
  registers: [register],
});
const chainFailures = new Counter({
  name: "forge_audit_chain_failures_total",
  help: "Number of times the periodic verifyLedger() returned ok=false",
  labelNames: ["reason"],
  registers: [register],
});
const lastCheck = new Gauge({
  name: "forge_audit_chain_last_check_seconds",
  help: "Unix timestamp of the last verifyLedger() invocation",
  registers: [register],
});
const lastOk = new Gauge({
  name: "forge_audit_chain_last_ok_seconds",
  help: "Unix timestamp of the last successful verifyLedger()",
  registers: [register],
});

// Default to "verified" until proven otherwise. Until the first run
// completes, we report 1 so a freshly-booted server doesn't appear
// tampered.
chainOk.set(1);

let _handle = null;
const DEFAULT_INTERVAL_S = 3600;

/**
 * Run a single verification pass and update the metrics + audit log.
 * Exposed for tests and for ad-hoc operator use. Returns the
 * verifyLedger() result.
 */
export async function runVerifyOnce(logger = null) {
  const result = await verifyLedger();
  const tsSec = Math.floor(Date.now() / 1000);
  lastCheck.set(tsSec);
  if (result.ok) {
    chainOk.set(1);
    lastOk.set(tsSec);
    return result;
  }
  chainOk.set(0);
  chainFailures.inc({ reason: result.reason || "unknown" });
  // Append a marker row to the (already-broken) chain so downstream
  // consumers see a clear breadcrumb. The new entry's hash will be
  // valid against itself; the historical breakage stays detectable
  // because verifyLedger() always walks the entire chain.
  audit({
    actor: "system",
    action: "audit.tamper.detected",
    subject: "audit_log",
    detail: {
      reason: result.reason || "unknown",
      firstBadIndex: result.firstBadIndex ?? null,
      entryId: result.entry?.id || null,
    },
  });
  if (logger?.error) {
    logger.error({
      reason: result.reason || "unknown",
      firstBadIndex: result.firstBadIndex ?? null,
    }, "audit ledger tamper detected");
  }
  return result;
}

export function startTamperWorker(logger, intervalS = Number(process.env.FORGE_AUDIT_VERIFY_INTERVAL_S || DEFAULT_INTERVAL_S)) {
  if (_handle || intervalS <= 0) return;
  // Kick off one check immediately on boot so the metric reflects
  // actual state (not the optimistic 1 we set above).
  runVerifyOnce(logger).catch((err) => logger?.warn?.({ err: String(err?.message || err) }, "initial ledger verify failed"));
  _handle = setInterval(() => {
    runVerifyOnce(logger).catch((err) => logger?.warn?.({ err: String(err?.message || err) }, "ledger verify tick failed"));
  }, intervalS * 1000);
  if (typeof _handle.unref === "function") _handle.unref();
  logger?.info?.({ intervalS }, "audit tamper worker started");
}

export function stopTamperWorker() {
  if (_handle) clearInterval(_handle);
  _handle = null;
}
