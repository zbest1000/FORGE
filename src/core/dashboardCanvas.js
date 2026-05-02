// Configurable dashboard canvas — Grafana / Ignition Perspective vibes.
//
// A dashboard is a list of panels laid out on a 12-column grid.
// Each panel has:
//   { id, kind, title, x, y, w, h, source, options }
// where:
//   x / y     = top-left grid cell (0-indexed; rows are auto-flow)
//   w / h     = grid span (1..12 columns; 1..N rows)
//   kind      = "kpi" | "line" | "bar" | "gauge" | "sparkline" | "table" | "stat"
//   source    = { pointId } for chart kinds (resolves to a historian point),
//               { metric: "workItemCount", filter: {...} } for table/kpi
//   options   = panel-kind-specific extras (color, unit, range, ...)
//
// Edit mode toggles a per-panel drag handle, resize affordances, and
// a delete button. New panels are added via the toolbar.
//
// Persistence: dashboards live on `state.data.dashboards` keyed by
// `id`. Each dashboard has a `scope` ("workspace" or `asset:<id>`)
// so the same canvas can render workspace-wide or per-asset views
// against the same primitive set.

import { el, modal, formRow, input, select, toast } from "./ui.js";
import { state, update } from "./store.js";
import { audit } from "./audit.js";
import { historianChart, sparkline } from "./charts.js";
import { can } from "./permissions.js";

/** @typedef {{ id:string, kind:string, title:string, x:number, y:number, w:number, h:number, source?:any, options?:any }} Panel */
/** @typedef {{ id:string, name:string, scope:string, panels:Panel[], createdAt?:string, updatedAt?:string }} Dashboard */

const PANEL_KINDS = [
  { id: "kpi",       label: "KPI",        defaultW: 3, defaultH: 2 },
  { id: "stat",      label: "Big stat",   defaultW: 4, defaultH: 3 },
  { id: "gauge",     label: "Gauge",      defaultW: 3, defaultH: 3 },
  { id: "sparkline", label: "Sparkline",  defaultW: 4, defaultH: 2 },
  { id: "line",      label: "Line chart", defaultW: 6, defaultH: 4 },
  { id: "bar",       label: "Bar chart",  defaultW: 6, defaultH: 4 },
  { id: "table",     label: "Table",      defaultW: 6, defaultH: 4 },
];

const COLS = 12;

let _editStateByDash = new Map();

function makeId() { return "PNL-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6).toUpperCase(); }
function dashId(id) { return id || ("DSH-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6).toUpperCase()); }

/**
 * Find or create the dashboard for the given scope, returning a deep
 * copy so callers can render without mutating store state.
 */
export function getOrCreateDashboard(scope, name = "Dashboard") {
  const list = (state.data && /** @type {any} */ (state.data).dashboards) || [];
  let dash = list.find(d => d.scope === scope);
  if (dash) return dash;
  // Bootstrap a default dashboard with one KPI per common axis.
  const id = dashId();
  dash = {
    id,
    scope,
    name,
    panels: defaultPanels(scope),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  update(s => {
    /** @type {any} */ (s.data).dashboards = /** @type {any} */ (s.data).dashboards || [];
    /** @type {any} */ (s.data).dashboards.push(dash);
  });
  return dash;
}

function defaultPanels(scope) {
  // Per-asset dashboards seed with sparklines for whatever historian
  // points the asset already has. Workspace dashboard seeds with
  // workspace-wide KPIs.
  if (scope.startsWith("asset:")) {
    const assetId = scope.slice("asset:".length);
    const points = (state.data?.historianPoints || []).filter(p => p.assetId === assetId).slice(0, 4);
    return points.map((p, i) => ({
      id: makeId(),
      kind: "sparkline",
      title: p.name || p.tag,
      x: (i % 3) * 4, y: Math.floor(i / 3) * 2,
      w: 4, h: 2,
      source: { pointId: p.id },
      options: { unit: p.unit || "" },
    }));
  }
  return [
    { id: makeId(), kind: "kpi",   title: "Open work items", x: 0, y: 0, w: 3, h: 2, source: { metric: "workItemCount", filter: { status: "open" } }, options: {} },
    { id: makeId(), kind: "kpi",   title: "Active incidents", x: 3, y: 0, w: 3, h: 2, source: { metric: "incidentCount", filter: { status: "active" } }, options: {} },
    { id: makeId(), kind: "kpi",   title: "Pending approvals", x: 6, y: 0, w: 3, h: 2, source: { metric: "approvalCount", filter: { status: "pending" } }, options: {} },
    { id: makeId(), kind: "kpi",   title: "Documents",         x: 9, y: 0, w: 3, h: 2, source: { metric: "documentCount" }, options: {} },
    { id: makeId(), kind: "table", title: "Recent work",       x: 0, y: 2, w: 6, h: 4, source: { metric: "recentWorkItems", limit: 8 }, options: {} },
    { id: makeId(), kind: "table", title: "Recent incidents",  x: 6, y: 2, w: 6, h: 4, source: { metric: "recentIncidents", limit: 8 }, options: {} },
  ];
}

/**
 * Render a dashboard into `host`. Caller is responsible for re-calling
 * `renderDashboard` when state changes (the canvas does NOT subscribe
 * itself — that's the parent screen's job).
 *
 * @param {HTMLElement} host
 * @param {string} scope    e.g. "workspace" or "asset:AS-1"
 * @param {{ name?: string, onChange?: () => void }} [opts]
 */
export function renderDashboard(host, scope, opts = {}) {
  const dash = getOrCreateDashboard(scope, opts.name);
  const editState = _editStateByDash.get(dash.id) || { editing: false };
  _editStateByDash.set(dash.id, editState);

  host.replaceChildren();
  host.append(toolbar(dash, editState, () => renderDashboard(host, scope, opts)));
  host.append(grid(dash, editState, () => renderDashboard(host, scope, opts)));
}

function toolbar(dash, editState, rerender) {
  return el("div", { class: "dashboard-toolbar" }, [
    el("div", {}, [
      el("div", { class: "strong" }, [dash.name]),
      el("div", { class: "tiny muted" }, [
        `${dash.panels.length} panel${dash.panels.length === 1 ? "" : "s"} · ${editState.editing ? "Edit mode" : "View mode"}`,
      ]),
    ]),
    el("div", { class: "row wrap" }, [
      editState.editing
        ? el("button", { class: "btn sm primary", onClick: () => { editState.editing = false; rerender(); } }, ["Done editing"])
        : el("button", {
            class: "btn sm",
            disabled: !can("edit"),
            title: can("edit") ? "Toggle edit mode to add / move / delete panels" : "Requires edit capability",
            onClick: () => { editState.editing = true; rerender(); },
          }, ["Edit dashboard"]),
      editState.editing
        ? el("button", { class: "btn sm primary", onClick: () => addPanel(dash, rerender) }, ["+ Panel"])
        : null,
      editState.editing
        ? el("button", {
            class: "btn sm danger",
            onClick: () => resetDashboard(dash, rerender),
          }, ["Reset"])
        : null,
    ]),
  ]);
}

function grid(dash, editState, rerender) {
  const wrap = el("div", { class: `dashboard-grid ${editState.editing ? "editing" : ""}` });
  // Panels are positioned via CSS grid `grid-column` / `grid-row` so
  // resizing is just an integer change. Auto rows accommodate any
  // height the operator picks.
  for (const p of dash.panels) {
    wrap.append(panelView(p, dash, editState, rerender));
  }
  if (!dash.panels.length) {
    wrap.append(el("div", { class: "muted small", style: { padding: "32px", textAlign: "center", gridColumn: "1 / -1" } }, [
      "Empty dashboard. Click ", el("strong", {}, ["Edit dashboard"]), " then ", el("strong", {}, ["+ Panel"]), " to add charts, KPIs, gauges, or tables.",
    ]));
  }
  return wrap;
}

function panelView(panel, dash, editState, rerender) {
  const node = el("div", {
    class: "dashboard-panel",
    style: {
      gridColumn: `${panel.x + 1} / span ${Math.min(panel.w, COLS - panel.x)}`,
      gridRow: `${panel.y + 1} / span ${panel.h}`,
    },
  }, [
    el("div", { class: "dashboard-panel-head" }, [
      el("span", { class: "dashboard-panel-title" }, [panel.title || "Untitled"]),
      el("span", { class: "tiny muted" }, [panel.kind]),
      editState.editing ? el("div", { class: "row" }, [
        el("button", { class: "btn sm ghost", title: "Edit panel", onClick: () => editPanel(panel, dash, rerender) }, ["⚙"]),
        el("button", { class: "btn sm danger", title: "Delete panel", onClick: () => deletePanel(panel, dash, rerender) }, ["✕"]),
      ]) : null,
    ]),
    el("div", { class: "dashboard-panel-body" }, [renderPanelBody(panel)]),
    editState.editing ? el("div", { class: "dashboard-panel-resize", title: "Drag to resize" }) : null,
  ]);
  if (editState.editing) wirePanelDrag(node, panel, dash, rerender);
  return node;
}

function renderPanelBody(panel) {
  const d = state.data || {};
  switch (panel.kind) {
    case "kpi":
    case "stat": {
      const value = computeMetric(panel.source, d);
      return el("div", { class: "dashboard-stat" }, [
        el("div", { class: "dashboard-stat-value" }, [String(value ?? "—")]),
        panel.options?.unit ? el("div", { class: "dashboard-stat-unit" }, [panel.options.unit]) : null,
      ]);
    }
    case "gauge": {
      const value = Number(computeMetric(panel.source, d)) || 0;
      const max = Number(panel.options?.max ?? 100);
      const pct = Math.max(0, Math.min(1, value / (max || 1)));
      return el("div", { class: "dashboard-gauge" }, [
        el("div", { class: "dashboard-gauge-ring", style: { background: `conic-gradient(var(--accent) ${pct * 360}deg, var(--surface) 0)` } }),
        el("div", { class: "dashboard-gauge-value" }, [String(Math.round(value))]),
        panel.options?.unit ? el("div", { class: "dashboard-gauge-unit" }, [panel.options.unit]) : null,
      ]);
    }
    case "sparkline": {
      const series = sampleSeriesForPoint(panel.source?.pointId);
      if (!series.length) return el("div", { class: "muted small" }, ["No samples for this point."]);
      return sparkline(series, { width: 280, height: 60, label: panel.title });
    }
    case "line":
    case "bar": {
      const samples = (d.historianSamples || []).filter(s => s.pointId === panel.source?.pointId);
      const point = (d.historianPoints || []).find(p => p.id === panel.source?.pointId);
      if (!samples.length) return el("div", { class: "muted small" }, ["No samples for this point."]);
      const host = document.createElement("div");
      host.style.width = "100%";
      host.style.height = "100%";
      host.style.minHeight = "180px";
      // historianChart expects samples shape, returns DOM. Defer mount
      // since the wrapper element isn't in the DOM yet.
      const chart = historianChart(samples, { title: panel.title || "", unit: point?.unit || "", type: panel.kind });
      Promise.resolve().then(() => host.replaceChildren(chart));
      return host;
    }
    case "table": {
      const rows = computeTableRows(panel.source, d);
      if (!rows.length) return el("div", { class: "muted small" }, ["No rows."]);
      const headers = Object.keys(rows[0]);
      return el("div", { style: { overflow: "auto", height: "100%" } }, [
        el("table", { class: "table" }, [
          el("thead", {}, [el("tr", {}, headers.map(h => el("th", {}, [h])))]),
          el("tbody", {}, rows.map(r => el("tr", {}, headers.map(h => el("td", {}, [String(r[h] ?? "—")]))))),
        ]),
      ]);
    }
    default:
      return el("div", { class: "muted small" }, [`Unknown panel kind: ${panel.kind}`]);
  }
}

function computeMetric(source, d) {
  if (!source) return "—";
  const m = source.metric;
  if (m === "workItemCount") {
    const f = source.filter || {};
    let items = d.workItems || [];
    if (f.status === "open") items = items.filter(w => w.status !== "Done" && w.status !== "Closed");
    if (f.status === "done") items = items.filter(w => w.status === "Done" || w.status === "Closed");
    if (f.assigneeId) items = items.filter(w => w.assigneeId === f.assigneeId);
    return items.length;
  }
  if (m === "incidentCount") {
    const f = source.filter || {};
    let items = d.incidents || [];
    if (f.status) items = items.filter(i => i.status === f.status);
    return items.length;
  }
  if (m === "approvalCount") {
    const f = source.filter || {};
    let items = d.approvals || [];
    if (f.status) items = items.filter(a => a.status === f.status);
    return items.length;
  }
  if (m === "documentCount") return (d.documents || []).length;
  if (m === "assetCount") return (d.assets || []).length;
  if (m === "lastValue") {
    const series = sampleSeriesForPoint(source.pointId);
    return series.length ? series[series.length - 1].toFixed(2) : "—";
  }
  return "—";
}

function computeTableRows(source, d) {
  if (!source) return [];
  const m = source.metric;
  const limit = source.limit || 8;
  if (m === "recentWorkItems") {
    return (d.workItems || []).slice(0, limit).map(w => ({
      id: w.id, title: w.title, status: w.status, assignee: w.assigneeId || "—",
    }));
  }
  if (m === "recentIncidents") {
    return (d.incidents || []).slice(0, limit).map(i => ({
      id: i.id, title: i.title, severity: i.severity, status: i.status,
    }));
  }
  if (m === "recentDocuments") {
    return (d.documents || []).slice(0, limit).map(x => ({
      id: x.id, name: x.name, discipline: x.discipline, sensitivity: x.sensitivity,
    }));
  }
  return [];
}

function sampleSeriesForPoint(pointId) {
  if (!pointId) return [];
  const d = state.data || {};
  return (d.historianSamples || [])
    .filter(s => s.pointId === pointId)
    .map(s => Number(s.value))
    .filter(v => Number.isFinite(v));
}

function addPanel(dash, rerender) {
  const titleInput = input({ value: "New panel" });
  const kindSel = select(PANEL_KINDS.map(k => ({ value: k.id, label: k.label })));
  // Source picker: a historian point (for chart kinds) OR a metric.
  const points = (state.data?.historianPoints || []).map(p => ({ value: `point:${p.id}`, label: `${p.name || p.id} · ${p.unit || ""}` }));
  const metrics = [
    { value: "metric:workItemCount:open",  label: "Open work items" },
    { value: "metric:workItemCount:done",  label: "Done work items" },
    { value: "metric:incidentCount:active",label: "Active incidents" },
    { value: "metric:approvalCount:pending", label: "Pending approvals" },
    { value: "metric:documentCount",       label: "Document count" },
    { value: "metric:assetCount",          label: "Asset count" },
    { value: "metric:recentWorkItems",     label: "Recent work items (table)" },
    { value: "metric:recentIncidents",     label: "Recent incidents (table)" },
    { value: "metric:recentDocuments",     label: "Recent documents (table)" },
  ];
  const sourceSel = select([{ value: "", label: "(no source)" }, ...metrics, ...points]);
  modal({
    title: "Add panel",
    body: el("div", { class: "stack" }, [
      formRow("Title", titleInput),
      formRow("Kind", kindSel),
      formRow("Source", sourceSel),
      el("div", { class: "tiny muted" }, [
        "Pick a panel kind, then either a metric or a historian point. ",
        "After adding, drag the bottom-right corner to resize.",
      ]),
    ]),
    actions: [
      { label: "Cancel" },
      { label: "Add", variant: "primary", onClick: () => {
        const kind = /** @type {HTMLSelectElement} */ (kindSel).value;
        const def = PANEL_KINDS.find(k => k.id === kind);
        const sourceRaw = /** @type {HTMLSelectElement} */ (sourceSel).value;
        const source = parseSource(sourceRaw);
        const panel = {
          id: makeId(),
          kind,
          title: /** @type {HTMLInputElement} */ (titleInput).value || "Panel",
          x: 0, y: 9999, // place at the bottom; the next render normalises positions
          w: def?.defaultW || 4,
          h: def?.defaultH || 3,
          source,
          options: {},
        };
        update(s => {
          const list = /** @type {any} */ (s.data).dashboards || [];
          const target = list.find(x => x.id === dash.id);
          if (!target) return;
          // Normalise: place new panel at the next free row.
          const nextY = (target.panels || []).reduce((max, p) => Math.max(max, p.y + p.h), 0);
          panel.y = nextY;
          target.panels = [...(target.panels || []), panel];
          target.updatedAt = new Date().toISOString();
        });
        audit("dashboard.panel.add", dash.id, { panelId: panel.id, kind });
        rerender();
      }},
    ],
  });
}

function parseSource(raw) {
  if (!raw) return null;
  if (raw.startsWith("point:")) return { pointId: raw.slice("point:".length) };
  if (raw.startsWith("metric:")) {
    const parts = raw.split(":");
    const metric = parts[1];
    const filterValue = parts[2];
    const out = { metric };
    if (filterValue) out.filter = { status: filterValue };
    if (metric.startsWith("recent")) out.limit = 8;
    return out;
  }
  return null;
}

function editPanel(panel, dash, rerender) {
  const titleInput = input({ value: panel.title || "" });
  const wInput = input({ type: "number", value: String(panel.w), min: "1", max: String(COLS) });
  const hInput = input({ type: "number", value: String(panel.h), min: "1", max: "12" });
  modal({
    title: `Edit panel · ${panel.title}`,
    body: el("div", { class: "stack" }, [
      formRow("Title", titleInput),
      formRow("Width (cols)", wInput),
      formRow("Height (rows)", hInput),
    ]),
    actions: [
      { label: "Cancel" },
      { label: "Save", variant: "primary", onClick: () => {
        update(s => {
          const list = /** @type {any} */ (s.data).dashboards || [];
          const target = list.find(x => x.id === dash.id);
          if (!target) return;
          const p = (target.panels || []).find(x => x.id === panel.id);
          if (!p) return;
          p.title = /** @type {HTMLInputElement} */ (titleInput).value || p.title;
          p.w = Math.max(1, Math.min(COLS, parseInt(/** @type {HTMLInputElement} */ (wInput).value, 10) || p.w));
          p.h = Math.max(1, Math.min(12, parseInt(/** @type {HTMLInputElement} */ (hInput).value, 10) || p.h));
          target.updatedAt = new Date().toISOString();
        });
        audit("dashboard.panel.edit", dash.id, { panelId: panel.id });
        rerender();
      }},
    ],
  });
}

function deletePanel(panel, dash, rerender) {
  update(s => {
    const list = /** @type {any} */ (s.data).dashboards || [];
    const target = list.find(x => x.id === dash.id);
    if (!target) return;
    target.panels = (target.panels || []).filter(p => p.id !== panel.id);
    target.updatedAt = new Date().toISOString();
  });
  audit("dashboard.panel.delete", dash.id, { panelId: panel.id });
  toast("Panel removed", "success");
  rerender();
}

function resetDashboard(dash, rerender) {
  if (!window.confirm("Reset this dashboard to defaults? Custom panels will be lost.")) return;
  update(s => {
    const list = /** @type {any} */ (s.data).dashboards || [];
    const target = list.find(x => x.id === dash.id);
    if (!target) return;
    target.panels = defaultPanels(target.scope);
    target.updatedAt = new Date().toISOString();
  });
  audit("dashboard.reset", dash.id);
  rerender();
}

// Drag-to-move + resize wiring. Move uses the panel head as handle;
// resize uses the bottom-right corner div. Coordinates snap to the
// 12-column grid.
function wirePanelDrag(node, panel, dash, rerender) {
  const head = node.querySelector(".dashboard-panel-head");
  const resize = node.querySelector(".dashboard-panel-resize");
  if (head) head.addEventListener("pointerdown", (e) => beginDrag(e, node, panel, dash, "move", rerender));
  if (resize) resize.addEventListener("pointerdown", (e) => beginDrag(e, node, panel, dash, "resize", rerender));
}

function beginDrag(e, node, panel, dash, mode, rerender) {
  if (e.button !== 0) return;
  e.preventDefault();
  const grid = node.parentElement;
  if (!grid) return;
  const rect = grid.getBoundingClientRect();
  const colW = rect.width / COLS;
  const rowH = parseFloat(getComputedStyle(grid).gridAutoRows) || 56;
  const startX = e.clientX, startY = e.clientY;
  const orig = { x: panel.x, y: panel.y, w: panel.w, h: panel.h };

  const onMove = (ev) => {
    const dx = Math.round((ev.clientX - startX) / colW);
    const dy = Math.round((ev.clientY - startY) / rowH);
    if (mode === "move") {
      panel.x = Math.max(0, Math.min(COLS - panel.w, orig.x + dx));
      panel.y = Math.max(0, orig.y + dy);
    } else {
      panel.w = Math.max(1, Math.min(COLS - panel.x, orig.w + dx));
      panel.h = Math.max(1, orig.h + dy);
    }
    node.style.gridColumn = `${panel.x + 1} / span ${panel.w}`;
    node.style.gridRow = `${panel.y + 1} / span ${panel.h}`;
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    update(s => {
      const list = /** @type {any} */ (s.data).dashboards || [];
      const target = list.find(x => x.id === dash.id);
      if (!target) return;
      const p = (target.panels || []).find(x => x.id === panel.id);
      if (!p) return;
      p.x = panel.x; p.y = panel.y; p.w = panel.w; p.h = panel.h;
      target.updatedAt = new Date().toISOString();
    });
    audit(mode === "move" ? "dashboard.panel.move" : "dashboard.panel.resize", dash.id, { panelId: panel.id });
    rerender();
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}
