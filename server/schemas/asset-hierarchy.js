// Schemas for `server/routes/asset-hierarchy.js` and the asset CRUD
// extensions in `server/routes/core.js`. Body validation runs before any
// handler logic so handlers can trust shape and concentrate on intent.
//
// `additionalProperties: true` is the house default — the existing
// schemas under `server/schemas/` follow the same convention so legacy
// clients that send unknown fields keep working during the rollout.

import { Id, NonEmptyString } from "./common.js";

const Acl = { type: "object", additionalProperties: true };

export const EnterpriseCreateBody = {
  type: "object",
  required: ["name"],
  additionalProperties: true,
  properties: {
    name: NonEmptyString(256),
    description: { type: ["string", "null"], maxLength: 4096 },
    sortOrder: { type: "integer", minimum: 0, maximum: 1_000_000 },
    workspaceId: { type: ["string", "null"], maxLength: 64 },
    acl: Acl,
  },
};

export const EnterprisePatchBody = {
  type: "object",
  additionalProperties: true,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 256 },
    description: { type: ["string", "null"], maxLength: 4096 },
    sortOrder: { type: "integer", minimum: 0, maximum: 1_000_000 },
    acl: Acl,
  },
};

export const LocationCreateBody = {
  type: "object",
  required: ["enterpriseId", "name"],
  additionalProperties: true,
  properties: {
    enterpriseId: Id,
    parentLocationId: { type: ["string", "null"], maxLength: 64 },
    name: NonEmptyString(256),
    kind: { type: ["string", "null"], maxLength: 64 },
    sortOrder: { type: "integer", minimum: 0, maximum: 1_000_000 },
    acl: Acl,
  },
};

export const LocationPatchBody = {
  type: "object",
  additionalProperties: true,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 256 },
    kind: { type: ["string", "null"], maxLength: 64 },
    parentLocationId: { type: ["string", "null"], maxLength: 64 },
    sortOrder: { type: "integer", minimum: 0, maximum: 1_000_000 },
    acl: Acl,
  },
};

// Re-resolve body. Either supply `bindingIds` (whitelist), `skipBindingIds`
// (blacklist), both empty (= all affected bindings), or omit. The handler
// computes the affected set against the post-rename name and only touches
// rows whose template_vars referenced the old name.
export const ReResolveBindingsBody = {
  type: "object",
  additionalProperties: true,
  properties: {
    bindingIds: { type: "array", items: Id, maxItems: 5_000 },
    skipBindingIds: { type: "array", items: Id, maxItems: 5_000 },
  },
};

export const AssetCreateBody = {
  type: "object",
  required: ["name"],
  additionalProperties: true,
  properties: {
    name: NonEmptyString(256),
    type: { type: ["string", "null"], maxLength: 64 },
    enterpriseId: { type: ["string", "null"], maxLength: 64 },
    locationId: { type: ["string", "null"], maxLength: 64 },
    hierarchy: { type: ["string", "null"], maxLength: 1024 },
    workspaceId: { type: ["string", "null"], maxLength: 64 },
    visualFileId: { type: ["string", "null"], maxLength: 64 },
    profileVersionId: { type: ["string", "null"], maxLength: 64 },
    status: { type: "string", maxLength: 64 },
    labels: { type: "array", items: { type: "string", maxLength: 128 }, maxItems: 200 },
    acl: Acl,
  },
};

export const AssetPatchBody = {
  type: "object",
  additionalProperties: true,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 256 },
    type: { type: ["string", "null"], maxLength: 64 },
    enterpriseId: { type: ["string", "null"], maxLength: 64 },
    locationId: { type: ["string", "null"], maxLength: 64 },
    hierarchy: { type: ["string", "null"], maxLength: 1024 },
    visualFileId: { type: ["string", "null"], maxLength: 64 },
    profileVersionId: { type: ["string", "null"], maxLength: 64 },
    status: { type: "string", maxLength: 64 },
    labels: { type: "array", items: { type: "string", maxLength: 128 }, maxItems: 200 },
    acl: Acl,
  },
};
