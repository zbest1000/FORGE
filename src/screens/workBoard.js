import { el, mount, card, badge } from "../core/ui.js";
import { state, update, getById, audit } from "../core/store.js";
import { navigate } from "../core/router.js";
import { can } from "../core/permissions.js";
import { toast, modal, formRow, input, select, textarea } from "../core/ui.js";

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

  const header = el("div", { class: "row spread", style: { marginBottom: "12px" } }, [
    el("div", {}, [
      el("div", { class: "strong" }, [project.name]),
      el("div", { class: "tiny muted" }, [`${(d.workItems || []).filter(w => w.projectId === id).length} items · ${project.status}`]),
    ]),
    el("div", { class: "row" }, [
      el("div", { class: "row" }, [
        el("button", { class: `btn sm ${view === "kanban" ? "primary" : ""}`, onClick: () => { sessionStorage.setItem(viewKey, "kanban"); renderWorkBoard({ id }); } }, ["Board"]),
        el("button", { class: `btn sm ${view === "table" ? "primary" : ""}`, onClick: () => { sessionStorage.setItem(viewKey, "table"); renderWorkBoard({ id }); } }, ["Table"]),
      ]),
      el("button", { class: "btn sm primary", disabled: !can("create"), onClick: () => openNewItem(id) }, ["+ New item"]),
    ]),
  ]);

  const body = view === "table" ? renderTableView(id, d) : renderKanbanView(id, d);

  mount(root, [header, body]);
}

function renderKanbanView(projectId, d) {
  const items = (d.workItems || []).filter(w => w.projectId === projectId);
  const cols = COLUMNS.map(col => {
    const colItems = items.filter(i => i.status === col);
    const colEl = el("div", {
      class: "kanban-col",
      dataset: { status: col },
      onDragover: (e) => { e.preventDefault(); colEl.classList.add("drop-active"); },
      onDragleave: () => colEl.classList.remove("drop-active"),
      onDrop: (e) => {
        e.preventDefault();
        colEl.classList.remove("drop-active");
        const itemId = e.dataTransfer.getData("text/plain");
        changeStatus(itemId, col);
      },
    }, [
      el("div", { class: "kanban-col-header" }, [col, el("span", { class: "tiny muted" }, [String(colItems.length)])]),
      ...colItems.map(renderCard),
    ]);
    return colEl;
  });

  return el("div", { class: "kanban" }, cols);
}

function renderCard(w) {
  const severityVariant = w.severity === "high" ? "danger" : w.severity === "medium" ? "warn" : "info";
  return el("div", {
    class: "kanban-card",
    draggable: "true",
    onDragstart: (e) => { e.dataTransfer.setData("text/plain", w.id); e.currentTarget.classList.add("dragging"); },
    onDragend: (e) => e.currentTarget.classList.remove("dragging"),
    onClick: () => openItem(w.id),
  }, [
    el("div", { class: "row spread" }, [
      el("span", { class: "card-id" }, [w.id]),
      badge(w.type, "info"),
    ]),
    el("div", { class: "card-title" }, [w.title]),
    el("div", { class: "card-meta row wrap" }, [
      badge(w.severity, severityVariant),
      w.due ? el("span", { class: "tiny muted" }, ["due " + new Date(w.due).toLocaleDateString()]) : null,
      w.blockers?.length ? badge(`blocked:${w.blockers.length}`, "danger") : null,
    ]),
  ]);
}

function renderTableView(projectId, d) {
  const items = (d.workItems || []).filter(w => w.projectId === projectId);
  return card("Items", tableBody(items));
}

function tableBody(items) {
  const rows = items.map(w => el("tr", {
    onClick: () => openItem(w.id),
    style: { cursor: "pointer" },
  }, [
    el("td", { class: "mono" }, [w.id]),
    el("td", {}, [w.title]),
    el("td", {}, [badge(w.type, "info")]),
    el("td", {}, [badge(w.severity, w.severity === "high" ? "danger" : w.severity === "medium" ? "warn" : "info")]),
    el("td", {}, [badge(w.status, "")]),
    el("td", { class: "tiny muted" }, [w.due ? new Date(w.due).toLocaleDateString() : "—"]),
  ]));
  return el("table", { class: "table" }, [
    el("thead", {}, [el("tr", {}, ["ID","Title","Type","Severity","Status","Due"].map(h => el("th", {}, [h])))]),
    el("tbody", {}, rows),
  ]);
}

function changeStatus(itemId, newStatus) {
  const item = getById("workItems", itemId);
  if (!item) return;
  if (!can("edit")) { toast("Cannot transition — read-only role", "warn"); return; }
  const old = item.status;
  if (old === newStatus) return;
  update(s => {
    const i = s.data.workItems.find(x => x.id === itemId);
    if (i) i.status = newStatus;
  });
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

  modal({
    title: `${w.id} — ${w.type}`,
    body: el("div", { class: "stack" }, [
      formRow("Title", titleInput),
      formRow("Status", statusSelect),
      formRow("Severity", severitySelect),
      formRow("Description", descTextarea),
      el("div", { class: "tiny muted" }, [`Assignee: ${w.assigneeId} · Due: ${w.due ? new Date(w.due).toLocaleDateString() : "—"}`]),
    ]),
    actions: [
      { label: "Cancel" },
      { label: "Save", variant: "primary", onClick: () => {
        if (!can("edit")) { toast("No permission", "warn"); return; }
        update(s => {
          const i = s.data.workItems.find(x => x.id === itemId);
          if (i) {
            const from = { ...i };
            i.title = titleInput.value;
            i.status = statusSelect.value;
            i.severity = severitySelect.value;
            i.description = descTextarea.value;
            audit("workitem.update", itemId, { changes: diff(from, i) });
          }
        });
        toast("Saved", "success");
      }},
    ],
  });
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
  const typeSelect = select(["Task","Issue","Action","RFI","Punch","Defect","CAPA","Change"]);
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
        const id = "WI-" + Math.floor(Math.random()*900+100);
        const item = {
          id, projectId, type: typeSelect.value, title: titleInput.value.trim(),
          assigneeId: assigneeSelect.value, status: "Open", severity: severitySelect.value,
          due: null, blockers: [],
        };
        update(s => { s.data.workItems.push(item); });
        audit("workitem.create", id, { type: item.type });
        toast(`${id} created`, "success");
      }},
    ],
  });
}
