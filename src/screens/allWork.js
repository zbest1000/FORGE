// Consolidated all-work view (`/work`).
//
// Independent of any single project — surfaces every work item the
// viewer can see, with three viewing modes:
//
//   - Kanban  : columns by status, cards filterable by everything below
//   - Table   : sortable rows
//   - Calendar: month grid keyed by `due` date
//
// Filters: search text + status + assignee + project + due-date
// preset (overdue / this week / this month / any) + show-completed
// toggle. Each filter persists in sessionStorage.

import { el, mount, badge, toast, tabs } from "../core/ui.js";
import { state } from "../core/store.js";
import { navigate } from "../core/router.js";
import { helpHint, helpLinkChip } from "../core/help.js";

const SS_VIEW       = "allwork.view";
const SS_FILTER     = "allwork.filter";
const SS_STATUS     = "allwork.status";
const SS_ASSIGNEE   = "allwork.assignee";
const SS_PROJECT    = "allwork.project";
const SS_DUE        = "allwork.due";
const SS_COMPLETED  = "allwork.includeCompleted";

const STATUS_OPTIONS = ["Backlog", "Open", "In Progress", "In Review", "Blocked", "Done", "Closed"];

export function renderAllWork() {
  const root = document.getElementById("screenContainer");
  const view = sessionStorage.getItem(SS_VIEW) || "kanban";

  const filters = readFilters();
  const allItems = collectWorkItems();
  const filtered = applyFilters(allItems, filters);

  mount(root, [
    headerRow(filtered.length, allItems.length),
    filterBar(filters),
    tabs({
      sessionKey: SS_VIEW,
      defaultId: view,
      ariaLabel: "All-work view",
      tabs: [
        { id: "kanban",   label: "Kanban",   content: () => kanbanView(filtered) },
        { id: "table",    label: "Table",    content: () => tableView(filtered) },
        { id: "calendar", label: "Calendar", content: () => calendarView(filtered) },
      ],
    }),
  ]);
}

function headerRow(matchCount, total) {
  return el("div", { class: "row spread mb-3" }, [
    el("div", {}, [
      el("h2", { style: { margin: 0, display: "inline-flex", alignItems: "center" } }, [
        "All work", helpHint("forge.workitem"),
      ]),
      el("div", { class: "tiny muted" }, [
        `${matchCount} of ${total} work items · across every project you can see.`,
      ]),
      el("div", { class: "row wrap", style: { gap: "6px", marginTop: "6px" } }, [
        helpLinkChip("forge.workitem", "Work items"),
        helpLinkChip("forge.approvals", "Approvals"),
        helpLinkChip("forge.incidents.severity", "Severity"),
      ]),
    ]),
    el("div", { class: "row" }, [
      el("button", { class: "btn sm primary", onClick: () => navigate("/projects") }, ["Open by project →"]),
      el("button", { class: "btn sm", onClick: () => navigate("/approvals") }, ["Approval queue →"]),
    ]),
  ]);
}

function readFilters() {
  return {
    text:    sessionStorage.getItem(SS_FILTER) || "",
    status:  sessionStorage.getItem(SS_STATUS) || "",
    assignee:sessionStorage.getItem(SS_ASSIGNEE) || "",
    project: sessionStorage.getItem(SS_PROJECT) || "",
    due:     sessionStorage.getItem(SS_DUE) || "any",
    includeCompleted: sessionStorage.getItem(SS_COMPLETED) === "1",
  };
}

function setFilter(key, value) {
  if (value) sessionStorage.setItem(key, value);
  else sessionStorage.removeItem(key);
  renderAllWork();
}

function filterBar(filters) {
  const d = state.data || {};
  const projects = d.projects || [];
  const users = d.users || [];

  const search = el("input", {
    type: "search", class: "input", placeholder: "Search by title, id, label…",
    value: filters.text, "aria-label": "Search work items",
  });
  let timer = null;
  search.addEventListener("input", () => {
    clearTimeout(timer);
    const v = /** @type {HTMLInputElement} */ (search).value;
    timer = setTimeout(() => {
      setFilter(SS_FILTER, v);
      // Restore focus after re-render
      setTimeout(() => {
        const fresh = document.querySelector('input[aria-label="Search work items"]');
        if (fresh instanceof HTMLInputElement) {
          fresh.focus();
          try { fresh.setSelectionRange(v.length, v.length); } catch {}
        }
      }, 0);
    }, 120);
  });

  const statusSel = el("select", { class: "select sm", "aria-label": "Filter by status" });
  ["", ...STATUS_OPTIONS].forEach(s => {
    const opt = document.createElement("option");
    opt.value = s; opt.textContent = s || "All statuses";
    if (s === filters.status) opt.selected = true;
    statusSel.append(opt);
  });
  statusSel.addEventListener("change", () => setFilter(SS_STATUS, /** @type {HTMLSelectElement} */ (statusSel).value));

  const assigneeSel = el("select", { class: "select sm", "aria-label": "Filter by assignee" });
  const meId = d.currentUserId;
  const assigneeOpts = [
    { value: "", label: "All assignees" },
    { value: "me", label: "Assigned to me" },
    { value: "unassigned", label: "Unassigned" },
    ...users.map(u => ({ value: u.id, label: u.name })),
  ];
  for (const o of assigneeOpts) {
    const opt = document.createElement("option");
    opt.value = o.value; opt.textContent = o.label;
    if (o.value === filters.assignee) opt.selected = true;
    assigneeSel.append(opt);
  }
  assigneeSel.addEventListener("change", () => setFilter(SS_ASSIGNEE, /** @type {HTMLSelectElement} */ (assigneeSel).value));

  const projectSel = el("select", { class: "select sm", "aria-label": "Filter by project" });
  const projectOpts = [{ value: "", label: "All projects" }, ...projects.map(p => ({ value: p.id, label: p.name }))];
  for (const o of projectOpts) {
    const opt = document.createElement("option");
    opt.value = o.value; opt.textContent = o.label;
    if (o.value === filters.project) opt.selected = true;
    projectSel.append(opt);
  }
  projectSel.addEventListener("change", () => setFilter(SS_PROJECT, /** @type {HTMLSelectElement} */ (projectSel).value));

  const dueSel = el("select", { class: "select sm", "aria-label": "Filter by due date" });
  const dueOpts = [
    { value: "any", label: "Any due date" },
    { value: "overdue", label: "Overdue" },
    { value: "today", label: "Due today" },
    { value: "week", label: "Due this week" },
    { value: "month", label: "Due this month" },
    { value: "no-due", label: "No due date" },
  ];
  for (const o of dueOpts) {
    const opt = document.createElement("option");
    opt.value = o.value; opt.textContent = o.label;
    if (o.value === filters.due) opt.selected = true;
    dueSel.append(opt);
  }
  dueSel.addEventListener("change", () => setFilter(SS_DUE, /** @type {HTMLSelectElement} */ (dueSel).value));

  const completedToggle = el("label", { class: "row", style: { gap: "4px", alignItems: "center" } }, [
    el("input", {
      type: "checkbox",
      checked: filters.includeCompleted,
      onChange: (e) => setFilter(SS_COMPLETED, /** @type {HTMLInputElement} */ (e.target).checked ? "1" : ""),
    }),
    el("span", { class: "tiny" }, ["Include done / closed"]),
  ]);

  const clearBtn = el("button", {
    class: "btn sm ghost",
    onClick: () => {
      [SS_FILTER, SS_STATUS, SS_ASSIGNEE, SS_PROJECT, SS_DUE, SS_COMPLETED].forEach(k => sessionStorage.removeItem(k));
      renderAllWork();
    },
  }, ["Clear filters"]);

  return el("div", { class: "row wrap mb-3", style: { gap: "8px", alignItems: "center" } }, [
    el("div", { style: { flex: "1 1 240px" } }, [search]),
    statusSel,
    assigneeSel,
    projectSel,
    dueSel,
    completedToggle,
    clearBtn,
  ]);
}

function collectWorkItems() {
  const d = state.data || {};
  return (d.workItems || []).slice();
}

function applyFilters(items, filters) {
  const now = Date.now();
  const startOfDay = (() => { const x = new Date(); x.setHours(0,0,0,0); return x.getTime(); })();
  const startOfTomorrow = startOfDay + 24 * 60 * 60 * 1000;
  const startOfNextWeek = startOfDay + 7 * 24 * 60 * 60 * 1000;
  const startOfNextMonth = (() => { const x = new Date(); x.setMonth(x.getMonth() + 1, 1); x.setHours(0,0,0,0); return x.getTime(); })();
  const meId = state.data?.currentUserId;

  return items.filter(w => {
    // Done / closed gate
    if (!filters.includeCompleted && (w.status === "Done" || w.status === "Closed")) return false;
    if (filters.status && w.status !== filters.status) return false;
    if (filters.project && w.projectId !== filters.project) return false;
    if (filters.assignee) {
      if (filters.assignee === "me") {
        if (w.assigneeId !== meId) return false;
      } else if (filters.assignee === "unassigned") {
        if (w.assigneeId) return false;
      } else if (w.assigneeId !== filters.assignee) return false;
    }
    if (filters.due && filters.due !== "any") {
      const due = w.due ? Date.parse(w.due) : null;
      if (filters.due === "no-due" && due) return false;
      if (filters.due === "overdue") {
        if (!due || due >= startOfDay || w.status === "Done" || w.status === "Closed") return false;
      }
      if (filters.due === "today") {
        if (!due || due < startOfDay || due >= startOfTomorrow) return false;
      }
      if (filters.due === "week") {
        if (!due || due < startOfDay || due >= startOfNextWeek) return false;
      }
      if (filters.due === "month") {
        if (!due || due < startOfDay || due >= startOfNextMonth) return false;
      }
    }
    if (filters.text) {
      const t = filters.text.toLowerCase();
      const hay = `${w.id} ${w.title} ${(w.labels || []).join(" ")} ${w.type || ""}`.toLowerCase();
      if (!hay.includes(t)) return false;
    }
    return true;
  });
}

// ---------- Kanban ----------

function kanbanView(items) {
  const cols = STATUS_OPTIONS.map(status => ({
    status,
    items: items.filter(w => w.status === status),
  })).filter(c => c.items.length || ["Backlog", "Open", "In Progress", "Done"].includes(c.status));

  return el("div", { class: "kanban-board", style: { display: "grid", gridTemplateColumns: `repeat(${cols.length}, minmax(220px, 1fr))`, gap: "10px", overflowX: "auto" } },
    cols.map(c => el("div", { class: "kanban-col", style: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "6px", padding: "8px", minHeight: "260px" } }, [
      el("div", { class: "row spread", style: { marginBottom: "6px" } }, [
        el("span", { class: "strong small" }, [c.status]),
        el("span", { class: "tiny muted" }, [String(c.items.length)]),
      ]),
      ...c.items.map(workCard),
      c.items.length === 0 ? el("div", { class: "muted tiny" }, ["No items."]) : null,
    ]))
  );
}

function workCard(w) {
  const due = w.due ? new Date(w.due) : null;
  const overdue = due && due.getTime() < Date.now() && w.status !== "Done" && w.status !== "Closed";
  const proj = (state.data?.projects || []).find(p => p.id === w.projectId);
  const user = (state.data?.users || []).find(u => u.id === w.assigneeId);
  return el("button", {
    class: "kanban-card",
    type: "button",
    style: { display: "block", width: "100%", textAlign: "left", marginBottom: "6px", padding: "8px 10px", background: "var(--panel)", border: "1px solid var(--border)", borderRadius: "6px", cursor: "pointer" },
    onClick: () => navigate(`/work-board/${w.projectId}#${w.id}`),
  }, [
    el("div", { class: "row spread" }, [
      el("span", { class: "tiny muted mono" }, [w.id]),
      w.severity ? badge(w.severity, w.severity === "high" ? "danger" : w.severity === "medium" ? "warn" : "info") : null,
    ]),
    el("div", { class: "small strong", style: { margin: "4px 0" } }, [w.title || "(untitled)"]),
    el("div", { class: "row wrap tiny muted", style: { gap: "8px" } }, [
      proj ? el("span", {}, [proj.name]) : null,
      user ? el("span", {}, [`@${user.name}`]) : null,
      due ? el("span", { style: { color: overdue ? "var(--danger)" : undefined } }, [(overdue ? "Overdue · " : "Due ") + due.toLocaleDateString()]) : null,
    ]),
  ]);
}

// ---------- Table ----------

function tableView(items) {
  const projects = state.data?.projects || [];
  const users = state.data?.users || [];
  return el("div", { style: { overflowX: "auto" } }, [
    el("table", { class: "table" }, [
      el("thead", {}, [el("tr", {}, ["ID", "Title", "Type", "Status", "Severity", "Assignee", "Project", "Due"].map(h => el("th", {}, [h])))]),
      el("tbody", {}, items.map(w => {
        const due = w.due ? new Date(w.due) : null;
        const overdue = due && due.getTime() < Date.now() && w.status !== "Done" && w.status !== "Closed";
        return el("tr", { class: "row-clickable", onClick: () => navigate(`/work-board/${w.projectId}#${w.id}`) }, [
          el("td", { class: "tiny mono" }, [w.id]),
          el("td", {}, [w.title]),
          el("td", {}, [w.type || "—"]),
          el("td", {}, [badge(w.status, statusVariant(w.status))]),
          el("td", {}, [w.severity ? badge(w.severity, w.severity === "high" ? "danger" : w.severity === "medium" ? "warn" : "info") : "—"]),
          el("td", {}, [users.find(u => u.id === w.assigneeId)?.name || "—"]),
          el("td", {}, [projects.find(p => p.id === w.projectId)?.name || "—"]),
          el("td", { style: { color: overdue ? "var(--danger)" : undefined } }, [due ? due.toLocaleDateString() + (overdue ? " · overdue" : "") : "—"]),
        ]);
      })),
    ]),
    items.length === 0 ? el("div", { class: "muted small mt-2" }, ["No work items match the current filters."]) : null,
  ]);
}

function statusVariant(s) {
  return ({
    "Done": "success", "Closed": "success",
    "In Progress": "info", "In Review": "info",
    "Blocked": "danger",
    "Open": "warn", "Backlog": "",
  })[s] || "";
}

// ---------- Calendar ----------

function calendarView(items) {
  // Month grid keyed by item.due. Items without a due date listed below
  // the grid in a "No due date" lane.
  const cur = new Date();
  cur.setDate(1);
  const year = cur.getFullYear();
  const month = cur.getMonth();
  const firstDow = cur.getDay(); // 0..6
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  /** @type {Map<string, any[]>} */
  const byDay = new Map();
  const noDue = [];
  for (const w of items) {
    if (!w.due) { noDue.push(w); continue; }
    const dt = new Date(w.due);
    if (dt.getFullYear() !== year || dt.getMonth() !== month) continue;
    const key = String(dt.getDate());
    (byDay.get(key) || byDay.set(key, []).get(key)).push(w);
  }

  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  const monthName = cur.toLocaleString(undefined, { month: "long", year: "numeric" });

  return el("div", { class: "stack" }, [
    el("div", { class: "strong" }, [monthName]),
    el("div", { class: "calendar-grid", style: { display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: "4px" } }, [
      ...["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map(h => el("div", { class: "tiny muted", style: { textAlign: "center", padding: "4px" } }, [h])),
      ...cells.map(d => el("div", {
        class: "calendar-cell",
        style: {
          minHeight: "82px", border: "1px solid var(--border)", borderRadius: "4px",
          padding: "4px", background: d ? "var(--panel)" : "transparent",
        },
      }, d ? [
        el("div", { class: "tiny mono muted" }, [String(d)]),
        ...(byDay.get(String(d)) || []).map(w => el("button", {
          class: "kanban-card",
          type: "button",
          style: { display: "block", width: "100%", textAlign: "left", margin: "2px 0", padding: "3px 5px", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "3px", fontSize: "11px", cursor: "pointer" },
          title: w.title,
          onClick: () => navigate(`/work-board/${w.projectId}#${w.id}`),
        }, [w.title?.length > 28 ? w.title.slice(0, 26) + "…" : (w.title || w.id)])),
      ] : [])),
    ]),
    noDue.length ? el("div", { class: "stack mt-2" }, [
      el("div", { class: "tiny muted" }, [`Items without a due date (${noDue.length})`]),
      el("div", { class: "row wrap" }, noDue.map(w => el("button", {
        class: "btn sm",
        onClick: () => navigate(`/work-board/${w.projectId}#${w.id}`),
      }, [w.title || w.id]))),
    ]) : null,
  ]);
}
