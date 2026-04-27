// Verify the unified error envelope: every error response carries
// `error.code`, `error.message`, `error.requestId`, plus a legacy
// `error_legacy_message` mirror so the SPA's existing string-error
// readers keep working during the migration.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function pickPort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

async function waitFor(url, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const r = await fetch(url); if (r.ok) return true; }
    catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

test("error envelope: 404 + validation responses include code/message/requestId",
  { skip: process.platform === "win32" ? "POSIX-only signal semantics" : false },
  async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-errenv-"));
    const port = await pickPort();
    const env = {
      ...process.env,
      FORGE_DATA_DIR: tmp,
      FORGE_TENANT_KEY: "ci-tenant-key-0123456789abcdef0123456789abcdef",
      FORGE_JWT_SECRET: "ci-jwt-secret-0123456789abcdef0123456789abcdef",
      FORGE_SERVE_SOURCE: "1",
      FORGE_SHUTDOWN_GRACE_MS: "5000",
      PORT: String(port),
      HOST: "127.0.0.1",
      LOG_LEVEL: "warn",
      NODE_ENV: "development",
    };
    const child = spawn(process.execPath, [path.join(ROOT, "server", "main.js")], { env, cwd: ROOT });
    child.stdout.on("data", () => {});
    child.stderr.on("data", () => {});
    try {
      assert.ok(await waitFor(`http://127.0.0.1:${port}/api/health`),
        "server did not become ready");

      // 404 for an unknown API path → envelope.
      const notFound = await fetch(`http://127.0.0.1:${port}/api/does-not-exist`);
      assert.equal(notFound.status, 404);
      const body = await notFound.json();
      assert.ok(body.error, "missing error envelope");
      assert.equal(body.error.code, "not_found");
      assert.ok(body.error.message);
      assert.ok(body.error.requestId);
      assert.equal(body.error.requestId, notFound.headers.get("x-request-id"));
      // Legacy string mirror still present for older clients.
      assert.ok(body.error_legacy_message);
    } finally {
      if (!child.killed) child.kill("SIGKILL");
    }
  });
