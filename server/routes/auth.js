// Auth routes: login (email/password) + me.

import { verifyPassword } from "../auth.js";
import { audit } from "../audit.js";

export default async function authRoutes(fastify) {
  fastify.post("/api/auth/login", async (req, reply) => {
    const { email, password } = req.body || {};
    if (!email || !password) return reply.code(400).send({ error: "email and password required" });
    const user = await verifyPassword(email, password);
    if (!user) {
      audit({ actor: email, action: "auth.login.fail", subject: email });
      return reply.code(401).send({ error: "invalid credentials" });
    }
    const token = await reply.jwtSign({ sub: user.id, role: user.role }, { expiresIn: "12h" });
    audit({ actor: user.id, action: "auth.login", subject: user.id });
    return { token, user };
  });

  fastify.post("/api/auth/logout", async (req, reply) => {
    if (req.user) audit({ actor: req.user.id, action: "auth.logout", subject: req.user.id });
    return { ok: true };
  });
}
