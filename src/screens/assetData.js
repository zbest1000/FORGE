// Asset Data tab — Live + Historical view.
//
// Mounted by `src/screens/assetDetail.js` on the Data tab. Renders
// one eCharts trend per binding via the existing `historianChart()`
// helper. A Live | Historical toggle drives the data source:
//
//   - Live      → opens an EventSource on /api/events/stream with the
//                 cached bearer token (?token=… because EventSource
//                 can't set Authorization headers) and filters
//                 `historian` events by assetId. A rolling 200-sample
//                 buffer per binding feeds the chart; re-renders are
//                 debounced via requestAnimationFrame.
//   - Historical → fetches /api/historian/samples?pointId=…&since=…
//                  &until=… for each binding's pointId and renders
//                  the trend over the chosen window (24h, 7d, 30d,
//                  custom).
//
// Demo mode (no server): falls back to seed historian samples so the
// asset detail screen looks alive offline. No SSE.
//
// Spec ref: docs/INDUSTRIAL_EDGE_PLATFORM_SPEC.md §1.2 (broker-as-
// backbone), §6.2 (time-series storage), §17.2 (REST endpoints
// `/api/historian/samples`), §17.3 (SSE / GraphQL subscriptions —
// FORGE uses SSE today; GraphQL subscriptions in a later phase).

import { el, mount, card, badge, select, toast } from "../core/ui.js";
import { state } from "../core/store.js";
import { api, getToken } from "../core/api.js";
import { historianChart, sparkline } from "../core/charts.js";

const SS_MODE = (assetId) => `asset.data.mode.${assetId}`;
const SS_RANGE = (assetId) => `asset.data.range.${assetId}`;
const ROLLING_WINDOW = Number(/** @type {any} */ (window).__FORGE_LIVE_BUFFER || 200);

const RANGE_OPTIONS = [
  { value: "1h",  label: "Last 1 hour",  ms: 60 * 60 * 1000 },
  { value: "24h", label: "Last 24 hours", ms: 24 * 60 * 60 * 1000 },
  { value: "7d",  label: "Last 7 days",   ms: 7 * 24 * 60 * 60 * 1000 },
  { value: "30d", label: "Last 30 days",  ms: 30 * 24 * 60 * 60 * 1000 },
];

/**
 * Public entry point. Renders into the supplied target node.
 *
 * Each invocation tears down any previously-attached SSE source +
 * timers so the user toggling tabs / modes never leaks resources.
 */
export async function renderAssetData({ assetId, target }) {
  if (!target) return;
  // Tear down anything from a previous mount.
  cleanupForTarget(target);

  if (!state.server?.connected) {
    mount(target, [renderDemoNotice(assetId)]);
    return;
  }

  mount(target, [el("div", { class: "muted tiny" }, ["Loading bindings…"])]);
  let bindings = [];
  try {
    bindings = await api(`/api/assets/${assetId}/bindings`);
  } catch (err) {
    mount(target, [
      card("Asset data", el("div", { class: "stack" }, [
        el("div", { class: "callout danger" }, [`Failed to load bindings: ${err?.message || err}`]),
      ])),
    ]);
    return;
  }
  bindings = bindings.filter(b => b.enabled && b.pointId);

  if (!bindings.length) {
    mount(target, [
      card("Asset data", el("div", { class: "stack" }, [
        el("p", { class: "muted" }, [
          "No bindings yet. Apply a profile or define a custom mapping under the Configuration tab to start streaming data into this asset.",
        ]),
      ])),
    ]);
    return;
  }

  const mode = sessionStorage.getItem(SS_MODE(assetId)) || "live";
  const range = sessionStorage.getItem(SS_RANGE(assetId)) || "24h";

  const head = headerRow({ assetId, mode, range });
  const grid = el("div", { class: "card-grid" });
  mount(target, [head, grid]);

  if (mode === "live") {
    await renderLive({ assetId, bindings, target, grid });
  } else {
    await renderHistorical({ assetId, bindings, range, grid });
  }
}

function renderDemoNotice(assetId) {
  // Demo mode (no live server) — render the historian points seeded
  // on this asset directly. Each point gets a sparkline of its
  // seeded samples plus a status row with last-known VQT. This isn't
  // SSE-driven (no live updates) but gives the user a real, populated
  // tab instead of a "sign in to see anything" placeholder.
  const d = state.data || {};
  const points = (d.historianPoints || []).filter(p => p.assetId === assetId);
  const samplesByPoint = (() => {
    const map = new Map();
    for (const s of (d.historianSamples || [])) {
      const arr = map.get(s.pointId) || [];
      arr.push(s);
      map.set(s.pointId, arr);
    }
    for (const arr of map.values()) arr.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    return map;
  })();

  const bindings = (d.dataSources || []).filter(ds => ds.assetId === assetId);

  if (!points.length && !bindings.length) {
    return card("Live & Historical Data", el("div", { class: "stack" }, [
      el("p", { class: "muted" }, [
        "No historian points or data sources are seeded for this asset yet. ",
        "Apply a profile under the Configuration tab to wire signals from MQTT, OPC UA, or SQL.",
      ]),
    ]));
  }

  const grid = el("div", { class: "card-grid" });
  for (const p of points) {
    const samples = samplesByPoint.get(p.id) || [];
    const last = samples[samples.length - 1];
    const series = samples.map(s => Number(s.value)).filter(v => Number.isFinite(v));
    const node = el("div", { class: "stack" }, [
      el("div", { class: "row wrap" }, [
        el("span", { class: "kpi-value", style: { fontSize: "24px" } }, [
          last && Number.isFinite(Number(last.value)) ? Number(last.value).toFixed(2) : "—",
        ]),
        el("span", { class: "tiny muted" }, [p.unit || ""]),
        last ? badge(last.quality || "—", last.quality === "Good" ? "success" : last.quality === "Bad" ? "danger" : "warn") : null,
      ]),
      series.length
        ? sparkline(series, { width: 280, height: 60, label: p.name })
        : el("div", { class: "tiny muted" }, ["No samples seeded yet."]),
      el("div", { class: "tiny muted" }, [
        last ? `Last sample ${new Date(last.ts).toLocaleString()}` : "No samples",
      ]),
      el("div", { class: "tiny mono muted" }, [p.tag || ""]),
    ]);
    grid.append(card(`${p.name || p.id}`, node, { subtitle: p.tag }));
  }

  return el("div", { class: "stack" }, [
    el("div", { class: "row spread" }, [
      el("div", {}, [
        el("div", { class: "strong" }, ["Live & Historical (offline)"]),
        el("div", { class: "tiny muted" }, [
          `${points.length} historian point${points.length === 1 ? "" : "s"} · ${bindings.length} data source${bindings.length === 1 ? "" : "s"} · seeded values`,
        ]),
      ]),
      el("div", { class: "row" }, [
        badge("DEMO", "warn", { title: "Connect to a FORGE server for live SSE updates and historical queries." }),
      ]),
    ]),
    grid,
    bindings.length
      ? card("Data sources", el("table", { class: "table" }, [
          el("thead", {}, [el("tr", {}, ["Connector", "Endpoint", "Last value", "Status"].map(h => el("th", {}, [h])))]),
          el("tbody", {}, bindings.map(b => el("tr", {}, [
            el("td", {}, [badge((b.kind || "—").toUpperCase(), "info")]),
            el("td", { class: "mono tiny" }, [b.endpoint || "—"]),
            el("td", {}, [b.lastValue || "—"]),
            el("td", {}, [badge(b.status || "—", b.status === "live" ? "success" : b.status === "stale" ? "warn" : "")]),
          ]))),
        ]), { subtitle: "Seeded source bindings — live updates require a server connection." })
      : null,
  ]);
}

function headerRow({ assetId, mode, range }) {
  const modeSel = select([
    { value: "live", label: "Live" },
    { value: "historical", label: "Historical" },
  ], { value: mode, onChange: (e) => {
    sessionStorage.setItem(SS_MODE(assetId), e.target.value);
    // Re-render the parent target node.
    const target = document.querySelector("#asset-data-target");
    if (target) renderAssetData({ assetId, target });
  }});
  const rangeSel = mode === "historical"
    ? select(RANGE_OPTIONS.map(r => ({ value: r.value, label: r.label })), { value: range, onChange: (e) => {
        sessionStorage.setItem(SS_RANGE(assetId), e.target.value);
        const target = document.querySelector("#asset-data-target");
        if (target) renderAssetData({ assetId, target });
      }})
    : null;
  return el("div", { class: "row spread", style: { marginBottom: "12px" } }, [
    el("div", {}, [
      el("div", { class: "strong" }, ["Live & Historical"]),
      el("div", { class: "tiny muted" }, [
        mode === "live"
          ? `Streaming via SSE · rolling window ${ROLLING_WINDOW} samples/point`
          : "Historical query against /api/historian/samples",
      ]),
    ]),
    el("div", { class: "row wrap", style: { gap: "8px" } }, [
      mode === "live" ? badge("LIVE", "success") : badge("HISTORICAL", "info"),
      el("label", { class: "tiny muted" }, ["Mode"]),
      modeSel,
      rangeSel ? el("label", { class: "tiny muted" }, ["Range"]) : null,
      rangeSel,
    ]),
  ]);
}

// ---------- Live mode ------------------------------------------------------

async function renderLive({ assetId, bindings, target, grid }) {
  // Per-binding state: chart node, sample buffer, dirty flag.
  /** @type {Map<string, { node: HTMLElement, samples: any[], dirty: boolean, binding: any }>} */
  const charts = new Map();

  // Seed each chart with the binding's last_seen value if present so
  // the user sees something the moment they open the tab.
  for (const b of bindings) {
    const node = el("div", { class: "stack" }, [el("div", { class: "tiny muted" }, ["Waiting for live data…"])]);
    grid.append(card(`${pretty(b)} · ${b.sourceKind.toUpperCase()}`, node, {
      subtitle: b.sourcePath,
    }));
    const seed = b.lastValue != null && b.lastSeen
      ? [{ ts: b.lastSeen, value: Number(b.lastValue), quality: b.lastQuality || "Good" }]
      : [];
    charts.set(b.pointId, { node, samples: seed, dirty: !!seed.length, binding: b });
  }

  // Single rAF debouncer for the whole tab — rendering N charts
  // sequentially is cheaper than rendering one-per-message.
  let raf = null;
  const flush = () => {
    raf = null;
    for (const [, st] of charts) {
      if (!st.dirty) continue;
      st.dirty = false;
      // Re-render: replace the chart node's children with a fresh
      // historianChart of the buffer.
      st.node.innerHTML = "";
      const ch = historianChart(st.samples, { title: pretty(st.binding), unit: pretty(st.binding, "unit"), type: "line" });
      st.node.append(ch);
      st.node.append(el("div", { class: "tiny muted", style: { marginTop: "4px" } }, [
        `${st.samples.length} sample${st.samples.length === 1 ? "" : "s"} · last ${st.samples.length ? new Date(st.samples[st.samples.length - 1].ts).toLocaleTimeString() : "—"}`,
      ]));
    }
  };
  const scheduleFlush = () => {
    if (raf != null) return;
    raf = requestAnimationFrame(flush);
  };
  // Initial render so the seeded buffer shows up.
  scheduleFlush();

  // Open the SSE source. EventSource can't set headers; we pass the
  // cached bearer token via ?token (the auth resolver in
  // server/main.js explicitly allows query-string auth ONLY on
  // /api/events/stream — see QUERY_AUTH_PATHS).
  const token = getToken();
  const url = token ? `/api/events/stream?token=${encodeURIComponent(token)}` : "/api/events/stream";
  let es;
  try {
    es = new EventSource(url, { withCredentials: false });
  } catch (err) {
    toast(`Live stream unavailable: ${err?.message || err}`, "warn");
    return;
  }

  // We listen on the named `historian` event (org-scoped broadcast)
  // and on the per-point sub-topic for sub-millisecond per-binding
  // routing.
  function handleHistorianPayload(data) {
    if (!data || !data.pointId) return;
    if (data.assetId && data.assetId !== assetId) return; // not us
    const st = charts.get(data.pointId);
    if (!st) return;
    st.samples.push({ ts: data.ts, value: Number(data.value), quality: data.quality || "Good" });
    if (st.samples.length > ROLLING_WINDOW) st.samples.splice(0, st.samples.length - ROLLING_WINDOW);
    st.dirty = true;
    scheduleFlush();
  }
  const handler = (ev) => {
    try { handleHistorianPayload(JSON.parse(ev.data)); }
    catch { /* malformed payload — ignore */ }
  };
  es.addEventListener("historian", handler);
  // Per-point topic carries fewer fields; reuse same path.
  for (const b of bindings) {
    es.addEventListener(`historian:point:${b.pointId}`, (ev) => {
      try {
        const payload = JSON.parse(ev.data);
        handleHistorianPayload({ ...payload, pointId: b.pointId, assetId });
      } catch { /* ignore */ }
    });
  }
  es.addEventListener("dropped", () => {
    toast("SSE dropped events under load — chart may have gaps", "warn");
  });
  es.onerror = () => {
    // Browsers auto-reconnect on transient errors; a clean close on
    // logout / shutdown will close the eventsource silently.
  };

  // Stash teardown on the target node so a re-render or tab switch
  // can clean up cleanly.
  attachCleanup(target, () => {
    if (raf != null) cancelAnimationFrame(raf);
    try { es.close(); } catch { /* swallow */ }
  });
}

// ---------- Historical mode -------------------------------------------------

async function renderHistorical({ assetId, bindings, range, grid }) {
  const opt = RANGE_OPTIONS.find(r => r.value === range) || RANGE_OPTIONS[1];
  const until = new Date();
  const since = new Date(until.getTime() - opt.ms);
  for (const b of bindings) {
    const target = el("div", { class: "stack" }, [el("div", { class: "tiny muted" }, ["Loading…"])]);
    grid.append(card(`${pretty(b)} · ${b.sourceKind.toUpperCase()}`, target, { subtitle: b.sourcePath }));
    api(`/api/historian/samples?pointId=${encodeURIComponent(b.pointId)}&since=${encodeURIComponent(since.toISOString())}&until=${encodeURIComponent(until.toISOString())}&limit=2000`).then((res) => {
      const samples = (res?.samples || []).map(s => ({ ts: s.ts, value: Number(s.value), quality: s.quality || "Good" }));
      target.innerHTML = "";
      if (!samples.length) {
        target.append(el("div", { class: "muted tiny" }, [`No samples in the last ${opt.label.toLowerCase().replace("last ", "")}.`]));
        return;
      }
      target.append(historianChart(samples, { title: pretty(b), unit: pretty(b, "unit"), type: "line" }));
      target.append(el("div", { class: "tiny muted", style: { marginTop: "4px" } }, [
        `${samples.length} sample${samples.length === 1 ? "" : "s"} · ${opt.label}`,
      ]));
    }).catch((err) => {
      target.innerHTML = "";
      target.append(el("div", { class: "callout danger" }, [`Failed: ${err?.message || err}`]));
    });
  }
}

// ---------- Helpers --------------------------------------------------------

function pretty(b, field) {
  // Phase 4 doesn't fetch the profile point alongside the binding, so
  // we infer a friendly name from the source_path tail. For the
  // historical chart's `unit` knob, we don't have unit yet; return
  // empty string.
  if (field === "unit") return ""; // Phase 4 limitation
  if (!b.sourcePath) return b.id;
  const tail = String(b.sourcePath).split(/[\/.]/).pop();
  return tail || b.id;
}

// Stash a cleanup callback on the target node so the next render
// can find and run it.
const _cleanups = new WeakMap();
function attachCleanup(target, fn) { _cleanups.set(target, fn); }
function cleanupForTarget(target) {
  const fn = _cleanups.get(target);
  if (typeof fn === "function") {
    try { fn(); } catch { /* swallow */ }
    _cleanups.delete(target);
  }
}
