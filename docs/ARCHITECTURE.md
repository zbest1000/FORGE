# FORGE — Architecture

This document describes how the FORGE prototype is organized, the technology
choices and the reasoning behind them. It is kept in sync with the working
implementation.

## 1. Shape of the system

FORGE ships here as a **pure client-side, zero-dependency prototype**: static
HTML/CSS + ES modules served by any static file server. It is architected as if
a real backend existed behind it, so each in-browser module has a clean
swap-point for a network implementation.

```
┌──────────────────── Browser ────────────────────────────────────────┐
│                                                                     │
│  Shell (rail, left panel, header, right context panel, ops dock)    │
│       │                                                             │
│       ▼                                                             │
│  Router  ──►  Screen renderers                                      │
│                    │                                                │
│                    ▼                                                │
│  Reactive store  ◄──► UI atoms / modals / toasts                    │
│       │                                                             │
│       ├──► Audit ledger (hash-chained, Web Crypto SHA-256)          │
│       ├──► Search index (BM25 inverted + facets)                    │
│       ├──► Event router (canonical envelope, DLQ, replay)           │
│       ├──► Revision lifecycle engine                                │
│       ├──► Subscription / watcher model                             │
│       ├──► Crypto helpers (HMAC-SHA256 signatures for approvals)    │
│       └──► i3X server (UNS + OpenAPI-compatible engine)             │
│                                                                     │
│  Persistence: localStorage (UI, seed overlay) + IndexedDB (ledgers) │
└─────────────────────────────────────────────────────────────────────┘
```

## 2. Technology choices

| Concern | Primary (OSS) | Fallback | Spec clause |
|---|---|---|---|
| Runtime | Browser ES modules, import map | — | — |
| Rendering | Hand-rolled DOM via `el()` helpers | — | §12 |
| State | Custom reactive store | — | — |
| PDF viewer | **PDF.js** (Apache 2.0) | SVG "paper" placeholder | §7.10 |
| Search | **MiniSearch** (MIT) | Hand-rolled BM25 | §15 |
| Persistent logs | **Dexie** (Apache 2.0) over IndexedDB | Bare IDB wrapper | §6.4, §9.4 |
| Markdown rendering | **marked** + **DOMPurify** (MIT, MPL 2.0) | Plain text | §6.1 |
| Dependency / impact graphs | **Mermaid** (MIT) | Hand-rolled SVG graph | §11.4, §6.5 |
| Drawing zoom/pan | **svg-pan-zoom** (BSD-2) | Hand-rolled transform matrix | §8 |
| Sparklines / telemetry | **µPlot** (MIT) | Hand-rolled polyline | §6.4 |
| MQTT broker | **MQTT.js** (MIT) WebSockets | In-process simulator | §6.4, §9.1 |
| IFC / BIM | **web-ifc** (MPL 2.0) | Stub entity tree | §8 |
| Command palette fuzzy match | **Fuse.js** (Apache 2.0) | Substring | §5.3 |
| Time formatting | **date-fns** (MIT) | Intl / toLocaleString | — |
| OpenAPI explorer (i3X) | **RapiDoc** (MIT) | — | i3X |
| Tamper-evident audit | Web Crypto SHA-256 hash chain | — | §13.2 |
| Signatures | Web Crypto HMAC-SHA256 | — | §13.2 |
| Routing | Hash router with params + query strings | — | — |
| i3X / UNS | In-process engine | — | CESMII i3X 1.0-Beta |

All OSS runs through `src/core/vendor.js`, which caches import promises
and exposes `vendorStatus()` for a UI badge. Failures are non-fatal and
switch the caller to its fallback path.

**Third-party open-source integration**. An ES-module import map in
`index.html` pulls 13 OSS packages at runtime from `esm.sh`: MiniSearch,
Dexie, marked, DOMPurify, Mermaid, svg-pan-zoom, µPlot, MQTT.js, web-ifc,
Fuse.js, date-fns, PDF.js, and RapiDoc. See `docs/THIRD_PARTY.md` for
pinned versions and licenses. Every integration is loaded through
`src/core/vendor.js` which caches the promise and lets callers fall back to
the hand-rolled implementation on failure, so the prototype still runs fully
offline with a local server.

## 3. Module map

```
src/
├── core/
│   ├── store.js              # Reactive state + localStorage
│   ├── router.js             # Hash router, rerenderCurrent()
│   ├── permissions.js        # RBAC + ABAC-lite capability helper
│   ├── palette.js            # Command palette (⌘K)
│   ├── screens-registry.js   # Screen→route map
│   ├── ui.js                 # el/card/badge/chip/table/modal/toast/form atoms
│   ├── hotkeys.js            # Single-key C/G/A/? handlers
│   ├── crypto.js             # SHA-256 hash chain + HMAC sign/verify
│   ├── audit.js              # Append-only hash-chained ledger + export
│   ├── idb.js                # Thin IndexedDB wrapper for append-only stores
│   ├── subscriptions.js      # Object follow/watch + notification fan-out
│   ├── search.js             # BM25 index + facets + saved searches
│   ├── events.js             # Canonical event envelope + router + DLQ
│   ├── revisions.js          # Revision lifecycle state machine
│   └── i3x/
│       ├── server.js         # In-process i3X engine
│       ├── client.js         # REST-shaped client wrapper
│       └── uns.js            # UNS path helpers
├── data/
│   ├── seed.js               # FORGE domain seed
│   └── uns-seed.js           # UNS instance graph
├── shell/
│   ├── rail.js leftPanel.js header.js contextPanel.js dock.js
└── screens/
    ├── home.js inbox.js search.js
    ├── teamSpaces.js channel.js workBoard.js
    ├── docViewer.js revisionCompare.js drawingViewer.js
    ├── assetDetail.js incident.js approvals.js ai.js
    ├── integrations.js mqtt.js opcua.js erp.js
    ├── uns.js i3x.js
    └── dashboards.js admin.js spec.js
```

## 4. Data & object model (§4 base fields)

Every domain object is normalized to include:

```js
{
  id: "OBJ-…",
  org_id: "ORG-1",
  workspace_id: "WS-1",
  created_by: "U-1",
  created_at: "ISO-8601",
  updated_at: "ISO-8601",
  status: "...",
  labels: [],
  acl: { roles: [...], users: [...], abac: { discipline, site, clearance }},
  audit_ref: null,   // populated to last ledger entry id for that object
}
```

A one-time normalization pass runs at boot to backfill these for the seed.
All mutation helpers (`update`, `upsert`, `remove`) touch `updated_at` and
enqueue an audit entry.

## 5. Audit ledger

Each ledger entry:

```js
{
  id: "AUD-<seq>",
  ts: "...",
  actor: "role or user id",
  action: "workitem.transition",
  subject: "WI-102",
  detail: { from: "Open", to: "In Review" },
  prevHash: "<hex>",
  hash: "<hex>"  // sha256(canonicalJSON({...entry without hash}))
}
```

The chain's first entry has `prevHash = "0".repeat(64)`. A `verifyLedger()`
function recomputes the chain and reports the first mismatch, if any. An
**export audit pack** takes a slice, wraps it in `{ exported_at, signer,
entries, signature }`, signs it with HMAC-SHA256 over the canonical JSON, and
downloads as a JSON file.

## 6. Revision lifecycle

States: `Draft → IFR → Approved → IFC → Superseded → Archived`, plus `Rejected`
on reject from any review state. The `revisions.transition(revId, to, meta)`
function enforces allowed transitions, auto-supersedes the previously-current
revision when a new one becomes `IFC`, and writes audit entries for every
transition.

## 7. Event pipeline

Every external or internal event flows through `events.ingest(rawEvent, source)`
which normalizes into the canonical envelope from spec §9.2:

```js
{ event_id, source, source_type, received_at, asset_ref, project_ref,
  object_refs: [], severity, event_type, payload, trace_id,
  routing_policy, dedupe_key, auth_context }
```

`events.route(envelope)` applies rules that can `notify` a channel, create or
update an incident or work item, append a timeline entry, or trigger an
approval. Failures land in a **dead-letter queue**; a `replay(dlqId)` call
re-ingests with a new `trace_id` and an audit entry.

## 8. Search

A BM25 inverted index is built at boot and updated on mutations. Documents
indexed: objects from every collection plus their key fields and labels. The
search screen exposes facets (object type, status, discipline, project, team
space) and saved searches (stored in localStorage per-user).

## 9. Viewers

### Drawing viewer
SVG canvas with a 2D transform matrix (`translate(x,y) scale(k)`). Tools:
zoom, pan, measure (two-click distance + on-canvas readout), markup palette
(arrow, cloud, highlight, text, stamp, status marker), layer visibility
toggles, overlay compare with opacity slider, mini-map. IFC mode is a tab
showing an object tree + metadata inspector fed from a stub model graph.

### Document viewer
Multi-page SVG "paper" with page nav and overview strip. Comment pins anchor to
`{page, x, y}` with threaded replies. Rich metadata panel per document
(discipline, project, package, area, line, system, vendor, revision, approver,
effective date). "Create issue from annotation" one-click creates a work item
referencing the pin.

## 10. AI

AI retrieval uses the BM25 index over objects, revisions, messages, and data
source mappings, filtered by the role's ACL capabilities before scoring. Every
prompt/output is recorded in the audit ledger with the AI retention policy tag.

## 11. Non-functional

- **Performance**: target p95 < 200ms for navigation. All mutations are O(N)
  over the in-memory store; N is small (< 200 objects in the seed) and
  IndexedDB writes are async so UI never blocks.
- **Observability**: every tool call emits a `trace_id`; audit entries carry
  it; the admin screen exposes a trace timeline.
- **Accessibility**: semantic HTML, focusable buttons, keyboard shortcuts,
  WCAG 2.2 AA palette check.

## 12. Extensibility seams

| Replace in-browser module with … | To gain |
|---|---|
| `i3x/client.js` → HTTP fetch | Any real i3X server |
| `events.js` inbound → EventSource/Webhooks | Real MQTT/OPC UA/ERP feed |
| `search.js` → OpenSearch REST | Distributed retrieval |
| `crypto.js` sign → KMS/HSM call | Hardware-backed signatures |
| `idb.js` → a backend append-only log | Tenant-wide audit |
