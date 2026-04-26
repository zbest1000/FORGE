// Graceful-shutdown test.
//
// Boots the actual `server/main.js` as a child process with a temp
// data dir, hits /api/health to confirm the server is up, sends
// SIGTERM, then asserts:
//   - the process exits with code 0 inside the configured grace period
//   - the audit ledger contains a `server.stop` entry (proving the
//     audit drain ran before exit)
//
// This is a P1 acceptance test for B.5 #1: previously the shutdown
// sequence called `process.exit(0)` immediately so background workers
// and the audit hash queue were torn down mid-flight.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
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
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

test("SIGTERM triggers a graceful shutdown that drains the audit queue", async () => {
  // Build is required only when the server boots in production mode;
  // we set FORGE_SERVE_SOURCE=1 so the test doesn't depend on `dist/`.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-shutdown-"));
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
    LOG_LEVEL: "info",
    NODE_ENV: "development",
  };
  const child = spawn(process.execPath, [path.join(ROOT, "server", "main.js")], { env, cwd: ROOT });

  let stderr = "";
  child.stdout.on("data", (b) => { /* drain */ });
  child.stderr.on("data", (b) => { stderr += b.toString(); });

  try {
    assert.ok(await waitFor(`http://127.0.0.1:${port}/api/health`),
      `server did not become ready on port ${port}; stderr=${stderr.slice(-400)}`);

    const exited = new Promise((resolve) => child.on("exit", (code, sig) => resolve({ code, sig })));
    const startedAt = Date.now();
    child.kill("SIGTERM");
    const result = await exited;
    const elapsed = Date.now() - startedAt;
    assert.equal(result.code, 0, `expected clean exit, got ${result.code}; tail=${stderr.slice(-400)}`);
    assert.ok(elapsed < 8000, `shutdown should be quick, took ${elapsed}ms`);

    // After exit, open the SQLite DB directly and look for the
    // `server.stop` audit row — that proves the audit hash queue was
    // drained before the process called process.exit(0).
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(path.join(tmp, "forge.db"), { readonly: true });
    const row = db.prepare("SELECT id, action, detail FROM audit_log WHERE action = 'server.stop' ORDER BY seq DESC LIMIT 1").get();
    db.close();
    assert.ok(row, "audit_log should contain a server.stop entry after graceful shutdown");
    const detail = JSON.parse(row.detail);
    assert.equal(detail.sig, "SIGTERM");
  } finally {
    if (!child.killed) child.kill("SIGKILL");
  }
});
