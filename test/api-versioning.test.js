// Verify the `/api/v1/*` versioning shim and the deprecation headers
// applied to legacy `/api/*` requests.

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

test("api versioning shim: /api/v1/health works and /api/health is exempt from deprecation",
  { skip: process.platform === "win32" ? "POSIX-only signal semantics" : false },
  async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-versioning-"));
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
    let stderr = "";
    child.stdout.on("data", () => {});
    child.stderr.on("data", (b) => { stderr += b.toString(); });

    try {
      assert.ok(await waitFor(`http://127.0.0.1:${port}/api/health`),
        `server did not become ready; stderr=${stderr.slice(-400)}`);

      // /api/health is exempt from deprecation warnings — stable
      // monitoring contract.
      const health = await fetch(`http://127.0.0.1:${port}/api/health`);
      assert.equal(health.status, 200);
      assert.equal(health.headers.get("deprecation"), null);

      // /api/v1/health rewrites to the same handler.
      const v1Health = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
      assert.equal(v1Health.status, 200);
      const body = await v1Health.json();
      assert.equal(body.status, "ok");

      // X-Request-Id is surfaced on every response.
      assert.ok(health.headers.get("x-request-id"), "X-Request-Id header missing");

      // /api/auth/login is a non-exempt API route → legacy hits get
      // Deprecation + Link: rel=successor-version.
      const legacyLogin = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "nope@example.com", password: "x" }),
      });
      assert.equal(legacyLogin.headers.get("deprecation"), "true");
      assert.match(
        legacyLogin.headers.get("link") || "",
        /<\/api\/v1\/auth\/login>; rel="successor-version"/,
      );

      // /api/v1/auth/login does NOT carry deprecation.
      const v1Login = await fetch(`http://127.0.0.1:${port}/api/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "nope@example.com", password: "x" }),
      });
      assert.equal(v1Login.headers.get("deprecation"), null);
      // Same business response shape regardless of versioning.
      assert.equal(v1Login.status, legacyLogin.status);
    } finally {
      if (!child.killed) child.kill("SIGKILL");
    }
  });
