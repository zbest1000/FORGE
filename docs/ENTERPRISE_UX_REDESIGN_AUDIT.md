# FORGE Enterprise UI/UX Redesign Audit

## A. Executive Summary

FORGE is technically broad and credible, but the current UI reads as prototype-to-advanced-demo rather than enterprise-ready SaaS. The code already covers collaboration, documents, drawings, work, incidents, assets, MQTT, OPC UA, UNS/i3X, AI, admin, audit, and server APIs. The main gap is experience architecture: too many advanced capabilities are visible at once through a permanent rail, left tree, header controls, right context panel, dock, KPI grids, badges, and dense toolbars.

The desired direction is a calmer enterprise product: role-based homes, simpler primary navigation, contextual secondary navigation, progressive disclosure for industrial/engineering depth, stronger document-control affordances, and a reusable design system layer.

## B. Product Experience Diagnosis

- FORGE currently exposes breadth before intent. `src/shell/rail.js` lists 15 primary destinations, `src/shell/leftPanel.js` simultaneously lists spaces, channels, projects, docs, drawings, and assets, `src/shell/contextPanel.js` always adds role and audit cards, and `src/shell/dock.js` adds another persistent operational surface.
- Many screens use dashboard-like grids even when the task is workflow-driven. Examples include `src/screens/home.js`, `src/screens/assetDetail.js`, `src/screens/integrations.js`, `src/screens/mqtt.js`, `src/screens/opcua.js`, and `src/screens/dashboards.js`.
- The frontend has good primitives, but not yet a product design system. `src/core/ui.js` provides `card`, `table`, `badge`, `modal`, and form helpers, while `styles.css` has tokens and component classes; screens still compose custom layouts, inline styles, emojis, hardcoded button labels, and bespoke side panels.
- Enterprise risk is highest in revision/approval clarity, industrial write actions, AI source boundaries, and permission visibility. These exist in code, but they need clearer UX patterns before customers can safely adopt the product.

## C. Application Map

### Structure

- Static SPA entry: `index.html`, `app.js`, `styles.css`.
- Shell: `src/shell/rail.js`, `src/shell/header.js`, `src/shell/leftPanel.js`, `src/shell/contextPanel.js`, `src/shell/dock.js`.
- Shared UI and state: `src/core/ui.js`, `src/core/router.js`, `src/core/store.js`, `src/core/palette.js`, `src/core/screens-registry.js`, `src/core/permissions.js`, `src/core/groups.js`, `src/core/api.js`.
- Screens: `src/screens/home.js`, `inbox.js`, `search.js`, `teamSpaces.js`, `channel.js`, `workBoard.js`, `docViewer.js`, `revisionCompare.js`, `drawingViewer.js`, `assetDetail.js`, `incident.js`, `approvals.js`, `ai.js`, `integrations.js`, `mqtt.js`, `opcua.js`, `erp.js`, `uns.js`, `i3x.js`, `dashboards.js`, `admin.js`, `spec.js`.
- Server/API: `server/main.js`, `server/routes/core.js`, `auth.js`, `ai.js`, `automations.js`, `cad.js`, `extras.js`, `files.js`, `i3x.js`, `tokens.js`, `webhooks.js`, plus `server/graphql/*`, `server/db.js`, `server/auth.js`, `server/acl.js`, `server/audit.js`, and connectors.

### Routes

`app.js` registers `#/hub`, `#/home`, `#/inbox`, `#/search`, `#/team-spaces`, `#/team-space/:id`, `#/channel/:id`, `#/projects`, `#/work-board/:id`, `#/docs`, `#/doc/:id`, `#/compare/:left/:right`, `#/drawings`, `#/drawing/:id`, `#/assets`, `#/asset/:id`, `#/incidents`, `#/incident/:id`, `#/approvals`, `#/ai`, `#/integrations`, `#/integrations/mqtt`, `#/integrations/opcua`, `#/integrations/erp`, `#/dashboards`, `#/admin`, `#/spec`, `#/uns`, and `#/i3x`.

### Data and governance

- Roles and client capabilities live in `src/core/permissions.js`; portal/group visibility lives in `src/core/groups.js`.
- Server capabilities, JWT/API-token auth, object ACL, ABAC hooks, signed approvals, audit packs, webhooks, and FTS search are implemented in `server/auth.js`, `server/acl.js`, `server/audit.js`, `server/routes/core.js`, `server/routes/tokens.js`, `server/routes/webhooks.js`, and `server/db.js`.
- Demo seed objects come from `src/data/seed.js`; server seed and SQLite persistence come from `server/seed.js` and `server/db.js`.

## D. Current Strengths

- Broad product coverage is already implemented: documents, revisions, drawings, assets, work, incidents, AI, admin, integrations, UNS, and i3X all have working screens.
- Hash routes and direct object URLs make deep links easy in `app.js` and `src/core/router.js`.
- Command palette and search are strong enterprise patterns through `src/core/palette.js`, `src/core/search.js`, and `src/screens/search.js`.
- Auditability is a real product strength: client audit appears in `src/core/audit.js` and server hash-chain audit appears in `server/audit.js`.
- Server architecture is credible for enterprise pilots: Fastify, SQLite WAL, JWT/API tokens, ACL, signed approvals, FTS, metrics, webhooks, GraphQL, MQTT, OPC UA, and i3X are documented in `docs/SERVER.md`.
- Existing token variables in `styles.css` create a usable base for a formal design system.

## E. Major UX Problems

1. Navigation is too broad by default. `src/shell/rail.js` makes advanced industrial/API/admin areas first-class for everyone unless portal/group filters hide them.
2. The left panel is a mixed object tree rather than contextual navigation. `src/shell/leftPanel.js` mixes team spaces, channels, projects, docs, drawings, and assets on every route.
3. Permanent panels create overload. `contextPanel.js` and `dock.js` can help, but they are always present in the default 4-column shell from `styles.css`.
4. Dense toolbars compete with safety-critical content. `drawingViewer.js`, `docViewer.js`, `workBoard.js`, `mqtt.js`, `opcua.js`, and `i3x.js` expose many controls at once.
5. Role-based experience is incomplete. Roles gate actions, but home, navigation, defaults, dashboards, and density do not sufficiently change by role.
6. Industrial data lacks layered defaults. `assetDetail.js`, `uns.js`, `mqtt.js`, and `opcua.js` expose live data, mappings, diagnostics, and write actions near regular browsing flows.
7. Accessibility needs hardening. Buttons often rely on emoji/icon labels, custom clickable `div`s, dense badges, and visual color states; `styles.css` has limited responsive behavior below 900px.

## F. Screen-by-Screen Audit

| Screen | Purpose | Current experience | UX issues | Recommended redesign | Related files/components | Priority | Effort |
|---|---|---|---|---|---|---|---|
| Hub | Portal launcher | Tile launcher opens portal-scoped tabs. | New-tab default fragments workspace continuity; portal labels are role-ish but not true role home. | Make Hub a workspace/role home selector with one active workspace, recent work, and role-specific start points. | `src/screens/hub.js`, `src/core/groups.js`, `src/shell/rail.js` | P1 | M |
| Home | Workspace dashboard | KPI strip, priority queue, AI brief, recent revisions, integration health. | Same shape for most users; too KPI-heavy for engineers/field users. | Build role homes: executive exceptions, PM blockers, engineer review queue, field assigned work, admin health. | `src/screens/home.js`, `src/core/permissions.js` | P1 | M |
| Inbox | Notifications | Central notification list. | Should become the universal triage surface with approvals, mentions, blocked work, incidents. | Add saved views: My approvals, Mentions, Assigned work, Incident actions, External requests. | `src/screens/inbox.js` | P2 | M |
| Search | Global search | Search over seeded objects. | Search is good but not sufficiently promoted as navigation. | Promote global search and command palette as primary object discovery; add scoped filters and recent searches. | `src/screens/search.js`, `src/core/search.js`, `src/core/palette.js`, `src/shell/header.js` | P1 | S |
| Team spaces/channels | Collaboration | Spaces, channels, messages, object chips. | Slack-like density can compete with structured work/document flows. | Separate discussion, decisions, files, linked work, and audit tabs; preserve object chips. | `src/screens/teamSpaces.js`, `src/screens/channel.js`, `src/core/mentions.js` | P2 | M |
| Projects/work board | Work management | Kanban/table/timeline/calendar/deps plus batch tools and automation. | Too many views and bulk actions in header; item detail is modal-driven. | Use saved views, quiet board cards, right detail drawer, explicit bulk mode, dependency tab. | `src/screens/workBoard.js` | P1 | L |
| Documents | Document control | Table index and rich viewer with metadata, timeline, approvals, comments, transmittals, impact, AI. | Viewer side pane has too many permanent cards; approval/revision safety needs stronger hierarchy. | Make current revision/approval state a banner; put metadata/history/comments/transmittals/audit in tabs or drawer. | `src/screens/docViewer.js`, `src/screens/revisionCompare.js`, `src/core/revisions.js` | P1 | L |
| Drawings | Drawing review | Sheet tabs, modes, tools, layers, compare, CAD load, export, side column. | Toolbar resembles a technical tool palette; compare/markup/IFC are visible simultaneously. | Use a viewer shell with mode-specific toolbars, drawing status banner, issue drawer, revision compare entry point. | `src/screens/drawingViewer.js`, `src/core/cad-viewer.js`, `server/routes/cad.js` | P1 | L |
| Assets | Industrial asset context | KPIs, UNS/i3X card, telemetry, mappings, docs, incidents, assignment, AI. | Operational, engineering, mapping, and AI content all appears together. | Use layered tabs: Summary, Documents, Drawings, Work, Incidents, Data mappings, Live values, Diagnostics, Audit. | `src/screens/assetDetail.js`, `src/screens/uns.js`, `src/core/i3x/*` | P1 | L |
| Incidents | War room | Severity bar, alarms, timeline, composer, checklist, roster, linked cards, AI/export. | Better than many screens, but side cards and timeline can still feel chat-like. | Command layout: status header, current objective, owner/commander, actions, decisions, telemetry, timeline, postmortem. | `src/screens/incident.js`, `src/core/fsm/incident.js` | P1 | M |
| Approvals | Review queue | Pending approval queue and decisions. | Needs more visible consequences and safer confirmation patterns. | Add approval detail page/drawer with affected revision, supersede risk, linked docs/drawings, signature preview. | `src/screens/approvals.js`, `server/routes/core.js` | P1 | M |
| Integrations | Connector console | Connector cards, UNS binding, event feed, DLQ. | Good content, but setup/diagnostics/replay are mixed. | Separate Overview, Connectors, Mappings, Events, DLQ, Audit; add setup wizard and permission-gated write mode. | `src/screens/integrations.js`, `server/connectors/*`, `server/routes/automations.js` | P2 | L |
| MQTT | Topic mapping | Broker connect, topic tree, payload inspector, mapping, policy, AI. | Advanced admin surface; publish/write actions need isolation. | Add Connect/Test wizard, read-only browser, mapping review flow, publish sandbox with strong warning. | `src/screens/mqtt.js`, `server/connectors/mqtt.js` | P2 | L |
| OPC UA | Node mapping | Endpoint/session, node tree, mapping editor, simulate/write. | Privileged write action appears next to simulation. | Put write-node in a gated maintenance drawer with confirmation, signature, and audit preview. | `src/screens/opcua.js`, `server/connectors/opcua.js` | P1 | M |
| UNS/i3X | Industrial data/API | Namespace tree, live values, raw API explorer, RapiDoc. | API explorer is developer/admin-heavy; default users need asset context first. | Keep `/i3x` admin/developer-only; make `/uns` a browse-and-context screen with live/stale/simulated distinctions. | `src/screens/uns.js`, `src/screens/i3x.js`, `src/core/i3x/*` | P2 | M |
| AI workspace | Governed assistant | Thread, model selector, scope, suggested prompts, policy, log. | Citations exist, but source boundaries and unavailable-permission states need stronger UX. | Add scoped mode header, source selector, citation panel, confidence/limits, permission denial explainer, output templates. | `src/screens/ai.js`, `server/ai.js`, `server/routes/ai.js` | P1 | M |
| Admin | Governance | SSO, retention, groups, RBAC, tokens, webhooks, n8n, metrics, audit, access review, policy. | Too many admin domains on one page. | Use settings IA: Org, Workspace, Identity, Security, Roles, Integrations, AI policy, Audit, Retention, System health. | `src/screens/admin.js`, `server/auth.js`, `server/acl.js`, `server/routes/tokens.js` | P1 | L |
| Dashboards | Analytics | Dashboard cards and KPI grid. | Too abstract; repeats home KPI behavior. | Create role dashboard templates focused on exceptions, blockers, approvals, revision conflicts, integration health. | `src/screens/dashboards.js` | P2 | M |

## G. Workflow Audit

| Workflow | Current flow | Friction | Missing states | Recommended flow | Required UI changes | Required code/component changes |
|---|---|---|---|---|---|---|
| Revision review/approval | Open doc, inspect side pane, compare, go to approvals. | Current/superseded/rejected risk is badge-heavy. | Superseded warning, approval consequence preview, blocked approval, rejected reason. | Document banner -> review drawer -> compare -> approve/reject with signature preview. | Banner, review drawer, safer confirmation. | `DocStatusBanner`, `ApprovalDecisionDrawer`, updates in `docViewer.js`, `approvals.js`. |
| Drawing markup to issue | Open drawing, choose markup mode/tool, click canvas, create issue. | Too many tools visible; issue creation is tool-driven. | Draft markup, unresolved/resolved states, linked work item status. | Mode selector -> markup toolbar -> create issue drawer -> linked item appears in side panel. | Mode-specific toolbar, issue drawer, markup list. | Split `drawingViewer.js` into viewer shell, toolbar, markup layer, issue drawer. |
| Work item management | Project board header switches views and creates items; modal edits. | Header overload; card metadata can become badge soup. | Saved filters, personal views, SLA rules, external/vendor view. | My Work / Project Work / Saved Views, with detail drawer and explicit bulk mode. | Saved view bar, item drawer, bulk mode toggle. | New shared `ViewToolbar`, `WorkItemDrawer`; refactor `workBoard.js`. |
| Asset investigation | Open asset, see telemetry, mappings, docs, incidents, assignment, AI. | Live data and mappings appear by default. | Stale/disconnected/simulated state, diagnostics history, audit. | Asset summary first, then tabs for docs/drawings/work/incidents/data/diagnostics/audit. | Asset page tabs and data-state indicators. | `AssetTabs`, `TelemetryStateBadge`, `MappingTable`; refactor `assetDetail.js`. |
| Incident response | Open incident, add timeline, checklist, roster, linked cards. | Actions and evidence compete with timeline. | Decision log, current objective, escalation state, postmortem state. | Command header -> active actions -> decision log -> evidence/timeline -> postmortem export. | Incident command template. | `IncidentCommandHeader`, `DecisionLog`, `IncidentActions`. |
| Integration setup | Integration console to connector-specific pages. | Setup, mapping, diagnostics, and replay mixed. | Draft config, validation errors, credential saved/rotated states. | Connector overview -> setup wizard -> test -> mapping -> validate -> enable -> audit. | Wizard and connector health page. | `ConnectorHealthCard`, `IntegrationWizard`, `MappingValidator`. |
| AI-assisted answer | Open AI, choose model, ask. | Scope and permission boundaries are understated. | Source unavailable, confidence/limits, stale index, no-citation warning. | Scoped AI mode with source selector, citation panel, limits, templates. | AI scope header and citation side panel. | `AIScopeHeader`, `CitationPanel`, server route response metadata. |
| Admin governance | Single admin page with many cards. | Settings overload; dangerous actions near passive status. | Search settings, dirty state, audit preview, confirmation tiers. | Settings sections with left nav, searchable settings, danger zone. | Admin settings shell. | Split `admin.js` into settings modules and shared dangerous action pattern. |

## H. Recommended Enterprise Information Architecture

### Global

- Organization switcher and workspace switcher.
- Global search and command palette.
- Inbox/notifications.
- User/profile, help, keyboard shortcuts.
- Admin only for authorized roles.

### Workspace primary navigation

Use a shorter primary nav:

1. Home
2. Work
3. Documents
4. Drawings
5. Assets
6. Incidents
7. Team spaces
8. Integrations
9. AI
10. Admin

### Contextual secondary navigation

- Work: Boards, Tables, Calendar, Dependencies, Saved views.
- Documents: Library, Reviews, Transmittals, Revisions, Audit.
- Drawings: Library, Reviews, Markups, Issues, Models.
- Assets: Summary, Documents, Drawings, Work, Incidents, Data, Diagnostics, Audit.
- Integrations: Overview, Connectors, Mappings, Events, DLQ, Credentials, Audit.
- Admin: Organization, Workspace, Identity, Security, Roles, Policies, AI, Integrations, Audit, Retention, System health.

### Role-based defaults

- Executive: exceptions, risk, overdue approvals, active incidents, program health.
- Engineering manager: review queues, blockers, revision conflicts, team load.
- Project manager: milestones, overdue work, RFIs/punch/CAPAs, dependencies.
- Engineer: assigned work, review requests, recent docs/drawings, mentions.
- Field technician/operator: assigned actions, procedures, asset status, incident actions.
- Integration admin: connector health, mapping errors, DLQ, credentials, audit.
- Admin/auditor: access review, audit ledger, retention, policy violations.
- External vendor/client: scoped documents, markups, RFIs, transmittals, no internal telemetry by default.

## I. Recommended Design System

### Principles

- Quiet by default, explicit when risky.
- Object-first pages: title, status, owner, primary next action, recent change.
- One primary action per surface.
- Details move into tabs, drawers, or expandable sections.
- Industrial data is trustworthy, labeled, and layered.

### Tokens

- Expand `styles.css` tokens into semantic groups: `--color-bg-page`, `--color-bg-surface`, `--color-text-primary`, `--color-text-secondary`, `--color-border-subtle`, `--color-action-primary`, `--color-focus-ring`.
- Keep semantic state tokens: success, info, warning, danger.
- Add explicit severity tokens: `sev-1`, `sev-2`, `sev-3`, `sev-4`.
- Add data-quality tokens: live, stale, disconnected, simulated, historical.
- Add revision tokens: draft, IFR, approved, IFC, superseded, rejected, archived.

### Components

- App shell: primary nav, workspace switcher, secondary nav, page header, details drawer.
- Buttons: primary, secondary, tertiary, destructive, danger-confirm.
- Tables: compact/comfortable density, sortable headers, saved filters, row actions, bulk mode.
- Cards: summary card, exception card, object card, health card.
- Badges/tags: use sparingly; severity and revision status get consistent shapes.
- Drawers: object detail, approval decision, issue creation, mapping edit.
- Modals: only blocking confirmations and short forms.
- Empty/loading states: include next action and permission reason.
- Command palette/search: global quick actions, object jump, recent searches.
- Data visualization: no raw telemetry charts on home; use exceptions and trends.
- Accessibility: visible focus rings, keyboard paths, aria labels, non-color labels.
- Dark mode: keep, but light mode should be default enterprise presentation.
- Field mode: tablet-friendly touch targets, offline/stale labels, high-contrast incident actions.

## J. Component Refactor Plan

- Extract `AppShell`, `PrimaryNav`, `SecondaryNav`, `PageHeader`, `ContextDrawer`, and `OperationsDock` from `src/shell/*`.
- Replace `card`, `badge`, `table` with richer primitives in `src/core/ui.js`: `Page`, `Toolbar`, `Tabs`, `DataTable`, `StatusBadge`, `SeverityBadge`, `RevisionBadge`, `EmptyState`, `Drawer`.
- Split large screens:
  - `docViewer.js` -> document page, revision banner, metadata tab, comments tab, transmittals tab, approval drawer.
  - `drawingViewer.js` -> viewer shell, mode toolbar, canvas, markup layer, layer panel, issue drawer.
  - `workBoard.js` -> view toolbar, board, table, timeline, dependency map, item drawer, bulk bar.
  - `assetDetail.js` -> asset header, summary, telemetry, mappings, incidents, assignment, audit.
  - `admin.js` -> settings shell plus identity, roles, tokens, webhooks, automations, metrics, audit, retention modules.
- Remove inline layout styles where possible and move them to tokenized CSS utilities in `styles.css`.
- Replace clickable `div` rows with semantic `button` or accessible row patterns.

## K. Industrial and Engineering UX Recommendations

- Keep industrial credibility through precise terms, trace IDs, mappings, and audit trails, but default to summaries.
- Asset summary should show status, owner, location/hierarchy, linked work, current incidents, and critical docs. Live values belong in a `Live values` tab.
- Distinguish live, stale, disconnected, simulated, and historical data everywhere telemetry appears: `assetDetail.js`, `uns.js`, `mqtt.js`, `opcua.js`, and `integrations.js`.
- MQTT/OPC UA publish/write actions must move into a permission-gated maintenance flow with explicit confirmation, affected endpoint, actor, signature/audit preview, and rollback/replay notes.
- UNS and i3X should be admin/developer tools by default; normal engineering users should reach industrial data through assets, incidents, and drawings.

## L. Accessibility and Responsive Review

- `styles.css` has responsive breakpoints at 1280px and 900px, but the four-panel desktop shell is still the default and many screens use two/three-column grids.
- Add a mobile/tablet IA: primary nav collapses, left panel becomes drawer, context panel becomes details drawer, dock becomes notification sheet.
- Add visible focus ring tokens and test keyboard use for command palette, modals, menus, boards, drawing tools, and tree rows.
- Replace emoji-only or emoji-led controls with accessible labels in `rail.js`, `drawingViewer.js`, `assetDetail.js`, and integration screens.
- Avoid color-only communication in badges, revision states, severity, live data quality, and integration health.
- Introduce table captions or accessible labels for data tables in document, asset, incident, approval, and admin screens.

## M. Risk Register

| Risk | Location in code | User affected | Severity | Cause | Business impact | Recommended mitigation |
|---|---|---|---|---|---|---|
| Users act on superseded drawings/docs | `docViewer.js`, `drawingViewer.js`, `revisionCompare.js` | Engineers, field techs, vendors | High | Revision status is badge-heavy, not a blocking banner | Rework, safety incidents, contractual disputes | Add revision safety banner and superseded interlock. |
| Accidental approval/rejection | `approvals.js`, `docViewer.js`, `server/routes/core.js` | Approvers, auditors | High | Decision context and consequence preview are limited | Compliance and quality failures | Approval drawer with linked impact, notes, signature preview. |
| Accidental MQTT/OPC UA writes | `mqtt.js`, `opcua.js`, `uns.js`, `server/routes/i3x.js` | Integration admins, operators | Critical | Write actions near browse/simulate actions | Operational disruption | Gated maintenance mode, confirmation, audit preview, role check. |
| Critical incident status hidden by clutter | `incident.js`, `dock.js`, `contextPanel.js` | Incident team, managers | High | Timeline/cards compete for attention | Slower response | Command header, current objective, active actions, decision log. |
| Overwhelming first-use experience | `rail.js`, `leftPanel.js`, `home.js`, `styles.css` | All new users | High | Too many routes, panels, cards | Enterprise adoption friction | Simplify primary nav, role home, progressive disclosure. |
| Permission model confusion | `permissions.js`, `groups.js`, `server/auth.js`, `server/acl.js` | Admins, external users | High | Client role dropdown, group portals, server RBAC/ACL differ | Trust and security concerns | Permission explainer, admin access model page, align client/server terminology. |
| AI appears more authoritative than it is | `ai.js`, `server/ai.js` | Engineers, managers, auditors | Medium | Citations exist but limitations are quiet | Bad decisions from incomplete context | Citation panel, source selector, limitations and permission-denied states. |
| Integration failures unclear | `integrations.js`, `mqtt.js`, `opcua.js`, `erp.js` | Integration admins | Medium | Health, events, DLQ, mappings mixed | Longer outage diagnosis | Connector health overview and diagnostics flow. |
| Mobile/tablet field use poor | `styles.css`, shell files, viewer screens | Field techs, supervisors | High | Dense grid shell and small controls | Low field adoption | Tablet shell, larger touch targets, offline/stale states. |
| Badge overload reduces signal | Most screens, `ui.js`, `styles.css` | All users | Medium | Badges used for many metadata types | Missed critical states | Badge taxonomy and severity/revision hierarchy rules. |

## N. Prioritized Roadmap

### Phase 1: Remove UX friction and visual overload

- Reduce primary nav to core domains in `rail.js`.
- Make left panel contextual instead of universal in `leftPanel.js`.
- Convert context panel to on-demand details drawer.
- Add revision/approval/incident safety banners.
- Add role-based home variants in `home.js`.

### Phase 2: Establish enterprise design system

- Formalize tokens in `styles.css`.
- Expand `src/core/ui.js` primitives.
- Add status, severity, revision, data-quality, empty-state, drawer, tabs, and data-table components.
- Document usage rules beside the skill/report.

### Phase 3: Redesign navigation and page templates

- Add workspace/project/site context.
- Add secondary navigation per domain.
- Promote global search and command palette.
- Add responsive tablet shell.

### Phase 4: Redesign core workflows

- Documents/revisions/approvals.
- Drawing review and markup-to-issue.
- Work item detail and saved views.
- Incident command.

### Phase 5: Improve industrial, integration, and AI experiences

- Layer asset pages.
- Separate integration setup, mapping, diagnostics, and DLQ.
- Gate MQTT/OPC UA/i3X write actions.
- Add governed AI scope/citation/limitations UX.

### Phase 6: Enterprise polish and accessibility hardening

- Keyboard test all flows.
- Add tablet/field mode.
- Reduce color-only status.
- Add confirmation patterns for dangerous actions.
- Review external/vendor and auditor experiences.

## O. Developer-Ready Task List

| Task | File/component | Why it matters | Suggested fix | Priority | Effort |
|---|---|---|---|---|---|
| Add enterprise UX skill for agents | `.claude/skills/enterprise-ux-audit/SKILL.md`, `AGENTS.md` | Makes this audit repeatable for Claude/agents. | Keep the skill current and require code-grounded report updates. | P0 | S |
| Simplify primary nav | `src/shell/rail.js` | Current 15-item rail overwhelms users. | Replace with core domains; move UNS/i3X/admin subroutes behind role/context menus. | P1 | M |
| Make left panel route-aware | `src/shell/leftPanel.js` | Universal object tree creates clutter. | Render secondary nav for active domain; move global objects to search/palette. | P1 | M |
| Convert right context panel to drawer | `src/shell/contextPanel.js`, `styles.css` | Permanent panel consumes attention. | Add details drawer opened by object/header actions. | P1 | M |
| Create role home variants | `src/screens/home.js`, `src/core/permissions.js` | Different roles need different defaults. | Switch content by current role/group and show saved views/exceptions. | P1 | M |
| Add document revision safety banner | `src/screens/docViewer.js`, `src/screens/revisionCompare.js` | Prevents acting on wrong revision. | Persistent banner with current/superseded/rejected state and compare/approval actions. | P1 | M |
| Redesign approval decision flow | `src/screens/approvals.js`, `server/routes/core.js` | Approvals are high-risk compliance actions. | Detail drawer with impact, linked objects, notes, signature preview, confirm. | P1 | M |
| Split drawing toolbar by mode | `src/screens/drawingViewer.js` | Current toolbar is too dense. | Mode selector plus mode-specific toolbar and issue drawer. | P1 | L |
| Add work item drawer and saved views | `src/screens/workBoard.js` | Reduces board/header density. | Add `WorkItemDrawer`, saved filters, explicit bulk mode. | P1 | L |
| Layer asset detail page | `src/screens/assetDetail.js` | Separates engineering context from live operations. | Add tabs: Summary, Docs, Drawings, Work, Incidents, Data, Diagnostics, Audit. | P1 | L |
| Add data-quality badge taxonomy | `styles.css`, `src/core/ui.js`, `assetDetail.js`, `uns.js` | Live/stale/simulated/historical states must be clear. | Add `DataQualityBadge` and use it anywhere telemetry appears. | P1 | M |
| Gate OPC UA write action | `src/screens/opcua.js` | Prevents accidental industrial writes. | Move write-node into maintenance drawer with confirmation and audit preview. | P1 | M |
| Gate MQTT publish/test actions | `src/screens/mqtt.js` | Publish actions can affect brokers. | Add sandbox/test mode and privileged publish confirmation. | P2 | M |
| Redesign incident command header | `src/screens/incident.js` | Incident teams need current state immediately. | Add commander, status, current objective, active actions, decision log. | P1 | M |
| Split admin into settings sections | `src/screens/admin.js` | Single page is too dense for enterprise admins. | Create settings shell with Identity, Security, Roles, Audit, Retention, Integrations, AI. | P1 | L |
| Add governed AI source panel | `src/screens/ai.js`, `server/routes/ai.js` | Prevents false authority. | Add source selector, citation panel, limitations, unavailable-permission states. | P1 | M |
| Build reusable data table | `src/core/ui.js`, table-heavy screens | Tables need sorting, density, filters, bulk mode. | Add `DataTable` primitive and migrate docs/assets/incidents/admin. | P2 | L |
| Add accessible focus and row semantics | `styles.css`, `src/core/ui.js`, `src/screens/*` | Keyboard and WCAG readiness. | Add focus tokens; replace clickable divs with buttons or keyboard handlers. | P1 | M |
| Add tablet field shell | `styles.css`, shell files | Field technicians need usable tablet flows. | Collapse panels to drawers, increase touch targets, simplify incident/asset screens. | P2 | L |
| Align client/server access terminology | `permissions.js`, `groups.js`, `server/auth.js`, `server/acl.js`, `admin.js` | Reduces permission trust gaps. | Add access model documentation screen and consistent labels. | P2 | M |
