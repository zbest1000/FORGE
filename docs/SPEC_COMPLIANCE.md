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
| Code/data snippet blocks | ◐ | Markdown fences via marked; **no language-aware data-table block** |
| `@user` mentions (parser + notification fan-out) | ○ | Not implemented (string label only) |

## §6.2 Work Execution

| Feature | State | Where |
|---|---|---|
| Work item types (spec lists Task/Issue/Action/RFI/**NCR**/Change) | ◐ | Has Task/Issue/Action/RFI/Punch/Defect/CAPA/Change; **NCR not present** |
| Kanban view | ✅ | `workBoard.js` |
| Table view | ✅ | `workBoard.js` |
| Timeline view | ✅ | `workBoard.js` timeline mode |
| **Calendar view** | ○ | Not implemented |
| Dependency map view | ✅ | `workBoard.js` deps graph |
| SLA / severity / owners / due / blocked-by | ✅ | seed + card renderer |
| Automation rules from integration events | ✅ | `core/events.js` default rules |
| Bulk update | ✅ | workBoard v2 multi-select |

## §6.3 Engineering Records & Drawing Review

| Feature | State | Where |
|---|---|---|
| Native doc viewer | ✅ | `docViewer.js` v2 |
| Revision lifecycle Draft/IFR/Approved/IFC/Superseded/Archived | ✅ | `core/revisions.js` state machine |
| Auto-supersede | ✅ | `revisions.transition` side effect |
| Revision compare side-by-side + overlay + metadata diff | ✅ | `revisionCompare.js` |
| Markup with anchored threads and issue creation | ✅ | drawing v2 + doc v2 |
| Approval routing with signer identity and timestamp | ✅ | `approvals.js` + `core/crypto.js` HMAC signature |
| Transmittals and review cycles | ◐ | Transmittals ✅; review cycle is **not its own object** — implicit in revision lifecycle + approvals |

## §6.4 Asset Context & Data Exchange

| Feature | State | Where |
|---|---|---|
| Hierarchies (Plant>Area>Line>Cell>Machine / Site>Building>Floor>Room / Project>Package>Discipline>DrawingSet) | ◐ | Plant + Project hierarchies seeded in UNS; **Site>Building>Floor>Room template not seeded** |
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
| 6 | Pinned comment threads to page region / drawing region / model element | ◐ Page+drawing region ✅; **model-element pinning ○** |
| 7 | Approval routing + signatures | ✅ (HMAC signature) |
| 8 | Linked transmittals and review cycles | ◐ Transmittals ✅; review cycles ○ as separate object |
| 9 | Rich metadata (discipline/project/package/area/line/system/vendor/revision/approver/effective date) | ✅ |
| 10 | File format support: PDF/image/spreadsheet/web records | ◐ PDF via **PDF.js**; **image/spreadsheet viewers ○** |
| 11 | CAD/model review layer | ◐ IFC decode via **web-ifc** + tree+metadata; **3D geometry view ○** |
| 12 | Schematic/panel review mode | ◐ (discipline tag exists; **dedicated panel-review tools ○**) |
| 13 | One-click issue/action creation from annotation | ✅ |

## §8 Drawing viewer

| Feature | State |
|---|---|
| Sheet navigator | ✅ |
| Mini-map | ✅ |
| Snap-to-region bookmarks | ○ |
| Zoom/pan/measure/compare/overlay | ✅ |
| Callout primitive | ◐ Arrow + text serve as callouts; **no formal connector** |
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
| §9.1 REST/Webhooks | ✅ Inbound: `POST /api/events/ingest`. Outbound: `/api/webhooks` CRUD, HMAC-SHA256 signed; **retries 1-shot, not exponential** |
| §9.1 ERP/MES/CMMS/Historian adapters | ◐ ERP flow ✅; concrete adapters ○ |
| §9.2 Canonical event envelope | ✅ `core/events.js` |
| §9.3 Rule outcomes (notify, incident, work item, timeline, approval) | ✅ |
| §9.4 Idempotency | ✅ dedupe_key check |
| §9.4 DLQ + replay | ✅ |
| §9.4 Signed integration audit | ✅ |

## §10 Workflows

| # | Workflow | State |
|---|---|---|
| 1 | Drawing ingestion | ◐ Manual upload via `/api/files`; **no auto revision-parse / metadata extract** |
| 2 | Review cycle | ✅ |
| 3 | Revision promotion (auto-supersede) | ✅ |
| 4 | MQTT alerting | ✅ MQTT bridge → events → incident |
| 5 | OPC UA state update | ✅ Bridge → state_change → asset/timeline |
| 6 | ERP sync | ◐ Conflict queue + writeback preview ✅; **no actual ERP adapter** |
| 7 | RFI chain | ◐ RFI is a work-item type; **dedicated RFI link graph (drawing/spec/markup/approval/vendor) not modeled** |
| 8 | Commissioning | ◐ Forms in seed; **no commissioning wizard / system-panel-package links** |
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
| Workspace switcher | ○ Single-workspace UI today |
| Data: tables/frozen columns/timeline/board cards/metric tiles | ✅ |
| Engineering: revision badge/sheet nav/markup toolbar/overlay slider | ✅ |
| Actions: split buttons/signature/automation rule builder | ✅ |
| Single-key quick actions C/G/A | ✅ `core/hotkeys.js` |
| `/go OBJ-ID` palette syntax | ◐ Palette exists; **`/go` parser not implemented** |
| Right panel shows contextual links | ✅ |
| WCAG 2.2 AA contrast | ◐ Tokens pass AA; **no `aria-*` attributes**, no automated a11y checks |
| Keyboard-first office operations | ◐ Many buttons reachable; **no full focus management / roving tabindex** |
| Field mode (glove targets, offline drafts) | ○ Not implemented (no PWA) |

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
| Self-hosted gateway | ◐ No external LLM call; in-browser deterministic responses based on retrieval |
| Tenant-controlled model routing | ◐ UI selector exists; **no actual provider switch** |
| Permission-filtered retrieval | ✅ |
| Mandatory citations | ✅ |
| No-training-by-default | ✅ (policy tag on log entries) |
| Audit of prompt/output/tool calls | ✅ `ai_log` table |

## §15 Search

| Feature | State |
|---|---|
| Unified index over objects, revisions, messages, telemetry events | ✅ |
| Hybrid retrieval (keyword + semantic) | ◐ BM25 + prefix + fuzzy ✅; **no vector embeddings** |
| Facets (object type, project, asset, discipline, status, **date**, **revision**) | ◐ kind/status/discipline/project/teamSpace ✅; **date and revision facets not surfaced** |
| Saved searches | ✅ |
| Alert subscriptions on saved searches | ○ Not implemented |

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
| Observability / tracing | ✅ trace_id in events and AI calls + Prometheus `/metrics` endpoint (`forge_http_requests_total`, latency histograms, `forge_audit_ledger_entries`, `forge_events_total`) |
| Backup / DR | ✅ `server/backup.js backup` / `restore` — SQLite `VACUUM INTO` + files/ tarball, `npm run backup` / `npm run restore` |

## §19 Success metrics

Surfaces in Dashboards screen; metrics computed from the live store.
