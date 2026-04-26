// FORGE local license server — runs on the customer's network as a
// sidecar to the FORGE app. One per customer (or one per data centre).
//
// Activation model:
//   - Online activation is required ONCE. After that the long-lived
//     activation1.* token is cached on disk and served to FORGE app
//     instances over the LAN.
//   - The local LS opportunistically heartbeats once a day to detect
//     supersession (the same customer activated on another machine)
//     or operator-initiated release/revoke. The heartbeat is best-
//     effort and an offline customer keeps running normally.
//   - The customer can voluntarily release the activation back to
//     the pool (POST /api/v1/release) so it can be reused elsewhere.
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
//   LOCAL_LS_HEARTBEAT_S       default 86400 (24h). Set to 0 to disable.

import Fastify from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import os from "node:os";
import crypto from "node:crypto";

import { activate, release as releaseRemote, heartbeat } from "./central-client.js";
import { verifyEntitlement } from "./verify.js";
import { getState, saveActivation, applyHeartbeatResult, recordHeartbeatError, markReleased } from "./state.js";

const PORT = Number(process.env.PORT || 7200);
const HOST = process.env.HOST || "0.0.0.0";
const CUSTOMER_ID = process.env.FORGE_CUSTOMER_ID;
const ACTIVATION_KEY = process.env.FORGE_ACTIVATION_KEY;
const SHARED_TOKEN = process.env.LOCAL_LS_SHARED_TOKEN;
const HEARTBEAT_S = Number(process.env.LOCAL_LS_HEARTBEAT_S || 86_400);
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
  console.error("error: LOCAL_LS_SHARED_TOKEN is required and must be at least 16 chars");
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
  return {
    status: "ok",
    customer_id: CUSTOMER_ID,
    instance_id: INSTANCE_ID,
    activation_status: s.activation_status || "uninitialised",
    activation_token_id: s.activation_token_id || null,
    activation_id: s.activation_id || null,
    issued_at: s.issued_at || null,
    last_heartbeat_at: s.last_heartbeat_at || null,
    last_heartbeat_error: s.last_heartbeat_error || null,
    superseded_by: s.superseded_by || null,
    released_at: s.released_at || null,
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
  if (!s.activation_token) {
    return reply.code(503).send({
      error: "no_activation",
      message: "This local license server hasn't activated yet. Once activation succeeds against FORGE LLC the token will be served here.",
    });
  }
  if (s.activation_status && s.activation_status !== "active") {
    // We deliberately still return the cached token — the FORGE app
    // will see the same status and decide for itself how to react.
    return {
      activation_token: s.activation_token,
      activation_id: s.activation_id,
      activation_token_id: s.activation_token_id,
      issued_at: s.issued_at,
      activation_status: s.activation_status,
      released_at: s.released_at || null,
      revoked_at: s.revoked_at || null,
      superseded_by: s.superseded_by || null,
      last_heartbeat_at: s.last_heartbeat_at || null,
      customer: s.customer,
      license: s.license,
    };
  }
  // Re-verify the cached token before serving so we never hand back a corrupt blob.
  const v = verifyEntitlement(s.activation_token);
  if (!v.ok) {
    return reply.code(500).send({
      error: "entitlement_invalid",
      message: "Cached activation token signature did not verify. The local license server should be re-activated.",
      detail: v.error,
    });
  }
  return {
    activation_token: s.activation_token,
    activation_id: s.activation_id,
    activation_token_id: s.activation_token_id,
    issued_at: s.issued_at,
    activation_status: "active",
    last_heartbeat_at: s.last_heartbeat_at || null,
    customer: s.customer,
    license: s.license,
    instance_id: INSTANCE_ID,
  };
});

// Trigger activation now (synchronous). Useful from the FORGE admin UI
// the first time a customer brings the stack up, or after a release
// to take the seat back.
app.post("/api/v1/activate-now", async (req, reply) => {
  if (!lanAuthenticated(req)) {
    return reply.code(401).send({ error: "lan_auth_invalid", message: "Provide a valid LOCAL_LS_SHARED_TOKEN bearer." });
  }
  try {
    const result = await runActivate();
    return { ok: true, result };
  } catch (err) {
    return reply.code(502).send({ error: "activate_failed", message: err.message || String(err) });
  }
});

// Release the cached activation back to the FORGE LLC pool so the
// customer can take this seat to a different machine. The local LS
// stops serving the token once the central server confirms.
app.post("/api/v1/release", async (req, reply) => {
  if (!lanAuthenticated(req)) {
    return reply.code(401).send({ error: "lan_auth_invalid", message: "Provide a valid LOCAL_LS_SHARED_TOKEN bearer." });
  }
  const s = getState();
  if (!s.activation_token_id) {
    return reply.code(409).send({ error: "no_activation", message: "There's no active activation on this server." });
  }
  try {
    const r = await releaseRemote({
      instance_id: INSTANCE_ID,
      customer_id: CUSTOMER_ID,
      activation_token_id: s.activation_token_id,
      activation_id: s.activation_id,
    });
    if (!r.ok) {
      return reply.code(502).send({ error: "release_failed", message: r.body?.message || `central server returned ${r.status}` });
    }
    markReleased();
    return { ok: true, status: "released", released_at: r.body?.released_at };
  } catch (err) {
    return reply.code(502).send({ error: "release_failed", message: err.message || String(err) });
  }
});

// Force a heartbeat now. The same logic runs on a daily timer.
app.post("/api/v1/heartbeat-now", async (req, reply) => {
  if (!lanAuthenticated(req)) {
    return reply.code(401).send({ error: "lan_auth_invalid", message: "Provide a valid LOCAL_LS_SHARED_TOKEN bearer." });
  }
  try {
    const result = await runHeartbeat();
    return { ok: true, result };
  } catch (err) {
    return reply.code(502).send({ error: "heartbeat_failed", message: err.message || String(err) });
  }
});

// --- Central server interaction -----------------------------------
async function runActivate() {
  const central = await activate({ instance_id: INSTANCE_ID, customer_id: CUSTOMER_ID });
  if (!central.ok) {
    const msg = central.body?.message || `central server returned ${central.status}`;
    app.log.warn({ status: central.status, body: central.body }, "activation failed");
    throw new Error(msg);
  }
  const verified = verifyEntitlement(central.body.activation_token);
  if (!verified.ok) {
    throw new Error("central server returned an activation token that failed signature verification: " + verified.error);
  }
  if (verified.payload.customer_id !== CUSTOMER_ID) {
    throw new Error("central server issued a token for a different customer id (configuration mismatch)");
  }
  return saveActivation({
    activation_token: central.body.activation_token,
    activation_id: central.body.activation_id,
    activation_token_id: central.body.activation_token_id,
    customer: central.body.customer,
    license: central.body.license,
    issued_at: central.body.issued_at,
    instance_id: INSTANCE_ID,
  });
}

async function runHeartbeat() {
  const s = getState();
  if (!s.activation_token_id) return { skipped: "no_activation" };
  try {
    const r = await heartbeat({
      instance_id: INSTANCE_ID,
      customer_id: CUSTOMER_ID,
      activation_token_id: s.activation_token_id,
    });
    if (!r.ok) {
      recordHeartbeatError(r.body?.message || `central server returned ${r.status}`);
      app.log.warn({ status: r.status, body: r.body }, "heartbeat returned non-OK");
      return { ok: false, status: r.status };
    }
    applyHeartbeatResult(r.body || {});
    return { ok: true, body: r.body };
  } catch (err) {
    recordHeartbeatError(err.message || String(err));
    app.log.warn({ err: String(err.message || err) }, "heartbeat threw");
    throw err;
  }
}

// --- Boot ---------------------------------------------------------
try {
  await app.listen({ host: HOST, port: PORT });
  app.log.info({ instance_id: INSTANCE_ID, customer_id: CUSTOMER_ID, heartbeat_s: HEARTBEAT_S },
    `FORGE local license server listening on http://${HOST}:${PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// First activation, in the background — only when we don't already
// have a cached token. The HTTP API is up immediately either way.
if (!getState().activation_token) {
  runActivate().catch(err => {
    app.log.warn({ err: String(err.message || err) }, "initial activation failed; call POST /api/v1/activate-now to retry");
  });
}

// Daily best-effort heartbeat. Detects supersession (another machine
// took the seat), operator release, or revocation. Keeps last-seen
// fresh on the central server too.
if (HEARTBEAT_S > 0) {
  setInterval(() => {
    runHeartbeat().catch(() => {});
  }, HEARTBEAT_S * 1000);
}

function shutdown(sig) {
  app.log.info({ sig }, "shutting down");
  app.close().finally(() => process.exit(0));
}
process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
