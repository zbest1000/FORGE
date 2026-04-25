// Prometheus-compatible metrics endpoint.
// We track minimal but useful counters/gauges:
//   forge_http_requests_total{method,status}
//   forge_http_request_seconds_bucket{le,method,route}
//   forge_events_ingested_total
//   forge_audit_ledger_entries
//   forge_up
//
// Zero deps; Fastify onResponse hook feeds the counters.

import { db } from "./db.js";

const counters = new Map();
const histograms = new Map();
const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

function incCounter(name, labels, by = 1) {
  const key = name + "|" + stringifyLabels(labels);
  counters.set(key, (counters.get(key) || 0) + by);
}
function observeHist(name, labels, value) {
  const key = name + "|" + stringifyLabels(labels);
  let h = histograms.get(key);
  if (!h) { h = { buckets: new Array(BUCKETS.length).fill(0), sum: 0, count: 0 }; histograms.set(key, h); }
  h.sum += value; h.count += 1;
  for (let i = 0; i < BUCKETS.length; i++) if (value <= BUCKETS[i]) h.buckets[i] += 1;
}
function stringifyLabels(labels) {
  if (!labels) return "";
  return Object.keys(labels).sort().map(k => `${k}="${String(labels[k]).replace(/"/g, '\\"')}"`).join(",");
}

// Exported helpers for server-side counters.
export function counter(name, labels, by = 1) { incCounter(name, labels, by); }
export function observe(name, labels, value) { observeHist(name, labels, value); }

export function register(app) {
  app.addHook("onResponse", async (req, reply) => {
    const route = req.routeOptions?.url || req.routerPath || "unknown";
    const method = req.method;
    const status = String(reply.statusCode || 0);
    incCounter("forge_http_requests_total", { method, route, status });
    const elapsed = reply.elapsedTime ? reply.elapsedTime / 1000 : 0;
    observeHist("forge_http_request_seconds", { method, route }, elapsed);
  });

  app.get("/metrics", async (req, reply) => {
    reply.header("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    const lines = [];

    lines.push("# HELP forge_up 1 if the FORGE server is up");
    lines.push("# TYPE forge_up gauge");
    lines.push("forge_up 1");

    lines.push("# HELP forge_audit_ledger_entries Total audit entries in SQLite");
    lines.push("# TYPE forge_audit_ledger_entries gauge");
    const n = db.prepare("SELECT COUNT(*) AS n FROM audit_log").get().n;
    lines.push(`forge_audit_ledger_entries ${n}`);

    lines.push("# HELP forge_events_total Total events ingested");
    lines.push("# TYPE forge_events_total gauge");
    const nev = db.prepare("SELECT COUNT(*) AS n FROM events").get().n;
    lines.push(`forge_events_total ${nev}`);

    lines.push("# HELP forge_http_requests_total HTTP requests");
    lines.push("# TYPE forge_http_requests_total counter");
    for (const [k, v] of counters) {
      const [name, labels] = k.split("|");
      if (name !== "forge_http_requests_total") continue;
      lines.push(`${name}{${labels}} ${v}`);
    }

    lines.push("# HELP forge_http_request_seconds HTTP request latency");
    lines.push("# TYPE forge_http_request_seconds histogram");
    for (const [k, h] of histograms) {
      const [name, labels] = k.split("|");
      if (name !== "forge_http_request_seconds") continue;
      for (let i = 0; i < BUCKETS.length; i++) {
        lines.push(`${name}_bucket{${labels},le="${BUCKETS[i]}"} ${h.buckets[i]}`);
      }
      lines.push(`${name}_bucket{${labels},le="+Inf"} ${h.count}`);
      lines.push(`${name}_sum{${labels}} ${h.sum.toFixed(6)}`);
      lines.push(`${name}_count{${labels}} ${h.count}`);
    }

    return lines.join("\n") + "\n";
  });
}
