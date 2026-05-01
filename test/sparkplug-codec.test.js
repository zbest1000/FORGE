// Phase 7f — Sparkplug B codec unit tests.
//
// Covers the protobuf encode + decode round-trip via Eclipse Tahu's
// `sparkplug-payload` package, the FORGE-shaped extractor that picks
// a single metric out of a decoded NDATA frame, the topic-shape
// classifier (`isSparkplugTopic` / `sparkplugMessageType`) and the
// per-system config resolvers (`resolveEncoding`,
// `resolveProtocolVersion`).
//
// These tests run without booting the registry — the codec is a
// pure module so we can assert the wire-format contract in isolation.

import test from "node:test";
import assert from "node:assert/strict";

const codec = await import("../server/connectors/sparkplug-codec.js");
const sparkplugPayload = (await import("sparkplug-payload")).default;
const tahu = sparkplugPayload.get("spBv1.0");

// ────────────────────────────────────────────────────────────────────
// encode / decode round-trip
// ────────────────────────────────────────────────────────────────────

test("encodePayload + decodePayload round-trip preserves metric scalars", () => {
  const ts = Date.now();
  const buf = codec.encodePayload({
    timestamp: ts,
    seq: 0,
    metrics: [
      { name: "temperature", value: 23.5, type: "Float", timestamp: ts },
      { name: "pressure", value: 4.2, type: "Double", timestamp: ts },
      { name: "rpm", value: 1450, type: "Int32", timestamp: ts },
    ],
  });
  assert.ok(Buffer.isBuffer(buf), "encode returns a Buffer");
  assert.ok(buf.length > 0);

  const dec = codec.decodePayload(buf);
  assert.equal(dec.metrics.length, 3);
  const byName = Object.fromEntries(dec.metrics.map(m => [m.name, m.value]));
  assert.equal(byName.temperature, 23.5);
  assert.equal(byName.pressure, 4.2);
  assert.equal(byName.rpm, 1450);
});

test("decodePayload accepts a Buffer constructed by sparkplug-payload directly", () => {
  // This guards against accidental Buffer/Uint8Array drift between
  // the codec wrapper and the underlying tahu encoder.
  const buf = tahu.encodePayload({
    timestamp: Date.now(),
    metrics: [{ name: "valve", value: true, type: "Boolean" }],
    seq: 1,
  });
  const dec = codec.decodePayload(buf);
  assert.equal(dec.metrics.length, 1);
  assert.equal(dec.metrics[0].name, "valve");
});

test("decodePayload throws on a non-buffer argument", () => {
  assert.throws(() => codec.decodePayload("not a buffer"), /buffer required/);
});

// ────────────────────────────────────────────────────────────────────
// extractMetricSample — FORGE-shaped extraction
// ────────────────────────────────────────────────────────────────────

test("extractMetricSample picks the named metric out of a decoded payload", () => {
  const ts = 1700000000000; // 2023-11-14T22:13:20.000Z
  // 21.5 and 3.125 are exactly representable in IEEE-754 single
  // precision, so the Float-typed round-trip is bit-exact and we
  // can assert.equal without a tolerance bound.
  const buf = codec.encodePayload({
    timestamp: ts,
    metrics: [
      { name: "temperature", value: 21.5, type: "Float", timestamp: ts },
      { name: "pressure", value: 3.125, type: "Float", timestamp: ts },
    ],
    seq: 0,
  });
  const dec = codec.decodePayload(buf);
  const sample = codec.extractMetricSample(dec, "pressure");
  assert.equal(sample.value, 3.125);
  assert.equal(sample.quality, "Good");
  assert.equal(sample.ts, "2023-11-14T22:13:20.000Z");
});

test("extractMetricSample matches the trailing path segment when name has slashes", () => {
  const buf = codec.encodePayload({
    timestamp: Date.now(),
    metrics: [
      { name: "motor/run_command", value: 1, type: "Int32" },
      { name: "motor/temperature", value: 88, type: "Float" },
    ],
    seq: 0,
  });
  const dec = codec.decodePayload(buf);
  // Using the leaf "temperature" alone should still match the
  // "motor/temperature" metric.
  const sample = codec.extractMetricSample(dec, "temperature");
  assert.equal(sample.value, 88);
});

test("extractMetricSample is case-insensitive on the metric name", () => {
  // Use Double type so the round-trip is bit-exact for arbitrary
  // decimals — the test is about name matching, not float precision.
  const buf = codec.encodePayload({
    timestamp: Date.now(),
    metrics: [{ name: "Temperature", value: 22.7, type: "Double" }],
    seq: 0,
  });
  const dec = codec.decodePayload(buf);
  assert.equal(codec.extractMetricSample(dec, "TEMPERATURE")?.value, 22.7);
  assert.equal(codec.extractMetricSample(dec, "temperature")?.value, 22.7);
});

test("extractMetricSample returns null when the metric is absent", () => {
  const buf = codec.encodePayload({
    timestamp: Date.now(),
    metrics: [{ name: "temperature", value: 22, type: "Float" }],
    seq: 0,
  });
  const dec = codec.decodePayload(buf);
  assert.equal(codec.extractMetricSample(dec, "pressure"), null);
});

test("extractMetricSample returns Bad quality for explicit-null metrics", () => {
  // Sparkplug B's protobuf sets `is_null=true` when a publisher
  // declares the metric value is null — emulate that here.
  const buf = tahu.encodePayload({
    timestamp: Date.now(),
    metrics: [{ name: "temperature", is_null: true, type: "Float" }],
    seq: 0,
  });
  const dec = codec.decodePayload(buf);
  const sample = codec.extractMetricSample(dec, "temperature");
  assert.equal(sample.value, null);
  assert.equal(sample.quality, "Bad");
});

test("extractMetricSample falls back to the payload-level timestamp when metric has none", () => {
  const ts = 1710000000000;
  const buf = tahu.encodePayload({
    timestamp: ts,
    metrics: [{ name: "temperature", value: 21, type: "Float" }],
    seq: 0,
  });
  const dec = codec.decodePayload(buf);
  const sample = codec.extractMetricSample(dec, "temperature");
  assert.equal(sample.ts, new Date(ts).toISOString());
});

// ────────────────────────────────────────────────────────────────────
// topic shape classifier
// ────────────────────────────────────────────────────────────────────

test("isSparkplugTopic recognises the canonical message types", () => {
  assert.equal(codec.isSparkplugTopic("spBv1.0/MyGroup/NDATA/edge1"), true);
  assert.equal(codec.isSparkplugTopic("spBv1.0/MyGroup/NDATA/edge1/dev1"), true);
  assert.equal(codec.isSparkplugTopic("spBv1.0/MyGroup/DBIRTH/edge1/dev1"), true);
  assert.equal(codec.isSparkplugTopic("spBv1.0/MyGroup/NDEATH/edge1"), true);
  assert.equal(codec.isSparkplugTopic("spBv1.0/MyGroup/STATE/edge1"), true);
});

test("isSparkplugTopic rejects non-sparkplug shapes", () => {
  assert.equal(codec.isSparkplugTopic("acme/site1/pump-a/temperature"), false);
  assert.equal(codec.isSparkplugTopic("spBv1.0/MyGroup"), false);
  assert.equal(codec.isSparkplugTopic("spBv1.0/MyGroup/UNKNOWN/edge1"), false);
  assert.equal(codec.isSparkplugTopic(""), false);
  assert.equal(codec.isSparkplugTopic(null), false);
});

test("sparkplugMessageType extracts NDATA / DDATA / etc.", () => {
  assert.equal(codec.sparkplugMessageType("spBv1.0/G/NDATA/e1"), "NDATA");
  assert.equal(codec.sparkplugMessageType("spBv1.0/G/DDATA/e1/d1"), "DDATA");
  assert.equal(codec.sparkplugMessageType("spBv1.0/G/NCMD/e1"), "NCMD");
  assert.equal(codec.sparkplugMessageType("not/sparkplug/shape"), null);
});

// ────────────────────────────────────────────────────────────────────
// config resolvers
// ────────────────────────────────────────────────────────────────────

test("resolveEncoding defaults to raw_json", () => {
  assert.equal(codec.resolveEncoding({}), "raw_json");
  assert.equal(codec.resolveEncoding(null), "raw_json");
  assert.equal(codec.resolveEncoding(undefined), "raw_json");
});

test("resolveEncoding accepts the canonical sparkplug_b form + common aliases", () => {
  assert.equal(codec.resolveEncoding({ mqtt_encoding: "sparkplug_b" }), "sparkplug_b");
  assert.equal(codec.resolveEncoding({ mqtt_encoding: "Sparkplug-B" }), "sparkplug_b");
  assert.equal(codec.resolveEncoding({ mqtt_encoding: "sparkplugb" }), "sparkplug_b");
  // Legacy field name `encoding` is also accepted for back-compat
  // with any operator who's already populated config that way.
  assert.equal(codec.resolveEncoding({ encoding: "sparkplug_b" }), "sparkplug_b");
});

test("resolveEncoding falls back to raw_json for unknown values", () => {
  assert.equal(codec.resolveEncoding({ mqtt_encoding: "csv" }), "raw_json");
  assert.equal(codec.resolveEncoding({ mqtt_encoding: "" }), "raw_json");
});

test("resolveProtocolVersion defaults to 4 (MQTT 3.1.1)", () => {
  assert.equal(codec.resolveProtocolVersion({}), 4);
  assert.equal(codec.resolveProtocolVersion(null), 4);
  assert.equal(codec.resolveProtocolVersion({ mqtt_protocol: "3.1.1" }), 4);
});

test("resolveProtocolVersion returns 5 for MQTT 5.0 selectors", () => {
  assert.equal(codec.resolveProtocolVersion({ mqtt_protocol: "5" }), 5);
  assert.equal(codec.resolveProtocolVersion({ mqtt_protocol: "5.0" }), 5);
  assert.equal(codec.resolveProtocolVersion({ mqtt_protocol: "v5" }), 5);
  assert.equal(codec.resolveProtocolVersion({ mqtt_protocol: "MQTT5" }), 5);
  // Legacy field name `protocol_version` accepted.
  assert.equal(codec.resolveProtocolVersion({ protocol_version: "5.0" }), 5);
});

// ────────────────────────────────────────────────────────────────────
// metricNameForBinding
// ────────────────────────────────────────────────────────────────────

test("metricNameForBinding pulls the trailing source_path segment", () => {
  const binding = { source_path: "spBv1.0/Atlas/NDATA/plant1/pumpA/temperature", template_vars: "{}" };
  assert.equal(codec.metricNameForBinding(binding), "temperature");
});

test("metricNameForBinding honours an explicit template_vars.metric_name override", () => {
  const binding = {
    source_path: "spBv1.0/Atlas/NDATA/plant1/pumpA",
    template_vars: JSON.stringify({ metric_name: "motor/run_command" }),
  };
  assert.equal(codec.metricNameForBinding(binding), "motor/run_command");
});

test("metricNameForBinding tolerates already-parsed template_vars objects", () => {
  const binding = {
    source_path: "any/path",
    template_vars: { metric_name: "rpm" },
  };
  assert.equal(codec.metricNameForBinding(binding), "rpm");
});

test("metricNameForBinding returns null for an empty binding", () => {
  assert.equal(codec.metricNameForBinding(null), null);
  assert.equal(codec.metricNameForBinding({ source_path: "" }), null);
});

// ────────────────────────────────────────────────────────────────────
// buildCommandPayload (writeback encoding)
// ────────────────────────────────────────────────────────────────────

test("buildCommandPayload encodes a single-metric NCMD/DCMD frame", () => {
  const buf = codec.buildCommandPayload({ metricName: "setpoint", value: 75.5 });
  assert.ok(Buffer.isBuffer(buf));
  const dec = codec.decodePayload(buf);
  assert.equal(dec.metrics.length, 1);
  assert.equal(dec.metrics[0].name, "setpoint");
  assert.equal(dec.metrics[0].value, 75.5);
});

test("buildCommandPayload rejects non-finite values", () => {
  assert.throws(() => codec.buildCommandPayload({ metricName: "x", value: NaN }), /finite number/);
  assert.throws(() => codec.buildCommandPayload({ metricName: "x", value: Infinity }), /finite number/);
  assert.throws(() => codec.buildCommandPayload({ metricName: "x", value: "12" }), /finite number/);
});

test("buildCommandPayload rejects missing metricName", () => {
  assert.throws(() => codec.buildCommandPayload({ value: 10 }), /metricName required/);
});
