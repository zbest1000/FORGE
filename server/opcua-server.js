// Lightweight OPC UA server.
//
// Spec ref: docs/INDUSTRIAL_EDGE_PLATFORM_SPEC.md §7.1 — "FORGE
// must expose its full tag tree as an OPC UA server so any OPC UA
// client (SCADA, MES, historian, BI tool) can browse and subscribe
// to FORGE data". The server is "the canonical path for legacy
// SCADA and MES systems that cannot consume REST or MQTT" — not
// optional for industrial deployments.
//
// Phases 5 + 7b together ship:
//   - Browse + Read + Subscribe of the asset hierarchy
//     (Enterprise → Location → Asset → DataPoint).
//   - **Historical Read (HistoryRead service, Phase 7b)** — every
//     binding Variable installs a custom IVariableHistorian whose
//     `extractDataValues()` delegates to
//     `server/historians/index.js`'s `readHistorianSamples()`. A
//     SCADA / MES client doing HA Read pulls real time-series
//     from whichever backend the binding's historian_point.historian
//     column points at: sqlite / influxdb / timebase / mssql /
//     postgresql / mysql.
//   - Address space derived automatically from `enterprises` /
//     `locations` / `assets` / `historian_points` / latest values
//     on `asset_point_bindings.last_value`.
//   - Variables refresh from the binding rows on each Read; for
//     Subscribe semantics node-opcua's address-space layer
//     auto-publishes when the underlying binding-attached
//     getter changes, so we update on each dispatched sample
//     via `refreshOpcuaServerForBinding()` exposed below.
//   - Security mode None for dev; Sign / SignAndEncrypt for prod
//     via FORGE_OPCUA_SERVER_SECURITY_MODE +
//     FORGE_OPCUA_SERVER_SECURITY_POLICY (defaults match the
//     client bridge's strict-mode posture in §15.1).
//   - Listening port FORGE_OPCUA_SERVER_PORT (default 4840 — the
//     OPC UA assigned port).
//   - Start gate: only boots when FORGE_OPCUA_SERVER_ENABLED=1.
//
// Out of scope for these phases (queued):
//   - Method calls (writeback) — high-risk; gated behind a
//     dedicated `device.write` capability in Phase 7c.
//   - Live address-space refresh on hierarchy / asset / binding
//     changes — Phase 7d.
//   - User-name/password / X.509 user authentication — anonymous
//     only at v0; SSO + token mapping later.

import { db, jsonOrDefault } from "./db.js";

let _server = null;
let _logger = null;
let _node_opcua = null;
let _addressSpace = null;
let _refreshHooks = new Map(); // bindingId → fn(value, ts, quality)

function strictMode(env = process.env) {
  if (/^(1|true|yes|on)$/i.test(String(env.FORGE_STRICT_CONFIG || ""))) return true;
  return env.NODE_ENV === "production";
}

function resolveServerSecurity(node_opcua, env = process.env) {
  const { MessageSecurityMode, SecurityPolicy } = node_opcua;
  // Server uses dedicated env vars so an operator can run a
  // FORGE-as-OPC-UA-server endpoint with different security than
  // the OPC UA *client* connecting to a plant historian.
  const modeName = String(env.FORGE_OPCUA_SERVER_SECURITY_MODE || (strictMode(env) ? "SignAndEncrypt" : "None"));
  const policyName = String(env.FORGE_OPCUA_SERVER_SECURITY_POLICY || (strictMode(env) ? "Basic256Sha256" : "None"));
  if (strictMode(env) && (modeName === "None" || policyName === "None")) {
    throw new Error(
      "OPC UA server in strict/production mode requires FORGE_OPCUA_SERVER_SECURITY_MODE + FORGE_OPCUA_SERVER_SECURITY_POLICY non-None"
    );
  }
  return {
    modeName, policyName,
    modes: [MessageSecurityMode[modeName] ?? MessageSecurityMode.None],
    policies: [SecurityPolicy[policyName] ?? SecurityPolicy.None],
  };
}

/**
 * Boot the OPC UA server.
 *
 * Caller is `server/main.js`. Returns `{ ok, port }` on success or
 * `{ ok: false, reason }` on disabled / failure. Failures are
 * non-fatal — the rest of the FORGE server keeps running.
 */
export async function startOpcuaServer({ logger } = {}) {
  _logger = logger || console;
  if (!/^(1|true|yes|on)$/i.test(String(process.env.FORGE_OPCUA_SERVER_ENABLED || ""))) {
    _logger.info?.({}, "[opcua-server] disabled (set FORGE_OPCUA_SERVER_ENABLED=1 to enable)");
    return { ok: false, reason: "disabled" };
  }

  let m;
  try {
    const node_opcua = await import("node-opcua");
    m = node_opcua.default || node_opcua;
  } catch (err) {
    _logger.warn?.({ err: String(err?.message || err) }, "[opcua-server] node-opcua not installed");
    return { ok: false, reason: "node-opcua missing" };
  }
  _node_opcua = m;

  let security;
  try { security = resolveServerSecurity(m); }
  catch (err) {
    _logger.error?.({ err: String(err?.message || err) }, "[opcua-server] insecure config refused");
    return { ok: false, reason: "insecure_config" };
  }

  const port = Number(process.env.FORGE_OPCUA_SERVER_PORT || 4840);
  const server = new m.OPCUAServer({
    port,
    resourcePath: "/forge",
    buildInfo: {
      productName: "FORGE OPC UA Server",
      buildNumber: "1",
      buildDate: new Date(),
    },
    serverInfo: { applicationName: { text: "FORGE", locale: "en-US" } },
    securityModes: security.modes,
    securityPolicies: security.policies,
    allowAnonymous: !strictMode(),
  });

  try {
    await server.initialize();
  } catch (err) {
    _logger.error?.({ err: String(err?.message || err) }, "[opcua-server] initialize failed");
    return { ok: false, reason: "initialize_failed" };
  }

  // Build the address space from current DB state. Calls to
  // refreshOpcuaServerForBinding() update the per-Variable getter
  // closure that node-opcua reads when a client subscribes / reads.
  buildAddressSpace(server);

  try {
    await server.start();
  } catch (err) {
    _logger.error?.({ err: String(err?.message || err) }, "[opcua-server] start failed");
    return { ok: false, reason: "start_failed" };
  }

  const endpoint = server.endpoints?.[0]?.endpointDescriptions()?.[0]?.endpointUrl;
  _server = server;
  _logger.info?.({ port, endpoint, securityMode: security.modeName, securityPolicy: security.policyName }, "[opcua-server] listening");
  return { ok: true, port, endpoint };
}

export async function stopOpcuaServer() {
  if (_server) {
    try { await _server.shutdown(0); }
    catch (err) { _logger?.warn?.({ err: String(err?.message || err) }, "[opcua-server] shutdown error"); }
  }
  _server = null;
  _refreshHooks = new Map();
}

export function getOpcuaServer() { return _server; }

/**
 * Public hook called by the connector orchestrator's
 * `dispatchSample()` after each new sample lands so the OPC UA
 * server's published value stays current. The hook is safe to
 * call when the server is disabled — it's a noop in that case.
 */
export function refreshOpcuaServerForBinding({ binding, value, ts, quality }) {
  if (!_server || !_node_opcua) return;
  const hook = _refreshHooks.get(binding.id);
  if (!hook) return;
  hook({ value, ts, quality });
}

// ----- Address space construction -----------------------------------------

function buildAddressSpace(server) {
  const m = _node_opcua;
  const addressSpace = server.engine.addressSpace;
  _addressSpace = addressSpace;
  // Custom namespace under `urn:forge:asset-tree`. Every browse
  // path under it derives from the live DB; calling
  // rebuildAddressSpace() (Phase 6) will refresh after big CRUD
  // events. For Phase 5 we build once at boot.
  const ns = addressSpace.registerNamespace("urn:forge:asset-tree");

  const rootFolder = addressSpace.findNode("ObjectsFolder")
    || addressSpace.rootFolder?.objects;

  const enterpriseRoot = ns.addObject({
    organizedBy: rootFolder,
    browseName: "Enterprises",
    description: "FORGE-managed enterprise → location → asset hierarchy",
  });

  const enterprises = db.prepare("SELECT * FROM enterprises ORDER BY org_id, sort_order, name").all();
  const locations = db.prepare("SELECT * FROM locations ORDER BY enterprise_id, sort_order, name").all();
  const assets = db.prepare("SELECT * FROM assets").all();
  const bindings = db.prepare(
    "SELECT b.*, hp.name AS point_name, hp.unit AS point_unit FROM asset_point_bindings b LEFT JOIN historian_points hp ON hp.id = b.point_id WHERE b.enabled = 1"
  ).all();

  // Index lookups for fast traversal.
  const locsByEnterprise = new Map();
  for (const l of locations) {
    if (!locsByEnterprise.has(l.enterprise_id)) locsByEnterprise.set(l.enterprise_id, []);
    locsByEnterprise.get(l.enterprise_id).push(l);
  }
  const childrenByLoc = new Map();
  for (const l of locations) {
    if (!l.parent_location_id) continue;
    if (!childrenByLoc.has(l.parent_location_id)) childrenByLoc.set(l.parent_location_id, []);
    childrenByLoc.get(l.parent_location_id).push(l);
  }
  const assetsByLoc = new Map();
  const assetsByEnt = new Map();
  for (const a of assets) {
    if (a.location_id) {
      if (!assetsByLoc.has(a.location_id)) assetsByLoc.set(a.location_id, []);
      assetsByLoc.get(a.location_id).push(a);
    } else if (a.enterprise_id) {
      if (!assetsByEnt.has(a.enterprise_id)) assetsByEnt.set(a.enterprise_id, []);
      assetsByEnt.get(a.enterprise_id).push(a);
    }
  }
  const bindingsByAsset = new Map();
  for (const b of bindings) {
    if (!bindingsByAsset.has(b.asset_id)) bindingsByAsset.set(b.asset_id, []);
    bindingsByAsset.get(b.asset_id).push(b);
  }

  function safeBrowseName(s) {
    return String(s || "node").replace(/[^A-Za-z0-9_\-]/g, "_") || "node";
  }

  for (const ent of enterprises) {
    const entObj = ns.addObject({
      organizedBy: enterpriseRoot,
      browseName: safeBrowseName(ent.name),
      description: ent.description || ent.name,
    });
    // Top-level locations under this enterprise (parent_location_id IS NULL).
    const tops = (locsByEnterprise.get(ent.id) || []).filter(l => !l.parent_location_id);
    for (const top of tops) {
      addLocation(ns, entObj, top, childrenByLoc, assetsByLoc, bindingsByAsset);
    }
    // Ungrouped assets directly under the enterprise.
    const ungrouped = assetsByEnt.get(ent.id) || [];
    for (const a of ungrouped) addAsset(ns, entObj, a, bindingsByAsset.get(a.id) || []);
  }
}

function addLocation(ns, parent, loc, childrenByLoc, assetsByLoc, bindingsByAsset) {
  const obj = ns.addObject({
    organizedBy: parent,
    browseName: String(loc.name).replace(/[^A-Za-z0-9_\-]/g, "_") || "loc",
    description: loc.kind ? `${loc.name} (${loc.kind})` : loc.name,
  });
  for (const child of (childrenByLoc.get(loc.id) || [])) {
    addLocation(ns, obj, child, childrenByLoc, assetsByLoc, bindingsByAsset);
  }
  for (const a of (assetsByLoc.get(loc.id) || [])) {
    addAsset(ns, obj, a, bindingsByAsset.get(a.id) || []);
  }
}

function addAsset(ns, parent, asset, bindings) {
  const m = _node_opcua;
  const obj = ns.addObject({
    organizedBy: parent,
    browseName: String(asset.name).replace(/[^A-Za-z0-9_\-]/g, "_") || "asset",
    description: asset.type ? `${asset.name} (${asset.type})` : asset.name,
  });
  for (const b of bindings) {
    addBindingVariable(ns, obj, b);
  }
}

function addBindingVariable(ns, parent, binding) {
  const m = _node_opcua;
  // Closure-captured "live value" + "live timestamp" + "live
  // quality"; refreshOpcuaServerForBinding() flips these atomically
  // when a new sample arrives.
  let liveValue = Number(binding.last_value ?? 0) || 0;
  let liveTs = binding.last_seen || new Date().toISOString();
  let liveQuality = binding.point_unit || binding.last_quality || "Good";
  _refreshHooks.set(binding.id, ({ value, ts, quality }) => {
    if (Number.isFinite(value)) liveValue = value;
    if (ts) liveTs = ts;
    if (quality) liveQuality = quality;
  });

  const browseName = String(binding.point_name || `binding_${binding.id}`).replace(/[^A-Za-z0-9_\-]/g, "_");
  const variable = ns.addVariable({
    componentOf: parent,
    browseName,
    description: binding.source_path,
    dataType: "Double",
    value: {
      // Functional getter — node-opcua calls this on every Read /
      // Subscribe-Notify cycle. Returning a fresh DataValue keeps
      // server-side caching honest.
      get: () => new m.Variant({ dataType: m.DataType.Double, value: Number(liveValue) }),
    },
  });

  // Phase 7b — install the HistoryRead service on this Variable.
  // node-opcua's `installHistoricalDataNode(node, { historian })`
  // accepts a custom IVariableHistorian; we hand it one whose
  // `extractDataValues()` calls FORGE's `readHistorianSamples()`.
  // The historian column on the bound `historian_points` row picks
  // the storage backend (sqlite / influxdb / timebase / mssql /
  // postgresql / mysql), so a SCADA HA Read query against this
  // Variable transparently pulls from whichever backend the
  // operator configured.
  //
  // `maxOnlineValues: 0` disables node-opcua's in-memory ring
  // buffer — we don't want it racing the historian.
  if (binding.point_id && _addressSpace?.installHistoricalDataNode) {
    try {
      const historian = makeForgeHistorian(binding.point_id);
      _addressSpace.installHistoricalDataNode(variable, { historian, maxOnlineValues: 0 });
    } catch (err) {
      _logger?.warn?.({ err: String(err?.message || err), bindingId: binding.id }, "[opcua-server] HA install failed");
    }
  }
}

/**
 * Custom IVariableHistorian. node-opcua calls `extractDataValues()`
 * on every HistoryReadRaw request that lands on a Variable we've
 * installed historizing on. We translate the request into a
 * FORGE-historian query and return DataValues.
 *
 * `push()` is intentionally a no-op: every sample dispatched
 * through the connector orchestrator already lands in the FORGE
 * historian (sqlite cache + write-through to the configured
 * backend) via `dispatchSample()`. Letting node-opcua double-
 * account in its own ring buffer would cause duplicate samples
 * on HA Read.
 */
function makeForgeHistorian(pointId) {
  const m = _node_opcua;
  return {
    async push(/* dataValue */) { /* see comment above */ },
    extractDataValues(historyReadRaw, maxNumberToExtract, isReversed, _reverseDataValue, callback) {
      (async () => {
        const point = db.prepare("SELECT * FROM historian_points WHERE id = ?").get(pointId);
        if (!point) return callback(null, []);
        const since = historyReadRaw.startTime
          ? new Date(historyReadRaw.startTime).toISOString()
          : new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const until = historyReadRaw.endTime
          ? new Date(historyReadRaw.endTime).toISOString()
          : new Date().toISOString();
        const limit = Math.max(1, Math.min(Number(maxNumberToExtract) || 1000, 50_000));
        try {
          const { readHistorianSamples } = await import("./historians/index.js");
          const { samples } = await readHistorianSamples(point, { since, until, limit });
          const out = samples.map(s => new m.DataValue({
            value: { dataType: m.DataType.Double, value: Number(s.value) },
            sourceTimestamp: new Date(s.ts),
            statusCode: m.StatusCodes.Good,
          }));
          if (isReversed) out.reverse();
          callback(null, out);
        } catch (err) {
          _logger?.warn?.({ err: String(err?.message || err), pointId }, "[opcua-server] HA extract failed");
          callback(null, []);
        }
      })();
    },
  };
}

// Test-harness introspection.
export const _internals = { state: () => ({ server: _server, hooks: _refreshHooks }), resolveServerSecurity };
