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
import { registerIdempotency } from "./idempotency.js";
import { attachSSE, registerSubscribeRoute } from "./sse.js";
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
import operationsRoutes from "./routes/operations.js";
import assetHierarchyRoutes from "./routes/asset-hierarchy.js";
import assetProfileRoutes from "./routes/asset-profiles.js";
import assetBindingRoutes from "./routes/asset-bindings.js";
import tagWritebackRoutes from "./routes/tag-writeback.js";
import * as connectorRegistry from "./connectors/registry.js";
import { startOpcuaServer, stopOpcuaServer } from "./opcua-server.js";
import { config } from "./config.js";
import { getLicense, requireFeature, FEATURES, pollLocalLicenseServer, loadPersistedActivation, localLicenseStatus } from "./license.js";

import { startMqttBridge, stopMqttBridge } from "./connectors/mqtt.js";
import { startOpcuaBridge, stopOpcuaBridge } from "./connectors/opcua.js";
import { startAlertWorker, stopAlertWorker } from "./alerts.js";
import { startRollupWorker, stopRollupWorker, readSeries, listDailySnapshot } from "./metrics-rollup.js";
import { startRetentionWorker, stopRetentionWorker } from "./retention.js";
import { startTamperWorker, stopTamperWorker } from "./audit-tamper.js";
import { stopOutboxWorker } from "./outbox.js";
import { stopWebhookWorker } from "./webhooks.js";
import { drain as drainAudit } from "./audit.js";
import { shutdownSSE } from "./sse.js";
import { shutdownTracing } from "./tracing.js";
import { errorHandler, buildEnvelope } from "./errors.js";

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

// API versioning shim is wired through `rewriteUrl` because Fastify
// route resolution runs *before* the `onRequest` hook chain, so any
// rewrite has to happen at the constructor layer to be visible to the
// router. `/api/v1/...` is the canonical, versioned URL space; we
// rewrite it to the unversioned handler so existing route registrations
// continue to match.
const VERSION_DEPRECATION_EXEMPT = new Set([
  "/api/health",
  "/api/metrics/series",
  "/api/metrics/snapshot",
]);
function versionRewrite(rawReq) {
  const original = rawReq.url || "";
  const queryIdx = original.indexOf("?");
  const pathPart = queryIdx === -1 ? original : original.slice(0, queryIdx);
  const queryPart = queryIdx === -1 ? "" : original.slice(queryIdx);
  if (pathPart.startsWith("/api/v1/")) {
    // Stash the original path on the raw request so the response hook
    // can tell canonical (versioned) requests apart from legacy ones.
    rawReq.__forgeApiVersion = "v1";
    return "/api" + pathPart.slice("/api/v1".length) + queryPart;
  }
  if (pathPart.startsWith("/api/")) {
    rawReq.__forgeApiVersion = "legacy";
  }
  return original;
}

// Pino redaction list. Any path matching one of these is replaced
// with `[Redacted]` before the log line is serialised, so a future
// debug call that accidentally logs the request body or response
// payload doesn't leak credentials.
//
// We deliberately scope these to common secret-bearing fields rather
// than applying a regex over every value — pino's path matcher is a
// fixed list, and overly broad redaction breaks observability.
const LOG_REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers['x-forge-token']",
  "headers.authorization",
  "headers.cookie",
  "secret",
  "*.secret",
  "password",
  "*.password",
  "token",
  "*.token",
  "refreshToken",
  "*.refreshToken",
  "totpSecret",
  "*.totpSecret",
  "recoveryCodes",
  "*.recoveryCodes",
];

const app = Fastify({
  logger: {
    transport: process.env.NODE_ENV === "production" ? undefined : {
      target: "pino/file",
      options: { destination: 1 },
    },
    level: config.logLevel,
    redact: { paths: LOG_REDACT_PATHS, censor: "[Redacted]" },
  },
  bodyLimit: 10 * 1024 * 1024,
  trustProxy: true,
  rewriteUrl: versionRewrite,
});

// CORS. Production strict mode (`server/config.js`) refuses to start
// when `FORGE_CORS_ORIGIN` is unset — `corsOrigin === true` (reflect
// any origin) is too dangerous for a credentialed cookie-bearing API.
// Development keeps the legacy permissive default for friction-free
// local work, but we log a clear warning at boot so the operator
// notices.
if (config.corsOrigin === true) {
  app.log.warn({
    nodeEnv: config.nodeEnv,
    fix: "FORGE_CORS_ORIGIN=https://your-tenant.example.com,https://second-origin",
  }, "CORS is reflecting any origin (development default). Set FORGE_CORS_ORIGIN to a comma-separated allowlist for production.");
}
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
// CSP_DEV permits 'unsafe-inline' + 'unsafe-eval' on script-src and pulls
// in esm.sh — necessary for source-mode dev (where browser-native modules
// follow the import map) but a security regression if it ever ships to
// production. Refuse to boot if dev CSP is active in NODE_ENV=production
// without an explicit opt-in. Operators that genuinely need it (e.g. a
// staging box that loads source modules) can set FORGE_ALLOW_DEV_CSP=1.
const usingDevCsp = !(HAS_DIST && !ALLOW_SOURCE_CLIENT);
if (usingDevCsp && process.env.NODE_ENV === "production" && process.env.FORGE_ALLOW_DEV_CSP !== "1") {
  // Fail fast — the alternative is silently shipping a relaxed CSP.
  // eslint-disable-next-line no-console
  console.error(
    "[forge] REFUSING TO START: dev CSP (allows 'unsafe-inline' + esm.sh) is active " +
    "but NODE_ENV=production. Build the SPA with `npm run build` so dist/ exists, " +
    "or — only if you really mean it — set FORGE_ALLOW_DEV_CSP=1.\n"
  );
  throw new Error("dev CSP active in production; refusing to start");
}
if (usingDevCsp && process.env.NODE_ENV !== "production") {
  // Quieter warning in dev/test — visible but not an obstacle.
  // eslint-disable-next-line no-console
  console.warn("[forge] dev CSP active (source-mode). Production builds use the strict CSP automatically.");
}
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

// API versioning surface.
//
// `rewriteUrl` (above) handles canonical `/api/v1/...` requests by
// stripping the `/v1` segment so the existing handlers keep matching.
// This `onRequest` hook handles the *response* side: legacy `/api/...`
// requests (the unversioned alias) get a `Deprecation` + `Link` pair
// so callers can discover the canonical URL. The `/api/health` and
// `/api/metrics/*` paths are stable contracts and stay clean.
//
// `req.headers["x-original-url"]` and `req.url` both reflect the
// rewritten URL by the time this hook runs, so the only way to tell a
// canonical v1 request from a legacy one is to inspect `req.raw.url`
// after rewrite — fastify also exposes the raw socket request, but
// `rewriteUrl` mutates that. We instead use a per-request marker set
// in `rewriteUrl` itself? No — Fastify constructs the request after
// rewrite. Simpler: this hook checks the *current* URL and emits
// deprecation only when the URL was NOT taken from a `/api/v1/...`
// path. A canonical request never appears under `/api/health` because
// Fastify will rewrite `/api/v1/health` → `/api/health` *before* this
// hook runs; we therefore read the `Referer`-style header that the
// rewrite leaves behind. To avoid that complexity, we instead set a
// marker header on the response from inside `rewriteUrl`: not possible
// (no reply object). Final design: stash the original URL on the
// `request.raw` before rewrite happens. That's what Fastify does
// internally; we read `req.raw.url` (post-rewrite) and look at
// `req.headers["x-forge-original-url"]` if present (set by the rewrite
// hook below). This avoids any reliance on framework internals.
app.addHook("onRequest", async (req, reply) => {
  const apiVersion = req.raw?.__forgeApiVersion || null;
  if (apiVersion !== "legacy") return; // canonical or non-API request
  const pathPart = (req.url || "").split("?")[0];
  if (VERSION_DEPRECATION_EXEMPT.has(pathPart)) return;
  const successor = "/api/v1" + pathPart.slice("/api".length);
  reply.header("Deprecation", "true");
  reply.header("Sunset", "Wed, 31 Dec 2025 23:59:59 GMT");
  reply.header("Link", `<${successor}>; rel="successor-version"`);
});

// Request id propagation. Fastify already generates `req.id`; surface
// it on the response so clients (and SIEMs) can correlate logs across
// the boundary, and so unified error envelopes can include it.
app.addHook("onRequest", async (req, reply) => {
  if (req.id) reply.header("X-Request-Id", req.id);
});

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
// Cheap pre-validation guards complementing mercurius's queryDepth + the
// alias cap below. Both are tunable via env so legitimate large queries
// (BI exports, audit dumps) can lift them without a redeploy.
const GQL_MAX_LENGTH = Number(process.env.FORGE_GRAPHQL_MAX_LENGTH || 32 * 1024); // 32 KB
const GQL_MAX_SELECTIONS = Number(process.env.FORGE_GRAPHQL_MAX_SELECTIONS || 500);
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
  // Pre-validation guards on /graphql. Cheap regex/length checks that
  // run before mercurius parses the document — defends the resolver pool
  // and the parser from oversize / overly-complex requests.
  scope.addHook("preValidation", async (req, reply) => {
    if (!req.url.startsWith("/graphql")) return;
    const q = String((req.body && typeof req.body === "object" ? req.body.query : null) || "");

    // 1) Raw length cap. A 32 KB query is a generous ceiling for any
    //    legitimate UI/API request and cuts off pathological payloads.
    if (q.length > GQL_MAX_LENGTH) {
      return reply.code(413).send({ errors: [{ message: "graphql query too large", extensions: { code: "QUERY_TOO_LARGE", limit: GQL_MAX_LENGTH } }] });
    }

    // 2) Aliases cap (kept) — `field: subfield` aliasing is the cheapest
    //    way to force a server to repeat work N times under a single
    //    selection.
    const aliasCount = (q.match(/\b[a-zA-Z_][a-zA-Z0-9_]*\s*:\s*[a-zA-Z_]/g) || []).length;
    if (aliasCount > GQL_ALIASES) {
      return reply.code(400).send({ errors: [{ message: "graphql query has too many aliases", extensions: { code: "QUERY_COMPLEXITY", limit: GQL_ALIASES } }] });
    }

    // 3) Total selection count (open braces minus comments/strings, but
    //    we skip the AST since this runs before parse). Keeps a single
    //    deeply-flat query from blowing past resolver budget.
    const selectionCount = (q.match(/\{/g) || []).length;
    if (selectionCount > GQL_MAX_SELECTIONS) {
      return reply.code(400).send({ errors: [{ message: "graphql query has too many selections", extensions: { code: "QUERY_COMPLEXITY", limit: GQL_MAX_SELECTIONS } }] });
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

// Idempotency-Key handling. Registered before the routes so its
// preHandler can short-circuit replays before any handler-side work.
await registerIdempotency(app);

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
await app.register(operationsRoutes);
await app.register(assetHierarchyRoutes);
await app.register(assetProfileRoutes);
await app.register(assetBindingRoutes);
await app.register(tagWritebackRoutes);
attachSSE(app);
registerSubscribeRoute(app);
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

// Unified error handler. All thrown errors and validation failures
// flow through the structured envelope from `server/errors.js`.
app.setErrorHandler(errorHandler());

// SPA fallback: any non-API, non-file path that missed the static handler
// gets index.html so deep links (`/admin`, `/doc/DOC-1`) work after reload.
app.setNotFoundHandler((req, reply) => {
  const p = (req.url || "/").split("?")[0];
  if (p.startsWith("/api/") || p.startsWith("/v1/") || p.startsWith("/metrics") || p.startsWith("/graphql")) {
    reply.code(404);
    return reply.send(buildEnvelope({
      status: 404,
      code: "not_found",
      message: "not found",
      requestId: req.id || null,
      details: { path: p },
    }));
  }
  // Paths that look like files (have an extension) should 404 rather than
  // serve HTML — prevents broken <img>/<script> from loading index.html.
  const last = p.split("/").pop() || "";
  if (last.includes(".")) {
    reply.code(404);
    return reply.send(buildEnvelope({
      status: 404,
      code: "not_found",
      message: "not found",
      requestId: req.id || null,
      details: { path: p },
    }));
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
startTamperWorker(app.log);
// Phase 3: connector registry (SQL polling subregistry boots here;
// MQTT + OPC UA registries land in Phase 4 + 5). Honours the
// FORGE_DISABLE_CONNECTOR_REGISTRY=1 escape hatch for in-process
// route tests that don't want side-effecting timers.
connectorRegistry.init({ logger: app.log }).catch(err =>
  app.log.warn({ err: String(err?.message || err) }, "connector registry init failed"));

// Phase 5: optional FORGE-as-OPC-UA-server (spec §7.1). Boots only
// when FORGE_OPCUA_SERVER_ENABLED=1 so the default install doesn't
// open port 4840. Failures are non-fatal — the rest of FORGE keeps
// running.
startOpcuaServer({ logger: app.log }).catch(err =>
  app.log.warn({ err: String(err?.message || err) }, "opcua server start failed"));

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
      Promise.resolve().then(() => stopTamperWorker()),
      Promise.resolve().then(() => stopRollupWorker()),
      Promise.resolve().then(() => stopMqttBridge()),
      Promise.resolve().then(() => stopOpcuaBridge()),
      Promise.resolve().then(() => connectorRegistry.shutdown()),
      Promise.resolve().then(() => stopOpcuaServer()),
      Promise.resolve().then(async () => {
        const { shutdownHistorians } = await import("./historians/index.js");
        await shutdownHistorians();
      }),
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
