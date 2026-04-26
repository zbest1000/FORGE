import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-outbox-"));
process.env.FORGE_DATA_DIR = tmpDir;
process.env.FORGE_TENANT_KEY = "outbox-key";
process.env.FORGE_JWT_SECRET = "outbox-jwt";

const { db } = await import("../server/db.js");
const { enqueueOutbox, processOutboxBatch, subscribeOutbox } = await import("../server/outbox.js");
const { ingest } = await import("../server/events.js");

test("enqueueOutbox persists and worker delivers to local subscribers", async () => {
  const seen = [];
  const unsubscribe = subscribeOutbox("test.topic", evt => seen.push(evt));
  const queued = enqueueOutbox({ topic: "test.topic", eventType: "demo.created", aggregateType: "demo", aggregateId: "D-1", payload: { ok: true }, traceId: "TRACE-1" });
  assert.ok(queued.id.startsWith("OBX-"));
  const results = await processOutboxBatch({ limit: 10 });
  assert.equal(results.length, 1);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].payload.ok, true);
  const row = db.prepare("SELECT * FROM outbox_events WHERE id = ?").get(queued.id);
  assert.equal(row.status, "published");
  unsubscribe();
});

test("event ingest writes canonical event and queues integration outbox event", () => {
  const env = ingest({ event_type: "alarm", severity: "low", dedupe_key: "outbox-test-1", payload: { tag: "HX01" } }, { source: "test", source_type: "rest" });
  assert.ok(env.event_id);
  const outbox = db.prepare("SELECT * FROM outbox_events WHERE aggregate_id = ?").get(env.event_id);
  assert.ok(outbox);
  assert.equal(outbox.topic, "events.ingested");
  assert.equal(outbox.event_type, "alarm");
});
