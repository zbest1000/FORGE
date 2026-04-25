// Tiny SSE broadcaster. Each connected client gets every event; filtering is
// done client-side. Connection management keeps a keepalive ping every 25s
// so proxies don't time out.

const clients = new Set();

export function attachSSE(fastify) {
  fastify.get("/api/events/stream", async (req, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const client = { reply, id: Math.random().toString(36).slice(2, 8) };
    clients.add(client);
    reply.raw.write(`event: hello\ndata: ${JSON.stringify({ ts: new Date().toISOString(), id: client.id })}\n\n`);

    const heartbeat = setInterval(() => {
      try { reply.raw.write(`:keepalive\n\n`); } catch { /* ignore */ }
    }, 25_000);

    req.raw.on("close", () => { clients.delete(client); clearInterval(heartbeat); });
  });
}

export function broadcast(topic, data) {
  const line = `event: ${topic}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) {
    try { c.reply.raw.write(line); } catch { clients.delete(c); }
  }
}
