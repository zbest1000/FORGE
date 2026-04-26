# FORGE Open-Source Competitive Analysis

## 1. Executive Summary

FORGE is not a direct replacement for one open-source product. It is trying to
replace a stack that many industrial and engineering teams assemble from
multiple tools:

- OpenProject, Redmine, Taiga, Tuleap, or Plane for project/work tracking.
- Mayan EDMS, Paperless-ngx, OpenDocMan, OpenKM, Alfresco Community, Nextcloud,
  or SeedDMS for document management.
- openMAINT, Atlas CMMS, SuperCMMS, ERPNext, Odoo Community, GLPI, or Snipe-IT
  for assets, maintenance, inventory, and service work.
- ThingsBoard, OpenRemote, FIWARE, Eclipse Ditto/Kapua/Hono, Grafana, Node-RED,
  EMQX, Mosquitto, and n8n for operations data and integration workflows.
- Mattermost, Zulip, Matrix, Nextcloud Talk, or GitLab issues for collaboration.

FORGE's opportunity is to become the enterprise layer that connects these
domains around engineering objects: projects, assets, controlled documents,
drawings, work, approvals, operations signals, maintenance, incidents, and audit.

The current codebase already demonstrates the full product shape, but it is
still prototype-level in persistence depth, data model normalization, workflow
configuration, mobile/field UX, and connector maturity.

## 2. Current FORGE Coverage

### Implemented strengths

- Shell, command palette, search, contextual navigation, role gates, and
  demo/server modes exist in `app.js`, `src/shell/*`, `src/core/*`, and
  `src/screens/*`.
- Work boards, documents, drawing review, assets, incidents, approvals, AI,
  integrations, UNS, and i3X all have UI surfaces in `src/screens/*`.
- The server includes Fastify, SQLite, JWT/API tokens, ACL/ABAC hooks, FTS,
  GraphQL, webhooks, files, audit packs, metrics, MQTT, OPC UA, n8n proxy, CAD,
  and i3X routes in `server/*`.
- The seed model now includes enterprise/site/location hierarchy, optional
  project-to-asset references, scoped documents, operations signal state, and
  service work records in `src/data/seed.js`.
- Project and asset pages now surface linked assets, scoped documents,
  operations signal health, service work, and activity timelines in
  `src/screens/workBoard.js` and `src/screens/assetDetail.js`.

### Main remaining gap

FORGE is broad, but many capabilities are still demo objects rather than
durable product systems. The next phase should turn seed-only relationships into
server-backed models, then make each workflow configurable, auditable,
permission-aware, and mobile/field ready.

## 3. Comparison by Replacement Category

| Category | OSS tools to beat or integrate | OSS strengths | FORGE advantage | FORGE gaps |
|---|---|---|---|---|
| Project/work management | OpenProject, Redmine, Taiga, Tuleap, Plane, GitLab | Mature issue workflows, agile boards, Gantt, time/cost tracking, plugins | Work is linked to documents, drawings, assets, incidents, approvals, operations signals, and audit | No configurable workflows, no custom fields, no true saved views, no time/cost tracking, no portfolio/resource planning |
| Engineering document control | Mayan EDMS, Alfresco Community, OpenKM, OpenDocMan, SeedDMS, Paperless-ngx, Nextcloud | OCR, check-in/out, metadata, workflow engines, document inbox, full-text search, APIs | Revision safety, approval chain, drawing context, asset/project scope, transmittals, engineering-specific states | No OCR pipeline, no file lifecycle depth, no metadata templates, no rendition service, no legal hold UX beyond prototype |
| Drawings/CAD/BIM review | LibreDWG, DXF viewers, web-ifc, Online3DViewer, FreeCAD ecosystem | Specialized file rendering and conversion | Drawings are linked to work, docs, issues, assets, and revision control | Needs production-grade model viewer, large file strategy, markup permissions, offline review, compare workflows |
| Asset and maintenance | openMAINT, Atlas CMMS, SuperCMMS, ERPNext, Odoo Community, GLPI, Snipe-IT | Asset trees, PMs, work orders, inventory, mobile work execution | Asset context combines engineering docs, projects, signals, incidents, service work, and audit | No server-backed maintenance tables, PM schedules, parts inventory, labor/time capture, mobile technician mode |
| Industrial operations data | ThingsBoard, OpenRemote, FIWARE, Eclipse Ditto/Kapua/Hono, Grafana, Node-RED | Device onboarding, telemetry storage, dashboards, rule chains, alarms, scale | FORGE treats operations signals as context for engineering decisions, not as the whole product | No time-series database, device registry, alarm rules engine UI, high availability, historian connector, edge sync |
| Integration automation | Node-RED, n8n, Huginn, Apache NiFi, Airbyte | Visual flows, adapters, retries, transformations | FORGE can gate integrations with engineering permissions and audit | Mapping UI is shallow; no connector marketplace, versioned mappings, test suites, replay workbench, secret rotation UX |
| Collaboration | Mattermost, Zulip, Matrix, Nextcloud Talk, GitLab discussions | Mature chat, federation, notifications, moderation | Object-linked discussions are more useful for engineering work | No real-time multi-user state, push notifications, threaded notification rules, external/vendor collaboration model |
| Governance/audit | Keycloak, Open Policy Agent, Wazuh, OpenSearch, Vault | Identity, policy, SIEM, key management | Hash-chained audit and signed approvals are built around engineering records | No OIDC/SCIM/MFA production flow, no policy engine UI, no SIEM export, no key rotation workflow |
| AI knowledge | AnythingLLM, Dify, Open WebUI, Langfuse, RAGFlow | Prompt tooling, RAG pipelines, observability, provider choice | FORGE can scope AI to permissions, docs, revisions, assets, incidents, and audit | No embeddings/vector store yet, weak source controls, no AI governance admin, no evaluation harness |

## 4. Where FORGE Can Win

### 4.1 Unified engineering object graph

Most OSS tools are strong in one domain. FORGE can win by making relationships
first-class:

- Project -> assets -> documents -> drawings -> revisions -> approvals.
- Asset -> operations signals -> incidents -> service work -> timeline.
- Document -> revision -> approval -> transmittal -> audit pack.
- Incident -> asset -> procedures -> decisions -> postmortem.

Current code has the start of this graph in `src/data/seed.js`,
`src/screens/workBoard.js`, and `src/screens/assetDetail.js`. The next step is
to normalize it into server tables and APIs.

### 4.2 Enterprise UX over domain-tool density

Open-source industrial tools often show device trees, dashboards, rule chains,
or dense admin tables first. FORGE should keep operational depth but default to:

- "What needs attention?"
- "What object am I looking at?"
- "What changed?"
- "What is safe to act on?"
- "What is linked?"

The new project and asset context panels are a good direction, but they should
become reusable page templates rather than custom code in each screen.

### 4.3 Governance as product value

Many OSS stacks can be self-hosted but leave audit, approval traceability,
retention, AI boundaries, and permission explanations fragmented across tools.
FORGE can differentiate with:

- Signed approvals.
- Hash-chained audit packs.
- Permission-visible AI.
- Object-level access explanations.
- Revision safety banners.
- Exportable incident/postmortem records.

## 5. Where OSS Still Beats FORGE

### 5.1 Work management depth

OpenProject and Redmine are deeper in:

- Configurable workflows.
- Custom fields.
- Time tracking.
- Gantt and portfolio planning.
- Per-project roles.
- Plugin ecosystems.

FORGE should not copy every feature. It should implement industrial-specific
work depth: RFIs, punch lists, CAPAs, NCRs, maintenance, commissioning, and
linked document/drawing context.

### 5.2 Document management depth

Mayan EDMS, Alfresco, OpenKM, and OpenDocMan are deeper in:

- OCR and ingestion pipelines.
- Metadata templates.
- Document classification.
- Check-in/check-out.
- Version/rendition management.
- Workflow engines.
- Records management.

FORGE should prioritize controlled engineering records over generic DMS breadth:
revision states, approval consequences, transmittals, superseded warnings,
watermarks, external package issue, and audit export.

### 5.3 Maintenance and asset operations depth

openMAINT, Atlas CMMS, SuperCMMS, ERPNext, Odoo, GLPI, and Snipe-IT are deeper
in:

- Preventive maintenance schedules.
- Work order execution.
- Mobile technician flows.
- Parts and inventory.
- Labor/time tracking.
- Asset depreciation or cost history.

FORGE should integrate or wrap these systems first. Native FORGE maintenance
should focus on engineering/service context, not full ERP asset accounting.

### 5.4 Industrial data depth

ThingsBoard, OpenRemote, FIWARE, Eclipse projects, Grafana, and Node-RED are
deeper in:

- Device lifecycle.
- Telemetry storage.
- Rule chains.
- Dashboards and widgets.
- Alarm engines.
- Edge deployments.
- Connector ecosystems.

FORGE should not become a SCADA dashboard. It should show operations signals as
decision context and route users into specialized tools only when needed.

## 6. Product Improvements to Prioritize

### Phase A: Make the object graph durable

| Task | File/component | Why | Suggested fix | Priority |
|---|---|---|---|---|
| Add server-backed locations | `server/db.js`, `server/routes/core.js`, `src/data/seed.js` | Seed-only hierarchy will not survive real data | Add `locations` table and REST/GraphQL reads | P1 |
| Add project-asset membership | `server/db.js`, `server/routes/core.js`, `workBoard.js` | Projects can reference assets without owning them | Add `project_assets` join table with role/scope fields | P1 |
| Add document scopes | `server/db.js`, `docViewer.js`, `docs index` | Global/site/project/asset docs need consistent visibility | Add `document_scopes` table and filters | P1 |
| Add service work records | `server/db.js`, `assetDetail.js`, `workBoard.js` | MaintainX-style data is currently demo-only | Add `service_work` table with external source/id/status | P1 |
| Add operations signal status records | `server/db.js`, `events.js`, `assetDetail.js` | Signal health needs history and stale detection | Add `signal_bindings` + last-known status rollup | P1 |

### Phase B: Improve UX patterns

| Task | File/component | Why | Suggested fix | Priority |
|---|---|---|---|---|
| Convert project context to tabs | `workBoard.js` | Context panels still push board content down | Tabs: Overview, Assets, Docs, Signals, Service, Activity | P1 |
| Convert asset page to tabs | `assetDetail.js` | Asset page is still too stacked | Tabs: Summary, Docs, Work, Signals, Service, Incidents, Activity | P1 |
| Build shared context components | `src/core/ui.js`, new `src/core/context.js` | Project and asset pages duplicate list/badge logic | Add `ContextCard`, `SignalStatus`, `ScopedDocList`, `ActivityFeed` | P2 |
| Add hover/help primitive | `src/core/ui.js`, `styles.css` | Help dots are screen-local | Promote `helpHint()` into shared UI helper with keyboard accessible tooltip | P2 |
| Add saved views | `workBoard.js`, `store.js` | OpenProject/Redmine class tools win on saved workflow views | Persist role/project filters and default views | P1 |

### Phase C: Replace stack tools intentionally

| Stack replaced | FORGE should own | FORGE should integrate |
|---|---|---|
| OpenProject/Redmine | Industrial object-linked work, approvals, RFIs, punch, CAPA | Time/cost/accounting if needed |
| Mayan/Alfresco/OpenKM | Engineering revision safety, transmittals, drawing-linked review | OCR/renditions/search backends |
| openMAINT/CMMS | Asset engineering context and service visibility | PM schedules, parts, mobile work orders |
| ThingsBoard/OpenRemote/Grafana | Signal context and stale/live health in work decisions | Telemetry storage, dashboards, device lifecycle |
| Node-RED/n8n/NiFi | Audited connector setup and mapping governance | Flow execution and long-running workflow engine |
| Mattermost/Zulip/Matrix | Object-linked decisions and audit-friendly threads | High-volume chat/federation if needed |

## 7. Specific UX Improvements Found

1. **Use "operations signal" language consistently.** Avoid raw terms like DAQ
   unless the user is in an integration/admin screen.
2. **Use hover help for relationship explanations.** Keep pages calm; let users
   hover for details about why a document or asset appears.
3. **Separate project activity from work board activity.** Project activity
   should include docs, signals, service, incidents, and approvals. The work
   board timeline should remain work-item specific.
4. **Make scoped document rules visible.** A document row should reveal why it is
   shown: enterprise, site, project, or asset scope.
5. **Avoid one-screen industrial density.** Asset pages should show summary first
   and move signal mappings, service records, and incident history behind tabs.
6. **Make external source identity clear.** Service work rows should show
   MaintainX/SAP PM/Maximo/Fiix/UpKeep identity and external record id.
7. **Add "open in source system."** For integrated service work or signal
   systems, add a safe outbound link pattern with permissions and audit.
8. **Add freshness rules.** Operations signals need explicit "live", "stale",
   "disconnected", "simulated", and "historical" definitions.
9. **Improve field mode.** Technicians need large tap targets, offline state,
   service work checklists, and asset QR lookup.
10. **Add admin mapping governance.** Integrations should support draft mappings,
    validation, approval, publish, rollback, replay, and audit.

## 8. Implementation Notes

- Keep the OSS-first rule. Use specialized OSS engines where they are already
  strong; FORGE should own the cross-domain engineering object experience.
- Prefer adapters over replacements for mature domains like telemetry storage,
  OCR, CMMS, and chat.
- Preserve self-hostability and auditability as differentiators.
- Treat UX calmness as a feature: default views should explain less on screen and
  reveal details through context, hover, drill-down, and command/search.

