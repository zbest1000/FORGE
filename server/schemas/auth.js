// Auth route schemas — login, refresh, MFA challenge.
//
// Tight enough to reject obvious garbage but lenient on extras so
// future fields (`mfaCode`, `recoveryCode`, `device_id`, …) can roll
// out without coordinated client changes.

import { Email, Id, NonEmptyString } from "./common.js";

export const LoginBody = {
  type: "object",
  required: ["email", "password"],
  additionalProperties: true,
  properties: {
    email: Email,
    password: NonEmptyString(512),
    mfaCode: { type: "string", minLength: 1, maxLength: 64 },
    recoveryCode: { type: "string", minLength: 1, maxLength: 64 },
  },
};

export const MfaVerifyBody = {
  type: "object",
  required: ["challenge"],
  additionalProperties: true,
  properties: {
    challenge: { type: "string", minLength: 1, maxLength: 1024 },
    mfaCode: { type: "string", minLength: 1, maxLength: 64 },
    recoveryCode: { type: "string", minLength: 1, maxLength: 64 },
  },
};

export const RefreshBody = {
  type: "object",
  required: ["refreshToken"],
  additionalProperties: true,
  properties: {
    refreshToken: { type: "string", minLength: 1, maxLength: 4096 },
  },
};

export const MfaCodeOnly = {
  type: "object",
  additionalProperties: true,
  properties: {
    code: { type: "string", minLength: 1, maxLength: 64 },
  },
};
