// Prometheus metrics. Replaces the hand-rolled exposition format with the
// industry-standard `prom-client` (MIT). Spec §18 observability.
//
// Default registry collects Node process metrics (CPU, memory, GC,
// event loop lag). On top of that we register a few FORGE-specific
// counters/histograms/gauges and refresh the SQLite-backed gauges
// on every scrape via `collect()` callbacks.

import { register, Registry, collectDefaultMetrics, Counter, Histogram, Gauge } from "prom-client";
import { db } from "./db.js";

// Use the default registry so prom-client's process metrics ship with us.
collectDefaultMetrics({ register, prefix: "forge_node_" });

const httpRequests = new Counter({
  name: "forge_http_requests_total",
  help: "HTTP requests by method, route, status",
  labelNames: ["method", "route", "status"],
  registers: [register],
});

const httpDuration = new Histogram({
  name: "forge_http_request_seconds",
  help: "HTTP request latency in seconds",
  labelNames: ["method", "route"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

// SQLite-backed gauges are recomputed at scrape-time so the value is
// always fresh without a polling loop.
new Gauge({
  name: "forge_audit_ledger_entries",
  help: "Total audit entries in SQLite",
  registers: [register],
  collect() {
    try { this.set(db.prepare("SELECT COUNT(*) AS n FROM audit_log").get().n); }
    catch { this.set(0); }
  },
});

new Gauge({
  name: "forge_events_total",
  help: "Total events ingested",
  registers: [register],
  collect() {
    try { this.set(db.prepare("SELECT COUNT(*) AS n FROM events").get().n); }
    catch { this.set(0); }
  },
});

new Gauge({
  name: "forge_dlq_open",
  help: "Open dead-letter envelopes",
  registers: [register],
  collect() {
    try { this.set(db.prepare("SELECT COUNT(*) AS n FROM dead_letters WHERE resolved = 0").get().n); }
    catch { this.set(0); }
  },
});

new Gauge({
  name: "forge_up",
  help: "1 if the FORGE server is up",
  registers: [register],
  collect() { this.set(1); },
});

// Convenience helpers used by other modules (e.g. job queue counters).
export function counter(name, help, labelNames = []) {
  return new Counter({ name, help, labelNames, registers: [register] });
}
export function gauge(name, help, labelNames = []) {
  return new Gauge({ name, help, labelNames, registers: [register] });
}

export function register_(app) {
  app.addHook("onResponse", async (req, reply) => {
    const route = req.routeOptions?.url || req.routerPath || "unknown";
    httpRequests.inc({ method: req.method, route, status: String(reply.statusCode || 0) });
    const elapsed = reply.elapsedTime ? reply.elapsedTime / 1000 : 0;
    httpDuration.observe({ method: req.method, route }, elapsed);
  });

  app.get("/metrics", async (req, reply) => {
    reply.header("Content-Type", register.contentType);
    return register.metrics();
  });
}
