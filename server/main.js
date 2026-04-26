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
import { initTracing } from "./tracing.js";

import { db } from "./db.js";
import { audit } from "./audit.js";
import { userById } from "./auth.js";
import { resolveToken } from "./tokens.js";
import { authenticateAccess } from "./sessions.js";
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
import complianceRoutes from "./routes/compliance.js";
import enterpriseSystemRoutes from "./routes/enterprise-systems.js";
import licenseRoutes from "./routes/license.js";
import { config } from "./config.js";
import { getLicense, requireFeature, FEATURES, pollLocalLicenseServer, loadPersistedActivation, localLicenseStatus } from "./license.js";

import { startMqttBridge, stopMqttBridge } from "./connectors/mqtt.js";
import { startOpcuaBridge, stopOpcuaBridge } from "./connectors/opcua.js";
import { startAlertWorker, stopAlertWorker } from "./alerts.js";
import { startRollupWorker, stopRollupWorker, readSeries, listDailySnapshot } from "./metrics-rollup.js";
import { startRetentionWorker, stopRetentionWorker } from "./retention.js";
import { stopOutboxWorker } from "./outbox.js";
import { stopWebhookWorker } from "./webhooks.js";
import { drain as drainAudit } from "./audit.js";
import { shutdownSSE } from "./sse.js";
import { shutdownTracing } from "./tracing.js";

initTracing("forge-api");
import { startOutboxWorker } from "./outbox.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "dist");
const HAS_DIST = fs.existsSync(path.join(DIST, "index.html"));
const ALLOW_SOURCE_CLIENT = config.serveSourceClient;
if (!HAS_DIST && !ALLOW_SOURCE_CLIENT) {
  throw new Error("Startup requires a built SPA in ./dist. Run `npm run build`, or use `npm run dev` / FORGE_SERVE_SOURCE=1 for local source fallback.");
}
const CLIENT_ROOT = HAS_DIST ? DIST : ROOT;
const PORT = config.port;
const HOST = config.host;
const JWT_SECRET = config.jwtSecret;

const app = Fastify({
  logger: {
    transport: process.env.NODE_ENV === "production" ? undefined : {
      target: "pino/file",
      options: { destination: 1 },
    },
    level: config.logLevel,
  },
  bodyLimit: 10 * 1024 * 1024,
  trustProxy: true,
});

await app.register(cors, {
  origin: config.corsOrigin,
  credentials: true,
});
// Secure HTTP headers. The CSP differs by run mode:
//   - Production (HAS_DIST=true, ALLOW_SOURCE_CLIENT=false): strict.
//     Vite has bundled all third-party deps into /assets/*. No CDN
//     origins are allowed. 'unsafe-eval' is still required by web-ifc
//     (WebAssembly streaming) and a few worker bootstraps; 'unsafe-inline'
//     is kept for inline event handlers in the legacy SPA shell — those
//     are tracked for migration to nonces in `docs/SECURITY.md`.
//   - Source / dev mode: also allow esm.sh because index.html's
//     importmap loads ESM packages from there as a fallback.
const CSP_BASE = {
  defaultSrc: ["'self'"],
  baseUri: ["'self'"],
  imgSrc:    ["'self'", "data:", "blob:", "https:"],
  fontSrc:   ["'self'", "https:", "data:"],
  frameAncestors: ["'none'"],
  formAction: ["'self'"],
  objectSrc: ["'none'"],
};
const CSP_PROD = {
  ...CSP_BASE,
  scriptSrc: ["'self'", "blob:", "'wasm-unsafe-eval'", "'unsafe-inline'", "'unsafe-eval'"],
  styleSrc:  ["'self'", "'unsafe-inline'"],
  connectSrc:["'self'", "https://api.i3x.dev", "ws:", "wss:"],
  workerSrc: ["'self'", "blob:"],
};
const CSP_DEV = {
  ...CSP_BASE,
  scriptSrc: ["'self'", "https://esm.sh", "https://storage.googleapis.com", "blob:", "'wasm-unsafe-eval'", "'unsafe-inline'", "'unsafe-eval'"],
  styleSrc:  ["'self'", "https://esm.sh", "'unsafe-inline'"],
  connectSrc:["'self'", "https://esm.sh", "https://storage.googleapis.com", "https://api.i3x.dev", "ws:", "wss:"],
  workerSrc: ["'self'", "blob:", "https://esm.sh", "https://storage.googleapis.com"],
};
await app.register(helmet, {
  contentSecurityPolicy: {
    directives: (HAS_DIST && !ALLOW_SOURCE_CLIENT) ? CSP_PROD : CSP_DEV,
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" },
  strictTransportSecurity: { maxAge: 31_536_000, includeSubDomains: true, preload: false },
  referrerPolicy: { policy: "strict-origin-when-cross-origin" },
});
await app.register(rateLimit, {
  global: true,
  max: config.rateLimit.max,
  timeWindow: config.rateLimit.timeWindow,
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
//
// `?token=` query-string auth is only accepted on streaming endpoints
// (SSE) where browser EventSource cannot set Authorization headers.
// Allowing it on every route would leak tokens into proxy access logs,
// HTTP referrer headers, and CDN caches.
const QUERY_AUTH_PATHS = ["/api/events/stream", "/v1/subscriptions/stream"];
app.addHook("onRequest", async (req) => {
  const h = req.headers.authorization || "";
  const reqPath = (req.url || "").split("?")[0];
  const allowQueryToken = QUERY_AUTH_PATHS.some((p) => reqPath === p || reqPath.startsWith(p + "/"));
  const queryToken = (allowQueryToken && req.query?.token) ? String(req.query.token) : null;
  const token = h.startsWith("Bearer ") ? h.slice(7) : queryToken;
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
    if (!decoded?.sub) { req.user = null; return; }
    // Session-bound JWTs (issued by login / mfa/verify / refresh) carry
    // `sid` + `jti`. Reject when the session is revoked or the jti has
    // been rotated. Bearer tokens that don't carry `sid` are treated as
    // legacy/non-session (no check) — useful for short-lived service
    // tokens minted out-of-band; in production every login mints a sid.
    if (decoded.sid) {
      const session = authenticateAccess({ sid: decoded.sid, jti: decoded.jti });
      if (!session) { req.user = null; return; }
      req.sessionId = session.id;
    }
    const user = userById(decoded.sub);
    req.user = user || null;
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
//
// GraphIQL is **opt-in**: it is only rendered when `FORGE_GRAPHIQL=1` is
// set explicitly. Earlier the playground was on whenever `NODE_ENV` was
// not `production`, which exposed schema introspection on any deployment
// that forgot to flip that env var.
//
// Query depth and aliases are bounded so a single authenticated user
// cannot DoS the resolver by issuing a 50-level deep graph or thousands
// of aliased fields. Both bounds can be tuned with env vars.
//
// The /graphql endpoint itself is gated by the GRAPHQL_API feature flag —
// installations on community/personal tiers see a 402 instead.
const GRAPHIQL_ENABLED = /^(1|true|yes|on)$/i.test(String(process.env.FORGE_GRAPHIQL || ""));
const GQL_DEPTH = Number(process.env.FORGE_GRAPHQL_MAX_DEPTH || 12);
const GQL_ALIASES = Number(process.env.FORGE_GRAPHQL_MAX_ALIASES || 20);
await app.register(async (scope) => {
  scope.addHook("onRequest", requireFeature(FEATURES.GRAPHQL_API));
  await scope.register(mercurius, {
    schema: typeDefs,
    resolvers,
    graphiql: GRAPHIQL_ENABLED,
    ide: GRAPHIQL_ENABLED,
    queryDepth: GQL_DEPTH,
    validationRules: [],
    context: (request) => ({ user: request.user, tokenScopes: request.tokenScopes || [] }),
    errorFormatter: (err, ctx) => {
      return { statusCode: err?.errors?.[0]?.extensions?.http?.status || 200, response: { errors: err?.errors || [], data: err?.data ?? null } };
    },
  });
  // Cheap aliases-cap: count `:` separators in the query string before mercurius
  // hits the resolver pool. Runs only on graphql endpoints.
  scope.addHook("preValidation", async (req, reply) => {
    if (!req.url.startsWith("/graphql")) return;
    const q = (req.body && typeof req.body === "object" ? req.body.query : null) || "";
    const aliasCount = (String(q).match(/\b[a-zA-Z_][a-zA-Z0-9_]*\s*:\s*[a-zA-Z_]/g) || []).length;
    if (aliasCount > GQL_ALIASES) {
      return reply.code(400).send({ errors: [{ message: "graphql query has too many aliases", extensions: { code: "QUERY_COMPLEXITY", limit: GQL_ALIASES } }] });
    }
  });
});

// License plugin is always-on; everything else is gated by feature flags
// so a downgraded / community license still serves /api/license itself.
await app.register(licenseRoutes);

// Per-feature plugin registration. We wrap each Fastify plugin in a
// thin scope that adds a license-feature preHandler at the plugin root.
// The plugin still runs (so the routes register) but every request is
// short-circuited with a 402 if the active license lacks the feature.
async function registerWithFeature(plugin, feature) {
  await app.register(async (scope) => {
    if (feature) scope.addHook("onRequest", requireFeature(feature));
    await scope.register(plugin);
  });
}

await app.register(authRoutes);
await app.register(coreRoutes);
await registerWithFeature(i3xRoutes, FEATURES.I3X_API);
await app.register(fileRoutes);
await app.register(tokenRoutes);
await registerWithFeature(webhookRoutes, FEATURES.WEBHOOKS);
await app.register(extrasRoutes);
await registerWithFeature(aiRoutes, FEATURES.AI_PROVIDERS);
await registerWithFeature(automationRoutes, FEATURES.N8N_AUTOMATIONS);
await registerWithFeature(cadRoutes, FEATURES.CAD_VIEWER);
await registerWithFeature(complianceRoutes, FEATURES.COMPLIANCE_CONSOLE);
await registerWithFeature(enterpriseSystemRoutes, FEATURES.ENTERPRISE_SYSTEMS);
attachSSE(app);
registerMetrics(app);

// §19 success-metrics endpoints (live + historical).
app.get("/api/metrics/series", async (req) => {
  const metric = req.query?.metric || "wau";
  const days = Math.min(60, Number(req.query?.days || 14));
  return readSeries(metric, days);
});
app.get("/api/metrics/snapshot", async () => listDailySnapshot());

// Serve the built client. Source serving is an explicit development fallback.
//
// Cache strategy:
//   - /assets/*  hashed bundles → 1y immutable. Vite emits content-hashed
//     filenames, so any code change produces a new URL and the old URL
//     can be cached forever.
//   - everything else (index.html, manifest, icon) → no-store so admins
//     and reverse proxies always see the latest entry point.
await app.register(fStatic, {
  root: CLIENT_ROOT,
  prefix: "/",
  constraints: {},
  decorateReply: false,
  // Disable @fastify/static's default Cache-Control (it would otherwise
  // overwrite our setHeaders values with `public, max-age=0`).
  cacheControl: false,
  setHeaders: (res, filePath) => {
    const isAsset = /[\\/]assets[\\/]/.test(filePath);
    if (isAsset) {
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    } else if (/index\.html?$/i.test(filePath)) {
      res.setHeader("Cache-Control", "no-store, must-revalidate");
    } else {
      res.setHeader("Cache-Control", "public, max-age=300");
    }
  },
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
startOutboxWorker(app.log);
startRetentionWorker(app.log);

// Record boot in the audit ledger.
audit({ actor: "system", action: "server.start", subject: "forge", detail: { host: HOST, port: PORT, pid: process.pid } });

try {
  // 1) Restore the persisted activation token from disk (no network).
  //    This means an already-activated FORGE app comes up at full
  //    entitlement with zero outbound traffic.
  loadPersistedActivation();

  // 2) If we don't yet have a persisted activation but a local LS is
  //    configured, pull once before listening so the very first
  //    /api/license response reflects the real entitlement.
  if (!getLicense().activation_id && process.env.FORGE_LOCAL_LS_URL) {
    try { await pollLocalLicenseServer(); }
    catch (err) { app.log.warn({ err: String(err.message || err) }, "initial local-LS pull failed; the FORGE app will keep trying via heartbeat"); }
  }

  // 3) Daily best-effort heartbeat. Detects supersession (the same
  //    customer activated this license on another machine) or
  //    operator-initiated release/revoke, so this app downgrades
  //    itself promptly. Heartbeat failures are non-fatal — we
  //    continue serving from the cached activation.
  if (process.env.FORGE_LOCAL_LS_URL) {
    const heartbeatMs = Number(process.env.FORGE_LOCAL_LS_HEARTBEAT_S || 86_400) * 1000;
    if (heartbeatMs > 0) {
      setInterval(() => {
        pollLocalLicenseServer().catch((err) => app.log.warn({ err: String(err.message || err) }, "license heartbeat failed"));
      }, heartbeatMs);
    }
  }

  await app.listen({ host: HOST, port: PORT });
  app.log.info(`FORGE server listening on http://${HOST}:${PORT}`);
  const lic = getLicense();
  app.log.info({
    license_source: lic.source,
    customer: lic.customer,
    tier: lic.tier,
    edition: lic.edition,
    term: lic.term,
    seats: lic.seats,
    license_expires_at: lic.expires_at,
    status: lic.status,
    activation_status: lic.activation_status || null,
    activation_id: lic.activation_id || null,
    activation_token_id: lic.activation_token_id || null,
    feature_count: lic.features.length,
    local_ls: localLicenseStatus(),
  }, lic.source === "fallback"
    ? "no license installed; running on Community plan"
    : lic.source === "local_ls_unreachable"
      ? "local license server unreachable and no cached activation; running on Community plan until activation"
      : lic.status === "superseded"
        ? `activation ${lic.activation_id} has been superseded by another machine; running on Community plan`
        : lic.status === "released"
          ? `activation ${lic.activation_id} has been released to the pool; running on Community plan`
          : lic.status === "revoked"
            ? `activation ${lic.activation_id} has been revoked by the operator; running on Community plan`
            : `licensed to ${lic.customer} (${lic.tier}) — activation ${lic.activation_id || "?"}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// Graceful shutdown.
//
// Sequence is deliberate: stop accepting new connections first, then
// close every long-running worker so no new background work is queued,
// then drain whatever is in flight (audit hash queue + Fastify), and
// finally hard-exit if any of the above hangs past the grace period.
const SHUTDOWN_GRACE_MS = Number(process.env.FORGE_SHUTDOWN_GRACE_MS || 15_000);
let _shuttingDown = false;

async function shutdown(sig) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  app.log.info({ sig, graceMs: SHUTDOWN_GRACE_MS }, "shutting down");
  audit({ actor: "system", action: "server.stop", subject: "forge", detail: { sig } });

  // Force-exit timer in case any async step deadlocks.
  const killSwitch = setTimeout(() => {
    app.log.error({ sig }, "shutdown grace exceeded; forcing exit");
    process.exit(1);
  }, SHUTDOWN_GRACE_MS);
  if (typeof killSwitch.unref === "function") killSwitch.unref();

  try {
    // 1) Drain SSE clients (sends `event: shutdown`, ends sockets).
    await shutdownSSE({ logger: app.log });

    // 2) Stop every background worker. Each is a synchronous interval
    //    teardown today; promisified so future async closers fit in.
    await Promise.allSettled([
      Promise.resolve().then(() => stopWebhookWorker()),
      Promise.resolve().then(() => stopOutboxWorker()),
      Promise.resolve().then(() => stopAlertWorker()),
      Promise.resolve().then(() => stopRetentionWorker()),
      Promise.resolve().then(() => stopRollupWorker()),
      Promise.resolve().then(() => stopMqttBridge()),
      Promise.resolve().then(() => stopOpcuaBridge()),
    ]);

    // 3) Stop Fastify (closes the listener + pending requests).
    await app.close();

    // 4) Flush the audit hash queue so the last entries (including
    //    `server.stop`) are persisted before we exit.
    await drainAudit();

    // 5) Flush OpenTelemetry traces if enabled.
    await shutdownTracing();
  } catch (err) {
    app.log.error({ err: String(err?.message || err) }, "shutdown step failed");
  } finally {
    clearTimeout(killSwitch);
    process.exit(0);
  }
}

process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
