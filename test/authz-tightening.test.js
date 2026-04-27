// Regression coverage for the B.3 capability separations:
//
// - `webhook.write` separates outbound-webhook mutation from
//   `admin.view`. A read-only auditor cannot create/delete webhooks.
// - `admin.edit` gates compliance writes; `admin.view` keeps reads.
// - `integration.write` gates `/api/events/ingest`.
//
// These all depend on the route-level `require_(...)` plumbing.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-authz-"));
process.env.FORGE_DATA_DIR = tmpDir;
process.env.FORGE_TENANT_KEY = "forge-authz-test";
process.env.FORGE_JWT_SECRET = "forge-authz-test-jwt";
process.env.FORGE_RATELIMIT_MAX = "10000";
process.env.LOG_LEVEL = "warn";

const { db } = await import("../server/db.js");
const { CAPABILITIES } = await import("../server/auth.js");

test("Viewer/Auditor lacks admin.edit and webhook.write", () => {
  const caps = CAPABILITIES["Viewer/Auditor"];
  assert.ok(caps.includes("admin.view"), "auditor should keep admin.view (read)");
  assert.ok(!caps.includes("admin.edit"), "auditor must not have admin.edit");
  assert.ok(!caps.includes("webhook.write"), "auditor must not have webhook.write");
});

test("Workspace Admin gains admin.edit and webhook.write", () => {
  const caps = CAPABILITIES["Workspace Admin"];
  assert.ok(caps.includes("admin.edit"));
  assert.ok(caps.includes("webhook.write"));
  assert.ok(caps.includes("integration.write"));
});

test("Engineer/Contributor cannot ingest events", () => {
  const caps = CAPABILITIES["Engineer/Contributor"];
  assert.ok(!caps.includes("integration.write"));
});

test("Organization Owner retains the wildcard", () => {
  assert.deepEqual(CAPABILITIES["Organization Owner"], ["*"]);
});
