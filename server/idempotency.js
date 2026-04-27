// HTTP idempotency-key contract for write APIs.
//
// Implements the semantics of RFC draft-ietf-httpapi-idempotency-key.
// Clients tag a non-idempotent request with `Idempotency-Key: <opaque>`;
// the server stores the response and replays it for any subsequent
// request that carries the same key from the same authenticated user.
//
// Why
// ---
// Without this, a network-level retry of `POST /api/work-items`
// produces two work items, the dispatcher creates two webhook
// deliveries, two audit rows, etc. With it, the second call returns
// the cached response and no side effects fire.
//
// Scope
// -----
// - Applies only to `POST`, `PUT`, `PATCH`, `DELETE` requests that
//   carry the `Idempotency-Key` header. GET / HEAD are pass-through.
// - Requires an authenticated user. Anonymous requests bypass the
//   cache (the audit explicitly notes server-only / streaming auth is
//   handled separately).
// - Skips streaming endpoints whose response body is not JSON-cacheable
//   (`/api/events/stream`, `/v1/subscriptions/stream`).
//
// Mismatch handling (RFC §2.4):
//   - Same key, same fingerprint   → replay cached response.
//   - Same key, in_flight          → 409 with `state: in_flight`.
//   - Same key, different body/url → 409 with `state: mismatch`.
//   - No key                       → handler runs untouched.
//
// Storage
// -------
// `idempotency_keys` rows live for `FORGE_IDEMPOTENCY_TTL_HOURS`
// (default 24). The retention sweep prunes expired rows.

import crypto from "node:crypto";
import { db } from "./db.js";

const DEFAULT_TTL_HOURS = Number(process.env.FORGE_IDEMPOTENCY_TTL_HOURS || 24);
const KEY_MAX = 256;
const SUPPORTED_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const SKIP_PATHS = [
  "/api/events/stream",
  "/v1/subscriptions/stream",
  "/api/auth/refresh", // refresh tokens are inherently single-use
];

const stmtSelect = db.prepare("SELECT * FROM idempotency_keys WHERE user_id = ? AND key = ?");
const stmtInsertInFlight = db.prepare(`
  INSERT INTO idempotency_keys (user_id, key, method, path, fingerprint, state, created_at, expires_at)
  VALUES (@user_id, @key, @method, @path, @fingerprint, 'in_flight', @created_at, @expires_at)
`);
const stmtFinalize = db.prepare(`
  UPDATE idempotency_keys
     SET status = @status,
         response_body = @response_body,
         response_headers = @response_headers,
         state = 'completed',
         completed_at = @completed_at
   WHERE user_id = @user_id AND key = @key
`);
const stmtAbort = db.prepare("DELETE FROM idempotency_keys WHERE user_id = ? AND key = ?");
const stmtSweep = db.prepare("DELETE FROM idempotency_keys WHERE expires_at < ?");

function nowIso() { return new Date().toISOString(); }
function plusHoursIso(h) { return new Date(Date.now() + h * 3_600_000).toISOString(); }

/**
 * Derive a deterministic fingerprint of the (method, path, body) tuple
 * so a replay with a *different* body on the same key is detectable.
 */
function fingerprint({ method, path, body }) {
  const payload = JSON.stringify([method, path, body ?? null]);
  return crypto.createHash("sha256").update(payload).digest("hex");
}

function isCacheable(req) {
  if (!SUPPORTED_METHODS.has(req.method)) return false;
  if (!req.user) return false;
  const p = (req.url || "").split("?")[0];
  return !SKIP_PATHS.some((s) => p === s || p.startsWith(s + "/"));
}

/**
 * Fastify plugin. Wire the two hooks into the request lifecycle:
 *   - preHandler: short-circuit replays / 409 mismatches; otherwise
 *     reserve an in_flight row.
 *   - onSend     : finalize the row with the captured response.
 *   - onError    : drop the in_flight row so the caller can retry.
 */
export async function registerIdempotency(fastify) {
  fastify.decorateRequest("_idempotencyKey", null);

  fastify.addHook("preHandler", async (req, reply) => {
    if (!isCacheable(req)) return;
    const raw = req.headers["idempotency-key"];
    if (!raw) return;
    const key = String(raw).trim().slice(0, KEY_MAX);
    if (!key) return reply.code(400).send({ error: "invalid Idempotency-Key" });

    const path = (req.url || "").split("?")[0];
    const fp = fingerprint({ method: req.method, path, body: req.body });
    const existing = stmtSelect.get(req.user.id, key);

    if (existing) {
      if (existing.fingerprint !== fp || existing.method !== req.method || existing.path !== path) {
        return reply.code(409).send({
          error: "idempotency key mismatch",
          reason: "mismatch",
          message: "key was previously used with a different request",
        });
      }
      if (existing.state === "in_flight") {
        return reply.code(409).send({
          error: "idempotency key in flight",
          reason: "in_flight",
          message: "the original request is still being processed",
        });
      }
      // Replay: emit the cached response and skip the handler.
      reply.header("Idempotency-Replay", "true");
      try {
        const headers = JSON.parse(existing.response_headers || "{}");
        for (const [k, v] of Object.entries(headers)) {
          if (k.toLowerCase() === "content-length") continue;
          reply.header(k, v);
        }
      } catch { /* ignore */ }
      reply.code(existing.status || 200);
      const body = existing.response_body || "null";
      // Use raw send so we can hand back the exact JSON the original
      // handler produced.
      try { return reply.type("application/json").send(JSON.parse(body)); }
      catch { return reply.send(body); }
    }

    // First time we've seen this key — reserve a slot.
    try {
      stmtInsertInFlight.run({
        user_id: req.user.id,
        key,
        method: req.method,
        path,
        fingerprint: fp,
        created_at: nowIso(),
        expires_at: plusHoursIso(DEFAULT_TTL_HOURS),
      });
      req._idempotencyKey = key;
    } catch (err) {
      // Race: another concurrent request inserted the same key. Re-read
      // and let the next iteration's logic handle it (most likely
      // returning 409 in_flight).
      const dup = stmtSelect.get(req.user.id, key);
      if (dup) {
        return reply.code(409).send({ error: "idempotency key in flight", reason: "in_flight" });
      }
      throw err;
    }
  });

  fastify.addHook("onSend", async (req, reply, payload) => {
    if (!req._idempotencyKey) return payload;
    const status = reply.statusCode;
    // Cache only successful + client-error responses; transient 5xx
    // shouldn't get pinned because the next retry might succeed.
    if (status >= 500) {
      stmtAbort.run(req.user.id, req._idempotencyKey);
      return payload;
    }
    let bodyStr = "null";
    if (payload != null) {
      if (typeof payload === "string") bodyStr = payload;
      else if (Buffer.isBuffer(payload)) bodyStr = payload.toString("utf8");
      else { try { bodyStr = JSON.stringify(payload); } catch { bodyStr = String(payload); } }
    }
    const headers = {};
    for (const k of ["content-type", "x-content-sha256", "x-forge-event"]) {
      const v = reply.getHeader(k);
      if (v != null) headers[k] = String(v);
    }
    stmtFinalize.run({
      status,
      response_body: bodyStr,
      response_headers: JSON.stringify(headers),
      completed_at: nowIso(),
      user_id: req.user.id,
      key: req._idempotencyKey,
    });
    return payload;
  });

  fastify.addHook("onError", async (req, _reply, _error) => {
    if (req._idempotencyKey && req.user) {
      stmtAbort.run(req.user.id, req._idempotencyKey);
    }
  });
}

/** Prune expired idempotency rows. Called from the retention worker. */
export function sweepIdempotency() {
  const r = stmtSweep.run(nowIso());
  return { changes: r.changes, mode: "hard" };
}

// Test-only escape hatch.
export function _drop(userId, key) { stmtAbort.run(userId, key); }
