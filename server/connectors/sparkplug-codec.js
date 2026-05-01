// Sparkplug B codec wrapper.
//
// Phase 7f. The MQTT bridge accepts two on-the-wire encodings:
//
//   * `raw_json`     — the legacy default. Payloads are UTF-8 JSON
//                      objects of shape {value, ts, quality} or a
//                      bare numeric scalar; see
//                      `mqtt-registry.parsePayload` for details.
//   * `sparkplug_b`  — the Eclipse Tahu / Cirrus Link spec. Payloads
//                      are protobuf-encoded with a list of metrics;
//                      we extract the metric whose `name` matches the
//                      binding's expected metric (last `/` segment of
//                      the resolved `source_path`, or an explicit
//                      override on the binding's `template_vars`).
//
// This module is the single integration seam between FORGE and the
// `sparkplug-payload` package. Keeping the import + Buffer/Long
// translation in one place means the registry stays a stable shape
// (encoding-agnostic dispatch) and the codec can be unit-tested
// without running the broker.
//
// Spec ref: docs/INDUSTRIAL_EDGE_PLATFORM_SPEC.md §1.2 (broker
// spine — multi-vendor interop) + Eclipse Sparkplug B 3.0 spec.

import sparkplugPayload from "sparkplug-payload";

// `sparkplug-payload` exposes a `get(version)` factory that returns
// the encoder/decoder pair. `spBv1.0` is the only currently shipping
// version (the 3.0 spec retains the same wire format).
const tahu = sparkplugPayload.get("spBv1.0");

/** Quality enum produced by the codec. Matches the rest of FORGE. */
const QUALITY_GOOD = "Good";
const QUALITY_BAD = "Bad";
const QUALITY_UNCERTAIN = "Uncertain";

// Sparkplug B reserves a small set of "metric type" identifiers.
// We coerce their value cells back to plain JS scalars here so
// downstream historian writes don't have to know about the wire
// format.
function coerceMetricValue(metric) {
  if (metric == null || metric.value == null) return null;
  const v = metric.value;
  // sparkplug-payload returns Long instances for Int64/UInt64 metrics
  // and plain numbers for everything else. We convert Long → number,
  // accepting the precision loss above 2^53 (industrial setpoints
  // virtually never sit in that range).
  if (typeof v === "object" && typeof v.toNumber === "function") {
    return v.toNumber();
  }
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  // Dataset / Template / File payloads aren't single-scalar metrics
  // and aren't carried by the dashboard's per-binding model. Return
  // null so the caller flags the sample as unreliable.
  return null;
}

/**
 * Decode a Sparkplug B payload buffer. Returns the parsed payload
 * shape from `sparkplug-payload`:
 *   { timestamp, metrics: [{ name, value, type, timestamp, ... }], seq }
 *
 * Throws if the buffer isn't a parseable Sparkplug B protobuf —
 * callers must catch and treat as `Bad` quality.
 */
export function decodePayload(buffer) {
  if (!Buffer.isBuffer(buffer) && !(buffer instanceof Uint8Array)) {
    throw new Error("decodePayload: buffer required");
  }
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  return tahu.decodePayload(buf);
}

/**
 * Encode a Sparkplug B payload from a list of metric records.
 * Used for outbound writebacks (NCMD / DCMD) — the MQTT registry
 * owns the topic layout and payload assembly, this helper is just
 * the protobuf step.
 *
 * @param {object} payload - { timestamp?, metrics, seq? } shape.
 * @returns {Buffer}
 */
export function encodePayload(payload) {
  if (!payload || !Array.isArray(payload.metrics)) {
    throw new Error("encodePayload: payload.metrics array required");
  }
  return tahu.encodePayload(payload);
}

/**
 * Pick the matching metric out of a decoded Sparkplug B payload and
 * normalise it into FORGE's {value, ts, quality} shape. Returns
 * `null` (not throw) when the metric isn't present so the registry
 * can simply ignore the message — Sparkplug B brokers fan out group-
 * level updates and an asset binding may legitimately not be in any
 * given DDATA frame.
 *
 * @param {object} decoded   - output of decodePayload()
 * @param {string} metricName - the metric name to extract (e.g. "temperature")
 * @returns {{ value: number|null, ts: string|null, quality: string } | null}
 */
export function extractMetricSample(decoded, metricName) {
  if (!decoded || !Array.isArray(decoded.metrics) || !metricName) return null;
  const wanted = String(metricName).toLowerCase();
  // Sparkplug B metric names are dot-separated paths inside a single
  // group (e.g. `motor/run_command`). We accept either an exact name
  // match (preferred) or the trailing-segment match for callers that
  // pass just the leaf.
  const match = decoded.metrics.find(m => {
    if (!m?.name) return false;
    const lname = String(m.name).toLowerCase();
    if (lname === wanted) return true;
    const tail = lname.split("/").pop();
    return tail === wanted;
  });
  if (!match) return null;
  const value = coerceMetricValue(match);
  let ts = null;
  if (match.timestamp != null) {
    // Sparkplug B timestamps are uint64 ms-since-epoch. `Long`-shaped
    // values come from the protobuf decoder.
    const tsNum = typeof match.timestamp === "object" && typeof match.timestamp.toNumber === "function"
      ? match.timestamp.toNumber()
      : Number(match.timestamp);
    if (Number.isFinite(tsNum) && tsNum > 0) ts = new Date(tsNum).toISOString();
  } else if (decoded.timestamp != null) {
    const tsNum = typeof decoded.timestamp === "object" && typeof decoded.timestamp.toNumber === "function"
      ? decoded.timestamp.toNumber()
      : Number(decoded.timestamp);
    if (Number.isFinite(tsNum) && tsNum > 0) ts = new Date(tsNum).toISOString();
  }
  // `is_null` flag (when the publisher explicitly marks the metric
  // as null) maps to Bad quality.
  const isNull = !!match.is_null || value == null;
  return {
    value: isNull ? null : value,
    ts,
    quality: isNull ? QUALITY_BAD : QUALITY_GOOD,
  };
}

/**
 * Detect Sparkplug B topic shape. Sparkplug B mandates the prefix
 * `spBv1.0/` followed by `<group>/<message_type>/<edge_node_id>[/<device_id>]`
 * where `message_type ∈ {NBIRTH, NDATA, NDEATH, NCMD, DBIRTH, DDATA, DDEATH, DCMD, STATE}`.
 */
const SPB_MESSAGE_TYPES = new Set([
  "NBIRTH", "NDATA", "NDEATH", "NCMD",
  "DBIRTH", "DDATA", "DDEATH", "DCMD",
  "STATE",
]);

export function isSparkplugTopic(topic) {
  if (typeof topic !== "string") return false;
  if (!topic.startsWith("spBv1.0/")) return false;
  const parts = topic.split("/");
  if (parts.length < 4) return false;
  return SPB_MESSAGE_TYPES.has(parts[2]);
}

/**
 * Extract the message type (NDATA / DBIRTH / etc.) from a Sparkplug
 * topic. Returns `null` when the topic isn't Sparkplug-shaped.
 */
export function sparkplugMessageType(topic) {
  if (!isSparkplugTopic(topic)) return null;
  return topic.split("/")[2];
}

/**
 * Build a Sparkplug B writeback payload (DCMD/NCMD shape). The
 * MQTT registry's writeback path calls this when the system's
 * encoding is `sparkplug_b` — the topic layout is the registry's
 * responsibility.
 *
 * @param {object} args
 * @param {string} args.metricName - target metric (matches binding source_path tail)
 * @param {number} args.value
 * @param {string} [args.metricType="Float"] - sparkplug type label
 * @param {number} [args.timestamp=Date.now()]
 * @returns {Buffer}
 */
export function buildCommandPayload({ metricName, value, metricType = "Float", timestamp = Date.now() }) {
  if (!metricName) throw new Error("buildCommandPayload: metricName required");
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("buildCommandPayload: value must be a finite number");
  }
  return tahu.encodePayload({
    timestamp,
    metrics: [
      {
        name: metricName,
        value,
        type: metricType,
        timestamp,
      },
    ],
    seq: 0,
  });
}

export const ENCODINGS = Object.freeze({
  RAW_JSON: "raw_json",
  SPARKPLUG_B: "sparkplug_b",
});

/**
 * Resolve the encoding string from a system row's parsed `config`.
 * Default is `raw_json` for back-compat with every existing
 * registered broker.
 */
export function resolveEncoding(systemConfig) {
  const raw = String(systemConfig?.mqtt_encoding ?? systemConfig?.encoding ?? "raw_json").toLowerCase();
  if (raw === "sparkplug_b" || raw === "sparkplug-b" || raw === "sparkplugb") return ENCODINGS.SPARKPLUG_B;
  return ENCODINGS.RAW_JSON;
}

/**
 * Resolve the MQTT protocol version from a system row's parsed
 * `config`. Default is 3.1.1 for back-compat. Returns the integer
 * the `mqtt` package expects in `connect({ protocolVersion })`:
 * `4` for MQTT 3.1.1, `5` for MQTT 5.0. (Note: `3` is MQTT 3.1,
 * which we don't currently surface — almost nobody runs it.)
 */
export function resolveProtocolVersion(systemConfig) {
  const raw = String(systemConfig?.mqtt_protocol ?? systemConfig?.protocol_version ?? "3.1.1");
  if (raw === "5" || raw === "5.0" || raw === "v5" || raw.toLowerCase() === "mqtt5") return 5;
  return 4;
}

/** Extract the binding's expected metric name from its source_path. */
export function metricNameForBinding(binding) {
  if (!binding) return null;
  // Prefer an explicit override on template_vars.metric_name —
  // operators with non-trivial Sparkplug naming can pin it without
  // forcing the source_path to contain the metric.
  try {
    const tv = typeof binding.template_vars === "string" ? JSON.parse(binding.template_vars) : (binding.template_vars || {});
    if (tv && typeof tv.metric_name === "string" && tv.metric_name) return tv.metric_name;
  } catch { /* fall through to source_path tail */ }
  const path = String(binding.source_path || "");
  if (!path) return null;
  // Strip the Sparkplug topic prefix if present (the binding's
  // source_path may carry the full topic for routing) and return
  // the last segment as the metric name.
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] || null;
}

export default {
  decodePayload,
  encodePayload,
  extractMetricSample,
  isSparkplugTopic,
  sparkplugMessageType,
  buildCommandPayload,
  resolveEncoding,
  resolveProtocolVersion,
  metricNameForBinding,
  ENCODINGS,
};
