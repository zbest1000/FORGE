// Connector registry — orchestrator for the per-system clients
// (MQTT broker connections, OPC UA sessions, SQL pollers) that
// subscribe / read tag data on behalf of `asset_point_bindings`.
//
// Phase 3 of the Asset Dashboard plan ships the SKELETON + the SQL
// poller. Phase 4 adds the MQTT registry. Phase 5 adds OPC UA
// (client + lightweight server). The registry is the single seam
// where the rest of the codebase asks "(re)build subscriptions for
// this asset / this binding / this system" — all subregistries
// register through this module.
//
// Spec ref: docs/INDUSTRIAL_EDGE_PLATFORM_SPEC.md §1 (broker spine)
// + §2 (Tag) + §3 (driver plugin contract). Each subregistry is the
// FORGE expression of a "driver" in the spec sense, with the
// registry's `dispatchSample()` playing the role of the broker
// publish from spec §1.1.
//
// Design:
//   - `init({ logger })`        — boot every kind that's enabled
//   - `reload({ systemId?, bindingId?, assetId? })` — surgical resync,
//                                  debounced 250ms so bulk binding
//                                  apply doesn't churn the brokers
//   - `dispatchSample({ binding, value, ts, quality, raw })` —
//        called by subregistries when a sample arrives. Persists
//        through `historians/index.js`, broadcasts SSE, updates
//        last_value/last_seen on the binding row.
//   - `shutdown()` — clean disconnect during process-stop sequence
//        in `server/main.js`.

import { db, now } from "../db.js";
import { audit } from "../audit.js";
import { broadcast } from "../sse.js";
import * as sqlRegistry from "./sql-registry.js";
import * as mqttRegistry from "./mqtt-registry.js";
import * as opcuaRegistry from "./opcua-registry.js";
import { refreshOpcuaServerForBinding } from "../opcua-server.js";

const SUBREGISTRIES = [sqlRegistry, mqttRegistry, opcuaRegistry];

const _state = {
  logger: null,
  initialised: false,
  reloadTimer: null,
  pendingReload: { systems: new Set(), bindings: new Set(), assets: new Set() },
};

/**
 * Boot the registry. Called once from `server/main.js`.
 *
 * The `FORGE_DISABLE_CONNECTOR_REGISTRY=1` env flag lets test runs
 * disable the registry for in-process suites that don't want to
 * spin up SQL pollers (test/asset-bindings.test.js sets this).
 */
export async function init({ logger } = {}) {
  if (_state.initialised) return;
  _state.logger = logger || console;
  _state.initialised = true;
  if (process.env.FORGE_DISABLE_CONNECTOR_REGISTRY === "1") {
    _state.logger.info?.({ reason: "FORGE_DISABLE_CONNECTOR_REGISTRY=1" }, "[connector-registry] disabled");
    return;
  }
  for (const sub of SUBREGISTRIES) {
    if (typeof sub.init === "function") {
      try {
        await sub.init({ logger: _state.logger, dispatchSample });
      } catch (err) {
        _state.logger.error?.({ err: String(err?.message || err), kind: sub.KIND }, "[connector-registry] subregistry init failed");
      }
    }
  }
  _state.logger.info?.({ kinds: SUBREGISTRIES.map(s => s.KIND) }, "[connector-registry] initialised");
}

/**
 * Surgical reconcile of subscriptions. Routes call this after CRUD
 * touches a binding / system / asset; the call is debounced 250ms
 * so a flurry of writes (apply-profile applying N points at once)
 * collapses to one reconcile.
 */
export function reload({ systemId, bindingId, assetId } = {}) {
  if (!_state.initialised) return;
  if (process.env.FORGE_DISABLE_CONNECTOR_REGISTRY === "1") return;
  if (systemId) _state.pendingReload.systems.add(systemId);
  if (bindingId) _state.pendingReload.bindings.add(bindingId);
  if (assetId) _state.pendingReload.assets.add(assetId);
  if (_state.reloadTimer) return;
  _state.reloadTimer = setTimeout(() => {
    _state.reloadTimer = null;
    const pending = _state.pendingReload;
    _state.pendingReload = { systems: new Set(), bindings: new Set(), assets: new Set() };
    for (const sub of SUBREGISTRIES) {
      try {
        if (typeof sub.reload === "function") sub.reload(pending);
      } catch (err) {
        _state.logger.error?.({ err: String(err?.message || err), kind: sub.KIND }, "[connector-registry] subregistry reload failed");
      }
    }
  }, 250);
}

/**
 * Subregistries call this with each sample they receive. We persist
 * via the historian adapter, broadcast SSE, and update last_seen on
 * the binding row. `binding` is the row from `asset_point_bindings`
 * (with org_id + point_id resolved already).
 */
export async function dispatchSample({ binding, value, ts, quality = "Good", raw = null }) {
  if (!binding || binding.point_id == null) return;
  const sampleTs = ts || now();
  const stmt = db.prepare(`INSERT INTO historian_samples (id, point_id, ts, value, quality, source_type, raw_payload)
                           VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const sampleId = `HS-${Math.random().toString(36).slice(2, 14).toUpperCase()}`;
  stmt.run(sampleId, binding.point_id, sampleTs, Number(value), String(quality), `binding:${binding.source_kind}`, raw ? JSON.stringify(raw) : "{}");

  // Update the binding's "last seen" indicators so the dashboard card
  // can render fresh values via `/api/asset-tree` without a separate
  // round-trip.
  db.prepare("UPDATE asset_point_bindings SET last_value = ?, last_quality = ?, last_seen = ?, updated_at = ? WHERE id = ?")
    .run(Number(value), String(quality), sampleTs, now(), binding.id);

  // SSE broadcast — tenant-scoped + per-point sub-topic so the asset
  // detail screen can filter cheaply.
  broadcast("historian", { pointId: binding.point_id, assetId: binding.asset_id, value: Number(value), ts: sampleTs, quality }, binding.org_id);
  broadcast(`historian:point:${binding.point_id}`, { value: Number(value), ts: sampleTs, quality }, binding.org_id);

  // Phase 5: keep the FORGE-as-OPC-UA-server's published value in
  // sync. This is a noop when the server is disabled (the default
  // hook check returns early).
  try { refreshOpcuaServerForBinding({ binding, value: Number(value), ts: sampleTs, quality }); }
  catch { /* server-side hook errors must not break dispatch */ }
}

/**
 * Cleanly tear down all subregistries. Called from the shutdown
 * sequence in `server/main.js`.
 */
export async function shutdown() {
  if (!_state.initialised) return;
  if (_state.reloadTimer) { clearTimeout(_state.reloadTimer); _state.reloadTimer = null; }
  for (const sub of SUBREGISTRIES) {
    if (typeof sub.shutdown === "function") {
      try { await sub.shutdown(); }
      catch (err) { _state.logger?.warn?.({ err: String(err?.message || err), kind: sub.KIND }, "[connector-registry] shutdown error"); }
    }
  }
  _state.initialised = false;
  audit({ actor: "system", action: "connector_registry.stop" });
}

// Re-export for test-harness use.
export const _internals = { state: _state, SUBREGISTRIES };
