// SSE per-tag/asset subscription filter — Phase 6.
//
// A client opens /api/events/stream, reads the `hello` event to
// learn its server-assigned id, then POSTs /api/events/subscribe
// to declare interest in {assetIds, pointIds, topics}. The server
// must:
//   - reject without auth (401)
//   - reject unknown clientId (404)
//   - apply the filter — only subsequent broadcasts whose
//     topic / data.assetId / data.pointId match are dequeued onto
//     the wire
//   - back-compat: a client that never POSTs /subscribe still sees
//     every broadcast in its tenant
//
// We use Node's stream APIs to read the SSE response progressively
// rather than awaiting the body to completion (which never returns
// for SSE).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sse-sub-"));
process.env.FORGE_DATA_DIR = tmpDir;
process.env.FORGE_TENANT_KEY = "forge-sse-sub-test";
process.env.FORGE_JWT_SECRET = "forge-sse-sub-test-jwt";
process.env.FORGE_RATELIMIT_MAX = "10000";
process.env.LOG_LEVEL = "warn";

const { db } = await import("../server/db.js");
const bcrypt = (await import("bcryptjs")).default;
const ts = new Date().toISOString();
db.prepare("INSERT INTO organizations (id, name, tenant_key, created_at) VALUES ('ORG-A','Atlas','atlas',?)").run(ts);
db.prepare("INSERT INTO workspaces (id, org_id, name, region, created_at) VALUES ('WS-A','ORG-A','North','us-east',?)").run(ts);
db.prepare("INSERT INTO users (id, org_id, email, name, role, password_hash, initials, disabled, created_at, updated_at) VALUES ('U-1','ORG-A','admin@forge.local','Admin','Organization Owner',?,'AD',0,?,?)")
  .run(await bcrypt.hash("forge", 10), ts, ts);

const { default: Fastify } = await import("fastify");
const { default: jwt } = await import("@fastify/jwt");
const { default: cors } = await import("@fastify/cors");
const { userById } = await import("../server/auth.js");
const { attachSSE, registerSubscribeRoute, broadcast } = await import("../server/sse.js");

const app = Fastify({ logger: false });
await app.register(cors, { origin: true });
await app.register(jwt, { secret: process.env.FORGE_JWT_SECRET });

app.addHook("onRequest", async (req) => {
  // Re-implement just enough of server/main.js's auth resolution for
  // this isolated test to recognise both Bearer and ?token= auth on
  // SSE streams.
  const h = req.headers.authorization || "";
  let tok = h.startsWith("Bearer ") ? h.slice(7) : null;
  const reqPath = (req.url || "").split("?")[0];
  if (!tok && reqPath === "/api/events/stream" && req.query?.token) tok = String(req.query.token);
  req.user = null;
  if (!tok) return;
  try {
    const d = app.jwt.verify(tok);
    if (!d?.sub) return;
    req.user = userById(d.sub);
  } catch { /* swallow */ }
});

await app.register((await import("../server/routes/auth.js")).default);
attachSSE(app);
registerSubscribeRoute(app);

await app.listen({ port: 0, host: "127.0.0.1" });
const addr = app.server.address();
const base = `http://127.0.0.1:${addr.port}`;

// Login + grab a token.
const loginR = await fetch(base + "/api/auth/login", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "admin@forge.local", password: "forge" }),
});
const TOKEN = (await loginR.json()).token;

// Helper: open an SSE connection via raw http.request so we can
// stream + parse events without depending on a browser EventSource.
function openSSE(token) {
  return new Promise((resolve) => {
    const url = new URL(base + "/api/events/stream" + (token ? `?token=${encodeURIComponent(token)}` : ""));
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: "GET",
      headers: { Accept: "text/event-stream" },
    }, (res) => {
      const events = [];
      let buffer = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        buffer += chunk;
        let idx;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          let event = "message";
          let data = "";
          for (const line of block.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data = (data ? data + "\n" : "") + line.slice(5).trim();
          }
          if (data) {
            try { events.push({ event, data: JSON.parse(data) }); }
            catch { events.push({ event, data }); }
          }
        }
      });
      resolve({ res, events, close: () => req.destroy() });
    });
    req.end();
  });
}

async function waitForEvent(es, predicate, maxMs = 1500) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const found = es.events.find(predicate);
    if (found) return found;
    await new Promise(r => setTimeout(r, 25));
  }
  return null;
}

let es;
let CLIENT_ID;

test.after(async () => {
  try { es?.close(); } catch {}
  await app.close();
});

test("SSE connect + hello frame returns a clientId", async () => {
  es = await openSSE(TOKEN);
  const hello = await waitForEvent(es, e => e.event === "hello");
  assert.ok(hello, "hello frame received");
  assert.ok(hello.data.id, "hello carries a clientId");
  CLIENT_ID = hello.data.id;
});

test("subscribe rejects without auth", async () => {
  const r = await fetch(base + "/api/events/subscribe", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId: CLIENT_ID, assetIds: ["AS-1"] }),
  });
  assert.equal(r.status, 401);
});

test("subscribe rejects unknown clientId with 404", async () => {
  const r = await fetch(base + "/api/events/subscribe", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ clientId: "nonexistent", assetIds: ["AS-1"] }),
  });
  assert.equal(r.status, 404);
});

test("after subscribe filter, only matching broadcasts dequeue", async () => {
  // Subscribe to assetId AS-MATCH only.
  const r = await fetch(base + "/api/events/subscribe", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ clientId: CLIENT_ID, assetIds: ["AS-MATCH"] }),
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.deepEqual(body.subscriptions.assetIds, ["AS-MATCH"]);

  // Snapshot count of seen events before broadcasts.
  const before = es.events.length;
  // Broadcast two events: one matching, one not. Both org-scoped to
  // ORG-A so the org gate doesn't drop them.
  broadcast("historian", { assetId: "AS-MATCH", pointId: "HP-1", value: 1 }, "ORG-A");
  broadcast("historian", { assetId: "AS-OTHER", pointId: "HP-2", value: 2 }, "ORG-A");
  await new Promise(r => setTimeout(r, 100));

  const newEvents = es.events.slice(before).filter(e => e.event === "historian");
  assert.equal(newEvents.length, 1, "only one of the two broadcasts dequeued");
  assert.equal(newEvents[0].data.assetId, "AS-MATCH");
});

test("topic-only subscription delivers exact topic matches", async () => {
  await fetch(base + "/api/events/subscribe", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ clientId: CLIENT_ID, topics: ["asset-hierarchy"] }),
  });
  const before = es.events.length;
  broadcast("asset-hierarchy", { kind: "ping" }, "ORG-A");
  broadcast("historian", { assetId: "AS-MATCH" }, "ORG-A");
  await new Promise(r => setTimeout(r, 100));
  const newEvents = es.events.slice(before);
  // The hierarchy event passed; the historian event was filtered out.
  assert.ok(newEvents.find(e => e.event === "asset-hierarchy"));
  assert.equal(newEvents.find(e => e.event === "historian"), undefined);
});

test("clearing the subscription reverts to all-events default", async () => {
  await fetch(base + "/api/events/subscribe", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ clientId: CLIENT_ID }), // null subs
  });
  const before = es.events.length;
  broadcast("historian", { assetId: "AS-FREE", pointId: "HP-Z", value: 99 }, "ORG-A");
  await new Promise(r => setTimeout(r, 100));
  const newEvents = es.events.slice(before).filter(e => e.event === "historian");
  assert.equal(newEvents.length, 1, "after clear, all-events default delivers everything in tenant");
});

test("a second never-subscribed client receives all events (back-compat)", async () => {
  const es2 = await openSSE(TOKEN);
  await waitForEvent(es2, e => e.event === "hello");
  const before = es2.events.length;
  broadcast("historian", { assetId: "AS-X", pointId: "HP-X", value: 1 }, "ORG-A");
  broadcast("historian", { assetId: "AS-Y", pointId: "HP-Y", value: 2 }, "ORG-A");
  await new Promise(r => setTimeout(r, 100));
  const newEvents = es2.events.slice(before).filter(e => e.event === "historian");
  assert.equal(newEvents.length, 2, "un-subscribed client sees both broadcasts");
  es2.close();
});

test("per-point subscription matches historian:point:<id> broadcast", async () => {
  await fetch(base + "/api/events/subscribe", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ clientId: CLIENT_ID, pointIds: ["HP-INTERESTING"] }),
  });
  const before = es.events.length;
  broadcast("historian:point:HP-INTERESTING", { value: 12 }, "ORG-A");
  broadcast("historian:point:HP-IGNORED", { value: 13 }, "ORG-A");
  await new Promise(r => setTimeout(r, 100));
  const newEvents = es.events.slice(before);
  assert.ok(newEvents.find(e => e.event === "historian:point:HP-INTERESTING"));
  assert.equal(newEvents.find(e => e.event === "historian:point:HP-IGNORED"), undefined);
});
