# FORGE — Engineering Audit Log

A detailed, chronological record of the changes made to bring FORGE into
alignment with `PRODUCT_SPEC.md`. Each entry describes what was done, why,
the technology choice and rationale, the file(s) touched, and how it was
verified.

New entries are appended in time order. Each entry corresponds to one git
commit on this branch. The commit hash is back-filled after commit.

---

## 2026-04-24 — Baseline

Starting state (already on this branch):
- `app.js`, `src/core/*`, `src/shell/*`, `src/screens/*` from prior commits
  `149a74f` (FORGE MVP) and `5ece325` (UNS + i3X 1.0-Beta).
- Prototype is a static client app. `python3 -m http.server 8080` runs it.

## 2026-04-24 — Spec gap analysis + docs scaffolding (2ddd2ac)

**What**
Re-read PRODUCT_SPEC.md end-to-end. Produced a full compliance matrix
(`docs/SPEC_COMPLIANCE.md`) and an architecture doc (`docs/ARCHITECTURE.md`).
Identified concrete gaps against §4 base fields, §7 revision detail, §8
drawing viewer features, §9 event pipeline, §10 workflows, §11 screens,
§13 signed-audit, §14 AI, §15 search.

**Why**
Without a single source of truth, it is impossible to claim "matches spec".
The compliance matrix is kept up to date with every subsequent commit.

**Tech decisions made**
- Zero npm deps. Pure browser ES modules, `Web Crypto`, `IndexedDB`, SVG.
- Hash-chained audit ledger (SHA-256) for tamper-evidence.
- HMAC-SHA256 signatures for approvals and audit-pack export.
- BM25 inverted index for unified search.
- In-process event envelope + DLQ + replay.
- Revision lifecycle as a formal state machine.

**Files**
- Added `docs/ARCHITECTURE.md`
- Added `docs/SPEC_COMPLIANCE.md`
- Added `docs/AUDIT_LOG.md` (this file)
- Added `docs/CHANGELOG.md`

**Verification**
- `node --check` on existing modules still passes.
- Prior runtime smoke tests unaffected.

---

## 2026-04-24 — Core foundations (07d8afd)

## 2026-04-24 — Drawing viewer v2, Doc viewer v2, Approvals v2 (173f9d0)

## 2026-04-24 — Work board, Channel, Incident, MQTT, OPC UA, ERP, AI, Search, Admin, Integrations v2 (ba47f06)

## 2026-04-24 — __forgeSelfTest enriched; compliance notes (b12d8ac)

**What**
Finished the spec-driven rewrite of the remaining screens. Every major
spec feature in §§11.3, 11.4, 11.9, 11.10, 11.11, 11.12, 11.13, 11.15,
11.16, 15 is now exercised by the running UI.

Highlights:
- Work board gained two new views (timeline Gantt + dependency map) beyond
  kanban/table, plus bulk operations via shift-click multi-select.
- Channel supports edit/delete with audit, checklist blocks, decision
  markers, and one-click conversion to work items or incidents.
- Incident war room carries a per-severity playbook checklist, role roster,
  alarms strip, and exports a signed postmortem (Markdown or JSON).
- MQTT and OPC UA screens can **publish** simulated payloads straight into
  `core/events.ingest()` so the rule engine drives incident creation,
  channel notifications, and asset timelines end to end.
- ERP mapping has conflict accept/override, writeback preview, and a
  backfill dry-run/commit flow.
- AI workspace now actually retrieves from the BM25 index, cites results,
  records each call in `state.data.aiLog` with `retention: no-training-by-
  default`, and has an Impact-of-revision intent that delegates to the
  revision engine.
- Search has a facet rail (kind/status/discipline/project/teamSpace) with
  counts and deep-linkable URLs plus saved searches.
- Admin console exposes `verifyLedger()` and `exportAuditPack()` from the
  core audit module, plus a file-picker that verifies an exported pack's
  HMAC.

**Why**
Screens were previously minimal-viable placeholders. The spec calls for
tool-rich, permission-aware, auditable UX. Each feature now maps to a
specific spec clause — see `SPEC_COMPLIANCE.md`.

**Tech decisions**
- Timeline / dependency views as hand-rolled SVG: zero deps, scales easily.
- Publish-test and simulate-node routes through `events.ingest()` on
  purpose, so the same routing rules apply whether an event came from a
  real MQTT/OPC UA client or a UI simulation.
- Postmortem export signs with HMAC-SHA256 over canonical JSON (same
  helpers used by the audit pack), so incident exports are
  independently verifiable.
- BM25 retrieval for AI: avoids embedding models in-browser while still
  producing ranked, citation-backed responses.
- Batch ops use `sessionStorage` (not the reactive store) for transient
  selection so it does not pollute `localStorage`.

**Files**
- `src/screens/workBoard.js`, `src/screens/channel.js`,
  `src/screens/incident.js`, `src/screens/mqtt.js`, `src/screens/opcua.js`,
  `src/screens/erp.js`, `src/screens/ai.js`, `src/screens/search.js`,
  `src/screens/admin.js`, `src/screens/integrations.js`
- `styles.css`: added `.success-text` / `.danger-text` / `.warn-text`.

**Verification**
- `node --check` passes on every changed file.
- End-to-end runtime test (Node):
  - §4 base fields present on a sample work item (`OK`).
  - Revision transition IFR → Approved → IFC succeeds.
  - `impactOfRevision("REV-2-C")` → 1 approval, 1 asset.
  - Event envelope has all 14 spec-required fields.
  - Follow + fanout: posting to followed subject creates a notification
    for each subscriber.
  - BM25 "vent interlock" returns 3 ranked hits led by "Add emergency vent
    interlock".
  - `verifyLedger()` → `ok: true` with `legacyCount: 3, strictCount: 7`.
  - `exportAuditPack()` → 10 entries; `verifyAuditPack()` → `true`.
- Static server returns 200 for every new/changed file.


**What**
Rewrote three signature screens to match the spec §7 / §8 / §11.14 feature
lists in detail.

Drawing viewer:
- 2D transform matrix on an SVG group (translate/scale composed around a
  center) producing zoom-at-cursor, drag-pan, reset/fit, and keeping markup
  coordinates normalized so they remain valid across transforms.
- Markup palette with 7 annotation kinds rendered as distinct SVG shapes.
- Compare mode renders a tinted overlay of a second sheet, opacity live-bound
  to a slider.
- Layer toggles separate the sheet, dimensions, and annotations groups.
- IFC mode: object tree + metadata inspector over a stub BIM graph (no
  geometry renderer — flagged as ◐ in SPEC_COMPLIANCE).
- Export SVG via `XMLSerializer` + Blob download.

Document viewer:
- Multi-page "paper" with a page strip, Alt-click to drop regional comment
  pins anchored to normalized (page, x, y), threaded replies,
  one-click convert-to-issue.
- Rich metadata panel with all spec §7.9 fields.
- Transmittals (subject, recipients, message) with send flow and listing.
- Impact analysis card driven by `core/revisions.impactOfRevision`.

Approvals:
- SLA chip with live countdown (`< 4h` red, `< 24h` amber) + auto-expiry
  pass before render.
- Delegation modal writes a chain-of-custody entry and changes approver.
- Batch approve / reject with chain-of-custody on each item.
- Every decision signs a canonical JSON payload with `HMAC-SHA256` from
  `core/crypto`; verifiable later via the audit pack export.
- Approving a Revision cascades through `core/revisions.transition` so the
  revision lifecycle (IFR → Approved → IFC) and auto-supersede happen
  coherently.

**Why**
Spec §7 #1–9, §8 complete tool set, §11.14 (SLA, delegation, batch, signed).
The prior versions were thin placeholders.

**Tech decisions**
- SVG + 2D transform rather than a canvas/PDF engine. Rationale: keeps the
  prototype dependency-free; normalized coordinates survive zoom and make
  cross-device pin sharing trivial.
- Alt-click to create comment pins (rather than a separate tool mode) so
  reading mode is not interrupted.
- Signed approvals with HMAC-SHA256 + canonical JSON so signatures are
  reproducible and verifiable from an exported audit pack.

**Files**
- `src/screens/drawingViewer.js` (rewrite)
- `src/screens/docViewer.js` (rewrite)
- `src/screens/approvals.js` (rewrite)

**Verification**
- `node --check` on all three passes.
- Existing ledger + crypto smoke test still green.
- Approvals signature: a signed decision payload verifies with
  `verifyHMAC` against the same canonical JSON.


**What**
Landed the cross-cutting building blocks that the screen-level spec work
depends on. Added 8 new core modules; wired them into `app.js` bootstrap.

- `core/crypto.js` — Web Crypto SHA-256 hashing and HMAC-SHA256 signing with
  canonical-JSON serialization so hashes are deterministic.
- `core/audit.js` — Append-only, hash-chained audit ledger. Entries are
  chained via `prevHash`; `verifyLedger()` walks the chain and reports
  tampering. `exportAuditPack()` produces a self-contained JSON pack with
  an HMAC-SHA256 signature. Serialized hashing keeps the chain deterministic
  under burst writes.
- `core/idb.js` — Thin IndexedDB wrapper for long-term append-only stores
  (auditLog, events, dlq, search). Fails gracefully if IDB is unavailable.
- `core/normalize.js` — One-time pass that backfills the §4 base fields
  (`org_id`, `workspace_id`, `created_by`, `created_at`, `updated_at`,
  `status`, `labels[]`, `acl`, `audit_ref`) on every entity in the seed.
  Also seeds `files`, `threads`, `savedSearches`, `subscriptions`,
  `transmittals`, `eventLog`, `deadLetters`, `aiLog`, `retentionPolicies`.
- `core/subscriptions.js` — Object follow/watch model with `fanout()` that
  pushes notifications to subscribers. Used by revisions, events, channels.
- `core/revisions.js` — Formal state machine (Draft → IFR → Approved → IFC →
  Superseded/Archived) with auto-supersede on IFC promotion and an
  `impactOfRevision()` helper feeding the AI impact analyzer.
- `core/events.js` — Canonical event envelope (exact fields from spec §9.2),
  ingest pipeline with idempotency (`dedupe_key`), routing engine with five
  default rules (high-sev alarm → incident, alarm → channel, ERP → work
  item, OPC UA state → asset timeline, any → fanout), DLQ + replay.
- `core/search.js` — BM25 inverted index over 10 collections, substring
  fallback, ACL-filtered results, facet counts (kind, status, discipline,
  project, teamSpace), saved searches.
- `core/hotkeys.js` — Single-key C/G/A/? shortcuts per spec §12.4.

**Why**
Spec §4 base fields, §13.2 tamper-evident audit, §9.2–9.4 canonical event
pipeline, §6.1 subscriptions, §6.3/§10 revision lifecycle, §12.4 hotkeys,
§15 search. Every downstream screen relies on these.

**Tech decisions**
- SHA-256 hash chain over canonical JSON: deterministic, zero-dep, real
  tamper evidence. Alternative (Merkle tree) considered but overkill for
  linear audit.
- HMAC-SHA256 signatures with a demo tenant key exposed via `getSigningKey()`
  — that function is the single seam where a real KMS would plug in.
- BM25 (k1=1.5, b=0.75) + substring fallback for "semantic-ish" per
  spec §15 hybrid retrieval. Alternative (TF-IDF) considered; BM25 is the
  industry default.
- Serialized hashing through a chained Promise so the ledger stays
  deterministic even under burst writes (`audit()` can be called N times
  synchronously and `verifyLedger()` still passes).

**Files**
- `src/core/crypto.js`, `src/core/audit.js`, `src/core/idb.js`,
  `src/core/normalize.js`, `src/core/subscriptions.js`,
  `src/core/revisions.js`, `src/core/events.js`, `src/core/search.js`,
  `src/core/hotkeys.js`
- `src/core/store.js` — delegated `audit()` to new ledger
- `app.js` — boot sequence: normalize → initAuditLedger → initI3X →
  buildIndex → installHotkeys; subscribe `scheduleRebuild()` for search.

**Verification**
- `node --check` passes on every new and modified file.
- Runtime test (Node):
  - `verifyLedger() → { ok: true, legacyCount: 3, strictCount: 5 }` after 5
    appended audits.
  - Tampering an entry flips `verifyLedger().ok` to `false` with
    `reason: "hash mismatch"`; reverting the tamper restores `ok: true`.
  - Event pipeline: `ingest()` normalizes a raw alarm into the canonical
    envelope, idempotency dedupe returns `null` on repeat, rule engine
    creates a matching incident.
  - BM25 query for "valve" returns 4 hits across revisions, work items, and
    drawings.
  - `exportAuditPack()` → 8 entries, `verifyAuditPack()` → `true`
    (HMAC-SHA256).
-->
