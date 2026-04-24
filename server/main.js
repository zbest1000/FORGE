// FORGE server entry. Fastify + SQLite, serves the client from the repo root.

import Fastify from "fastify";
import jwt from "@fastify/jwt";
import cors from "@fastify/cors";
import fStatic from "@fastify/static";
import multipart from "@fastify/multipart";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

import { db } from "./db.js";
import { audit } from "./audit.js";
import { userById } from "./auth.js";
import { attachSSE } from "./sse.js";

import authRoutes from "./routes/auth.js";
import coreRoutes from "./routes/core.js";
import i3xRoutes from "./routes/i3x.js";

import { startMqttBridge } from "./connectors/mqtt.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
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
await app.register(jwt, { secret: JWT_SECRET });
await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });

// @fastify/jwt already decorates request.user with the decoded token on
// jwtVerify. We resolve the full DB user in an onRequest hook and store it
// on req.user, overriding the decoded stub.
app.addHook("onRequest", async (req) => {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : (req.query?.token ? String(req.query.token) : null);
  if (!token) { req.user = null; return; }
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

await app.register(authRoutes);
await app.register(coreRoutes);
await app.register(i3xRoutes);
attachSSE(app);

// Serve the static client from the repo root.
await app.register(fStatic, {
  root: ROOT,
  prefix: "/",
  // Keep /api and /v1 reserved.
  constraints: {},
  decorateReply: false,
});

// SPA-like fallback: only route `/` to index.html. API paths 404 as JSON.
app.setNotFoundHandler((req, reply) => {
  const p = (req.url || "/").split("?")[0];
  if (p === "/" || p === "") {
    return reply.type("text/html").send(fs.readFileSync(path.join(ROOT, "index.html")));
  }
  return reply.code(404).send({ error: "not found", path: p });
});

// Start MQTT bridge (optional).
startMqttBridge(app.log);

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
