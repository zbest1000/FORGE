// Kanban view, extracted from workBoard.js (Phase 4 decomposition
// continued). Drag-drop status change is the same regardless of
// scope; card click (or shift-click for multi-select) calls
// `scope.rerender()` so the per-project board and /work both reuse
// this view via the same `scope = { id, rerender, showProjectColumn }`
// contract used by calendar/timeline/dependency.

import { el, badge } from "../core/ui.js";
import { state } from "../core/store.js";
import { COLUMNS, changeStatus, openItem } from "./workBoardItem.js";
import { toggleBatch } from "./workBoardBatch.js";

/**
 * @param {any[]} items
 * @param {{ id: string, rerender: () => void, showProjectColumn?: boolean }} scope
 * @param {string[]} batch
 * @param {string} batchKey
 */
export function kanbanView(items, scope, batch, batchKey) {
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
        scope.rerender();
      },
    }, [
      el("div", { class: "kanban-col-header" },
        [col, el("span", { class: "tiny muted" }, [String(colItems.length)])]),
      ...colItems.map(w => kanbanCard(w, scope, batch, batchKey)),
    ]);
    return node;
  }));
}

function kanbanCard(w, scope, batch, batchKey) {
  const sevVariant = w.severity === "high" || w.severity === "critical" ? "danger"
    : w.severity === "medium" ? "warn"
    : "info";
  const isSelected = batch.includes(w.id);
  // In all-work scope show the project name as a chip so cards aren't
  // ambiguous when many projects are mixed together.
  const projectName = scope.showProjectColumn
    ? (state.data?.projects || []).find(p => p.id === w.projectId)?.name || w.projectId
    : null;
  const card = el("div", {
    class: `kanban-card ${isSelected ? "selected" : ""}`,
    style: isSelected ? { boxShadow: "0 0 0 2px var(--accent) inset" } : {},
    draggable: "true",
    "data-item-id": w.id,
    // HTML5 drag/drop — works great on mouse, doesn't fire on touch.
    onDragstart: (e) => { e.dataTransfer.setData("text/plain", w.id); e.currentTarget.classList.add("dragging"); },
    onDragend: (e) => e.currentTarget.classList.remove("dragging"),
    onClick: (e) => {
      if (e.shiftKey) { toggleBatch(w.id, batchKey); scope.rerender(); }
      else openItem(w.id);
    },
  }, [
    el("div", { class: "row spread" }, [
      el("span", { class: "card-id" }, [w.id]),
      badge(w.type, "info"),
    ]),
    el("div", { class: "card-title" }, [w.title]),
    projectName ? el("div", { class: "tiny muted", style: { marginTop: "2px" } }, ["📁 ", projectName]) : null,
    el("div", { class: "card-meta row wrap" }, [
      badge(w.severity, sevVariant),
      w.due ? el("span", { class: "tiny muted" }, ["due " + new Date(w.due).toLocaleDateString()]) : null,
      w.blockers?.length ? badge(`blocked:${w.blockers.length}`, "danger") : null,
      (w.labels || []).slice(0, 2).map(l => badge(l, "")),
    ]),
  ]);

  // Touch / pen drag path: HTML5 drag/drop is mouse-only on every
  // major mobile browser, so on touch we run our own pointerdown/move/
  // up FSM and use elementsFromPoint() to hit-test drop columns.
  // Mouse interactions get pointerType === "mouse" and we no-op so
  // the native HTML5 path owns them (avoids double-handling).
  attachTouchDrag(card, w, scope);
  return card;
}

function attachTouchDrag(card, item, scope) {
  let dragging = false;
  let startX = 0, startY = 0;
  /** @type {number | null} */
  let activePointerId = null;
  const THRESHOLD_PX = 6;
  const HOVER_ATTR = "data-touch-hover";

  card.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse") return;
    activePointerId = e.pointerId;
    startX = e.clientX; startY = e.clientY;
    dragging = false;
    // Don't preventDefault yet — let a tap propagate to onClick if no drag.
  });

  card.addEventListener("pointermove", (e) => {
    if (e.pointerId !== activePointerId) return;
    const dx = Math.abs(e.clientX - startX);
    const dy = Math.abs(e.clientY - startY);
    if (!dragging && (dx > THRESHOLD_PX || dy > THRESHOLD_PX)) {
      dragging = true;
      card.classList.add("dragging");
      try { card.setPointerCapture(e.pointerId); } catch {}
    }
    if (!dragging) return;
    e.preventDefault();
    document.querySelectorAll(".kanban-col").forEach(c => c.removeAttribute(HOVER_ATTR));
    const els = document.elementsFromPoint(e.clientX, e.clientY);
    const target = els.find(n => n.classList && n.classList.contains("kanban-col"));
    if (target) target.setAttribute(HOVER_ATTR, "true");
  });

  const finish = (e, commit) => {
    if (e.pointerId !== activePointerId) return;
    activePointerId = null;
    if (!dragging) return;
    card.classList.remove("dragging");
    document.querySelectorAll(".kanban-col").forEach(c => c.removeAttribute(HOVER_ATTR));
    if (commit) {
      const els = document.elementsFromPoint(e.clientX, e.clientY);
      const target = /** @type {HTMLElement | undefined} */ (
        els.find(n => n instanceof HTMLElement && n.classList.contains("kanban-col"))
      );
      const newStatus = target?.dataset?.status;
      if (newStatus && newStatus !== item.status) {
        changeStatus(item.id, newStatus);
        scope.rerender();
      }
    }
    dragging = false;
  };
  card.addEventListener("pointerup",     (e) => finish(e, true));
  card.addEventListener("pointercancel", (e) => finish(e, false));
}
