// Schemas for routes registered in `server/routes/extras.js`:
// review cycles, form submissions, commissioning checklists,
// RFI link graph, saved-search alerts, drawing ingest, model pins.

import { Id, NonEmptyString } from "./common.js";

export const ReviewCycleCreateBody = {
  type: "object",
  required: ["docId", "revId", "name"],
  additionalProperties: true,
  properties: {
    docId: Id,
    revId: Id,
    name: NonEmptyString(256),
    reviewers: { type: "array", items: { type: "string", maxLength: 64 }, maxItems: 200 },
    dueTs: { type: ["string", "null"] },
    notes: { type: ["string", "null"], maxLength: 16384 },
  },
};

export const FormSubmissionBody = {
  type: "object",
  required: ["formId"],
  additionalProperties: true,
  properties: {
    formId: NonEmptyString(128),
    parentKind: { type: ["string", "null"], maxLength: 64 },
    parentId: { type: ["string", "null"], maxLength: 64 },
    answers: { type: "object", additionalProperties: true },
  },
};

export const CommissioningCreateBody = {
  type: "object",
  required: ["name", "projectId"],
  additionalProperties: true,
  properties: {
    name: NonEmptyString(256),
    projectId: Id,
    system: { type: ["string", "null"], maxLength: 256 },
    panel: { type: ["string", "null"], maxLength: 256 },
    package: { type: ["string", "null"], maxLength: 256 },
    items: { type: "array", maxItems: 1000 },
  },
};

export const CommissioningCheckBody = {
  type: "object",
  required: ["index"],
  additionalProperties: true,
  properties: {
    index: { type: ["integer", "string"] },
    checked: { type: "boolean" },
  },
};

export const RfiLinkBody = {
  type: "object",
  required: ["targetKind", "targetId"],
  additionalProperties: true,
  properties: {
    targetKind: NonEmptyString(64),
    targetId: NonEmptyString(64),
    relation: { type: "string", maxLength: 64 },
  },
};

export const SearchAlertCreateBody = {
  type: "object",
  required: ["name", "query"],
  additionalProperties: true,
  properties: {
    name: NonEmptyString(256),
    query: NonEmptyString(1024),
  },
};

export const DrawingIngestBody = {
  type: "object",
  required: ["fileId"],
  additionalProperties: true,
  properties: {
    fileId: Id,
    reviewerId: { type: ["string", "null"], maxLength: 64 },
  },
};

export const ModelPinCreateBody = {
  type: "object",
  required: ["drawingId", "elementId", "text"],
  additionalProperties: true,
  properties: {
    drawingId: Id,
    elementId: NonEmptyString(256),
    text: NonEmptyString(4096),
  },
};
