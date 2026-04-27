// Compliance route schemas — ROPA, DSAR, legal holds, evidence,
// subprocessors, risks, AI systems, regulatory incidents.

import { Id, NonEmptyString, Iso8601 } from "./common.js";

const Status = { type: "string", maxLength: 64 };
const Severity = { type: "string", maxLength: 64 };
const Kind = { type: "string", maxLength: 128 };

export const RopaCreateBody = {
  type: "object",
  required: ["name", "purpose", "lawfulBasis"],
  additionalProperties: true,
  properties: {
    name: NonEmptyString(256),
    purpose: NonEmptyString(2048),
    lawfulBasis: NonEmptyString(256),
    dataCategories: { type: "array", items: { type: "string", maxLength: 256 }, maxItems: 200 },
    subjectCategories: { type: "array", items: { type: "string", maxLength: 256 }, maxItems: 200 },
    recipients: { type: "array", items: { type: "string", maxLength: 256 }, maxItems: 200 },
    retention: { type: ["string", "null"], maxLength: 256 },
    region: { type: ["string", "null"], maxLength: 64 },
    systems: { type: "array", maxItems: 200 },
  },
};

export const DsarCreateBody = {
  type: "object",
  required: ["subjectUserId"],
  additionalProperties: true,
  properties: {
    subjectUserId: { type: "string", minLength: 1, maxLength: 256 },
    requestType: { type: "string", maxLength: 64 },
    dueAt: { type: ["string", "null"] },
    scope: { type: "object", additionalProperties: true },
  },
};

export const LegalHoldCreateBody = {
  type: "object",
  required: ["name", "scope", "reason"],
  additionalProperties: true,
  properties: {
    name: NonEmptyString(256),
    scope: NonEmptyString(64),
    reason: NonEmptyString(4096),
    objectRefs: { type: "array", maxItems: 1000 },
    objectIds: { type: ["array", "null"], items: Id, maxItems: 1000 },
    expiresAt: { type: ["string", "null"] },
  },
};

export const LegalHoldPatchBody = {
  type: "object",
  additionalProperties: true,
  properties: { status: Status },
};

export const EvidenceCreateBody = {
  type: "object",
  required: ["framework", "controlId", "title"],
  additionalProperties: true,
  properties: {
    framework: NonEmptyString(64),
    controlId: NonEmptyString(64),
    title: NonEmptyString(256),
    description: { type: "string", maxLength: 16384 },
    objectRefs: { type: "array", maxItems: 200 },
    owner: { type: ["string", "null"], maxLength: 256 },
    reviewAt: { type: ["string", "null"] },
    evidenceUri: { type: ["string", "null"], maxLength: 2048 },
  },
};

export const SubprocessorCreateBody = {
  type: "object",
  required: ["name", "purpose", "region"],
  additionalProperties: true,
  properties: {
    name: NonEmptyString(256),
    purpose: NonEmptyString(2048),
    region: NonEmptyString(64),
    dataCategories: { type: "array", items: { type: "string", maxLength: 256 }, maxItems: 200 },
    transferMechanism: { type: ["string", "null"], maxLength: 256 },
    risk: Severity,
    dpaUrl: { type: ["string", "null"], maxLength: 2048 },
  },
};

export const SubprocessorPatchBody = {
  type: "object",
  additionalProperties: true,
  properties: { status: Status, risk: Severity },
};

export const RiskCreateBody = {
  type: "object",
  required: ["title"],
  additionalProperties: true,
  properties: {
    title: NonEmptyString(256),
    framework: { type: "string", maxLength: 64 },
    severity: Severity,
    likelihood: Severity,
    mitigation: { type: "string", maxLength: 16384 },
    owner: { type: ["string", "null"], maxLength: 256 },
    status: Status,
    category: Kind,
  },
};

export const RiskPatchBody = {
  type: "object",
  additionalProperties: true,
  properties: { status: Status, mitigation: { type: "string", maxLength: 16384 } },
};

export const AiSystemCreateBody = {
  type: "object",
  required: ["name", "provider", "purpose"],
  additionalProperties: true,
  properties: {
    name: NonEmptyString(256),
    provider: NonEmptyString(256),
    model: { type: ["string", "null"], maxLength: 256 },
    purpose: NonEmptyString(2048),
    riskClass: { type: "string", maxLength: 64 },
    riskTier: { type: "string", maxLength: 64 },
    dataCategories: { type: "array", items: { type: "string", maxLength: 256 }, maxItems: 200 },
    humanOversight: { type: "string", maxLength: 4096 },
    evaluation: { type: "string", maxLength: 16384 },
    status: Status,
  },
};

export const RegulatoryReportBody = {
  type: "object",
  additionalProperties: true,
  properties: {
    framework: { type: "string", maxLength: 64 },
    authority: { type: ["string", "null"], maxLength: 256 },
    summary: { type: "string", maxLength: 16384 },
    reportDueAt: { type: ["string", "null"] },
  },
};
