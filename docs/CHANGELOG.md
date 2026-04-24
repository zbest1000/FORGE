# Changelog

Notable changes to FORGE. See `docs/AUDIT_LOG.md` for the detailed
engineering log behind each change.

## Unreleased — Spec-compliance hardening

Work in progress on branch `cursor/forge-mvp-build-f2a3`.

### Added
- `docs/ARCHITECTURE.md`, `docs/SPEC_COMPLIANCE.md`, `docs/AUDIT_LOG.md`
  covering every spec clause and every change.

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
