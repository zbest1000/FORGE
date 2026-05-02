// PDF / image annotation layer.
//
// Provides a single SVG overlay that:
//   * paints existing annotations (highlight / underline / strike / ink /
//     rect / ellipse / line / arrow / redact / text-insert / form-field)
//   * wires pointer events for the active tool so the user can draw new
//     ones via click-drag (or click for point tools)
//   * persists each new annotation through `update()` + `audit()`
//
// Coordinates: every annotation stores normalised x/y in [0..1] of the
// page so a re-render at a different zoom keeps placement accurate.
//
// Annotation shape:
//   { id, docId, revId, page, kind, bounds?, points?, text?, fieldLabel?,
//     color, strokeWidth?, author, ts }

import { state, update } from "./store.js";
import { audit } from "./audit.js";
import { toast } from "./ui.js";

const NS = "http://www.w3.org/2000/svg";

const DEFAULT_COLOR_BY_KIND = {
  highlight: "#fde047",   // amber 300
  underline: "#fb923c",   // orange 400
  strike:    "#fca5a5",   // red 300
  ink:       "#0ea5e9",   // sky 500
  rect:      "#38bdf8",   // sky 400
  ellipse:   "#38bdf8",
  line:      "#38bdf8",
  arrow:     "#38bdf8",
  redact:    "#0b1220",   // black-ish (matches dark backplate)
  "text-insert": "#fbbf24",
  "form-field":  "#a78bfa",
};

/** @returns {any[]} */
export function listAnnotations(docId, revId, page) {
  const all = /** @type {any} */ (state.data || {}).docAnnotations || [];
  return all.filter(a => a.docId === docId && a.revId === revId && a.page === page);
}

export function addAnnotation(ann) {
  /** @type {any} */ (state.data) ||= {};
  update(s => {
    /** @type {any} */ (s.data).docAnnotations = /** @type {any} */ (s.data).docAnnotations || [];
    /** @type {any} */ (s.data).docAnnotations.push(ann);
  });
  audit("doc.annotation.add", ann.docId, { id: ann.id, kind: ann.kind, page: ann.page });
}

export function updateAnnotation(id, patch) {
  update(s => {
    const arr = /** @type {any} */ (s.data).docAnnotations || [];
    const a = arr.find(x => x.id === id);
    if (!a) return;
    Object.assign(a, patch);
  });
  audit("doc.annotation.update", id, { patch });
}

export function deleteAnnotation(id) {
  update(s => {
    const arr = /** @type {any} */ (s.data).docAnnotations || [];
    const idx = arr.findIndex(x => x.id === id);
    if (idx >= 0) arr.splice(idx, 1);
  });
  audit("doc.annotation.delete", id);
}

/**
 * Build the SVG overlay for a page. The caller is expected to absolute-
 * position this on top of the rendered PDF canvas.
 *
 * @param {{ docId: string, revId: string, page: number, mode: string, tool: string, color?: string, author?: string, onChanged?: () => void }} opts
 */
export function buildAnnotationOverlay(opts) {
  const { docId, revId, page, mode, tool, color, author, onChanged } = opts;
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("viewBox", "0 0 1 1");
  svg.style.position = "absolute";
  svg.style.left = "0";
  svg.style.top = "0";
  svg.style.width = "100%";
  svg.style.height = "100%";
  // The overlay is non-interactive in View mode (so PDF text selection
  // works through it). Every other mode captures pointer events.
  svg.style.pointerEvents = mode === "view" ? "none" : "auto";
  svg.style.touchAction = "none";

  // Existing annotations.
  for (const a of listAnnotations(docId, revId, page)) {
    svg.append(renderAnnotation(a, mode));
  }

  // Tool wiring.
  if (mode !== "view") {
    wireTool(svg, { docId, revId, page, mode, tool, color, author, onChanged });
  }
  return svg;
}

/** Render a single annotation as an SVG element (group). */
function renderAnnotation(a, mode) {
  const g = document.createElementNS(NS, "g");
  g.setAttribute("data-annotation-id", a.id);
  g.style.cursor = mode === "view" ? "default" : "pointer";
  const stroke = a.color || DEFAULT_COLOR_BY_KIND[a.kind] || "#0ea5e9";
  const fill = a.color || DEFAULT_COLOR_BY_KIND[a.kind] || "#0ea5e9";

  const b = a.bounds || {};
  switch (a.kind) {
    case "highlight": {
      const r = rect(b);
      r.setAttribute("fill", stroke);
      r.setAttribute("fill-opacity", "0.35");
      r.setAttribute("stroke", "none");
      g.append(r);
      break;
    }
    case "underline": {
      const ln = document.createElementNS(NS, "line");
      ln.setAttribute("x1", String(b.x ?? 0));
      ln.setAttribute("x2", String((b.x ?? 0) + (b.w ?? 0)));
      ln.setAttribute("y1", String((b.y ?? 0) + (b.h ?? 0)));
      ln.setAttribute("y2", String((b.y ?? 0) + (b.h ?? 0)));
      ln.setAttribute("stroke", stroke);
      ln.setAttribute("stroke-width", "0.004");
      ln.setAttribute("vector-effect", "non-scaling-stroke");
      ln.style.strokeWidth = "2";
      g.append(ln);
      break;
    }
    case "strike": {
      const ln = document.createElementNS(NS, "line");
      ln.setAttribute("x1", String(b.x ?? 0));
      ln.setAttribute("x2", String((b.x ?? 0) + (b.w ?? 0)));
      ln.setAttribute("y1", String((b.y ?? 0) + (b.h ?? 0) / 2));
      ln.setAttribute("y2", String((b.y ?? 0) + (b.h ?? 0) / 2));
      ln.setAttribute("stroke", stroke);
      ln.setAttribute("vector-effect", "non-scaling-stroke");
      ln.style.strokeWidth = "2";
      g.append(ln);
      break;
    }
    case "ink": {
      const path = document.createElementNS(NS, "path");
      const d = pointsToPath(a.points || []);
      path.setAttribute("d", d);
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", stroke);
      path.setAttribute("vector-effect", "non-scaling-stroke");
      path.style.strokeWidth = String(a.strokeWidth || 2);
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("stroke-linejoin", "round");
      g.append(path);
      break;
    }
    case "rect":
    case "redact": {
      const r = rect(b);
      r.setAttribute("fill", a.kind === "redact" ? "#0b1220" : "transparent");
      r.setAttribute("stroke", a.kind === "redact" ? "#0b1220" : stroke);
      r.setAttribute("vector-effect", "non-scaling-stroke");
      r.style.strokeWidth = "2";
      g.append(r);
      break;
    }
    case "ellipse": {
      const e = document.createElementNS(NS, "ellipse");
      e.setAttribute("cx", String((b.x ?? 0) + (b.w ?? 0) / 2));
      e.setAttribute("cy", String((b.y ?? 0) + (b.h ?? 0) / 2));
      e.setAttribute("rx", String(Math.abs(b.w ?? 0) / 2));
      e.setAttribute("ry", String(Math.abs(b.h ?? 0) / 2));
      e.setAttribute("fill", "transparent");
      e.setAttribute("stroke", stroke);
      e.setAttribute("vector-effect", "non-scaling-stroke");
      e.style.strokeWidth = "2";
      g.append(e);
      break;
    }
    case "line":
    case "arrow": {
      const ln = document.createElementNS(NS, "line");
      ln.setAttribute("x1", String(b.x ?? 0));
      ln.setAttribute("y1", String(b.y ?? 0));
      ln.setAttribute("x2", String((b.x ?? 0) + (b.w ?? 0)));
      ln.setAttribute("y2", String((b.y ?? 0) + (b.h ?? 0)));
      ln.setAttribute("stroke", stroke);
      ln.setAttribute("vector-effect", "non-scaling-stroke");
      ln.style.strokeWidth = "2";
      g.append(ln);
      if (a.kind === "arrow") {
        // Arrowhead: small triangle at (x2, y2) pointing along the line.
        const dx = (b.w ?? 0);
        const dy = (b.h ?? 0);
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len, uy = dy / len;
        const sz = 0.012;
        const tipX = (b.x ?? 0) + dx;
        const tipY = (b.y ?? 0) + dy;
        const ax = tipX - ux * sz - uy * sz * 0.6;
        const ay = tipY - uy * sz + ux * sz * 0.6;
        const bx = tipX - ux * sz + uy * sz * 0.6;
        const by = tipY - uy * sz - ux * sz * 0.6;
        const tri = document.createElementNS(NS, "polygon");
        tri.setAttribute("points", `${tipX},${tipY} ${ax},${ay} ${bx},${by}`);
        tri.setAttribute("fill", stroke);
        g.append(tri);
      }
      break;
    }
    case "text-insert": {
      // Yellow "T" pin + foreignObject text bubble for visibility at any scale.
      const pin = document.createElementNS(NS, "circle");
      pin.setAttribute("cx", String(b.x ?? 0));
      pin.setAttribute("cy", String(b.y ?? 0));
      pin.setAttribute("r", "0.012");
      pin.setAttribute("fill", fill);
      g.append(pin);
      if (a.text) {
        const fo = document.createElementNS(NS, "foreignObject");
        const w = 0.30, h = 0.06;
        fo.setAttribute("x", String(Math.min(0.99 - w, (b.x ?? 0) + 0.01)));
        fo.setAttribute("y", String(Math.min(0.99 - h, (b.y ?? 0) + 0.01)));
        fo.setAttribute("width", String(w));
        fo.setAttribute("height", String(h));
        const div = document.createElement("div");
        div.style.font = "600 11px system-ui, sans-serif";
        div.style.background = "rgba(251, 191, 36, 0.95)";
        div.style.color = "#0b1220";
        div.style.borderRadius = "4px";
        div.style.padding = "4px 6px";
        div.style.boxShadow = "0 2px 6px rgba(0,0,0,0.25)";
        div.style.overflow = "hidden";
        div.style.textOverflow = "ellipsis";
        div.textContent = a.text;
        fo.appendChild(div);
        g.append(fo);
      }
      break;
    }
    case "form-field": {
      // Visible filled rectangle with a label + value overlay.
      const r = rect(b);
      r.setAttribute("fill", "rgba(167, 139, 250, 0.10)");
      r.setAttribute("stroke", stroke);
      r.setAttribute("stroke-dasharray", "0.005 0.003");
      r.setAttribute("vector-effect", "non-scaling-stroke");
      r.style.strokeWidth = "1.5";
      g.append(r);
      const fo = document.createElementNS(NS, "foreignObject");
      fo.setAttribute("x", String(b.x ?? 0));
      fo.setAttribute("y", String(b.y ?? 0));
      fo.setAttribute("width", String(b.w ?? 0));
      fo.setAttribute("height", String(b.h ?? 0));
      const div = document.createElement("div");
      div.style.font = "11px system-ui, sans-serif";
      div.style.color = "#e5edf7";
      div.style.padding = "4px 6px";
      div.style.height = "100%";
      div.style.display = "flex";
      div.style.flexDirection = "column";
      div.style.justifyContent = "center";
      const label = document.createElement("div");
      label.style.fontSize = "9px";
      label.style.color = "#a78bfa";
      label.textContent = a.fieldLabel || "Field";
      const value = document.createElement("div");
      value.style.fontSize = "12px";
      value.style.color = "#e5edf7";
      value.textContent = a.text || "(empty)";
      div.append(label, value);
      fo.appendChild(div);
      g.append(fo);
      break;
    }
    default:
      break;
  }

  // Click → delete (with confirm) so users can clean up. View mode
  // ignores clicks; Annotate / Shapes / Redact / Insert / Form modes
  // route them to delete.
  if (mode !== "view") {
    g.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      if (confirm(`Delete ${a.kind} annotation?`)) {
        deleteAnnotation(a.id);
        toast("Annotation deleted", "success");
      }
    });
  }
  return g;
}

function rect(b) {
  const r = document.createElementNS(NS, "rect");
  const x = Math.min(b.x ?? 0, (b.x ?? 0) + (b.w ?? 0));
  const y = Math.min(b.y ?? 0, (b.y ?? 0) + (b.h ?? 0));
  const w = Math.abs(b.w ?? 0);
  const h = Math.abs(b.h ?? 0);
  r.setAttribute("x", String(x));
  r.setAttribute("y", String(y));
  r.setAttribute("width", String(w));
  r.setAttribute("height", String(h));
  return r;
}

function pointsToPath(points) {
  if (!points || !points.length) return "";
  const [first, ...rest] = points;
  return `M ${first[0]} ${first[1]} ` + rest.map(p => `L ${p[0]} ${p[1]}`).join(" ");
}

// ---------------- pointer wiring ----------------

function localXY(svg, e) {
  const r = svg.getBoundingClientRect();
  return [
    Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
    Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
  ];
}

function newId() {
  return "ANN-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6).toUpperCase();
}

function shapeForMode(mode, tool) {
  // Annotate mode: 4 tools — highlight / underline / strike / draw +
  // sticky note (handled in docViewer separately for legacy parity).
  if (mode === "annotate") {
    if (tool === "highlight") return { kind: "highlight",  drag: "rect" };
    if (tool === "underline") return { kind: "underline",  drag: "rect" };
    if (tool === "strike")    return { kind: "strike",     drag: "rect" };
    if (tool === "draw")      return { kind: "ink",        drag: "ink"  };
    return null; // sticky note handled by docViewer's existing pin flow
  }
  // Shapes mode: pure shape tools.
  if (mode === "shapes") {
    if (tool === "rect")    return { kind: "rect",    drag: "rect" };
    if (tool === "ellipse") return { kind: "ellipse", drag: "rect" };
    if (tool === "line")    return { kind: "line",    drag: "line" };
    if (tool === "arrow")   return { kind: "arrow",   drag: "line" };
  }
  if (mode === "redact") return { kind: "redact",      drag: "rect" };
  if (mode === "insert") return { kind: "text-insert", drag: "click" };
  if (mode === "form")   return { kind: "form-field",  drag: "rect" };
  return null;
}

function wireTool(svg, ctx) {
  const shape = shapeForMode(ctx.mode, ctx.tool);
  if (!shape) return;

  // Pointer-down begins a draw; pointer-move updates a preview; pointer-
  // up commits the annotation. Click tools commit on the down event.
  let drawing = null;

  svg.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const [x, y] = localXY(svg, e);
    if (shape.drag === "click") {
      // Insert / point-style tools — prompt for text, then commit.
      const text = window.prompt("Note text") || "";
      if (!text.trim()) return;
      const ann = {
        id: newId(),
        docId: ctx.docId, revId: ctx.revId, page: ctx.page,
        kind: shape.kind,
        bounds: { x, y, w: 0, h: 0 },
        text: text.trim(),
        color: ctx.color || DEFAULT_COLOR_BY_KIND[shape.kind],
        author: ctx.author || "anonymous",
        ts: new Date().toISOString(),
      };
      addAnnotation(ann);
      ctx.onChanged?.();
      return;
    }

    drawing = { kind: shape.kind, drag: shape.drag, start: [x, y], current: [x, y], points: [[x, y]], previewEl: null };
    drawing.previewEl = createPreview(drawing, ctx);
    svg.append(drawing.previewEl);
    svg.setPointerCapture(e.pointerId);
  });

  svg.addEventListener("pointermove", (e) => {
    if (!drawing) return;
    const [x, y] = localXY(svg, e);
    drawing.current = [x, y];
    if (drawing.drag === "ink") drawing.points.push([x, y]);
    updatePreview(drawing);
  });

  svg.addEventListener("pointerup", (e) => {
    if (!drawing) return;
    svg.releasePointerCapture(e.pointerId);
    const d = drawing;
    drawing = null;
    if (d.previewEl) d.previewEl.remove();

    const [sx, sy] = d.start;
    const [cx, cy] = d.current;
    const w = cx - sx, h = cy - sy;

    // Reject zero-size accidental clicks.
    if (d.drag === "rect" && Math.abs(w) < 0.005 && Math.abs(h) < 0.005) return;
    if (d.drag === "line" && Math.hypot(w, h) < 0.005) return;
    if (d.drag === "ink" && d.points.length < 3) return;

    let extra = {};
    if (d.kind === "form-field") {
      const label = window.prompt("Field label") || "Field";
      const value = window.prompt(`Default value for "${label}"`) || "";
      extra.fieldLabel = label;
      extra.text = value;
    }
    if (d.kind === "redact") {
      const why = window.prompt("Reason for redaction (audited)") || "Redaction";
      extra.text = why;
    }

    const ann = {
      id: newId(),
      docId: ctx.docId, revId: ctx.revId, page: ctx.page,
      kind: d.kind,
      ...(d.drag === "ink"
        ? { points: d.points.slice() }
        : { bounds: { x: sx, y: sy, w, h } }),
      color: ctx.color || DEFAULT_COLOR_BY_KIND[d.kind],
      strokeWidth: 2,
      author: ctx.author || "anonymous",
      ts: new Date().toISOString(),
      ...extra,
    };
    addAnnotation(ann);
    ctx.onChanged?.();
  });

  svg.addEventListener("pointercancel", () => {
    if (drawing?.previewEl) drawing.previewEl.remove();
    drawing = null;
  });
}

function createPreview(d, ctx) {
  const stroke = ctx.color || DEFAULT_COLOR_BY_KIND[d.kind];
  if (d.drag === "rect") {
    const r = document.createElementNS(NS, "rect");
    r.setAttribute("x", String(d.start[0]));
    r.setAttribute("y", String(d.start[1]));
    r.setAttribute("width", "0");
    r.setAttribute("height", "0");
    r.setAttribute("fill", d.kind === "highlight" ? stroke : (d.kind === "redact" ? "#0b1220" : "transparent"));
    r.setAttribute("fill-opacity", d.kind === "highlight" ? "0.35" : "1");
    r.setAttribute("stroke", d.kind === "redact" ? "#0b1220" : stroke);
    r.setAttribute("vector-effect", "non-scaling-stroke");
    r.setAttribute("stroke-dasharray", "0.005 0.003");
    r.style.strokeWidth = "2";
    return r;
  }
  if (d.drag === "line") {
    const l = document.createElementNS(NS, "line");
    l.setAttribute("x1", String(d.start[0]));
    l.setAttribute("y1", String(d.start[1]));
    l.setAttribute("x2", String(d.start[0]));
    l.setAttribute("y2", String(d.start[1]));
    l.setAttribute("stroke", stroke);
    l.setAttribute("vector-effect", "non-scaling-stroke");
    l.style.strokeWidth = "2";
    return l;
  }
  // ink
  const p = document.createElementNS(NS, "path");
  p.setAttribute("fill", "none");
  p.setAttribute("stroke", stroke);
  p.setAttribute("vector-effect", "non-scaling-stroke");
  p.setAttribute("stroke-linecap", "round");
  p.setAttribute("stroke-linejoin", "round");
  p.style.strokeWidth = "2";
  return p;
}

function updatePreview(d) {
  if (!d.previewEl) return;
  if (d.drag === "rect") {
    const x = Math.min(d.start[0], d.current[0]);
    const y = Math.min(d.start[1], d.current[1]);
    const w = Math.abs(d.current[0] - d.start[0]);
    const h = Math.abs(d.current[1] - d.start[1]);
    d.previewEl.setAttribute("x", String(x));
    d.previewEl.setAttribute("y", String(y));
    d.previewEl.setAttribute("width", String(w));
    d.previewEl.setAttribute("height", String(h));
  } else if (d.drag === "line") {
    d.previewEl.setAttribute("x2", String(d.current[0]));
    d.previewEl.setAttribute("y2", String(d.current[1]));
  } else if (d.drag === "ink") {
    d.previewEl.setAttribute("d", pointsToPath(d.points));
  }
}
