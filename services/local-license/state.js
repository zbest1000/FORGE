// Local license server — persistent state.
//
// Stores the most recently issued entitlement bundle to disk so the
// process can restart without re-activating against the central
// server. The store is intentionally a JSON file, not SQLite — this
// service is a single-instance sidecar with one row of state.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const STATE_DIR = process.env.LOCAL_LICENSE_DATA_DIR
  || path.resolve(__dirname, "data");
fs.mkdirSync(STATE_DIR, { recursive: true });
const STATE_FILE = path.join(STATE_DIR, "state.json");

function readSafe() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return {}; }
}

function writeAtomic(obj) {
  const tmp = STATE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

let cached = readSafe();

export function getState() { return { ...cached }; }

export function saveActivation({ entitlement, bundle_id, customer, license, issued_at, expires_at, refresh_at }) {
  cached = {
    ...cached,
    entitlement,
    bundle_id,
    customer,
    license,
    issued_at,
    expires_at,
    refresh_at,
    last_central_at: new Date().toISOString(),
    activation_status: "ok",
    activation_error: null,
  };
  writeAtomic(cached);
  return cached;
}

export function recordRefreshFailure(message) {
  cached = {
    ...cached,
    activation_status: "offline",
    activation_error: message,
    last_failure_at: new Date().toISOString(),
  };
  writeAtomic(cached);
  return cached;
}

export function clearActivation() {
  cached = {};
  try { fs.unlinkSync(STATE_FILE); } catch {}
  return cached;
}

export function isOnline() { return cached.activation_status === "ok"; }
