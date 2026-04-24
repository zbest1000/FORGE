# FORGE

Federated Operations, Research, Governance, and Engineering.

A secure, self-hostable engineering collaboration and execution platform.
This repository contains the product specification plus an interactive
client-side MVP prototype that exercises the full FORGE object model.

## What is in this repository

- `PRODUCT_SPEC.md` — full product specification, UX architecture, and UI system.
- `index.html`, `app.js`, `styles.css` — static entry points for the MVP prototype.
- `src/` — modular ES-module implementation:
  - `src/core/` — store (with `localStorage` persistence + audit log), router, permissions, UI atoms, command palette.
  - `src/data/` — seed domain data (organization, workspaces, team spaces, channels, docs, revisions, drawings, markups, assets, work items, incidents, approvals, integrations, telemetry).
  - `src/shell/` — workspace shell: far-left rail, left panel, header, right context panel, operations dock.
  - `src/screens/` — functional screens for all MVP pillars.

## Run locally

The app is a static client prototype — any static file server works from the repo root:

```bash
python3 -m http.server 8080
```

Open <http://localhost:8080/index.html>.

Requires a modern browser with ES module support.

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

### Permissions

Role selector in the header switches capabilities in real time.
Actions such as transitions, approvals, markup edits, and integration writes
are gated per-role. See `src/core/permissions.js`.

## Structure

```
├─ index.html              # shell mount points
├─ styles.css              # design tokens + component styles
├─ app.js                  # module bootstrap + route registry
├─ PRODUCT_SPEC.md         # full product spec
└─ src/
   ├─ core/
   │   ├─ store.js
   │   ├─ router.js
   │   ├─ permissions.js
   │   ├─ palette.js
   │   ├─ screens-registry.js
   │   └─ ui.js
   ├─ data/
   │   └─ seed.js
   ├─ shell/
   │   ├─ rail.js
   │   ├─ leftPanel.js
   │   ├─ header.js
   │   ├─ contextPanel.js
   │   └─ dock.js
   └─ screens/
       ├─ home.js        inbox.js        search.js
       ├─ teamSpaces.js  channel.js      workBoard.js
       ├─ docViewer.js   revisionCompare.js
       ├─ drawingViewer.js assetDetail.js
       ├─ incident.js    approvals.js    ai.js
       ├─ integrations.js mqtt.js        opcua.js     erp.js
       ├─ dashboards.js  admin.js        spec.js
```

## Development notes

- No build step. All modules are served directly.
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
