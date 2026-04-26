// Auth routes: login (email/password, optional MFA second-step) + me.

import crypto from "node:crypto";
import { verifyPassword, userById } from "../auth.js";
import { audit } from "../audit.js";
import { recordLoginFailure, isLockedOut, resetLockout, lockoutSummary } from "../security/lockout.js";
import {
  mfaRequirementForUser,
  issueChallenge,
  consumeChallenge,
  verifyMfaCode,
  beginEnrolment,
  completeEnrolment,
  regenerateRecoveryCodes,
  disableMfa,
  getMfaState,
} from "../mfa.js";
import {
  createSession,
  rotateRefresh,
  revokeSession,
  revokeAllForUser,
  listSessions,
  ACCESS_JWT_EXPIRES_IN,
} from "../sessions.js";

function hashEmailForAudit(email) {
  if (!email) return "anonymous";
  // Stable, non-reversible identifier so audit consumers can correlate
  // failed-login bursts without storing the email plaintext in the
  // immutable hash chain.
  return "email:" + crypto.createHash("sha256").update(String(email).toLowerCase()).digest("hex").slice(0, 16);
}

/**
 * Mint an access JWT bound to a fresh session, alongside a refresh
 * token. Returns the same shape `/api/auth/login` historically returned
 * (`{ token, user }`) plus `refreshToken` and the access/refresh
 * expiries so callers can drive their own renewal timers.
 */
async function issueSessionPair(reply, req, user, mfaMethod = null) {
  const ip = req.ip || null;
  const userAgent = req.headers?.["user-agent"] || null;
  const session = createSession({ userId: user.id, mfa: mfaMethod, ip, userAgent });
  const token = await reply.jwtSign(
    { sub: user.id, role: user.role, sid: session.sessionId, jti: session.accessJti },
    { expiresIn: ACCESS_JWT_EXPIRES_IN }
  );
  return {
    token,
    user,
    refreshToken: session.refreshToken,
    sessionId: session.sessionId,
    accessExpiresAt: session.accessExpiresAt,
    refreshExpiresAt: session.refreshExpiresAt,
  };
}

export default async function authRoutes(fastify) {
  fastify.post("/api/auth/login", async (req, reply) => {
    const { email, password, mfaCode, recoveryCode } = req.body || {};
    if (!email || !password) return reply.code(400).send({ error: "email and password required" });
    const subjectKey = hashEmailForAudit(email);
    const ip = req.ip || "0.0.0.0";

    const lock = isLockedOut(subjectKey, ip);
    if (lock.locked) {
      audit({ actor: subjectKey, action: "auth.login.locked", subject: subjectKey, detail: { reason: lock.reason, retryAfterMs: lock.retryAfterMs } });
      reply.header("Retry-After", String(Math.ceil((lock.retryAfterMs || 60_000) / 1000)));
      return reply.code(429).send({ error: "too many attempts", retryAfterMs: lock.retryAfterMs });
    }

    const user = await verifyPassword(email, password);
    if (!user) {
      const summary = recordLoginFailure(subjectKey, ip);
      audit({ actor: subjectKey, action: "auth.login.fail", subject: subjectKey, detail: { ip, ...summary } });
      return reply.code(401).send({ error: "invalid credentials" });
    }

    // Password is valid. Decide whether a second factor is required.
    const requirement = mfaRequirementForUser(user);
    if (requirement.required) {
      // Path A: caller already passed a code in the same request — verify
      // it, issue the JWT, and skip the challenge round-trip.
      const candidate = mfaCode || recoveryCode;
      if (candidate) {
        const ok = verifyMfaCode(user.id, candidate);
        if (!ok) {
          const summary = recordLoginFailure(subjectKey, ip);
          audit({ actor: user.id, action: "auth.mfa.fail", subject: user.id, detail: summary });
          return reply.code(401).send({ error: "invalid mfa code" });
        }
        resetLockout(subjectKey, ip);
        const pair = await issueSessionPair(reply, req, user, ok.method);
        audit({ actor: user.id, action: "auth.login", subject: user.id, detail: { mfa: ok.method, sid: pair.sessionId } });
        return pair;
      }

      // Path B: hand back a challenge so the client can prompt the user.
      // The challenge is opaque, short-lived, and bound to this user.
      // Successful enrolment lookups happen on the verify step, so we do
      // NOT reset the lockout counter yet.
      const challenge = issueChallenge(user.id);
      audit({ actor: user.id, action: "auth.mfa.challenge", subject: user.id, detail: { reason: requirement.reason } });
      return {
        mfaRequired: true,
        challenge,
        reason: requirement.reason,
        enrolmentRequired: !!requirement.enrolment_required,
      };
    }

    resetLockout(subjectKey, ip);
    const pair = await issueSessionPair(reply, req, user);
    audit({ actor: user.id, action: "auth.login", subject: user.id, detail: { sid: pair.sessionId } });
    return pair;
  });

  // Second leg of the two-step login. Caller passes the challenge token
  // and a code (TOTP or recovery). We deliberately re-check the lockout
  // tracker so brute-forcing the second step is bounded too.
  fastify.post("/api/auth/mfa/verify", async (req, reply) => {
    const { challenge, mfaCode, recoveryCode } = req.body || {};
    const ip = req.ip || "0.0.0.0";
    const payload = consumeChallenge(challenge);
    if (!payload) return reply.code(400).send({ error: "invalid or expired challenge" });
    const subjectKey = `userid:${payload.sub}`;
    const lock = isLockedOut(subjectKey, ip);
    if (lock.locked) {
      reply.header("Retry-After", String(Math.ceil((lock.retryAfterMs || 60_000) / 1000)));
      return reply.code(429).send({ error: "too many attempts", retryAfterMs: lock.retryAfterMs });
    }
    const user = userById(payload.sub);
    if (!user) return reply.code(401).send({ error: "user not found" });

    const candidate = mfaCode || recoveryCode;
    const ok = verifyMfaCode(user.id, candidate);
    if (!ok) {
      const summary = recordLoginFailure(subjectKey, ip);
      audit({ actor: user.id, action: "auth.mfa.fail", subject: user.id, detail: summary });
      return reply.code(401).send({ error: "invalid mfa code" });
    }
    resetLockout(subjectKey, ip);
    const pair = await issueSessionPair(reply, req, user, ok.method);
    audit({ actor: user.id, action: "auth.login", subject: user.id, detail: { mfa: ok.method, sid: pair.sessionId } });
    return pair;
  });

  // Refresh-token rotation. Returns a new access JWT + a new refresh
  // token; the old refresh token becomes invalid immediately. Replaying
  // a stale refresh token revokes the entire session.
  fastify.post("/api/auth/refresh", async (req, reply) => {
    const { refreshToken } = req.body || {};
    if (!refreshToken) return reply.code(400).send({ error: "refreshToken required" });
    const r = rotateRefresh(refreshToken);
    if (r.error) {
      audit({ actor: "system", action: "auth.refresh.fail", subject: "auth", detail: { error: r.error } });
      const code = r.error === "session_revoked" || r.error === "refresh_expired" ? 401 : 400;
      return reply.code(code).send({ error: r.error });
    }
    const user = userById(r.userId);
    if (!user) return reply.code(401).send({ error: "user not found" });
    const token = await reply.jwtSign(
      { sub: user.id, role: user.role, sid: r.sessionId, jti: r.accessJti },
      { expiresIn: ACCESS_JWT_EXPIRES_IN }
    );
    return {
      token,
      user,
      refreshToken: r.refreshToken,
      sessionId: r.sessionId,
      accessExpiresAt: r.accessExpiresAt,
      refreshExpiresAt: r.refreshExpiresAt,
    };
  });

  // Logout revokes the caller's current session, killing both the
  // access JWT and any outstanding refresh token. Idempotent — calling
  // logout twice is fine.
  fastify.post("/api/auth/logout", async (req, reply) => {
    if (!req.user) return { ok: true };
    if (req.sessionId) revokeSession(req.sessionId, "logout", req.user.id);
    audit({ actor: req.user.id, action: "auth.logout", subject: req.user.id, detail: { sid: req.sessionId || null } });
    return { ok: true };
  });

  // List the caller's active + past sessions. Useful for the SPA's
  // "Devices" or "Sessions" admin screen.
  fastify.get("/api/auth/sessions", async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: "unauthenticated" });
    const rows = listSessions(req.user.id);
    return rows.map((r) => ({ ...r, current: r.id === req.sessionId }));
  });

  // Revoke one specific session. Caller can only revoke their own.
  fastify.delete("/api/auth/sessions/:id", async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: "unauthenticated" });
    const target = listSessions(req.user.id).find((s) => s.id === req.params.id);
    if (!target) return reply.code(404).send({ error: "not found" });
    revokeSession(req.params.id, "user_revoked", req.user.id);
    return { ok: true };
  });

  // "Sign out everywhere" — revoke every session for the caller. The
  // current session is also revoked, so the next request from this
  // browser will return 401 and the client must re-login.
  fastify.post("/api/auth/sessions/revoke-all", async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: "unauthenticated" });
    const count = revokeAllForUser(req.user.id, "revoke_all", req.user.id);
    return { ok: true, revoked: count };
  });

  // Operational helper: returns lockout state for the current request.
  // Useful for client UIs that want to show "x attempts remaining". No PII.
  fastify.get("/api/auth/lockout", async (req) => lockoutSummary(req.ip || "0.0.0.0"));

  // ------------------------------------------------------------------
  // Per-user MFA management. Caller must be authenticated (JWT). The
  // sensitive operations (`disable`, `recovery/regenerate`) require a
  // proof-of-presence in the form of a fresh TOTP/recovery code so that
  // a stolen JWT cannot quietly turn off the second factor.
  // ------------------------------------------------------------------
  fastify.get("/api/auth/mfa/status", async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: "unauthenticated" });
    return getMfaState(req.user.id);
  });

  fastify.post("/api/auth/mfa/enrol", async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: "unauthenticated" });
    const issuer = process.env.FORGE_MFA_ISSUER || "FORGE";
    return beginEnrolment(req.user, issuer);
  });

  fastify.post("/api/auth/mfa/activate", async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: "unauthenticated" });
    const { code } = req.body || {};
    try {
      return completeEnrolment(req.user, code);
    } catch (err) {
      return reply.code(err.statusCode || 400).send({ error: String(err.message || err) });
    }
  });

  fastify.post("/api/auth/mfa/recovery/regenerate", async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: "unauthenticated" });
    const { code } = req.body || {};
    if (!verifyMfaCode(req.user.id, code)) return reply.code(401).send({ error: "fresh mfa code required" });
    try {
      return regenerateRecoveryCodes(req.user);
    } catch (err) {
      return reply.code(err.statusCode || 400).send({ error: String(err.message || err) });
    }
  });

  fastify.post("/api/auth/mfa/disable", async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: "unauthenticated" });
    const { code } = req.body || {};
    if (!verifyMfaCode(req.user.id, code)) return reply.code(401).send({ error: "fresh mfa code required" });
    disableMfa(req.user, req.user.id);
    return { ok: true };
  });
}
