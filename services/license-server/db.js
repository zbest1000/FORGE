// FORGE LLC central license server — SQLite schema.
//
// Stores customers, their licenses (one active per customer), the
// activation key hashes, audit events for every operator action, and a
// rolling history of entitlements issued (used for refresh validation
// and seat-overage detection).
//
// The signing private key is **not** stored here. It is supplied at
// runtime via FORGE_LICENSE_SIGNING_KEY (PEM) or
// FORGE_LICENSE_SIGNING_KEY_PATH so secrets stay in your secrets
// manager and the database file alone cannot be used to issue tokens.

import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.LICENSE_SERVER_DATA_DIR
  || path.resolve(__dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, "license-server.db");
export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("synchronous = NORMAL");

const SCHEMA_VERSION = 1;

db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);

function getVersion() {
  const r = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  return r ? Number(r.value) : 0;
}
function setVersion(v) {
  db.prepare("INSERT INTO meta(key, value) VALUES('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(String(v));
}

function migrate() {
  const v = getVersion();
  if (v >= SCHEMA_VERSION) return;
  db.transaction(() => {
    if (v < 1) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS customers (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          contact_email TEXT,
          status TEXT NOT NULL DEFAULT 'active',  -- active | disabled
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          notes TEXT
        );

        -- Activation keys are bearer secrets the customer's local
        -- license server uses to authenticate. We store only a SHA-256
        -- digest. A customer may have multiple keys live (e.g. for
        -- staged rotation), with at most one of each label.
        CREATE TABLE IF NOT EXISTS activation_keys (
          id TEXT PRIMARY KEY,
          customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
          label TEXT NOT NULL,
          key_hash TEXT NOT NULL UNIQUE,
          last_used_at TEXT,
          revoked_at TEXT,
          created_by TEXT,
          created_at TEXT NOT NULL,
          UNIQUE (customer_id, label)
        );

        -- One active license per customer at a time. Replacing one
        -- ends the previous (status='superseded').
        CREATE TABLE IF NOT EXISTS licenses (
          id TEXT PRIMARY KEY,
          customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
          tier TEXT NOT NULL,                    -- community | personal | team | enterprise
          edition TEXT,
          term TEXT NOT NULL,                    -- annual | perpetual
          seats INTEGER NOT NULL,
          features_add TEXT NOT NULL DEFAULT '[]',
          features_remove TEXT NOT NULL DEFAULT '[]',
          deployment TEXT NOT NULL DEFAULT 'self_hosted',
          starts_at TEXT NOT NULL,
          expires_at TEXT,                       -- null for perpetual
          maintenance_until TEXT,
          status TEXT NOT NULL DEFAULT 'active', -- active | superseded | revoked
          notes TEXT,
          created_by TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_licenses_customer ON licenses(customer_id, status);

        -- Activations record each successful contact from a local LS
        -- so the operator dashboard can see "where is this customer's
        -- LS deployed, when did it last refresh, what fingerprint".
        CREATE TABLE IF NOT EXISTS activations (
          id TEXT PRIMARY KEY,
          customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
          activation_key_id TEXT REFERENCES activation_keys(id),
          instance_id TEXT NOT NULL,
          fingerprint TEXT NOT NULL DEFAULT '{}',
          client_version TEXT,
          remote_ip TEXT,
          remote_country TEXT,
          first_seen_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          UNIQUE (customer_id, instance_id)
        );
        CREATE INDEX IF NOT EXISTS idx_activations_customer ON activations(customer_id, last_seen_at DESC);

        -- One row per entitlement bundle issued. We do NOT store the
        -- raw bundle (it can always be rebuilt) but we keep an id so
        -- a refresh request can prove possession without divulging
        -- the activation key.
        CREATE TABLE IF NOT EXISTS issued_entitlements (
          id TEXT PRIMARY KEY,
          customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
          activation_id TEXT REFERENCES activations(id),
          license_id TEXT REFERENCES licenses(id),
          issued_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          revoked_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_issued_customer ON issued_entitlements(customer_id, issued_at DESC);

        -- Append-only audit log for operator + system events.
        CREATE TABLE IF NOT EXISTS audit_log (
          id TEXT PRIMARY KEY,
          ts TEXT NOT NULL,
          actor TEXT NOT NULL,        -- operator email, or 'system'
          action TEXT NOT NULL,       -- license.create / license.revoke / activation_key.create / ...
          customer_id TEXT,
          subject TEXT,               -- license id, activation id, etc.
          remote_ip TEXT,
          detail TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX IF NOT EXISTS idx_audit_customer ON audit_log(customer_id, ts DESC);

        -- Operator credentials for the small admin API. Kept simple:
        -- bcrypt hash + role. Operators issue API tokens for the CLI.
        CREATE TABLE IF NOT EXISTS operators (
          id TEXT PRIMARY KEY,
          email TEXT UNIQUE NOT NULL,
          name TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'admin',  -- admin | viewer
          password_hash TEXT,
          api_token_hash TEXT,
          disabled INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        );
      `);
      setVersion(1);
    }
  })();
}

migrate();

export function now() { return new Date().toISOString(); }
export function uuid(prefix = "") {
  const s = (typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2)).replace(/-/g, "").slice(0, 16).toUpperCase();
  return prefix ? `${prefix}-${s}` : s;
}
export function tx(fn) { return db.transaction(fn)(); }

if (process.argv.includes("--migrate-only")) {
  console.log("schema_version =", getVersion());
  process.exit(0);
}
