// SQL validator tests — `historian.sql.raw` chokepoint.
//
// Every reject case here is a real SQL-injection / data-exfiltration
// vector. The validator is the single chokepoint between operator-
// authored query templates and the `mssql` driver execution path; if
// it lets a forbidden shape through, the connector registry executes
// the query against the customer's external database. So the test
// matrix here is broad and pedantic on purpose.

import test from "node:test";
import assert from "node:assert/strict";

const { validateSelectTemplate, ALLOWED_PARAMS } = await import("../server/security/sql-validator.js");

function reject(template, expectedCode, label) {
  const r = validateSelectTemplate(template);
  assert.equal(r.ok, false, `${label || template} — expected reject`);
  assert.equal(r.code, expectedCode, `${label || template} — expected code=${expectedCode}, got ${r.code} (${r.message})`);
}
function accept(template, label) {
  const r = validateSelectTemplate(template);
  assert.equal(r.ok, true, `${label || template} — expected accept; failed with code=${r.code} message=${r.message}`);
  return r;
}

test("accepts a vanilla parameterised SELECT against forge_historian_samples", () => {
  const r = accept(
    "SELECT TOP 1000 ts, value, quality FROM forge_historian_samples WHERE point_id = :point_id AND ts > :since AND ts <= :until ORDER BY ts ASC"
  );
  assert.deepEqual([...r.params].sort(), ["point_id", "since", "until"]);
  // node-sql-parser exposes the MSSQL dialect under "transactsql".
  assert.equal(r.dialect, "transactsql");
});

test("accepts SELECT with LIMIT (non-mssql syntax) when LIMIT keyword present", () => {
  // Even on the mssql dialect, a LIMIT keyword in the template is
  // tolerated because some shops author cross-dialect templates.
  accept(
    "SELECT ts, value FROM telemetry WHERE point_id = :point_id LIMIT :limit"
  );
});

test("rejects empty / blank templates", () => {
  reject("", "empty", "empty string");
  reject("   ", "empty", "blank string");
});

test("rejects template > 8 KiB", () => {
  const long = "SELECT 1 FROM t WHERE x = :point_id LIMIT :limit -- " + "x".repeat(9000);
  reject(long, "too_long");
});

test("rejects line-comment markers (--)", () => {
  reject(
    "SELECT TOP 10 ts FROM t WHERE point_id = :point_id -- malicious comment\nLIMIT :limit",
    "comment_dash"
  );
});

test("rejects block-comment markers (/* */)", () => {
  reject(
    "SELECT TOP 10 ts FROM t /* hi */ WHERE point_id = :point_id LIMIT :limit",
    "comment_block"
  );
  reject(
    "SELECT TOP 10 ts FROM t WHERE point_id = :point_id LIMIT :limit */",
    "comment_block",
    "trailing block close"
  );
});

test("rejects hash comment lines (#)", () => {
  reject(
    "# this is mysql-style\nSELECT TOP 10 ts FROM t WHERE point_id = :point_id LIMIT :limit",
    "comment_hash"
  );
});

test("rejects multi-statement attacks via ';'", () => {
  reject(
    "SELECT TOP 1 ts FROM t WHERE point_id = :point_id LIMIT :limit; DROP TABLE users",
    "semicolon"
  );
});

test("rejects trailing ';'", () => {
  reject(
    "SELECT TOP 1 ts FROM t WHERE point_id = :point_id LIMIT :limit;",
    "trailing_semi"
  );
});

test("rejects DML statements (INSERT/UPDATE/DELETE/MERGE/REPLACE)", () => {
  // Each of these must NOT be `not_select` because the raw scan
  // catches them first via the structural rules; what we care about
  // is that the validator never returns ok:true for any of these.
  for (const stmt of [
    "INSERT INTO t VALUES (1)",
    "UPDATE t SET x = 1 WHERE y = :point_id",
    "DELETE FROM t WHERE y = :point_id",
    "MERGE INTO t USING s ON s.id = t.id WHEN MATCHED THEN UPDATE SET t.x = s.x",
    "REPLACE INTO t (a) VALUES (1)",
  ]) {
    const r = validateSelectTemplate(stmt);
    assert.equal(r.ok, false, `${stmt} — expected reject`);
    assert.notEqual(r.code, "ok");
  }
});

test("rejects DDL (CREATE / ALTER / DROP / TRUNCATE)", () => {
  for (const stmt of [
    "CREATE TABLE t (id INT)",
    "ALTER TABLE t ADD COLUMN x INT",
    "DROP TABLE t",
    "TRUNCATE TABLE t",
  ]) {
    const r = validateSelectTemplate(stmt);
    assert.equal(r.ok, false, `${stmt} — expected reject`);
  }
});

test("rejects DCL (GRANT / REVOKE) — any reject code", () => {
  // node-sql-parser shapes GRANT/REVOKE differently across dialects;
  // we don't pin the code, only the security property: never accepted.
  for (const stmt of ["GRANT SELECT ON t TO u", "REVOKE SELECT ON t FROM u"]) {
    const r = validateSelectTemplate(stmt);
    assert.equal(r.ok, false, `${stmt} — expected reject`);
  }
});

test("rejects EXEC / EXECUTE / CALL", () => {
  // These often parse as something exotic; we just confirm not ok.
  const stmts = [
    "EXEC sp_who",
    "EXECUTE sp_who",
    "CALL my_proc(:point_id)",
  ];
  for (const s of stmts) {
    const r = validateSelectTemplate(s);
    assert.equal(r.ok, false, `${s} — expected reject`);
  }
});

test("rejects SET / USE statements (database hop)", () => {
  for (const stmt of ["SET ANSI_NULLS ON", "USE master"]) {
    const r = validateSelectTemplate(stmt);
    assert.equal(r.ok, false, `${stmt} — expected reject`);
  }
});

test("rejects INFORMATION_SCHEMA / pg_catalog / sys / mysql / master enumeration", () => {
  for (const ns of ["information_schema", "pg_catalog", "sys", "mysql", "master"]) {
    const r = validateSelectTemplate(
      `SELECT TOP 10 table_name FROM ${ns}.tables WHERE table_name = :point_id LIMIT :limit`
    );
    assert.equal(r.ok, false, `${ns} — expected reject`);
    assert.equal(r.code, "forbidden_namespace");
  }
});

test("rejects unknown bind parameter (typo of :point_id)", () => {
  reject(
    "SELECT TOP 10 ts FROM t WHERE point = :pointid LIMIT :limit",
    "unknown_parameter"
  );
});

test("rejects parameter-free SELECT (no allowed bind param referenced)", () => {
  reject(
    "SELECT TOP 1 ts FROM t WHERE 1 = 1",
    "no_parameters"
  );
});

test("rejects missing LIMIT / TOP", () => {
  reject(
    "SELECT ts FROM t WHERE point_id = :point_id ORDER BY ts ASC",
    "missing_limit"
  );
});

test("rejects parse errors with stable code", () => {
  reject(
    "SELECT FROM WHERE point_id = :point_id LIMIT :limit",
    "parse_error"
  );
});

test("ALLOWED_PARAMS exposes the contract for clients", () => {
  // The frontend reads this list to render parameter chips; making the
  // contract part of the test suite stops accidental drift.
  assert.deepEqual(ALLOWED_PARAMS, ["point_id", "asset_id", "since", "until", "limit"]);
});

test("accepts every allowed parameter name in isolation", () => {
  for (const p of ALLOWED_PARAMS) {
    accept(
      `SELECT TOP 100 ts FROM t WHERE x = :${p} LIMIT 100`,
      `param :${p}`
    );
  }
});

test("multi-dialect: forge canonical names route to the right parser", () => {
  // Phase 7a — the validator now accepts both FORGE-canonical and
  // node-sql-parser-native dialect names. Each FORGE name must
  // accept its dialect's idiomatic SELECT.
  const cases = [
    { dialect: "mssql",      sql: "SELECT TOP 10 ts FROM t WHERE point_id = :point_id LIMIT :limit" },
    { dialect: "postgresql", sql: "SELECT ts FROM t WHERE point_id = :point_id LIMIT :limit" },
    { dialect: "mysql",      sql: "SELECT ts FROM t WHERE point_id = :point_id LIMIT :limit" },
    { dialect: "sqlite",     sql: "SELECT ts FROM t WHERE point_id = :point_id LIMIT :limit" },
  ];
  for (const c of cases) {
    const r = validateSelectTemplate(c.sql, { dialect: c.dialect });
    assert.equal(r.ok, true, `${c.dialect} accept failed: ${r.code} ${r.message}`);
    // The returned dialect is the parser-native name so callers
    // can plumb it to the executor without re-translating.
    assert.ok(r.dialect, `dialect echoed back for ${c.dialect}`);
  }
});

test("multi-dialect: bound-param + LIMIT rules apply uniformly", () => {
  for (const dialect of ["mssql", "postgresql", "mysql", "sqlite"]) {
    // Missing LIMIT rejected uniformly.
    const noLimit = validateSelectTemplate(
      "SELECT ts FROM t WHERE point_id = :point_id ORDER BY ts",
      { dialect }
    );
    assert.equal(noLimit.ok, false, `${dialect}: missing LIMIT must reject`);
    assert.equal(noLimit.code, "missing_limit");
    // Unknown bind param rejected uniformly.
    const badParam = validateSelectTemplate(
      "SELECT ts FROM t WHERE point = :pointid LIMIT :limit",
      { dialect }
    );
    assert.equal(badParam.ok, false, `${dialect}: unknown bind param must reject`);
    assert.equal(badParam.code, "unknown_parameter");
  }
});

test("structural reject (e.g. trailing semicolon) wins over namespace reject", () => {
  // When two reject rules both match, the raw-text scan runs first so
  // the operator gets the most actionable error. We rely on this
  // ordering for clear UX.
  const r = validateSelectTemplate(
    "SELECT * FROM information_schema.tables WHERE table_name = :point_id LIMIT :limit;"
  );
  assert.equal(r.ok, false);
  assert.equal(r.code, "trailing_semi");
});
