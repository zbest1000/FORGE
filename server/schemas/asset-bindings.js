// Schemas for `server/routes/asset-bindings.js`.

import { Id, NonEmptyString } from "./common.js";

const SourceKind = { type: "string", enum: ["mqtt", "opcua", "sql"] };
const SqlMode = { type: "string", enum: ["schema_defined", "free_form"] };

const TemplateVars = { type: "object", additionalProperties: { type: ["string", "number", "boolean", "null"] } };

const CustomMappingItem = {
  type: "object",
  required: ["pointName", "sourceSystemId", "sourcePath"],
  additionalProperties: true,
  properties: {
    pointName: NonEmptyString(128),
    unit: { type: ["string", "null"], maxLength: 32 },
    dataType: { type: "string", maxLength: 32 },
    sourceKind: SourceKind,
    sourceSystemId: Id,
    sourcePath: NonEmptyString(1024),
    // Free-form SQL only — the per-point query template that
    // `server/security/sql-validator.js` validated. Schema-defined
    // mode leaves this null and relies on the bound system's
    // source_template + binding source_path.
    queryTemplate: { type: ["string", "null"], maxLength: 8192 },
    sqlMode: { type: ["string", "null"], enum: ["schema_defined", "free_form", null] },
  },
};

export const ApplyProfileBody = {
  type: "object",
  required: ["profileVersionId", "sourceSystemId"],
  additionalProperties: true,
  properties: {
    profileVersionId: Id,
    sourceSystemId: Id,
    hierarchy: TemplateVars,
    overrides: {
      type: "array",
      maxItems: 500,
      items: {
        type: "object",
        additionalProperties: true,
        properties: {
          profilePointId: Id,
          sourcePath: { type: "string", maxLength: 1024 },
          queryTemplate: { type: ["string", "null"], maxLength: 8192 },
        },
      },
    },
    sqlMode: SqlMode, // applies to sql profiles; ignored otherwise
  },
};

export const CustomMappingBody = {
  type: "object",
  required: ["mappings"],
  additionalProperties: true,
  properties: {
    mappings: { type: "array", items: CustomMappingItem, minItems: 1, maxItems: 500 },
  },
};

export const BindingTestBody = {
  // Body is opaque (depends on source kind). Phase 3 supports the
  // SQL-mode dry-run; Phase 4/5 extend.
  type: "object",
  additionalProperties: true,
};
