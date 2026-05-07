// OPC UA connector subregistry (CLIENT role).
//
// Phase 5 of the Asset Dashboard plan. For each registered
// `enterprise_systems` row of kind `opcua`, opens an OPCUAClient
// session, batches the bindings under that system into one
// ClientSubscription per publishing-interval bucket, and uses
// `ClientMonitoredItemGroup.create()` to register monitored items
// in chunks. On `dataValue.changed` events the orchestrator's
// `dispatchSample()` lands the sample in the historian + SSE bus,
// the same path the SQL/MQTT subregistries use.
//
// Design choices (see docs/INDUSTRIAL_EDGE_PLATFORM_SPEC.md §3,
// §17.3 + plan §5 OPC UA monitored-items pool):
//
//   - One OPCUAClient + Session per `enterprise_systems` row.
//   - Bindings are bucketed by publishing interval (250ms / 1s /
//     5s / 60s) and one ClientSubscription is created per bucket.
//     Don't create one subscription per item — most OPC UA servers
//     cap subscriptions per session (~50) and a 10k-item plant would
//     blow that out instantly.
//   - Monitored items go in via ClientMonitoredItemGroup.create()
//     in chunks of 500 — that's the batched CreateMonitoredItems
//     service call. The legacy bridge's serial subscription.monitor()
//     loop didn't scale.
//   - sampling interval = publishing interval bucket; queueSize = 1
//     with discardOldest=true for analog signals (we only care about
//     latest). Phase 6 may expose a per-binding queueSize override
//     for alarm/event nodes that mustn't be coalesced.
//   - Reconnect / disconnect handling via node-opcua's built-in
//     `connectionStrategy`. We surface client errors through the
//     orchestrator's logger and let node-opcua reconnect.
//   - `setOpcuaClientFactory(fn)` is the test seam — production
//     uses node-opcua directly; tests pass a stub factory that
//     returns a mock OPCUAClient with `connect`, `createSession`,
//     and a fake subscription whose `on('changed', cb)` we drive
//     manually.
//
// Security:
//   - FORGE_OPCUA_SECURITY_MODE / FORGE_OPCUA_SECURITY_POLICY
//     control transport security exactly like the legacy bridge.
//     In strict/production mode the registry refuses to connect
//     with mode=None or policy=None — same posture as the legacy
//     bridge.

import { db, jsonOrDefault } from "../db.js";
import { withSpan } from "../tracing.js";

export const KIND = "opcua";

const PUBLISHING_BUCKETS_MS = [250, 1000, 5000, 60_000];

// Pick the bucket whose publishing interval is the closest match
// (rounded up) to the binding's requested interval.
function pickBucket(requestedMs) {
  for (const b of PUBLISHING_BUCKETS_MS) {
    if (requestedMs <= b) return b;
  }
  return PUBLISHING_BUCKETS_MS[PUBLISHING_BUCKETS_MS.length - 1];
}

let _clientFactory = null;
export function setOpcuaClientFactory(fn) { _clientFactory = fn; }
export function resetOpcuaClientFactory() { _clientFactory = null; }

const _state = {
  logger: null,
  dispatch: null,
  // systemId → { client, session, subscriptions: Map<bucketMs, sub>,
  //              monitoredGroups: Map<bucketMs, group>, status,
  //              lastError, bindings: [...] }
  systems: new Map(),
};

function strictMode(env = process.env) {
  if (/^(1|true|yes|on)$/i.test(String(env.FORGE_STRICT_CONFIG || ""))) return true;
  return env.NODE_ENV === "production";
}

function resolveSecurity(node_opcua, env = process.env) {
  const { MessageSecurityMode, SecurityPolicy } = node_opcua;
  const modeName = String(env.FORGE_OPCUA_SECURITY_MODE || (strictMode(env) ? "SignAndEncrypt" : "None"));
  const policyName = String(env.FORGE_OPCUA_SECURITY_POLICY || (strictMode(env) ? "Basic256Sha256" : "None"));
  if (strictMode(env) && (modeName === "None" || policyName === "None")) {
    throw new Error(
      "OPC UA registry in strict/production mode requires FORGE_OPCUA_SECURITY_MODE and FORGE_OPCUA_SECURITY_POLICY to be set to non-None values; " +
      "received mode='" + modeName + "' policy='" + policyName + "'"
    );
  }
  return {
    mode: MessageSecurityMode[modeName] ?? MessageSecurityMode.None,
    policy: SecurityPolicy[policyName] ?? SecurityPolicy.None,
    modeName, policyName,
  };
}

async function defaultOpcuaClientFactory({ url, security, logger }) {
  const node_opcua = await import("node-opcua");
  const m = node_opcua.default || node_opcua;
  const client = m.OPCUAClient.create({
    applicationName: "FORGE",
    securityMode: security.mode,
    securityPolicy: security.policy,
    endpointMustExist: false,
    connectionStrategy: { initialDelay: 1000, maxRetry: 5, maxDelay: 60_000 },
  });
  return { client, node_opcua: m };
}

function listOpcuaBindings() {
  return db.prepare(`
    SELECT b.*, p.source_template AS pv_source_template
      FROM asset_point_bindings b
      LEFT JOIN asset_profile_versions p ON p.id = b.profile_version_id
     WHERE b.source_kind = 'opcua' AND b.enabled = 1
  `).all();
}

function listOpcuaSystems() {
  return db.prepare(`
    SELECT * FROM enterprise_systems
     WHERE LOWER(COALESCE(kind,     '')) = 'opcua'
        OR LOWER(COALESCE(category, '')) IN ('opcua','iot.broker','opc.client')
  `).all();
}

export async function init({ logger, dispatchSample }) {
  _state.logger = logger || console;
  _state.dispatch = dispatchSample;
  await rebuild();
}

export async function shutdown() {
  for (const sys of _state.systems.values()) {
    try { await sys.client?.disconnect?.(); } catch { /* swallow */ }
  }
  _state.systems.clear();
}

export function reload() {
  rebuild().catch(err => _state.logger?.warn?.({ err: String(err?.message || err) }, "[opcua-registry] rebuild failed"));
}

async function rebuild() {
  // Tear down current sessions; re-build from DB. The disruption is
  // bounded by the orchestrator's debounce so bulk apply-profile
  // does one rebuild, not N.
  for (const sys of _state.systems.values()) {
    try { await sys.client?.disconnect?.(); } catch { /* swallow */ }
  }
  _state.systems.clear();

  const allSystems = listOpcuaSystems();
  const allBindings = listOpcuaBindings();
  const bindingsBySystem = new Map();
  for (const b of allBindings) {
    if (!b.system_id) continue;
    if (!bindingsBySystem.has(b.system_id)) bindingsBySystem.set(b.system_id, []);
    bindingsBySystem.get(b.system_id).push(b);
  }

  for (const system of allSystems) {
    const bindings = bindingsBySystem.get(system.id) || [];
    if (!bindings.length) continue; // no point connecting
    try {
      await startSystem(system, bindings);
    } catch (err) {
      _state.logger?.warn?.({ err: String(err?.message || err), systemId: system.id }, "[opcua-registry] startSystem failed");
    }
  }
}

async function startSystem(system, bindings) {
  if (!system.base_url) {
    _state.logger?.warn?.({ systemId: system.id }, "[opcua-registry] system has no base_url; skipping");
    return;
  }
  let security;
  try { security = (await import("node-opcua")).default ? resolveSecurity((await import("node-opcua")).default) : resolveSecurity(await import("node-opcua")); }
  catch (err) {
    _state.logger?.warn?.({ err: String(err?.message || err), systemId: system.id }, "[opcua-registry] insecure config refused");
    return;
  }

  const factory = _clientFactory || defaultOpcuaClientFactory;
  let factoryResult;
  try {
    factoryResult = await factory({ url: system.base_url, security, logger: _state.logger, system });
  } catch (err) {
    _state.logger?.warn?.({ err: String(err?.message || err), systemId: system.id }, "[opcua-registry] client factory failed");
    return;
  }
  const { client, node_opcua } = factoryResult;
  const sysState = {
    client,
    session: null,
    status: "connecting",
    lastError: null,
    subscriptions: new Map(),
    bindings,
    node_opcua,
  };
  _state.systems.set(system.id, sysState);

  try {
    await client.connect(system.base_url);
    sysState.session = await client.createSession();
    sysState.status = "connected";
  } catch (err) {
    sysState.lastError = String(err?.message || err);
    sysState.status = "error";
    _state.logger?.warn?.({ err: sysState.lastError, systemId: system.id }, "[opcua-registry] connect failed");
    return;
  }

  // Bucket bindings by requested publishing interval.
  /** @type {Map<number, any[]>} */
  const buckets = new Map();
  for (const b of bindings) {
    const tpl = jsonOrDefault(b.pv_source_template, {});
    const requested = Number(tpl.publishing_interval_ms) || 1000;
    const bucket = pickBucket(requested);
    if (!buckets.has(bucket)) buckets.set(bucket, []);
    buckets.get(bucket).push(b);
  }

  for (const [bucketMs, bucketBindings] of buckets.entries()) {
    try {
      await createSubscriptionForBucket({ sysState, bucketMs, bucketBindings, system });
    } catch (err) {
      _state.logger?.warn?.({ err: String(err?.message || err), systemId: system.id, bucketMs }, "[opcua-registry] subscription bucket failed");
    }
  }
}

async function createSubscriptionForBucket({ sysState, bucketMs, bucketBindings, system }) {
  const m = sysState.node_opcua;
  const subscription = m.ClientSubscription.create(sysState.session, {
    requestedPublishingInterval: bucketMs,
    requestedLifetimeCount: 100,
    requestedMaxKeepAliveCount: 10,
    maxNotificationsPerPublish: 200,
    publishingEnabled: true,
    priority: 10,
  });
  sysState.subscriptions.set(bucketMs, subscription);

  // Batch the create. We register monitored items in chunks of 500
  // via ClientMonitoredItemGroup.create(); the underlying service
  // call is a single CreateMonitoredItems request per chunk so the
  // subscription's setup time is constant in subscription count and
  // linear in chunk count, not items.
  const ITEMS_PER_GROUP = 500;
  for (let i = 0; i < bucketBindings.length; i += ITEMS_PER_GROUP) {
    const chunk = bucketBindings.slice(i, i + ITEMS_PER_GROUP);
    const itemsToMonitor = chunk.map(b => ({
      nodeId: b.source_path, // resolved per-asset OPC UA node id
      attributeId: m.AttributeIds.Value,
    }));
    const monitoringParameters = {
      samplingInterval: bucketMs,
      discardOldest: true,
      // Analog signal default; alarm/event nodes can override in a
      // follow-up phase by carrying queue_size on the binding.
      queueSize: 1,
    };
    // Span the per-chunk CreateMonitoredItems batch so operators with
    // OTel can spot slow OPC UA servers + correlate timeouts to specific
    // (system, publishing-interval, chunk-size) combinations.
    let group;
    try {
      group = await withSpan("opcua.monitorItems", {
        system_id: system.id,
        bucket_ms: bucketMs,
        chunk_size: chunk.length,
      }, async () => m.ClientMonitoredItemGroup.create(
        subscription,
        itemsToMonitor,
        monitoringParameters,
        m.TimestampsToReturn.Both,
      ));
    } catch (err) {
      _state.logger?.warn?.({ err: String(err?.message || err), systemId: system.id, bucketMs, chunkSize: chunk.length }, "[opcua-registry] monitored item group failed");
      continue;
    }

    // Wire each item's "changed" event to a dispatch. node-opcua's
    // group exposes `monitoredItems[i]` aligned with the input order.
    const monitoredItems = group.monitoredItems || group._monitoredItems || [];
    chunk.forEach((b, idx) => {
      const item = monitoredItems[idx];
      if (!item || typeof item.on !== "function") return;
      item.on("changed", (dataValue) => {
        const value = dataValue?.value?.value;
        const ts = dataValue?.sourceTimestamp?.toISOString?.() || dataValue?.serverTimestamp?.toISOString?.() || new Date().toISOString();
        const numeric = (typeof value === "number" || typeof value === "bigint") ? Number(value) : Number.parseFloat(String(value));
        const quality = dataValue?.statusCode?.name || "Good";
        _state.dispatch({
          binding: b,
          value: Number.isFinite(numeric) ? numeric : 0,
          ts,
          quality: Number.isFinite(numeric) ? quality : "Uncertain",
          raw: { nodeId: b.source_path, source: "opcua" },
        }).catch(err => _state.logger?.warn?.({ err: String(err?.message || err), bindingId: b.id }, "[opcua-registry] dispatch failed"));
      });
      item.on("err", (err) => {
        _state.logger?.warn?.({ err: String(err?.message || err), bindingId: b.id }, "[opcua-registry] monitored item error");
      });
    });
  }
}

/**
 * Phase 7c — writeback. Drive a value back to the registered
 * external OPC UA server through the open Session.write call.
 * Returns `{ ok }` matching the MQTT registry's writeback shape
 * so the connector orchestrator's router can fan out uniformly.
 *
 * Caller is `server/connectors/registry.js`'s
 * `writeBindingValue()` orchestrator, invoked by the
 * `device.write`-gated `POST /api/tags/:pointId/write` route.
 *
 * Status code semantics: `result.statusCode.name === "Good"` is
 * success per OPC UA spec; anything else surfaces as the
 * structured error.
 */
export async function writeBindingValue({ binding, value }) {
  if (!binding || !binding.system_id || !binding.source_path) {
    return { ok: false, code: "missing_binding_fields", message: "binding has no system_id or source_path" };
  }
  const sysState = _state.systems.get(binding.system_id);
  if (!sysState || sysState.status !== "connected" || !sysState.session) {
    return { ok: false, code: "session_unavailable", message: `OPC UA session for system ${binding.system_id} is not connected` };
  }
  const m = sysState.node_opcua;
  try {
    const numeric = Number(value);
    const dataValue = {
      value: { dataType: m.DataType.Double, value: numeric },
    };
    const result = await sysState.session.write({
      nodeId: binding.source_path,
      attributeId: m.AttributeIds.Value,
      value: dataValue,
    });
    const statusName = result?.name || result?.statusCode?.name || "Good";
    if (statusName !== "Good") {
      return { ok: false, code: "bad_status", message: `OPC UA write returned ${statusName}` };
    }
    return { ok: true, nodeId: binding.source_path };
  } catch (err) {
    _state.logger?.warn?.({ err: String(err?.message || err), bindingId: binding.id }, "[opcua-registry] writeback failed");
    return { ok: false, code: "write_failed", message: String(err?.message || err) };
  }
}

// Test-harness introspection.
export const _internals = { state: _state, pickBucket, PUBLISHING_BUCKETS_MS };
