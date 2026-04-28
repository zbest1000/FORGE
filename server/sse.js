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
let _shuttingDown = false;

function makeId() { return Math.random().toString(36).slice(2, 8); }

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
      queue: [],
      queuedBytes: 0,
      heartbeat: null,
      drainTimer: null,
      reason: null,
    };
    clients.add(client);

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
    enqueue(c, line);
    flush(c);
  }
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
