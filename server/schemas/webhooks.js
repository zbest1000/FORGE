// Webhook route schemas.

import { NonEmptyString } from "./common.js";

export const WebhookCreateBody = {
  type: "object",
  required: ["name", "url"],
  additionalProperties: true,
  properties: {
    name: NonEmptyString(256),
    // SSRF + scheme validation lives in `server/security/outbound.js`.
    // Schema-level pattern is a coarse early gate — actual rejection
    // (private-ip, scheme-not-allowed, internal-host) produces a
    // richer error envelope.
    url: { type: "string", minLength: 8, maxLength: 2048, pattern: "^https?://" },
    events: { type: "array", items: { type: "string", maxLength: 128 }, maxItems: 100 },
    secret: { type: ["string", "null"], minLength: 8, maxLength: 256 },
  },
};

export const WebhookPatchBody = {
  type: "object",
  additionalProperties: true,
  properties: {
    enabled: { type: "boolean" },
  },
};
