# FORGE

Federated Operations, Research, Governance, and Engineering.

A secure, self-hostable engineering collaboration and execution platform.
This repository contains the product specification plus an interactive
client-side MVP prototype that exercises the full FORGE object model.

## Engineering philosophy

> **Don't rebuild the wheel.** This repo follows the rule codified in
> `docs/ENGINEERING_PHILOSOPHY.md`: every concern is solved by a mature,
> permissive-licensed open-source project first, with hand-rolled code
> only when no fit exists or the surface needs redesigning around the
> spec. The doc has the decision matrix, the per-concern OSS register,
> and a pre-flight checklist that every PR is expected to use.

## What is in this repository

- `PRODUCT_SPEC.md` — full product specification, UX architecture, and UI system.
- `index.html`, `app.js`, `styles.css` — browser entry points for the SPA.
- `vite.config.js` — production build config; `npm run build` emits `dist/`.
- `src/` — modular ES-module implementation:
  - `src/core/` — store (with `localStorage` persistence + audit log), router, permissions, UI atoms, command palette.
  - `src/core/i3x/` — **Unified Namespace + CESMII i3X 1.0-Beta compatible engine** (server, client, path helpers).
  - `src/data/` — seed domain data plus `uns-seed.js` that generates namespaces, types, relationship types, and a full instance graph from the FORGE data.
  - `src/shell/` — workspace shell: far-left rail, left panel, header, right context panel, operations dock.
  - `src/screens/` — functional screens for all MVP pillars, including a UNS browser and an i3X API explorer.

## Run

FORGE ships as a **server + client** and also runs client-only in "demo mode"
for quick UX inspection.

### Server (recommended)

```bash
npm install
npm run build       # production SPA bundle in ./dist
npm run seed        # one-time: creates ./data/forge.db + demo users
npm start           # Fastify on http://localhost:3000
# admin@forge.local / forge
```

For local source-module development use `npm run dev` (sets
`FORGE_SERVE_SOURCE=1`) or `npm run dev:client`; production must ship `dist/`.
See `docs/RELEASE.md` for the Git build/release flow and `docs/SERVER.md` for
the full API surface, deployment, and security model.
A Dockerfile and `docker-compose.yml` (with an optional Mosquitto broker) are
included.

### Client-only demo mode (no backend)

```bash
python3 -m http.server 8080
# open http://localhost:8080
```

This path is for quick UX inspection only. The client probes `/api/health` and
automatically drops into a fully-offline demo mode when no backend responds.

## Implemented MVP features

- **Shell** — workspace switcher / rail, left panel with grouped trees (team spaces, channels, projects, docs, drawings, assets), role switcher, operations dock with live status chips for active incidents, degraded integrations, pending approvals.
- **Command palette** — `⌘K` / `Ctrl+K` to jump to any object or screen.
- **Persistent state** — all mutations persist to `localStorage` across reloads. "Reset" in the header restores seed.
- **Audit log** — every create / update / transition / approval / markup / incident change is appended to the audit ledger visible in context panel and Admin.

### Screens

- **Home** — KPIs, priority queue, daily AI engineering brief (citation-backed), recent revisions, integration health.
- **Inbox** — filtered notifications linked to sources.
- **Search** — hybrid keyword/semantic search over all seeded objects.
- **Team Spaces** — index + detail (channels, projects, docs, members).
- **Channel** — real message stream, structured thread types, inline `[OBJ-ID]` chips that jump to objects, composer with Enter-to-send, attachments, decision markers.
- **Work Board** — drag-and-drop Kanban with board/table toggle, create/edit work items, severity & SLA chips, blocker indicators.
- **Doc Viewer** — paper canvas with metadata, revision timeline (click a row to switch rev), approval banner, request-approval flow, Compare button, "Ask this document" AI.
- **Revision Compare** — side-by-side panes + metadata semantic diff + AI impact analysis.
- **Drawing Viewer** — SVG-rendered sheet navigator, toggleable markup mode (click to anchor pins on the sheet), markup cluster view, cross-links.
- **Asset Detail** — live telemetry sparkline (mock), hierarchy, linked docs, data source mappings, open-war-room button creating an incident inline.
- **Incident War Room** — severity bar, chronological timeline, log-entry composer, commander assignment, linked asset/channel, AI next-step recommendations.
- **Approvals** — filtered queue with sign/reject flow, cascade to revision promotion, signature audit trail.
- **Integrations Console** — per-connector health, test/replay actions; sub-screens for MQTT (topic tree + payload inspector + mapping rules), OPC UA (endpoint/session + node tree + mapping editor), ERP (mapping matrix with conflict queue).
- **AI Workspace** — threaded assistant, scope-aware prompts, citations, suggested prompts, retention policy note.
- **Admin Governance** — SSO/retention status, RBAC capability matrix, audit analytics, policy violation list.
- **Dashboards** — dashboard cards + workspace KPIs.
- **Spec reference** (`/spec`) — preserved screen-by-screen spec summary.
- **Unified Namespace** (`/uns`) — hierarchical ISA-95 instance browser with live VQT, relationship panel, alternate addresses (MQTT topics, OPC UA nodes, FORGE IDs) for every node, and cross-links back to the asset/doc/drawing/incident records.
- **i3X API Explorer** (`/i3x`) — live, in-process implementation of the [CESMII i3X 1.0-Beta OpenAPI](https://api.i3x.dev/v1/docs). Pick any endpoint, edit the request body, see the resolved request URL and the exact `SuccessResponse` / `BulkResponse` envelope the server returns, and open an SSE-simulated subscription stream that prints live sequence-numbered VQT updates.

### Permissions

Role selector in the header switches capabilities in real time.
Actions such as transitions, approvals, markup edits, and integration writes
are gated per-role. See `src/core/permissions.js`.

## Unified Namespace + i3X compatibility

FORGE ships with an in-process engine that implements the **CESMII i3X 1.0-Beta**
OpenAPI surface and a **Unified Namespace** built over ISA-95.

### Namespaces

| URI                         | Purpose                                        |
|-----------------------------|------------------------------------------------|
| `urn:cesmii:isa95:1`        | `Enterprise`/`Site`/`Area`/`ProductionLine`/`Cell`/`Equipment` types + `HasChild`/`HasComponent`/`LocatedIn` relationships |
| `urn:forge:signals:1`       | `Variable`, `Alarm` signal types with `Measures` relationship |
| `urn:forge:core:1`          | FORGE record types (`Document`, `Drawing`, `WorkItem`, `Incident`) |
| `urn:atlas:workspace:1`     | Tenant-scoped instance namespace                |

Every FORGE asset is emitted into a **single canonical UNS path**, e.g.:

```
atlas-industrial-systems/north-plant/line-a/cell-3/hx-01
atlas-industrial-systems/north-plant/line-a/cell-3/hx-01/temp
atlas-industrial-systems/north-plant/line-a/cell-3/hx-01/high-temp
```

Each variable records every **alternate address** (MQTT topic, OPC UA nodeId,
FORGE asset id) so the same signal is resolvable by UNS path, by i3X
`elementId`, by `ns=2;s=HX01.Temp`, by `line/a1/hx01/temp`, or by `AS-1`.

### i3X endpoints

All implemented against the in-process server and exposed through the Explorer:

| Method | Path                                 | Tag       |
|--------|--------------------------------------|-----------|
| GET    | `/info`                              | Info      |
| GET    | `/namespaces`                        | Explore   |
| GET    | `/objecttypes` (+ `/query`)          | Explore   |
| GET    | `/relationshiptypes` (+ `/query`)    | Explore   |
| GET    | `/objects` (`?typeElementId`, `?root`, `?includeMetadata`) | Explore |
| POST   | `/objects/list`                      | Explore   |
| POST   | `/objects/related`                   | Explore   |
| POST   | `/objects/value`  (maxDepth composition rollup) | Query |
| POST   | `/objects/history`                   | Query     |
| GET    | `/objects/{id}/history`              | Query     |
| PUT    | `/objects/{id}/value`                | Update    |
| PUT    | `/objects/{id}/history`              | Update    |
| POST   | `/subscriptions` + `/register` + `/unregister` + `/sync` + `/list` + `/delete` | Subscribe |
| POST   | `/subscriptions/stream`              | Subscribe (SSE-simulated) |

Responses match the spec's `SuccessResponse` / `BulkResponse` / `ErrorResponse`
envelopes and use **VQT** shapes (`value`, `quality` ∈ `Good`/`Uncertain`/`Bad`/`GoodNoData`, `timestamp`). A 1.5 s ticker generates live VQT updates so the UNS
sparkline and the subscription stream move continuously.

The client (`src/core/i3x/client.js`) exposes the same functions and can be
replaced with an HTTP `fetch()` against a real i3X server without touching the UI.

## Structure

```
├─ index.html              # Vite entry + shell mount points
├─ styles.css              # design tokens + component styles
├─ app.js                  # module bootstrap + route registry
├─ dist/                   # generated by npm run build (ignored)
├─ PRODUCT_SPEC.md         # full product spec
└─ src/
   ├─ core/
   │   ├─ store.js         router.js       permissions.js
   │   ├─ palette.js       screens-registry.js     ui.js
   │   └─ i3x/
   │       ├─ server.js    # in-process i3X engine + subscription manager
   │       ├─ client.js    # thin REST-shaped client
   │       └─ uns.js       # UNS path helpers
   ├─ data/
   │   ├─ seed.js          # FORGE domain seed
   │   └─ uns-seed.js      # UNS namespaces/types/relationships/instances
   ├─ shell/               # rail / leftPanel / header / contextPanel / dock
   └─ screens/
       ├─ home.js        inbox.js        search.js
       ├─ teamSpaces.js  channel.js      workBoard.js
       ├─ docViewer.js   revisionCompare.js
       ├─ drawingViewer.js assetDetail.js
       ├─ incident.js    approvals.js    ai.js
       ├─ integrations.js mqtt.js        opcua.js     erp.js
       ├─ uns.js         i3x.js
       ├─ dashboards.js  admin.js        spec.js
```

## Development notes

- Enterprise builds use Vite: `npm run build` writes hashed assets to `dist/`.
- `npm start` requires `dist/` unless `FORGE_SERVE_SOURCE=1` is set.
- `npm run release:check` is the required pre-merge/release gate.
- Data model is defined in `src/data/seed.js` and can be reset from the header.
- State changes are reactive via a small pub/sub store (`src/core/store.js`); every mutation triggers re-render of the shell and the current screen.
- Routes are hash-based (`#/doc/DOC-1`, `#/work-board/PRJ-1`, etc.) and support query strings (`#/search?q=valve`).
- Console helper: `window.__forgeSelfTest()` asserts seed integrity.

## Roadmap alignment

This MVP implements items 1–12 of the roadmap §17.1 (team spaces, channels+threads,
work items+boards, doc viewer, revision control + approvals, drawing markup,
asset pages, MQTT + REST foundation, OPC UA foundation, search, AI summaries + doc
Q&A, SSO + audit log surfaces) as an interactive UI prototype. Phase 2 and 3
features (IFC model review, ERP connector packs, edge sync, federation) are
represented as design-accurate skeletons ready to be backed by real services.
