# Office viewers — architecture decision

## Goal

Browser-side viewing (and eventually editing) of Word / Excel / PowerPoint files **without** running a separate document-server container.

The pattern we are explicitly NOT adopting:

> ONLYOFFICE Document Server / Collabora Online — both ship as ~5 GB Docker services, mount user files into a sandboxed Office runtime, and inject an `<iframe>` into the host app. Powerful, but the operational overhead (container, healthcheck, certs, version pinning, file-mount permissions) is heavier than the rest of FORGE combined for what is, today, a viewing requirement.

## Decision

**Two-tier strategy, one tier per use case.**

### Tier 1 — Viewing (in this repo, today)

Embedded browser libraries that render Office formats directly in the SPA. Each is lazy-loaded so the eager bundle doesn't pay for them until a user actually opens a Word/Excel file.

| Format | Library | npm | License | Approx. gz size | Status |
|---|---|---|---|---|---|
| `.docx` (Word) | [docx-preview](https://github.com/VolodymyrBaydalka/docxjs) | `docx-preview` | Apache-2.0 | ~70 KB gz | **Wired** in `src/core/office.js → renderDocx`. Renders fonts, tables, images, lists, headers/footers. |
| `.xlsx` (Excel) | [SheetJS Community](https://docs.sheetjs.com/) | `xlsx` (CDN tarball) | Apache-2.0 | ~150 KB gz | **Wired** in `src/core/office.js → renderXlsx`. Sheet tabs, table render. |
| `.pptx` (PowerPoint) | (placeholder) | — | — | — | Not built. We show a "use the download button" message; full preview deferred to Tier 2. |
| `.doc` / `.xls` (legacy) | server-side convert (LibreOffice headless or mammoth + tika) | — | — | — | Not built. The detector flags `needsServerConvert` so we know it can't be browser-rendered as-is. |

### Tier 2 — Editing (recommended path, not yet integrated)

[**Univer**](https://github.com/dream-num/univer) (Apache-2.0) — the official successor to Luckysheet (which is now archived and redirects to Univer). The only realistic browser-side editor for `.xlsx`, `.docx`, and `.pptx` simultaneously, with collaborative editing via OT, conditional formatting, formulas, and pivot tables. **No separate Docker service.**

- Modular presets: `@univerjs/preset-sheets-core`, `@univerjs/preset-docs-core`, `@univerjs/preset-slides-core` — load only what's needed per route.
- Bundle weight: ~1.5–3 MB gz **per preset**. Heavy by browser standards but the modular split lets us avoid loading editing code for users who only view documents.
- Integration shape: each preset is mounted into a host element and accepts a workbook/document/slidedeck JSON; converters from `.xlsx`/`.docx`/`.pptx` are first-party.

**Why we haven't integrated Univer yet:** it's a large addition that needs its own integration pass — license/mount UI, save-back path, conflict resolution with our revision/approval state machine. Tracked as a follow-up.

## Alternatives we evaluated and rejected

| Option | Why rejected |
|---|---|
| **ONLYOFFICE Document Server** | Separate ~5 GB Docker; opposite of the goal. |
| **Collabora Online** | Same as ONLYOFFICE — separate Docker service. |
| **Luckysheet** | Archived in October 2025; the maintainers explicitly redirect to Univer. |
| **Handsontable** | Free tier requires a non-commercial license — fails the permissive-OSS bar. |
| **mammoth.js (Word → HTML, BSD)** | Works for read-only Word but loses some formatting (advanced tables, headers/footers, page boundaries). docx-preview gives higher fidelity at similar size. We can add mammoth as a fallback later. |
| **Apryse / Nutrient WebViewer** | Proprietary, paid. |

## DWG (binary AutoCAD format)

Separate from Office formats but adjacent. We currently route DWG via `server/cad/convert` (LibreDWG → DXF → `dxf-viewer`). Browser-side alternative tracked:

- [**mlightcad/cad-viewer**](https://github.com/mlightcad/cad-viewer) — TypeScript, renders DWG/DXF directly in the browser via a WASM converter. Adding it would make DWG viewing work even when the server's LibreDWG converter isn't installed. Substantial library (~1 MB gz) so it should chunk-split like the other heavy viewers; integration deferred until we feel the pain of the server-convert dependency.

## Editing roadmap

If editing becomes a concrete user need, the recommended sequence:

1. Pick which formats actually need editing (most teams need Excel only — Word is overwhelmingly view + comment).
2. Add Univer as a lazy chunk on a new `/edit/:docId` route. Don't try to swap the viewer in-place; the editor is a separate UX.
3. Wire Univer's save callback to our revision pipeline: each save creates a new `Revision` row attached to the original `Document`, with the user's saved blob as the new `pdfUrl`/source.
4. Disable Univer's collaborative-OT layer until our backend has CRDT-ish persistence — until then, last-writer-wins per save is the safe default.
5. Keep the embedded viewers in this PR as the read path. Only the `Edit` button on a document detail page should pull Univer's chunk.
