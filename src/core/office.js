// Office document viewers (Word + Excel + minimal PowerPoint).
//
// View-only rendering via small browser-side libraries — no separate
// document server required (the explicit goal: replace the ONLYOFFICE
// Document Server pattern, which needs ~5 GB Docker, with embedded
// libraries that ship in the SPA bundle).
//
//   - .docx → docx-preview (Apache-2.0, ~250 KB) renders with formatting
//             (fonts, tables, images, lists) into HTML/CSS.
//   - .xlsx / .xls → xlsx aka SheetJS Community (Apache-2.0, ~500 KB)
//             parses the workbook; we render each sheet as an HTML
//             table with sheet-name tabs.
//   - .pptx → not rendered here. The recommended path is Univer
//             (Apache-2.0, https://github.com/dream-num/univer) which
//             is the official Luckysheet successor and the only
//             realistic browser-side editor for Office formats.
//             See docs/OFFICE_VIEWERS.md.
//
// Each function takes a host element and a Blob/ArrayBuffer/URL,
// returns a teardown function that cleans up.

import { vendor } from "./vendor.js";

function statusLine(text, variant = "info") {
  const e = document.createElement("div");
  e.className = `tiny ${variant === "danger" ? "callout danger" : "muted"}`;
  e.textContent = text;
  e.style.padding = "8px 12px";
  return e;
}

async function fetchAsArrayBuffer(source) {
  if (source instanceof ArrayBuffer) return source;
  if (source instanceof Blob) return source.arrayBuffer();
  if (typeof source === "string") {
    const r = await fetch(source);
    if (!r.ok) throw new Error(`fetch ${source}: ${r.status}`);
    return r.arrayBuffer();
  }
  throw new Error("renderDocx/renderXlsx need ArrayBuffer | Blob | URL");
}

/**
 * Render a .docx into `host`. Lazy-imports docx-preview the first time
 * so the SPA's eager bundle stays small. Falls back to a download link
 * if the library fails to load (offline / CSP / etc.).
 */
export async function renderDocx(host, source, { name } = {}) {
  if (!host) return () => {};
  host.innerHTML = "";
  const status = statusLine(`Loading ${name || "document"}…`);
  host.append(status);
  try {
    const buf = await fetchAsArrayBuffer(source);
    const dp = await vendor.docxPreview();
    const renderer = dp.renderAsync || dp.default?.renderAsync || dp;
    if (typeof renderer !== "function") throw new Error("docx-preview missing renderAsync");
    status.remove();
    const wrap = document.createElement("div");
    wrap.className = "docx-render";
    host.append(wrap);
    await renderer(buf, wrap, null, {
      ignoreWidth: false,
      ignoreHeight: false,
      ignoreFonts: false,
      breakPages: true,
      renderHeaders: true,
      renderFooters: true,
      inWrapper: true,
      className: "docx",
    });
    return () => { wrap.remove(); };
  } catch (err) {
    status.remove();
    host.append(statusLine(`Could not render Word document: ${err.message || err}`, "danger"));
    return () => {};
  }
}

/**
 * Render an .xlsx workbook into `host`. Each sheet becomes an HTML
 * table; a tab strip switches between sheets. Lazy-imports SheetJS.
 */
export async function renderXlsx(host, source, { name } = {}) {
  if (!host) return () => {};
  host.innerHTML = "";
  const status = statusLine(`Loading ${name || "spreadsheet"}…`);
  host.append(status);
  try {
    const buf = await fetchAsArrayBuffer(source);
    const XLSX = await vendor.xlsx();
    const wb = XLSX.read(buf, { type: "array" });
    status.remove();

    const tabBar = document.createElement("div");
    tabBar.className = "row wrap xlsx-tabs";
    tabBar.style.gap = "4px";
    tabBar.style.marginBottom = "8px";
    const sheetHost = document.createElement("div");
    sheetHost.className = "xlsx-sheet";

    const renderSheet = (name) => {
      const ws = wb.Sheets[name];
      const html = XLSX.utils.sheet_to_html(ws, { editable: false, header: "" });
      sheetHost.innerHTML = html;
      const t = sheetHost.querySelector("table");
      if (t) {
        t.classList.add("table");
        t.style.minWidth = "100%";
      }
      // Highlight the active tab
      tabBar.querySelectorAll("button").forEach(b => {
        b.classList.toggle("primary", b.dataset.sheet === name);
      });
    };

    wb.SheetNames.forEach((sheetName, i) => {
      const btn = document.createElement("button");
      btn.className = "btn xs" + (i === 0 ? " primary" : "");
      btn.textContent = sheetName;
      btn.dataset.sheet = sheetName;
      btn.addEventListener("click", () => renderSheet(sheetName));
      tabBar.append(btn);
    });
    host.append(tabBar);
    host.append(sheetHost);
    if (wb.SheetNames.length) renderSheet(wb.SheetNames[0]);

    return () => { tabBar.remove(); sheetHost.remove(); };
  } catch (err) {
    status.remove();
    host.append(statusLine(`Could not render Excel: ${err.message || err}`, "danger"));
    return () => {};
  }
}

/**
 * .pptx placeholder. Real rendering is deferred to the Univer
 * integration; for now we show a friendly message + download link.
 * Returning a teardown so the host can swap renderers cleanly.
 */
export async function renderPptx(host, source, { name } = {}) {
  if (!host) return () => {};
  host.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "stack";
  wrap.style.padding = "20px";
  wrap.append(statusLine(`PowerPoint preview is not yet built into the embedded viewer. Use the download button to open ${name || "this file"} in your slide editor.`, "info"));
  host.append(wrap);
  return () => { wrap.remove(); };
}
