// SQL driver registry tests — Phase 7a.
//
// Unit-tests the dialect-resolution + bind-rewriting logic in
// `server/connectors/sql-drivers.js`. The wire-execution paths
// (mssql / pg / mysql / sqlite) are exercised via the connector
// orchestrator's existing test seam (`setSampleFetcher`) and in
// each driver's own integration tests downstream — wiring real
// Postgres / MySQL fixtures here would balloon test cost without
// covering anything the dialect-resolution test doesn't already.

import test from "node:test";
import assert from "node:assert/strict";

const { dialectForBinding, parserDialectFor, rewriteNamedToPositional, DIALECTS, _internals } = await import("../server/connectors/sql-drivers.js");

test("DIALECTS is the canonical contract: mssql / postgresql / mysql / sqlite", () => {
  assert.deepEqual(Object.keys(DIALECTS).sort(), ["mssql", "mysql", "postgresql", "sqlite"]);
  // Each entry maps to a node-sql-parser dialect + a driver module.
  for (const v of Object.values(DIALECTS)) {
    assert.ok(v.parserDialect);
    assert.ok(v.driverModule);
  }
});

test("dialectForBinding: explicit binding.dialect wins", () => {
  const r = dialectForBinding({ binding: { dialect: "postgresql" }, system: { vendor: "MSSQL Server" } });
  assert.equal(r, "postgresql");
});

test("dialectForBinding: legacy aliases on binding.dialect resolve via VENDOR_ALIASES", () => {
  for (const [alias, expected] of [
    ["timescaledb", "postgresql"],
    ["timescale",   "postgresql"],
    ["sqlserver",   "mssql"],
    ["mariadb",     "mysql"],
    ["sqlite3",     "sqlite"],
  ]) {
    assert.equal(dialectForBinding({ binding: { dialect: alias } }), expected, `alias ${alias} → ${expected}`);
  }
});

test("dialectForBinding: falls back to system config.dialect", () => {
  const r = dialectForBinding({ system: { config: JSON.stringify({ dialect: "mysql" }), vendor: "Generic" } });
  assert.equal(r, "mysql");
});

test("dialectForBinding: fuzzy-matches system vendor + kind", () => {
  assert.equal(dialectForBinding({ system: { vendor: "PostgreSQL 16" } }), "postgresql");
  assert.equal(dialectForBinding({ system: { vendor: "MariaDB 11" } }), "mysql");
  assert.equal(dialectForBinding({ system: { vendor: "TimescaleDB", kind: "historian" } }), "postgresql");
  assert.equal(dialectForBinding({ system: { kind: "sqlite" } }), "sqlite");
});

test("dialectForBinding: defaults to mssql for back-compat", () => {
  // No clue from anywhere → mssql (Phase 3's only supported dialect).
  assert.equal(dialectForBinding({ system: { vendor: "GenericVendor" } }), "mssql");
  assert.equal(dialectForBinding({}), "mssql");
});

test("parserDialectFor: forge → node-sql-parser names", () => {
  assert.equal(parserDialectFor("mssql"), "transactsql");
  assert.equal(parserDialectFor("postgresql"), "postgresql");
  assert.equal(parserDialectFor("mysql"), "mysql");
  assert.equal(parserDialectFor("sqlite"), "sqlite");
});

test("rewriteNamedToPositional postgres uses $1..$n in source order", () => {
  const { sql, ordered } = rewriteNamedToPositional(
    "SELECT * FROM t WHERE point_id = :point_id AND ts > :since LIMIT :limit",
    { point_id: "HP-1", since: "2026-01-01", limit: 100 },
    "postgres"
  );
  assert.equal(sql, "SELECT * FROM t WHERE point_id = $1 AND ts > $2 LIMIT $3");
  assert.deepEqual(ordered, ["HP-1", "2026-01-01", 100]);
});

test("rewriteNamedToPositional mysql uses ?", () => {
  const { sql, ordered } = rewriteNamedToPositional(
    "SELECT * FROM t WHERE asset_id = :asset_id AND ts <= :until LIMIT :limit",
    { asset_id: "AS-1", until: "2026-12-31", limit: 50 },
    "mysql"
  );
  assert.equal(sql, "SELECT * FROM t WHERE asset_id = ? AND ts <= ? LIMIT ?");
  assert.deepEqual(ordered, ["AS-1", "2026-12-31", 50]);
});

test("rewriteNamedToPositional throws on missing param", () => {
  assert.throws(
    () => rewriteNamedToPositional("SELECT :missing FROM t LIMIT :limit", { limit: 10 }, "postgres"),
    (e) => e.code === "missing_param"
  );
});

test("rewriteNamedToPositional preserves repeat parameter order", () => {
  const { sql, ordered } = rewriteNamedToPositional(
    "SELECT * FROM t WHERE point_id = :point_id AND old_point_id = :point_id LIMIT :limit",
    { point_id: "HP-1", limit: 1 },
    "postgres"
  );
  // Each occurrence gets its own positional slot; same value emitted twice.
  assert.equal(sql, "SELECT * FROM t WHERE point_id = $1 AND old_point_id = $2 LIMIT $3");
  assert.deepEqual(ordered, ["HP-1", "HP-1", 1]);
});

test("getDriver surfaces driver_missing for unknown dialect", async () => {
  await assert.rejects(_internals.getDriver("oracle"), (e) => e.code === "unknown_dialect");
});
