// Asana-like table view, extracted from workBoard.js (Round 4 of the
// Phase 4 decomposition).
//
// Sortable column headers (click to toggle asc / desc / clear),
// per-column text filters (input row below the headers), and a
// column-visibility menu so users can show/hide columns. Sort,
// filter, and visibility state is per-scope and persists across
// navigation via sessionStorage — it does NOT live in the global
// store because it's view scaffolding, not data.
//
// Linkages: `blockers` is rendered as a clickable list that
// navigates to the linked work item. The link picker (modal) is
// opened from the cell to add/remove blockers without leaving the
// table.
//
// Custom columns: `state.data.customWorkItemFields[scope.id]` is a
// per-project list of `{ id, name, type, options? }`. Values are
// read from `workItem.customValues[fieldId]`. Type can be text |
// number | date | select. New fields are added via the
// column-visibility menu — except when `scope.id === "all"`, where
// custom fields aren't applicable (they're tied to a specific
// project) so the "+ Custom field" entry is gated.

import { el, badge, card, input, toast } from "../core/ui.js";
import { state, update } from "../core/store.js";
import { openItem } from "./workBoardItem.js";
import { toggleBatch } from "./workBoardBatch.js";

function sevRank(s) {
  return ({ critical: 0, high: 1, medium: 2, low: 3 })[s] ?? 4;
}

function renderBlockers(w) {
  const blockers = w.blockers || [];
  if (!blockers.length) return el("span", { class: "tiny muted" }, ["—"]);
  return el("span", { class: "row wrap gap-1" },
    blockers.map(id => el("button", {
      class: "btn xs ghost",
      title: `Open ${id}`,
      onClick: (e) => { e.stopPropagation(); openItem(id); },
    }, [id]))
  );
}

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
  { id: "labels",    header: "Labels",    sort: (a, b) => (a.labels?.length || 0) - (b.labels?.length || 0), filter: (w, q) => (w.labels || []).join(",").toLowerCase().includes(q), render: (w) => el("div", { class: "row wrap gap-1" }, (w.labels || []).map(l => badge(l, "")) || []) },
];

// Default visible columns (ordered). Other columns are hidden until the
// user enables them via the column-visibility menu.
const DEFAULT_VISIBLE = ["id", "title", "type", "severity", "status", "assignee", "assigned", "due", "blockers"];

function loadTableState(scopeId) {
  try {
    const raw = sessionStorage.getItem(`board.table.${scopeId}`);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}
function saveTableState(scopeId, st) {
  try { sessionStorage.setItem(`board.table.${scopeId}`, JSON.stringify(st)); } catch {}
}

function customFieldsFor(scopeId) {
  return state.data?.customWorkItemFields?.[scopeId] || [];
}

function projectNameForId(id) {
  if (!id) return "—";
  const p = (state.data?.projects || []).find(x => x.id === id);
  return p?.name || id;
}

// Pseudo-column for the all-work scope: shows the project name. Hidden
// when scope is a single project (it would be redundant).
const PROJECT_COLUMN_DEF = {
  id: "project",
  header: "Project",
  sort: (a, b) => String(projectNameForId(a.projectId)).localeCompare(String(projectNameForId(b.projectId))),
  filter: (w, q) => projectNameForId(w.projectId).toLowerCase().includes(q),
  render: (w) => el("span", { class: "tiny" }, [projectNameForId(w.projectId)]),
};

/**
 * @param {any[]} items
 * @param {{ id: string, rerender: () => void, showProjectColumn?: boolean }} scope
 * @param {string[]} batch
 * @param {string} batchKey
 */
export function tableView(items, scope, batch, batchKey) {
  const persisted = loadTableState(scope.id) || {};
  const sort = persisted.sort || { col: null, dir: 1 };
  const filters = persisted.filters || {};
  // Default-visible columns: in all-work scope we add a "project" column
  // up front so users know which project each row belongs to.
  const baseDefaults = scope.showProjectColumn ? ["id", "project", ...DEFAULT_VISIBLE.filter(c => c !== "id")] : DEFAULT_VISIBLE;
  const visible = persisted.visible || baseDefaults;
  const customFields = scope.id === "all" ? [] : customFieldsFor(scope.id);

  // Build the column list — built-in columns the user has chosen + any
  // custom fields they've defined for this project. Custom fields render
  // via a generic accessor.
  const allCols = [
    ...COLUMN_DEFS,
    ...(scope.showProjectColumn ? [PROJECT_COLUMN_DEF] : []),
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
    saveTableState(scope.id, { ...persisted, sort: next });
    scope.rerender();
  };
  const setFilter = (colId, val) => {
    const next = { ...filters, [colId]: val };
    if (!val) delete next[colId];
    saveTableState(scope.id, { ...persisted, filters: next });
    scope.rerender();
  };
  const toggleColumn = (colId) => {
    const next = visible.includes(colId) ? visible.filter(c => c !== colId) : [...visible, colId];
    saveTableState(scope.id, { ...persisted, visible: next });
    scope.rerender();
  };
  const addCustomField = () => {
    if (scope.id === "all") {
      toast("Custom fields are project-scoped. Open a specific project to add them.", "warn");
      return;
    }
    const name = window.prompt("Field name (e.g. \"Customer ref\")");
    if (!name || !name.trim()) return;
    const type = window.prompt("Type (text / number / date / select)", "text") || "text";
    const id = `cf-${Date.now().toString(36)}`;
    const field = { id, name: name.trim(), type: type.trim() };
    update(s => {
      s.data.customWorkItemFields = s.data.customWorkItemFields || {};
      s.data.customWorkItemFields[scope.id] = [...(s.data.customWorkItemFields[scope.id] || []), field];
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
        onClick: (e) => { if (e.shiftKey) { toggleBatch(w.id, batchKey); scope.rerender(); } else openItem(w.id); },
      }, [
        el("td", { onClick: e => e.stopPropagation() }, [
          el("input", { type: "checkbox", checked: batch.includes(w.id), onChange: () => { toggleBatch(w.id, batchKey); scope.rerender(); } }),
        ]),
        ...cols.map(c => el("td", {}, [c.render(w)])),
        el("td", {}, [""]),
      ]))),
    ]),
    !rows.length ? el("div", { class: "muted tiny p-3 center" }, [
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
        el("div", { class: "tiny strong p-1" }, ["Columns"]),
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
