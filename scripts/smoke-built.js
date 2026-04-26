#!/usr/bin/env node

import { spawn } from "node:child_process";

const port = String(process.env.PORT || 3100);
const env = {
  ...process.env,
  NODE_ENV: "production",
  PORT: port,
  FORGE_JWT_SECRET: process.env.FORGE_JWT_SECRET || "smoke-jwt-secret-0123456789abcdef",
  FORGE_TENANT_KEY: process.env.FORGE_TENANT_KEY || "smoke-tenant-key-0123456789abcdef",
  FORGE_CORS_ORIGIN: process.env.FORGE_CORS_ORIGIN || `http://127.0.0.1:${port}`,
};

const server = spawn(process.execPath, ["server/main.js"], {
  env,
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
server.stdout.on("data", d => { output += d.toString(); });
server.stderr.on("data", d => { output += d.toString(); });

function stop(code) {
  server.kill("SIGTERM");
  setTimeout(() => process.exit(code), 250);
}

async function waitForHealth() {
  const url = `http://127.0.0.1:${port}/api/health`;
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // retry
    }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`server did not become healthy on ${url}\n${output}`);
}

try {
  await waitForHealth();
  const html = await fetch(`http://127.0.0.1:${port}/`).then(r => r.text());
  if (!html.includes("/assets/")) {
    throw new Error("root HTML did not reference built /assets/ bundle");
  }
  if (html.includes("/src/") || html.includes('src="app.js"')) {
    throw new Error("root HTML appears to serve source modules, not the built SPA");
  }
  console.log(`built server smoke ok on :${port}`);
  stop(0);
} catch (err) {
  console.error(err?.stack || err);
  stop(1);
}
