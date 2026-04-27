// Core domain schemas — work-items, messages, revisions, approvals.

import { Id, NonEmptyString } from "./common.js";

const Severity = { type: "string", enum: ["low", "medium", "high", "critical"] };
const RevisionStatus = { type: "string", enum: ["Draft", "IFR", "IFA", "Approved", "IFC", "Superseded", "Withdrawn"] };
const ApprovalOutcome = { type: "string", enum: ["approved", "rejected"] };

export const WorkItemCreateBody = {
  type: "object",
  required: ["projectId", "title"],
  additionalProperties: true,
  properties: {
    projectId: Id,
    type: { type: "string", maxLength: 64 },
    title: NonEmptyString(512),
    severity: Severity,
    assigneeId: { type: ["string", "null"], maxLength: 64 },
    due: { type: ["string", "null"] },
  },
};

export const WorkItemPatchBody = {
  type: "object",
  additionalProperties: true,
  properties: {
    title: { type: "string", maxLength: 512 },
    description: { type: ["string", "null"], maxLength: 16384 },
    assignee_id: { type: ["string", "null"], maxLength: 64 },
    status: { type: "string", maxLength: 64 },
    severity: Severity,
    due: { type: ["string", "null"] },
    blockers: { type: "array", items: { type: "string", maxLength: 256 }, maxItems: 200 },
    labels: { type: "array", items: { type: "string", maxLength: 128 }, maxItems: 200 },
  },
};

export const MessagePostBody = {
  type: "object",
  required: ["text"],
  additionalProperties: true,
  properties: {
    text: NonEmptyString(16384),
    type: { type: "string", maxLength: 64 },
    attachments: { type: "array", maxItems: 50 },
  },
};

export const RevisionTransitionBody = {
  type: "object",
  required: ["to"],
  additionalProperties: true,
  properties: {
    to: RevisionStatus,
    notes: { type: "string", maxLength: 4096 },
  },
};

export const ApprovalDecideBody = {
  type: "object",
  required: ["outcome"],
  additionalProperties: true,
  properties: {
    outcome: ApprovalOutcome,
    notes: { type: "string", maxLength: 4096 },
  },
};
