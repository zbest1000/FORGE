// Postgres + TimescaleDB historian adapter — interface tests.
//
// We don't spin up an actual Postgres in the test harness; instead we
// import the adapter, monkey-patch its `pool()` method to return a
// stub that records calls, and assert the SQL + parameters the
// adapter sends.
//
// Coverage:
//   - configured() reflects FORGE_PG_CONNECTION_STRING presence
//   - status() shape includes timescale flag
//   - writeSample issues an INSERT with the right column order
//   - querySamples emits the expected SELECT
//   - aggregateSamples emits time_bucket() under TimescaleDB and
//     a date_trunc fallback otherwise

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-pg-adapter-"));
process.env.FORGE_DATA_DIR = dataDir;
process.env.FORGE_TENANT_KEY ||= Buffer.alloc(32, 1).toString("base64");
process.env.FORGE_JWT_SECRET ||= "test";

// listHistorianBackends pulls each adapter's status — we want to
// inspect the postgres entry specifically.
const { listHistorianBackends, getHistorianBackend } = await import("../server/historians/index.js");

after(() => {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
});

/** Stub pool that records every query() call for later assertions. */
function stubPool() {
  /** @type {Array<{ sql: string, params: any[] }>} */
  const calls = [];
  return {
    calls,
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      // Different shaped responses for different reads:
      if (/^SELECT version/i.test(sql)) return { rows: [{ version: "PostgreSQL 16 (mock)" }] };
      if (/SELECT point_id/.test(sql)) return { rows: [] };
      if (/time_bucket|date_trunc/.test(sql)) return { rows: [] };
      return { rowCount: 1 };
    },
    end: async () => {},
  };
}

beforeEach(() => {
  // Always start with the connection string set so configured()
  // returns true; individual tests override as needed.
  process.env.FORGE_PG_CONNECTION_STRING = "postgresql://u:p@h:5432/db";
  delete process.env.FORGE_PG_TIMESCALEDB;
});

test("postgresAdapter.configured() reflects FORGE_PG_CONNECTION_STRING", () => {
  const a = getHistorianBackend("postgresql");
  assert.equal(a.configured(), true);

  delete process.env.FORGE_PG_CONNECTION_STRING;
  assert.equal(a.configured(), false);
});

test("postgresAdapter.status() reports the timescale flag", () => {
  const a = getHistorianBackend("postgresql");
  assert.equal(a.status().timescale, false);
  process.env.FORGE_PG_TIMESCALEDB = "1";
  assert.equal(a.status().timescale, true);
});

test("listHistorianBackends includes the postgres entry", () => {
  const list = listHistorianBackends();
  const pg = list.find(x => x.name === "postgresql");
  assert.ok(pg, "postgresql entry should be in the backend list");
  assert.ok("timescale" in pg);
});

test("writeSample issues the expected INSERT", async () => {
  const a = getHistorianBackend("postgresql");
  const stub = stubPool();
  a.pool = async () => stub;

  await a.writeSample(
    { id: "P-1", asset_id: "A-1", tag: "temperature" },
    { ts: "2026-05-07T10:00:00.000Z", value: 42, quality: "Good", source_type: "mqtt" },
  );

  assert.equal(stub.calls.length, 1);
  assert.match(stub.calls[0].sql, /INSERT INTO forge_historian_samples/);
  // Param order is fixed by the adapter — guard against a future
  // accidental swap (e.g. asset_id and tag positions).
  assert.deepEqual(stub.calls[0].params.slice(0, 3), ["P-1", "A-1", "temperature"]);
  assert.equal(stub.calls[0].params[4], 42);
});

test("querySamples emits the expected SELECT range query", async () => {
  const a = getHistorianBackend("postgresql");
  const stub = stubPool();
  a.pool = async () => stub;

  await a.querySamples(
    { id: "P-1" },
    { since: "2026-05-01T00:00:00Z", until: "2026-05-07T00:00:00Z", limit: 1000 },
  );

  assert.equal(stub.calls.length, 1);
  assert.match(stub.calls[0].sql, /SELECT point_id, ts, value, quality, source_type[\s\S]+ORDER BY ts ASC LIMIT/);
  assert.equal(stub.calls[0].params[0], "P-1");
  assert.equal(stub.calls[0].params[3], 1000);
});

test("aggregateSamples uses date_trunc when TimescaleDB is off", async () => {
  delete process.env.FORGE_PG_TIMESCALEDB;
  const a = getHistorianBackend("postgresql");
  const stub = stubPool();
  a.pool = async () => stub;

  await a.aggregateSamples({ id: "P-1" }, { since: "2026-05-01T00:00:00Z", until: "2026-05-07T00:00:00Z", bucketSeconds: 60, limit: 5000 });
  assert.equal(stub.calls.length, 1);
  assert.match(stub.calls[0].sql, /date_trunc/, "vanilla pg path uses date_trunc");
  assert.doesNotMatch(stub.calls[0].sql, /time_bucket\(/);
});

test("aggregateSamples uses time_bucket when TimescaleDB is on", async () => {
  process.env.FORGE_PG_TIMESCALEDB = "1";
  const a = getHistorianBackend("postgresql");
  const stub = stubPool();
  a.pool = async () => stub;

  await a.aggregateSamples({ id: "P-1" }, { since: "2026-05-01T00:00:00Z", until: "2026-05-07T00:00:00Z", bucketSeconds: 60, limit: 5000 });
  assert.equal(stub.calls.length, 1);
  assert.match(stub.calls[0].sql, /time_bucket\(/, "TimescaleDB path uses time_bucket()");
  // Interval is passed as a string with seconds.
  assert.equal(stub.calls[0].params[0], "60 seconds");
});
