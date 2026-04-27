#!/usr/bin/env node
// Manual pre-migration snapshot.
//
// `migrate()` in `server/db.js` already takes an opportunistic backup
// every time `schema_version` advances, but ops sometimes want a
// snapshot ahead of an upgrade window: before a manual schema change,
// before a major version bump, or just to anchor a known-good state
// next to the live DB.
//
// This script:
//
//   - Reads the data dir from `FORGE_DATA_DIR` (default ./data).
//   - Calls better-sqlite3's online backup API so the copy is
//     consistent under concurrent WAL writes.
//   - Writes to `<DATA_DIR>/forge.db.bak-<schema_version>-<ts>` by
//     default, or to a path supplied as `--out <path>`.
//
// Examples:
//   node scripts/migrate-snapshot.js
//   FORGE_DATA_DIR=/var/lib/forge node scripts/migrate-snapshot.js
//   node scripts/migrate-snapshot.js --out /tmp/before-upgrade.db
//
// Exit codes:
//   0  snapshot succeeded
//   1  data dir missing / DB file missing / backup failed
//
// Companion: `node server/db.js --integrity` to validate FK state
// before applying a v12+ migration. See docs/SCHEMA_UPGRADE.md for
// the full upgrade SOP.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = process.env.FORGE_DATA_DIR
  ? path.resolve(process.env.FORGE_DATA_DIR)
  : path.resolve(ROOT, "data");
const DB_PATH = path.join(DATA_DIR, "forge.db");

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") out.out = argv[++i];
    else if (a === "--quiet") out.quiet = true;
    else if (a === "-h" || a === "--help") out.help = true;
    else { console.error(`unknown arg: ${a}`); process.exit(1); }
  }
  return out;
}

function logIfNotQuiet(args, msg) {
  if (!args.quiet) console.log(msg);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log("Usage: node scripts/migrate-snapshot.js [--out <path>] [--quiet]");
    process.exit(0);
  }
  if (!fs.existsSync(DATA_DIR)) {
    console.error(`FORGE_DATA_DIR does not exist: ${DATA_DIR}`);
    process.exit(1);
  }
  if (!fs.existsSync(DB_PATH)) {
    console.error(`no SQLite DB at: ${DB_PATH}`);
    process.exit(1);
  }
  // Open the DB read-only so we don't trigger migrate() (the snapshot
  // should reflect the *current* schema state, not the post-upgrade
  // one).
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(DB_PATH, { readonly: true });
  let version = "unknown";
  try {
    version = String(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value || "0");
  } catch {
    // meta table absent on a brand-new DB; fall through to "0"
    version = "0";
  }
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = args.out
    ? path.resolve(args.out)
    : path.join(DATA_DIR, `forge.db.bak-${version}-manual-${ts}`);
  logIfNotQuiet(args, `snapshotting ${DB_PATH} (schema_version=${version}) → ${dest}`);
  try {
    await db.backup(dest);
    db.close();
    const stat = fs.statSync(dest);
    logIfNotQuiet(args, `ok: ${stat.size} bytes`);
    process.exit(0);
  } catch (err) {
    db.close();
    console.error(`backup failed: ${String(err?.message || err)}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(String(err?.stack || err?.message || err));
  process.exit(1);
});
