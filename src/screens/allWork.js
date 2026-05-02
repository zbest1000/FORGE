// Cross-project work view (the "centralised inbox" pattern).
//
// FORGE's per-project work board (`workBoard.js` at /work-board/:id)
// is the deep-dive surface — every project has its own kanban + table
// + timeline + calendar, scoped to that project's items.
//
// What was missing — and what users immediately reach for after their
// second project — is the inverse: ALL work items in one view,
// filtered by project / status / severity / assignee / type, so the
// operator stays in one place and FILTERS down rather than hopping
// projects. This screen is that view.
//
// Information architecture:
//   /work          this screen — every work item in the workspace
//   /work-board/:id  per-project drill-down (the existing screen)
//   Each card here links to its per-project drawer for the deep
//   actions, so you never lose context.
//
// The view supports two modes (board + table). Timeline / calendar /
// batch ops are intentionally out of scope — they make sense in the
// per-project context where the user has already scoped the data,
// less so on the firehose. If a real user case appears we can add
// them.

import { el, mount, badge, card, kpi, table, formRow, select, input } from "../core/ui.js";
import { state } from "../core/store.js";
import { navigate } from "../core/router.js";
import { canSeeAsset } from "../core/groups.js";

// True when the current user can see this work item. A work item is
// considered visible if EITHER:
//   * It has no asset link (a general task — visible to everyone in
//     the workspace), OR
//   * At least one of the linked assets passes `canSeeAsset()`
//     (group/portal-aware visibility from src/core/groups.js).
// This keeps the firehose honest: an operator without access to a
// restricted asset doesn't see its work items in the cross-project
// view either.
function canSeeWorkItem(item, assets) {
  const ids = Array.isArray(item.assetIds) ? item.assetIds : (item.assetIds ? [item.assetIds] : []);
  if (ids.length === 0) return true;
  return ids.some(id => {
    const a = assets.find(x => x.id === id);
    return a ? canSeeAsset(a) : true; // unknown asset id → don't hide
  });
}

// Persist filter selections per-session so opening another screen +
// returning here doesn't reset the operator's view.
const SS_FILTERS = "allWork.filters.v1";
const SS_VIEW = "allWork.view.v1";

const STATUS_ORDER = ["Backlog", "Open", "In Progress", "In Review", "Approved", "Done"];
const SEVERITY_VARIANT = {
  critical: "danger",
  high: "danger",
  medium: "warn",
  low: "info",
};

function readFilters() {
  try {
    const raw = sessionStorage.getItem(SS_FILTERS);
    if (!raw) return defaultFilters();
    const parsed = JSON.parse(raw);
    return { ...defaultFilters(), ...parsed };
  } catch {
    return defaultFilters();
  }
}

function defaultFilters() {
  return {
    projectId: "",      // "" = all projects
    status: "",         // "" = all statuses
    severity: "",
    assigneeId: "",
    type: "",
    mine: false,        // true → only items assigned to current user
    dueWindow: "",      // "" | "overdue" | "today" | "week" | "month"
  };
}

function saveFilters(f) {
  try { sessionStorage.setItem(SS_FILTERS, JSON.stringify(f)); } catch { /* private mode */ }
}

function readView() {
  try { return sessionStorage.getItem(SS_VIEW) || "board"; } catch { return "board"; }
}

function saveView(v) {
  try { sessionStorage.setItem(SS_VIEW, v); } catch { /* private mode */ }
}

// Filter predicate. Single source of truth so board + table see the
// same set of items.
function passes(item, filters, currentUserId) {
  if (filters.projectId && item.projectId !== filters.projectId) return false;
  if (filters.status && item.status !== filters.status) return false;
  if (filters.severity && item.severity !== filters.severity) return false;
  if (filters.assigneeId && item.assigneeId !== filters.assigneeId) return false;
  if (filters.type && item.type !== filters.type) return false;
  if (filters.mine && item.assigneeId !== currentUserId) return false;
  if (filters.dueWindow) {
    if (!item.due) return false;
    const due = new Date(item.due).getTime();
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    switch (filters.dueWindow) {
      case "overdue":
        if (due >= now) return false;
        break;
      case "today":
        if (due < now || due > now + day) return false;
        break;
      case "week":
        if (due < now || due > now + 7 * day) return false;
        break;
      case "month":
        if (due < now || due > now + 30 * day) return false;
        break;
    }
  }
  return true;
}

export function renderAllWork() {
  const root = document.getElementById("screenContainer");
  if (!root) return;
  const d = state.data || {};
  const projects = d.projects || [];
  const users = d.users || [];
  const assets = d.assets || [];
  // Apply permission filter BEFORE user filters so the visible-item
  // count + KPIs reflect what the user actually has access to.
  const items = (d.workItems || []).filter(w => canSeeWorkItem(w, assets));

  const filters = readFilters();
  const view = readView();
  const currentUserId = state.data?.currentUserId || state.ui?.currentUserId || null;

  // Build the visible set once. Filters apply identically in board + table.
  const visible = items.filter(w => passes(w, filters, currentUserId));

  // KPI strip — gives the operator a sense of the funnel before they
  // start filtering.
  const kpis = el("div", { class: "card-grid mb-4" }, [
    kpi("Visible items", String(visible.length), `${items.length} total`, ""),
    kpi("Open", String(visible.filter(w => ["Open", "In Progress"].includes(w.status)).length), "actionable", ""),
    kpi("Awaiting review", String(visible.filter(w => w.status === "In Review").length), "needs eyes", ""),
    kpi("Overdue", String(visible.filter(w => w.due && new Date(w.due).getTime() < Date.now() && w.status !== "Done").length), "past due", "down"),
    kpi("Mine", String(visible.filter(w => w.assigneeId === currentUserId).length), "assigned to you", ""),
  ]);

  mount(root, [
    headerCard(),
    filterBar(),
    kpis,
    view === "table" ? renderTable() : renderBoard(),
  ]);

  function headerCard() {
    return el("div", { class: "row spread mb-3" }, [
      el("div", {}, [
        el("h2", { class: "m-0" }, ["Activity"]),
        el("div", { class: "tiny muted" }, [
          `Every work item you can access across ${projects.length} project${projects.length === 1 ? "" : "s"} in this workspace. `,
          "Filters narrow what you see; click a card to open it in its project board.",
        ]),
      ]),
      el("div", { class: "row gap-2" }, [
        el("button", {
          class: `btn sm ${view === "board" ? "primary" : ""}`.trim(),
          onClick: () => { saveView("board"); renderAllWork(); },
        }, ["Board"]),
        el("button", {
          class: `btn sm ${view === "table" ? "primary" : ""}`.trim(),
          onClick: () => { saveView("table"); renderAllWork(); },
        }, ["Table"]),
      ]),
    ]);
  }

  function filterBar() {
    const projectOpts = [
      { value: "", label: "All projects" },
      ...projects.map(p => ({ value: p.id, label: p.name })),
    ];
    const statusOpts = [
      { value: "", label: "Any status" },
      ...STATUS_ORDER.map(s => ({ value: s, label: s })),
    ];
    const severityOpts = [
      { value: "", label: "Any severity" },
      { value: "critical", label: "Critical" },
      { value: "high", label: "High" },
      { value: "medium", label: "Medium" },
      { value: "low", label: "Low" },
    ];
    const assigneeOpts = [
      { value: "", label: "Anyone" },
      ...users.map(u => ({ value: u.id, label: u.name })),
    ];
    const typeOpts = [
      { value: "", label: "Any type" },
      ...uniqueTypes(items).map(t => ({ value: t, label: t })),
    ];
    const dueOpts = [
      { value: "", label: "Any due date" },
      { value: "overdue", label: "Overdue" },
      { value: "today", label: "Due today" },
      { value: "week", label: "Due this week" },
      { value: "month", label: "Due this month" },
    ];

    const updates = (key) => (e) => {
      const val = e.target.type === "checkbox" ? e.target.checked : e.target.value;
      const next = { ...filters, [key]: val };
      saveFilters(next);
      renderAllWork();
    };

    const reset = () => {
      saveFilters(defaultFilters());
      renderAllWork();
    };

    const filterCount = countActive(filters);

    return card(
      "Filters",
      el("div", { class: "row wrap gap-2" }, [
        labeledSelect("Project",  projectOpts,  filters.projectId, updates("projectId")),
        labeledSelect("Status",   statusOpts,   filters.status,    updates("status")),
        labeledSelect("Severity", severityOpts, filters.severity,  updates("severity")),
        labeledSelect("Assignee", assigneeOpts, filters.assigneeId, updates("assigneeId")),
        labeledSelect("Type",     typeOpts,     filters.type,      updates("type")),
        labeledSelect("Due",      dueOpts,      filters.dueWindow, updates("dueWindow")),
        el("label", { class: "row gap-1", style: { alignItems: "center" } }, [
          el("input", { type: "checkbox", checked: filters.mine, onChange: updates("mine") }),
          el("span", { class: "small" }, ["Mine only"]),
        ]),
        filterCount > 0
          ? el("button", { class: "btn sm", onClick: reset }, [`Clear (${filterCount})`])
          : null,
      ]),
      { subtitle: filterCount > 0 ? `${filterCount} filter${filterCount === 1 ? "" : "s"} active` : "Showing every work item" },
    );
  }

  function renderBoard() {
    // Group visible items by status. Render every status as a column
    // even if empty so the operator sees the funnel.
    const byStatus = {};
    for (const s of STATUS_ORDER) byStatus[s] = [];
    for (const w of visible) {
      const bucket = byStatus[w.status] || (byStatus[w.status] = []);
      bucket.push(w);
    }

    return el("div", { class: "kanban mt-3" }, STATUS_ORDER.map(status => {
      const col = byStatus[status] || [];
      return el("div", { class: "kanban-col" }, [
        el("div", { class: "kanban-col-header" }, [
          el("span", {}, [status]),
          el("span", { class: "tiny muted" }, [String(col.length)]),
        ]),
        ...col.map(workCard),
        col.length === 0 ? el("div", { class: "muted tiny center p-2" }, ["No items"]) : null,
      ]);
    }));
  }

  function workCard(w) {
    const project = projects.find(p => p.id === w.projectId);
    const assetIds = Array.isArray(w.assetIds) ? w.assetIds : (w.assetIds ? [w.assetIds] : []);
    const visibleAssetIds = assetIds.filter(id => assets.find(a => a.id === id && canSeeAsset(a)));
    const sevVariant = SEVERITY_VARIANT[w.severity] || "info";
    const overdue = w.due && new Date(w.due).getTime() < Date.now() && w.status !== "Done";

    return el("button", {
      class: "kanban-card",
      type: "button",
      // Hash with `?wi=` so the per-project board can pick the item up
      // and open the drawer. The board screen reads it on render.
      onClick: () => navigate(`/work-board/${w.projectId}?wi=${encodeURIComponent(w.id)}`),
    }, [
      el("div", { class: "row spread" }, [
        el("span", { class: "card-id" }, [w.id]),
        badge(w.type, "info"),
      ]),
      el("div", { class: "card-title" }, [w.title]),
      el("div", { class: "card-meta row wrap gap-1" }, [
        badge(w.severity, sevVariant),
        project ? badge(project.name, "purple") : null,
        w.due ? el("span", { class: `tiny ${overdue ? "danger-text" : "muted"}` }, [
          (overdue ? "overdue " : "due ") + new Date(w.due).toLocaleDateString(),
        ]) : null,
        w.blockers?.length ? badge(`blocked:${w.blockers.length}`, "danger") : null,
        w.assigneeId ? el("span", { class: "tiny muted" }, ["@ " + (users.find(u => u.id === w.assigneeId)?.name || w.assigneeId)]) : null,
        ...visibleAssetIds.slice(0, 2).map(id => {
          const a = assets.find(x => x.id === id);
          return a ? badge(a.name, "accent") : null;
        }),
      ]),
    ]);
  }

  function renderTable() {
    const columns = [
      { key: "id", header: "ID", render: (r) => el("span", { class: "mono tiny" }, [r.id]) },
      { key: "title", header: "Title" },
      { key: "type", header: "Type", render: (r) => badge(r.type, "info") },
      { key: "status", header: "Status", render: (r) => badge(r.status, statusVariant(r.status)) },
      { key: "severity", header: "Severity", render: (r) => badge(r.severity, SEVERITY_VARIANT[r.severity] || "info") },
      { key: "project", header: "Project", render: (r) => {
          const p = projects.find(x => x.id === r.projectId);
          return p ? badge(p.name, "purple") : "—";
        } },
      { key: "assignee", header: "Assignee", render: (r) => {
          const u = users.find(x => x.id === r.assigneeId);
          return u ? u.name : "—";
        } },
      { key: "due", header: "Due", render: (r) => {
          if (!r.due) return "—";
          const overdue = new Date(r.due).getTime() < Date.now() && r.status !== "Done";
          return el("span", { class: overdue ? "danger-text" : "" }, [new Date(r.due).toLocaleDateString()]);
        } },
    ];

    if (visible.length === 0) {
      return card("No items match", el("div", { class: "muted center p-6" }, [
        "No work items match the current filters. Clear a filter to see more.",
      ]));
    }

    return el("div", { class: "mt-3" }, [
      table({
        columns,
        rows: visible,
        onRowClick: (row) => navigate(`/work-board/${row.projectId}?wi=${encodeURIComponent(row.id)}`),
      }),
    ]);
  }
}

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

function labeledSelect(label, options, value, onChange) {
  // A compact filter pill: label on top, native <select> below.
  const sel = select(options, { value, onChange });
  return el("label", { class: "stack", style: { gap: "2px" } }, [
    el("span", { class: "tiny muted" }, [label]),
    sel,
  ]);
}

function uniqueTypes(items) {
  const set = new Set();
  for (const w of items) if (w.type) set.add(w.type);
  return [...set].sort();
}

function countActive(f) {
  let n = 0;
  if (f.projectId) n++;
  if (f.status) n++;
  if (f.severity) n++;
  if (f.assigneeId) n++;
  if (f.type) n++;
  if (f.dueWindow) n++;
  if (f.mine) n++;
  return n;
}

function statusVariant(s) {
  if (s === "Done" || s === "Approved") return "success";
  if (s === "In Review") return "warn";
  if (s === "Backlog") return "";
  return "info";
}

export default { renderAllWork };
