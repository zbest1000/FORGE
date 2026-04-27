// Reusable JSON-schema fragments shared across route plugins.
//
// Fastify has built-in JSON-schema validation; attaching `schema` to a
// route definition validates body / params / querystring before the
// handler runs and rejects malformed inputs with a 400 + structured
// error envelope (see `server/errors.js`).
//
// We deliberately set `additionalProperties: true` on most schemas so
// existing clients that send extra fields keep working during the
// migration. Tight schemas can come later.

export const Id = { type: "string", minLength: 1, maxLength: 64 };

// We intentionally avoid `format: "email"` because (a) Ajv's email
// format is overly strict for the demo / self-hosted accounts that
// don't use a public TLD (e.g. `admin@forge.local`, `viewer@x`), and
// (b) email syntactic validation is the responsibility of the
// directory / SCIM layer, not the auth endpoint. The minimum here is
// "non-empty, contains an @, no embedded whitespace".
export const Email = {
  type: "string",
  minLength: 3,
  maxLength: 254,
  pattern: "^\\S+@\\S+$",
};

export const Iso8601 = {
  type: "string",
  format: "date-time",
};

export const NonEmptyString = (max = 1024) => ({
  type: "string",
  minLength: 1,
  maxLength: max,
});

export const PaginationQuery = {
  type: "object",
  additionalProperties: true,
  properties: {
    limit: { type: ["integer", "string"], minimum: 1, maximum: 500 },
    offset: { type: ["integer", "string"], minimum: 0 },
  },
};

export const IdParam = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: { id: Id },
};

/** Standard error envelope for response schemas — informational only. */
export const ErrorEnvelope = {
  type: "object",
  required: ["error"],
  properties: {
    error: {
      type: "object",
      required: ["code", "message"],
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        requestId: { type: ["string", "null"] },
        details: { type: ["object", "null"], additionalProperties: true },
      },
      additionalProperties: true,
    },
    error_legacy_message: { type: ["string", "null"] },
  },
  additionalProperties: true,
};
