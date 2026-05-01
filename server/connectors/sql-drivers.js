// Multi-vendor SQL driver registry for the *ingest* side
// (asset_point_bindings whose `source_kind = 'sql'`).
//
// FORGE supports three classes of SQL data source on the ingest
// path, mirroring the historian-write side:
//
//   - mssql       — driver: `mssql` (already required)
//   - postgresql  — driver: `pg`   (optionalDependency; covers
//                                   vanilla Postgres + TimescaleDB
//                                   + AWS RDS / Aurora-Postgres)
//   - mysql       — driver: `mysql2/promise` (optionalDependency;
//                                              covers MySQL + MariaDB)
//   - sqlite      — driver: `better-sqlite3` (already required;
//                                              external SQLite files
//                                              over a path)
//
// node-sql-parser dialect names differ from ours; the registry
// translates between the two so the validator and the executor
// agree on which dialect to use.
//
// All drivers are loaded lazily via dynamic import. A binding
// referencing a driver whose package isn't installed surfaces a
// structured error through the connector orchestrator instead of
// crashing the boot path.
//
// Spec ref: docs/INDUSTRIAL_EDGE_PLATFORM_SPEC.md §3.4 (Tier 1
// protocols include SQL); §3.1 (driver contract); §15.1 (TLS for
// the connection string).

import { jsonOrDefault } from "../db.js";

/**
 * Canonical FORGE dialect → { parserDialect, driverModule }.
 * `parserDialect` is the string `node-sql-parser` accepts in its
 * `database` option (see test/sql-validator.test.js).
 */
export const DIALECTS = Object.freeze({
  mssql:      { parserDialect: "transactsql", driverModule: "mssql" },
  postgresql: { parserDialect: "postgresql",  driverModule: "pg" },
  mysql:      { parserDialect: "mysql",       driverModule: "mysql2/promise" },
  sqlite:     { parserDialect: "sqlite",      driverModule: "better-sqlite3" },
});

const VENDOR_ALIASES = new Map([
  ["mssql", "mssql"],
  ["sqlserver", "mssql"],
  ["sql_server", "mssql"],
  ["microsoftsql", "mssql"],
  ["microsoft", "mssql"],
  ["postgres", "postgresql"],
  ["postgresql", "postgresql"],
  ["psql", "postgresql"],
  ["timescaledb", "postgresql"],
  ["timescale", "postgresql"],
  ["aurora", "postgresql"],
  ["mysql", "mysql"],
  ["maria", "mysql"],
  ["mariadb", "mysql"],
  ["sqlite", "sqlite"],
  ["sqlite3", "sqlite"],
]);

/**
 * Pick a FORGE-canonical dialect for a binding given (in priority):
 *   1. The binding's own `dialect` column (Phase 7a v17 added it).
 *   2. The system row's config.dialect.
 *   3. The system's vendor / kind / category fuzzy-matched.
 *   4. Hard default `mssql` for back-compat with Phase 3 bindings.
 */
export function dialectForBinding({ binding, system } = {}) {
  if (binding && typeof binding.dialect === "string" && binding.dialect) {
    const norm = String(binding.dialect).toLowerCase();
    if (DIALECTS[norm]) return norm;
    if (VENDOR_ALIASES.has(norm)) return VENDOR_ALIASES.get(norm);
  }
  if (system) {
    const cfg = jsonOrDefault(system.config, {});
    if (cfg.dialect && DIALECTS[String(cfg.dialect).toLowerCase()]) {
      return String(cfg.dialect).toLowerCase();
    }
    const haystack = `${system.vendor || ""} ${system.kind || ""} ${system.category || ""}`.toLowerCase();
    // Substring scan — "PostgreSQL 16", "MariaDB 11", "Microsoft SQL
    // Server 2022", etc. all hit the right alias.
    for (const [needle, dialect] of VENDOR_ALIASES.entries()) {
      if (haystack.includes(needle)) return dialect;
    }
  }
  return "mssql";
}

/**
 * Returns the parser dialect string for `node-sql-parser` so the
 * validator and the executor agree on which dialect was used.
 */
export function parserDialectFor(forgeDialect) {
  const d = DIALECTS[forgeDialect];
  return d ? d.parserDialect : DIALECTS.mssql.parserDialect;
}

/**
 * Lazy-import the underlying driver module. Returns null when the
 * package isn't installed (the connector orchestrator surfaces
 * the missing-driver error to the operator via connector_runs).
 *
 * `getDriver()` keeps a process-local cache so repeat calls are
 * cheap.
 */
const _driverCache = new Map();
async function getDriver(forgeDialect) {
  if (_driverCache.has(forgeDialect)) return _driverCache.get(forgeDialect);
  const def = DIALECTS[forgeDialect];
  if (!def) {
    const err = new Error(`unknown SQL dialect: ${forgeDialect}`);
    err.code = "unknown_dialect";
    throw err;
  }
  let mod;
  try {
    mod = await import(def.driverModule);
  } catch (err) {
    const e = new Error(`SQL driver "${def.driverModule}" is not installed (npm install ${def.driverModule})`);
    e.code = "driver_missing";
    e.cause = err;
    throw e;
  }
  _driverCache.set(forgeDialect, mod);
  return mod;
}

/**
 * Run a parameterised SELECT against the system's connection string.
 *
 * `params` is a flat record `{ point_id, asset_id, since, until,
 * limit }` matching the validator's ALLOWED_PARAMS. Each driver
 * substitutes the named bind syntax it expects ($1/@p1/?:?) so
 * the same query template ports across dialects.
 *
 * The function intentionally does NOT do its own validation — that
 * has already happened at write-time (server/security/sql-validator.js).
 * It does enforce a per-system query-time-budget so a runaway query
 * doesn't stall the connector subregistry.
 *
 * Returns a list of `{ ts, value, quality }` rows so the connector
 * registry's dispatch loop is dialect-agnostic.
 */
export async function executeSelect({ system, dialect, query, params, timeoutMs = Number(process.env.FORGE_SQL_QUERY_TIMEOUT_MS || 5000) }) {
  if (!system) throw Object.assign(new Error("system required"), { code: "missing_system" });
  if (!query) throw Object.assign(new Error("query required"), { code: "missing_query" });
  const forgeDialect = dialect || dialectForBinding({ system });
  const driver = await getDriver(forgeDialect);

  // Each branch here is short on purpose — the heavy lifting is in
  // the historian adapter for the *historian-read* side; this is
  // for *ingest from external SQL* which is mostly the same
  // SELECT shape but per-driver bind syntax.
  switch (forgeDialect) {
    case "mssql":      return mssqlSelect({ driver, system, query, params, timeoutMs });
    case "postgresql": return postgresSelect({ driver, system, query, params, timeoutMs });
    case "mysql":      return mysqlSelect({ driver, system, query, params, timeoutMs });
    case "sqlite":     return sqliteSelect({ driver, system, query, params, timeoutMs });
    default: {
      const err = new Error(`unsupported SQL dialect: ${forgeDialect}`);
      err.code = "unsupported_dialect";
      throw err;
    }
  }
}

// ---------- per-dialect implementations ----------

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => {
      const err = new Error("SQL query timeout");
      err.code = "query_timeout";
      reject(err);
    }, ms)),
  ]);
}

async function mssqlSelect({ driver, system, query, params, timeoutMs }) {
  const sql = driver.default || driver;
  const pool = await sql.connect(system.base_url);
  const req = pool.request();
  for (const [k, v] of Object.entries(params || {})) {
    req.input(k, mssqlTypeFor(v), v);
  }
  const result = await withTimeout(req.query(query), timeoutMs);
  return (result?.recordset || []).map(rowFromMssql);
}
function mssqlTypeFor(v) {
  // Use `mssql`'s NVarChar for strings, DateTime2 for Date, Float for numbers,
  // Int for integers; falls back to NVarChar so unknown values aren't a crash.
  // We import lazily; this helper resolves on demand.
  if (v instanceof Date) return _mssqlSql().DateTime2;
  if (typeof v === "number") return Number.isInteger(v) ? _mssqlSql().Int : _mssqlSql().Float;
  return _mssqlSql().NVarChar;
}
let _mssqlSqlCache = null;
function _mssqlSql() {
  if (_mssqlSqlCache) return _mssqlSqlCache;
  // synchronous getter — only safe AFTER getDriver('mssql') has resolved.
  // We snapshot the namespace from the cached module.
  const m = _driverCache.get("mssql");
  _mssqlSqlCache = m?.default || m;
  return _mssqlSqlCache;
}
function rowFromMssql(r) {
  return {
    ts: r.ts ? new Date(r.ts).toISOString() : (r.timestamp ? new Date(r.timestamp).toISOString() : null),
    value: Number(r.value),
    quality: r.quality || "Good",
    raw: r,
  };
}

async function postgresSelect({ driver, system, query, params, timeoutMs }) {
  const Pool = driver.default?.Pool || driver.Pool;
  // We don't pool aggressively here — reuse the system-level pool
  // pattern would complicate per-binding cancellation. A lightweight
  // per-call client is fine for poll-cadence workloads (≤1 QPS per
  // binding by default).
  const pool = new Pool({ connectionString: system.base_url });
  // pg uses positional $1..$n bind. Convert :name → $i preserving
  // the param order so the validator's already-vetted query stays
  // intact.
  const { sql: rewritten, ordered } = rewriteNamedToPositional(query, params, "postgres");
  try {
    const result = await withTimeout(pool.query(rewritten, ordered), timeoutMs);
    return (result.rows || []).map(rowFromGeneric);
  } finally {
    await pool.end();
  }
}

async function mysqlSelect({ driver, system, query, params, timeoutMs }) {
  const mysql = driver.default || driver;
  const conn = await mysql.createConnection({ uri: system.base_url });
  // mysql2 supports named placeholders only with `namedPlaceholders: true`,
  // which we set per connection. We could alternatively rewrite to `?`.
  conn.config.namedPlaceholders = true;
  try {
    const [rows] = await withTimeout(conn.query(query, params || {}), timeoutMs);
    return (rows || []).map(rowFromGeneric);
  } finally {
    try { await conn.end(); } catch { /* swallow */ }
  }
}

async function sqliteSelect({ driver, system, query, params, timeoutMs: _t }) {
  // External SQLite — `system.base_url` is a filesystem path. We
  // don't pool because better-sqlite3 is synchronous; we open and
  // close per call. `_t` is unused since better-sqlite3 doesn't
  // support cancellation.
  const Database = driver.default || driver;
  const ext = new Database(system.base_url, { readonly: true, fileMustExist: true });
  try {
    const stmt = ext.prepare(query);
    const rows = stmt.all(params || {});
    return (rows || []).map(rowFromGeneric);
  } finally {
    try { ext.close(); } catch { /* swallow */ }
  }
}

function rowFromGeneric(r) {
  return {
    ts: r.ts ? new Date(r.ts).toISOString() : (r.timestamp ? new Date(r.timestamp).toISOString() : null),
    value: Number(r.value),
    quality: r.quality || "Good",
    raw: r,
  };
}

/**
 * Convert `:name` placeholders to positional `$1..$n` (postgres) or
 * `?` (mysql). Order of the returned `ordered` array matches the
 * order names appear in the SQL string. Callers then pass `ordered`
 * to the driver's positional API.
 */
export function rewriteNamedToPositional(query, params, style) {
  const ordered = [];
  const seen = [];
  const re = /:([a-zA-Z_][a-zA-Z0-9_]*)/g;
  const sql = query.replace(re, (_, name) => {
    seen.push(name);
    if (style === "postgres") return `$${seen.length}`;
    return "?";
  });
  for (const name of seen) {
    if (!Object.prototype.hasOwnProperty.call(params || {}, name)) {
      const err = new Error(`missing bind parameter :${name}`);
      err.code = "missing_param";
      throw err;
    }
    ordered.push(params[name]);
  }
  return { sql, ordered };
}

// Test-harness introspection.
export const _internals = { getDriver, rewriteNamedToPositional, VENDOR_ALIASES };
