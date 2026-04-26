// Auth routes: login (email/password) + me.

import crypto from "node:crypto";
import { verifyPassword } from "../auth.js";
import { audit } from "../audit.js";
import { recordLoginFailure, isLockedOut, resetLockout, lockoutSummary } from "../security/lockout.js";

function hashEmailForAudit(email) {
  if (!email) return "anonymous";
  // Stable, non-reversible identifier so audit consumers can correlate
  // failed-login bursts without storing the email plaintext in the
  // immutable hash chain.
  return "email:" + crypto.createHash("sha256").update(String(email).toLowerCase()).digest("hex").slice(0, 16);
}

export default async function authRoutes(fastify) {
  fastify.post("/api/auth/login", async (req, reply) => {
    const { email, password } = req.body || {};
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
    resetLockout(subjectKey, ip);
    const token = await reply.jwtSign({ sub: user.id, role: user.role }, { expiresIn: "12h" });
    audit({ actor: user.id, action: "auth.login", subject: user.id });
    return { token, user };
  });

  fastify.post("/api/auth/logout", async (req, reply) => {
    if (req.user) audit({ actor: req.user.id, action: "auth.logout", subject: req.user.id });
    return { ok: true };
  });

  // Operational helper: returns lockout state for the current request.
  // Useful for client UIs that want to show "x attempts remaining". No PII.
  fastify.get("/api/auth/lockout", async (req) => lockoutSummary(req.ip || "0.0.0.0"));
}
