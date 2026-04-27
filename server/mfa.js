// TOTP-based multi-factor authentication.
//
// Implements RFC 6238 (TOTP) on top of RFC 4226 (HOTP) using only Node's
// built-in crypto. No external dependency.
//
// Storage
// -------
// Per-user state lives in the `user_mfa` table:
//   { user_id, totp_secret, enabled, recovery_codes, enrolled_at }
//
// `totp_secret` is a base32-encoded 20-byte random string (the standard
// otpauth URL format). It is written when the user starts enrolment and
// promoted to "enabled" only after a successful first verify, so a half-
// completed enrolment cannot accidentally lock the user out.
//
// `recovery_codes` is a JSON array of `{ hash, used_at }` records. We
// only ever store SHA-256 hashes of the recovery codes; the plaintext is
// returned exactly once at enrolment / regeneration. Used codes are
// marked rather than deleted so the audit log can prove which slot was
// consumed.
//
// Login challenge
// ---------------
// When a user with `enabled = 1` logs in we issue a short-lived
// challenge token that ties the second step to the same browser session
// and prevents code-reuse across logins. The challenge is HMAC-signed
// using `FORGE_JWT_SECRET` and contains:
//   { sub: userId, mfa: true, jti: <random>, exp: now + 5min }
// The challenge is **not** a JWT bearer for `/api/me` — handlers that
// accept normal auth tokens reject these (the `mfa` flag is set).
// The challenge becomes a real JWT only after `/api/auth/mfa/verify`
// confirms a fresh TOTP / recovery code.
//
// Mandatory MFA
// -------------
// Per-user opt-in is always available. Org-wide *enforcement* (refusing
// to issue a JWT to users without MFA enabled) is gated by the
// `governance.mfa_enforce` license feature; without it `verifyMfa()`
// only enforces MFA for users who have already enrolled.

import crypto from "node:crypto";
import { db, now, uuid } from "./db.js";
import { audit } from "./audit.js";
import { hasFeature, FEATURES } from "./license.js";

const TOTP_DIGITS = 6;
const TOTP_PERIOD_S = 30;
// Accept the previous and next step too (i.e. ±30s clock skew) so users
// don't bounce off the auth wall when their phone clock drifts.
const TOTP_WINDOW = 1;

const RECOVERY_CODE_COUNT = 10;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

// ----------------------------------------------------------------------
// Base32 (RFC 4648, no padding) — keeps the secret pasteable into any
// authenticator app. Implementation is small enough to ship inline.
// ----------------------------------------------------------------------

const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32Encode(buf) {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 0x1f];
  return out;
}
function base32Decode(input) {
  const clean = String(input || "").replace(/=+$/g, "").replace(/\s+/g, "").toUpperCase();
  const out = [];
  let bits = 0, value = 0;
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error("invalid base32 char");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// ----------------------------------------------------------------------
// HOTP / TOTP
// ----------------------------------------------------------------------

function hotp(secret, counter) {
  const counterBuf = Buffer.alloc(8);
  // Big-endian 64-bit counter. Node's writeBigUInt64BE works since
  // Node 16; we already require 20+.
  counterBuf.writeBigUInt64BE(BigInt(counter), 0);
  const mac = crypto.createHmac("sha1", secret).update(counterBuf).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const code = ((mac[offset] & 0x7f) << 24)
    | ((mac[offset + 1] & 0xff) << 16)
    | ((mac[offset + 2] & 0xff) << 8)
    | (mac[offset + 3] & 0xff);
  return String(code % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

export function totpAt(secretB32, atSeconds) {
  const counter = Math.floor(atSeconds / TOTP_PERIOD_S);
  return hotp(base32Decode(secretB32), counter);
}

/**
 * Constant-time compare two strings. Returns false when they differ in
 * length; otherwise uses `crypto.timingSafeEqual`.
 */
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Verify a TOTP code against a base32-encoded secret. Walks ±TOTP_WINDOW
 * steps. Returns the matching counter on success, null on failure.
 */
export function verifyTotp(secretB32, code, atSeconds = Date.now() / 1000) {
  if (!secretB32 || !code) return null;
  if (!/^\d{6}$/.test(String(code).trim())) return null;
  const secret = base32Decode(secretB32);
  const center = Math.floor(atSeconds / TOTP_PERIOD_S);
  for (let w = -TOTP_WINDOW; w <= TOTP_WINDOW; w++) {
    const counter = center + w;
    if (counter < 0) continue;
    const candidate = hotp(secret, counter);
    if (safeEqual(candidate, String(code).trim())) return counter;
  }
  return null;
}

// ----------------------------------------------------------------------
// Recovery codes
// ----------------------------------------------------------------------

function generateRecoveryCode() {
  // 10 hex chars in two 5-char groups: easy to type, ~40 bits of entropy.
  const raw = crypto.randomBytes(5).toString("hex");
  return `${raw.slice(0, 5)}-${raw.slice(5, 10)}`.toLowerCase();
}

function hashRecoveryCode(plain) {
  return crypto.createHash("sha256").update(String(plain || "").replace(/[^a-z0-9-]/gi, "").toLowerCase()).digest("hex");
}

function generateRecoverySet(count = RECOVERY_CODE_COUNT) {
  const plain = [];
  const stored = [];
  for (let i = 0; i < count; i++) {
    const code = generateRecoveryCode();
    plain.push(code);
    stored.push({ hash: hashRecoveryCode(code), used_at: null });
  }
  return { plain, stored };
}

// ----------------------------------------------------------------------
// Persistence helpers
// ----------------------------------------------------------------------

const stmtGet = db.prepare("SELECT * FROM user_mfa WHERE user_id = ?");
const stmtUpsert = db.prepare(`INSERT INTO user_mfa (user_id, totp_secret, enabled, recovery_codes, enrolled_at)
                                VALUES (@user_id, @totp_secret, @enabled, @recovery_codes, @enrolled_at)
                                ON CONFLICT(user_id) DO UPDATE SET
                                  totp_secret = excluded.totp_secret,
                                  enabled = excluded.enabled,
                                  recovery_codes = excluded.recovery_codes,
                                  enrolled_at = excluded.enrolled_at`);
const stmtUpdateRecovery = db.prepare("UPDATE user_mfa SET recovery_codes = ? WHERE user_id = ?");
const stmtDelete = db.prepare("DELETE FROM user_mfa WHERE user_id = ?");

export function getMfaState(userId) {
  const row = stmtGet.get(userId);
  if (!row) return { enabled: false, enrolled_at: null, pending: false, recovery_count: 0 };
  const codes = JSON.parse(row.recovery_codes || "[]");
  return {
    enabled: !!row.enabled,
    pending: !!row.totp_secret && !row.enabled,
    enrolled_at: row.enrolled_at,
    recovery_count: codes.filter(c => !c.used_at).length,
  };
}

export function isMfaEnabled(userId) {
  const row = stmtGet.get(userId);
  return !!(row && row.enabled);
}

/**
 * Begin enrolment: generate a new secret, persist as `pending`, return
 * the otpauth URL the client renders as a QR code.
 */
export function beginEnrolment(user, issuer = "FORGE") {
  const secret = base32Encode(crypto.randomBytes(20));
  stmtUpsert.run({
    user_id: user.id,
    totp_secret: secret,
    enabled: 0,
    recovery_codes: "[]",
    enrolled_at: null,
  });
  const account = encodeURIComponent(`${issuer}:${user.email || user.id}`);
  const otpauthUrl = `otpauth://totp/${account}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD_S}`;
  audit({ actor: user.id, action: "mfa.enrol.begin", subject: user.id });
  return { secret, otpauthUrl };
}

/**
 * Complete enrolment: caller must present a valid TOTP code generated
 * from the secret returned by `beginEnrolment`. Returns the freshly-
 * generated recovery codes (plaintext, shown only once).
 */
export function completeEnrolment(user, code) {
  const row = stmtGet.get(user.id);
  if (!row || !row.totp_secret) {
    const err = new Error("no enrolment in progress");
    err.statusCode = 409;
    throw err;
  }
  if (verifyTotp(row.totp_secret, code) === null) {
    audit({ actor: user.id, action: "mfa.enrol.fail", subject: user.id });
    const err = new Error("invalid code");
    err.statusCode = 400;
    throw err;
  }
  const { plain, stored } = generateRecoverySet();
  stmtUpsert.run({
    user_id: user.id,
    totp_secret: row.totp_secret,
    enabled: 1,
    recovery_codes: JSON.stringify(stored),
    enrolled_at: now(),
  });
  audit({ actor: user.id, action: "mfa.enrol.complete", subject: user.id, detail: { recovery_count: plain.length } });
  return { recoveryCodes: plain };
}

/** Regenerate recovery codes — called from a re-authenticated session. */
export function regenerateRecoveryCodes(user) {
  const row = stmtGet.get(user.id);
  if (!row || !row.enabled) {
    const err = new Error("MFA is not enabled for this user");
    err.statusCode = 409;
    throw err;
  }
  const { plain, stored } = generateRecoverySet();
  stmtUpdateRecovery.run(JSON.stringify(stored), user.id);
  audit({ actor: user.id, action: "mfa.recovery.regenerate", subject: user.id });
  return { recoveryCodes: plain };
}

/** Disable MFA for the user. Caller is responsible for re-auth. */
export function disableMfa(user, actorId) {
  const row = stmtGet.get(user.id);
  if (!row) return false;
  stmtDelete.run(user.id);
  audit({ actor: actorId || user.id, action: "mfa.disable", subject: user.id });
  return true;
}

/**
 * Verify either a TOTP code or a recovery code. On success, returns
 * `{ method: 'totp' | 'recovery' }`. Recovery codes are consumed.
 *
 * Returns null on failure. Caller must apply rate-limit / lockout.
 */
export function verifyMfaCode(userId, candidate) {
  const row = stmtGet.get(userId);
  if (!row || !row.enabled) return null;
  if (!candidate) return null;
  const trimmed = String(candidate).trim();

  // 1) TOTP path.
  if (/^\d{6}$/.test(trimmed)) {
    if (verifyTotp(row.totp_secret, trimmed) !== null) {
      audit({ actor: userId, action: "mfa.verify.totp", subject: userId });
      return { method: "totp" };
    }
  }

  // 2) Recovery path. Hash the candidate and look for an unused match.
  const codes = JSON.parse(row.recovery_codes || "[]");
  const target = hashRecoveryCode(trimmed);
  let matched = -1;
  for (let i = 0; i < codes.length; i++) {
    if (!codes[i].used_at && safeEqual(codes[i].hash, target)) { matched = i; break; }
  }
  if (matched >= 0) {
    codes[matched].used_at = now();
    stmtUpdateRecovery.run(JSON.stringify(codes), userId);
    audit({ actor: userId, action: "mfa.verify.recovery", subject: userId, detail: { remaining: codes.filter(c => !c.used_at).length } });
    return { method: "recovery" };
  }

  audit({ actor: userId, action: "mfa.verify.fail", subject: userId });
  return null;
}

// ----------------------------------------------------------------------
// Login challenge tokens
// ----------------------------------------------------------------------

function challengeSecret() {
  return process.env.FORGE_JWT_SECRET || "forge-dev-jwt-secret-please-rotate";
}

function sign(payloadStr) {
  return crypto.createHmac("sha256", challengeSecret()).update(payloadStr).digest("hex");
}

/**
 * Mint a short-lived MFA challenge token. The token is opaque to the
 * client and only valid as input to `/api/auth/mfa/verify`.
 */
export function issueChallenge(userId) {
  const payload = {
    sub: userId,
    mfa: true,
    jti: uuid("MCH"),
    exp: Date.now() + CHALLENGE_TTL_MS,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = sign(body);
  return `mfa1.${body}.${sig}`;
}

/**
 * Validate and decode a challenge token. Returns the payload on success,
 * null when malformed, expired, or signature-mismatched.
 */
export function consumeChallenge(token) {
  if (!token || typeof token !== "string" || !token.startsWith("mfa1.")) return null;
  const [, body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = sign(body);
  if (!safeEqual(expected, sig)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); }
  catch { return null; }
  if (!payload?.mfa || !payload.sub) return null;
  if (typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
  return payload;
}

// ----------------------------------------------------------------------
// Mandatory MFA enforcement
// ----------------------------------------------------------------------

/**
 * Returns `{ required: bool, reason }` describing whether the user must
 * complete an MFA challenge before a JWT can be issued.
 *
 * - If the user has MFA enrolled and enabled, MFA is always required.
 * - If the deployment has the `governance.mfa_enforce` feature licensed
 *   AND the user's role is in the org's enforcement set (env-driven for
 *   now via `FORGE_MFA_ENFORCE_ROLES`, comma-separated), MFA is required
 *   even when the user has not yet enrolled — they will be redirected to
 *   the enrolment screen by the client. This is the difference between
 *   per-user MFA (always available) and mandatory org-wide MFA (gated).
 */
export function mfaRequirementForUser(user) {
  if (!user) return { required: false, reason: null };
  if (isMfaEnabled(user.id)) return { required: true, reason: "user_enabled" };
  const enforced = isMfaEnforced(user);
  return enforced ? { required: true, reason: "policy", enrolment_required: true } : { required: false, reason: null };
}

function isMfaEnforced(user) {
  if (!hasFeature(FEATURES.MFA_ENFORCEMENT)) return false;
  const roles = String(process.env.FORGE_MFA_ENFORCE_ROLES || "")
    .split(",").map(s => s.trim()).filter(Boolean);
  if (!roles.length) return false;
  if (roles.includes("*")) return true;
  return roles.includes(user.role);
}
