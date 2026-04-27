// In-process login-failure tracker.
//
// FORGE is single-replica by design today (see `docs/ENTERPRISE_READINESS_AUDIT.md`
// section B.5). For multi-replica deployments this map needs to move to
// Redis or the DB; the public surface is intentionally small so the swap
// is easy.
//
// Policy
// ------
// - Per-subject (email-hash) limit: 5 failures in 15 minutes → 15 min lock.
// - Per-IP limit: 25 failures in 15 minutes → 15 min lock. Catches
//   credential-stuffing across many emails.
// - Successful login resets both counters for the (subject, IP) pair.

const WINDOW_MS = 15 * 60 * 1000;
const SUBJECT_THRESHOLD = Number(process.env.FORGE_LOGIN_LOCKOUT_SUBJECT || 5);
const IP_THRESHOLD = Number(process.env.FORGE_LOGIN_LOCKOUT_IP || 25);
const LOCKOUT_MS = Number(process.env.FORGE_LOGIN_LOCKOUT_MS || 15 * 60 * 1000);

const subjects = new Map();
const ips = new Map();

function clock() { return Date.now(); }

function bump(map, key, threshold) {
  const now = clock();
  let entry = map.get(key);
  if (!entry || (now - entry.firstAt) > WINDOW_MS) {
    entry = { count: 0, firstAt: now, lockUntil: 0 };
  }
  entry.count += 1;
  if (entry.count >= threshold) {
    entry.lockUntil = now + LOCKOUT_MS;
  }
  map.set(key, entry);
  return entry;
}

function lockState(map, key) {
  const entry = map.get(key);
  if (!entry) return null;
  const now = clock();
  if (entry.lockUntil > now) {
    return { count: entry.count, retryAfterMs: entry.lockUntil - now };
  }
  if ((now - entry.firstAt) > WINDOW_MS) {
    map.delete(key);
    return null;
  }
  return { count: entry.count, retryAfterMs: 0 };
}

export function isLockedOut(subjectKey, ip) {
  const s = lockState(subjects, subjectKey);
  if (s?.retryAfterMs) return { locked: true, reason: "subject", retryAfterMs: s.retryAfterMs };
  const i = lockState(ips, ip);
  if (i?.retryAfterMs) return { locked: true, reason: "ip", retryAfterMs: i.retryAfterMs };
  return { locked: false };
}

export function recordLoginFailure(subjectKey, ip) {
  const s = bump(subjects, subjectKey, SUBJECT_THRESHOLD);
  const i = bump(ips, ip, IP_THRESHOLD);
  return {
    subjectFailures: s.count,
    subjectThreshold: SUBJECT_THRESHOLD,
    ipFailures: i.count,
    ipThreshold: IP_THRESHOLD,
    locked: s.lockUntil > 0 || i.lockUntil > 0,
  };
}

export function resetLockout(subjectKey, ip) {
  subjects.delete(subjectKey);
  if (ip) ips.delete(ip);
}

export function lockoutSummary(ip) {
  const i = lockState(ips, ip);
  return {
    subjectThreshold: SUBJECT_THRESHOLD,
    ipThreshold: IP_THRESHOLD,
    ipFailures: i?.count || 0,
    ipLockedForMs: i?.retryAfterMs || 0,
  };
}

// Test helper. Not part of the public surface.
export function _resetAll() {
  subjects.clear();
  ips.clear();
}
