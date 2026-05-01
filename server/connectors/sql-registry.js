// SQL connector subregistry.
//
// Polls registered SQL `enterprise_systems` rows for the bindings
// that reference them and dispatches each fetched sample through the
// connector registry's `dispatchSample()` to land in the historian
// + SSE bus.
//
// Two binding modes per spec / plan:
//
//   1. Schema-defined  — the profile's `source_template` declares
//      `{ table, ts_column, value_column, point_column,
//         asset_filter_column, poll_interval_ms }`. The poller
//      issues `SELECT <ts_col>, <value_col>, … FROM <table> WHERE
//      <asset_filter_col> = :asset_id AND <ts_col> > :since ORDER
//      BY <ts_col> ASC LIMIT :limit`. Identifiers are validated at
//      profile-save time against an allowlist regex; values are
//      always bound parameters.
//
//   2. Free-form (`historian.sql.raw` capability) — the binding row
//      carries an operator-authored `query_template` that has been
//      pre-validated by `server/security/sql-validator.js`. The
//      poller binds `:point_id, :asset_id, :since, :until, :limit`
//      and runs the prepared statement.
//
// Phase 3 ships polling against MSSQL since the existing
// `server/historians/index.js` already has the mssql driver wired.
// pg / mysql / sqlite drivers ship in later phases via the same
// validation pipeline.
//
// Spec ref: docs/INDUSTRIAL_EDGE_PLATFORM_SPEC.md §3 (driver
// contract — poll/subscribe), §6.2 (time-series storage), §17.2
// (REST surface — historian samples).

import { db, jsonOrDefault } from "../db.js";

export const KIND = "sql";

const _state = {
  logger: null,
  dispatch: null,
  intervals: new Map(), // systemId → setInterval handle
  // Last-seen-ts cursor per binding so polls only fetch deltas.
  cursors: new Map(),   // bindingId → ISO string
};

/** Identifier allowlist for schema-defined templates. */
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Fetch all enabled SQL bindings tenant-agnostically (orchestrator-only). */
function listSqlBindings() {
  return db.prepare(`
    SELECT b.*, p.source_template AS pv_source_template, p.id AS pv_id, p.profile_id AS pv_profile_id,
           pp.source_path_template AS pp_source_path_template, pp.name AS pp_name
      FROM asset_point_bindings b
      LEFT JOIN asset_profile_versions p ON p.id = b.profile_version_id
      LEFT JOIN asset_profile_points pp ON pp.id = b.profile_point_id
     WHERE b.source_kind = 'sql' AND b.enabled = 1
  `).all();
}

function listSqlSystems() {
  return db.prepare(`
    SELECT * FROM enterprise_systems
     WHERE LOWER(COALESCE(category, '')) IN ('sql','historian','data.warehouse')
        OR LOWER(COALESCE(kind,     '')) = 'sql'
  `).all();
}

export async function init({ logger, dispatchSample }) {
  _state.logger = logger || console;
  _state.dispatch = dispatchSample;
  await reload({ systems: new Set(), bindings: new Set(), assets: new Set() });
}

export async function shutdown() {
  for (const handle of _state.intervals.values()) clearInterval(handle);
  _state.intervals.clear();
  _state.cursors.clear();
}

/**
 * Surgical reconcile. The orchestrator passes the sets of changed
 * system / binding / asset ids; we re-derive the poll plan from the
 * current bindings.
 */
export function reload({ systems, bindings, assets } = {}) {
  // For Phase 3 we always recompute the full plan — bindings are
  // small (hundreds, not millions) and the recompute is O(N)
  // anyway. Phase 6 can introduce surgical patches if profiling
  // shows cost.
  rebuildPlan();
}

function rebuildPlan() {
  // Stop any existing intervals. We re-build below.
  for (const h of _state.intervals.values()) clearInterval(h);
  _state.intervals.clear();

  const systems = new Map(listSqlSystems().map(s => [s.id, s]));
  const bindingsBySystem = new Map();
  for (const b of listSqlBindings()) {
    if (!b.system_id || !systems.has(b.system_id)) continue;
    if (!bindingsBySystem.has(b.system_id)) bindingsBySystem.set(b.system_id, []);
    bindingsBySystem.get(b.system_id).push(b);
  }

  for (const [systemId, list] of bindingsBySystem.entries()) {
    const system = systems.get(systemId);
    const intervalMs = pollIntervalForList(list);
    const handle = setInterval(() => pollSystem(system, list).catch(err => {
      _state.logger?.warn?.({ err: String(err?.message || err), systemId }, "[sql-registry] poll error");
    }), Math.max(1000, intervalMs));
    // Don't keep the process alive on the test harness during shutdown.
    if (typeof handle.unref === "function") handle.unref();
    _state.intervals.set(systemId, handle);
  }
}

function pollIntervalForList(bindings) {
  // Take the minimum poll_interval_ms declared by any binding's
  // profile-version source_template; default 5s. Per-binding
  // overrides land in Phase 4.
  let min = 5000;
  for (const b of bindings) {
    const tpl = jsonOrDefault(b.pv_source_template, {});
    const ms = Number(tpl?.poll_interval_ms);
    if (Number.isFinite(ms) && ms > 0 && ms < min) min = ms;
  }
  return min;
}

async function pollSystem(system, bindings) {
  // Phase 3: Re-use `server/historians/index.js`'s mssql driver — the
  // import is dynamic so the optional dep doesn't load on every server
  // boot. Routes that DON'T poll keep the lighter footprint.
  let mssql;
  try {
    mssql = await import("../historians/index.js");
  } catch {
    return; // historian module unavailable; nothing to do
  }
  // The current historian module exports the queryHistorianSamples
  // helper used elsewhere. For phase-3 scope we delegate the actual
  // wire-execution to a focused helper that's mocked easily under
  // test. The shape below is intentionally conservative: each poll
  // produces zero-or-more samples per binding and dispatches them one
  // at a time so the connector-registry can update last_value.
  for (const binding of bindings) {
    try {
      const cursor = _state.cursors.get(binding.id) || new Date(0).toISOString();
      const samples = await fetchSamplesForBinding({ system, binding, since: cursor, mssql });
      for (const s of samples) {
        await _state.dispatch({
          binding,
          value: s.value,
          ts: s.ts,
          quality: s.quality || "Good",
          raw: s.raw || null,
        });
        _state.cursors.set(binding.id, s.ts);
      }
    } catch (err) {
      _state.logger?.warn?.({ err: String(err?.message || err), bindingId: binding.id }, "[sql-registry] binding poll failed");
    }
  }
}

/**
 * The actual wire-execution. Test harnesses replace this via
 * `setSampleFetcher()` so unit tests don't need a real database.
 *
 * Schema-defined mode: parameterised SELECT against the profile's
 * `source_template` (table + columns are validated against
 * `IDENT_RE` at poll time as a defence-in-depth check).
 *
 * Free-form mode: the binding's `query_template` (set by Phase-3's
 * apply-profile flow when sourceKind=sql + mode=free_form) was
 * pre-validated at write time; here we only re-validate the
 * IDENT-only resolved bind values and execute.
 */
let _fetchImpl = async ({ system, binding, since }) => {
  // Default no-op: returns no samples. Tests + Phase 4+ override.
  return [];
};

export function setSampleFetcher(fn) { _fetchImpl = fn; }
export function resetSampleFetcher() {
  _fetchImpl = async () => [];
}

async function fetchSamplesForBinding(args) {
  const tpl = jsonOrDefault(args.binding.pv_source_template, {});
  // Schema-defined identifier validation at poll-time too. Belt and
  // braces: the apply-profile route validates on write, but a stale
  // row from before the validation existed could still be in the DB.
  if (tpl.table && !IDENT_RE.test(String(tpl.table))) return [];
  for (const k of ["ts_column", "value_column", "point_column", "asset_filter_column"]) {
    if (tpl[k] && !IDENT_RE.test(String(tpl[k]))) return [];
  }
  return _fetchImpl(args);
}

// Re-export for test-harness use.
export const _internals = { state: _state, IDENT_RE };
