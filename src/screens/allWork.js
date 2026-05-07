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
import { navigate, queryParams, updateQueryParams } from "../core/router.js";
import { helpHint, helpLinkChip } from "../core/help.js";
import {
  kanbanView,
  tableView,
  timelineView,
  calendarView,
  dependencyView,
  batchBar,
} from "./workBoard.js";

// Filter state lives in the URL (`#/work?status=Open&due=overdue`) so it
// can be bookmarked, shared, and walked through browser history. The
// previous sessionStorage-only model made filtered views invisible to
// anything outside the active tab. SS_BATCH stays session-local because
// multi-select state is an interaction artifact, not navigation state.
const SS_VIEW   = "allwork.view";    // local: which tab the user last had open
const SS_BATCH  = "allwork.batch";   // local: per-tab multi-select scratch
// URL params: q, status, assignee, project, due, completed

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
  // URL → current view's filter set. Defaults match the pre-URL behaviour
  // (any due, hide done/closed) so a bare `/work` URL renders the same
  // active-work view users were used to.
  const q = queryParams();
  return {
    text:    q.get("q") || "",
    status:  q.get("status") || "",
    assignee:q.get("assignee") || "",
    project: q.get("project") || "",
    due:     q.get("due") || "any",
    includeCompleted: q.get("completed") === "1",
  };
}

// Mirror of readFilters() keys → URL param names. Single source of truth
// so a typo in setFilter() can't drift out of sync from readFilters().
const FILTER_PARAM = {
  text: "q", status: "status", assignee: "assignee",
  project: "project", due: "due", includeCompleted: "completed",
};

function setFilter(key, value) {
  // The hashchange handler re-renders automatically, so we don't need to
  // call renderAllWork() here. updateQueryParams treats "" / null / false
  // as "delete this key" so the URL stays clean of empty params.
  const param = FILTER_PARAM[key] || key;
  // includeCompleted is a boolean — encode "1" / delete.
  const v = key === "includeCompleted"
    ? (value ? "1" : "")
    : (value || "");
  updateQueryParams({ [param]: v });
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
      setFilter("text", v);
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
  statusSel.addEventListener("change", () => setFilter("status", /** @type {HTMLSelectElement} */ (statusSel).value));

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
  assigneeSel.addEventListener("change", () => setFilter("assignee", /** @type {HTMLSelectElement} */ (assigneeSel).value));

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
  projectSel.addEventListener("change", () => setFilter("project", /** @type {HTMLSelectElement} */ (projectSel).value));

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
  dueSel.addEventListener("change", () => setFilter("due", /** @type {HTMLSelectElement} */ (dueSel).value));

  const completedToggle = el("label", { class: "row", style: { gap: "4px", alignItems: "center" } }, [
    el("input", {
      type: "checkbox",
      checked: filters.includeCompleted,
      onChange: (e) => setFilter("includeCompleted", /** @type {HTMLInputElement} */ (e.target).checked),
    }),
    el("span", { class: "tiny" }, ["Include done / closed"]),
  ]);

  const clearBtn = el("button", {
    class: "btn sm ghost",
    onClick: () => {
      // One-shot wipe: drop every filter param at once. The hashchange
      // handler triggers the re-render automatically.
      updateQueryParams({ q: "", status: "", assignee: "", project: "", due: "", completed: "" });
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
  if (filters.text) chips.push(filterChip(`"${filters.text}"`, () => setFilter("text", "")));
  if (filters.status) chips.push(filterChip(`Status: ${filters.status}`, () => setFilter("status", "")));
  if (filters.assignee) {
    const label = filters.assignee === "me" ? "Assigned to me"
      : filters.assignee === "unassigned" ? "Unassigned"
      : (users.find(u => u.id === filters.assignee)?.name || filters.assignee);
    chips.push(filterChip(`Assignee: ${label}`, () => setFilter("assignee", "")));
  }
  if (filters.project) {
    const label = filters.project === "__none__" ? "No project"
      : (projects.find(p => p.id === filters.project)?.name || filters.project);
    chips.push(filterChip(`Project: ${label}`, () => setFilter("project", "")));
  }
  if (filters.due && filters.due !== "any") {
    const label = ({ overdue: "Overdue", today: "Due today", week: "This week", month: "This month", "no-due": "No due date" })[filters.due] || filters.due;
    chips.push(filterChip(`Due: ${label}`, () => setFilter("due", "")));
  }
  if (!filters.includeCompleted) {
    chips.push(filterChip("Hiding done / closed", () => setFilter("includeCompleted", true), "muted"));
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

