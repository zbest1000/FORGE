// /api/tokens — user-scoped API tokens for machine clients.

import { require_ } from "../auth.js";
import { createToken, listTokens, revokeToken } from "../tokens.js";
import { TokenCreateBody } from "../schemas/integrations.js";

export default async function tokenRoutes(fastify) {
  fastify.get("/api/tokens", { preHandler: require_() }, async (req) => {
    return listTokens(req.user.id);
  });

  fastify.post("/api/tokens", {
    preHandler: require_(),
    schema: { body: TokenCreateBody },
  }, async (req, reply) => {
    const { name = "api token", scopes = ["view"], ttlDays = null } = req.body || {};
    const t = createToken({ userId: req.user.id, name, scopes, ttlDays });
    // `plaintext` is returned exactly once; client must store it.
    return { id: t.id, name: t.name, scopes: t.scopes, expires_at: t.expires_at, created_at: t.created_at, token: t.plaintext };
  });

  fastify.delete("/api/tokens/:id", { preHandler: require_() }, async (req, reply) => {
    const ok = revokeToken(req.params.id, req.user.id);
    if (!ok) return reply.code(404).send({ error: "not found" });
    return { ok: true };
  });
}
