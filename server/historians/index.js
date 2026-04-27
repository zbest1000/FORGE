// Pluggable historian backends.
//
// SQLite is always the local cache and default historian. External backends
// are optional and configured via env vars; when absent, routes keep the
// local cache usable and report the backend as unconfigured.

import { db, jsonOrDefault, now, uuid } from "../db.js";

const BACKEND_ALIASES = new Map([
  ["sqlite", "sqlite"],
  ["local", "sqlite"],
  ["influx", "influxdb"],
  ["influxdb", "influxdb"],
  ["timebase", "timebase"],
  ["mssql", "mssql"],
  ["sqlserver", "mssql"],
  ["sql_server", "mssql"],
]);

export function normalizeHistorian(name = "sqlite") {
  return BACKEND_ALIASES.get(String(name || "sqlite").toLowerCase()) || String(name || "sqlite").toLowerCase();
}

export function sampleRow(row) {
  return { ...row, raw_payload: jsonOrDefault(row.raw_payload, {}) };
}

export function summaryFor(samples) {
  const values = samples.map(s => Number(s.value)).filter(Number.isFinite);
  return values.length ? {
    min: Math.min(...values),
    max: Math.max(...values),
    avg: values.reduce((a, b) => a + b, 0) / values.length,
    count: values.length,
  } : { min: null, max: null, avg: null, count: 0 };
}

function parseIso(value, fallback) {
  const d = value ? new Date(value) : null;
  return d && !Number.isNaN(d.valueOf()) ? d.toISOString() : fallback;
}

function cacheSample({ point, ts = now(), value, quality = "Good", sourceType = "api", rawPayload = {} }) {
  const row = {
    id: uuid("HS"),
    pointId: point.id,
    ts: parseIso(ts, now()),
    value: Number(value),
    quality,
    sourceType,
    rawPayload: JSON.stringify(rawPayload || {}),
  };
  db.prepare(`INSERT INTO historian_samples (id, point_id, ts, value, quality, source_type, raw_payload)
              VALUES (@id, @pointId, @ts, @value, @quality, @sourceType, @rawPayload)`).run(row);
  return sampleRow(db.prepare("SELECT * FROM historian_samples WHERE id = ?").get(row.id));
}

function queryCache(pointId, { since, until, limit }) {
  return db.prepare(`SELECT * FROM historian_samples
                     WHERE point_id = ? AND ts >= ? AND ts <= ?
                     ORDER BY ts ASC LIMIT ?`).all(pointId, since, until, limit).map(sampleRow);
}

const sqliteAdapter = {
  name: "sqlite",
  kind: "local-cache",
  configured: true,
  status() {
    return { name: "sqlite", configured: true, writable: true, readable: true, role: "local-cache" };
  },
  async writeSample(point, sample) {
    return { backend: "sqlite", written: true, cached: true, sample };
  },
  async querySamples(point, query) {
    return queryCache(point.id, query);
  },
};

const influxAdapter = {
  name: "influxdb",
  kind: "time-series",
  configured() {
    return Boolean(process.env.FORGE_INFLUX_URL && process.env.FORGE_INFLUX_TOKEN && process.env.FORGE_INFLUX_ORG && process.env.FORGE_INFLUX_BUCKET);
  },
  status() {
    return {
      name: "influxdb",
      configured: this.configured(),
      writable: this.configured(),
      readable: this.configured(),
      url: redactUrl(process.env.FORGE_INFLUX_URL),
      bucket: process.env.FORGE_INFLUX_BUCKET || null,
    };
  },
  async writeSample(point, sample) {
    if (!this.configured()) return notConfigured("influxdb");
    const { InfluxDB, Point } = await import("@influxdata/influxdb-client");
    const client = new InfluxDB({ url: process.env.FORGE_INFLUX_URL, token: process.env.FORGE_INFLUX_TOKEN });
    const writeApi = client.getWriteApi(process.env.FORGE_INFLUX_ORG, process.env.FORGE_INFLUX_BUCKET, "ms");
    writeApi.writePoint(new Point("forge_historian")
      .tag("point_id", point.id)
      .tag("asset_id", point.asset_id)
      .tag("tag", point.tag)
      .tag("quality", sample.quality)
      .floatField("value", Number(sample.value))
      .timestamp(new Date(sample.ts)));
    await writeApi.close();
    return { backend: "influxdb", written: true };
  },
  async querySamples(point, query) {
    if (!this.configured()) return null;
    const { InfluxDB } = await import("@influxdata/influxdb-client");
    const client = new InfluxDB({ url: process.env.FORGE_INFLUX_URL, token: process.env.FORGE_INFLUX_TOKEN });
    const queryApi = client.getQueryApi(process.env.FORGE_INFLUX_ORG);
    const flux = `from(bucket: "${escapeFlux(process.env.FORGE_INFLUX_BUCKET)}")
      |> range(start: time(v: "${query.since}"), stop: time(v: "${query.until}"))
      |> filter(fn: (r) => r._measurement == "forge_historian" and r.point_id == "${escapeFlux(point.id)}" and r._field == "value")
      |> sort(columns: ["_time"])
      |> limit(n: ${Number(query.limit)})`;
    const rows = [];
    for await (const { values, tableMeta } of queryApi.iterateRows(flux)) {
      const r = tableMeta.toObject(values);
      rows.push({ id: `${point.id}:${r._time}`, point_id: point.id, ts: new Date(r._time).toISOString(), value: Number(r._value), quality: r.quality || "Good", source_type: "influxdb", raw_payload: {} });
    }
    return rows;
  },
};

const timebaseAdapter = {
  name: "timebase",
  kind: "enterprise-historian",
  configured() {
    return Boolean(process.env.FORGE_TIMEBASE_URL);
  },
  status() {
    return {
      name: "timebase",
      configured: this.configured(),
      writable: this.configured(),
      readable: this.configured(),
      url: redactUrl(process.env.FORGE_TIMEBASE_URL),
    };
  },
  async writeSample(point, sample) {
    if (!this.configured()) return notConfigured("timebase");
    const res = await fetch(new URL("/api/v1/samples", process.env.FORGE_TIMEBASE_URL), {
      method: "POST",
      headers: jsonHeaders(process.env.FORGE_TIMEBASE_TOKEN),
      body: JSON.stringify({ point, sample }),
    });
    if (!res.ok) throw new Error(`timebase write failed: ${res.status}`);
    return { backend: "timebase", written: true };
  },
  async querySamples(point, query) {
    if (!this.configured()) return null;
    const url = new URL("/api/v1/samples", process.env.FORGE_TIMEBASE_URL);
    url.searchParams.set("tag", point.tag);
    url.searchParams.set("since", query.since);
    url.searchParams.set("until", query.until);
    url.searchParams.set("limit", String(query.limit));
    const res = await fetch(url, { headers: jsonHeaders(process.env.FORGE_TIMEBASE_TOKEN) });
    if (!res.ok) throw new Error(`timebase query failed: ${res.status}`);
    const body = await res.json();
    return (body.samples || []).map(s => ({ id: s.id || `${point.id}:${s.ts}`, point_id: point.id, ts: parseIso(s.ts, now()), value: Number(s.value), quality: s.quality || "Good", source_type: "timebase", raw_payload: s.rawPayload || {} }));
  },
};

const mssqlAdapter = {
  name: "mssql",
  kind: "relational-history",
  configured() {
    return Boolean(process.env.FORGE_MSSQL_CONNECTION_STRING);
  },
  status() {
    return {
      name: "mssql",
      configured: this.configured(),
      writable: this.configured(),
      readable: this.configured(),
      role: "recipes,batches,relational-history",
    };
  },
  async pool() {
    const sql = await import("mssql");
    return sql.default.connect(process.env.FORGE_MSSQL_CONNECTION_STRING);
  },
  async writeSample(point, sample) {
    if (!this.configured()) return notConfigured("mssql");
    const sql = await import("mssql");
    const pool = await this.pool();
    await pool.request()
      .input("point_id", sql.default.NVarChar, point.id)
      .input("asset_id", sql.default.NVarChar, point.asset_id)
      .input("tag", sql.default.NVarChar, point.tag)
      .input("ts", sql.default.DateTime2, new Date(sample.ts))
      .input("value", sql.default.Float, Number(sample.value))
      .input("quality", sql.default.NVarChar, sample.quality)
      .input("source_type", sql.default.NVarChar, sample.source_type)
      .query(`INSERT INTO forge_historian_samples(point_id, asset_id, tag, ts, value, quality, source_type)
              VALUES(@point_id, @asset_id, @tag, @ts, @value, @quality, @source_type)`);
    return { backend: "mssql", written: true };
  },
  async querySamples(point, query) {
    if (!this.configured()) return null;
    const sql = await import("mssql");
    const pool = await this.pool();
    const result = await pool.request()
      .input("point_id", sql.default.NVarChar, point.id)
      .input("since", sql.default.DateTime2, new Date(query.since))
      .input("until", sql.default.DateTime2, new Date(query.until))
      .input("limit", sql.default.Int, Number(query.limit))
      .query(`SELECT TOP (@limit) point_id, ts, value, quality, source_type
              FROM forge_historian_samples
              WHERE point_id = @point_id AND ts >= @since AND ts <= @until
              ORDER BY ts ASC`);
    return result.recordset.map(r => ({ id: `${point.id}:${r.ts.toISOString()}`, point_id: point.id, ts: r.ts.toISOString(), value: Number(r.value), quality: r.quality || "Good", source_type: r.source_type || "mssql", raw_payload: {} }));
  },
  async archiveRecipeEvent(action, recipe, version = null) {
    if (!this.configured()) return { backend: "mssql", archived: false, reason: "not_configured" };
    const sql = await import("mssql");
    const pool = await this.pool();
    await pool.request()
      .input("event_id", sql.default.NVarChar, uuid("RPE"))
      .input("action", sql.default.NVarChar, action)
      .input("recipe_id", sql.default.NVarChar, recipe.id)
      .input("asset_id", sql.default.NVarChar, recipe.asset_id || null)
      .input("version_id", sql.default.NVarChar, version?.id || recipe.current_version_id || null)
      .input("payload", sql.default.NVarChar, JSON.stringify({ recipe, version }))
      .input("created_at", sql.default.DateTime2, new Date())
      .query(`INSERT INTO forge_recipe_events(event_id, action, recipe_id, asset_id, version_id, payload, created_at)
              VALUES(@event_id, @action, @recipe_id, @asset_id, @version_id, @payload, @created_at)`);
    return { backend: "mssql", archived: true };
  },
};

const adapters = new Map([
  ["sqlite", sqliteAdapter],
  ["influxdb", influxAdapter],
  ["timebase", timebaseAdapter],
  ["mssql", mssqlAdapter],
]);

export function listHistorianBackends() {
  return [...adapters.values()].map(adapter => typeof adapter.status === "function" ? adapter.status() : { name: adapter.name });
}

export function getHistorianBackend(name) {
  return adapters.get(normalizeHistorian(name)) || null;
}

export async function writeHistorianSample(point, input, { strict = process.env.FORGE_HISTORIAN_STRICT === "1" } = {}) {
  const numeric = Number(input.value);
  if (!Number.isFinite(numeric)) throw Object.assign(new Error("numeric value required"), { statusCode: 400 });
  const sample = cacheSample({ point, ...input, value: numeric });
  const backendName = normalizeHistorian(point.historian || "sqlite");
  const backend = getHistorianBackend(backendName);
  if (!backend) return { sample, backend: { name: backendName, written: false, cached: true, reason: "unknown_backend" } };
  if (backendName === "sqlite") return { sample, backend: { name: "sqlite", written: true, cached: true } };
  try {
    const result = await backend.writeSample(point, sample);
    return { sample, backend: { ...result, cached: true } };
  } catch (err) {
    if (strict) throw err;
    return { sample, backend: { name: backendName, written: false, cached: true, error: String(err?.message || err) } };
  }
}

export async function readHistorianSamples(point, query) {
  const backendName = normalizeHistorian(point.historian || "sqlite");
  const backend = getHistorianBackend(backendName);
  if (backend && backendName !== "sqlite") {
    try {
      const external = await backend.querySamples(point, query);
      if (external && external.length) return { backend: backendName, samples: external };
    } catch {
      // Fall through to local cache. The API returns cached data instead of
      // breaking operator trend views when an external historian is offline.
    }
  }
  return { backend: "sqlite", samples: queryCache(point.id, query), fallbackFrom: backendName === "sqlite" ? null : backendName };
}

export async function archiveRecipeEvent(action, recipe, version = null) {
  return mssqlAdapter.archiveRecipeEvent(action, recipe, version);
}

function notConfigured(name) {
  return { backend: name, written: false, reason: "not_configured" };
}

function redactUrl(raw) {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    u.username = "";
    u.password = "";
    return u.toString();
  } catch {
    return "[configured]";
  }
}

function jsonHeaders(token) {
  return {
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

function escapeFlux(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
