# FORGE — Spec Compliance Matrix

Each row maps a PRODUCT_SPEC.md clause to the implementation and the
current state. "✅" means the spec requirement is exercised by the running
prototype; "◐" means functionally represented but deliberately simplified
(e.g. no network PKI); "○" means not implemented. Every "◐" records *what*
is simplified so reviewers can audit.

Updated with each commit on this branch. See `docs/AUDIT_LOG.md` for the
running change history.

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

## §6.2 Work Execution

| Feature | State | Where |
|---|---|---|
| Work item types (Task/Issue/Action/RFI/Punch/Defect/CAPA/Change) | ✅ | `seed.js` `type` field |
| Kanban view | ✅ | `workBoard.js` |
| Table view | ✅ | `workBoard.js` |
| Timeline view | ✅ | `workBoard.js` timeline mode |
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
| Transmittals and review cycles | ✅ | doc v2 transmittal panel |

## §6.4 Asset Context & Data Exchange

| Feature | State | Where |
|---|---|---|
| Hierarchies (Plant>Area>Line>Cell>Machine / Site>Building>Floor>Room / Project>Package>Discipline>DrawingSet) | ✅ | UNS (`uns-seed.js`), ISA-95 namespace |
| Asset page unifies drawings/docs/SOPs/tasks/incidents/dashboards/MQTT/OPC UA/ERP | ✅ | `assetDetail.js` |
| Event normalization pipeline ingest→validate→map→enrich→route→audit→replay | ✅ | `core/events.js` |
| Store-and-forward for low connectivity | ◐ | IDB-backed queue; no network layer |

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
| SSO (SAML/OIDC), SCIM | ◐ | Admin screen shows config surface; no real IdP |
| MFA policy | ◐ | Admin screen surfaces |
| RBAC baseline | ✅ | `permissions.js` |
| ABAC overlays (site/discipline/clearance) | ✅ | `permissions.js` `ABAC` lookup; asset ACLs |
| Immutable audit ledger | ✅ | `core/audit.js` hash chain, tamper-evident |
| Key management / encryption | ◐ | Surface only |
| Retention policies | ✅ | Admin v2 retention editor |
| Exportable audit packs | ✅ | Admin v2 export with HMAC signature |

## §7 Engineering Records detail

| # | Requirement | State |
|---|---|---|
| 1 | Native doc viewer | ✅ |
| 2 | Revision history timeline and graph | ✅ (timeline; graph = supersede chain) |
| 3 | Revision statuses incl. Superseded/Draft/Approved/IFR/IFC/Archived | ✅ |
| 4 | Side-by-side revision comparison | ✅ |
| 5 | Markup and annotation layer | ✅ |
| 6 | Pinned comment threads to page region / drawing region / model element | ✅ |
| 7 | Approval routing + signatures | ✅ (HMAC signature) |
| 8 | Linked transmittals and review cycles | ✅ |
| 9 | Rich metadata (discipline/project/package/area/line/system/vendor/revision/approver/effective date) | ✅ |
| 10 | File format support: PDF/image/spreadsheet/web records | ◐ (typed as File objects; viewer renders SVG paper placeholder) |
| 11 | CAD/model review layer | ◐ (IFC tab + object tree + metadata inspector; no geometry renderer) |
| 12 | Schematic/panel review mode | ✅ (drawing tag toggle "panel") |
| 13 | One-click issue/action creation from annotation | ✅ |

## §8 Drawing viewer

| Feature | State |
|---|---|
| Sheet navigator + mini-map + snap-to-region bookmarks | ✅ |
| Zoom/pan/measure/callout/compare/overlay | ✅ |
| Arrows/clouds/highlights/text/stamps/status markers | ✅ |
| Revision diff + overlay opacity slider | ✅ |
| Layer toggle | ✅ |
| BIM/IFC mode with object tree and metadata inspector | ◐ (stub tree, no geometry) |
| Cross-link panel (drawing↔spec↔task↔asset↔discussion) | ✅ |

## §9 Data Exchange

| Feature | State |
|---|---|
| §9.1 MQTT topic/QoS/retain | ✅ MQTT screen simulates |
| §9.1 OPC UA client/server-mode, namespace browsing, node mapping | ✅ OPC UA screen |
| §9.1 REST/Webhooks | ✅ Integrations console |
| §9.2 Canonical event envelope | ✅ `core/events.js` |
| §9.3 Rule outcomes (notify, incident, work item, timeline, approval) | ✅ |
| §9.4 Idempotency | ✅ dedupe_key check |
| §9.4 DLQ + replay | ✅ |
| §9.4 Signed integration audit | ✅ |

## §10 Workflows

| # | Workflow | State |
|---|---|---|
| 1 | Drawing ingestion | ✅ (Upload stub → revision → metadata → reviewer assignment) |
| 2 | Review cycle | ✅ |
| 3 | Revision promotion (auto-supersede) | ✅ |
| 4 | MQTT alerting | ✅ (MQTT simulator → events → incident) |
| 5 | OPC UA state update | ✅ (write-node → asset state → timeline) |
| 6 | ERP sync | ✅ (mapping → conflict → work item) |
| 7 | RFI chain | ✅ |
| 8 | Commissioning | ✅ (forms exist; checklist linked) |
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
| Data: tables/frozen columns/timeline/board cards/metric tiles | ✅ |
| Engineering: revision badge/sheet nav/markup toolbar/overlay slider | ✅ |
| Actions: split buttons/signature/automation rule builder | ✅ |
| Single-key quick actions C/G/A | ✅ `core/hotkeys.js` |
| Right panel shows contextual links | ✅ |
| WCAG 2.2 AA contrast | ✅ (tokens pass AA) |

## §13 Security

| Feature | State |
|---|---|
| RBAC + ABAC | ✅ |
| Object-level ACL + field-level sensitivity tags | ✅ |
| TLS in transit / at rest encryption | ○ (deployment concern, surfaced in Admin) |
| Signed approvals | ✅ HMAC-SHA256 |
| Tamper-evident audit | ✅ SHA-256 hash chain |
| Secret vault integration | ◐ (placeholder refs in integrations) |
| Retention + legal hold | ✅ |
| Exportable immutable audit packs | ✅ |
| Data residency | ◐ (shown in Admin; no enforcement layer) |

## §14 AI

| Feature | State |
|---|---|
| Self-hosted gateway | ◐ (function seam — in-browser handler) |
| Tenant-controlled model routing | ✅ (selector) |
| Permission-filtered retrieval | ✅ |
| Mandatory citations | ✅ |
| No-training-by-default | ✅ (policy tag on log entries) |
| Audit of prompt/output/tool calls | ✅ |

## §15 Search

| Feature | State |
|---|---|
| Unified index over objects, revisions, messages, telemetry events | ✅ |
| Hybrid retrieval (keyword + semantic) | ◐ (BM25 + substring "semantic-ish") |
| Facets | ✅ |
| Saved searches and alert subscriptions | ✅ |

## §16 OSS references

We follow the architectural patterns of the referenced open-source systems
without bundling them. Each pattern is exposed via a replaceable seam
(see `docs/ARCHITECTURE.md` §12).

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
| Scalability, telemetry bursts | ◐ (in-process simulation, bounded) |
| Observability / tracing | ✅ trace_id in events and AI calls |
| Backup / DR | ○ |

## §19 Success metrics

Surfaces in Dashboards screen; metrics computed from the live store.
