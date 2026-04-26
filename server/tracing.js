// Optional OpenTelemetry bootstrap.
//
// The server remains dependency-light in local/dev mode. When
// FORGE_OTEL_ENABLED=1 is set, this module starts a NodeSDK that exports
// traces through OTLP/HTTP. Import this before app startup work so HTTP and
// Fastify instrumentation can patch libraries early.

let sdk = null;

export async function initTracing({
  enabled = process.env.FORGE_OTEL_ENABLED === "1",
  serviceName = process.env.OTEL_SERVICE_NAME || "forge-api",
  endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318/v1/traces",
  environment = process.env.NODE_ENV || "development",
} = {}) {
  if (!enabled || sdk) return sdk;

  const [
    { NodeSDK },
    { OTLPTraceExporter },
    { getNodeAutoInstrumentations },
    api,
  ] = await Promise.all([
    import("@opentelemetry/sdk-node"),
    import("@opentelemetry/exporter-trace-otlp-http"),
    import("@opentelemetry/auto-instrumentations-node"),
    import("@opentelemetry/api"),
  ]);

  sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter({ url: endpoint }),
    instrumentations: [getNodeAutoInstrumentations()],
    serviceName,
  });
  await sdk.start();
  api.diag.debug?.(`FORGE tracing enabled for ${serviceName} (${environment})`);
  return sdk;
}

export async function shutdownTracing() {
  if (!sdk) return;
  const s = sdk;
  sdk = null;
  await s.shutdown();
}

export async function currentTraceContext() {
  try {
    const { context, trace } = await import("@opentelemetry/api");
    const span = trace.getSpan(context.active());
    const ctx = span?.spanContext?.();
    if (!ctx?.traceId) return {};
    return {
      trace_id: ctx.traceId,
      span_id: ctx.spanId,
      trace_flags: ctx.traceFlags,
    };
  } catch {
    return {};
  }
}

export function traceContextCarrier({ traceId, spanId = "0000000000000000", flags = "01" } = {}) {
  if (!traceId) return {};
  const safeTrace = String(traceId).replace(/[^a-f0-9]/gi, "").padEnd(32, "0").slice(0, 32).toLowerCase();
  const safeSpan = String(spanId || "").replace(/[^a-f0-9]/gi, "").padEnd(16, "0").slice(0, 16).toLowerCase();
  return { traceparent: `00-${safeTrace}-${safeSpan}-${flags}` };
}
