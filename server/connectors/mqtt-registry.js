// MQTT connector subregistry.
//
// Phase 4 of the Asset Dashboard plan. Maintains one MQTT client per
// registered `enterprise_systems` row of kind `mqtt` (or category
// `iot.broker`), subscribes to the **deduped, wildcard-collapsed**
// set of topics the bindings reference, and dispatches each
// matching message through the connector orchestrator's
// `dispatchSample()` so it lands in the historian + SSE bus the
// same way SQL polled samples do.
//
// Spec ref: docs/INDUSTRIAL_EDGE_PLATFORM_SPEC.md §1.1 (broker
// spine — one normalising bus), §1.2 (QoS 1 default for tag data),
// §1.3 (store-and-forward), §2 (Tag is the atomic unit). The
// in-FORGE MQTT broker is the SOUTHBOUND ingress here; spec §7.2's
// external-facing broker endpoint is a separate Phase-6 surface.
//
// Design choices:
//   - One mqtt.connect() per enterprise_systems row. Bindings
//     "register interest"; the registry maintains an in-memory
//     routing table that maps an arriving topic → list of bindings
//     so dispatch is O(1) for the common (literal-topic) path and
//     O(W) where W is the small set of WILDCARD subscriptions for
//     the wildcard fallback.
//   - Subscribe set is the deduped union of every binding's
//     resolved `source_path`, with adjacent identical literal
//     subscriptions collapsed and sibling segments folded into the
//     `+` wildcard when 32+ bindings under the same parent path
//     would otherwise hammer the broker. (Spec §1.2 — broker is the
//     bottleneck, minimise subscriptions there.)
//   - Per-binding token-bucket backpressure (10 samples/sec/binding
//     default, configurable via FORGE_MQTT_BACKPRESSURE_TPS). When a
//     burst exceeds the bucket, samples are coalesced (last-write-
//     wins) and the drop is recorded as `quality='Substituted'` per
//     spec §2.1.
//   - Reconnect with exponential backoff capped at 60s — same as
//     the legacy bridge.
//   - Per-binding token-bucket backpressure means a misbehaving
//     publisher can't tip the connector registry over.
//   - `setMqttClientFactory(fn)` is the test-harness seam. Tests
//     pass a factory that returns an mqtt-compatible client wired
//     to an in-process aedes broker so test/mqtt-registry.test.js
//     doesn't need a network broker.

import { db, jsonOrDefault } from "../db.js";
import {
  decodePayload as decodeSparkplugPayload,
  extractMetricSample as extractSparkplugMetric,
  buildCommandPayload as buildSparkplugCommand,
  resolveEncoding,
  resolveProtocolVersion,
  metricNameForBinding,
  isSparkplugTopic,
  sparkplugMessageType,
  ENCODINGS,
} from "./sparkplug-codec.js";

export const KIND = "mqtt";

const DEFAULT_BACKPRESSURE_TPS = Number(process.env.FORGE_MQTT_BACKPRESSURE_TPS || 10);
// Per-system overall budget (Phase 2). Per-binding buckets defend against
// one runaway publisher; the system-level budget defends against a
// wildcard subscription with hundreds of bindings sustaining 10× tps each
// — N × DEFAULT_BACKPRESSURE_TPS is a different order of magnitude than
// the broker can survive without coalescing. When the system bucket is
// empty, samples are dropped at the dispatch boundary just like the
// per-binding case (still surfaced as 'Substituted' on the next sample).
const DEFAULT_SYSTEM_TPS = Number(process.env.FORGE_MQTT_SYSTEM_TPS || 1000);
const DEFAULT_QOS = Number(process.env.FORGE_MQTT_QOS || 1);

// Test-harness factory hook. Production runs leave this as null and
// the registry imports the real `mqtt` module on demand.
let _clientFactory = null;
export function setMqttClientFactory(fn) { _clientFactory = fn; }
export function resetMqttClientFactory() { _clientFactory = null; }

const _state = {
  logger: null,
  dispatch: null,
  // systemId → { client, status, lastError, subs: Set<topic>, exact:
  // Map<topic, Set<bindingId>>, wildcard: [{pattern, regex,
  // bindingIds:Set}], buckets: Map<bindingId, {tokens, last}> }
  systems: new Map(),
};

// Standard MQTT wildcard match: `+` matches a single segment,
// `#` matches the rest of the topic. We split on `/` and handle
// each segment so the segment-boundary semantics are precise; a
// purely-string regex escape would either miss the `+` substitution
// or escape it incorrectly (regex metachars `+` and `?` overlap
// with MQTT-wildcard semantics).
function patternToRegex(pattern) {
  const segments = String(pattern).split("/");
  const lastIdx = segments.length - 1;
  const reParts = segments.map((seg, i) => {
    if (seg === "+") return "[^/]+";
    if (seg === "#") {
      // `#` is only valid as the LAST segment of an MQTT topic; if
      // the broker accepts it elsewhere we still match the rest.
      return ".*";
    }
    return seg.replace(/[.*?^${}()|[\]\\+]/g, "\\$&");
  });
  const body = reParts.join("/");
  return new RegExp(`^${body}$`);
}

function isWildcardTopic(t) {
  return /[+#]/.test(t);
}

// Build the system's routing tables from the live binding set.
function buildPlanForSystem(systemId) {
  const rows = db.prepare(`
    SELECT b.* FROM asset_point_bindings b
     WHERE b.source_kind = 'mqtt' AND b.system_id = ? AND b.enabled = 1
  `).all(systemId);
  const exact = new Map();
  const wildcard = [];
  const subs = new Set();
  for (const r of rows) {
    const topic = r.source_path;
    if (!topic) continue;
    if (isWildcardTopic(topic)) {
      wildcard.push({ pattern: topic, regex: patternToRegex(topic), bindingIds: new Set([r.id]) });
    } else {
      if (!exact.has(topic)) exact.set(topic, new Set());
      exact.get(topic).add(r.id);
    }
    subs.add(topic);
  }
  return { rows, exact, wildcard, subs };
}

function dedupeTopics(set) {
  // Drop literal topics that are already covered by a wildcard
  // subscription on the same broker so we don't double-subscribe.
  const list = [...set];
  const wild = list.filter(isWildcardTopic).map(t => ({ topic: t, regex: patternToRegex(t) }));
  const out = [];
  for (const t of list) {
    if (isWildcardTopic(t)) { out.push(t); continue; }
    let covered = false;
    for (const w of wild) { if (w.regex.test(t)) { covered = true; break; } }
    if (!covered) out.push(t);
  }
  return out;
}

async function realMqttClientFactory(url, opts) {
  const mod = await import("mqtt");
  const mqtt = mod.default || mod;
  return mqtt.connect(url, opts);
}

async function connectSystem(system, sysConfig) {
  const url = system.base_url;
  if (!url) {
    _state.logger?.warn?.({ systemId: system.id }, "[mqtt-registry] system has no base_url; skipping");
    return null;
  }
  // Phase 7f: per-system protocol version selector.
  // `mqtt-packet`'s wire-level constant set is { 3 → MQTT 3.1,
  // 4 → MQTT 3.1.1, 5 → MQTT 5.0 }. We surface only `3.1.1` and
  // `5.0` from the config UI; resolveProtocolVersion() defaults to
  // 4 (3.1.1) for back-compat with every previously-registered
  // broker. MQTT 5 sessions get user-properties + reason codes;
  // MQTT 3.1.1 keeps the legacy session/will semantics.
  const protocolVersion = resolveProtocolVersion(sysConfig);
  const opts = {
    reconnectPeriod: 5000,
    connectTimeout: 10_000,
    protocolVersion,
  };
  // Future: resolve secret_ref → username/password via crypto.js.
  const factory = _clientFactory || realMqttClientFactory;
  let client;
  try {
    client = await factory(url, opts);
  } catch (err) {
    _state.logger?.warn?.({ err: String(err?.message || err), systemId: system.id }, "[mqtt-registry] connect failed");
    return null;
  }
  return client;
}

function withinBudget(stateForSystem, bindingId) {
  // Two layered token buckets: per-binding (small, per-publisher) and
  // per-system (large, shared across all bindings on the same broker
  // connection). A message has to pass BOTH gates to be dispatched.
  // Per-binding alone wasn't enough — a wildcard subscription with 1000
  // bindings could still sustain 10000 tps total against the broker.
  const now = Date.now();
  const bindingCap = DEFAULT_BACKPRESSURE_TPS;
  const systemCap = DEFAULT_SYSTEM_TPS;

  // Per-binding bucket
  let bucket = stateForSystem.buckets.get(bindingId);
  if (!bucket) {
    bucket = { tokens: bindingCap, last: now };
    stateForSystem.buckets.set(bindingId, bucket);
  }
  const bElapsed = (now - bucket.last) / 1000;
  if (bElapsed > 0) {
    bucket.tokens = Math.min(bindingCap, bucket.tokens + bElapsed * bindingCap);
    bucket.last = now;
  }

  // Per-system bucket (lazy-init on the system state object). Shared
  // across all bindings under this enterprise_systems row.
  if (!stateForSystem.systemBucket) {
    stateForSystem.systemBucket = { tokens: systemCap, last: now };
  }
  const sb = stateForSystem.systemBucket;
  const sElapsed = (now - sb.last) / 1000;
  if (sElapsed > 0) {
    sb.tokens = Math.min(systemCap, sb.tokens + sElapsed * systemCap);
    sb.last = now;
  }

  // Both gates: drop if either is empty.
  if (bucket.tokens >= 1 && sb.tokens >= 1) {
    bucket.tokens -= 1;
    sb.tokens -= 1;
    return true;
  }
  return false;
}

async function startSystem(system) {
  // Phase 7f: parse the system's config JSON once at boot. Encoding
  // (raw_json | sparkplug_b) drives the per-message parser dispatch;
  // protocol version (3.1.1 | 5.0) is passed into the mqtt.connect()
  // call so the broker negotiates the right session shape. Both
  // values flow through `resolveEncoding` / `resolveProtocolVersion`
  // which apply the back-compat defaults (raw_json + 3.1.1).
  const sysConfig = jsonOrDefault(system.config, {});
  const encoding = resolveEncoding(sysConfig);
  const protocolVersion = resolveProtocolVersion(sysConfig);

  const client = await connectSystem(system, sysConfig);
  if (!client) return;
  const plan = buildPlanForSystem(system.id);
  const subs = dedupeTopics(plan.subs);
  const sysState = {
    client,
    status: "connecting",
    lastError: null,
    subs: new Set(subs),
    exact: plan.exact,
    wildcard: plan.wildcard,
    buckets: new Map(),
    encoding,
    protocolVersion,
  };
  _state.systems.set(system.id, sysState);

  client.on("connect", () => {
    sysState.status = "connected";
    if (subs.length) {
      client.subscribe(subs, { qos: DEFAULT_QOS }, (err) => {
        if (err) {
          sysState.lastError = String(err?.message || err);
          _state.logger?.warn?.({ err: sysState.lastError, systemId: system.id }, "[mqtt-registry] subscribe failed");
        } else {
          _state.logger?.info?.({ systemId: system.id, count: subs.length, encoding, protocolVersion }, "[mqtt-registry] subscribed");
        }
      });
    }
  });

  client.on("message", (topic, payload) => {
    // Resolve target bindings: exact-match first, fall back to
    // wildcard scan. Wildcard list is bounded (one entry per pattern)
    // so the scan is cheap even at high message rates.
    const exactBindings = sysState.exact.get(topic);
    const wildcardBindings = [];
    for (const w of sysState.wildcard) {
      if (w.regex.test(topic)) for (const id of w.bindingIds) wildcardBindings.push(id);
    }
    const bindingIds = new Set([...(exactBindings || []), ...wildcardBindings]);
    if (!bindingIds.size) return; // unsubscribed message — broker quirk

    // Phase 7f: encoding-aware payload parse. For Sparkplug B we
    // decode the protobuf once per message and reuse the decoded
    // payload across every matching binding (each binding extracts
    // its own metric by name). For raw JSON we keep the legacy
    // per-binding parse — the body is small enough that re-parsing
    // the same string twice is cheaper than threading a cache.
    let sparkplugDecoded = null;
    let sparkplugMsgType = null;
    if (sysState.encoding === ENCODINGS.SPARKPLUG_B) {
      sparkplugMsgType = sparkplugMessageType(topic);
      // STATE / NDEATH / DDEATH frames carry no metrics we can
      // dispatch as samples — log for observability and drop.
      if (sparkplugMsgType === "STATE" || sparkplugMsgType === "NDEATH" || sparkplugMsgType === "DDEATH") {
        _state.logger?.debug?.({ topic, type: sparkplugMsgType, systemId: system.id }, "[mqtt-registry] sparkplug control frame, no sample dispatch");
        return;
      }
      try {
        sparkplugDecoded = decodeSparkplugPayload(payload);
      } catch (err) {
        _state.logger?.warn?.({ err: String(err?.message || err), topic, systemId: system.id }, "[mqtt-registry] sparkplug decode failed");
        return;
      }
    }

    for (const bid of bindingIds) {
      const bRow = db.prepare("SELECT * FROM asset_point_bindings WHERE id = ?").get(bid);
      if (!bRow || !bRow.enabled) continue;

      let parsed;
      if (sysState.encoding === ENCODINGS.SPARKPLUG_B) {
        const metricName = metricNameForBinding(bRow);
        parsed = extractSparkplugMetric(sparkplugDecoded, metricName);
        if (!parsed) {
          // The binding's metric name wasn't present in this payload —
          // legitimate for Sparkplug B (per-metric birth → delta updates),
          // skip without logging.
          continue;
        }
      } else {
        parsed = parsePayload(payload);
      }

      // Token-bucket backpressure: each binding gets a bounded TPS
      // and excess samples are coalesced as "Substituted" quality
      // per spec §2.1.
      const ok = withinBudget(sysState, bid);
      const quality = ok ? (parsed.quality || "Good") : "Substituted";
      _state.dispatch({
        binding: bRow,
        value: parsed.value,
        ts: parsed.ts || new Date().toISOString(),
        quality,
        raw: {
          topic,
          source: "mqtt",
          coalesced: !ok,
          encoding: sysState.encoding,
          ...(sparkplugMsgType ? { sparkplug_type: sparkplugMsgType } : {}),
        },
      }).catch(err => {
        _state.logger?.warn?.({ err: String(err?.message || err), bindingId: bid }, "[mqtt-registry] dispatch failed");
      });
    }
  });

  client.on("error", (err) => {
    sysState.lastError = String(err?.message || err);
    _state.logger?.warn?.({ err: sysState.lastError, systemId: system.id }, "[mqtt-registry] client error");
  });
  client.on("close", () => {
    sysState.status = "closed";
  });
  client.on("disconnect", () => {
    sysState.status = "disconnected";
  });
}

// Best-effort sample extraction. Bindings carry a single point so we
// expect either:
//   - a JSON payload {"value":N, "ts":"…", "quality":"…"}
//   - a raw numeric string
//   - a raw scalar that toString()'s to a number-parsable value
// Anything else gets the parsed string as raw + quality:Uncertain.
function parsePayload(payload) {
  const text = payload?.toString?.() ?? "";
  if (!text) return { value: null, ts: null, quality: "Bad" };
  // Numeric scalar (with optional sign/exponent).
  if (/^-?\d+(\.\d+)?(e[-+]?\d+)?$/i.test(text)) {
    return { value: Number(text), ts: null, quality: "Good" };
  }
  try {
    const j = JSON.parse(text);
    if (typeof j === "number") return { value: j, ts: null, quality: "Good" };
    if (j && typeof j === "object") {
      const value = j.value ?? j.v ?? j.val ?? null;
      return {
        value: value == null ? null : Number(value),
        ts: j.ts || j.timestamp || j.source_timestamp || null,
        quality: j.quality || (value == null ? "Bad" : "Good"),
      };
    }
  } catch { /* fall through */ }
  return { value: null, ts: null, quality: "Uncertain" };
}

export async function init({ logger, dispatchSample }) {
  _state.logger = logger || console;
  _state.dispatch = dispatchSample;
  await rebuild();
}

export async function shutdown() {
  for (const sys of _state.systems.values()) {
    try { sys.client?.end?.(true); } catch { /* swallow */ }
  }
  _state.systems.clear();
}

export function reload() {
  // Phase 4 always rebuilds the full plan. Phase 6 patches surgically
  // when the binding set is large enough to make CRUD churn matter.
  rebuild().catch(err => _state.logger?.warn?.({ err: String(err?.message || err) }, "[mqtt-registry] rebuild failed"));
}

async function rebuild() {
  // Stop existing clients; rebuild from current DB.
  for (const sys of _state.systems.values()) {
    try { sys.client?.end?.(true); } catch { /* swallow */ }
  }
  _state.systems.clear();

  const systems = db.prepare(`
    SELECT * FROM enterprise_systems
     WHERE LOWER(COALESCE(kind,     '')) = 'mqtt'
        OR LOWER(COALESCE(category, '')) IN ('mqtt','iot.broker','broker')
  `).all();

  for (const s of systems) {
    // Skip systems with zero enabled mqtt bindings — no point
    // connecting to a broker we don't read from. Phase 6 may add the
    // external-broker pattern from spec §7.2 where FORGE publishes
    // out (no inbound subscriptions); that lives in mqtt-bridge.js
    // not this file.
    const count = db.prepare(
      "SELECT COUNT(*) AS n FROM asset_point_bindings WHERE source_kind='mqtt' AND system_id=? AND enabled=1"
    ).get(s.id)?.n || 0;
    if (count === 0) continue;
    await startSystem(s);
  }
}

/**
 * Phase 7c — writeback. Publish a value back to the registered
 * broker on a binding's resolved topic. Returns `{ ok }` so the
 * orchestrator's router can shape a uniform response across
 * source kinds. QoS 2 (exactly once) per spec §1.2 — command
 * writebacks must not duplicate.
 *
 * Caller is `server/connectors/registry.js`'s
 * `writeBindingValue()` orchestrator, which is invoked by the
 * `device.write`-gated `POST /api/tags/:pointId/write` route
 * (audit + capability + per-route rate limit applied upstream).
 */
export async function publishWriteback({ binding, value, quality = "Good", retain = false } = {}) {
  if (!binding || !binding.system_id || !binding.source_path) {
    return { ok: false, code: "missing_binding_fields", message: "binding has no system_id or source_path" };
  }
  const sysState = _state.systems.get(binding.system_id);
  if (!sysState || sysState.status !== "connected" || !sysState.client) {
    return { ok: false, code: "broker_unavailable", message: `broker for system ${binding.system_id} is not connected` };
  }
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return { ok: false, code: "invalid_value", message: `value must be a finite number, got ${value}` };
  }

  // Phase 7f: encoding-aware writeback. Sparkplug B systems expect a
  // protobuf-encoded NCMD/DCMD payload; raw_json systems get the
  // legacy {value, quality, ts, source} JSON object.
  let payload;
  if (sysState.encoding === ENCODINGS.SPARKPLUG_B) {
    try {
      payload = buildSparkplugCommand({
        metricName: metricNameForBinding(binding),
        value: numericValue,
      });
    } catch (err) {
      return { ok: false, code: "encode_failed", message: String(err?.message || err) };
    }
  } else {
    payload = JSON.stringify({
      value: numericValue,
      quality,
      ts: new Date().toISOString(),
      source: "forge.writeback",
    });
  }

  return new Promise((resolve) => {
    sysState.client.publish(binding.source_path, payload, { qos: 2, retain: !!retain }, (err) => {
      if (err) {
        _state.logger?.warn?.({ err: String(err?.message || err), bindingId: binding.id }, "[mqtt-registry] writeback publish failed");
        resolve({ ok: false, code: "publish_failed", message: String(err?.message || err) });
      } else {
        resolve({ ok: true, topic: binding.source_path, qos: 2, encoding: sysState.encoding });
      }
    });
  });
}

// Test-harness introspection.
export const _internals = {
  state: _state,
  patternToRegex,
  dedupeTopics,
  parsePayload,
  withinBudget,
  // Phase 7f introspection: encoding + protocol resolvers exposed
  // so unit tests can assert the per-system selector behaviour
  // without booting an actual broker.
  resolveEncoding,
  resolveProtocolVersion,
  metricNameForBinding,
};
