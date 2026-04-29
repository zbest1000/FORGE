// Work board v2 — spec §11.4 and §6.2.
//
// Views: Board (kanban) · Table · Timeline (Gantt-ish) · Dependency map.
// Bulk operations: multi-select, bulk state change, bulk assign, bulk
// severity, bulk labels. Dependencies create blocked-by links.
// Automation: default rules and per-project trigger viewer.

import { el, mount, card, badge, toast, modal, formRow, input, select, textarea, prompt, tabs, kpi, drawer, confirm } from "../core/ui.js";
import { state, update, getById } from "../core/store.js";
import { audit } from "../core/audit.js";
import { navigate } from "../core/router.js";
import { can } from "../core/permissions.js";
import { renderMermaid } from "../core/mermaid.js";
import { simulation } from "../core/simulation.js";

const COLUMNS = ["Backlog", "Open", "In Progress", "In Review", "Approved", "Done"];

export function renderProjectsIndex() {
  const root = document.getElementById("screenContainer");
  const d = state.data;
  mount(root, [
    el("div", { class: "card-grid" }, (d.projects || []).map(p => {
      const items = (d.workItems || []).filter(w => w.projectId === p.id);
      return card(p.name, el("div", { class: "stack" }, [
        el("div", { class: "tiny muted" }, [`Due: ${p.dueDate ? new Date(p.dueDate).toLocaleDateString() : "—"}`]),
        el("div", { class: "row wrap" }, [
          badge(p.status, p.status === "active" ? "success" : "info"),
          badge(`${items.length} items`, ""),
        ]),
      ]), { actions: [el("button", { class: "btn sm primary", onClick: () => navigate(`/work-board/${p.id}`) }, ["Open board"])] });
    })),
  ]);
}

export function renderWorkBoard({ id }) {
  const root = document.getElementById("screenContainer");
  const d = state.data;
  const project = getById("projects", id);
  if (!project) return mount(root, el("div", { class: "muted" }, ["Project not found."]));

  const viewKey = `board.view.${id}`;
  const view = sessionStorage.getItem(viewKey) || "kanban";
  const filterKey = `board.filter.${id}`;
  const filter = sessionStorage.getItem(filterKey) || "";
  const batchKey = `board.batch.${id}`;
  const batch = JSON.parse(sessionStorage.getItem(batchKey) || "[]");

  const items = filteredItems(id, filter);
  const viewPreset = sessionStorage.getItem(`board.saved.${id}`) || "all";
  const visibleItems = applySavedView(items, viewPreset);

  mount(root, [
    header(project, view, filter, visibleItems.length, batch, viewKey, filterKey, batchKey, id, viewPreset),
    projectContext(project, items),
    batchBar(batch, batchKey, id),
    view === "kanban"   ? kanbanView(visibleItems, batch, batchKey) :
    view === "table"    ? tableView(visibleItems, batch, batchKey) :
    view === "timeline" ? timelineView(visibleItems) :
    view === "calendar" ? calendarView(visibleItems, id) :
    view === "deps"     ? dependencyView(visibleItems) :
    kanbanView(visibleItems, batch, batchKey),
  ]);
}

function projectContext(project, items) {
  const d = state.data;
  const site = locationById(project.siteId);
  const loc = locationById(project.locationId);
  const orgName = d.organization?.name || "Enterprise";
  const projectAssets = linkedProjectAssets(project);
  const projectDocs = scopedProjectDocs(project, projectAssets);
  const dataSources = (d.dataSources || []).filter(ds => ds.projectId === project.id || projectAssets.some(a => a.id === ds.assetId));
  const maintenance = (d.maintenanceItems || []).filter(m => m.projectId === project.id || projectAssets.some(a => a.id === m.assetId));
  const incidents = (d.incidents || []).filter(i => projectAssets.some(a => a.id === i.assetId));
  const tabKey = `project.context.tab.${project.id}`;
  const ctx = { orgName, site, loc, projectAssets, projectDocs, dataSources, maintenance, incidents, items };
  return el("div", { class: "stack project-context", style: { marginBottom: "16px" } }, [
    tabs({
      sessionKey: tabKey,
      ariaLabel: "Project context",
      tabs: [
        { id: "overview", label: "Overview", content: () => projectOverview(project, ctx) },
        { id: "assets", label: `Assets ${projectAssets.length}`, content: () => card(`Linked assets (${projectAssets.length})`, assetList(projectAssets)) },
        { id: "docs", label: `Docs ${projectDocs.length}`, content: () => card(`Documents (${projectDocs.length})`, documentList(projectDocs, project, projectAssets)) },
        { id: "signals", label: `Signals ${dataSources.length}`, content: () => card("Signal health", signalHealthList(dataSources), { actions: [
          helpHint("Live operations signals from MQTT, OPC UA, ERP, or other connectors. Hover each status for source and quality."),
        ]}) },
        { id: "service", label: `Service ${maintenance.length}`, content: () => card(`Service work (${maintenance.length})`, serviceWorkList(maintenance), { actions: [
          helpHint("Service records can come from systems such as MaintainX, SAP PM, Fiix, UpKeep, or Maximo."),
        ]}) },
        { id: "activity", label: "Activity", content: () => card("Project activity", projectTimeline(project, ctx)) },
      ],
    }),
  ]);
}

function projectOverview(project, ctx) {
  return card(`${ctx.orgName} context`, el("div", { class: "stack" }, [
    el("div", { class: "row wrap" }, [
      chipText("Organization", ctx.orgName),
      chipText("Site", ctx.site?.name || "—"),
      chipText("Location", ctx.loc?.path || ctx.loc?.name || "—"),
      chipText("Referenced assets", String(ctx.projectAssets.length), "Assets remain mastered by site/location. This project references the assets it affects."),
    ]),
    el("div", { class: "card-grid" }, [
      kpi("Assets", ctx.projectAssets.length, "referenced", ""),
      kpi("Documents", ctx.projectDocs.length, "scoped", ""),
      kpi("Signals", ctx.dataSources.length, "live context", ctx.dataSources.some(ds => ds.status === "stale") ? "down" : "up"),
      kpi("Service work", ctx.maintenance.length, "open / planned", ctx.maintenance.some(m => ["open","due"].includes(m.status)) ? "down" : "up"),
      kpi("Incidents", ctx.incidents.filter(i => i.status === "active").length, "active", ctx.incidents.some(i => i.status === "active") ? "down" : "up"),
    ]),
  ]));
}

function locationById(id) {
  return (state.data?.locations || []).find(l => l.id === id) || null;
}

function linkedProjectAssets(project) {
  const ids = new Set(project.assetIds || []);
  return (state.data.assets || []).filter(a => ids.has(a.id) || (a.projectIds || []).includes(project.id));
}

function scopedProjectDocs(project, assets) {
  const assetIds = new Set(assets.map(a => a.id));
  return (state.data.documents || []).filter(doc =>
    doc.scope === "enterprise" ||
    doc.projectId === project.id ||
    doc.siteId === project.siteId ||
    (doc.assetIds || []).some(id => assetIds.has(id))
  );
}

function chipText(kind, value, help) {
  return el("span", { class: "chip", title: help || "" }, [
    el("span", { class: "chip-kind" }, [kind]),
    value || "—",
    help ? helpIcon(help) : null,
  ]);
}

function helpIcon(text) {
  return el("span", { class: "help-dot", title: text, "aria-label": text }, ["?"]);
}

function helpHint(text) {
  return el("span", { class: "help-dot", title: text, "aria-label": text }, ["?"]);
}

function assetList(assets) {
  if (!assets.length) return el("div", { class: "muted tiny" }, ["No assets explicitly linked to this project."]);
  return el("div", { class: "stack" }, assets.map(a => el("button", {
    class: "activity-row",
    onClick: () => navigate(`/asset/${a.id}`),
  }, [
    badge(a.status.toUpperCase(), statusVariant(a.status)),
    el("span", {}, [a.name]),
    el("span", { class: "tiny muted" }, [a.maintenanceStatus || "—"]),
  ])));
}

function documentList(docs, project, assets = []) {
  if (!docs.length) return el("div", { class: "muted tiny" }, ["No scoped documents."]);
  const assetIds = new Set(assets.map(a => a.id));
  return el("div", { class: "stack" }, docs.map(doc => el("button", {
    class: "activity-row",
    onClick: () => navigate(`/doc/${doc.id}`),
  }, [
    scopeBadge(doc, project, assetIds),
    el("span", {}, [doc.name]),
    el("span", { class: "tiny muted" }, [doc.discipline || doc.kind || doc.id]),
  ])));
}

function scopeBadge(doc, project, assetIds) {
  const scope = doc.scope || "project";
  const reason = scope === "enterprise" ? "Enterprise document: visible across the organization."
    : doc.projectId === project.id ? `Project document for ${project.name}.`
    : doc.siteId === project.siteId ? "Site document inherited from this project's site."
    : (doc.assetIds || []).some(id => assetIds.has(id)) ? "Asset document inherited from a linked asset."
    : "Document matched this context.";
  const variant = scope === "enterprise" ? "purple" : scope === "asset" ? "accent" : scope === "site" ? "warn" : "info";
  return badge(scope, variant, { title: reason });
}

function signalHealthList(sources) {
  if (!sources.length) return el("div", { class: "muted tiny" }, ["No live operations signals linked."]);
  return el("div", { class: "stack" }, sources.map(ds => el("div", { class: "activity-row" }, [
    signalBadge(ds),
    el("span", { class: "mono tiny" }, [ds.endpoint]),
    el("span", { class: "tiny muted" }, [ds.lastValue || ds.kind]),
  ])));
}

function signalBadge(ds) {
  const label = ds.status === "live" ? "Live"
    : ds.status === "stale" ? "Stale"
    : ds.status === "not_connected" ? "Not connected"
    : ds.status || ds.quality || ds.kind;
  const title = `Source: ${ds.integrationId || "unknown"} · Quality: ${ds.quality || "unknown"} · Last seen: ${ds.lastSeen ? new Date(ds.lastSeen).toLocaleString() : "unknown"}`;
  return el("span", { class: `badge ${dataVariant(ds.status || ds.quality)}`, title }, [label]);
}

function serviceWorkList(items) {
  if (!items.length) return el("div", { class: "muted tiny" }, ["No maintenance items linked."]);
  return el("div", { class: "stack" }, items.map(m => el("div", { class: "activity-row" }, [
    badge(m.source, "purple", { title: `External ${m.source} record ${m.externalId || m.id} · sync ${m.syncStatus || "unknown"}` }),
    el("span", {}, [m.title]),
    badge(`${m.status} · ${m.priority}`, m.priority === "high" ? "danger" : m.priority === "medium" ? "warn" : "info"),
  ])));
}

function projectTimeline(project, ctx) {
  const rows = [
    ...ctx.projectDocs.map(doc => ({ ts: revisionTs(doc.currentRevisionId), kind: "Document", text: `${doc.name} current revision`, route: `/doc/${doc.id}` })),
    ...ctx.items.map(w => ({ ts: w.due, kind: w.type, text: `${w.id} · ${w.title}`, route: null })),
    ...ctx.maintenance.map(m => ({ ts: m.due, kind: "Service", text: `${m.source} · ${m.title}`, route: `/asset/${m.assetId}` })),
    ...ctx.incidents.flatMap(i => (i.timeline || []).map(t => ({ ts: t.ts, kind: "Incident", text: `${i.id} · ${t.text}`, route: `/incident/${i.id}` }))),
    ...ctx.dataSources.map(ds => ({ ts: ds.lastSeen, kind: "Signal", text: `${ds.endpoint} · ${ds.lastValue || ds.status}`, route: ds.assetId ? `/asset/${ds.assetId}` : null })),
  ].filter(r => r.ts).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts)).slice(-8);
  if (!rows.length) return el("div", { class: "muted tiny" }, ["No timeline events yet."]);
  return el("div", { class: "stack" }, rows.map(r => el(r.route ? "button" : "div", {
    class: "activity-row",
    onClick: r.route ? () => navigate(r.route) : null,
  }, [
    el("span", { class: "ts" }, [new Date(r.ts).toLocaleDateString()]),
    el("span", {}, [r.text]),
    badge(r.kind, "info"),
  ])));
}

function revisionTs(revId) {
  return (state.data.revisions || []).find(r => r.id === revId)?.createdAt || null;
}

function statusVariant(s) {
  return s === "alarm" ? "danger" : s === "warning" ? "warn" : s === "offline" ? "" : "success";
}

function dataVariant(s) {
  return s === "live" || s === "Good" || s === "connected" ? "success"
    : s === "stale" || s === "Uncertain" || s === "GoodNoData" ? "warn"
    : s === "not_connected" || s === "failed" ? "danger"
    : "info";
}

const SAVED_VIEWS = [
  { id: "all", label: "All", test: () => true },
  { id: "mine", label: "My work", test: w => w.assigneeId === state.data?.currentUserId },
  { id: "blocked", label: "Blocked", test: w => (w.blockers || []).length > 0 },
  { id: "due", label: "Due soon", test: w => w.due && Date.parse(w.due) <= Date.now() + 7 * 86400_000 },
  { id: "asset", label: "Asset-linked", test: w => (w.assetIds || []).length > 0 },
  { id: "approval", label: "Needs approval", test: w => ["In Review", "Approved"].includes(w.status) },
];

function applySavedView(items, viewId) {
  const view = SAVED_VIEWS.find(v => v.id === viewId) || SAVED_VIEWS[0];
  return items.filter(view.test);
}

function header(project, view, filter, count, batch, viewKey, filterKey, batchKey, id, viewPreset) {
  const searchInput = input({ placeholder: "Filter by title/ID/label...", value: filter });
  searchInput.addEventListener("input", () => {
    sessionStorage.setItem(filterKey, searchInput.value);
    renderWorkBoard({ id });
  });
  return el("div", { class: "row spread", style: { marginBottom: "12px" } }, [
    el("div", {}, [
      el("div", { class: "strong" }, [project.name]),
      el("div", { class: "tiny muted" }, [`${count} items · status ${project.status}`]),
    ]),
    el("div", { class: "row" }, [
      searchInput,
      select(SAVED_VIEWS.map(v => ({ value: v.id, label: v.label })), {
        value: viewPreset,
        title: "Saved view",
        onChange: (e) => { sessionStorage.setItem(`board.saved.${id}`, e.target.value); renderWorkBoard({ id }); },
      }),
      el("div", { class: "row" },
        ["kanban","table","timeline","calendar","deps"].map(v => el("button", {
          class: `btn sm ${view === v ? "primary" : ""}`,
          onClick: () => { sessionStorage.setItem(viewKey, v); renderWorkBoard({ id }); },
        }, [label(v)]))
      ),
      el("button", {
        class: "btn sm ghost",
        title: "View all automation rules that run on this project (event routing, MQTT/OPC UA/Modbus ingestion, retention, lifecycle automations)",
        onClick: () => showAutomationRulesModal(),
      }, ["⚙ Rules"]),
      el("button", { class: "btn sm primary", disabled: !can("create"), onClick: () => openNewItem(id) }, ["+ New item"]),
    ]),
  ]);
}

function label(v) { return ({ kanban: "Board", table: "Table", timeline: "Timeline", calendar: "Calendar", deps: "Dependencies" })[v] || v; }

function filteredItems(projectId, filter) {
  const d = state.data;
  const list = (d.workItems || []).filter(w => w.projectId === projectId);
  if (!filter) return list;
  const f = filter.toLowerCase();
  return list.filter(w =>
    (w.title || "").toLowerCase().includes(f) ||
    (w.id || "").toLowerCase().includes(f) ||
    (w.labels || []).some(l => String(l).toLowerCase().includes(f))
  );
}

// ---------- batch bar ----------
function batchBar(batch, batchKey, projectId) {
  if (!batch.length) return el("div", {});
  return card(`Batch (${batch.length} selected)`, el("div", { class: "row wrap" }, [
    ...COLUMNS.map(c => el("button", {
      class: "btn sm",
      disabled: !can("edit"),
      onClick: () => batchMove(batch, c, batchKey, projectId),
    }, [`→ ${c}`])),
    el("button", { class: "btn sm", disabled: !can("edit"), onClick: () => batchSeverity(batch, batchKey, projectId) }, ["Set severity"]),
    el("button", { class: "btn sm", disabled: !can("edit"), onClick: () => batchAssignee(batch, batchKey, projectId) }, ["Assign"]),
    el("button", { class: "btn sm", disabled: !can("edit"), onClick: () => batchAddLabel(batch, batchKey, projectId) }, ["+ Label"]),
    el("button", { class: "btn sm ghost", onClick: () => { sessionStorage.setItem(batchKey, "[]"); renderWorkBoard({ id: projectId }); } }, ["Clear"]),
  ]));
}

function batchMove(ids, to, batchKey, projectId) {
  update(s => { for (const id of ids) { const w = s.data.workItems.find(x => x.id === id); if (w) { const from = w.status; w.status = to; audit("workitem.transition", id, { from, to, batch: true }); } } });
  sessionStorage.setItem(batchKey, "[]");
  toast(`${ids.length} items → ${to}`, "success");
  renderWorkBoard({ id: projectId });
}
function batchSeverity(ids, batchKey, projectId) {
  const pick = select(["low","medium","high","critical"], { value: "high" });
  modal({ title: "Set severity", body: formRow("Severity", pick), actions: [
    { label: "Cancel" },
    { label: "Apply", variant: "primary", onClick: () => {
      update(s => { for (const id of ids) { const w = s.data.workItems.find(x => x.id === id); if (w) { w.severity = pick.value; audit("workitem.update", id, { severity: pick.value }); } } });
      sessionStorage.setItem(batchKey, "[]");
      toast("Severity updated", "success"); renderWorkBoard({ id: projectId });
    }},
  ] });
}
function batchAssignee(ids, batchKey, projectId) {
  const pick = select(state.data.users.map(u => ({ value: u.id, label: u.name })));
  modal({ title: "Assign", body: formRow("Assignee", pick), actions: [
    { label: "Cancel" },
    { label: "Apply", variant: "primary", onClick: () => {
      update(s => { for (const id of ids) { const w = s.data.workItems.find(x => x.id === id); if (w) { w.assigneeId = pick.value; audit("workitem.assign", id, { to: pick.value }); } } });
      sessionStorage.setItem(batchKey, "[]"); renderWorkBoard({ id: projectId });
    }},
  ] });
}
async function batchAddLabel(ids, batchKey, projectId) {
  const label = await prompt({ title: "Add label", message: "Label name:" });
  if (!label) return;
  update(s => { for (const id of ids) { const w = s.data.workItems.find(x => x.id === id); if (w) { w.labels = w.labels || []; if (!w.labels.includes(label)) w.labels.push(label); audit("workitem.label", id, { add: label }); } } });
  sessionStorage.setItem(batchKey, "[]"); renderWorkBoard({ id: projectId });
}

function toggleBatch(itemId, batchKey) {
  const arr = JSON.parse(sessionStorage.getItem(batchKey) || "[]");
  const s = new Set(arr);
  if (s.has(itemId)) s.delete(itemId); else s.add(itemId);
  sessionStorage.setItem(batchKey, JSON.stringify([...s]));
}

// ---------- kanban ----------
function kanbanView(items, batch, batchKey) {
  return el("div", { class: "kanban" }, COLUMNS.map(col => {
    const colItems = items.filter(i => i.status === col);
    const node = el("div", {
      class: "kanban-col",
      dataset: { status: col },
      onDragover: (e) => { e.preventDefault(); node.classList.add("drop-active"); },
      onDragleave: () => node.classList.remove("drop-active"),
      onDrop: (e) => {
        e.preventDefault();
        node.classList.remove("drop-active");
        const itemId = e.dataTransfer.getData("text/plain");
        changeStatus(itemId, col);
      },
    }, [
      el("div", { class: "kanban-col-header" }, [col, el("span", { class: "tiny muted" }, [String(colItems.length)])]),
      ...colItems.map(w => kanbanCard(w, batch, batchKey)),
    ]);
    return node;
  }));
}

function kanbanCard(w, batch, batchKey) {
  const sevVariant = w.severity === "high" || w.severity === "critical" ? "danger" : w.severity === "medium" ? "warn" : "info";
  const isSelected = batch.includes(w.id);
  return el("div", {
    class: `kanban-card ${isSelected ? "selected" : ""}`,
    style: isSelected ? { boxShadow: "0 0 0 2px var(--accent) inset" } : {},
    draggable: "true",
    onDragstart: (e) => { e.dataTransfer.setData("text/plain", w.id); e.currentTarget.classList.add("dragging"); },
    onDragend: (e) => e.currentTarget.classList.remove("dragging"),
    onClick: (e) => { if (e.shiftKey) { toggleBatch(w.id, batchKey); renderWorkBoard({ id: w.projectId }); } else openItem(w.id); },
  }, [
    el("div", { class: "row spread" }, [
      el("span", { class: "card-id" }, [w.id]),
      badge(w.type, "info"),
    ]),
    el("div", { class: "card-title" }, [w.title]),
    el("div", { class: "card-meta row wrap" }, [
      badge(w.severity, sevVariant),
      w.due ? el("span", { class: "tiny muted" }, ["due " + new Date(w.due).toLocaleDateString()]) : null,
      w.blockers?.length ? badge(`blocked:${w.blockers.length}`, "danger") : null,
      (w.labels || []).slice(0, 2).map(l => badge(l, "")),
    ]),
  ]);
}

// ---------- table ----------
// ---------- Asana-like table view ----------
//
// Sortable column headers (click to toggle asc/desc/clear), per-column
// text filters (input row below the headers), and a column-visibility
// menu so users can show/hide columns. Sort, filter, and visibility
// state is per-project and persists across navigation via sessionStorage
// — it does NOT live in the global store because it's view scaffolding,
// not data.
//
// Linkages: `blockers` is rendered as a clickable list that navigates to
// the linked work item. The link picker (modal) is opened from the cell
// to add/remove blockers without leaving the table.
//
// Custom columns: `state.data.customWorkItemFields[projectId]` is a
// per-project list of `{ id, name, type, options? }`. Values are read
// from `workItem.customValues[fieldId]`. Type can be text|number|date|
// select. New fields are added via the column-visibility menu.

const COLUMN_DEFS = [
  { id: "id",        header: "ID",        sort: (a, b) => String(a.id).localeCompare(String(b.id)), filter: (w, q) => String(w.id).toLowerCase().includes(q), render: (w) => el("span", { class: "mono" }, [w.id]) },
  { id: "title",     header: "Title",     sort: (a, b) => String(a.title || "").localeCompare(String(b.title || "")), filter: (w, q) => (w.title || "").toLowerCase().includes(q), render: (w) => w.title || "—" },
  { id: "type",      header: "Type",      sort: (a, b) => String(a.type || "").localeCompare(String(b.type || "")), filter: (w, q) => (w.type || "").toLowerCase().includes(q), render: (w) => badge(w.type || "—", "info") },
  { id: "severity",  header: "Severity",  sort: (a, b) => sevRank(a.severity) - sevRank(b.severity), filter: (w, q) => (w.severity || "").toLowerCase().includes(q), render: (w) => badge(w.severity || "—", w.severity === "high" || w.severity === "critical" ? "danger" : w.severity === "medium" ? "warn" : "info") },
  { id: "status",    header: "Status",    sort: (a, b) => String(a.status || "").localeCompare(String(b.status || "")), filter: (w, q) => (w.status || "").toLowerCase().includes(q), render: (w) => badge(w.status || "—", "") },
  { id: "assignee",  header: "Assignee",  sort: (a, b) => String(a.assigneeId || "").localeCompare(String(b.assigneeId || "")), filter: (w, q) => (w.assigneeId || "").toLowerCase().includes(q), render: (w) => el("span", { class: "tiny muted" }, [w.assigneeId || "—"]) },
  { id: "assigned",  header: "Assigned",  sort: (a, b) => (Date.parse(a.assignedAt) || Infinity) - (Date.parse(b.assignedAt) || Infinity), filter: (w, q) => (w.assignedAt || "").toLowerCase().includes(q), render: (w) => el("span", { class: "tiny muted" }, [w.assignedAt ? new Date(w.assignedAt).toLocaleDateString() : "—"]) },
  { id: "due",       header: "Due",       sort: (a, b) => (Date.parse(a.due) || Infinity) - (Date.parse(b.due) || Infinity), filter: (w, q) => (w.due || "").toLowerCase().includes(q), render: (w) => el("span", { class: "tiny muted" }, [w.due ? new Date(w.due).toLocaleDateString() : "—"]) },
  { id: "blockers",  header: "Blocked by", sort: (a, b) => (a.blockers?.length || 0) - (b.blockers?.length || 0), filter: (w, q) => (w.blockers || []).join(",").toLowerCase().includes(q), render: (w) => renderBlockers(w) },
  { id: "labels",    header: "Labels",    sort: (a, b) => (a.labels?.length || 0) - (b.labels?.length || 0), filter: (w, q) => (w.labels || []).join(",").toLowerCase().includes(q), render: (w) => el("div", { class: "row wrap", style: { gap: "4px" } }, (w.labels || []).map(l => badge(l, "")) || []) },
];

// Default visible columns (ordered). Other columns are hidden until the
// user enables them via the column-visibility menu.
const DEFAULT_VISIBLE = ["id", "title", "type", "severity", "status", "assignee", "assigned", "due", "blockers"];

function sevRank(s) {
  return ({ critical: 0, high: 1, medium: 2, low: 3 })[s] ?? 4;
}

function renderBlockers(w) {
  const blockers = w.blockers || [];
  if (!blockers.length) return el("span", { class: "tiny muted" }, ["—"]);
  return el("span", { class: "row wrap", style: { gap: "4px" } },
    blockers.map(id => el("button", {
      class: "btn xs ghost",
      title: `Open ${id}`,
      onClick: (e) => { e.stopPropagation(); openItem(id); },
    }, [id]))
  );
}

function loadTableState(projectId) {
  try {
    const raw = sessionStorage.getItem(`board.table.${projectId}`);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}
function saveTableState(projectId, st) {
  try { sessionStorage.setItem(`board.table.${projectId}`, JSON.stringify(st)); } catch {}
}

function customFieldsFor(projectId) {
  return state.data?.customWorkItemFields?.[projectId] || [];
}

function tableView(items, batch, batchKey) {
  const projectId = items[0]?.projectId || "";
  const persisted = loadTableState(projectId) || {};
  const sort = persisted.sort || { col: null, dir: 1 };
  const filters = persisted.filters || {};
  const visible = persisted.visible || DEFAULT_VISIBLE;
  const customFields = customFieldsFor(projectId);

  // Build the column list — built-in columns the user has chosen + any
  // custom fields they've defined for this project. Custom fields render
  // via a generic accessor.
  const allCols = [
    ...COLUMN_DEFS,
    ...customFields.map(f => ({
      id: `cf:${f.id}`,
      header: f.name,
      custom: true,
      field: f,
      sort: (a, b) => String((a.customValues || {})[f.id] || "").localeCompare(String((b.customValues || {})[f.id] || "")),
      filter: (w, q) => String((w.customValues || {})[f.id] || "").toLowerCase().includes(q),
      render: (w) => {
        const v = (w.customValues || {})[f.id];
        if (v == null || v === "") return el("span", { class: "tiny muted" }, ["—"]);
        if (f.type === "date") return el("span", { class: "tiny muted" }, [new Date(v).toLocaleDateString()]);
        return el("span", { class: "small" }, [String(v)]);
      },
    })),
  ];
  const cols = visible.map(id => allCols.find(c => c.id === id)).filter(Boolean);

  // Apply per-column filters first, then sort.
  let rows = items.slice();
  for (const c of cols) {
    const f = filters[c.id];
    if (f) rows = rows.filter(w => c.filter(w, f.toLowerCase()));
  }
  if (sort.col) {
    const col = allCols.find(c => c.id === sort.col);
    if (col) rows = rows.sort((a, b) => col.sort(a, b) * sort.dir);
  }

  const setSort = (colId) => {
    const cur = sort.col === colId ? sort.dir : 0;
    const next = cur === 0 ? { col: colId, dir: 1 } : cur === 1 ? { col: colId, dir: -1 } : { col: null, dir: 1 };
    saveTableState(projectId, { ...persisted, sort: next });
    renderWorkBoard({ id: projectId });
  };
  const setFilter = (colId, val) => {
    const next = { ...filters, [colId]: val };
    if (!val) delete next[colId];
    saveTableState(projectId, { ...persisted, filters: next });
    renderWorkBoard({ id: projectId });
  };
  const toggleColumn = (colId) => {
    const next = visible.includes(colId) ? visible.filter(c => c !== colId) : [...visible, colId];
    saveTableState(projectId, { ...persisted, visible: next });
    renderWorkBoard({ id: projectId });
  };
  const addCustomField = () => {
    const name = window.prompt("Field name (e.g. \"Customer ref\")");
    if (!name || !name.trim()) return;
    const type = window.prompt("Type (text / number / date / select)", "text") || "text";
    const id = `cf-${Date.now().toString(36)}`;
    const field = { id, name: name.trim(), type: type.trim() };
    update(s => {
      s.data.customWorkItemFields = s.data.customWorkItemFields || {};
      s.data.customWorkItemFields[projectId] = [...(s.data.customWorkItemFields[projectId] || []), field];
    });
    toggleColumn(`cf:${id}`);
  };

  // Header cell classes: col-sortable always; is-sorted + sort-asc /
  // sort-desc only when this column is the active sort. Indicator
  // arrows are rendered as a CSS triangle via ::after, not inline text,
  // so headers stay precisely aligned.
  const headerClass = (colId) => {
    const cls = ["col-sortable"];
    if (sort.col === colId) {
      cls.push("is-sorted", sort.dir === 1 ? "sort-asc" : "sort-desc");
    }
    return cls.join(" ");
  };

  const headerRow = el("tr", {}, [
    el("th", { style: { width: "32px" } }, [""]),
    ...cols.map(c => el("th", {
      class: headerClass(c.id),
      onClick: () => setSort(c.id),
      title: "Click to toggle sort (asc → desc → none)",
    }, [c.header])),
    el("th", { style: { width: "40px" } }, [columnMenu(allCols, visible, toggleColumn, addCustomField)]),
  ]);
  const filterRow = el("tr", { class: "filter-row" }, [
    el("th", {}, [""]),
    ...cols.map(c => {
      const inp = input({ value: filters[c.id] || "", placeholder: "Filter…" });
      inp.addEventListener("input", () => {
        clearTimeout(inp._t);
        inp._t = setTimeout(() => setFilter(c.id, inp.value), 150);
      });
      return el("th", {}, [inp]);
    }),
    el("th", {}, [""]),
  ]);

  return card(`Items (${rows.length}/${items.length})`, el("div", { class: "stack", style: { gap: "0" } }, [
    el("table", { class: "table" }, [
      el("thead", {}, [headerRow, filterRow]),
      el("tbody", {}, rows.map(w => el("tr", {
        style: { cursor: "pointer", background: batch.includes(w.id) ? "var(--elevated)" : "" },
        onClick: (e) => { if (e.shiftKey) { toggleBatch(w.id, batchKey); renderWorkBoard({ id: w.projectId }); } else openItem(w.id); },
      }, [
        el("td", { onClick: e => e.stopPropagation() }, [
          el("input", { type: "checkbox", checked: batch.includes(w.id), onChange: () => { toggleBatch(w.id, batchKey); renderWorkBoard({ id: w.projectId }); } }),
        ]),
        ...cols.map(c => el("td", {}, [c.render(w)])),
        el("td", {}, [""]),
      ]))),
    ]),
    !rows.length ? el("div", { class: "muted tiny", style: { padding: "12px", textAlign: "center" } }, [
      items.length ? "No rows match the current filters." : "No items yet.",
    ]) : null,
  ].filter(Boolean)));
}

function columnMenu(allCols, visible, toggleColumn, addCustomField) {
  const wrap = el("span", { style: { position: "relative", display: "inline-block" } });
  let pop = null;
  const close = () => { if (pop) { pop.remove(); pop = null; document.removeEventListener("mousedown", onDoc, true); } };
  const onDoc = (e) => { if (pop && !pop.contains(e.target) && !wrap.contains(e.target)) close(); };
  const trigger = el("button", {
    class: "btn xs ghost",
    title: "Show/hide columns",
    "aria-haspopup": "menu",
    onClick: (e) => {
      e.stopPropagation();
      if (pop) { close(); return; }
      pop = el("div", {
        role: "menu",
        style: {
          position: "absolute", right: "0", top: "calc(100% + 4px)", zIndex: "100",
          background: "var(--surface)", border: "1px solid var(--border)",
          borderRadius: "8px", padding: "8px", minWidth: "200px",
          boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
        },
      }, [
        el("div", { class: "tiny strong", style: { padding: "4px" } }, ["Columns"]),
        ...allCols.map(c => {
          const checked = visible.includes(c.id);
          const cb = el("input", { type: "checkbox", checked, onChange: () => toggleColumn(c.id) });
          return el("label", { class: "row", style: { gap: "8px", padding: "4px", cursor: "pointer" } }, [
            cb,
            el("span", {}, [c.header]),
            c.custom ? badge("custom", "info") : null,
          ]);
        }),
        el("div", { style: { borderTop: "1px solid var(--border)", marginTop: "6px", paddingTop: "6px" } }, [
          el("button", { class: "btn xs", onClick: () => { close(); addCustomField(); } }, ["+ Custom field"]),
        ]),
      ]);
      wrap.appendChild(pop);
      document.addEventListener("mousedown", onDoc, true);
    },
  }, ["⋯"]);
  wrap.appendChild(trigger);
  return wrap;
}

// ---------- timeline (Gantt-ish) ----------
function timelineView(items) {
  const haveDates = items.filter(w => w.due);
  if (!haveDates.length) return card("Timeline", el("div", { class: "muted tiny" }, ["No due dates to plot."]));
  const starts = haveDates.map(w => w.created_at ? Date.parse(w.created_at) : Date.now());
  const ends = haveDates.map(w => Date.parse(w.due));
  const tMin = Math.min(...starts, Date.now() - 7 * 86400_000);
  const tMax = Math.max(...ends, Date.now() + 7 * 86400_000);
  const span = tMax - tMin;
  const rowH = 28;
  const H = rowH * haveDates.length + 40;

  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 1000 ${H}`);
  svg.setAttribute("width", "100%");
  svg.style.background = "var(--panel)";
  svg.style.borderRadius = "8px";

  // Today line
  const todayX = ((Date.now() - tMin) / span) * 1000;
  const today = document.createElementNS(NS, "line");
  today.setAttribute("x1", String(todayX)); today.setAttribute("y1", "0"); today.setAttribute("x2", String(todayX)); today.setAttribute("y2", String(H));
  today.setAttribute("stroke", "var(--accent)"); today.setAttribute("stroke-dasharray", "4 3");
  svg.append(today);

  // Week gridlines
  const msWeek = 7 * 86400_000;
  for (let t = Math.ceil(tMin / msWeek) * msWeek; t < tMax; t += msWeek) {
    const x = ((t - tMin) / span) * 1000;
    const ln = document.createElementNS(NS, "line");
    ln.setAttribute("x1", String(x)); ln.setAttribute("y1", "0"); ln.setAttribute("x2", String(x)); ln.setAttribute("y2", String(H));
    ln.setAttribute("stroke", "var(--border)"); ln.setAttribute("stroke-width", "0.5");
    svg.append(ln);
  }

  haveDates.forEach((w, i) => {
    const s = w.created_at ? Date.parse(w.created_at) : Date.now();
    const e = Date.parse(w.due);
    const x1 = ((s - tMin) / span) * 1000;
    const x2 = ((e - tMin) / span) * 1000;
    const y = 10 + i * rowH;

    const rect = document.createElementNS(NS, "rect");
    rect.setAttribute("x", String(Math.min(x1, x2))); rect.setAttribute("y", String(y));
    rect.setAttribute("width", String(Math.max(8, Math.abs(x2 - x1)))); rect.setAttribute("height", "16");
    const color = w.severity === "high" || w.severity === "critical" ? "#ef4444" : w.severity === "medium" ? "#f59e0b" : "#38bdf8";
    rect.setAttribute("fill", color); rect.setAttribute("rx", "3");
    rect.addEventListener("click", () => openItem(w.id));
    rect.style.cursor = "pointer";
    svg.append(rect);

    const txt = document.createElementNS(NS, "text");
    txt.setAttribute("x", String(Math.min(x1, x2) + 4)); txt.setAttribute("y", String(y + 12));
    txt.setAttribute("fill", "#fff"); txt.setAttribute("font-size", "11");
    txt.textContent = `${w.id}  ${w.title.slice(0, 28)}`;
    svg.append(txt);
  });

  return card("Timeline", svg, { subtitle: "Today = dashed accent line. Bars colored by severity." });
}

// ---------- calendar (month grid by due date) ----------
function calendarView(items, projectId) {
  const monthKey = `board.cal.${projectId}`;
  const cur = sessionStorage.getItem(monthKey);
  const today = new Date();
  const anchor = cur ? new Date(cur + "-01T00:00:00") : new Date(today.getFullYear(), today.getMonth(), 1);
  const year = anchor.getFullYear();
  const month = anchor.getMonth();

  // Group items by ISO date.
  const byDay = new Map();
  for (const w of items) {
    if (!w.due) continue;
    const d = new Date(w.due);
    if (d.getFullYear() !== year || d.getMonth() !== month) continue;
    const k = d.toISOString().slice(0, 10);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(w);
  }

  const monthLabel = anchor.toLocaleString(undefined, { month: "long", year: "numeric" });

  const setMonth = (delta) => {
    const next = new Date(year, month + delta, 1);
    sessionStorage.setItem(monthKey, `${next.getFullYear()}-${String(next.getMonth()+1).padStart(2,"0")}`);
    renderWorkBoard({ id: projectId });
  };

  // First-of-month weekday (Mon=0 … Sun=6).
  const first = new Date(year, month, 1);
  const startCol = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < startCol; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(year, month, d));
  while (cells.length % 7) cells.push(null);

  const headerRow = el("div", { class: "row spread", style: { marginBottom: "8px" } }, [
    el("button", { class: "btn sm", onClick: () => setMonth(-1), "aria-label": "previous month" }, ["← Prev"]),
    el("div", { class: "strong" }, [monthLabel]),
    el("button", { class: "btn sm", onClick: () => setMonth(1), "aria-label": "next month" }, ["Next →"]),
  ]);

  const weekdayHeader = el("div", { class: "calendar-grid header" },
    ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map(n => el("div", { class: "calendar-cell head" }, [n]))
  );

  const grid = el("div", { class: "calendar-grid" }, cells.map(c => {
    if (!c) return el("div", { class: "calendar-cell empty" });
    const k = c.toISOString().slice(0, 10);
    const list = byDay.get(k) || [];
    const isToday = c.toDateString() === today.toDateString();
    return el("div", { class: `calendar-cell ${isToday ? "today" : ""}` }, [
      el("div", { class: "calendar-date" }, [String(c.getDate())]),
      ...list.slice(0, 3).map(w => el("button", {
        class: `calendar-pill sev-${w.severity || "low"}`,
        title: w.title,
        onClick: () => openItem(w.id),
      }, [w.id + " · " + (w.title || "").slice(0, 18)])),
      list.length > 3 ? el("div", { class: "tiny muted" }, ["+", String(list.length - 3), " more"]) : null,
    ]);
  }));

  return card("Calendar", el("div", {}, [headerRow, weekdayHeader, grid]), {
    subtitle: "Items plotted by due date. Click a pill to open. Spec §6.2.",
  });
}

// ---------- dependency map ----------
function dependencyView(items) {
  // Mermaid flowchart built from the blocked-by graph. Falls back to a
  // hand-rolled SVG below.
  const lines = ["flowchart LR"];
  const safe = id => id.replace(/[^A-Za-z0-9_]/g, "_");
  for (const w of items) {
    const sev = w.severity === "high" || w.severity === "critical" ? ":::hi"
      : w.severity === "medium" ? ":::md" : ":::lo";
    lines.push(`  ${safe(w.id)}["${w.id}<br/>${(w.title || "").slice(0, 32)}"]${sev}`);
  }
  for (const w of items) {
    for (const bl of (w.blockers || [])) {
      if (items.some(x => x.id === bl)) lines.push(`  ${safe(bl)} --> ${safe(w.id)}`);
    }
  }
  lines.push("  classDef hi fill:#ef4444,stroke:#991b1b,color:#fff;");
  lines.push("  classDef md fill:#f59e0b,stroke:#92400e,color:#111;");
  lines.push("  classDef lo fill:#38bdf8,stroke:#075985,color:#111;");
  const def = lines.join("\n");
  return card("Dependency map (Mermaid)", el("div", { class: "stack" }, [
    renderMermaid(def),
    el("div", { class: "tiny muted" }, ["Rendered with mermaid-js (MIT). Falls back to in-repo SVG if offline."]),
    dependencyViewSvg(items),
  ]), { subtitle: "Red = high/critical severity. Arrows = blocked-by." });
}

function dependencyViewSvg(items) {
  // Force-free layout: position nodes by status column + order.
  const byStatus = {};
  for (const w of items) (byStatus[w.status] = byStatus[w.status] || []).push(w);
  const cols = COLUMNS.filter(c => byStatus[c]?.length);
  const W = 1000, H = 480;
  const colW = W / Math.max(1, cols.length);
  const coords = new Map();
  cols.forEach((c, ci) => {
    byStatus[c].forEach((w, i) => {
      coords.set(w.id, { x: colW * ci + colW / 2, y: 40 + (H - 80) * (i + 1) / (byStatus[c].length + 1) });
    });
  });

  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("width", "100%"); svg.style.background = "var(--panel)"; svg.style.borderRadius = "8px";

  // Draw dependency edges.
  for (const w of items) {
    const to = coords.get(w.id);
    for (const blocker of (w.blockers || [])) {
      const from = coords.get(blocker);
      if (!from || !to) continue;
      const path = document.createElementNS(NS, "line");
      path.setAttribute("x1", from.x); path.setAttribute("y1", from.y);
      path.setAttribute("x2", to.x); path.setAttribute("y2", to.y);
      path.setAttribute("stroke", "#ef4444"); path.setAttribute("stroke-width", "1.5");
      svg.append(path);
    }
  }

  // Draw nodes.
  for (const w of items) {
    const c = coords.get(w.id);
    if (!c) continue;
    const g = document.createElementNS(NS, "g");
    g.style.cursor = "pointer";
    g.addEventListener("click", () => openItem(w.id));
    const circle = document.createElementNS(NS, "circle");
    circle.setAttribute("cx", String(c.x)); circle.setAttribute("cy", String(c.y)); circle.setAttribute("r", "14");
    const fill = w.severity === "high" || w.severity === "critical" ? "#ef4444" : w.severity === "medium" ? "#f59e0b" : "#38bdf8";
    circle.setAttribute("fill", fill);
    g.append(circle);
    const txt = document.createElementNS(NS, "text");
    txt.setAttribute("x", String(c.x)); txt.setAttribute("y", String(c.y - 20));
    txt.setAttribute("text-anchor", "middle"); txt.setAttribute("font-size", "10"); txt.setAttribute("fill", "var(--text)");
    txt.textContent = w.id;
    g.append(txt);
    svg.append(g);
  }

  // Column headers.
  cols.forEach((c, ci) => {
    const t = document.createElementNS(NS, "text");
    t.setAttribute("x", String(colW * ci + colW / 2)); t.setAttribute("y", "20");
    t.setAttribute("text-anchor", "middle"); t.setAttribute("font-size", "12"); t.setAttribute("fill", "var(--muted)");
    t.textContent = c;
    svg.append(t);
  });

  return el("div", { class: "stack" }, [
    el("div", { class: "tiny muted" }, ["Hand-rolled SVG fallback (always available):"]),
    svg,
  ]);
}

// ---------- automation rules ----------
//
// Comprehensive listing of every automated behavior the system runs on
// behalf of a project, organized by category. Rendered on demand via the
// header "Rules" button, not as a constantly-visible card on the work
// board (it's reference material, not daily-driver UI).

const AUTOMATION_RULES = [
  {
    section: "Event routing (src/core/events.js · §9.3)",
    rules: [
      { trigger: "alarm event with severity SEV-1/SEV-2/critical/high", outcome: "Auto-create Incident with timeline anchor + asset link" },
      { trigger: "any alarm event", outcome: "Post a system message to the incident-kind channel" },
      { trigger: "po.created event OR source_type === \"erp\"", outcome: "Auto-create a Task work item bound to the asset/project" },
      { trigger: "opcua.state_change event", outcome: "Append entry to asset timeline (provenance: source, actor, ts)" },
      { trigger: "any event with asset_ref", outcome: "Fan out to subscribed followers of that asset" },
    ],
  },
  {
    section: "Protocol ingestion (server/connectors)",
    rules: [
      { trigger: "MQTT broker message on FORGE_MQTT_TOPICS (default forge/#)", outcome: "Normalise to canonical event envelope and pipe through routing rules" },
      { trigger: "OPC UA monitored-node value change (security mode + cert)", outcome: "Emit state_change event with old/new value, severity inferred" },
      { trigger: "Modbus TCP register write (FORGE_MODBUS_WRITE_MODE=live)", outcome: "Direct write to PLC + audit; default mode is simulated for safety" },
      { trigger: "Modbus TCP register polling (per-register polling_ms)", outcome: "Sample is recorded to historian_samples (and/or pluggable historian backend)" },
      { trigger: "Inbound POST /api/events from external systems (ERP, n8n, custom)", outcome: "Same canonical envelope + dedupe by dedupe_key" },
    ],
  },
  {
    section: "Background workers (server)",
    rules: [
      { trigger: "Saved-search subscription tick (default 60s)", outcome: "Match query against latest data; fire notification if results changed" },
      { trigger: "Retention worker tick (default 24h)", outcome: "Soft- or hard-delete rows matching policy.scope older than policy.days; respects active legal_holds" },
      { trigger: "Audit-tamper worker tick (default 1h)", outcome: "Re-hash audit_log and verify chain integrity end-to-end" },
      { trigger: "Outbox worker tick (5s)", outcome: "Publish queued events; DLQ after MAX_ATTEMPTS with structured error" },
      { trigger: "Webhook delivery (per outbox event with subscribed webhook)", outcome: "POST signed body to subscriber URL with retry + signature" },
      { trigger: "Metrics rollup tick (5m)", outcome: "Compute 9 KPI metrics from current state, write daily snapshot" },
    ],
  },
  {
    section: "Lifecycle automations",
    rules: [
      { trigger: "Revision transitions to IFC", outcome: "Auto-supersede the document's prior IFC revision; update document.current_revision_id" },
      { trigger: "Approval signing/decision", outcome: "Append HMAC-signed entry to approval.chain; audit ledger entry; update subject row" },
      { trigger: "Recipe version activate", outcome: "Mark previous active version as superseded; archive event to MSSQL recipe-history adapter (if configured)" },
      { trigger: "Login + MFA (if enabled)", outcome: "Mint refresh + access JWT pair; lockout after FORGE_LOGIN_LOCKOUT_THRESHOLD failures per account+IP" },
      { trigger: "Workspace switch", outcome: "Re-evaluate group access for current route; redirect to /home if access lost" },
    ],
  },
];

function showAutomationRulesModal() {
  const sections = AUTOMATION_RULES.map(group => el("div", { class: "stack", style: { gap: "6px" } }, [
    el("div", { class: "tiny strong", style: { textTransform: "uppercase", letterSpacing: "0.05em", marginTop: "8px" } }, [group.section]),
    ...group.rules.map(r => el("div", { class: "activity-row", style: { gap: "10px", alignItems: "flex-start" } }, [
      badge("rule", "info"),
      el("div", { class: "stack", style: { gap: "2px", flex: "1", minWidth: "0" } }, [
        el("div", { class: "small" }, [r.trigger]),
        el("div", { class: "tiny muted" }, ["→ ", r.outcome]),
      ]),
    ])),
  ]));

  modal({
    title: "Automation rules",
    body: el("div", { class: "stack", style: { gap: "8px", maxHeight: "70vh", overflow: "auto" } }, [
      el("div", { class: "tiny muted" }, [
        "Every automated behavior the system runs. Source-of-truth lives in code (src/core/events.js, server/connectors/*, server/*.js workers); this view is read-only reference material. Spec §6.2 / §9.3.",
      ]),
      ...sections,
    ]),
    actions: [{ label: "Close" }],
  });
}

// ---------- actions ----------
function changeStatus(itemId, newStatus) {
  const item = getById("workItems", itemId);
  if (!item) return;
  if (!can("edit")) { toast("Cannot transition — read-only role", "warn"); return; }
  const old = item.status;
  if (old === newStatus) return;
  update(s => { const i = s.data.workItems.find(x => x.id === itemId); if (i) i.status = newStatus; });
  audit("workitem.transition", itemId, { from: old, to: newStatus });
  toast(`${itemId} → ${newStatus}`, "success");
}

function openItem(itemId) {
  const w = getById("workItems", itemId);
  if (!w) return;
  const statusSelect = select(COLUMNS, { value: w.status });
  const severitySelect = select(["low","medium","high","critical"], { value: w.severity });
  const titleInput = input({ value: w.title });
  const descTextarea = textarea({ value: w.description || "" });
  const blockersInput = input({ value: (w.blockers || []).join(", ") });
  const userOptions = (state.data?.users || []).map(u => ({ value: u.id, label: `${u.id} · ${u.name || u.email || u.id}` }));
  const assigneeSelect = select([{ value: "", label: "Unassigned" }, ...userOptions], { value: w.assigneeId || "" });
  // Bind dates as <input type="date"> with yyyy-mm-dd shape so the
  // native date picker renders. Leaving the value blank clears it.
  const toDate = (iso) => iso ? new Date(iso).toISOString().slice(0, 10) : "";
  const assignedInput = input({ type: "date", value: toDate(w.assignedAt) });
  const dueInput = input({ type: "date", value: toDate(w.due) });

  drawer({
    title: `${w.id} — ${w.type}`,
    body: el("div", { class: "stack" }, [
      el("div", { class: "row wrap" }, [
        badge(w.status, "info"),
        badge(w.severity, w.severity === "high" || w.severity === "critical" ? "danger" : w.severity === "medium" ? "warn" : "info"),
        ...(w.assetIds || []).map(id => badge(`Asset ${id}`, "accent")),
      ]),
      formRow("Title", titleInput),
      formRow("Status", statusSelect),
      formRow("Severity", severitySelect),
      formRow("Assignee", assigneeSelect),
      formRow("Assigned date", assignedInput),
      formRow("Due date", dueInput),
      formRow("Description", descTextarea),
      formRow("Blocked by (comma-separated IDs)", blockersInput),
      historyDrawer(w),
    ]),
    actions: [
      { label: "Close" },
      { label: "Save", variant: "primary", onClick: () => {
        if (!can("edit")) { toast("No permission", "warn"); return; }
        update(s => {
          const i = s.data.workItems.find(x => x.id === itemId);
          if (!i) return;
          const from = { ...i };
          i.title = titleInput.value;
          i.status = statusSelect.value;
          i.severity = severitySelect.value;
          i.description = descTextarea.value;
          i.blockers = blockersInput.value.split(",").map(x => x.trim()).filter(Boolean);
          // Assignee change: stamp assignedAt to now if the user is
          // changing the assignee and didn't override the date input.
          // If they explicitly cleared assignedInput, leave it null.
          const newAssignee = assigneeSelect.value || null;
          if (newAssignee !== from.assigneeId) {
            i.assigneeId = newAssignee;
            if (assignedInput.value === toDate(from.assignedAt)) {
              i.assignedAt = newAssignee ? new Date().toISOString() : null;
            } else {
              i.assignedAt = assignedInput.value ? new Date(assignedInput.value).toISOString() : null;
            }
          } else {
            i.assignedAt = assignedInput.value ? new Date(assignedInput.value).toISOString() : null;
          }
          i.due = dueInput.value ? new Date(dueInput.value).toISOString() : null;
          audit("workitem.update", itemId, { changes: diff(from, i) });
        });
        toast("Saved", "success");
      }},
    ],
  });
}

function historyDrawer(w) {
  const ev = (state.data.auditEvents || []).filter(e => e.subject === w.id).slice(0, 8);
  if (!ev.length) return el("div", { class: "tiny muted" }, ["(no history)"]);
  return el("div", {}, [
    el("div", { class: "tiny muted" }, ["History"]),
    ev.map(e => el("div", { class: "activity-row" }, [
      el("span", { class: "ts" }, [new Date(e.ts).toLocaleString()]),
      el("span", { class: "small" }, [e.action]),
      el("span", { class: "tiny muted" }, [e.actor]),
    ])),
  ]);
}

function diff(a, b) {
  const out = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out[k] = [a[k], b[k]];
  }
  return out;
}

function openNewItem(projectId) {
  const titleInput = input({ placeholder: "Short title" });
  const typeSelect = select(["Task","Issue","Action","RFI","NCR","Punch","Defect","CAPA","Change"]);
  const severitySelect = select(["low","medium","high","critical"], { value: "medium" });
  const assigneeSelect = select(state.data.users.map(u => ({ value: u.id, label: u.name })));
  modal({
    title: "New work item",
    body: el("div", { class: "stack" }, [
      formRow("Title", titleInput),
      formRow("Type", typeSelect),
      formRow("Severity", severitySelect),
      formRow("Assignee", assigneeSelect),
    ]),
    actions: [
      { label: "Cancel" },
      { label: "Create", variant: "primary", onClick: () => {
        if (!titleInput.value.trim()) { toast("Title required", "warn"); return false; }
        const id = simulation.demoId("WI", state.data.workItems || []);
        const item = {
          id, projectId, type: typeSelect.value, title: titleInput.value.trim(),
          assigneeId: assigneeSelect.value, status: "Open", severity: severitySelect.value,
          due: null, blockers: [], labels: [],
          created_at: new Date().toISOString(),
        };
        update(s => { s.data.workItems.push(item); });
        audit("workitem.create", id, { type: item.type });
        toast(`${id} created`, "success");
      }},
    ],
  });
}
