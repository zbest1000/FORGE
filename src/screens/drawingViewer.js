import { el, mount, card, badge, toast } from "../core/ui.js";
import { state, update, getById, audit } from "../core/store.js";
import { navigate } from "../core/router.js";
import { can } from "../core/permissions.js";

export function renderDrawingsIndex() {
  const root = document.getElementById("screenContainer");
  const d = state.data;
  mount(root, [
    card("Drawings", el("div", { class: "card-grid" }, (d.drawings || []).map(dr => {
      const nMarkups = (d.markups || []).filter(m => m.drawingId === dr.id).length;
      return card(dr.name, el("div", { class: "stack" }, [
        el("div", { class: "tiny muted" }, [`${dr.sheets.length} sheets · discipline ${dr.discipline}`]),
        el("div", { class: "row wrap" }, [
          badge(`${nMarkups} markups`, "info"),
        ]),
      ]), { actions: [el("button", { class: "btn sm primary", onClick: () => navigate(`/drawing/${dr.id}`) }, ["Open"])] });
    }))),
  ]);
}

export function renderDrawingViewer({ id }) {
  const root = document.getElementById("screenContainer");
  const dr = getById("drawings", id);
  if (!dr) return mount(root, el("div", { class: "muted" }, ["Drawing not found."]));

  const activeSheetKey = `drawing.sheet.${id}`;
  const activeSheetId = sessionStorage.getItem(activeSheetKey) || dr.sheets[0].id;
  const markups = (state.data.markups || []).filter(m => m.drawingId === id && m.sheetId === activeSheetId);

  const markupMode = sessionStorage.getItem("drawing.markupMode") === "1";

  mount(root, [
    el("div", { class: "viewer-layout" }, [
      el("div", { class: "viewer-canvas" }, [
        el("div", { class: "viewer-toolbar" }, [
          ...dr.sheets.map(s => el("button", {
            class: `btn sm ${s.id === activeSheetId ? "primary" : ""}`,
            onClick: () => { sessionStorage.setItem(activeSheetKey, s.id); renderDrawingViewer({ id }); },
          }, [s.label])),
          el("span", { style: { flex: 1 } }),
          el("button", {
            class: `btn sm ${markupMode ? "primary" : ""}`,
            disabled: !can("edit.markup") && !can("edit"),
            onClick: () => {
              sessionStorage.setItem("drawing.markupMode", markupMode ? "0" : "1");
              renderDrawingViewer({ id });
            },
          }, [markupMode ? "✍ Markup ON" : "✍ Markup OFF"]),
          el("button", { class: "btn sm" }, ["⇆ Compare"]),
        ]),
        el("div", {
          class: "viewer-page",
          onClick: (e) => {
            if (!markupMode) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const x = (e.clientX - rect.left) / rect.width;
            const y = (e.clientY - rect.top) / rect.height;
            if (x < 0.05 || x > 0.95 || y < 0.05 || y > 0.95) return;
            addMarkup(id, activeSheetId, x, y);
          },
        }, [
          el("div", { class: "paper", style: { cursor: markupMode ? "crosshair" : "default" } }, [
            sheetSvg(dr, activeSheetId),
            ...markups.map((m, i) => el("div", {
              class: "markup-pin",
              style: { left: (m.x * 100) + "%", top: (m.y * 100) + "%" },
              title: m.text,
              onClick: (e) => { e.stopPropagation(); showMarkup(m); },
            }, [String(i + 1)])),
          ]),
        ]),
      ]),
      el("div", { class: "viewer-side" }, [
        card(`Markups (${markups.length})`, markupList(markups)),
        card("Cross-links", el("div", { class: "stack" }, [
          chipRow("Document", dr.docId, `/doc/${dr.docId}`),
          el("div", { class: "tiny muted" }, ["Linked tasks, assets, and threads."]),
        ])),
        card("AI", el("div", { class: "stack" }, [
          el("div", { class: "small muted" }, ["Cluster of markups around upper-right quadrant. Most reference valve sizing."]),
          el("button", { class: "btn sm", onClick: () => navigate(`/ai?drawing=${id}`) }, ["Open AI →"]),
        ])),
      ]),
    ]),
  ]);
}

function sheetSvg(dr, sheetId) {
  // Procedural SVG content pretending to be a sheet.
  const seed = (dr.id + sheetId).split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  const lines = [];
  for (let i = 0; i < 30; i++) {
    const x1 = (i * 37 + seed) % 100;
    const y1 = (i * 53 + seed) % 100;
    const x2 = (x1 + 15 + (i % 6)) % 100;
    const y2 = (y1 + 10 + (i % 5)) % 100;
    lines.push(`<line x1="${x1}%" y1="${y1}%" x2="${x2}%" y2="${y2}%" stroke="#64748b" stroke-width="1" />`);
  }
  for (let i = 0; i < 8; i++) {
    const cx = ((i * 97 + seed) % 90) + 5;
    const cy = ((i * 41 + seed) % 90) + 5;
    lines.push(`<circle cx="${cx}%" cy="${cy}%" r="14" fill="none" stroke="#0f172a" stroke-width="1.2" />`);
    lines.push(`<text x="${cx}%" y="${cy + 1}%" dy="0.35em" text-anchor="middle" font-size="9" fill="#0f172a">V-${10+i}</text>`);
  }
  const svg = el("svg", { class: "drawing-svg", viewBox: "0 0 100 100", preserveAspectRatio: "none" });
  svg.innerHTML = lines.join("");
  return svg;
}

function chipRow(label, id, route) {
  return el("div", { class: "row" }, [
    el("span", { class: "tiny muted" }, [label, ":"]),
    el("span", { class: "chip clickable", onClick: () => navigate(route) }, [id]),
  ]);
}

function markupList(markups) {
  if (!markups.length) return el("div", { class: "muted tiny" }, ["No markups on this sheet."]);
  return el("div", { class: "stack" }, markups.map((m, i) => el("div", { class: "activity-row" }, [
    el("span", { class: "ts" }, [String(i + 1)]),
    el("span", { class: "small" }, [m.text]),
    el("span", { class: "tiny muted" }, [m.author || ""]),
  ])));
}

function addMarkup(drawingId, sheetId, x, y) {
  if (!can("edit.markup") && !can("edit")) { toast("No markup permission", "warn"); return; }
  const text = window.prompt("Markup comment:");
  if (!text) return;
  const id = "MK-" + Math.floor(Math.random()*9000+1000);
  update(s => {
    s.data.markups.push({ id, drawingId, sheetId, x, y, text, author: s.ui.role });
  });
  audit("markup.create", id, { drawingId, sheetId });
  toast("Markup added", "success");
}

function showMarkup(m) {
  alert(`Markup ${m.id}\nBy: ${m.author}\n\n${m.text}`);
}
