# FORGE Product Specification, UX Architecture, and UI System

## 1) Product Definition

### 1.1 Vision
FORGE is a secure, self-hostable engineering collaboration and execution platform for software, industrial automation, construction, manufacturing, and research teams. It unifies communication, planning, technical records, drawing/model review, operations context, and governed AI into one system.

### 1.2 Positioning
FORGE is a private alternative to a combination of Slack + Asana + Notion + technical document control + drawing review + industrial data integration—purpose-built for engineering and operations.

### 1.3 Core Product Goal
Enable teams to communicate, plan, review, document, approve, trace, and execute technical work while preserving deep linkage to engineering context: assets, drawings, revisions, specs, ERP records, forms, incidents, and live data streams.

### 1.4 Design Principles
1. Communication is always tied to work context.
2. Engineering records are first-class objects (not just files).
3. Revisions, approvals, comments, and markups are fully auditable.
4. Data exchange supports enterprise and industrial protocols.
5. Works for office and field/plant users.
6. AI is permission-aware, citation-backed, private, and optional.
7. UI is modern, structured, dense, and credible for technical users.

---

## 2) Product Pillars

1. **Collaboration**: Channels, structured threads, mentions, inbox, notifications, war rooms.
2. **Work Execution**: Work items, boards, tables, timelines, dependencies, operational playbooks.
3. **Engineering Records & Drawing Review**: Controlled revisions, approval workflows, drawing markup, diff/overlay.
4. **Asset Context & Data Exchange**: Asset hierarchies, telemetry, protocol connectors, event normalization.
5. **AI Knowledge & Assistance**: Contextual Q&A, summarization, drafting, impact analysis with citations.
6. **Governance & Security**: RBAC/ABAC, audit logs, SSO, retention, data residency, cryptographic signatures.

---

## 3) Users, Roles, and Primary Jobs

### 3.1 Persona Groups
- Software engineers and architects
- Controls/automation engineers
- Mechanical/electrical/process engineers
- Construction PMs, coordinators, field supervisors
- Manufacturing operations teams
- Reliability/maintenance teams
- Researchers/lab operations teams
- Quality, compliance, and governance teams
- External contractors/vendors (scoped access)

### 3.2 Role Model (Baseline)
- Organization Owner
- Workspace Admin
- Team Space Admin
- Engineer/Contributor
- Reviewer/Approver
- Operator/Technician
- Viewer/Auditor
- Integration Admin
- AI Admin
- External Guest/Vendor

### 3.3 Top Jobs-to-be-Done
- Review and approve technical revisions with full traceability.
- Resolve issues directly from drawings/models with linked tasks.
- Coordinate incidents around alarms, procedures, and live data.
- Map operational data sources to assets and trigger workflows.
- Search and ask AI for trusted, citation-backed answers.

---

## 4) Domain Object Model

All objects include: `id`, `org_id`, `workspace_id`, `created_by`, `created_at`, `updated_at`, `status`, `labels[]`, `acl`, `audit_ref`.

1. **Organization**: tenancy, identity boundaries, policies.
2. **Workspace**: operational environment (e.g., business unit/site/program).
3. **Team Space**: domain collaboration zone with channels/docs/assets.
4. **Project**: scoped initiative with milestones/packages.
5. **Channel**: persistent contextual communication stream.
6. **Thread**: structured discussion under a channel event/message/object.
7. **Work Item**: task/issue/action/RFI/NCR/change with lifecycle.
8. **Document**: logical engineering record container.
9. **Revision**: immutable version instance of a document/drawing.
10. **Drawing**: technical drawing object with sheets and markups.
11. **Markup**: anchored annotation shape/comment/status marker.
12. **Asset**: physical/digital asset with hierarchy and telemetry mappings.
13. **Incident**: operational event with severity, timeline, response.
14. **Approval**: routed decision workflow with signatures.
15. **Form**: structured checklist/template submission.
16. **File**: binary artifact tied to document/revision/record.
17. **Dashboard**: composed widgets from events, telemetry, and KPIs.
18. **Integration**: configured connector (MQTT/OPC UA/ERP/API/etc.).
19. **Data Source**: endpoint/topic/node/table/feed definition.
20. **AI Agent**: scoped assistant with tools, policies, and memory settings.
21. **Audit Event**: immutable log record of all critical actions.

### 4.1 Core Relationships
- Organization → Workspaces → Team Spaces.
- Team Space ↔ Projects ↔ Channels ↔ Threads.
- Document → Revisions → Files/Markups/Approvals.
- Drawing ⊂ Document (or document subtype), linked to Assets and Work Items.
- Asset ↔ Data Sources (MQTT topics, OPC UA nodes, ERP refs).
- Incidents link to Assets, Channels, Work Items, Docs, telemetry events.
- Audit Events link to every object mutation.

---

## 5) Information Architecture and Navigation

### 5.1 Global Layout Shell
- **Far-left rail**: workspace switcher, Home, Inbox, Search, Notifications, AI, Settings.
- **Left panel**: Team Spaces, Channels, Projects, Docs, Drawings, Assets, Dashboards.
- **Main content**: context-dependent views (chat/board/table/timeline/viewers/console).
- **Right context panel**: metadata, links, revisions, approvals, AI insights, activity.
- **Bottom operations dock** (optional): incidents, data health, integration events, live sessions.

### 5.2 Top-level Navigation
1. Home
2. Inbox
3. Search
4. Team Spaces
5. Projects
6. Docs
7. Drawings
8. Assets
9. Dashboards
10. Integrations
11. AI
12. Admin

### 5.3 Cross-Cutting UX Rules
- Every object can be linked, mentioned, subscribed, and audited.
- IDs, revision stamps, and status badges are always visible.
- “Open in context” jumps between related records.
- Global command palette supports object-first navigation (`/go D-101 Rev C`).

---

## 6) Functional Specification by Pillar

### 6.1 Collaboration
- Channel types: Team, Project, Asset, Incident, External.
- Structured threads: issue thread, review thread, decision thread, shift handover thread.
- Message schema supports links to any object, checklist blocks, code/data snippets.
- Watch/follow model for notifications by object and status transitions.

### 6.2 Work Execution
- Work item types: Task, Issue, Action, RFI, Punch, Defect, CAPA, Change Request.
- Views: Kanban, Table, Timeline, Calendar, Dependency map.
- SLA fields, priority/severity, owners, due windows, blocked-by relations.
- Automation rules from integration events.

### 6.3 Engineering Records & Drawing Review
- Native doc viewer (PDF/image/sheet/web records).
- Controlled revision lifecycle:
  - Draft
  - Issued for Review (IFR)
  - Approved
  - Issued for Construction (IFC)
  - Superseded
  - Archived
- Revision compare: side-by-side + overlay + semantic metadata diff.
- Markup with anchored threads and issue creation.
- Approval routing with signer identity and timestamp evidence.
- Transmittals and review cycles linked to revisions.

### 6.4 Asset Context & Data Exchange
- Hierarchies:
  - Plant > Area > Line > Cell > Machine
  - Site > Building > Floor > Room
  - Project > Package > Discipline > Drawing Set
- Asset page unifies drawings, revisions, SOPs, tasks, incidents, dashboards, MQTT topics, OPC UA nodes, ERP records.
- Integration event normalization pipeline:
  - ingest → validate → map → enrich → route → audit → replay.
- Store-and-forward for low connectivity modes.

### 6.5 AI Knowledge & Assistance
- RAG over documents, revisions, channels, tasks, incidents, assets, integrations.
- Mandatory citations and permission-filtered retrieval.
- Skills: summarize review cycles, explain revision deltas, draft reports/transmittals/handover.
- Impact analysis engine: flags potentially affected tasks/assets/approvals on revision changes.

### 6.6 Governance & Security
- SSO (SAML/OIDC), SCIM provisioning, MFA policy enforcement.
- RBAC + optional ABAC (site/discipline/clearance based).
- Immutable audit ledger for critical actions.
- Key management, encryption at rest/in transit, tenant-level retention policies.
- Data residency and export controls.

---

## 7) Engineering Records Detailed Requirements

1. Native document viewer.
2. Revision history timeline and graph.
3. Required revision statuses (Superseded, Draft, Approved, IFR, IFC, Archived).
4. Side-by-side revision comparison.
5. Markup and annotation layer.
6. Pinned comment threads to page region/drawing region/model element.
7. Approval routing and signatures.
8. Linked transmittals and review cycles.
9. Rich metadata schema: discipline, project, package, area, line, system, vendor, revision, approver, effective date.
10. File format support: PDF, image sheets, spreadsheets, browser-viewable records.
11. CAD/model review layer.
12. Schematic/panel review mode.
13. One-click issue/action creation from annotation.

---

## 8) Drawing and Model Viewer Detailed Requirements

- Sheet navigator + mini-map + snap-to-region bookmarks.
- Tools: zoom/pan/measure/callout/compare/overlay.
- Markups: arrows/clouds/highlights/text/stamps/status markers.
- Revision diff + overlay with opacity slider.
- Layer toggle (if source supports layers).
- BIM/IFC mode with object tree and metadata inspector.
- Cross-link panel (drawing ↔ spec ↔ task ↔ asset ↔ discussion).

---

## 9) Data Exchange and Integration Architecture

### 9.1 Protocol and Connector Layer
- **MQTT**: topic subscriptions, QoS controls, retained messages, namespace governance.
- **OPC UA**: client/server mode, namespace browsing, node mapping, semantic model support.
- **REST/Webhooks**: inbound/outbound events, signed callbacks, retries.
- **ERP/MES/CMMS/Historians/Doc repos** via connector adapters.

### 9.2 Event Normalization Contract
Canonical event envelope:
- `event_id`, `source`, `source_type`, `received_at`
- `asset_ref`, `project_ref`, `object_refs[]`
- `severity`, `event_type`, `payload`, `trace_id`
- `routing_policy`, `dedupe_key`, `auth_context`

### 9.3 Rule Engine Outcomes
- Notify channel/thread.
- Create/update incident.
- Create/update work item.
- Append contextual timeline entry.
- Trigger approval or escalation.

### 9.4 Reliability and Audit
- Exactly-once semantics where possible (idempotency keys otherwise).
- Dead-letter queues + replay controls.
- Signed integration audit records and operator-visible diagnostics.

---

## 10) Required Engineering Workflows

1. **Drawing ingestion**: upload → revision parse → metadata extract → reviewer assignment.
2. **Review cycle**: reviewer markup → issue link → route approval.
3. **Revision promotion**: approved revision set current; prior set superseded.
4. **MQTT alerting**: event from site/line triggers contextual asset alert room thread.
5. **OPC UA state update**: node value update changes asset state, logs timeline, optional incident trigger.
6. **ERP sync**: purchase/work-order event creates or updates work item.
7. **RFI chain**: RFI linked to drawing/spec/markup/approval/vendor response.
8. **Commissioning**: checklist links to system/panel/package/issues.
9. **Incident war room**: alarms, docs, procedures, tasks, and timeline in one live space.

---

## 11) Screen-by-Screen UX Architecture

For each screen: layout anatomy, components, states, interactions, permissions, responsive behavior, AI affordances, audit placement.

### 11.1 Workspace Home
- **Layout**: summary grid + activity feed + priority queues.
- **Components**: KPIs, assigned work, review queue, incidents snapshot, integration health widgets.
- **States**: normal, no-data, degraded integrations, incident surge.
- **Interactions**: quick create, pin dashboard, jump to object.
- **Permissions**: hides unauthorized team spaces/projects.
- **Responsive**: collapses to stacked cards for tablets/mobile.
- **AI**: “Daily engineering brief” and risk highlights.
- **Audit**: last critical actions tile.

### 11.2 Team Space Overview
- **Layout**: header + channel/project/doc/asset tabs.
- **Components**: membership panel, active threads, milestones, recent revisions.
- **States**: active, archived, restricted.
- **Interactions**: create channel/project/doc, invite scoped users.
- **Permissions**: team-space ACL governs visibility/actions.
- **Responsive**: tab condense to segmented control.
- **AI**: summarize current blockers and changes.
- **Audit**: team activity stream in right panel.

### 11.3 Channel with Structured Threads
- **Layout**: message stream center, thread drawer right.
- **Components**: composer, pinned objects, thread type badges.
- **States**: live, read-only, incident-locked, external-collab mode.
- **Interactions**: convert message to work item, link revision, escalate to incident.
- **Permissions**: posting/mention restrictions by role.
- **Responsive**: thread drawer becomes full-screen panel on mobile.
- **AI**: summarize unread, draft response with citations.
- **Audit**: message edit/delete and decision log markers inline.

### 11.4 Work Board
- **Layout**: board/table toggle with filters and swimlanes.
- **Components**: cards with severity/SLA/dependencies.
- **States**: backlog, active sprint/window, frozen release.
- **Interactions**: drag state change, bulk update, dependency creation.
- **Permissions**: state transition rights and field-level lock.
- **Responsive**: table-first on narrow viewports.
- **AI**: suggest prioritization and due-date risk.
- **Audit**: per-card history drawer.

### 11.5 Document Viewer with Revision History
- **Layout**: doc canvas center, revision timeline right, metadata top.
- **Components**: page nav, comment pins, approval banner.
- **States**: draft, IFR, approved, IFC, superseded, archived.
- **Interactions**: open previous rev, diff, create approval request.
- **Permissions**: watermark/download control by classification.
- **Responsive**: page pane focus mode; metadata collapsible.
- **AI**: ask-document, summarize changes, propose transmittal text.
- **Audit**: revision action ledger under timeline.

### 11.6 Drawing Viewer with Markup Tools
- **Layout**: toolbars top/left, drawing canvas center, object context right.
- **Components**: sheet list, markup palette, measurement tool, issue link button.
- **States**: view-only, markup-edit, compare-overlay.
- **Interactions**: create markup, anchor thread, convert to issue.
- **Permissions**: markup rights by discipline/role.
- **Responsive**: simplified toolset on tablets.
- **AI**: detect notable changed regions and summarize markup clusters.
- **Audit**: markup provenance panel.

### 11.7 Side-by-Side Revision Compare
- **Layout**: split panes with synchronized pan/zoom.
- **Components**: change legend, opacity slider, metadata diff list.
- **States**: identical, changed, conflict/unresolved review.
- **Interactions**: approve change set, open linked tasks.
- **Permissions**: compare visible revisions only.
- **Responsive**: toggled A/B mode instead of split on small screens.
- **AI**: explain likely engineering impact of changes.
- **Audit**: compare session and decision history strip.

### 11.8 Asset Detail Page
- **Layout**: header identity + tabbed context + telemetry side panel.
- **Components**: hierarchy breadcrumb, linked drawings/docs/tasks/incidents/dashboards/data mappings.
- **States**: normal, warning, alarm, offline.
- **Interactions**: open war room, add work item, inspect node/topic events.
- **Permissions**: sensitive asset masking and control-action gating.
- **Responsive**: telemetry dock collapses under tabs.
- **AI**: “What changed on this asset in last 24h?”
- **Audit**: asset timeline includes user + machine events.

### 11.9 Integration Console
- **Layout**: connector list left, config and logs center/right.
- **Components**: health status, retry queue, dead-letter browser, credentials vault refs.
- **States**: connected, degraded, failed, maintenance.
- **Interactions**: test connection, replay event, rotate credentials.
- **Permissions**: integration-admin only for writes.
- **Responsive**: log panel collapses into tabs.
- **AI**: explain recurring connector failures.
- **Audit**: immutable integration change log.

### 11.10 MQTT Topic Browser & Mapping
- **Layout**: topic tree left, payload inspector center, mapping rules right.
- **Components**: QoS/retain indicators, namespace policy checker.
- **States**: subscribed, paused, disconnected.
- **Interactions**: map topic to asset/event type, simulate message.
- **Permissions**: publish rights strictly separated from subscribe.
- **Responsive**: tree + inspector stacked.
- **AI**: suggest topic taxonomy and mapping anomalies.
- **Audit**: topic mapping revisions and publish tests logged.

### 11.11 OPC UA Browser & Node Mapping
- **Layout**: endpoint/session panel, node tree, mapping editor.
- **Components**: namespace browser, datatype validator, sampling controls.
- **States**: session active, cert warning, endpoint unavailable.
- **Interactions**: browse nodes, bind node to asset signal, validate transform.
- **Permissions**: endpoint credentials hidden; write-node ops gated.
- **Responsive**: node tree collapsible drawer.
- **AI**: suggest semantic mappings and unit normalization.
- **Audit**: node mapping and write attempts logged.

### 11.12 ERP Integration Mapping
- **Layout**: entity mapping matrix with transformation rules.
- **Components**: PO/work-order/inventory object mapping, sync status.
- **States**: in-sync, drift detected, conflict.
- **Interactions**: resolve conflict, backfill records, preview writeback.
- **Permissions**: finance/procurement scoped access.
- **Responsive**: row detail drawer on mobile.
- **AI**: detect mapping drift and recommend fixes.
- **Audit**: every writeback and conflict decision recorded.

### 11.13 Incident War Room
- **Layout**: live timeline center, alarms/data strip top, tasks/docs/procedures side.
- **Components**: severity header, comms thread, command checklist, role roster.
- **States**: active, escalated, stabilized, resolved, postmortem.
- **Interactions**: assign commander, open bridge, create action items.
- **Permissions**: command roles can alter severity/status.
- **Responsive**: focus on timeline + actions on field devices.
- **AI**: live incident summary and recommended next steps.
- **Audit**: immutable command log and timeline export.

### 11.14 Approval Queue
- **Layout**: queue table + object preview pane.
- **Components**: signature status, SLA timer, delegation controls.
- **States**: pending, approved, rejected, expired, delegated.
- **Interactions**: sign with reason, request changes, batch approve.
- **Permissions**: approver matrix enforcement.
- **Responsive**: compact list with detail modal.
- **AI**: summarize pending risk and highlight unusual changes.
- **Audit**: signature evidence and chain-of-custody panel.

### 11.15 AI Workspace
- **Layout**: multi-thread assistant console with source panel.
- **Components**: scoped query builder, citations viewer, output templates.
- **States**: ready, retrieval-limited, policy-blocked.
- **Interactions**: run Q&A, generate report, compare revisions via AI.
- **Permissions**: inherits object permissions; no privilege escalation.
- **Responsive**: single-column chat + expandable citations.
- **AI**: primary function; model/router selector if policy allows.
- **Audit**: prompt/output/tool call logs with retention policy.

### 11.16 Admin Governance Console
- **Layout**: policy nav left, settings center, audit analytics right.
- **Components**: SSO config, role matrices, retention, DLP, key management.
- **States**: compliant, warning, policy violation.
- **Interactions**: change policy, run access review, export audit pack.
- **Permissions**: admin and auditor scoped areas.
- **Responsive**: section-by-section wizard mode.
- **AI**: policy impact explainer (read-only advisory).
- **Audit**: full governance event stream.

---

## 12) UI System (Design Language)

### 12.1 Visual Principles
- Dense but readable layouts.
- High information hierarchy with persistent status signals.
- Neutral industrial color base + semantic accents.
- Consistent iconography for object types and statuses.

### 12.2 Tokens (Example)
- Spacing scale: 4/8/12/16/24/32.
- Radius: 4 (controls), 8 (cards), 12 (modals).
- Typography: Inter/IBM Plex Sans + JetBrains Mono for IDs/data.
- Color roles: surface, elevated, border, text-strong, text-muted, success, warning, danger, info, revision-state colors.

### 12.3 Component Families
- Navigation: rails, trees, breadcrumbs, command palette.
- Data: tables with frozen columns, timeline, board cards, metric tiles.
- Engineering: revision badge, sheet navigator, markup toolbar, overlay slider.
- Actions: split buttons, approval/signature controls, automation rule builders.
- Context: object chips, relation graph cards, audit event rows.

### 12.4 Interaction Patterns
- Single-key quick actions (`C` create, `G` go, `A` assign).
- Right panel always shows contextual links and activity.
- Optimistic updates only for reversible actions; approvals/signatures require confirmation.

### 12.5 Accessibility & Field Usability
- WCAG 2.2 AA contrast.
- Keyboard-first operations for office users.
- Glove-friendly target sizes and offline drafts for field mode.

---

## 13) Permissions, Security, and Compliance

### 13.1 Access Control Model
- RBAC baseline with optional ABAC overlays (site, discipline, project, clearance).
- Object-level ACL + field-level sensitivity tags.

### 13.2 Security Controls
- Encryption in transit (TLS 1.2+) and at rest (tenant keys optional).
- Signed approvals and tamper-evident audit trails.
- Secret vault integration for connector credentials.

### 13.3 Compliance/Policy
- Retention and legal hold policies.
- Exportable immutable audit packs.
- Regional data residency controls.

---

## 14) AI Architecture and Policy Model

- Self-hosted AI gateway with policy guardrails.
- Tenant-controlled model routing (local/open/enterprise models).
- Retrieval index with permission-filtered chunks and source citations.
- Configurable retention: no-training-by-default on tenant data.
- AI actions always produce auditable execution records.

---

## 15) Search and Knowledge Architecture

- Unified index over objects, revisions, messages, telemetry events.
- Hybrid retrieval (keyword + semantic).
- Facets: object type, project, asset, discipline, status, date, revision.
- Saved searches and alert subscriptions.

---

## 16) Open-Source Reference Mapping

- Collaboration patterns: Mattermost-inspired channel/thread mechanics.
- PDF rendering: PDF.js-based viewer foundation.
- Model review: IFC/BIM viewer-compatible architecture.
- OPC UA: open62541/Eclipse Milo pattern alignment.
- MQTT: EMQX-compatible semantics and operational tooling concepts.
- Industrial protocol expansion: Apache PLC4X reference direction.
- Identity: Keycloak-compatible SSO/SCIM architecture.
- Search: OpenSearch-compatible indexing and retrieval.
- AI: self-hosted gateway with strict policy enforcement.

---

## 17) Delivery Roadmap

### 17.1 MVP
1. Team Spaces
2. Channels + threads
3. Work items + boards
4. Document viewer
5. Revision control + approvals
6. Drawing markup
7. Asset pages
8. MQTT + REST integration foundation
9. OPC UA connector foundation
10. Search
11. AI summaries + document Q&A
12. SSO + audit logs

### 17.2 Phase 2
1. IFC-rich model review
2. ERP connector packs
3. Digital transmittals
4. Advanced drawing compare
5. Field mode
6. Shift handover
7. Construction/manufacturing templates
8. Rich incident workflow playbooks

### 17.3 Phase 3
1. Advanced AI agents
2. Edge sync
3. Historian/MES deep integrations
4. Federation across organizations
5. Predictive engineering analytics
6. Digital twin overlays

---

## 18) Non-Functional Requirements

- Performance: sub-200ms p95 for common navigation actions in LAN deployments.
- Availability: 99.9%+ target for core collaboration; buffered ingestion during connector outages.
- Scalability: multi-site tenants with high-frequency telemetry bursts.
- Observability: full tracing for UI action ↔ API ↔ connector pipeline.
- Backup/DR: policy-based backups with tenant-level restore scopes.

---

## 19) Success Metrics

### 19.1 Adoption
- Weekly active technical users by role.
- Cross-object linking rate (messages with object references).

### 19.2 Execution
- Mean time from revision upload to approval.
- Work item cycle time and SLA compliance.

### 19.3 Quality and Safety
- Incident MTTR reduction.
- Rework caused by revision confusion (target down).

### 19.4 Data Reliability
- Integration event success/replay rates.
- Mapping coverage across critical assets.

### 19.5 AI Trust
- Citation usage rate.
- Hallucination/invalid reference incident rate.

