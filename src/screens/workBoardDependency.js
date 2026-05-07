// Dependency-graph view, extracted from workBoard.js (Phase 4
// decomposition). Two renderers: a Mermaid flowchart for the primary
// view, and a hand-rolled SVG fallback so this works offline / without
// the mermaid bundle.
//
// Used by both the per-project board and the consolidated /work view
// — the `_scope` parameter is reserved for future per-scope behaviour
// (e.g. cross-project edges in /work) but is currently unused.

import { el, card } from "../core/ui.js";
import { renderMermaid } from "../core/mermaid.js";
import { COLUMNS, openItem } from "./workBoardItem.js";

/**
 * @param {any[]} items
 * @param {{ id: string, rerender: () => void }} [_scope]
 */
export function dependencyView(items, _scope) {
  // Mermaid flowchart built from the blocked-by graph. Falls back to a
  // hand-rolled SVG below.
  const lines = ["flowchart LR"];
  const safe = (/** @type {string} */ id) => id.replace(/[^A-Za-z0-9_]/g, "_");
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
    el("div", { class: "tiny muted" },
      ["Rendered with mermaid-js (MIT). Falls back to in-repo SVG if offline."]),
    dependencyViewSvg(items),
  ]), { subtitle: "Red = high/critical severity. Arrows = blocked-by." });
}

function dependencyViewSvg(items) {
  // Force-free layout: position nodes by status column + order.
  /** @type {{ [k: string]: any[] }} */
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

  // Draw dependency edges first so node circles paint on top.
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
    circle.setAttribute("cx", String(c.x)); circle.setAttribute("cy", String(c.y)); circle.setAttribute("r", "14");
    const fill = w.severity === "high" || w.severity === "critical" ? "#ef4444"
      : w.severity === "medium" ? "#f59e0b"
      : "#38bdf8";
    circle.setAttribute("fill", fill);
    g.append(circle);
    const txt = document.createElementNS(NS, "text");
    txt.setAttribute("x", String(c.x)); txt.setAttribute("y", String(c.y - 20));
    txt.setAttribute("text-anchor", "middle"); txt.setAttribute("font-size", "10"); txt.setAttribute("fill", "var(--text)");
    txt.textContent = w.id;
    g.append(txt);
    svg.append(g);
  }

  // Column headers.
  cols.forEach((c, ci) => {
    const t = document.createElementNS(NS, "text");
    t.setAttribute("x", String(colW * ci + colW / 2)); t.setAttribute("y", "20");
    t.setAttribute("text-anchor", "middle"); t.setAttribute("font-size", "12"); t.setAttribute("fill", "var(--muted)");
    t.textContent = c;
    svg.append(t);
  });

  return el("div", { class: "stack" }, [
    el("div", { class: "tiny muted" }, ["Hand-rolled SVG fallback (always available):"]),
    svg,
  ]);
}
