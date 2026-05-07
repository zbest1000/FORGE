#!/usr/bin/env node
// One-shot schema initialiser for the Postgres + TimescaleDB historian
// backend.
//
// Usage:
//   FORGE_PG_CONNECTION_STRING=postgresql://user:pwd@host:5432/db \
//     node scripts/historians/pg-init.mjs
//
//   # With TimescaleDB hypertables (recommended for >1M rows / point):
//   FORGE_PG_CONNECTION_STRING=... \
//   FORGE_PG_TIMESCALEDB=1 \
//     node scripts/historians/pg-init.mjs
//
// Idempotent — re-running is safe. The script:
//   1. Verifies connectivity.
//   2. Creates `forge_historian_samples` if absent.
//   3. Creates the (point_id, ts) read-path index.
//   4. (TimescaleDB only) Converts the table to a hypertable and
//      sets a 1-year retention policy. If the timescaledb extension
//      isn't installed, the script reports the gap and proceeds with
//      a vanilla table.
//
// Why a script and not a runtime-bootstrap migration: introducing
// auto-DDL on every server start would be a footgun when an operator
// is layering FORGE on top of an existing Postgres they don't own.
// The init step stays opt-in and explicit.

import process from "node:process";

const conn = process.env.FORGE_PG_CONNECTION_STRING;
if (!conn) {
  console.error("FORGE_PG_CONNECTION_STRING is not set. Aborting.");
  process.exit(1);
}
const useTimescale = process.env.FORGE_PG_TIMESCALEDB === "1";

let pg;
try { pg = await import("pg"); }
catch {
  console.error("`pg` package not installed. Run `npm install pg` (it's in optionalDependencies) and retry.");
  process.exit(2);
}

const Pool = pg.default?.Pool || pg.Pool;
const pool = new Pool({ connectionString: conn });

async function exec(sql, label) {
  process.stdout.write(`  · ${label} ... `);
  try {
    await pool.query(sql);
    console.log("ok");
    return true;
  } catch (err) {
    console.log(`failed: ${err.message}`);
    return false;
  }
}

console.log(`Initialising FORGE historian schema on ${redact(conn)} ${useTimescale ? "(TimescaleDB)" : "(vanilla Postgres)"}\n`);

// Connectivity check.
try {
  const r = await pool.query("SELECT version()");
  console.log(`Connected: ${r.rows[0].version.split(",")[0]}\n`);
} catch (err) {
  console.error(`Connection failed: ${err.message}`);
  await pool.end().catch(() => {});
  process.exit(3);
}

// Table.
await exec(`
  CREATE TABLE IF NOT EXISTS forge_historian_samples (
    point_id    text        NOT NULL,
    asset_id    text,
    tag         text,
    ts          timestamptz NOT NULL,
    value       double precision,
    quality     text        NOT NULL DEFAULT 'Good',
    source_type text,
    PRIMARY KEY (point_id, ts)
  )
`, "create table forge_historian_samples");

// Read-path index: server/historians/index.js's querySamples filters
// by point_id + ts range, and the existing primary key already covers
// that, but a separate index on (ts) helps the OPC UA HA service
// scan recent samples across all points cheaply.
await exec(`
  CREATE INDEX IF NOT EXISTS idx_forge_historian_samples_ts
    ON forge_historian_samples (ts)
`, "create idx_forge_historian_samples_ts");

if (useTimescale) {
  // TimescaleDB: convert to hypertable so writes auto-shard by time.
  // The CREATE EXTENSION step is a no-op when the extension is
  // already installed, and reports a clear error when it isn't.
  const haveExt = await exec(
    `CREATE EXTENSION IF NOT EXISTS timescaledb`,
    "ensure timescaledb extension"
  );
  if (haveExt) {
    await exec(`
      SELECT create_hypertable('forge_historian_samples', 'ts',
                               if_not_exists => TRUE)
    `, "create_hypertable on ts");

    // 1-year retention policy by default. Operators that need more
    // history adjust this AFTER init — re-running the script doesn't
    // change a policy that's already configured.
    await exec(`
      SELECT add_retention_policy('forge_historian_samples',
                                   INTERVAL '1 year',
                                   if_not_exists => TRUE)
    `, "add 1y retention policy");
  } else {
    console.log("\n  ⚠  TimescaleDB extension not available — table left as a vanilla Postgres table.");
    console.log("     Install the extension (Timescale Cloud / your-pg-package-manager) and re-run.\n");
  }
}

await pool.end();
console.log("\nDone. The historian backend will use this table when FORGE_HISTORIAN=postgresql.");

function redact(url) {
  try { const u = new URL(url); u.password = "***"; return u.toString(); }
  catch { return "<conn-string>"; }
}
