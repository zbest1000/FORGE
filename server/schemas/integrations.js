// Schemas for `server/routes/enterprise-systems.js`,
// `server/routes/tokens.js`, `server/routes/automations.js`,
// `server/routes/cad.js`, `server/routes/ai.js`.

import { Id, NonEmptyString } from "./common.js";

export const TokenCreateBody = {
  type: "object",
  additionalProperties: true,
  properties: {
    name: { type: "string", maxLength: 256 },
    scopes: { type: "array", items: { type: "string", maxLength: 64 }, maxItems: 64 },
    ttlDays: { type: ["integer", "null"], minimum: 0, maximum: 3650 },
  },
};

export const EnterpriseSystemCreateBody = {
  type: "object",
  required: ["name", "category"],
  additionalProperties: true,
  properties: {
    name: NonEmptyString(256),
    category: NonEmptyString(64),
    vendor: { type: ["string", "null"], maxLength: 256 },
    baseUrl: { type: ["string", "null"], maxLength: 2048 },
    authType: { type: "string", maxLength: 64 },
    secretRef: { type: ["string", "null"], maxLength: 1024 },
    capabilities: { type: "array", items: { type: "string", maxLength: 128 }, maxItems: 128 },
    dataResidency: { type: ["string", "null"], maxLength: 64 },
    ownerId: { type: ["string", "null"], maxLength: 64 },
    config: { type: "object", additionalProperties: true },
  },
};

export const EnterpriseSystemPatchBody = {
  type: "object",
  additionalProperties: true,
  properties: {
    name: { type: "string", maxLength: 256 },
    status: { type: "string", maxLength: 64 },
    vendor: { type: ["string", "null"], maxLength: 256 },
    baseUrl: { type: ["string", "null"], maxLength: 2048 },
    authType: { type: "string", maxLength: 64 },
    secretRef: { type: ["string", "null"], maxLength: 1024 },
    capabilities: { type: "array", items: { type: "string", maxLength: 128 }, maxItems: 128 },
    dataResidency: { type: ["string", "null"], maxLength: 64 },
    ownerId: { type: ["string", "null"], maxLength: 64 },
    config: { type: "object", additionalProperties: true },
  },
};

export const EnterpriseSystemSyncBody = {
  // Sync request body is opaque; recordRun() forwards it verbatim
  // into stats.requested. We accept any object so future connectors
  // can extend their knobs without coordinated server changes.
  type: "object",
  additionalProperties: true,
};

export const ExternalLinkCreateBody = {
  type: "object",
  required: ["systemId", "externalKind", "externalId", "forgeKind", "forgeId"],
  additionalProperties: true,
  properties: {
    systemId: Id,
    externalKind: NonEmptyString(64),
    externalId: NonEmptyString(256),
    forgeKind: NonEmptyString(64),
    forgeId: NonEmptyString(64),
    direction: { type: "string", maxLength: 32 },
    metadata: { type: "object", additionalProperties: true },
  },
};

export const AiAskBody = {
  type: "object",
  required: ["prompt"],
  additionalProperties: true,
  properties: {
    prompt: NonEmptyString(8192),
    provider: { type: ["string", "null"], maxLength: 64 },
    scope: { type: "object", additionalProperties: true },
  },
};

export const CadConvertBody = {
  type: "object",
  additionalProperties: true,
  properties: {
    fileId: { type: ["string", "null"], maxLength: 64 },
    target: { type: ["string", "null"], maxLength: 32 },
  },
};

export const CadConvertByUrlBody = {
  type: "object",
  required: ["url"],
  additionalProperties: true,
  properties: {
    url: { type: "string", minLength: 8, maxLength: 4096, pattern: "^https?://" },
    to: { type: "string", maxLength: 32 },
  },
};
