// Schemas for `server/routes/asset-profiles.js`.
//
// Body validation runs before any handler logic so handlers can trust
// shape and concentrate on intent. House default `additionalProperties:
// true` so legacy clients that send unknown fields keep working.

import { Id, NonEmptyString } from "./common.js";

const SourceKind = { type: "string", enum: ["mqtt", "opcua", "sql"] };
const Status = { type: "string", enum: ["draft", "active", "archived"] };

// A profile point is the per-data-point definition that lives under a
// profile version. The `sourcePathTemplate` is a Mustache-lite string
// (only `{var}` tokens) — Phase 3's apply-profile flow resolves it
// against the asset's hierarchy variables.
const ProfilePointInput = {
  type: "object",
  required: ["name"],
  additionalProperties: true,
  properties: {
    name: NonEmptyString(128),
    unit: { type: ["string", "null"], maxLength: 32 },
    dataType: { type: "string", maxLength: 32 },
    sourcePathTemplate: { type: "string", maxLength: 512 },
    order: { type: "integer", minimum: 0, maximum: 1_000_000 },
  },
};

// `sourceTemplate` is per-source-kind opaque JSON (mqtt: topic_template,
// opcua: node_template, sql: { table, ts_column, value_column, ... }).
// We accept any object so future kinds extend without coordinated
// schema changes.
const SourceTemplate = { type: "object", additionalProperties: true };

export const ProfileCreateBody = {
  type: "object",
  required: ["name", "sourceKind"],
  additionalProperties: true,
  properties: {
    name: NonEmptyString(256),
    description: { type: ["string", "null"], maxLength: 4096 },
    sourceKind: SourceKind,
    sourceTemplate: SourceTemplate,
    workspaceId: { type: ["string", "null"], maxLength: 64 },
    points: { type: "array", items: ProfilePointInput, maxItems: 500 },
  },
};

// PATCH only updates the profile's metadata (name, description, status).
// To change versioned content (sourceTemplate or points), POST a new
// version via /api/asset-profiles/:id/versions. This is the
// versioning model in the plan: profiles are versioned; bindings pin
// to a `profile_version_id`; upgrades are explicit per-asset or
// fleet-wide. (See plan: assumptions §2.)
export const ProfilePatchBody = {
  type: "object",
  additionalProperties: true,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 256 },
    description: { type: ["string", "null"], maxLength: 4096 },
    status: Status,
  },
};

export const ProfileVersionCreateBody = {
  type: "object",
  required: ["sourceTemplate", "points"],
  additionalProperties: true,
  properties: {
    sourceTemplate: SourceTemplate,
    points: { type: "array", items: ProfilePointInput, minItems: 1, maxItems: 500 },
    notes: { type: ["string", "null"], maxLength: 4096 },
  },
};
