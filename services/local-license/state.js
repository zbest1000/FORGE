// Local license server — persistent state.
//
// Stores the long-lived activation token + the most recent
// supersession/heartbeat status to disk. Under the new activation
// model the local LS does NOT periodically refresh: once activated
// it serves the cached token unless the customer (or the FORGE LLC
// operator) explicitly releases or revokes it.

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

/**
 * Persist a successful activation. The token is the immutable signed
 * artefact handed to FORGE app instances; everything else is bookkeeping.
 */
export function saveActivation({ activation_token, activation_id, activation_token_id, customer, license, issued_at, instance_id }) {
  cached = {
    ...cached,
    activation_token,
    activation_id,
    activation_token_id,
    customer,
    license,
    issued_at,
    instance_id,
    activation_status: "active",
    activation_status_updated_at: new Date().toISOString(),
    last_heartbeat_at: null,
    last_heartbeat_error: null,
    superseded_by: null,
    released_at: null,
  };
  writeAtomic(cached);
  return cached;
}

/**
 * Reflect the central server's view of this activation back into the
 * local cache after a heartbeat. If the central server says we've
 * been superseded, released, or revoked we DO keep the token on disk
 * so downstream tooling can still inspect the last known state.
 */
export function applyHeartbeatResult({ active, status, activation_status, superseded_by, released_at, revoked_at, last_seen_at }) {
  cached = {
    ...cached,
    activation_status: status || activation_status || cached.activation_status,
    activation_status_updated_at: new Date().toISOString(),
    last_heartbeat_at: last_seen_at || new Date().toISOString(),
    last_heartbeat_error: null,
    superseded_by: superseded_by || null,
    released_at: released_at || null,
    revoked_at: revoked_at || null,
  };
  writeAtomic(cached);
  return cached;
}

export function recordHeartbeatError(message) {
  cached = {
    ...cached,
    last_heartbeat_error: message,
    last_heartbeat_at: new Date().toISOString(),
  };
  writeAtomic(cached);
  return cached;
}

/**
 * After a successful self-release, mark the cached activation as gone
 * so the local LS stops serving it. The next activate() call will
 * obtain a fresh slot.
 */
export function markReleased() {
  cached = {
    ...cached,
    activation_status: "released",
    released_at: new Date().toISOString(),
    activation_token: null,
    activation_token_id: null,
  };
  writeAtomic(cached);
  return cached;
}

export function clear() {
  cached = {};
  try { fs.unlinkSync(STATE_FILE); } catch {}
  return cached;
}
