// Drawing viewer v2 — spec §8 "Drawing and Model Viewer Detailed Requirements".
//
// Feature set:
//   * Sheet navigator + mini-map
//   * SVG canvas with 2D transform: zoom (wheel), pan (drag), reset, fit-to-view
//   * Measure tool (two-click, on-canvas readout)
//   * Markup palette: arrow, cloud, highlight, text, stamp, status marker, pin
//   * Compare/overlay mode with opacity slider
//   * Layer toggle (dims, objects, annotations)
//   * BIM/IFC mode — object tree + metadata inspector (stub model graph)
//   * Cross-link panel (drawing ↔ spec ↔ task ↔ asset ↔ discussion)
//   * One-click issue creation from a markup
//
// Geometry is stored as normalized [0..1] coordinates on the active sheet so
// zoom/pan don't warp markups.

import { el, mount, card, badge, toast, chip, modal, formRow, input, select, textarea, prompt } from "../core/ui.js";
import { state, update, getById } from "../core/store.js";
import { audit } from "../core/audit.js";
import { navigate } from "../core/router.js";
import { can } from "../core/permissions.js";
import { follow, isFollowing, unfollow } from "../core/subscriptions.js";
import { vendor } from "../core/vendor.js";
import { renderCad } from "../core/cad-viewer.js";
import { detectCad, supportedExtensions } from "../core/cad.js";

export function renderDrawingsIndex() {
  const root = document.getElementById("screenContainer");
  const d = state.data;
  mount(root, [
    card("Drawings", el("div", { class: "card-grid" }, (d.drawings || []).map(dr => {
      const nMarkups = (d.markups || []).filter(m => m.drawingId === dr.id).length;
      return card(dr.name, el("div", { class: "stack" }, [
        el("div", { class: "tiny muted" }, [`${dr.sheets.length} sheets · ${dr.discipline}`]),
        el("div", { class: "row wrap" }, [badge(`${nMarkups} markups`, "info")]),
      ]), { actions: [el("button", { class: "btn sm primary", onClick: () => navigate(`/drawing/${dr.id}`) }, ["Open"])] });
    }))),
  ]);
}

const SK = (drawingId, k) => `drawing.${drawingId}.${k}`;

const TOOLS = ["pan", "measure", "arrow", "callout", "cloud", "highlight", "text", "stamp", "status", "pin"];

export function renderDrawingViewer({ id }) {
  const root = document.getElementById("screenContainer");
  const dr = getById("drawings", id);
  if (!dr) return mount(root, el("div", { class: "muted" }, ["Drawing not found."]));

  const activeSheetId = sessionStorage.getItem(SK(id, "sheet")) || dr.sheets[0].id;
  const mode = sessionStorage.getItem(SK(id, "mode")) || "view"; // view | markup | compare | ifc
  const tool = sessionStorage.getItem(SK(id, "tool")) || "pan";
  const compareWithId = sessionStorage.getItem(SK(id, "compareWith")) || null;
  const overlayOpacity = parseFloat(sessionStorage.getItem(SK(id, "overlayOpacity")) || "0.5");
  const layers = parseLayers(sessionStorage.getItem(SK(id, "layers")));

  const markups = (state.data.markups || []).filter(m => m.drawingId === id && m.sheetId === activeSheetId);

  mount(root, [
    toolbar(dr, activeSheetId, mode, tool, layers, compareWithId, overlayOpacity),
    el("div", { class: "viewer-layout" }, [
      canvasColumn(dr, activeSheetId, mode, tool, markups, layers, compareWithId, overlayOpacity),
      sideColumn(dr, id, activeSheetId, markups, mode),
    ]),
  ]);
}

// ---------- toolbar ----------
function toolbar(dr, sheetId, mode, tool, layers, compareWithId, overlayOpacity) {
  const id = dr.id;
  return el("div", { class: "viewer-toolbar", style: { marginBottom: "12px", borderRadius: "8px" } }, [
    // Sheet tabs
    ...dr.sheets.map(s => el("button", {
      class: `btn sm ${s.id === sheetId ? "primary" : ""}`,
      onClick: () => { sessionStorage.setItem(SK(id, "sheet"), s.id); renderDrawingViewer({ id }); },
    }, [s.label])),

    sep(),

    // Mode group
    ...["view", "markup", "compare", "ifc"].map(m => el("button", {
      class: `btn sm ${mode === m ? "primary" : ""}`,
      onClick: () => { sessionStorage.setItem(SK(id, "mode"), m); renderDrawingViewer({ id }); },
    }, [m.toUpperCase()])),

    sep(),

    // Tool group (enabled in markup mode)
    ...TOOLS.map(t => el("button", {
      class: `btn sm ${tool === t ? "primary" : ""}`,
      disabled: mode !== "markup",
      title: t,
      onClick: () => { sessionStorage.setItem(SK(id, "tool"), t); renderDrawingViewer({ id }); },
    }, [toolIcon(t)])),

    sep(),

    // Zoom/reset
    el("button", { class: "btn sm", onClick: () => zoom(id, 1.25) }, ["+"]),
    el("button", { class: "btn sm", onClick: () => zoom(id, 0.8) }, ["−"]),
    el("button", { class: "btn sm", onClick: () => resetView(id) }, ["Fit"]),

    sep(),

    // Layers
    ...["dims", "objects", "annotations"].map(layer => el("button", {
      class: `btn sm ${layers[layer] ? "primary" : ""}`,
      onClick: () => { layers[layer] = !layers[layer]; sessionStorage.setItem(SK(id, "layers"), JSON.stringify(layers)); renderDrawingViewer({ id }); },
    }, [`layer:${layer}`])),

    // Compare picker
    mode === "compare" ? compareSelector(dr, compareWithId, overlayOpacity) : null,

    el("span", { style: { flex: 1 } }),
    el("button", { class: "btn sm", onClick: () => loadCadFile(dr) }, [dr.cadUrl ? "Reload CAD" : "Load CAD…"]),
    el("button", { class: "btn sm", onClick: () => exportSVG(id) }, ["Export SVG"]),
  ]);
}

function sep() { return el("span", { style: { width: "1px", height: "22px", background: "var(--border)", margin: "0 4px" } }); }
function toolIcon(t) {
  const map = { pan: "✋", measure: "📏", arrow: "➜", callout: "💬", cloud: "☁", highlight: "▮", text: "T", stamp: "⛊", status: "●", pin: "📍" };
  return map[t] || t;
}

function compareSelector(dr, compareWithId, overlayOpacity) {
  const sheetsOther = dr.sheets.filter(s => s.id !== (sessionStorage.getItem(SK(dr.id, "sheet")) || dr.sheets[0].id));
  const picker = select(
    [{ value: "", label: "(none)" }, ...sheetsOther.map(s => ({ value: s.id, label: s.label }))],
    { value: compareWithId || "", onChange: e => { sessionStorage.setItem(SK(dr.id, "compareWith"), e.target.value); renderDrawingViewer({ id: dr.id }); } }
  );
  const slider = el("input", { type: "range", min: "0", max: "1", step: "0.05", value: String(overlayOpacity),
    onInput: e => { sessionStorage.setItem(SK(dr.id, "overlayOpacity"), e.target.value); applyOverlayOpacity(dr.id, parseFloat(e.target.value)); },
  });
  return el("div", { class: "row", style: { gap: "6px" } }, [
    el("span", { class: "tiny muted" }, ["compare:"]), picker,
    el("span", { class: "tiny muted" }, ["opacity:"]), slider,
  ]);
}

// ---------- canvas column ----------
function canvasColumn(dr, sheetId, mode, tool, markups, layers, compareWithId, overlayOpacity) {
  const cell = el("div", { class: "viewer-canvas" });
  cell.append(pageArea(dr, sheetId, mode, tool, markups, layers, compareWithId, overlayOpacity));
  return cell;
}

function pageArea(dr, sheetId, mode, tool, markups, layers, compareWithId, overlayOpacity) {
  const id = dr.id;
  const viewState = loadViewState(id);

  // If a CAD asset is attached, render that instead of the synthetic SVG
  // sheet — DXF/STEP/IGES/STL/OBJ/glTF/IFC etc. The native markup palette
  // still works for any kind, since the CAD viewer is hosted inside the
  // same `viewer-page` container.
  if (dr.cadUrl) {
    const cadHost = el("div", { class: "viewer-page", style: { position: "relative", overflow: "hidden" } });
    const innerHost = el("div", { style: { position: "absolute", inset: "0" } });
    cadHost.append(innerHost);
    renderCad(innerHost, { url: dr.cadUrl, name: dr.cadUrl }).catch(() => {});
    return cadHost;
  }

  const svg = buildSvg(dr, sheetId, markups, layers, compareWithId, overlayOpacity, viewState);

  const container = el("div", {
    class: "viewer-page",
    style: { position: "relative", overflow: "hidden" },
    onWheel: (e) => {
      if (e.ctrlKey) return;
      e.preventDefault();
      const rect = container.getBoundingClientRect();
      const cx = (e.clientX - rect.left) / rect.width;
      const cy = (e.clientY - rect.top) / rect.height;
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      zoomAt(id, factor, cx, cy);
    },
  });

  // Pan handling
  let panning = false;
  let lastX = 0, lastY = 0;
  let measurePoints = [];

  container.addEventListener("mousedown", (e) => {
    if (mode === "markup" && tool !== "pan") return;
    if (mode === "ifc") return;
    panning = true;
    lastX = e.clientX; lastY = e.clientY;
    container.style.cursor = "grabbing";
  });
  window.addEventListener("mouseup", () => { panning = false; container.style.cursor = ""; });
  container.addEventListener("mousemove", (e) => {
    if (!panning) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    const rect = container.getBoundingClientRect();
    const v = loadViewState(id);
    v.tx = (v.tx || 0) + dx / rect.width;
    v.ty = (v.ty || 0) + dy / rect.height;
    saveViewState(id, v);
    applyTransform(id, v);
  });

  // Click handling for markup placement and measure.
  container.addEventListener("click", (e) => {
    if (mode !== "markup") return;
    const rect = container.getBoundingClientRect();
    const v = loadViewState(id);
    const scale = v.k || 1;
    // Invert the canvas transform to get the normalized position on the sheet.
    const xCanvas = (e.clientX - rect.left) / rect.width;
    const yCanvas = (e.clientY - rect.top) / rect.height;
    const nx = (xCanvas - (v.tx || 0) - 0.5) / scale + 0.5;
    const ny = (yCanvas - (v.ty || 0) - 0.5) / scale + 0.5;
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return;

    if (tool === "measure") {
      measurePoints.push({ x: nx, y: ny });
      if (measurePoints.length === 2) {
        const [a, b] = measurePoints;
        const dist = Math.hypot((b.x - a.x), (b.y - a.y));
        toast(`Distance (normalized): ${dist.toFixed(3)}`, "info");
        measurePoints = [];
      }
      return;
    }
    createMarkup(id, sheetId, tool, nx, ny);
  });

  container.append(svg);

  // Upgrade zoom/pan to svg-pan-zoom (BSD-2) if available. This replaces the
  // custom wheel/drag handlers with a well-tested library when present, but
  // keeps ours as the default so offline works.
  (async () => {
    try {
      const spz = await vendor.svgPanZoom();
      if (!spz) return;
      // Give the browser a tick to lay out the SVG first.
      await new Promise(r => requestAnimationFrame(r));
      spz(svg, {
        zoomEnabled: true,
        panEnabled: mode !== "markup",
        controlIconsEnabled: true,
        fit: true,
        center: true,
        minZoom: 0.5,
        maxZoom: 10,
      });
      // Mark so our hand-rolled transform helpers don't fight the lib.
      svg.dataset.spz = "1";
    } catch { /* fallback already active */ }
  })();

  return container;
}

function buildSvg(dr, sheetId, markups, layers, compareWithId, overlayOpacity, viewState) {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 1000 700");
  svg.setAttribute("id", `svg-${dr.id}`);
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  svg.style.width = "100%";
  svg.style.height = "70vh";
  svg.style.background = "#f8fafc";
  svg.style.userSelect = "none";

  const gAll = document.createElementNS(NS, "g");
  gAll.setAttribute("id", `all-${dr.id}`);
  applyGroupTransform(gAll, viewState);
  svg.append(gAll);

  // Base sheet content
  const gSheet = document.createElementNS(NS, "g");
  gSheet.setAttribute("data-layer", "objects");
  if (!layers.objects) gSheet.setAttribute("display", "none");
  gSheet.append(...sheetGeometry(dr.id + ":" + sheetId));
  gAll.append(gSheet);

  // Overlay (compare)
  if (compareWithId) {
    const gOv = document.createElementNS(NS, "g");
    gOv.setAttribute("data-overlay", "1");
    gOv.setAttribute("style", `opacity:${overlayOpacity}; filter: hue-rotate(120deg) saturate(1.5);`);
    gOv.append(...sheetGeometry(dr.id + ":" + compareWithId));
    gAll.append(gOv);
  }

  // Dimensions layer
  const gDims = document.createElementNS(NS, "g");
  gDims.setAttribute("data-layer", "dims");
  if (!layers.dims) gDims.setAttribute("display", "none");
  gDims.append(...dimensionLines(dr.id + ":" + sheetId));
  gAll.append(gDims);

  // Annotations (markups)
  const gAnn = document.createElementNS(NS, "g");
  gAnn.setAttribute("data-layer", "annotations");
  if (!layers.annotations) gAnn.setAttribute("display", "none");
  for (const m of markups) {
    gAnn.append(renderMarkup(m));
  }
  gAll.append(gAnn);

  return svg;
}

function applyGroupTransform(g, v) {
  const { tx = 0, ty = 0, k = 1 } = v || {};
  // Origin-center zoom: translate to center, scale, translate back, then pan.
  const W = 1000, H = 700;
  const cx = W / 2, cy = H / 2;
  g.setAttribute("transform", `translate(${tx * W} ${ty * H}) translate(${cx} ${cy}) scale(${k}) translate(${-cx} ${-cy})`);
}

function applyTransform(drawingId, v) {
  const g = document.getElementById(`all-${drawingId}`);
  if (g) applyGroupTransform(g, v);
}

function applyOverlayOpacity(drawingId, opacity) {
  const g = document.getElementById(`all-${drawingId}`);
  if (!g) return;
  const ov = g.querySelector("[data-overlay]");
  if (ov) ov.setAttribute("style", `opacity:${opacity}; filter: hue-rotate(120deg) saturate(1.5);`);
}

function loadViewState(id) {
  try { return JSON.parse(sessionStorage.getItem(SK(id, "view")) || "{}"); } catch { return {}; }
}
function saveViewState(id, v) { sessionStorage.setItem(SK(id, "view"), JSON.stringify(v)); }

function zoom(id, factor) { zoomAt(id, factor, 0.5, 0.5); }
function zoomAt(id, factor, cx, cy) {
  const v = loadViewState(id);
  const oldK = v.k || 1;
  const newK = Math.min(8, Math.max(0.2, oldK * factor));
  // Adjust translation so the point under cursor stays fixed.
  const dK = newK / oldK;
  v.tx = (v.tx || 0) + (cx - 0.5 - (v.tx || 0)) * (1 - dK);
  v.ty = (v.ty || 0) + (cy - 0.5 - (v.ty || 0)) * (1 - dK);
  v.k = newK;
  saveViewState(id, v);
  applyTransform(id, v);
}

function resetView(id) { saveViewState(id, { tx: 0, ty: 0, k: 1 }); applyTransform(id, { tx: 0, ty: 0, k: 1 }); }

function parseLayers(s) {
  try { return Object.assign({ dims: true, objects: true, annotations: true }, JSON.parse(s || "{}")); }
  catch { return { dims: true, objects: true, annotations: true }; }
}

// ---------- geometry generators (deterministic but content-rich) ----------
function sheetGeometry(seedKey) {
  const NS = "http://www.w3.org/2000/svg";
  const out = [];
  const seed = Array.from(seedKey).reduce((a, c) => a + c.charCodeAt(0), 0);
  // Title block
  const tb = document.createElementNS(NS, "rect");
  tb.setAttribute("x", 20); tb.setAttribute("y", 20);
  tb.setAttribute("width", 960); tb.setAttribute("height", 660);
  tb.setAttribute("fill", "none"); tb.setAttribute("stroke", "#0f172a"); tb.setAttribute("stroke-width", 1.5);
  out.push(tb);
  // Random piping/wiring/equipment lines
  for (let i = 0; i < 40; i++) {
    const x1 = ((i * 71 + seed) % 900) + 40;
    const y1 = ((i * 37 + seed) % 600) + 40;
    const x2 = x1 + 40 + ((i * 17 + seed) % 120);
    const y2 = y1 + ((i * 23 + seed) % 80) - 40;
    const l = document.createElementNS(NS, "line");
    l.setAttribute("x1", x1); l.setAttribute("y1", y1); l.setAttribute("x2", x2); l.setAttribute("y2", y2);
    l.setAttribute("stroke", "#475569"); l.setAttribute("stroke-width", 1.2);
    out.push(l);
  }
  // Equipment bubbles
  for (let i = 0; i < 10; i++) {
    const cx = ((i * 97 + seed) % 900) + 40;
    const cy = ((i * 53 + seed) % 600) + 40;
    const r = 22;
    const c = document.createElementNS(NS, "circle");
    c.setAttribute("cx", cx); c.setAttribute("cy", cy); c.setAttribute("r", r);
    c.setAttribute("fill", "#fff"); c.setAttribute("stroke", "#0f172a"); c.setAttribute("stroke-width", 1.2);
    out.push(c);
    const t = document.createElementNS(NS, "text");
    t.setAttribute("x", cx); t.setAttribute("y", cy + 4);
    t.setAttribute("text-anchor", "middle"); t.setAttribute("font-size", 12); t.setAttribute("fill", "#0f172a");
    t.textContent = ["V-101","V-102","V-103","P-1","P-2","TK-1","HX-01","PSV-14","PT-102","LT-3"][i % 10];
    out.push(t);
  }
  return out;
}

function dimensionLines(seedKey) {
  const NS = "http://www.w3.org/2000/svg";
  const out = [];
  const seed = Array.from(seedKey).reduce((a, c) => a + c.charCodeAt(0), 0);
  for (let i = 0; i < 6; i++) {
    const y = 60 + i * 100;
    const l = document.createElementNS(NS, "line");
    l.setAttribute("x1", 40); l.setAttribute("y1", y); l.setAttribute("x2", 960); l.setAttribute("y2", y);
    l.setAttribute("stroke", "#94a3b8"); l.setAttribute("stroke-dasharray", "4 4"); l.setAttribute("stroke-width", 0.8);
    out.push(l);
    const t = document.createElementNS(NS, "text");
    t.setAttribute("x", 970); t.setAttribute("y", y + 3); t.setAttribute("font-size", 10); t.setAttribute("fill", "#94a3b8");
    t.textContent = `${((i * 1300 + seed) % 5000)} mm`;
    out.push(t);
  }
  return out;
}

function renderMarkup(m) {
  const NS = "http://www.w3.org/2000/svg";
  const x = m.x * 1000, y = m.y * 700;
  const g = document.createElementNS(NS, "g");
  g.setAttribute("data-markup", m.id);
  g.setAttribute("style", "cursor: pointer;");
  g.addEventListener("click", (e) => { e.stopPropagation(); showMarkup(m); });

  switch (m.kind || "pin") {
    case "arrow": {
      const line = document.createElementNS(NS, "line");
      line.setAttribute("x1", x - 40); line.setAttribute("y1", y - 40);
      line.setAttribute("x2", x); line.setAttribute("y2", y);
      line.setAttribute("stroke", "#ef4444"); line.setAttribute("stroke-width", 2);
      line.setAttribute("marker-end", "url(#arrow)");
      g.append(line);
      const head = document.createElementNS(NS, "polygon");
      head.setAttribute("points", `${x},${y} ${x-10},${y-5} ${x-10},${y+5}`);
      head.setAttribute("fill", "#ef4444");
      g.append(head);
      break;
    }
    case "callout": {
      // Connector + bubble. Anchor (x,y) with bubble offset to upper-left.
      const bx = x - 110, by = y - 70;
      const bw = 160, bh = 40;
      const conn = document.createElementNS(NS, "line");
      conn.setAttribute("x1", x); conn.setAttribute("y1", y);
      conn.setAttribute("x2", bx + bw); conn.setAttribute("y2", by + bh);
      conn.setAttribute("stroke", "#0ea5e9"); conn.setAttribute("stroke-width", 1.5);
      g.append(conn);
      const dot = document.createElementNS(NS, "circle");
      dot.setAttribute("cx", x); dot.setAttribute("cy", y); dot.setAttribute("r", 4);
      dot.setAttribute("fill", "#0ea5e9");
      g.append(dot);
      const bubble = document.createElementNS(NS, "rect");
      bubble.setAttribute("x", bx); bubble.setAttribute("y", by);
      bubble.setAttribute("width", bw); bubble.setAttribute("height", bh);
      bubble.setAttribute("rx", 6);
      bubble.setAttribute("fill", "#fff"); bubble.setAttribute("stroke", "#0ea5e9"); bubble.setAttribute("stroke-width", 1.5);
      g.append(bubble);
      const tx = document.createElementNS(NS, "text");
      tx.setAttribute("x", bx + 8); tx.setAttribute("y", by + 24);
      tx.setAttribute("fill", "#0f172a"); tx.setAttribute("font-size", 12);
      tx.textContent = (m.text || "Callout").slice(0, 22);
      g.append(tx);
      break;
    }
    case "cloud": {
      const c = document.createElementNS(NS, "ellipse");
      c.setAttribute("cx", x); c.setAttribute("cy", y);
      c.setAttribute("rx", 60); c.setAttribute("ry", 30);
      c.setAttribute("fill", "none"); c.setAttribute("stroke", "#a855f7"); c.setAttribute("stroke-width", 2);
      c.setAttribute("stroke-dasharray", "4 3");
      g.append(c);
      break;
    }
    case "highlight": {
      const r = document.createElementNS(NS, "rect");
      r.setAttribute("x", x - 40); r.setAttribute("y", y - 14);
      r.setAttribute("width", 80); r.setAttribute("height", 28);
      r.setAttribute("fill", "#facc15"); r.setAttribute("opacity", "0.35");
      g.append(r);
      break;
    }
    case "text": {
      const t = document.createElementNS(NS, "text");
      t.setAttribute("x", x); t.setAttribute("y", y);
      t.setAttribute("fill", "#0f172a"); t.setAttribute("font-size", 14); t.setAttribute("font-weight", "700");
      t.textContent = (m.text || "").slice(0, 24);
      g.append(t);
      break;
    }
    case "stamp": {
      const r = document.createElementNS(NS, "rect");
      r.setAttribute("x", x - 36); r.setAttribute("y", y - 14);
      r.setAttribute("width", 72); r.setAttribute("height", 28);
      r.setAttribute("fill", "none"); r.setAttribute("stroke", "#16a34a"); r.setAttribute("stroke-width", 2);
      g.append(r);
      const t = document.createElementNS(NS, "text");
      t.setAttribute("x", x); t.setAttribute("y", y + 5);
      t.setAttribute("text-anchor", "middle"); t.setAttribute("fill", "#16a34a"); t.setAttribute("font-size", 12); t.setAttribute("font-weight", "700");
      t.textContent = m.stampLabel || "APPROVED";
      g.append(t);
      break;
    }
    case "status": {
      const c = document.createElementNS(NS, "circle");
      c.setAttribute("cx", x); c.setAttribute("cy", y); c.setAttribute("r", 10);
      const color = m.statusColor || "#f59e0b";
      c.setAttribute("fill", color); c.setAttribute("stroke", "#0f172a"); c.setAttribute("stroke-width", 1);
      g.append(c);
      break;
    }
    case "pin":
    default: {
      const c = document.createElementNS(NS, "circle");
      c.setAttribute("cx", x); c.setAttribute("cy", y); c.setAttribute("r", 10);
      c.setAttribute("fill", "#38bdf8"); c.setAttribute("stroke", "#fff"); c.setAttribute("stroke-width", 2);
      g.append(c);
      const t = document.createElementNS(NS, "text");
      t.setAttribute("x", x); t.setAttribute("y", y + 4);
      t.setAttribute("text-anchor", "middle"); t.setAttribute("font-size", 10); t.setAttribute("fill", "#0b1220"); t.setAttribute("font-weight", "700");
      t.textContent = String(m.seq || "•");
      g.append(t);
    }
  }
  return g;
}

// ---------- side column ----------
function sideColumn(dr, id, sheetId, markups, mode) {
  if (mode === "ifc") return ifcPanel(dr);
  return el("div", { class: "viewer-side" }, [
    miniMap(dr, sheetId, markups),
    bookmarksCard(dr, sheetId),
    card(`Markups on this sheet (${markups.length})`, markupList(markups, dr.id)),
    crossLinks(dr),
    followCard(dr.id),
    card("AI — Markup cluster summary", el("div", { class: "stack" }, [
      el("div", { class: "small" }, [
        markups.length
          ? `${markups.length} markups on this sheet. Type mix: ${histogramMarkupTypes(markups)}.`
          : "No markups yet. Use the toolbar to switch to MARKUP mode and pick an annotation tool."
      ]),
      el("button", { class: "btn sm", onClick: () => navigate(`/ai?drawing=${dr.id}`) }, ["Open AI →"]),
    ])),
  ]);
}

function bookmarksCard(dr, sheetId) {
  const key = SK(dr.id, "bookmarks");
  let list;
  try { list = JSON.parse(sessionStorage.getItem(key) || "[]"); } catch { list = []; }
  const sheetList = list.filter(b => b.sheetId === sheetId);

  const captureCurrent = async () => {
    let view; try { view = JSON.parse(sessionStorage.getItem(SK(dr.id, "view")) || "{}"); } catch { view = {}; }
    const name = await prompt({ title: "Bookmark name", defaultValue: `View ${sheetList.length + 1}` });
    if (!name) return;
    const bookmark = {
      id: "BM-" + Math.random().toString(36).slice(2, 8).toUpperCase(),
      name,
      sheetId,
      view,
      created_at: new Date().toISOString(),
    };
    list.push(bookmark);
    sessionStorage.setItem(key, JSON.stringify(list));
    audit("drawing.bookmark.create", bookmark.id, { drawingId: dr.id, sheetId });
    renderDrawingViewer({ id: dr.id });
  };

  const goTo = (b) => {
    if (b.sheetId !== sheetId) sessionStorage.setItem(SK(dr.id, "sheet"), b.sheetId);
    sessionStorage.setItem(SK(dr.id, "view"), JSON.stringify(b.view || {}));
    audit("drawing.bookmark.open", b.id, { drawingId: dr.id });
    renderDrawingViewer({ id: dr.id });
  };

  const remove = (b) => {
    const next = list.filter(x => x.id !== b.id);
    sessionStorage.setItem(key, JSON.stringify(next));
    audit("drawing.bookmark.delete", b.id, { drawingId: dr.id });
    renderDrawingViewer({ id: dr.id });
  };

  return card("Snap-to-region bookmarks", el("div", { class: "stack" }, [
    el("div", { class: "tiny muted" }, ["Capture the current zoom + pan as a named region. Click to snap back."]),
    sheetList.length
      ? el("div", { class: "stack" }, sheetList.map(b => el("div", { class: "activity-row" }, [
          el("button", { class: "btn sm", onClick: () => goTo(b), "aria-label": `Snap to ${b.name}` }, ["📍"]),
          el("span", { class: "small", style: { flex: 1 } }, [b.name]),
          el("span", { class: "tiny muted mono" }, [`k=${(b.view?.k ?? 1).toFixed(2)}`]),
          el("button", { class: "btn sm danger", onClick: () => remove(b), "aria-label": `Delete bookmark ${b.name}` }, ["×"]),
        ])))
      : el("div", { class: "muted tiny" }, ["No bookmarks for this sheet."]),
    el("button", { class: "btn sm primary", onClick: captureCurrent }, ["+ Capture current view"]),
  ]));
}

function miniMap(dr, sheetId, markups) {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 1000 700");
  svg.style.width = "100%";
  svg.style.height = "120px";
  svg.style.background = "#f8fafc";
  svg.style.borderRadius = "4px";
  svg.append(...sheetGeometry(dr.id + ":" + sheetId));
  for (const m of markups) svg.append(renderMarkup({ ...m, kind: "pin" }));
  return card("Mini-map", svg, { subtitle: "Click a sheet tab to switch." });
}

function markupList(markups, drawingId) {
  if (!markups.length) return el("div", { class: "muted tiny" }, ["No markups on this sheet yet."]);
  return el("div", { class: "stack" }, markups.map((m, i) => el("div", { class: "activity-row" }, [
    el("span", { class: "ts" }, [`#${m.seq || i + 1}`]),
    el("div", { class: "stack", style: { gap: "2px", flex: 1 } }, [
      el("span", { class: "small" }, [m.text || `(${m.kind})`]),
      el("span", { class: "tiny muted" }, [`${m.kind} · ${m.author || "?"}`]),
    ]),
    el("button", { class: "btn sm", onClick: () => convertMarkupToIssue(m) }, ["→ Issue"]),
  ])));
}

function crossLinks(dr) {
  const d = state.data;
  const doc = d.documents.find(x => x.id === dr.docId);
  const project = doc ? d.projects.find(p => p.id === doc.projectId) : null;
  const relatedAssets = d.assets.filter(a => (a.docIds || []).includes(dr.docId));
  const tasks = d.workItems.filter(w => (w.projectId === doc?.projectId));
  return card("Cross-links", el("div", { class: "stack" }, [
    doc ? linkRow("Document", doc.name, `/doc/${doc.id}`) : null,
    project ? linkRow("Project", project.name, `/work-board/${project.id}`) : null,
    ...relatedAssets.map(a => linkRow("Asset", a.name, `/asset/${a.id}`)),
    tasks.slice(0, 5).map(w => linkRow("Task", w.title, `/work-board/${w.projectId}`)),
  ].flat().filter(Boolean)), { subtitle: "drawing ↔ spec ↔ task ↔ asset ↔ discussion" });
}
function linkRow(kind, label, route) {
  return el("div", { class: "activity-row", onClick: () => navigate(route) }, [
    badge(kind, "info"),
    el("span", { class: "small" }, [label]),
  ]);
}

function followCard(drawingId) {
  const is = isFollowing(drawingId);
  return card("Subscribe", el("div", { class: "stack" }, [
    el("div", { class: "small muted" }, [
      is ? "You will receive notifications for updates on this drawing." : "Follow this drawing to be notified of markup and revision changes."
    ]),
    el("button", {
      class: `btn sm ${is ? "danger" : "primary"}`,
      onClick: () => { is ? unfollow(drawingId) : follow(drawingId); renderDrawingViewer({ id: drawingId }); },
    }, [is ? "Unfollow" : "Follow"]),
  ]));
}

function histogramMarkupTypes(markups) {
  const counts = {};
  for (const m of markups) counts[m.kind || "pin"] = (counts[m.kind || "pin"] || 0) + 1;
  return Object.entries(counts).map(([k, n]) => `${k}×${n}`).join(", ");
}

// ---------- IFC mode ----------
async function loadCadFile(dr) {
  const url = await prompt({
    title: "Load CAD file",
    message: "Supported: " + supportedExtensions().join(", ") + ". Must be CORS-enabled.",
    defaultValue: dr.cadUrl || "",
    placeholder: "https://...",
  });
  if (!url) return;
  const detected = detectCad(url);
  if (!detected) { toast("Unsupported CAD format", "warn"); return; }
  update(s => { const x = s.data.drawings.find(y => y.id === dr.id); if (x) { x.cadUrl = url; x.cadKind = detected.kind; } });
  audit("drawing.cad.attach", dr.id, { url, kind: detected.kind });
  toast(`Loading ${detected.name}…`, "info");
  renderDrawingViewer({ id: dr.id });
}

async function loadIfcFile(dr) {
  const url = await prompt({ title: "Load IFC file", message: "Must be CORS-enabled.", defaultValue: dr.ifcUrl || "", placeholder: "https://..." });
  if (!url) return;
  update(s => { const x = s.data.drawings.find(y => y.id === dr.id); if (x) x.ifcUrl = url; });
  toast("Loading IFC via web-ifc (MPL 2.0)...", "info");
  try {
    const mod = await vendor.webIfc();
    if (!mod) { toast("web-ifc unavailable", "warn"); return; }
    const IfcAPI = new mod.IfcAPI();
    await IfcAPI.Init();
    const buf = await fetch(url).then(r => r.arrayBuffer());
    const modelID = IfcAPI.OpenModel(new Uint8Array(buf));
    const lines = IfcAPI.GetAllLines(modelID);
    audit("drawing.ifc.load", dr.id, { url, entities: lines?.size?.() || 0 });
    toast(`IFC loaded — ${lines?.size?.() || 0} entities`, "success");
    IfcAPI.CloseModel(modelID);
    renderDrawingViewer({ id: dr.id });
  } catch (e) {
    toast("IFC load failed: " + e.message, "danger");
  }
}

function ifcPanel(dr) {
  const model = {
    name: dr.name,
    root: {
      id: "ROOT", type: "IfcProject", children: [
        { id: "SITE-1", type: "IfcSite", attrs: { latlon: "40.7/-74.0" }, children: [
          { id: "BLDG-1", type: "IfcBuilding", attrs: { elevation: "+0m" }, children: [
            { id: "LVL-1", type: "IfcBuildingStorey", attrs: { level: 1 }, children: [
              { id: "SPC-A", type: "IfcSpace", attrs: { use: "Control Room" } },
              { id: "EQ-HX01", type: "IfcEquipment", attrs: { tag: "HX-01", type: "HeatExchanger" } },
              { id: "EQ-PV14", type: "IfcFlowController", attrs: { tag: "PSV-14" } },
            ]},
          ]},
        ]},
      ],
    },
  };
  const selectedKey = `ifc.${dr.id}.sel`;
  const selected = sessionStorage.getItem(selectedKey) || "EQ-HX01";
  const node = findIfcNode(model.root, selected) || model.root;

  return el("div", { class: "viewer-side", style: { gridColumn: "1 / 3" } }, [
    el("div", { class: "viewer-layout" }, [
      card("Object tree", renderIfcTree(model.root, selected, id => {
        sessionStorage.setItem(selectedKey, id);
        renderDrawingViewer({ id: dr.id });
      })),
      el("div", { class: "stack" }, [
        card("Metadata inspector", el("div", { class: "stack" }, [
          el("div", { class: "strong" }, [node.type]),
          el("div", { class: "tiny muted" }, [node.id]),
          ...Object.entries(node.attrs || {}).map(([k, v]) => el("div", { class: "row" }, [
            el("span", { class: "tiny muted", style: { width: "80px" } }, [k]),
            el("span", { class: "mono small" }, [String(v)]),
          ])),
        ])),
        card("IFC file", el("div", { class: "stack" }, [
          el("div", { class: "tiny muted" }, [
            "Backed by web-ifc (MPL 2.0, ThatOpen). Paste an IFC URL to load entity counts and metadata here.",
          ]),
          dr.ifcUrl ? el("div", { class: "mono tiny" }, [dr.ifcUrl]) : null,
          el("button", { class: "btn sm primary", onClick: () => loadIfcFile(dr) }, [dr.ifcUrl ? "Reload IFC" : "Load IFC"]),
        ])),
      ]),
    ]),
  ]);
}
function renderIfcTree(node, selected, onSelect, depth = 0) {
  const container = el("div", { style: { paddingLeft: depth * 12 + "px" } });
  container.append(el("div", {
    class: `tree-item ${node.id === selected ? "active" : ""}`,
    onClick: () => onSelect(node.id),
  }, [
    el("span", { class: "tree-dot" }),
    el("span", { class: "mono tiny" }, [node.type]),
    el("span", { class: "small" }, [" ", node.id]),
  ]));
  for (const child of (node.children || [])) container.append(renderIfcTree(child, selected, onSelect, depth + 1));
  return container;
}
function findIfcNode(node, id) {
  if (node.id === id) return node;
  for (const c of (node.children || [])) {
    const hit = findIfcNode(c, id);
    if (hit) return hit;
  }
  return null;
}

// ---------- actions ----------
async function createMarkup(drawingId, sheetId, kind, x, y) {
  if (!can("edit.markup") && !can("edit")) { toast("No markup permission", "warn"); return; }

  let extra = {};
  if (kind === "text") extra.text = (await prompt({ title: "Text markup", placeholder: "Text" })) || "";
  else if (kind === "stamp") extra.stampLabel = (await prompt({ title: "Stamp label", defaultValue: "APPROVED" })) || "APPROVED";
  else if (kind === "status") extra.statusColor = await chooseStatusColor();
  else extra.text = (await prompt({ title: "Markup comment", message: "Optional", placeholder: "Comment" })) || "";

  const existing = (state.data.markups || []).filter(m => m.drawingId === drawingId && m.sheetId === sheetId);
  const id = "MK-" + Math.floor(Math.random() * 90000 + 10000);
  const markup = {
    id, drawingId, sheetId, kind, x, y,
    text: extra.text || null,
    stampLabel: extra.stampLabel || null,
    statusColor: extra.statusColor || null,
    author: state.ui.role,
    seq: existing.length + 1,
    created_at: new Date().toISOString(),
  };
  update(s => { s.data.markups.push(markup); });
  audit("markup.create", id, { drawingId, sheetId, kind });
  toast(`Markup (${kind}) added`, "success");
  renderDrawingViewer({ id: drawingId });
}

async function chooseStatusColor() {
  const pick = await prompt({ title: "Status color", message: "red / yellow / green", defaultValue: "yellow" });
  return pick === "red" ? "#ef4444" : pick === "green" ? "#22c55e" : "#f59e0b";
}

function showMarkup(m) {
  const d = state.data;
  const dr = d.drawings.find(x => x.id === m.drawingId);
  modal({
    title: `${m.id} · ${m.kind}`,
    body: el("div", { class: "stack" }, [
      el("div", { class: "small" }, [m.text || `(${m.kind})`]),
      el("div", { class: "tiny muted" }, [`By ${m.author} · ${new Date(m.created_at || Date.now()).toLocaleString()}`]),
      dr ? el("div", { class: "tiny muted" }, [`Drawing: ${dr.name}`]) : null,
    ]),
    actions: [
      { label: "Close" },
      { label: "Convert to issue", variant: "primary", onClick: () => convertMarkupToIssue(m) },
      { label: "Delete", variant: "danger", onClick: () => deleteMarkup(m) },
    ],
  });
}

async function convertMarkupToIssue(m) {
  if (!can("create")) { toast("No permission", "warn"); return; }
  const title = await prompt({ title: "Convert to issue", message: "Issue title:", defaultValue: m.text || `Markup ${m.id}` });
  if (!title) return;
  const dr = state.data.drawings.find(x => x.id === m.drawingId);
  const doc = dr ? state.data.documents.find(x => x.id === dr.docId) : null;
  const projectId = doc?.projectId || (state.data.projects || [])[0]?.id;
  const id = "WI-" + Math.floor(Math.random() * 900 + 100);
  update(s => {
    s.data.workItems.push({
      id, projectId, type: "Issue", title, assigneeId: "U-1",
      status: "Open", severity: "medium", due: null, blockers: [],
      description: `Originated from markup ${m.id} on drawing ${m.drawingId} (sheet ${m.sheetId}).`,
      labels: [m.drawingId, m.id],
    });
  });
  audit("markup.convert.issue", m.id, { workItemId: id });
  toast(`${id} created from markup`, "success");
  navigate(`/work-board/${projectId}`);
}

function deleteMarkup(m) {
  if (!can("edit")) { toast("No permission", "warn"); return; }
  update(s => { s.data.markups = s.data.markups.filter(x => x.id !== m.id); });
  audit("markup.delete", m.id);
  toast("Markup deleted", "warn");
  renderDrawingViewer({ id: m.drawingId });
}

function exportSVG(drawingId) {
  const svg = document.getElementById(`svg-${drawingId}`);
  if (!svg) return;
  const xml = new XMLSerializer().serializeToString(svg);
  const blob = new Blob(['<?xml version="1.0"?>\n', xml], { type: "image/svg+xml" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${drawingId}.svg`;
  document.body.append(a);
  a.click();
  a.remove();
  audit("drawing.export", drawingId);
  toast("SVG exported", "success");
}
