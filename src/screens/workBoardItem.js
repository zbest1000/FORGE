// Work-item operations extracted from workBoard.js (Phase 4
// decomposition). Hosted in their own module so the per-view files
// (workBoardCalendar.js, future workBoardKanban.js, etc.) can import
// them without circular dependencies.
//
// Exports:
//   changeStatus(itemId, newStatus)  — single-item status transition
//   openItem(itemId)                 — opens the item edit drawer
//   openNewItem(projectId)           — opens the "+ New item" modal
//   COLUMNS                          — canonical status pipeline

import { el, badge, toast, modal, formRow, input, select, textarea, drawer } from "../core/ui.js";
import { state, update, getById } from "../core/store.js";
import { audit } from "../core/audit.js";
import { can } from "../core/permissions.js";
import { simulation } from "../core/simulation.js";

/**
 * Canonical work-item pipeline. Re-exported here so any view file
 * (kanban, table, calendar) can render against the same column set
 * without re-declaring the list.
 */
export const COLUMNS = ["Backlog", "Open", "In Progress", "In Review", "Approved", "Done"];

/**
 * Single-item status transition. Used by drag-drop targets and bulk
 * batch operations alike. Read-only roles get a warn toast and a no-op.
 */
export function changeStatus(itemId, newStatus) {
  const item = getById("workItems", itemId);
  if (!item) return;
  if (!can("edit")) { toast("Cannot transition — read-only role", "warn"); return; }
  const old = item.status;
  if (old === newStatus) return;
  update(s => { const i = s.data.workItems.find(x => x.id === itemId); if (i) i.status = newStatus; });
  audit("workitem.transition", itemId, { from: old, to: newStatus });
  toast(`${itemId} → ${newStatus}`, "success");
}

/**
 * Open the work-item edit drawer. Read-only roles can still see the
 * drawer but the Save button is gated to `edit` capability.
 */
export function openItem(itemId) {
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
  const ev = (state.data?.auditEvents || []).filter(e => e.subject === w.id).slice(0, 8);
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

/**
 * Open the "+ New item" modal. Used from the per-project board
 * header. /work could conceivably reuse this once the all-work
 * scope grows a "create new" CTA — passing projectId stays explicit
 * so the new item is bound to a specific project.
 */
export function openNewItem(projectId) {
  const titleInput = input({ placeholder: "Short title" });
  const typeSelect = select(["Task","Issue","Action","RFI","NCR","Punch","Defect","CAPA","Change"]);
  const severitySelect = select(["low","medium","high","critical"], { value: "medium" });
  const assigneeSelect = select((state.data?.users || []).map(u => ({ value: u.id, label: u.name })));
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
        const id = simulation.demoId("WI", state.data?.workItems || []);
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
