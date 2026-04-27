// ETag / If-Match optimistic-concurrency helpers.
//
// Semantics follow RFC 7232 §3.1 (If-Match) and §2.3 (ETag). FORGE
// emits weak ETags derived from each row's `id + updated_at`:
//
//   ETag: W/"sha256:abc123…"
//
// `If-Match` rejects PATCH requests whose etag does not match the
// current row, returning 412 Precondition Failed. `If-None-Match` is
// not yet supported (used for caching, not for concurrency).
//
// Sending `If-Match` is optional by default — clients that opt in get
// optimistic concurrency, those that don't keep last-write-wins. When
// `FORGE_REQUIRE_IF_MATCH=1` is set, PATCH/DELETE requests on
// concurrency-tracked routes must include the header (428 if absent).

import crypto from "node:crypto";
import { sendError } from "./errors.js";

function strict() {
  return /^(1|true|yes|on)$/i.test(String(process.env.FORGE_REQUIRE_IF_MATCH || ""));
}

/**
 * Compute a stable, weak ETag for a row. Inputs:
 *   - `row.id`         — primary key
 *   - `row.updated_at` — ISO timestamp of last modification
 *
 * Both fields must be present; rows without them get `null`.
 */
export function etagOf(row) {
  if (!row) return null;
  const id = row.id;
  const updated = row.updated_at || row.updatedAt || row.created_at || row.createdAt;
  if (id == null || updated == null) return null;
  const hash = crypto.createHash("sha256").update(`${id}|${updated}`).digest("hex").slice(0, 32);
  return `W/"sha256:${hash}"`;
}

/**
 * Set the `ETag` header on a reply when the row supplies an etag.
 */
export function applyEtag(reply, row) {
  const tag = etagOf(row);
  if (tag) reply.header("ETag", tag);
  return tag;
}

/**
 * Enforce `If-Match` semantics on a write request against `row`.
 *
 * Behaviour:
 *   - No `If-Match` header AND not strict: pass.
 *   - No `If-Match` header AND strict: 428 Precondition Required.
 *   - `If-Match: *`: passes when the row exists.
 *   - `If-Match` value matches the row's current etag: pass.
 *   - Mismatch: 412 Precondition Failed.
 *
 * Returns `true` on pass; otherwise sends an envelope on `reply` and
 * returns `false`.
 */
export function requireIfMatch(req, reply, row) {
  const header = req.headers?.["if-match"];
  const current = etagOf(row);
  if (!header) {
    if (strict()) {
      sendError(reply, {
        status: 428,
        code: "precondition_required",
        message: "If-Match header required for optimistic concurrency",
      });
      return false;
    }
    return true;
  }
  if (!current) {
    sendError(reply, {
      status: 412,
      code: "precondition_failed",
      message: "row does not support optimistic concurrency (no updated_at)",
    });
    return false;
  }
  // Allow comma-separated tag list (RFC 7232 §3.1).
  const tags = String(header).split(",").map((s) => s.trim()).filter(Boolean);
  if (tags.includes("*")) return true;
  if (tags.includes(current)) return true;
  sendError(reply, {
    status: 412,
    code: "etag_mismatch",
    message: "row was modified since you read it",
    details: { expected: current },
  });
  return false;
}
