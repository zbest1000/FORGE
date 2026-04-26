// FORGE server entry. Fastify + SQLite, serves the client from the repo root.

import Fastify from "fastify";
import jwt from "@fastify/jwt";
import cors from "@fastify/cors";
import fStatic from "@fastify/static";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import helmet from "@fastify/helmet";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

import { db } from "./db.js";
import { audit } from "./audit.js";
import { userById } from "./auth.js";
import { resolveToken } from "./tokens.js";
import { attachSSE } from "./sse.js";
import { register_ as registerMetrics } from "./metrics.js";

import mercurius from "mercurius";
import { typeDefs } from "./graphql/schema.js";
import { resolvers } from "./graphql/resolvers.js";

import authRoutes from "./routes/auth.js";
import coreRoutes from "./routes/core.js";
import i3xRoutes from "./routes/i3x.js";
import fileRoutes from "./routes/files.js";
import tokenRoutes from "./routes/tokens.js";
import webhookRoutes from "./routes/webhooks.js";
import extrasRoutes from "./routes/extras.js";
import aiRoutes from "./routes/ai.js";
import automationRoutes from "./routes/automations.js";
import cadRoutes from "./routes/cad.js";

import { startMqttBridge } from "./connectors/mqtt.js";
import { startOpcuaBridge } from "./connectors/opcua.js";
import { startAlertWorker } from "./alerts.js";
import { startRollupWorker, readSeries, listDailySnapshot } from "./metrics-rollup.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "dist");
const CLIENT_ROOT = fs.existsSync(path.join(DIST, "index.html")) ? DIST : ROOT;
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const JWT_SECRET = process.env.FORGE_JWT_SECRET || "forge-dev-jwt-secret-please-rotate";

const app = Fastify({
  logger: {
    transport: process.env.NODE_ENV === "production" ? undefined : {
      target: "pino/file",
      options: { destination: 1 },
    },
    level: process.env.LOG_LEVEL || "info",
  },
  bodyLimit: 10 * 1024 * 1024,
  trustProxy: true,
});

await app.register(cors, {
  origin: process.env.FORGE_CORS_ORIGIN ? process.env.FORGE_CORS_ORIGIN.split(",") : true,
  credentials: true,
});
// Secure HTTP headers. Permissive CSP for the SPA (needs the ESM CDN for the
// vendor import map) but locked down for XSS defaults.
await app.register(helmet, {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      scriptSrc: ["'self'", "https://esm.sh", "https://storage.googleapis.com", "'unsafe-inline'", "'unsafe-eval'"],
      styleSrc:  ["'self'", "https://esm.sh", "'unsafe-inline'"],
      imgSrc:    ["'self'", "data:", "blob:", "https:"],
      connectSrc:["'self'", "https://esm.sh", "https://storage.googleapis.com", "https://api.i3x.dev", "ws:", "wss:"],
      fontSrc:   ["'self'", "https:", "data:"],
      workerSrc: ["'self'", "blob:", "https://esm.sh", "https://storage.googleapis.com"],
      frameAncestors: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" },
});
await app.register(rateLimit, {
  global: true,
  max: Number(process.env.FORGE_RATELIMIT_MAX || 600),
  timeWindow: process.env.FORGE_RATELIMIT_WINDOW || "1 minute",
  // Don't rate-limit static assets; they're small + cached.
  skipOnError: true,
  allowList: (req) => {
    const p = req.url.split("?")[0];
    return !(p.startsWith("/api/") || p.startsWith("/v1/"));
  },
  keyGenerator: (req) => (req.user?.id || req.ip || "anon"),
});
await app.register(jwt, { secret: JWT_SECRET });
await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });

// Auth resolution. Two token formats are accepted:
//   - JWT bearer  (signed by FORGE_JWT_SECRET; short-lived)
//   - API token   (long-lived, fgt_…; user-scoped, revocable)
// The first match wins.
app.addHook("onRequest", async (req) => {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : (req.query?.token ? String(req.query.token) : null);
  if (!token) { req.user = null; return; }

  // 1) API token (machine clients).
  if (token.startsWith("fgt_")) {
    const r = resolveToken(token, userById);
    req.user = r ? r.user : null;
    if (r) { req.tokenId = r.tokenId; req.tokenScopes = r.scopes; }
    return;
  }

  // 2) JWT bearer (interactive clients).
  try {
    const decoded = app.jwt.verify(token);
    if (decoded?.sub) {
      const user = userById(decoded.sub);
      req.user = user || null;
    } else {
      req.user = null;
    }
  } catch (err) {
    req.user = null;
    req.log.warn({ err: String(err?.message || err) }, "auth verify failed");
  }
});

app.get("/api/health", async () => ({
  status: "ok",
  version: "0.3.0",
  schema_version: db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value,
  uptime_s: Math.floor(process.uptime()),
  ts: new Date().toISOString(),
}));

// GraphQL — mercurius mounted at /graphql with the same auth context as REST.
// Use `graphiql: true` only in non-production for the UX and tooling.
await app.register(mercurius, {
  schema: typeDefs,
  resolvers,
  graphiql: process.env.NODE_ENV !== "production",
  ide: process.env.NODE_ENV !== "production",
  context: (request) => ({ user: request.user, tokenScopes: request.tokenScopes || [] }),
  errorFormatter: (err, ctx) => {
    return { statusCode: err?.errors?.[0]?.extensions?.http?.status || 200, response: { errors: err?.errors || [], data: err?.data ?? null } };
  },
});

await app.register(authRoutes);
await app.register(coreRoutes);
await app.register(i3xRoutes);
await app.register(fileRoutes);
await app.register(tokenRoutes);
await app.register(webhookRoutes);
await app.register(extrasRoutes);
await app.register(aiRoutes);
await app.register(automationRoutes);
await app.register(cadRoutes);
attachSSE(app);
registerMetrics(app);

// §19 success-metrics endpoints (live + historical).
app.get("/api/metrics/series", async (req) => {
  const metric = req.query?.metric || "wau";
  const days = Math.min(60, Number(req.query?.days || 14));
  return readSeries(metric, days);
});
app.get("/api/metrics/snapshot", async () => listDailySnapshot());

// Serve the built client when `npm run build` has produced dist/.
// In development, fall back to the source tree so `npm start` still works.
await app.register(fStatic, {
  root: CLIENT_ROOT,
  prefix: "/",
  // Keep /api and /v1 reserved.
  constraints: {},
  decorateReply: false,
});

// SPA fallback: any non-API, non-file path that missed the static handler
// gets index.html so deep links (`/admin`, `/doc/DOC-1`) work after reload.
app.setNotFoundHandler((req, reply) => {
  const p = (req.url || "/").split("?")[0];
  if (p.startsWith("/api/") || p.startsWith("/v1/") || p.startsWith("/metrics") || p.startsWith("/graphql")) {
    return reply.code(404).send({ error: "not found", path: p });
  }
  // Paths that look like files (have an extension) should 404 rather than
  // serve HTML — prevents broken <img>/<script> from loading index.html.
  const last = p.split("/").pop() || "";
  if (last.includes(".")) {
    return reply.code(404).send({ error: "not found", path: p });
  }
  return reply.type("text/html").send(fs.readFileSync(path.join(CLIENT_ROOT, "index.html")));
});

// Start optional ingress bridges + background workers.
startMqttBridge(app.log);
startOpcuaBridge(app.log);
startAlertWorker(app.log);
startRollupWorker(app.log);

// Record boot in the audit ledger.
audit({ actor: "system", action: "server.start", subject: "forge", detail: { host: HOST, port: PORT, pid: process.pid } });

try {
  await app.listen({ host: HOST, port: PORT });
  app.log.info(`FORGE server listening on http://${HOST}:${PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

function shutdown(sig) {
  app.log.info({ sig }, "shutting down");
  audit({ actor: "system", action: "server.stop", subject: "forge", detail: { sig } });
  app.close().finally(() => process.exit(0));
}
process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
