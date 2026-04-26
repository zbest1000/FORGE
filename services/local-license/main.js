// FORGE local license server — runs on the customer's network as a
// sidecar to the FORGE app. One per customer (or one per data centre).
//
// Responsibilities:
//   1. Authenticate to the FORGE LLC central server using the
//      customer's activation key, on a configurable schedule.
//   2. Cache the most recent signed entitlement bundle on disk so
//      transient internet outages don't take customers down.
//   3. Serve that bundle on the LAN to FORGE app instances over a
//      simple shared-secret HTTP API (`GET /api/v1/entitlement`).
//
// Configuration (env):
//
//   PORT                       default 7200
//   HOST                       default 0.0.0.0
//   FORGE_LLC_URL              default https://license.forge.llc
//   FORGE_CUSTOMER_ID          required: CUST-…
//   FORGE_ACTIVATION_KEY       required: fla_…  (the bearer secret)
//   LOCAL_LS_SHARED_TOKEN      required: bearer for FORGE app callers
//   LOCAL_LS_INSTANCE_ID       optional, defaults to a stable hash of
//                              FORGE_CUSTOMER_ID + machine hostname
//   LOCAL_LS_GRACE_HOURS       default 168 (7 days). After this many
//                              hours offline, served bundles are
//                              flagged as `offline_grace_expired`.
//   LOCAL_LS_REFRESH_S         default 3600 (1 hour). Lower = more
//                              outbound traffic but tighter freshness.

import Fastify from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import os from "node:os";
import crypto from "node:crypto";

import { activate, refresh, heartbeat } from "./central-client.js";
import { verifyEntitlement } from "./verify.js";
import { getState, saveActivation, recordRefreshFailure } from "./state.js";

const PORT = Number(process.env.PORT || 7200);
const HOST = process.env.HOST || "0.0.0.0";
const CUSTOMER_ID = process.env.FORGE_CUSTOMER_ID;
const ACTIVATION_KEY = process.env.FORGE_ACTIVATION_KEY;
const SHARED_TOKEN = process.env.LOCAL_LS_SHARED_TOKEN;
const GRACE_HOURS = Number(process.env.LOCAL_LS_GRACE_HOURS || 168);
const REFRESH_S = Number(process.env.LOCAL_LS_REFRESH_S || 3600);
const INSTANCE_ID = process.env.LOCAL_LS_INSTANCE_ID
  || ("ULS-" + crypto.createHash("sha256").update(String(CUSTOMER_ID || "") + os.hostname()).digest("hex").slice(0, 12));

if (!CUSTOMER_ID) {
  console.error("error: FORGE_CUSTOMER_ID is required (CUST-… from your FORGE LLC portal)");
  process.exit(2);
}
if (!ACTIVATION_KEY) {
  console.error("error: FORGE_ACTIVATION_KEY is required (fla_… from your FORGE LLC portal)");
  process.exit(2);
}
if (!SHARED_TOKEN || SHARED_TOKEN.length < 16) {
  console.error("error: LOCAL_LS_SHARED_TOKEN is required and must be at least 16 chars (used by FORGE app instances on the LAN)");
  process.exit(2);
}

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || "info",
    redact: { paths: ["req.headers.authorization"], remove: false, censor: "[redacted]" },
  },
});

await app.register(helmet, { contentSecurityPolicy: false });
await app.register(rateLimit, { global: true, max: 120, timeWindow: "1 minute" });

// --- LAN-side authentication for FORGE app callers ----------------
function lanAuthenticated(req) {
  const h = req.headers.authorization || "";
  if (!h.startsWith("Bearer ")) return false;
  const provided = h.slice(7).trim();
  if (provided.length !== SHARED_TOKEN.length) return false;
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(SHARED_TOKEN));
}

// --- Routes -------------------------------------------------------
app.get("/api/v1/health", async () => {
  const s = getState();
  const grace = computeGrace(s);
  return {
    status: "ok",
    customer_id: CUSTOMER_ID,
    instance_id: INSTANCE_ID,
    activation_status: s.activation_status || "uninitialised",
    last_central_at: s.last_central_at || null,
    last_failure_at: s.last_failure_at || null,
    bundle_id: s.bundle_id || null,
    bundle_expires_at: s.expires_at || null,
    grace_until: grace.grace_until,
    in_grace: grace.in_grace,
    grace_expired: grace.grace_expired,
    refresh_at: s.refresh_at || null,
    activation_error: s.activation_error || null,
  };
});

app.get("/api/v1/entitlement", async (req, reply) => {
  if (!lanAuthenticated(req)) {
    return reply.code(401).send({
      error: "lan_auth_invalid",
      message: "Provide a valid LOCAL_LS_SHARED_TOKEN bearer.",
    });
  }
  const s = getState();
  if (!s.entitlement) {
    return reply.code(503).send({
      error: "no_entitlement",
      message: "This local license server hasn't activated yet. Check the central license server connection.",
    });
  }
  // Re-verify before serving so we never hand back a tampered cache.
  const v = verifyEntitlement(s.entitlement);
  if (!v.ok) {
    return reply.code(500).send({
      error: "entitlement_invalid",
      message: "Cached entitlement signature did not verify. The local license server should be re-activated.",
      detail: v.error,
    });
  }
  const grace = computeGrace(s);
  return {
    entitlement: s.entitlement,
    bundle_id: s.bundle_id,
    issued_at: s.issued_at,
    expires_at: s.expires_at,
    refresh_at: s.refresh_at,
    last_central_at: s.last_central_at,
    online: !!s.activation_status && s.activation_status === "ok",
    grace_until: grace.grace_until,
    in_grace: grace.in_grace,
    grace_expired: grace.grace_expired,
    customer: s.customer,
    license: s.license,
  };
});

app.post("/api/v1/refresh-now", async (req, reply) => {
  if (!lanAuthenticated(req)) {
    return reply.code(401).send({ error: "lan_auth_invalid", message: "Provide a valid LOCAL_LS_SHARED_TOKEN bearer." });
  }
  try {
    const result = await runRefresh({ force: true });
    return { ok: true, result };
  } catch (err) {
    return reply.code(502).send({ error: "refresh_failed", message: err.message || String(err) });
  }
});

// --- Central server interaction -----------------------------------
async function runRefresh({ force = false } = {}) {
  const s = getState();
  const isActivated = !!s.entitlement;
  const central = isActivated && !force
    ? await refresh({ instance_id: INSTANCE_ID, customer_id: CUSTOMER_ID, prior_bundle_id: s.bundle_id })
    : await activate({ instance_id: INSTANCE_ID, customer_id: CUSTOMER_ID });

  if (!central.ok) {
    const msg = central.body?.message || `central server returned ${central.status}`;
    recordRefreshFailure(msg);
    app.log.warn({ status: central.status, body: central.body }, "central refresh failed");
    throw new Error(msg);
  }

  const verified = verifyEntitlement(central.body.entitlement);
  if (!verified.ok) {
    recordRefreshFailure("signature_invalid: " + verified.error);
    throw new Error("central server returned an entitlement that failed signature verification: " + verified.error);
  }
  if (verified.payload.customer_id !== CUSTOMER_ID) {
    recordRefreshFailure("customer_mismatch");
    throw new Error("central server issued an entitlement for a different customer id (configuration mismatch)");
  }

  return saveActivation({
    entitlement: central.body.entitlement,
    bundle_id: central.body.bundle_id,
    customer: central.body.customer,
    license: central.body.license,
    issued_at: central.body.issued_at,
    expires_at: central.body.expires_at,
    refresh_at: central.body.refresh_at,
  });
}

function computeGrace(s) {
  if (!s.last_central_at) return { grace_until: null, in_grace: false, grace_expired: false };
  const ms = GRACE_HOURS * 3600_000;
  const graceUntil = new Date(new Date(s.last_central_at).getTime() + ms).toISOString();
  const now = Date.now();
  const inGrace = now <= new Date(graceUntil).getTime();
  return { grace_until: graceUntil, in_grace: inGrace, grace_expired: !inGrace };
}

// --- Boot ---------------------------------------------------------
try {
  await app.listen({ host: HOST, port: PORT });
  app.log.info({ instance_id: INSTANCE_ID, customer_id: CUSTOMER_ID, refresh_s: REFRESH_S, grace_hours: GRACE_HOURS },
    `FORGE local license server listening on http://${HOST}:${PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// First activation, in the background. The HTTP API is up immediately
// either way — calls just return 503 until the first activation
// succeeds (or a cached bundle is present from a previous run).
runRefresh({ force: !getState().entitlement }).catch(err => {
  app.log.warn({ err: String(err.message || err) }, "initial activation failed; will retry");
});

setInterval(() => {
  runRefresh().catch(err => app.log.warn({ err: String(err.message || err) }, "scheduled refresh failed"));
}, REFRESH_S * 1000);

setInterval(() => {
  heartbeat({ instance_id: INSTANCE_ID, customer_id: CUSTOMER_ID }).catch(() => {});
}, Math.max(60_000, REFRESH_S * 1000 / 4));

function shutdown(sig) {
  app.log.info({ sig }, "shutting down");
  app.close().finally(() => process.exit(0));
}
process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
