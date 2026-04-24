# Changelog

Notable changes to FORGE. See `docs/AUDIT_LOG.md` for the detailed
engineering log behind each change.

## Unreleased — Spec-compliance hardening

Work in progress on branch `cursor/forge-mvp-build-f2a3`.

### Added
- **Third-party OSS integration**: import map + dynamic loader in
  `src/core/vendor.js` pulling PDF.js, MiniSearch, Dexie, marked, DOMPurify,
  Mermaid, svg-pan-zoom, µPlot, MQTT.js, web-ifc, Fuse.js, date-fns, and
  RapiDoc from `esm.sh`. See `docs/THIRD_PARTY.md`.
- **PDF.js** rendering in doc viewer (Attach-PDF action).
- **web-ifc** lazy loading on drawing IFC tab.
- **MQTT.js** real broker client on the MQTT screen.
- **Mermaid** dependency graph on work board.
- **svg-pan-zoom** for the drawing viewer.
- **µPlot** sparklines on asset detail / UNS.
- **RapiDoc** pane embedded in the i3X explorer.
- **Fuse.js** fuzzy match in the command palette.
- `docs/ARCHITECTURE.md`, `docs/SPEC_COMPLIANCE.md`, `docs/AUDIT_LOG.md`
  covering every spec clause and every change.

### Changed
- `core/search.js`: MiniSearch is now the primary search engine; the
  previous hand-rolled BM25 is kept as fallback.
- `core/idb.js`: Dexie is now the primary IDB client; bare IDB is fallback.
- Channel messages render through `marked` + `DOMPurify` before being
  decorated with object-chip links.

## 0.2.0 — UNS + i3X 1.0-Beta compatibility

- Unified Namespace over ISA-95 with 4 namespaces, 12 ObjectTypes, 6
  RelationshipTypes, materialized from the FORGE asset seed.
- In-process i3X API engine covering Info/Explore/Query/Update/Subscribe
  primitives with the exact CESMII envelope and VQT shapes.
- `/uns` and `/i3x` screens wired into the rail and command palette.
- Asset Detail surfaces canonical UNS path + live variables rollup.

## 0.1.0 — FORGE MVP shell

- Reactive store with localStorage persistence + audit log.
- Hash router + permission model.
- Shell: rail, left panel, header, context panel, ops dock.
- 16 MVP screens implementing the spec's screen-by-screen UX.
