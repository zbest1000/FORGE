// FORGE LLC central license server.
//
// Listens on :7100 by default. Issues signed entitlement bundles to
// authenticated local license servers. Operator API (CRUD over
// customers + licenses + keys) is on a separate port-or-prefix because
// the operator surface should never share a TLS endpoint with the
// public activation endpoint in production.

import Fastify from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import cors from "@fastify/cors";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { db, now, uuid } from "./db.js";
import { signEntitlement, publicKeyPem } from "./signing.js";
import activationRoutes from "./routes/activation.js";
import operatorRoutes from "./routes/operator.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 7100);
const HOST = process.env.HOST || "0.0.0.0";
const ENTITLEMENT_TTL_S = Number(process.env.ENTITLEMENT_TTL_SECONDS || 86_400); // 24h
const HEARTBEAT_TTL_S   = Number(process.env.HEARTBEAT_TTL_SECONDS   || 300);

// Verify the signing key loads cleanly before binding any sockets.
publicKeyPem();

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || "info",
    redact: { paths: ["req.headers.authorization"], remove: false, censor: "[redacted]" },
  },
  bodyLimit: 256 * 1024,
  trustProxy: true,
  disableRequestLogging: false,
});

await app.register(cors, { origin: false }); // No browser callers.
await app.register(helmet, {
  contentSecurityPolicy: false, // No HTML surface here.
  hsts: { maxAge: 31_536_000, includeSubDomains: true },
});
await app.register(rateLimit, {
  global: true,
  max: 60,
  timeWindow: "1 minute",
  keyGenerator: (req) => (req.headers["authorization"] || req.ip),
});

// --- Public --------------------------------------------------------

app.get("/healthz", async () => ({ status: "ok", ts: now() }));

app.get("/pubkey", async () => ({
  algorithm: "ed25519",
  pem: publicKeyPem(),
  kid: hashKid(publicKeyPem()),
}));

function hashKid(pem) {
  return crypto.createHash("sha256").update(pem).digest("hex").slice(0, 16);
}

app.decorate("config", {
  ENTITLEMENT_TTL_S,
  HEARTBEAT_TTL_S,
  signEntitlement,
  publicKeyPem,
  now,
  uuid,
  db,
});

// --- Activation API (used by customer local LS) -------------------
await app.register(activationRoutes, { prefix: "/api/v1" });

// --- Operator API (used by FORGE LLC staff via CLI/SCIM) ----------
await app.register(operatorRoutes, { prefix: "/admin/v1" });

// --- Boot ---------------------------------------------------------
try {
  await app.listen({ host: HOST, port: PORT });
  app.log.info({ pubkey_kid: hashKid(publicKeyPem()), entitlement_ttl_s: ENTITLEMENT_TTL_S },
    `FORGE LLC license server listening on http://${HOST}:${PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

function shutdown(sig) {
  app.log.info({ sig }, "shutting down");
  app.close().finally(() => process.exit(0));
}
process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
