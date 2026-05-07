// Consolidated all-work view (`/work`).
//
// Cross-project view that surfaces every work item the viewer can see.
// Reuses the per-project board's view code (kanban / table / timeline /
// calendar / dependency) by importing the shared view functions from
// workBoard.js and passing an all-work scope:
//
//   { id: "all", rerender: () => renderAllWork(), showProjectColumn: true }
//
// This guarantees the consolidated view looks and feels identical to the
// per-project board — same drag-drop kanban, same sortable table with
// column visibility menu, same Gantt-ish timeline, same month calendar,
// same Mermaid dependency map. The only addition is a top-level filter
// bar (project, status, assignee, due-date preset, search) that scopes
// which items each view receives.

import { el, mount, tabs } from "../core/ui.js";
import { state } from "../core/store.js";
import { navigate } from "../core/router.js";
import { helpHint, helpLinkChip } from "../core/help.js";
import {
  kanbanView,
  tableView,
  timelineView,
  calendarView,
  dependencyView,
  batchBar,
} from "./workBoard.js";

const SS_VIEW       = "allwork.view";
const SS_FILTER     = "allwork.filter";
const SS_STATUS     = "allwork.status";
const SS_ASSIGNEE   = "allwork.assignee";
const SS_PROJECT    = "allwork.project";
const SS_DUE        = "allwork.due";
const SS_COMPLETED  = "allwork.includeCompleted";
const SS_BATCH      = "allwork.batch";

const STATUS_OPTIONS = ["Backlog", "Open", "In Progress", "In Review", "Blocked", "Approved", "Done", "Closed"];

export function renderAllWork() {
  const root = document.getElementById("screenContainer");
  const view = sessionStorage.getItem(SS_VIEW) || "kanban";

  const filters = readFilters();
  const allItems = collectWorkItems();
  const filtered = applyFilters(allItems, filters);
  const batch = JSON.parse(sessionStorage.getItem(SS_BATCH) || "[]");

  // Scope object passed into the shared workBoard views. Storage keys
  // for sort/filter/visibility/calendar-month all namespace under "all"
  // so they survive navigation but stay distinct from per-project state.
  const scope = {
    id: "all",
    rerender: () => renderAllWork(),
    showProjectColumn: true,
  };

  mount(root, [
    headerRow(filtered.length, allItems.length),
    filterBar(filters),
    batchBar(batch, SS_BATCH, scope),
    tabs({
      sessionKey: SS_VIEW,
      defaultId: view,
      ariaLabel: "All-work view",
      tabs: [
        { id: "kanban",   label: "Board",        content: () => kanbanView(filtered, scope, batch, SS_BATCH) },
        { id: "table",    label: "Table",        content: () => tableView(filtered, scope, batch, SS_BATCH) },
        { id: "timeline", label: "Timeline",     content: () => timelineView(filtered, scope) },
        { id: "calendar", label: "Calendar",     content: () => calendarView(filtered, scope) },
        { id: "deps",     label: "Dependencies", content: () => dependencyView(filtered, scope) },
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
      // Restore focus after re-render so the user can keep typing.
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
  const projectOpts = [
    { value: "", label: "All projects" },
    { value: "__none__", label: "Unassigned to project" },
    ...projects.map(p => ({ value: p.id, label: p.name })),
  ];
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

  // Active filter chip strip — at-a-glance summary of what's currently
  // applied. Each chip clears its own filter when clicked. Keeps users
  // out of the "why am I seeing/not seeing X?" trap.
  const activeChips = activeFilterChips(filters, projects, users);

  return el("div", { class: "stack mb-3", style: { gap: "8px" } }, [
    el("div", { class: "row wrap", style: { gap: "8px", alignItems: "center" } }, [
      el("div", { style: { flex: "1 1 240px" } }, [search]),
      statusSel,
      assigneeSel,
      projectSel,
      dueSel,
      completedToggle,
      clearBtn,
    ]),
    activeChips,
  ]);
}

function activeFilterChips(filters, projects, users) {
  const chips = [];
  if (filters.text) chips.push(filterChip(`"${filters.text}"`, () => setFilter(SS_FILTER, "")));
  if (filters.status) chips.push(filterChip(`Status: ${filters.status}`, () => setFilter(SS_STATUS, "")));
  if (filters.assignee) {
    const label = filters.assignee === "me" ? "Assigned to me"
      : filters.assignee === "unassigned" ? "Unassigned"
      : (users.find(u => u.id === filters.assignee)?.name || filters.assignee);
    chips.push(filterChip(`Assignee: ${label}`, () => setFilter(SS_ASSIGNEE, "")));
  }
  if (filters.project) {
    const label = filters.project === "__none__" ? "No project"
      : (projects.find(p => p.id === filters.project)?.name || filters.project);
    chips.push(filterChip(`Project: ${label}`, () => setFilter(SS_PROJECT, "")));
  }
  if (filters.due && filters.due !== "any") {
    const label = ({ overdue: "Overdue", today: "Due today", week: "This week", month: "This month", "no-due": "No due date" })[filters.due] || filters.due;
    chips.push(filterChip(`Due: ${label}`, () => setFilter(SS_DUE, "")));
  }
  if (!filters.includeCompleted) {
    chips.push(filterChip("Hiding done / closed", () => setFilter(SS_COMPLETED, "1"), "muted"));
  }
  if (!chips.length) return el("div");
  return el("div", { class: "row wrap", style: { gap: "6px", alignItems: "center" } }, [
    el("span", { class: "tiny muted" }, ["Active filters:"]),
    ...chips,
  ]);
}

function filterChip(label, onClear, variant) {
  return el("button", {
    class: `btn xs ${variant || ""}`,
    title: "Click to clear this filter",
    onClick: onClear,
  }, [label, " ✕"]);
}

function collectWorkItems() {
  const d = state.data || {};
  return (d.workItems || []).slice();
}

function applyFilters(items, filters) {
  const startOfDay = (() => { const x = new Date(); x.setHours(0,0,0,0); return x.getTime(); })();
  const startOfTomorrow = startOfDay + 24 * 60 * 60 * 1000;
  const startOfNextWeek = startOfDay + 7 * 24 * 60 * 60 * 1000;
  const startOfNextMonth = (() => { const x = new Date(); x.setMonth(x.getMonth() + 1, 1); x.setHours(0,0,0,0); return x.getTime(); })();
  const meId = state.data?.currentUserId;

  return items.filter(w => {
    // Done / closed gate
    if (!filters.includeCompleted && (w.status === "Done" || w.status === "Closed")) return false;
    if (filters.status && w.status !== filters.status) return false;
    if (filters.project) {
      if (filters.project === "__none__") {
        if (w.projectId) return false;
      } else if (w.projectId !== filters.project) return false;
    }
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

