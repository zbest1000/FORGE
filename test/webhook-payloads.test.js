// Regression test for B.4 #11 — webhook payloads must live in the
// dedicated `webhook_delivery_payloads` table, not on `audit_log` rows.
//
// Acceptance:
//   1. After `dispatchEvent` no `webhook.queued` audit entry contains a
//      `body` field — the immutable hash chain stays small.
//   2. The dispatcher delivers successfully even when `audit_log` is
//      wiped between dispatch and delivery.
//   3. On a successful delivery the payload row is removed.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-webhook-payload-"));
process.env.FORGE_DATA_DIR = tmpDir;
process.env.FORGE_TENANT_KEY = "forge-webhook-payload-test-0123456789abcdef0123456789abcdef";
process.env.FORGE_JWT_SECRET = "forge-webhook-payload-test-jwt-0123456789abcdef0123456789abcdef";
process.env.LOG_LEVEL = "warn";
// The dispatcher's outbound URL guard is enabled in production / strict
// mode. Local tests post to 127.0.0.1, so opt the host into the
// allowlist explicitly.
process.env.FORGE_OUTBOUND_ALLOWLIST = "127.0.0.1";

const { db } = await import("../server/db.js");
const { drain } = await import("../server/audit.js");

// Local sink that records every webhook the dispatcher delivers.
const received = [];
const sink = http.createServer((req, res) => {
  let buf = "";
  req.on("data", (c) => buf += c);
  req.on("end", () => {
    try { received.push({ headers: req.headers, body: JSON.parse(buf) }); } catch { received.push({ headers: req.headers, body: buf }); }
    res.writeHead(200, { "content-type": "application/json" }); res.end("{}");
  });
});
await new Promise((r) => sink.listen(0, "127.0.0.1", r));
const sinkPort = sink.address().port;
test.after(() => sink.close());

const { createWebhook, dispatchEvent, processDueDeliveries } = await import("../server/webhooks.js");

const webhook = createWebhook({
  name: "test-sink",
  url: `http://127.0.0.1:${sinkPort}/in`,
  events: ["test.payload-table"],
});

test("dispatchEvent persists body to webhook_delivery_payloads, not audit_log", async () => {
  dispatchEvent("test.payload-table", { event_id: "EVT-A", greeting: "hello", count: 3 });
  await drain();

  const queued = db.prepare("SELECT detail FROM audit_log WHERE action = 'webhook.queued' ORDER BY seq DESC LIMIT 1").get();
  assert.ok(queued, "webhook.queued audit entry should exist");
  const detail = JSON.parse(queued.detail);
  assert.equal(detail.body, undefined, "audit detail must NOT carry the payload body");
  assert.equal(detail.eventId, "EVT-A");
  assert.match(String(detail.deliveryId || ""), /^delivery-/);

  const payloadRow = db.prepare("SELECT body FROM webhook_delivery_payloads WHERE delivery_id = ?").get(detail.deliveryId);
  assert.ok(payloadRow, "payload row should exist");
  const stored = JSON.parse(payloadRow.body);
  assert.equal(stored.greeting, "hello");
  assert.equal(stored.count, 3);
});

test("dispatcher delivers even when audit_log is wiped between queue and tick", async () => {
  // Wipe audit between dispatch and tick to prove the body is no longer
  // looked up there. The hash chain check is irrelevant for this test.
  dispatchEvent("test.payload-table", { event_id: "EVT-B", marker: "AUDIT-WIPE" });
  await drain();
  const before = db.prepare("SELECT COUNT(*) AS n FROM audit_log").get().n;
  db.exec("DELETE FROM audit_log");
  assert.ok(before > 0);

  // Force the worker to drain pending deliveries synchronously rather
  // than waiting for the production 5s timer.
  await processDueDeliveries();
  const got = received.find((r) => r.body?.payload?.marker === "AUDIT-WIPE");
  assert.ok(got, "dispatcher should deliver even with audit_log wiped");
  assert.equal(got.headers["x-forge-event"], "test.payload-table");
  const remaining = db.prepare("SELECT COUNT(*) AS n FROM webhook_delivery_payloads WHERE delivery_id IN (SELECT id FROM webhook_deliveries WHERE event_id = 'EVT-B')").get().n;
  assert.equal(remaining, 0, "delivered payload row should be removed");
});
