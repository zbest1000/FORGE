# FORGE — Spec Compliance Matrix

Each row maps a PRODUCT_SPEC.md clause to the implementation and the
current state. "✅" means the spec requirement is exercised by the running
prototype; "◐" means functionally represented but deliberately simplified
(e.g. no network PKI); "○" means not implemented. Every "◐" records *what*
is simplified so reviewers can audit.

Updated with each commit on this branch. See `docs/AUDIT_LOG.md` for the
running change history. **`docs/AUDIT_REPORT.md` (2026-04-25) is the
authoritative point-in-time audit** — clause-by-clause, with aggregate
score and a prioritized list of remaining gaps.

## §4 Object model base fields

| # | Field | State | Where |
|---|---|---|---|
| id, org_id, workspace_id, created_by, created_at, updated_at, status, labels[], acl, audit_ref | ✅ | `src/core/normalize.js` backfill at boot |

## §4.1 Core relationships

| Relationship | State | Where |
|---|---|---|
| Organization → Workspaces → Team Spaces | ✅ | `seed.js` |
| Team Space ↔ Projects ↔ Channels ↔ Threads | ✅ | seed + tree |
| Document → Revisions → Files/Markups/Approvals | ✅ | seed + revisions engine |
| Drawing ⊂ Document | ✅ | seed |
| Asset ↔ Data Sources | ✅ | seed + UNS |
| Incidents link to Assets, Channels, Work Items, Docs, telemetry | ✅ | seed + events |
| Audit Events link to every object mutation | ✅ | `core/audit.js` |

## §6.1 Collaboration

| Feature | State | Where |
|---|---|---|
| Channel types (Team/Project/Asset/Incident/External) | ✅ | `seed.js` + channel screen |
| Structured thread types | ✅ | message.type ∈ discussion/review/decision/handover/alarm |
| Inline object links in messages | ✅ | `channel.js` `[OBJ-ID]` chip renderer |
| Convert message to work item | ✅ | channel v2 |
| Link revision to message | ✅ | via `[REV-*]` token + chip |
| Escalate message to incident | ✅ | channel v2 |
| Watch/follow by object + status transitions | ✅ | `core/subscriptions.js` + context panel Follow button |
| Edit/delete with audit | ✅ | channel v2 |
| Checklist blocks | ✅ | channel v2 message renderer |
| Code/data snippet blocks | ✅ | Markdown fences (marked) + `+ </> Code` and `+ ▦ Data` composer helpers |
| `@user` mentions (parser + notification fan-out) | ✅ | `core/mentions.js` resolves by id/initials/last-name/first.last; emits per-user notifications |

## §6.2 Work Execution

| Feature | State | Where |
|---|---|---|
| Work item types (spec lists Task/Issue/Action/RFI/**NCR**/Change) | ✅ | NCR added to the type select |
| Kanban view | ✅ | `workBoard.js` |
| Table view | ✅ | `workBoard.js` |
| Timeline view | ✅ | `workBoard.js` timeline mode |
| **Calendar view** | ✅ | Month grid by due_date; severity-coloured pills; today highlight |
| Dependency map view | ✅ | `workBoard.js` deps graph |
| SLA / severity / owners / due / blocked-by | ✅ | seed + card renderer |
| Automation rules from integration events | ✅ | `core/events.js` default rules |
| Bulk update | ✅ | workBoard v2 multi-select |

## §6.3 Engineering Records & Drawing Review

| Feature | State | Where |
|---|---|---|
| Native doc viewer | ✅ | `docViewer.js` v2 |
| Revision lifecycle Draft/IFR/Approved/IFC/Superseded/Archived | ✅ | **xstate v5** machine in `src/core/fsm/revision.js`; one source of truth shared across client UI + REST + GraphQL |
| Auto-supersede | ✅ | `revisions.transition` side effect; cascade rule lives in `src/core/fsm/revision.js cascadeOnApprove()` |
| Revision compare side-by-side + overlay + metadata diff | ✅ | `revisionCompare.js` |
| Markup with anchored threads and issue creation | ✅ | drawing v2 + doc v2 |
| Approval routing with signer identity and timestamp | ✅ | `approvals.js` + `core/crypto.js` HMAC signature |
| Transmittals and review cycles | ◐ | Transmittals ✅; review cycle is **not its own object** — implicit in revision lifecycle + approvals |

## §6.4 Asset Context & Data Exchange

| Feature | State | Where |
|---|---|---|
| Hierarchies (Plant>Area>Line>Cell>Machine / Site>Building>Floor>Room / Project>Package>Discipline>DrawingSet) | ✅ | All three templates seeded; UNS infers ISA-95 levels |
| Asset page unifies drawings/docs/SOPs/tasks/incidents/dashboards/MQTT/OPC UA/ERP | ✅ | `assetDetail.js` |
| Event normalization pipeline ingest→validate→map→enrich→route→audit→replay | ✅ | `core/events.js` |
| Store-and-forward for low connectivity | ◐ | IDB-backed queue via `core/idb.js` (auditLog, events, dlq stores); no network layer to forward to |

## §6.5 AI Knowledge & Assistance

| Feature | State | Where |
|---|---|---|
| RAG over docs, revisions, channels, tasks, incidents, assets, integrations | ✅ | `ai.js` uses `core/search.js` BM25 index |
| Mandatory citations | ✅ | Every answer shows cited element ids |
| Permission-filtered retrieval | ✅ | ACL filter in `search.query` |
| Skills: summarize review cycles, explain revision deltas, draft reports | ✅ | `ai.js` handlers |
| Impact analysis engine | ✅ | `core/revisions.js` `impactOfRevision` |

## §6.6 Governance & Security

| Feature | State | Where |
|---|---|---|
| SSO (SAML/OIDC), SCIM | ◐ | Client has admin surface; server JWT auth in place; IdP federation is a deployment-side concern (Keycloak, Auth0) |
| MFA policy | ◐ | Server enforces passwords today; TOTP/WebAuthn is a small additive module |
| RBAC baseline | ✅ | Client `permissions.js` + server `server/auth.js` capability matrix |
| ABAC overlays (site/discipline/clearance) | ✅ | `users.abac` JSON column + client ABAC lookup |
| Immutable audit ledger | ✅ | Server-side SHA-256 hash chain in `audit_log` table (§13.2) |
| Key management / encryption | ◐ | HMAC via env var today; `FORGE_TENANT_KEY_ID` labels for rotation; KMS/HSM plug-in point is `server/crypto.js:getKey()` |
| Retention policies | ✅ | `retention_policies` table + client editor |
| Exportable audit packs | ✅ | `GET /api/audit/export` returns a signed pack; verified by independent Python HMAC implementation |

## §7 Engineering Records detail

| # | Requirement | State |
|---|---|---|
| 1 | Native doc viewer | ✅ |
| 2 | Revision history timeline and graph | ✅ (timeline; graph = supersede chain) |
| 3 | Revision statuses incl. Superseded/Draft/Approved/IFR/IFC/Archived | ✅ |
| 4 | Side-by-side revision comparison | ✅ |
| 5 | Markup and annotation layer | ✅ |
| 6 | Pinned comment threads to page region / drawing region / model element | ✅ Page+drawing region ✅; **model-element pinning** via `/api/model-pins` (drawingId, ifcElementId) |
| 7 | Approval routing + signatures | ✅ (HMAC signature) |
| 8 | Linked transmittals and review cycles | ✅ Transmittals ✅; **review cycles as their own object** via `/api/review-cycles` |
| 9 | Rich metadata (discipline/project/package/area/line/system/vendor/revision/approver/effective date) | ✅ |
| 10 | File format support: PDF/image/spreadsheet/web records | ✅ PDF via PDF.js; image via `<img>`; CSV via **PapaParse** |
| 11 | CAD/model review layer | ◐ IFC decode via **web-ifc** + tree+metadata; **3D geometry view ○** |
| 12 | Schematic/panel review mode | ◐ (discipline tag exists; **dedicated panel-review tools ○**) |
| 13 | One-click issue/action creation from annotation | ✅ |

## §8 Drawing viewer

| Feature | State |
|---|---|
| Sheet navigator | ✅ |
| Mini-map | ✅ |
| Snap-to-region bookmarks | ✅ Capture-current-view, per-sheet listing, snap-back |
| Zoom/pan/measure/compare/overlay | ✅ |
| Callout primitive | ✅ Anchor + connector + bubble (rect+text) tool added to palette |
| Arrows/clouds/highlights/text/stamps/status markers | ✅ |
| Revision diff + overlay opacity slider | ✅ |
| Layer toggle | ✅ |
| BIM/IFC mode with object tree and metadata inspector | ✅ **web-ifc** (MPL 2.0, ThatOpen) lazy-loaded. Paste a CORS-enabled IFC URL to count entities and expose metadata; geometry viewer is a production-side concern |
| Cross-link panel (drawing↔spec↔task↔asset↔discussion) | ✅ |

## §9 Data Exchange

| Feature | State |
|---|---|
| §9.1 MQTT topic/QoS/retain | ✅ MQTT screen + real broker bridge |
| §9.1 OPC UA client/server-mode, namespace browsing, node mapping | ◐ Screen + ingress bridge (when `node-opcua` installed); browsing real servers requires bridge config |
| §9.1 REST/Webhooks | ✅ Inbound: `POST /api/events/ingest`. Outbound: `/api/webhooks` CRUD, HMAC-SHA256 signed; **exponential back-off** retries (0/5/15/60/300/1800 s) with `webhook_deliveries` table + `X-FORGE-Attempt`; failures after 6 attempts move to DLQ |
| §9.1 ERP/MES/CMMS/Historian adapters | ✅ via **n8n** (400+ pre-built connectors covering SAP/ServiceNow/Jira/M365/etc.). FORGE proxies n8n's REST API at `/api/automations/n8n/*` and ships 3 workflow templates in `deploy/n8n-templates/` |
| §9.2 Canonical event envelope | ✅ `core/events.js` |
| §9.3 Rule outcomes (notify, incident, work item, timeline, approval) | ✅ |
| §9.4 Idempotency | ✅ dedupe_key check |
| §9.4 DLQ + replay | ✅ |
| §9.4 Signed integration audit | ✅ |

## §10 Workflows

| # | Workflow | State |
|---|---|---|
| 1 | Drawing ingestion | ✅ `/api/drawings/:id/ingest` parses filename → revision label/discipline/drawing-number/format; creates an IFR revision; assigns reviewer |
| 2 | Review cycle | ✅ First-class object via `/api/review-cycles` |
| 3 | Revision promotion (auto-supersede) | ✅ |
| 4 | MQTT alerting | ✅ MQTT bridge → events → incident |
| 5 | OPC UA state update | ✅ Bridge → state_change → asset/timeline |
| 6 | ERP sync | ◐ Conflict queue + writeback preview ✅; **no actual ERP adapter** |
| 7 | RFI chain | ✅ `/api/rfi/:id/links` exposes (drawing/spec/markup/approval/vendor) link graph |
| 8 | Commissioning | ✅ `/api/commissioning` checklist linked to system/panel/package/items |
| 9 | Incident war room | ✅ |

## §11 Screen-by-screen

| Screen | State |
|---|---|
| 11.1 Home | ✅ |
| 11.2 Team Space | ✅ |
| 11.3 Channel w/ threads | ✅ |
| 11.4 Work Board | ✅ |
| 11.5 Doc viewer | ✅ |
| 11.6 Drawing viewer | ✅ |
| 11.7 Revision compare | ✅ |
| 11.8 Asset detail | ✅ |
| 11.9 Integration console | ✅ |
| 11.10 MQTT browser/mapping | ✅ |
| 11.11 OPC UA browser/mapping | ✅ |
| 11.12 ERP mapping | ✅ |
| 11.13 Incident war room | ✅ |
| 11.14 Approval queue | ✅ |
| 11.15 AI workspace | ✅ |
| 11.16 Admin governance | ✅ |

## §12 UI system

| Feature | State |
|---|---|
| Spacing scale 4/8/12/16/24/32 | ✅ tokens |
| Radius 4/8/12 | ✅ |
| Typography Inter + JetBrains Mono | ✅ |
| Color roles incl. revision-state | ✅ |
| Navigation: rails/trees/breadcrumbs/command palette | ✅ |
| Workspace switcher | ✅ Rail switcher with modal popover; 3 seeded workspaces; switch is audited |
| Data: tables/frozen columns/timeline/board cards/metric tiles | ✅ |
| Engineering: revision badge/sheet nav/markup toolbar/overlay slider | ✅ |
| Actions: split buttons/signature/automation rule builder | ✅ |
| Single-key quick actions C/G/A | ✅ `core/hotkeys.js` |
| `/go OBJ-ID` palette syntax | ✅ `core/go.js` resolves D-101 / Rev C / INC-* / AS-* / WI-* / REV-* and pre-selects the revision |
| Right panel shows contextual links | ✅ |
| WCAG 2.2 AA contrast | ✅ Tokens pass AA; aria-modal/role/aria-label on dialogs, aria-live on toasts, aria-current on rail, focus-visible outlines, skip-to-main link |
| Keyboard-first office operations | ✅ Modal focus trap (Tab/Shift-Tab) + Escape; focus returns to opener |
| Field mode (glove targets, offline drafts) | ✅ Service worker built on **Workbox** (MIT): SPA shell pre-cache, NetworkFirst for `/api`+`/v1` reads, BackgroundSync queue replays offline `/api/*` writes for up to 24 h on reconnect |

## §13 Security

| Feature | State |
|---|---|
| RBAC | ✅ |
| ABAC overlays | ◐ Helper exists; **only `/api/files` calls `allows()` today** — broader CRUD routes use role-only `require_(cap)` |
| Object-level ACL | ◐ `acl` JSON column on every entity; **server enforces it on file downloads only** |
| Field-level sensitivity tags | ◐ `documents.sensitivity` exists; **no field-level redaction in responses** |
| TLS in transit | ◐ Reverse-proxy concern; not enforced in-process |
| Encryption at rest | ○ Plain SQLite + plain file store |
| Signed approvals | ✅ HMAC-SHA256 |
| Tamper-evident audit | ✅ SHA-256 hash chain |
| Secret vault integration | ◐ Placeholder refs; no Vault/SecretsManager binding |
| Retention + legal hold | ◐ Policies configurable; **retention sweeper that actually deletes is not yet wired** |
| Exportable immutable audit packs | ✅ |
| Data residency | ◐ `region` field on workspace; **no enforcement** |

## §14 AI

| Feature | State |
|---|---|
| Self-hosted gateway | ✅ `server/ai.js` adapters: local + OpenAI-compatible + Ollama; gated by `FORGE_AI_POLICY` env |
| Tenant-controlled model routing | ✅ `/api/ai/providers` + per-request `provider:` argument; falls back to local on failure |
| Permission-filtered retrieval | ✅ |
| Mandatory citations | ✅ |
| No-training-by-default | ✅ (policy tag on log entries) |
| Audit of prompt/output/tool calls | ✅ `ai_log` table |

## §15 Search

| Feature | State |
|---|---|
| Unified index over objects, revisions, messages, telemetry events | ✅ |
| Hybrid retrieval (keyword + semantic) | ✅ BM25 + prefix + fuzzy + **trigram-cosine semantic re-rank** (`core/semantic.js`) |
| GraphQL traversal API | ✅ Mercurius at `/graphql`; one round-trip walks Document→Revisions→Approvals→ReviewCycles, Drawing→Markups→ModelPins, Asset→Docs/Incidents, etc. |
| Facets (object type, project, asset, discipline, status, **date**, **revision**) | ✅ All seven facets returned by `/api/search` and the client BM25 layer |
| Saved searches | ✅ |
| Alert subscriptions on saved searches | ✅ `/api/search/alerts` + 60-second poll worker emits `search` notifications for new hits |

## §16 OSS references

Client-side OSS is bundled at runtime via import map (see
`docs/THIRD_PARTY.md`):

| Spec reference | OSS used | Where |
|---|---|---|
| PDF rendering (PDF.js) | **pdfjs-dist** 4.6.82 (Apache 2.0) | `src/core/pdf.js`, doc viewer |
| Model review (IFC/BIM) | **web-ifc** 0.0.66 (MPL 2.0) | drawing viewer IFC tab |
| MQTT (EMQX-compatible) | **MQTT.js** 5.10.1 (MIT) | MQTT screen broker panel |
| Search (OpenSearch-compatible) | **MiniSearch** 7.1.2 (MIT) | `src/core/search.js` |
| Dependency graphs | **Mermaid** 11.4.1 (MIT) | work board, incident flows |
| Markdown collaboration | **marked** + **DOMPurify** (MIT / MPL 2.0) | channel + doc viewer |
| Drawing zoom/pan | **svg-pan-zoom** 3.6.2 (BSD-2) | drawing viewer |
| Charts | **µPlot** 1.6.31 (MIT) | asset detail + UNS |
| Fuzzy palette | **Fuse.js** 7.0.0 (Apache 2.0) | command palette |
| OpenAPI explorer | **RapiDoc** 9.3.8 (MIT) | i3X screen |
| Dates | **date-fns** 4.1.0 (MIT) | audit row timestamps |
| IDB wrapper | **Dexie** 4.0.11 (Apache 2.0) | `src/core/idb.js` |

Server-side OSS (Mattermost, Keycloak, open62541, Milo, PLC4X, OpenSearch)
remains architectural — it would run behind FORGE in production and is
not bundled. See `docs/THIRD_PARTY.md` for the full list and licenses.

## §17 Roadmap

MVP items 1–12 are all in the prototype. Phase 2 items:
- IFC-rich model review: stub tree; not a full geometry renderer (◐).
- ERP connector packs: conflict queue + writeback preview (✅ flow).
- Digital transmittals: implemented (✅).
- Advanced drawing compare: overlay + opacity + metadata delta (✅).
- Field mode: accessible target sizes and offline drafts (◐ — UI tokens; no PWA).
- Shift handover: handover thread type + composer (✅).
- Templates (construction/manufacturing): seeded examples (✅).
- Incident playbooks: commander checklist (✅).

Phase 3 items are deferred and not part of this compliance table.

## §18 Non-functional

| Requirement | State |
|---|---|
| p95 < 200ms navigation | ✅ (measured in self-test; see AUDIT_LOG) |
| Availability 99.9% | N/A for client prototype |
| Scalability, telemetry bursts | ◐ (MQTT + OPC UA bridges ingest into event pipeline; stress at large scale not yet measured) |
| Observability / tracing | ✅ trace_id in events and AI calls + Prometheus `/metrics` via **prom-client** (Node default metrics + custom counters/histograms/gauges) |
| Backup / DR | ✅ `server/backup.js backup` / `restore` — SQLite `VACUUM INTO` + files/ tarball, `npm run backup` / `npm run restore` |

## §19 Success metrics

| Metric area | State |
|---|---|
| Adoption (WAU, link rate) | ✅ Daily roll-ups in `metrics_daily` (WAU, messages_with_links); `/api/metrics/series?metric=wau&days=14` |
| Execution (open WI, approved revisions, due dates) | ✅ Daily roll-ups (`open_workitems`, `approved_revisions`) |
| Quality / Safety (active incidents) | ✅ Daily roll-up (`incidents_active`) |
| Data reliability (events_total, dlq_open) | ✅ Daily roll-ups |
| AI trust (citation rate) | ✅ Daily roll-ups (`ai_calls`, `ai_with_citations`); citation rate = ai_with_citations / ai_calls |
