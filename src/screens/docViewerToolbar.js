// Toolbar render functions for the document viewer.
//
// Extracted from docViewer.js (Phase 4 decomposition) — these were a
// natural ~150 LOC unit with no shared state beyond what the viewer
// already passed in. Each render function takes a single `ctx` bag so
// docViewer.js can wire up callbacks once and reuse them across the
// toolbar / mode bar / per-mode tool bars.
//
// `ctx` contract:
//   doc         — Document record (id, name, revisionIds, …)
//   rev         — Active Revision record (id, label, status, pdfUrl, …)
//   activePage  — current page (1-indexed)
//   zoom        — current zoom level (matches one of ZOOM_LEVELS)
//   pageCount   — pageCount() → number    (read-only accessor)
//   tool        — tool() → string         (annotation tool id)
//   shapeTool   — shapeTool() → string    (shape mode tool id)
//   activeMode  — current mode id
//   onPage      — onPage(n) — navigate to page
//   onZoom      — onZoom(z) — set zoom level
//   onMode      — onMode(id) — switch viewer mode
//   onTool      — onTool(id) — switch annotation tool
//   onShapeTool — onShapeTool(id) — switch shape tool
//   onAttach    — opens the file/URL attach modal
//   onTransmittal — opens the transmittal draft flow

import { el } from "../core/ui.js";
import {
  VIEWER_MODES, ANNOTATE_TOOLS, SHAPE_TOOLS, ZOOM_LEVELS,
  prevZoom, nextZoom,
} from "./docViewerConstants.js";

export function viewerTopBar(ctx) {
  const { doc, rev, activePage, zoom, pageCount, onPage, onZoom, onAttach, onTransmittal } = ctx;
  const pct = Math.round(zoom * 100);
  const total = pageCount();
  return el("div", { class: "viewer-toolbar" }, [
    // Page navigation.
    el("button", {
      class: "btn sm icon-btn",
      title: "Previous page", "aria-label": "Previous page",
      disabled: activePage <= 1,
      onClick: () => onPage(activePage - 1),
    }, ["◀"]),
    el("span", { class: "tiny mono", style: { minWidth: "60px", textAlign: "center" } },
      [`${activePage} / ${total}`]),
    el("button", {
      class: "btn sm icon-btn",
      title: "Next page", "aria-label": "Next page",
      disabled: activePage >= total,
      onClick: () => onPage(activePage + 1),
    }, ["▶"]),
    el("span", { class: "viewer-toolbar-divider", "aria-hidden": "true" }),
    // Zoom controls.
    el("button", {
      class: "btn sm icon-btn",
      title: "Zoom out", "aria-label": "Zoom out",
      disabled: zoom <= ZOOM_LEVELS[0],
      onClick: () => onZoom(prevZoom(zoom)),
    }, ["−"]),
    el("span", { class: "tiny mono", style: { minWidth: "52px", textAlign: "center" } }, [`${pct}%`]),
    el("button", {
      class: "btn sm icon-btn",
      title: "Zoom in", "aria-label": "Zoom in",
      disabled: zoom >= ZOOM_LEVELS[ZOOM_LEVELS.length - 1],
      onClick: () => onZoom(nextZoom(zoom)),
    }, ["+"]),
    el("button", { class: "btn sm", title: "Fit width", onClick: () => onZoom(1.5) }, ["Fit width"]),
    el("button", { class: "btn sm", title: "Fit page",  onClick: () => onZoom(0.85) }, ["Fit page"]),
    el("span", { style: { flex: 1 } }),
    // Persistent doc actions on the right.
    el("button", { class: "btn sm", onClick: () => onTransmittal(doc, rev) }, ["Transmittal"]),
    el("button", { class: "btn sm", onClick: () => onAttach(doc, rev) },
      [rev.pdfUrl ? "Change PDF" : "Attach PDF"]),
  ]);
}

export function viewerModeBar(ctx) {
  const { activeMode, onMode } = ctx;
  return el("div", { class: "viewer-modebar", role: "tablist", "aria-label": "Viewer mode" },
    VIEWER_MODES.map(m => el("button", {
      class: `viewer-mode-btn ${activeMode === m.id ? "active" : ""}`,
      role: "tab",
      "aria-selected": activeMode === m.id ? "true" : "false",
      onClick: () => onMode(m.id),
    }, [m.label]))
  );
}

export function viewerAnnotateBar(ctx) {
  const { tool: getTool, onTool } = ctx;
  const tool = getTool();
  return el("div", { class: "viewer-annotate-bar", role: "toolbar", "aria-label": "Annotation tools" }, [
    ...ANNOTATE_TOOLS.map(t => el("button", {
      class: `viewer-tool-btn ${tool === t.id ? "active" : ""}`,
      title: t.label, "aria-label": t.label,
      onClick: () => onTool(t.id),
    }, [
      el("span", { class: "viewer-tool-icon", "aria-hidden": "true" }, [t.icon]),
      el("span", { class: "viewer-tool-label" }, [t.label]),
    ])),
    el("span", { class: "tiny muted ml-2" }, [
      tool === "comment" ? "Click on the page to drop a sticky note."
      : tool === "draw"  ? "Click + drag to draw freehand."
      : "Click + drag across the text to mark.",
    ]),
  ]);
}

export function viewerShapesBar(ctx) {
  const { shapeTool: getShapeTool, onShapeTool } = ctx;
  const tool = getShapeTool();
  return el("div", { class: "viewer-annotate-bar", role: "toolbar", "aria-label": "Shape tools" }, [
    ...SHAPE_TOOLS.map(t => el("button", {
      class: `viewer-tool-btn ${tool === t.id ? "active" : ""}`,
      title: t.label, "aria-label": t.label,
      onClick: () => onShapeTool(t.id),
    }, [
      el("span", { class: "viewer-tool-icon", "aria-hidden": "true" }, [t.icon]),
      el("span", { class: "viewer-tool-label" }, [t.label]),
    ])),
    el("span", { class: "tiny muted ml-2" },
      ["Click + drag to draw the shape. Double-click any shape to delete."]),
  ]);
}

// The redact / insert / form bars carry only static guidance copy
// today; they're parameter-free and exported for symmetry so the
// caller can switch on `mode` without scattering inline `el()` calls.
export function viewerRedactBar() {
  return el("div", { class: "viewer-annotate-bar", role: "toolbar", "aria-label": "Redaction" }, [
    el("span", { class: "tiny" }, [
      "Click + drag to mark a region for redaction. The reason you provide is recorded in the audit ledger. ",
      "Visual redaction in the viewer; bake-into-PDF on export is a separate slice.",
    ]),
  ]);
}

export function viewerInsertBar() {
  return el("div", { class: "viewer-annotate-bar", role: "toolbar", "aria-label": "Insert" }, [
    el("span", { class: "tiny" },
      ["Click anywhere on the page to drop a text annotation. Double-click any annotation to delete."]),
  ]);
}

export function viewerFormBar() {
  return el("div", { class: "viewer-annotate-bar", role: "toolbar", "aria-label": "Form fields" }, [
    el("span", { class: "tiny" },
      ["Click + drag to place a fillable field. You'll be prompted for a label and a default value."]),
  ]);
}
