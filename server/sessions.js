// Session + refresh-token store.
//
// Issues short-lived access JWTs paired with long-lived refresh tokens.
// Every JWT we mint carries `sid` (= `sessions.id`) and `jti`
// (= `sessions.access_jti`). The auth resolver in `server/main.js`
// rejects access tokens whose session row is revoked or whose `jti`
// does not match the session's current `access_jti`. That guarantees:
//
//   - `POST /api/auth/logout` revokes the session row → existing JWT
//     stops working immediately on next request.
//   - Refresh rotation invalidates the previous JWT for the same
//     session, so a stolen access token cannot ride alongside the new
//     one.
//   - "Sign out everywhere" (revoke-all) is a single SQL update.
//
// Refresh tokens look like `fsr_<sessionId>_<random>`; only the
// `sha256` of the random part is persisted. The plaintext is returned
// to the client exactly once. The previous hash is kept on the row so
// replay of an already-rotated refresh token can be detected and
// trigger session-wide revocation (suspected token theft).
//
// Defaults:
//   - access TTL  : 30 min  (FORGE_ACCESS_TTL_MIN)
//   - refresh TTL : 30 days (FORGE_REFRESH_TTL_DAYS)
//
// All times are stored as ISO strings to match the rest of the schema.

import crypto from "node:crypto";
import { db, now, uuid } from "./db.js";
import { audit } from "./audit.js";

const ACCESS_TTL_S = Number(process.env.FORGE_ACCESS_TTL_MIN || 30) * 60;
const REFRESH_TTL_DAYS = Number(process.env.FORGE_REFRESH_TTL_DAYS || 30);

export const ACCESS_JWT_EXPIRES_IN = `${Math.max(60, ACCESS_TTL_S)}s`;

function isoPlus(seconds) {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function hashRefreshSecret(secret) {
  return crypto.createHash("sha256").update(String(secret || "")).digest("hex");
}

function splitRefresh(token) {
  if (!token || typeof token !== "string" || !token.startsWith("fsr_")) return null;
  const rest = token.slice(4);
  const idx = rest.indexOf("_");
  if (idx <= 0) return null;
  const sessionId = rest.slice(0, idx);
  const secret = rest.slice(idx + 1);
  if (!sessionId || !secret) return null;
  return { sessionId, secret };
}

function newAccessJti() { return uuid("AJT"); }
function newSessionId() { return uuid("SID"); }
function newRefreshSecret() { return crypto.randomBytes(32).toString("base64url"); }

const stmtInsert = db.prepare(`
  INSERT INTO sessions (id, user_id, access_jti, refresh_hash, mfa, ip, user_agent,
                        created_at, last_used_at, rotated_at, expires_at, refresh_expires_at)
  VALUES (@id, @user_id, @access_jti, @refresh_hash, @mfa, @ip, @user_agent,
          @created_at, @last_used_at, NULL, @expires_at, @refresh_expires_at)
`);
const stmtById = db.prepare("SELECT * FROM sessions WHERE id = ?");
const stmtByRefresh = db.prepare("SELECT * FROM sessions WHERE refresh_hash = ?");
const stmtByPrevRefresh = db.prepare("SELECT * FROM sessions WHERE previous_refresh_hash = ?");
const stmtRotate = db.prepare(`
  UPDATE sessions
     SET access_jti = @access_jti,
         refresh_hash = @refresh_hash,
         previous_refresh_hash = @previous_refresh_hash,
         rotated_at = @rotated_at,
         last_used_at = @last_used_at,
         refresh_expires_at = @refresh_expires_at
   WHERE id = @id
`);
const stmtTouch = db.prepare("UPDATE sessions SET last_used_at = ? WHERE id = ?");
const stmtRevoke = db.prepare("UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE id = ? AND revoked_at IS NULL");
const stmtRevokeAllForUser = db.prepare("UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE user_id = ? AND revoked_at IS NULL");
const stmtListForUser = db.prepare("SELECT id, mfa, ip, user_agent, created_at, last_used_at, rotated_at, expires_at, refresh_expires_at, revoked_at, revoked_reason FROM sessions WHERE user_id = ? ORDER BY created_at DESC");

/**
 * Open a new session for `user`. Returns `{ session, refreshToken,
 * accessJwt }` after the caller signs the access JWT — we cannot sign
 * here because Fastify's `reply.jwtSign` is bound to the request scope.
 */
export function createSession({ userId, mfa = 0, ip = null, userAgent = null }) {
  const id = newSessionId();
  const access_jti = newAccessJti();
  const refreshSecret = newRefreshSecret();
  const refresh_hash = hashRefreshSecret(refreshSecret);
  const ts = now();
  // The schema's `mfa` column is `INTEGER NOT NULL DEFAULT 0` and acts
  // as a boolean "session was MFA-verified" flag. Callers historically
  // passed an MFA method name string (e.g. "totp") or null; coerce so
  // any truthy value becomes 1 and any falsy/missing value becomes 0,
  // and the schema's NOT NULL constraint is never tripped by a
  // forwarded `null`.
  const mfaFlag = mfa ? 1 : 0;
  stmtInsert.run({
    id, user_id: userId, access_jti, refresh_hash,
    mfa: mfaFlag, ip, user_agent: userAgent,
    created_at: ts, last_used_at: ts,
    expires_at: isoPlus(ACCESS_TTL_S),
    refresh_expires_at: isoPlus(REFRESH_TTL_DAYS * 86_400),
  });
  audit({ actor: userId, action: "session.create", subject: id, detail: { ip, mfa: mfaFlag } });
  return {
    sessionId: id,
    accessJti: access_jti,
    refreshToken: `fsr_${id}_${refreshSecret}`,
    refreshExpiresAt: isoPlus(REFRESH_TTL_DAYS * 86_400),
    accessExpiresAt: isoPlus(ACCESS_TTL_S),
  };
}

/**
 * Validate that an access JWT's `sid`+`jti` still matches an active
 * session. Returns the row on success, null on failure.
 *
 * Failure cases (all return null):
 *   - no such session row
 *   - session revoked
 *   - jti has been rotated (the holder is using a stale access token)
 */
export function authenticateAccess({ sid, jti }) {
  if (!sid || !jti) return null;
  const row = stmtById.get(sid);
  if (!row) return null;
  if (row.revoked_at) return null;
  if (row.access_jti !== jti) return null;
  stmtTouch.run(now(), row.id);
  return row;
}

/**
 * Rotate a refresh token. Issues a fresh access_jti and refresh secret;
 * the caller signs and returns a new access JWT. Detects refresh-reuse
 * (a token that matches `previous_refresh_hash`) and revokes the entire
 * session as a precaution against token theft.
 */
export function rotateRefresh(plainRefresh) {
  const parsed = splitRefresh(plainRefresh);
  if (!parsed) return { error: "invalid_refresh" };
  const refreshHash = hashRefreshSecret(parsed.secret);

  let row = stmtByRefresh.get(refreshHash);
  if (!row) {
    // Reuse detection: this token is no longer current. If it matches a
    // previous_refresh_hash, the legitimate user has already rotated;
    // someone else is replaying the old token. Burn the session.
    const replay = stmtByPrevRefresh.get(refreshHash);
    if (replay && !replay.revoked_at) {
      stmtRevoke.run(now(), "refresh_reuse_detected", replay.id);
      audit({ actor: replay.user_id, action: "session.revoke", subject: replay.id, detail: { reason: "refresh_reuse_detected" } });
    }
    return { error: "invalid_refresh" };
  }
  if (row.id !== parsed.sessionId) return { error: "invalid_refresh" };
  if (row.revoked_at) return { error: "session_revoked" };
  if (row.refresh_expires_at && Date.parse(row.refresh_expires_at) < Date.now()) {
    stmtRevoke.run(now(), "refresh_expired", row.id);
    return { error: "refresh_expired" };
  }

  const newJti = newAccessJti();
  const newSecret = newRefreshSecret();
  const newHash = hashRefreshSecret(newSecret);
  const ts = now();
  stmtRotate.run({
    id: row.id,
    access_jti: newJti,
    refresh_hash: newHash,
    previous_refresh_hash: refreshHash,
    rotated_at: ts,
    last_used_at: ts,
    refresh_expires_at: isoPlus(REFRESH_TTL_DAYS * 86_400),
  });
  audit({ actor: row.user_id, action: "session.refresh", subject: row.id });
  return {
    sessionId: row.id,
    userId: row.user_id,
    accessJti: newJti,
    refreshToken: `fsr_${row.id}_${newSecret}`,
    accessExpiresAt: isoPlus(ACCESS_TTL_S),
    refreshExpiresAt: isoPlus(REFRESH_TTL_DAYS * 86_400),
    mfa: row.mfa,
  };
}

export function revokeSession(sessionId, reason = "logout", actorId = null) {
  const r = stmtRevoke.run(now(), reason, sessionId);
  if (r.changes > 0) {
    audit({ actor: actorId || "system", action: "session.revoke", subject: sessionId, detail: { reason } });
  }
  return r.changes > 0;
}

export function revokeAllForUser(userId, reason = "revoke_all", actorId = null) {
  const r = stmtRevokeAllForUser.run(now(), reason, userId);
  audit({ actor: actorId || userId, action: "session.revoke_all", subject: userId, detail: { reason, count: r.changes } });
  return r.changes;
}

export function listSessions(userId) {
  return stmtListForUser.all(userId);
}

export function getSession(sessionId) {
  return stmtById.get(sessionId) || null;
}

// Test helper. Not part of the public surface.
export function _consts() {
  return { ACCESS_TTL_S, REFRESH_TTL_DAYS };
}
