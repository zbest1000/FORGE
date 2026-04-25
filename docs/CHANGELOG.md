# Changelog

Notable changes to FORGE. See `docs/AUDIT_LOG.md` for the detailed
engineering log behind each change.

## 0.6.0 — Major CAD format support (DWG / DXF / STEP / IGES / STL / glTF / IFC / …)

### Added
- `src/core/cad.js` — central CAD format detector (URL, MIME, extension)
  covering: PDF · DXF · DWG · SVG · PNG · JPEG · CSV · STEP · IGES ·
  STL · OBJ · glTF (.gltf, .glb) · 3DM (Rhino) · 3DS · 3MF · FBX · DAE
  (Collada) · PLY · OFF · VRML · BREP · IFC.
- `src/core/cad-viewer.js` — single-seam unified renderer:
  - **dxf-viewer** (MIT) for DXF;
  - **Online3DViewer** (MIT, wraps three.js + occt-import-js) for the
    full 3D family;
  - Server-side **LibreDWG** `dwg2dxf` (GPL-3.0, deployed-service
    exception) for DWG, then dxf-viewer renders the DXF.
- `server/converters/dwg.js` — subprocess wrapper with SHA-256 caching.
- `server/routes/cad.js` — `/api/cad/info`, `/api/cad/info/:fileId`,
  `/api/cad/convert/:fileId?to=dxf`, `/api/cad/convert?url=…`,
  `/api/cad/converted/:hash.dxf` (immutable cache).
- Drawing viewer: **Load CAD…** action accepts any supported format and
  routes through the unified viewer.
- Doc viewer: revision asset URLs that point at CAD files render in the
  CAD viewer; PDF/image/CSV continue on their existing renderers.
- Dockerfile installs `libredwg-tools` so DWG works out of the box in
  `docker compose up`.

### Tests
- 10 new tests in `test/cad.test.js` (kind detection by URL / MIME,
  3D family coverage, DWG flag, ext stripping, accept-attr generation,
  converter argument validation, route-name regex hardening). 41/41
  passing.

## 0.5.2 — xstate FSMs (revision / approval / incident)

### Added / Changed
- Three formal state machines in `src/core/fsm/{revision,approval,incident}.js`
  using **xstate v5** (MIT). One source of truth shared across the
  client UI, REST routes, and GraphQL resolvers.
- Refactored `src/core/revisions.js`, `src/screens/approvals.js`,
  `src/screens/incident.js`, `server/routes/core.js`,
  `server/graphql/resolvers.js` to delegate transition rules to the
  FSMs (was 9 hand-typed sites with subtle drift).
- 12 new FSM tests in `test/fsm.test.js`.
- Reversed the philosophy doc's earlier "xstate overkill" decision and
  added the **re-walk-the-matrix-when-rules-spread-to-3+-files** lesson.

## 0.5.1 — Engineering Philosophy + canonical OSS swaps

### Added
- `docs/ENGINEERING_PHILOSOPHY.md` — permanent rule + decision matrix +
  per-concern OSS register + pre-flight checklist.
- `CONTRIBUTING.md` — pre-flight checklist anchor for every PR.

### Changed
- **Prometheus metrics** swapped from hand-rolled to **prom-client**
  (Apache-2.0). Adds Node process metrics for free.
- **Service worker** swapped from hand-rolled to **Workbox** 7.1.0
  (MIT). Cache strategies + BackgroundSync queue replace the custom
  IDB queue.
- **CSV parser** in doc viewer swapped to **PapaParse** 5.4.1 (MIT)
  with a small offline fallback retained.

## 0.5.0 — n8n + GraphQL

### Added
- **GraphQL** at `POST /graphql` (Mercurius). Reads cover every primary
  object with deep field resolvers (`Document.revisions`, `Drawing.markups`,
  `Asset.docs`, `Revision.reviewCycles`, …). Mutations: `createWorkItem`,
  `updateWorkItem`, `postMessage`, `transitionRevision` (with auto-
  supersede cascade), `decideApproval` (HMAC chain-of-custody),
  `ingestEvent`. Auth = same Bearer header as REST. GraphiQL at
  `/graphiql` outside production.
- **n8n integration** — workflow automation engine bundled in
  `docker-compose.yml`.
  - Internal proxy at `/api/automations/n8n/*` (status / list workflows /
    activate / deactivate / executions); audited.
  - Admin → "Automations (n8n)" panel renders workflows + activation
    toggle and deep-links to the n8n UI.
  - 3 ready-to-import workflow templates in `deploy/n8n-templates/`:
    `forge-incident-to-slack` (signed-webhook receiver),
    `erp-po-to-workitem` (GraphQL mutation),
    `mqtt-alarm-to-incident` (REST event ingest).
- 5 new tests in `test/graphql.test.js` (auth gating, deep traversal,
  mutation cascade, introspection sanity).

## 0.4.0 — Spec gap-closing

### Added
- **Mentions** — `@user` parser + per-user notifications (`core/mentions.js`).
- **`/go OBJ-ID` palette parser** — `D-101 Rev C`, `INC-4412`, `AS-1`, etc.
- **Workspace switcher** in the rail; 3 seeded workspaces.
- **Calendar view** + **NCR work-item type** on the work board.
- **Site>Building>Floor>Room** alt hierarchy template seeded.
- **Drawing snap-to-region bookmarks** with capture-current-view.
- **Channel composer**: `</> Code` and `▦ Data` block helpers.
- **Drawing callout primitive** (anchor + connector + bubble).
- **Review cycles** as a first-class server object.
- **Form submissions** signed with HMAC-SHA256.
- **Commissioning checklists** linked to system/panel/package.
- **RFI link graph** (drawing/spec/markup/approval/vendor).
- **Model-element pins** (IFC element id anchor).
- **Drawing ingestion auto-parse** (filename → revision label/discipline/...).
- **Search facets**: kind + date + revision; with filter querystring.
- **Saved-search alert subscriptions** with 60 s polling worker.
- **Webhook retry** with exponential back-off + per-delivery rows.
- **Daily roll-ups** for §19 success metrics; `/api/metrics/series`.
- **AI provider routing** — local / OpenAI / Ollama via `FORGE_AI_POLICY`.
- **Trigram-cosine semantic re-rank** for hybrid retrieval (§15).
- **Image + CSV viewers** on doc viewer.
- **Field-mode PWA**: service worker shell cache + offline write queue.
- **a11y**: skip-link, aria-modal/role/aria-label, focus trap, focus-visible.

## 0.3.1 — Production hardening

### Added
- **API tokens** (`/api/tokens`): long-lived machine bearer credentials
  (`fgt_…`); SHA-256-stored, plaintext returned once; revocable.
- **File upload/download** (`/api/files`): multipart upload streamed to a
  SHA-256-addressed on-disk store; parent-record ACL enforced on download;
  `X-Content-SHA256` header; soft delete.
- **Outbound webhooks** (`/api/webhooks`): admin-scoped CRUD; every event
  emits an HMAC-SHA256 signed callback with `X-FORGE-Signature`,
  `X-FORGE-Event`, `X-FORGE-Delivery` headers; failures surface in
  `last_error`.
- **Prometheus metrics** (`/metrics`): counters + latency histograms +
  gauges (audit ledger size, event count).
- **Security hardening**: `@fastify/helmet` (CSP, HSTS, etc.),
  `@fastify/rate-limit` (600 req/min/user default, configurable).
- **Object-level ACL helper** (`server/acl.js`) with ABAC overlays (site /
  discipline / clearance attribute equality).
- **Backup / restore CLI** (`npm run backup` / `npm run restore`): online
  SQLite `VACUUM INTO` snapshot + files tarball.
- **OPC UA ingress bridge** (`server/connectors/opcua.js`): `node-opcua`
  based, gracefully disabled when the optional dep isn't installed.
- **SPA fallback** on the server: `/admin`, `/doc/…`, etc. reload into
  the client deep-linked.
- **Server admin UI**: Admin screen gains API-token, webhook, and
  metrics panels (server-mode only).
- **Route tests** (`test/routes.test.js`): in-process Fastify + fresh DB;
  covers login, `/api/me`, work-item CRUD, revision cascade, file SHA-256
  round-trip, API token lifecycle.
- **CI workflow** (`.github/workflows/ci.yml`): syntax check, migrations,
  `npm test`, live `/api/health` probe, Docker build + healthcheck.

### Changed
- `server/main.js` now accepts API tokens (`fgt_…`) and JWTs on the same
  `Authorization: Bearer` header.

## 0.3.0 — Server (Fastify + SQLite + JWT)

- Added **server/**: Node.js 20+ Fastify application.
  - SQLite + FTS5 schema with migrations (`server/db.js`).
  - JWT auth (`@fastify/jwt`) + bcrypt passwords + role/capability matrix.
  - Tamper-evident audit ledger in SQLite; `GET /api/audit/verify` walks
    the SHA-256 chain; `GET /api/audit/export` signs a JSON pack with
    HMAC-SHA256 that an independent verifier confirms byte-for-byte.
  - Canonical §9.2 event pipeline with DB-persisted envelopes, idempotent
    dedup, routing rules (incident/work-item/asset-timeline/alarm channel),
    DLQ, replay.
  - Full CRUD routes for team spaces, projects, channels, messages,
    documents, revisions (with IFR→Approved→IFC auto-supersede cascade),
    assets, work items, incidents, approvals (with signed chain-of-custody).
  - CESMII i3X 1.0-Beta REST mounted under `/v1`. Reuses the existing
    in-process engine so the client and server share one implementation.
  - SSE firehose at `/api/events/stream` for client live updates.
  - Optional MQTT bridge at `server/connectors/mqtt.js`.
- Client now auto-detects the server via `/api/health` and adds a sign-in
  flow; falls back to demo mode when no backend is present.
- Dockerfile + docker-compose.yml (with Mosquitto) + `.env.example`.
- Tests: `npm test` runs Node test runner against the audit chain.

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
