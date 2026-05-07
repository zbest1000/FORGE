// Constants and pure helpers extracted from docViewer.js (Phase 4
// decomposition). The viewer file is 1300+ LOC; the constants and
// zoom-stepping helpers are self-contained and have no dependency on
// the viewer's render pipeline, so they live here so a future PR can
// pull more of the toolbar render code into a sibling module without
// circular imports.
//
// Nothing in this module mutates state or touches the DOM — everything
// is referentially transparent. Tests can import directly without
// stubbing browser globals.

/** Viewer mode tabs. Persisted per-doc as `doc.<id>.mode`. */
export const VIEWER_MODES = [
  { id: "view",     label: "View" },
  { id: "annotate", label: "Annotate" },
  { id: "shapes",   label: "Shapes" },
  { id: "insert",   label: "Insert" },
  { id: "form",     label: "Form" },
  { id: "redact",   label: "Redact" },
];

/** Annotation tools available in Annotate mode. `impl: true` flags
 *  tools that have a finished implementation; the others (none today)
 *  would render disabled. */
export const ANNOTATE_TOOLS = [
  { id: "comment",   label: "Sticky note",  icon: "🗨", impl: true },
  { id: "highlight", label: "Highlight",    icon: "🖍", impl: true },
  { id: "underline", label: "Underline",    icon: "U̲", impl: true },
  { id: "strike",    label: "Strikethrough", icon: "S̶", impl: true },
  { id: "draw",      label: "Free draw",    icon: "✎", impl: true },
];

/** Shape-mode tools. Drawn as SVG primitives; double-click deletes. */
export const SHAPE_TOOLS = [
  { id: "rect",    label: "Rectangle", icon: "▭" },
  { id: "ellipse", label: "Ellipse",   icon: "◯" },
  { id: "line",    label: "Line",      icon: "—" },
  { id: "arrow",   label: "Arrow",     icon: "→" },
];

/** Zoom levels offered by the +/- buttons. The toolbar's "Fit width" /
 *  "Fit page" buttons jump to specific values (1.5 / 0.85) that don't
 *  need to be in this list. */
export const ZOOM_LEVELS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

/**
 * Step zoom down one level. Returns the next-lower zoom (clamped to
 * the smallest level). Pure — safe to call repeatedly.
 */
export function prevZoom(z) {
  const i = ZOOM_LEVELS.findIndex(l => l >= z);
  return i <= 0 ? ZOOM_LEVELS[0] : ZOOM_LEVELS[i - 1];
}

/**
 * Step zoom up one level. Returns the next-higher zoom (clamped to
 * the largest level). Pure — safe to call repeatedly.
 */
export function nextZoom(z) {
  const i = ZOOM_LEVELS.findIndex(l => l > z);
  return i === -1 ? ZOOM_LEVELS[ZOOM_LEVELS.length - 1] : ZOOM_LEVELS[i];
}
