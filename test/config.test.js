import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../server/config.js";

test("production config rejects default secrets and wildcard CORS", () => {
  assert.throws(() => loadConfig({ NODE_ENV: "production" }), (err) => {
    assert.equal(err.code, "ERR_FORGE_UNSAFE_CONFIG");
    assert.match(err.message, /FORGE_JWT_SECRET/);
    assert.match(err.message, /FORGE_TENANT_KEY/);
    assert.match(err.message, /FORGE_CORS_ORIGIN/);
    return true;
  });
});

test("strict config accepts explicit enterprise secrets and CORS origins", () => {
  const cfg = loadConfig({
    FORGE_STRICT_CONFIG: "1",
    FORGE_JWT_SECRET: "0123456789abcdef0123456789abcdef",
    FORGE_TENANT_KEY: "abcdef0123456789abcdef0123456789",
    FORGE_CORS_ORIGIN: "https://forge.example.com,https://admin.example.com",
    FORGE_RATELIMIT_MAX: "1200",
  });
  assert.equal(cfg.strict, true);
  assert.deepEqual(cfg.corsOrigin, ["https://forge.example.com", "https://admin.example.com"]);
  assert.equal(cfg.rateLimit.max, 1200);
});

test("development config keeps local defaults usable", () => {
  const cfg = loadConfig({});
  assert.equal(cfg.strict, false);
  assert.equal(cfg.port, 3000);
  assert.equal(cfg.corsOrigin, true);
  assert.ok(cfg.jwtSecret);
});
