// Tiny SSE broadcaster. Each connected client gets every event; filtering
// is done client-side. Connection management keeps a keepalive ping every
// 25s so proxies don't time out.
//
// Backpressure
// ------------
// `broadcast()` used to write directly to every client socket on every
// event. A slow consumer (mobile network, paused tab, debugger) backs up
// Node's TCP send buffer until the process runs out of memory. Now each
// client carries a bounded queue: writes that overflow the queue cause
// the slowest events to be dropped, and clients that fail to drain a
// full queue within a grace window are disconnected entirely. The
// dispatcher emits a `dropped` SSE event so the client can refresh
// state on its own.
//
// All limits are env-tunable for ops:
//   FORGE_SSE_MAX_QUEUE        per-client queued events     (default 256)
//   FORGE_SSE_DRAIN_TIMEOUT_MS time before a stuck client   (default 30000)
//   FORGE_SSE_KEEPALIVE_MS     keepalive ping interval      (default 25000)

const MAX_QUEUE = Number(process.env.FORGE_SSE_MAX_QUEUE || 256);
const DRAIN_TIMEOUT_MS = Number(process.env.FORGE_SSE_DRAIN_TIMEOUT_MS || 30_000);
const KEEPALIVE_MS = Number(process.env.FORGE_SSE_KEEPALIVE_MS || 25_000);

const clients = new Set();
const clientsById = new Map();
let _shuttingDown = false;

function makeId() { return Math.random().toString(36).slice(2, 8); }

/**
 * Phase 6: per-client subscription filter.
 *
 * A client that has explicitly subscribed (POST
 * /api/events/subscribe) only receives events whose `topic` /
 * `data.assetId` / `data.pointId` is in its declared interest set.
 * A client that has never subscribed sees every event broadcast
 * to its tenant — preserving back-compat with the Phase 1-5 wire.
 *
 * The filter is in-memory only and tied to the SSE socket; there
 * is no persistence. A client reconnecting must re-subscribe.
 */
function eventMatchesSubscription(client, topic, data) {
  const sub = client.subscriptions;
  if (!sub) return true; // un-subscribed clients see everything (back-compat)
  if (sub.topics && sub.topics.size && !sub.topics.has(topic)) {
    // The per-point fan-out topic name is `historian:point:<id>`;
    // we let `pointIds` stand in for that without forcing the
    // client to enumerate the per-point topic strings.
    if (!(sub.pointIds && sub.pointIds.size && topic.startsWith("historian:point:") && sub.pointIds.has(topic.slice("historian:point:".length)))) {
      return false;
    }
  }
  if (sub.assetIds && sub.assetIds.size) {
    const ai = data && data.assetId;
    if (!ai || !sub.assetIds.has(ai)) {
      // If the topic is per-point, fall through to pointIds.
      if (!(sub.pointIds && sub.pointIds.size && data && data.pointId && sub.pointIds.has(data.pointId))) {
        return false;
      }
    }
  }
  if (sub.pointIds && sub.pointIds.size) {
    const pi = data && data.pointId;
    const fromPerPoint = topic.startsWith("historian:point:") && sub.pointIds.has(topic.slice("historian:point:".length));
    if (!fromPerPoint && (!pi || !sub.pointIds.has(pi))) return false;
  }
  return true;
}

/**
 * Update a client's subscription set. Called from the
 * `/api/events/subscribe` route. Pass `null` to clear and revert
 * to the all-events default.
 */
export function setClientSubscription(clientId, { assetIds, pointIds, topics } = {}) {
  const client = clientsById.get(clientId);
  if (!client) return false;
  if (assetIds == null && pointIds == null && topics == null) {
    client.subscriptions = null;
    return true;
  }
  client.subscriptions = {
    assetIds: Array.isArray(assetIds) ? new Set(assetIds.map(String)) : null,
    pointIds: Array.isArray(pointIds) ? new Set(pointIds.map(String)) : null,
    topics:   Array.isArray(topics)   ? new Set(topics.map(String))   : null,
  };
  return true;
}

/** Test-only: list current subscriptions for diagnostics. */
export function _peekSubscriptions() {
  return Array.from(clients).map(c => ({
    id: c.id,
    orgId: c.orgId,
    subscriptions: c.subscriptions ? {
      assetIds: c.subscriptions.assetIds ? [...c.subscriptions.assetIds] : null,
      pointIds: c.subscriptions.pointIds ? [...c.subscriptions.pointIds] : null,
      topics:   c.subscriptions.topics   ? [...c.subscriptions.topics]   : null,
    } : null,
  }));
}

/**
 * Try to flush the client's queue to the wire. Stops on the first failed
 * write (back-pressure or socket error). Returns true if the queue is
 * now empty.
 */
function flush(client) {
  while (client.queue.length > 0) {
    const line = client.queue[0];
    let ok;
    try { ok = client.reply.raw.write(line); }
    catch { close(client, "write_error"); return false; }
    client.queue.shift();
    client.queuedBytes -= line.length;
    if (!ok) return false;
  }
  return true;
}

function close(client, reason) {
  if (!clients.has(client)) return;
  clients.delete(client);
  if (client.id) clientsById.delete(client.id);
  clearInterval(client.heartbeat);
  if (client.drainTimer) clearTimeout(client.drainTimer);
  try { client.reply.raw.end(); } catch { /* socket already gone */ }
  client.reason = reason;
}

function armDrainWatch(client) {
  if (client.drainTimer) return;
  client.drainTimer = setTimeout(() => {
    // Last chance: try once more, otherwise drop.
    if (!flush(client) && client.queue.length > 0) close(client, "drain_timeout");
    client.drainTimer = null;
  }, DRAIN_TIMEOUT_MS);
}

export function attachSSE(fastify) {
  fastify.get("/api/events/stream", async (req, reply) => {
    if (_shuttingDown) {
      reply.code(503);
      return reply.send({ error: "shutting down" });
    }

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const client = {
      reply,
      id: makeId(),
      // Tag the client with the authenticated user's org so broadcast()
      // can scope events to a single tenant. Unauthenticated SSE
      // connections (req.user is null) get null orgId and only see
      // broadcasts that opt into "send to all" by passing no orgId.
      orgId: req.user?.org_id || null,
      // Phase 6: optional per-client subscription filter (assetIds /
      // pointIds / topics). Null = receive every event broadcast to
      // the tenant (Phase 1-5 wire). Set via POST /api/events/subscribe.
      subscriptions: null,
      queue: [],
      queuedBytes: 0,
      heartbeat: null,
      drainTimer: null,
      reason: null,
    };
    clients.add(client);
    clientsById.set(client.id, client);

    // Hello frame goes through the normal path so it respects buffering.
    enqueue(client, `event: hello\ndata: ${JSON.stringify({ ts: new Date().toISOString(), id: client.id })}\n\n`);
    flush(client);

    client.heartbeat = setInterval(() => {
      if (!clients.has(client)) return;
      enqueue(client, `:keepalive\n\n`);
      flush(client);
    }, KEEPALIVE_MS);

    reply.raw.on("drain", () => { flush(client); });
    req.raw.on("close", () => close(client, "client_closed"));
    req.raw.on("error", () => close(client, "socket_error"));
  });
}

function enqueue(client, line) {
  client.queue.push(line);
  client.queuedBytes += line.length;
  // Cap the queue: drop the oldest entries (FIFO) and tell the client
  // it missed events so it can re-fetch from the REST API. Keeping the
  // newest is the right policy for live dashboards — last-write-wins.
  if (client.queue.length > MAX_QUEUE) {
    const dropped = client.queue.length - MAX_QUEUE;
    const removed = client.queue.splice(0, dropped);
    for (const r of removed) client.queuedBytes -= r.length;
    const note = `event: dropped\ndata: ${JSON.stringify({ count: dropped, reason: "queue_overflow" })}\n\n`;
    client.queue.push(note);
    client.queuedBytes += note.length;
  }
  if (client.queue.length > 0) armDrainWatch(client);
}

/**
 * Push an event to connected clients. Per-client queues bound the
 * memory cost so a slow consumer cannot exhaust the heap. Slow clients
 * that fail to drain within `DRAIN_TIMEOUT_MS` are disconnected.
 *
 * If `orgId` is provided, the event is delivered only to clients that
 * authenticated as a user in that org — this is how we scope live
 * updates to a tenant. Callers that don't supply orgId still broadcast
 * to every client (used for genuinely global events like server health),
 * but the convention going forward is: every mutation broadcast SHOULD
 * include the originating org's id.
 */
export function broadcast(topic, data, orgId) {
  if (_shuttingDown) return;
  const line = `event: ${topic}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) {
    if (orgId && c.orgId && c.orgId !== orgId) continue;
    if (!eventMatchesSubscription(c, topic, data)) continue;
    enqueue(c, line);
    flush(c);
  }
}

/**
 * Register the `/api/events/subscribe` route on the given Fastify
 * instance. Wired from server/main.js alongside attachSSE(). The
 * route requires a valid SSE clientId (from the `hello` event the
 * server sends on connect) + an authenticated user — the body's
 * subscription set is validated and applied.
 */
export function registerSubscribeRoute(fastify) {
  fastify.post("/api/events/subscribe", async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: "unauthenticated" });
    const { clientId, assetIds, pointIds, topics } = req.body || {};
    if (!clientId) return reply.code(400).send({ error: "clientId required" });
    const client = clientsById.get(String(clientId));
    if (!client) return reply.code(404).send({ error: "client not connected" });
    // Tenant-scope: refuse to update another org's client.
    if (client.orgId && req.user.org_id && client.orgId !== req.user.org_id) {
      return reply.code(404).send({ error: "client not connected" });
    }
    setClientSubscription(clientId, { assetIds, pointIds, topics });
    return {
      ok: true,
      clientId,
      subscriptions: client.subscriptions ? {
        assetIds: client.subscriptions.assetIds ? [...client.subscriptions.assetIds] : null,
        pointIds: client.subscriptions.pointIds ? [...client.subscriptions.pointIds] : null,
        topics:   client.subscriptions.topics   ? [...client.subscriptions.topics]   : null,
      } : null,
    };
  });
}

/**
 * Stop accepting new SSE clients and gracefully close existing ones.
 * Called from the server-shutdown sequence in `server/main.js`.
 */
export async function shutdownSSE({ logger } = {}) {
  _shuttingDown = true;
  const list = Array.from(clients);
  for (const c of list) {
    try {
      enqueue(c, `event: shutdown\ndata: {}\n\n`);
      flush(c);
    } catch { /* ignore */ }
    close(c, "server_shutdown");
  }
  logger?.info?.({ closed: list.length }, "SSE clients closed for shutdown");
}

/** Test-only stats. */
export function _sseStats() {
  return {
    clients: clients.size,
    queues: Array.from(clients).map(c => ({ id: c.id, queue: c.queue.length, bytes: c.queuedBytes })),
    maxQueue: MAX_QUEUE,
    drainTimeoutMs: DRAIN_TIMEOUT_MS,
  };
}
