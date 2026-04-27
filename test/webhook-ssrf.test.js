// Tests for webhook SSRF guard.
// The webhooks module imports `db` so we need a temp data dir like the
// other route tests.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-webhooks-"));
process.env.FORGE_DATA_DIR = tmpDir;
process.env.FORGE_TENANT_KEY = "forge-webhook-test-0123456789abcdef0123456789abcdef";
process.env.FORGE_JWT_SECRET = "forge-webhook-test-jwt-0123456789abcdef0123456789abcdef";
process.env.LOG_LEVEL = "warn";

const { createWebhook } = await import("../server/webhooks.js");

test("createWebhook rejects loopback URL", () => {
  assert.throws(() => createWebhook({ name: "bad", url: "http://127.0.0.1:9999/hook" }), /private_ip/);
});

test("createWebhook rejects link-local cloud metadata URL", () => {
  assert.throws(() => createWebhook({ name: "bad", url: "http://169.254.169.254/latest/meta-data/" }), /private_ip/);
});

test("createWebhook rejects localhost hostname", () => {
  assert.throws(() => createWebhook({ name: "bad", url: "http://localhost:8080/x" }), /internal_host/);
});

test("createWebhook accepts public https URL", () => {
  const wh = createWebhook({ name: "ok", url: "https://example.com/hook" });
  assert.ok(wh.id);
  assert.equal(wh.url, "https://example.com/hook");
});
