// Work board v2 — spec §11.4 and §6.2.
//
// Views: Board (kanban) · Table · Timeline (Gantt-ish) · Dependency map.
// Bulk operations: multi-select, bulk state change, bulk assign, bulk
// severity, bulk labels. Dependencies create blocked-by links.
// Automation: default rules and per-project trigger viewer.

import { el, mount, card, badge, toast, modal, formRow, input, select, textarea } from "../core/ui.js";
import { state, update, getById } from "../core/store.js";
import { audit } from "../core/audit.js";
import { navigate } from "../core/router.js";
import { can } from "../core/permissions.js";
import { renderMermaid } from "../core/mermaid.js";

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

  mount(root, [
    header(project, view, filter, items.length, batch, viewKey, filterKey, batchKey, id),
    batchBar(batch, batchKey, id),
    view === "kanban"   ? kanbanView(items, batch, batchKey) :
    view === "table"    ? tableView(items, batch, batchKey) :
    view === "timeline" ? timelineView(items) :
    view === "deps"     ? dependencyView(items) :
    kanbanView(items, batch, batchKey),
    automationCard(project, id),
  ]);
}

function header(project, view, filter, count, batch, viewKey, filterKey, batchKey, id) {
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
      el("div", { class: "row" },
        ["kanban","table","timeline","deps"].map(v => el("button", {
          class: `btn sm ${view === v ? "primary" : ""}`,
          onClick: () => { sessionStorage.setItem(viewKey, v); renderWorkBoard({ id }); },
        }, [label(v)]))
      ),
      el("button", { class: "btn sm primary", disabled: !can("create"), onClick: () => openNewItem(id) }, ["+ New item"]),
    ]),
  ]);
}

function label(v) { return ({ kanban: "Board", table: "Table", timeline: "Timeline", deps: "Dependencies" })[v] || v; }

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
function batchAddLabel(ids, batchKey, projectId) {
  const label = window.prompt("Label to add:");
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
function tableView(items, batch, batchKey) {
  return card("Items", el("table", { class: "table" }, [
    el("thead", {}, [el("tr", {}, [
      el("th", {}, [""]),
      el("th", {}, ["ID"]),
      el("th", {}, ["Title"]),
      el("th", {}, ["Type"]),
      el("th", {}, ["Severity"]),
      el("th", {}, ["Status"]),
      el("th", {}, ["Assignee"]),
      el("th", {}, ["Due"]),
      el("th", {}, ["Blockers"]),
    ])]),
    el("tbody", {}, items.map(w => el("tr", {
      style: { cursor: "pointer", background: batch.includes(w.id) ? "var(--elevated)" : "" },
      onClick: (e) => { if (e.shiftKey) { toggleBatch(w.id, batchKey); renderWorkBoard({ id: w.projectId }); } else openItem(w.id); },
    }, [
      el("td", { onClick: e => e.stopPropagation() }, [el("input", { type: "checkbox", checked: batch.includes(w.id), onChange: () => { toggleBatch(w.id, batchKey); renderWorkBoard({ id: w.projectId }); } })]),
      el("td", { class: "mono" }, [w.id]),
      el("td", {}, [w.title]),
      el("td", {}, [badge(w.type, "info")]),
      el("td", {}, [badge(w.severity, w.severity === "high" ? "danger" : w.severity === "medium" ? "warn" : "info")]),
      el("td", {}, [badge(w.status, "")]),
      el("td", { class: "tiny muted" }, [w.assigneeId]),
      el("td", { class: "tiny muted" }, [w.due ? new Date(w.due).toLocaleDateString() : "—"]),
      el("td", { class: "tiny muted" }, [(w.blockers || []).join(", ") || "—"]),
    ]))),
  ]));
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
  today.setAttribute("x1", todayX); today.setAttribute("y1", 0); today.setAttribute("x2", todayX); today.setAttribute("y2", H);
  today.setAttribute("stroke", "var(--accent)"); today.setAttribute("stroke-dasharray", "4 3");
  svg.append(today);

  // Week gridlines
  const msWeek = 7 * 86400_000;
  for (let t = Math.ceil(tMin / msWeek) * msWeek; t < tMax; t += msWeek) {
    const x = ((t - tMin) / span) * 1000;
    const ln = document.createElementNS(NS, "line");
    ln.setAttribute("x1", x); ln.setAttribute("y1", 0); ln.setAttribute("x2", x); ln.setAttribute("y2", H);
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
    rect.setAttribute("x", Math.min(x1, x2)); rect.setAttribute("y", y);
    rect.setAttribute("width", Math.max(8, Math.abs(x2 - x1))); rect.setAttribute("height", 16);
    const color = w.severity === "high" || w.severity === "critical" ? "#ef4444" : w.severity === "medium" ? "#f59e0b" : "#38bdf8";
    rect.setAttribute("fill", color); rect.setAttribute("rx", 3);
    rect.addEventListener("click", () => openItem(w.id));
    rect.style.cursor = "pointer";
    svg.append(rect);

    const txt = document.createElementNS(NS, "text");
    txt.setAttribute("x", Math.min(x1, x2) + 4); txt.setAttribute("y", y + 12);
    txt.setAttribute("fill", "#fff"); txt.setAttribute("font-size", "11");
    txt.textContent = `${w.id}  ${w.title.slice(0, 28)}`;
    svg.append(txt);
  });

  return card("Timeline", svg, { subtitle: "Today = dashed accent line. Bars colored by severity." });
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
    circle.setAttribute("cx", c.x); circle.setAttribute("cy", c.y); circle.setAttribute("r", 14);
    const fill = w.severity === "high" || w.severity === "critical" ? "#ef4444" : w.severity === "medium" ? "#f59e0b" : "#38bdf8";
    circle.setAttribute("fill", fill);
    g.append(circle);
    const txt = document.createElementNS(NS, "text");
    txt.setAttribute("x", c.x); txt.setAttribute("y", c.y - 20);
    txt.setAttribute("text-anchor", "middle"); txt.setAttribute("font-size", "10"); txt.setAttribute("fill", "var(--text)");
    txt.textContent = w.id;
    g.append(txt);
    svg.append(g);
  }

  // Column headers.
  cols.forEach((c, ci) => {
    const t = document.createElementNS(NS, "text");
    t.setAttribute("x", colW * ci + colW / 2); t.setAttribute("y", 20);
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
function automationCard(project, projectId) {
  const rules = [
    "Any ERP event → Task",
    "Alarm SEV-1/SEV-2 → Incident",
    "OPC UA state_change → Asset timeline",
    "Approved revision → auto-supersede prior IFC",
  ];
  return card("Automation rules (§6.2 / §9.3)", el("div", { class: "stack" }, [
    ...rules.map(r => el("div", { class: "activity-row" }, [
      badge("rule", "info"), el("span", { class: "small" }, [r]),
    ])),
    el("div", { class: "tiny muted" }, ["Rules run in the event engine. See /integrations for live event feed."]),
  ]));
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

  modal({
    title: `${w.id} — ${w.type}`,
    body: el("div", { class: "stack" }, [
      formRow("Title", titleInput),
      formRow("Status", statusSelect),
      formRow("Severity", severitySelect),
      formRow("Description", descTextarea),
      formRow("Blocked by (comma-separated IDs)", blockersInput),
      el("div", { class: "tiny muted" }, [`Assignee: ${w.assigneeId} · Due: ${w.due ? new Date(w.due).toLocaleDateString() : "—"}`]),
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
