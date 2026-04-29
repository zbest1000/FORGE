// In-browser document editor (`/edit/:docId`).
//
// Backed by Univer (Apache-2.0, https://github.com/dream-num/univer)
// — the official Luckysheet successor and the only realistic
// browser-only editor for Office formats. We deliberately do NOT
// stand up a separate ONLYOFFICE / Collabora Docker service; see
// docs/OFFICE_VIEWERS.md for the architecture decision.
//
// Routing:
//   /edit/:docId          → auto-pick editor based on the doc's file
//                            extension (xlsx → Univer Sheets;
//                            docx/pptx → not yet wired, prompt to view).
//
// Save flow:
//   1. User clicks "Save".
//   2. We export the current Univer workbook to an .xlsx ArrayBuffer.
//   3. The buffer is wrapped in a Blob, registered as a new revision
//      on the document, and the user is redirected to the doc viewer
//      to see the new revision.
//
// Lazy-loading:
//   Univer is heavy (~2 MB gz for the sheets preset). We dynamically
//   import only when this route is hit, and only after the user has
//   opted into editing — the doc viewer's "Open" button still uses
//   the lightweight read-only viewer in src/core/office.js.

import { el, mount, card, badge, toast } from "../core/ui.js";
import { state, update, getById } from "../core/store.js";
import { audit } from "../core/audit.js";
import { navigate } from "../core/router.js";
import { vendor } from "../core/vendor.js";

export async function renderEdit({ id }) {
  const root = document.getElementById("screenContainer");
  const doc = getById("documents", id);
  if (!doc) {
    mount(root, el("div", { class: "muted" }, ["Document not found."]));
    return;
  }
  const rev = getById("revisions", doc.currentRevisionId);
  const ext = (doc.name?.split(".").pop() || rev?.blobName?.split(".").pop() || "").toLowerCase();

  if (ext !== "xlsx" && ext !== "xls") {
    mount(root, [
      card(`Editing ${doc.name}`, el("div", { class: "stack" }, [
        el("div", { class: "tiny muted" }, [
          "In-browser editing is currently wired up for Excel (.xlsx) only. ",
          "Word and PowerPoint editing are tracked as follow-ups in docs/OFFICE_VIEWERS.md ",
          "(both run on the same Univer engine via separate presets).",
        ]),
        el("div", { class: "row" }, [
          el("button", { class: "btn primary", onClick: () => navigate(`/doc/${doc.id}`) }, ["Open in viewer"]),
        ]),
      ])),
    ]);
    return;
  }

  // Build the editor shell first so the user sees something while
  // Univer is being downloaded.
  const editorHost = el("div", {
    id: "univer-host",
    style: { width: "100%", height: "75vh", background: "var(--surface)", borderRadius: "8px", border: "1px solid var(--border)", overflow: "hidden" },
  });
  const status = el("div", { class: "tiny muted" }, ["Loading Univer editor (Apache-2.0, ~2 MB)…"]);
  const saveBtn = el("button", { class: "btn primary", disabled: true }, ["Save"]);
  const cancelBtn = el("button", { class: "btn ghost", onClick: () => navigate(`/doc/${doc.id}`) }, ["Cancel"]);

  mount(root, [
    el("div", { class: "row spread", style: { marginBottom: "12px" } }, [
      el("div", {}, [
        el("h2", { style: { margin: 0, fontSize: "18px" } }, [`Editing — ${doc.name}`]),
        status,
      ]),
      el("div", { class: "row" }, [cancelBtn, saveBtn]),
    ]),
    editorHost,
  ]);

  // Now bring up Univer + load the workbook in parallel.
  let univerAPI = null;
  let workbookId = null;
  try {
    const xlsxLib = await vendor.xlsx();
    const presets = await vendor.univerPresets();

    // Fetch the existing xlsx blob (if any) so we can seed the editor
    // with the current revision's content.
    let workbookData = null;
    if (rev?.pdfUrl) {
      try {
        const buf = await fetch(rev.pdfUrl).then(r => r.arrayBuffer());
        // Convert xlsx → JSON via SheetJS first, then map to Univer's
        // workbook snapshot shape. This matches what Univer's xlsx
        // import plugin would produce, but lets us avoid pulling in
        // Univer's separate xlsx-import bundle for now.
        const wb = xlsxLib.read(buf, { type: "array" });
        workbookData = sheetjsToUniverSnapshot(wb, xlsxLib);
      } catch (e) {
        console.warn("[edit] could not load existing revision; starting blank", e);
      }
    }

    const { createUniver, defaultTheme, LocaleType, UniverSheetsCorePreset } = presets;
    const { univerAPI: api } = createUniver({
      locale: LocaleType.EN_US,
      locales: { [LocaleType.EN_US]: presets.sheetsCoreEnUS || {} },
      theme: defaultTheme,
      presets: [UniverSheetsCorePreset({ container: editorHost })],
    });
    univerAPI = api;

    const wb = workbookData
      ? api.createWorkbook(workbookData)
      : api.createWorkbook({ name: doc.name || "Untitled" });
    workbookId = wb.getId ? wb.getId() : wb.id;

    status.textContent = "";
    saveBtn.disabled = false;
  } catch (err) {
    console.error("[edit] Univer failed to initialise:", err);
    status.textContent = "Could not load the editor: " + (err?.message || err);
    status.className = "tiny callout danger";
    return;
  }

  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    status.textContent = "Saving…";
    status.className = "tiny muted";
    try {
      // Export Univer → xlsx ArrayBuffer via the same SheetJS wrapper.
      const xlsxLib = await vendor.xlsx();
      const wb = univerAPI.getActiveWorkbook ? univerAPI.getActiveWorkbook() : univerAPI.getWorkbook(workbookId);
      const sheetJsWb = univerSnapshotToSheetjs(wb, xlsxLib);
      const buf = xlsxLib.write(sheetJsWb, { bookType: "xlsx", type: "array" });
      const blob = new Blob([buf], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const url = URL.createObjectURL(blob);
      // Append a new Revision and update the document pointer.
      const newRevId = "REV-" + Math.random().toString(36).slice(2, 9).toUpperCase();
      const ts = new Date().toISOString();
      update(s => {
        const d = s.data.documents.find(x => x.id === doc.id);
        if (!d) return;
        const previousLabel = (d.revisionIds && d.revisionIds.length)
          ? String.fromCharCode("A".charCodeAt(0) + d.revisionIds.length)
          : "B";
        s.data.revisions.push({
          id: newRevId,
          docId: doc.id,
          label: previousLabel,
          status: "Draft",
          summary: "Edited in-browser via Univer",
          notes: `${blob.size} bytes`,
          pdfUrl: url,
          blobName: doc.name,
          blobType: blob.type,
          blobSize: blob.size,
          created_at: ts,
          updated_at: ts,
        });
        d.revisionIds = [...(d.revisionIds || []), newRevId];
        d.currentRevisionId = newRevId;
        d.updated_at = ts;
      });
      audit("document.edit.save", doc.id, { revId: newRevId, via: "univer" });
      toast(`Saved revision ${newRevId}`, "success");
      navigate(`/doc/${doc.id}`);
    } catch (err) {
      console.error("[edit] save failed:", err);
      status.textContent = "Save failed: " + (err?.message || err);
      status.className = "tiny callout danger";
      saveBtn.disabled = false;
    }
  });
}

// ---- xlsx ↔ Univer snapshot bridges ----
//
// Univer expects a `WorkbookData` snapshot (id + sheets keyed by id,
// each sheet has `cellData` keyed by row → col → ICellData). SheetJS
// gives us a much simpler structure (range + cell objects). Bridge
// the two so we can hand off without pulling in Univer's separate
// .xlsx import/export plugin (smaller bundle).

function sheetjsToUniverSnapshot(wb, XLSX) {
  const sheets = {};
  const sheetOrder = [];
  for (const name of wb.SheetNames) {
    const sheetId = "S-" + name.replace(/[^a-z0-9]/gi, "_");
    sheetOrder.push(sheetId);
    const ws = wb.Sheets[name];
    const range = XLSX.utils.decode_range(ws["!ref"] || "A1:A1");
    const cellData = {};
    for (let r = range.s.r; r <= range.e.r; r++) {
      for (let c = range.s.c; c <= range.e.c; c++) {
        const addr = XLSX.utils.encode_cell({ r, c });
        const cell = ws[addr];
        if (!cell) continue;
        cellData[r] = cellData[r] || {};
        cellData[r][c] = { v: cell.v, t: 1 };
      }
    }
    sheets[sheetId] = {
      id: sheetId,
      name,
      cellData,
      rowCount: range.e.r + 1,
      columnCount: range.e.c + 1,
    };
  }
  return {
    id: "WB-" + Date.now().toString(36),
    sheetOrder,
    sheets,
  };
}

function univerSnapshotToSheetjs(workbook, XLSX) {
  // Best-effort export: walk every sheet, collect cells, emit a
  // SheetJS workbook. Misses Univer-specific features (formula
  // bindings, conditional formatting, charts) — acceptable for a v1
  // round-trip. A later iteration can use Univer's native xlsx export
  // plugin once we accept its bundle weight.
  const out = XLSX.utils.book_new();
  const snapshot = workbook.save ? workbook.save() : workbook.getSnapshot?.();
  if (!snapshot) return out;
  for (const sheetId of snapshot.sheetOrder || []) {
    const sheet = snapshot.sheets[sheetId];
    if (!sheet) continue;
    const aoa = [];
    const cells = sheet.cellData || {};
    const maxRow = sheet.rowCount || 0;
    const maxCol = sheet.columnCount || 0;
    for (let r = 0; r < maxRow; r++) {
      const row = [];
      for (let c = 0; c < maxCol; c++) {
        const cell = cells[r] && cells[r][c];
        row.push(cell ? cell.v : null);
      }
      aoa.push(row);
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    XLSX.utils.book_append_sheet(out, ws, sheet.name || sheetId);
  }
  return out;
}
