// Unified error envelope.
//
// Every server-emitted error response should conform to a stable shape
// so clients, support engineers, and SIEM pipelines can rely on the
// same fields regardless of which handler produced it:
//
//   {
//     "error": {
//       "code":      "FST_ERR_VALIDATION",
//       "message":   "body must have required property 'title'",
//       "requestId": "req-123",
//       "details":   { "field": "title" }      // optional
//     },
//     "error_legacy_message": "body must have required property 'title'"
//   }
//
// `error_legacy_message` is a temporary back-compat alias for callers
// that read `body.error` as a string. The duplication is intentional
// and will be removed once internal SPA call sites have migrated.
//
// The error handler registered in `server/main.js` wraps any thrown or
// `reply.code(...)`d error into this shape unless the handler already
// produced a structured `{ error: {...} }` body.

const DEFAULT_CODES = new Map([
  [400, "bad_request"],
  [401, "unauthenticated"],
  [403, "forbidden"],
  [404, "not_found"],
  [409, "conflict"],
  [412, "precondition_failed"],
  [413, "payload_too_large"],
  [415, "unsupported_media_type"],
  [422, "unprocessable_entity"],
  [428, "precondition_required"],
  [429, "too_many_requests"],
  [500, "internal_error"],
  [501, "not_implemented"],
  [502, "bad_gateway"],
  [503, "service_unavailable"],
]);

/**
 * Build an envelope object from a (status, code, message, details) tuple.
 * Pure — does not touch the reply.
 */
export function buildEnvelope({ status = 500, code, message, requestId = null, details = null }) {
  const resolvedCode = code || DEFAULT_CODES.get(status) || "error";
  const resolvedMessage = message || resolvedCode;
  const out = {
    error: {
      code: resolvedCode,
      message: resolvedMessage,
      requestId: requestId || null,
    },
    // Legacy mirror so older clients that read `body.error` as a string
    // keep working. Remove once all internal callers consume `error.message`.
    error_legacy_message: resolvedMessage,
  };
  if (details && typeof details === "object") out.error.details = details;
  return out;
}

/**
 * Send an error envelope on the given Fastify reply.
 */
export function sendError(reply, { status = 500, code, message, details = null } = {}) {
  const requestId = reply.request?.id || null;
  reply.code(status);
  return reply.send(buildEnvelope({ status, code, message, requestId, details }));
}

/**
 * Fastify error-handler factory. Catches thrown errors, validation
 * failures, and rate-limit rejections; passes structured replies through
 * untouched.
 */
export function errorHandler() {
  return function handle(err, req, reply) {
    const status = err?.statusCode || (err?.validation ? 400 : 500);
    const requestId = req.id || null;
    const isValidation = !!err?.validation;
    const code = isValidation
      ? "validation_error"
      : err?.code || DEFAULT_CODES.get(status) || "error";
    const message = err?.message || "internal error";
    const envelope = buildEnvelope({
      status,
      code,
      message,
      requestId,
      details: isValidation ? { issues: err.validation } : undefined,
    });
    if (status >= 500) {
      req.log.error({ err: String(err?.stack || err?.message || err), code, requestId }, "request failed");
    } else {
      req.log.warn({ status, code, requestId, msg: message }, "request error");
    }
    reply.code(status).send(envelope);
  };
}
