# FORGE Enterprise UI/UX Redesign Audit

> Refreshed full-app UX analysis. The baseline audit drove Phase 1–4 of the
> original roadmap to completion — role-aware left panel, revision safety
> banner, work-board saved views and drawer, approval impact drawer, layered
> asset tabs, admin settings sections, drawing mode toolbars. This refresh
> grounds findings in the **current** code at `app.js`, `src/shell/*`,
> `src/screens/*`, `src/core/ui.js`, `src/core/groups.js`, and `styles.css`,
> and documents the next wave of improvements.

## A. Executive Summary

FORGE has matured into a credible enterprise SPA: it now has a Hub launcher,
portal-scoped rail filtering, group-based route gating (`src/core/groups.js`),
a contextual left navigator, a document revision safety banner, a layered
asset detail page, a signed approval drawer, a work-item drawer with saved
views, and an admin settings shell. The shell continues to be a four-column
desktop grid (`72px 260px 1fr 340px`) with focus / field / portal modes.

The remaining gap is **enterprise polish and consistency** rather than
missing capability. The same patterns are reimplemented with subtle
variation across screens (custom tabs in `assetDetail.js`, `workBoard.js`,
and `admin.js`; bespoke tables in `docViewer.js`, `incident.js`, `erp.js`,
`approvals.js`; `window.prompt`/`window.confirm` for ~28 destructive
actions). The Hub still opens portals in separate browser tabs, the right
context panel is still permanent rather than on-demand, the rail still
mixes 12 items with emoji-led labels, and accessibility details (clickable
`div`s as rows, color-only states, dense toolbars in the drawing viewer)
need another pass.

The most impactful next steps are: (1) consolidate shared primitives in
`src/core/ui.js` (`Tabs`, `DataTable`, `EmptyState`, `Drawer`, `Confirm`,
`StatusBadge`); (2) replace native `prompt/confirm` with FORGE modals;
(3) make the right context panel on-demand; (4) add real role-based home
variants; (5) tighten the Hub-to-workspace navigation model so
discipline-specific portals don't fragment the user's workspace.

## B. Product Experience Diagnosis

- **Breadth before intent has improved but not been resolved.** `src/shell/rail.js`
  now defaults to 12 destinations (Hub, Home, Work, Docs, Drawings, Assets,
  Incidents, Teams, Inbox, AI, Integ, Admin) and is portal-filtered when
  `state.ui.portalId` is set. It still renders Theme and Dock toggles inline
  with navigation, and every primary item is icon-led with an emoji.
- **Workflow defaults still don't change by role.** `src/screens/home.js`
  shows the same KPI strip + priority queue + AI brief + recent revisions
  for every role, with a single conditional ("integration health" vs
  "engineering picks") gated on group membership. Field, executive, and
  approver roles see the engineering manager's home.
- **The right context panel and operations dock are always-on.**
  `src/shell/contextPanel.js` always renders Role + route-context + Recent
  audit; `src/shell/dock.js` always shows active incidents, integration
  failures, and pending approvals at the bottom of the screen, taking
  ~48 px of vertical real estate even on read-only browsing.
- **Two distinct nav models compete.** Hub tiles open in **new tabs** with
  `target="_blank"` (`src/screens/hub.js:55-71`). Inside a portal tab the
  rail filters to that portal's items. This means a user can have
  "Engineering" and "Industrial Operations Data" open in two browser tabs
  with different rails, and yet the URL bar gives them no quick way to
  switch portal scope on the same tab.
- **Native browser dialogs are still load-bearing.** ~28 calls to
  `window.prompt` or `window.confirm` in `src/screens/{drawingViewer,
  channel,opcua,mqtt,docViewer,incident,workBoard,admin,erp,approvals,uns,
  integrations}.js`. They have no consistent styling, no per-action audit
  hint, and no way to validate input before commit.
- **Patterns are reimplemented per screen.** Three custom tab strips
  (`assetDetail.js:140`, `workBoard.js:127`, `admin.js:49`); bespoke
  `<table>` in `docViewer.js`, `incident.js`, `approvals.js`, `erp.js`,
  `admin.js` while `src/core/ui.js` exports a `table()` helper used only by
  `inbox.js`; bespoke chip/help dot helpers redeclared in
  `assetDetail.js:118-124` and `workBoard.js:157-171`.
- **Accessibility regressions accumulate at the row level.** ~30 instances
  of `class: "activity-row"` with `onClick` handlers across the screens
  remain non-button, non-keyboard reachable — a partial improvement over
  the baseline where some are now `<button>` (e.g. `assetDetail.js`'s
  `documentList`) but most are still `<div>`.

## C. Application Map

### Routes (`app.js:setupRoutes`)

`/hub`, `/home`, `/inbox`, `/search`, `/team-spaces`, `/team-space/:id`,
`/channel/:id`, `/projects`, `/work-board/:id`, `/docs`, `/doc/:id`,
`/compare/:left/:right`, `/drawings`, `/drawing/:id`, `/assets`,
`/asset/:id`, `/incidents`, `/incident/:id`, `/approvals`, `/ai`,
`/integrations`, `/integrations/{mqtt,opcua,erp}`, `/dashboards`, `/admin`,
`/admin/:section`, `/spec`, `/uns`, `/i3x`. ~28 routes; the only
restriction-gated routes (`canAccessRoute` in `src/core/groups.js`) are
`/i3x`, `/uns`, `/integrations*`, `/admin*`.

### Shell

`src/shell/rail.js` (primary nav, 12 items + 2 utility), `header.js` (titles
+ breadcrumb + search + view menu + role + reset + sign-in pill),
`leftPanel.js` (route-aware contextual nav with quick actions and sections
per domain), `contextPanel.js` (Role card + route detail card + Recent
audit), `dock.js` (active alerts strip pinned to bottom).

### Shared primitives (`src/core/ui.js`)

`el`, `mount`, `clear`, `card`, `badge`, `chip`, `kpi`, `table` (used
once), `toast`, `modal`, `drawer`, `confirm` (used **zero times**),
`formRow`, `input`, `select`, `textarea`. No `Tabs`, `DataTable`,
`EmptyState`, `StatusBadge`, `SeverityBadge`, `RevisionBadge`,
`PageHeader`, `Toolbar` primitives.

### Governance

Client roles in `src/core/permissions.js` (10 roles), groups + portals +
route gating in `src/core/groups.js`, server JWT/RBAC in
`server/auth.js`, ACL in `server/acl.js`, hash-chain audit in
`server/audit.js` and `src/core/audit.js`.

## D. What's Already Been Done Since Baseline

These baseline P1 tasks are now complete in code:

| Baseline task | Current state | Code |
|---|---|---|
| Make left panel route-aware | Domains: work / docs / drawings / assets / incidents / spaces / integrations / admin / home with quick actions and section trees. | `src/shell/leftPanel.js` |
| Add document revision safety banner | Persistent banner with kicker, title, state label, guidance, status badge, and "Open current / Compare / Review approvals" actions. | `src/screens/docViewer.js:69-112`, `styles.css:.revision-safety-banner` |
| Add work item drawer + saved views | `WorkItemDrawer` via `drawer()`; six saved views (`SAVED_VIEWS`); explicit batch toolbar; calendar + dependency views. | `src/screens/workBoard.js:270-310, 716-760` |
| Layer asset detail | Tabs: Summary, Docs, Work, Signals, Activity; live VQT separated from summary. | `src/screens/assetDetail.js:126-150` |
| Approval impact + signed decision drawer | `decideDrawer` shows impact preview + signature notes; HMAC chain-of-custody. | `src/screens/approvals.js:198-294` |
| Split drawing toolbar by mode | `view / markup / compare / ifc` modes with mode-gated tool palette. | `src/screens/drawingViewer.js:69-117` |
| Split admin into settings sections | Identity / Access / Integrations / Audit / Retention / System health tabs. | `src/screens/admin.js:34-46` |
| Hub launcher + portal scoping | Hub tiles open portal tabs with `?portal=` scope; rail and header retint. | `src/screens/hub.js`, `src/shell/rail.js:25-34` |
| Group-based gating | `canAccessRoute`, `canSeePortal`, `canSeeAsset`. Admin "Demo identity" switcher exists. | `src/core/groups.js`, `src/screens/admin.js:425-478` |
| Field / focus / portal layout modes | View menu in header writes `state.ui.{showRail,showLeftPanel,showContextPanel,showHeader,focusMode,fieldMode}`; persistent in localStorage. | `src/shell/header.js:94-177`, `styles.css:.hide-*, .focus-mode, .field-mode` |
| Demo simulation seam | `src/core/simulation.js` centralizes telemetry, briefs, IDs. | `src/core/simulation.js` |

## E. Major UX Problems (refreshed)

1. **Right context panel is permanent.** `src/shell/contextPanel.js` always
   renders Role + route-context + audit. The grid track is `340px` even
   on screens that already have rich detail (asset, incident, doc) — the
   panel duplicates information rather than adding it.
2. **Operations Dock is permanently visible at the bottom.**
   `src/shell/dock.js` always shows incidents/integrations/approvals dots
   (or "All systems nominal" when clean). The dock duplicates content
   already on Home and the Inbox, and steals 48 px even when reading a
   document.
3. **Rail emoji icons hurt scannability.** `src/shell/rail.js:7-20` —
   `🏛 🏠 ✓ 📑 📐 ⚙️ 🚨 🗂 📥 🤖 🔌 🛡`. Mixed visual weight, low contrast
   in light theme, and emoji rendering varies across OSes (Linux
   noto-emoji vs macOS Apple Color Emoji).
4. **No real role-based home.** `src/screens/home.js` has the same five
   KPIs, priority queue, AI brief, and recent revisions for everyone,
   with one conditional card.
5. **`window.prompt` / `window.confirm` for high-stakes actions.**
   `drawingViewer.js` (text markup, stamp), `opcua.js:151,168` (write
   value, write-node), `mqtt.js`, `incident.js:293,386,393` (action item,
   change severity, change status), `docViewer.js:420,475,493` (regional
   comment, convert to issue, attach url), `approvals.js:351`
   (batch confirm), `admin.js:112` (revoke token), `uns.js:242` (write
   value), `erp.js`, `channel.js`, `integrations.js:82` (rotate
   credential).
6. **Hub fragments workspace continuity.** `src/screens/hub.js:65-71`
   force-opens every tile in a new tab via `window.open(href, "_blank")`.
   No way to switch portal scope from the rail; tab management is on the
   user.
7. **Three different tab strips.** `src/screens/admin.js:49-58`,
   `src/screens/workBoard.js:127-136`, `src/screens/assetDetail.js:140-150`
   — same idea, three implementations, slightly different markup and
   `aria-selected` handling. No `Tabs` primitive in `src/core/ui.js`.
8. **Bespoke `<table>` everywhere.** `docViewer.js`, `incident.js`,
   `approvals.js`, `admin.js`, `erp.js`, `assetDetail.js` all hand-roll
   tables; the shared `table()` in `src/core/ui.js:80-106` is only used by
   `src/screens/inbox.js`. Sortability, filterability, density, and bulk
   selection are reinvented or skipped per screen.
9. **`activity-row` divs as clickable rows.** ~30 occurrences across
   screens; in many places (`home.js`, `incident.js`, `docViewer.js`,
   `mqtt.js`, `i3x.js`, `uns.js`, `integrations.js`) they're `<div>` with
   `onClick` and no `tabindex`/`role`/keyboard handler.
10. **Drawing viewer toolbar is still very dense.**
    `src/screens/drawingViewer.js:71-117` — sheet tabs + 4 modes + 10
    tools + 3 zoom + 3 layer toggles + compare picker + Reload CAD +
    Export SVG. Tools are emoji-led (`✋ 📏 ➜ 💬 ☁ ▮ T ⛊ ● 📍`).
11. **No empty states.** Most "no data" branches use a literal
    `el("div", { class: "muted tiny" }, ["…"])`. No reusable
    `EmptyState` with icon + headline + next action + permission hint.
12. **Color-only status across badges.** `badge(p.status, p.status ===
    "active" ? "success" : "info")` is the dominant pattern. There is no
    icon glyph or alphanumeric prefix on success/warn/danger badges, and
    no formal severity / data-quality / revision token taxonomy enforced
    via primitives.
13. **Mobile / tablet layout still light.** `styles.css:1683-1701` has
    breakpoints at 1280 px and 900 px only. Below 900 px the left panel
    hides, but the rail stays at 72 px (icons + tiny labels) and the
    operations dock continues to stretch full width over the bottom of
    the screen. Field mode (`body.field-mode`) is declared but has **no**
    CSS rules in `styles.css`.
14. **Group-restricted routes always show the same generic forbidden
    page.** `app.js:191-208` renders the same fallback for `/admin`,
    `/integrations`, `/uns`, `/i3x`. There is no link to "Request
    access", no "this is an admin route, ask your administrator to add
    you to the IT group" guidance, no membership of the asking user.
15. **Header search and command palette duplicate intent.** Both go to
    `/search`; the palette (`⌘K`) is the richer entry point but the
    header still keeps a 280-px search input on every page.
16. **The "Reset" button is a top-level destructive control.**
    `src/shell/header.js:85-89` — an `OK/Cancel` `confirm()` is the only
    safety. Should be in admin/settings, not the global header.
17. **No persistent breadcrumb-as-navigation.**
    `src/shell/header.js:66-70` renders breadcrumbs as plain text
    (`org / workspace / crumb`); none of the segments are clickable.
18. **AI workspace under-communicates limits.** `src/screens/ai.js`
    shows scope and citations, but offline/cold-start, retrieval-zero,
    and "permission filtered N hits" feedback are missing. `welcome()`
    is identical for every role and scope.

## F. Screen-by-Screen Audit (refreshed)

| Screen | Current state (post-baseline work) | Remaining UX issues | Priority | Effort |
|---|---|---|---|---|
| Hub (`hub.js`) | Hero + grid of tiles + footer; portal tiles tinted by `accent`; opens new tab. | New-tab-by-default fragments work; hero is generic; no recent work or pinned items. | P1 | M |
| Home (`home.js`) | KPI strip, priority queue, AI brief, recent revisions, integration health/picks. | Single home for every role; no saved views; AI brief auto-runs even with no relevant signals. | P1 | M |
| Inbox (`inbox.js`) | Single notifications table, "Mark all read". Uses shared `table()`. | No saved views (mentions / approvals / assigned / incident actions); no unread indicator distinct from row read state; only one entry-point per row. | P2 | S |
| Search (`search.js`) | Facet rail + saved searches + permission-filtered. | Header search input duplicates palette; no recent searches; no scope chips bound to current route. | P2 | S |
| Team spaces / channels (`teamSpaces.js`, `channel.js`) | Card index + members + projects + docs; channel composer with chips, mentions, decision blocks. | Composer is dense; thread drawer is permanent; spaces detail is cards-and-rows. | P2 | M |
| Projects / Work board (`workBoard.js`) | Saved views + filter + 5 view modes + batch bar + project context tabs + automation rules card + work item drawer. | Two header rows + project context tabs + batch bar = three competing toolbars; new-item modal still uses native form. | P1 | M |
| Documents / Doc viewer (`docViewer.js`) | Revision safety banner + metadata bar + viewer toolbar + 8 side cards (metadata, timeline, approvals, comments, transmittals, impact, cross-links, ai-ask). | Side stack is very tall; metadata bar duplicates info already in banner + side card; ad-hoc table on `renderDocsIndex`. | P1 | M |
| Drawings / Drawing viewer (`drawingViewer.js`) | Mode-gated toolbar; SVG canvas with svg-pan-zoom upgrade; CAD via three.js; markup palette. | Toolbar still has ~30 affordances on the row; emoji tool icons; markup creation uses `window.prompt`. | P1 | L |
| Assets / Asset detail (`assetDetail.js`) | Header chips + 5 KPI cards + tabs (Summary/Docs/Work/Signals/Activity) + Assignment + AI brief. | Top still shows 5 KPIs *and* tabs *and* a War Room button; long single page; UNS card duplicates Signals tab. | P1 | M |
| Incidents (`incident.js`) | Severity bar + command header KPIs + alarms strip + timeline + checklist + roster + linked + AI + export. | Three "header" surfaces stack (severity bar, command header, alarms); status/severity changes use `window.prompt`. | P1 | M |
| Approvals (`approvals.js`) | Filter strip + batch + queue table + preview + decide drawer + impact + signed chain. | Decision drawer is excellent; queue table has no SLA-color sort; reject path is `prompt` for batch. | P2 | S |
| Integrations (`integrations.js`) | Mapping lifecycle strip + connector cards + UNS binding + events + DLQ. | Lifecycle steps `connector-lifecycle` reference CSS classes that **don't exist** in `styles.css` — silently broken on light theme. Cred rotation uses `confirm()`. | P1 | S |
| MQTT (`mqtt.js`) | Live broker + topic tree + payload inspector + mapping rules + namespace policy + AI taxonomy. | Publish dialog uses native modal; `disabled: !can("integration.write")` is the only guard for live publish. | P2 | M |
| OPC UA (`opcua.js`) | Endpoint + node tree + mapping editor + simulate + write-node. | Privileged write-node is one click + `prompt`; no signature preview, no audit preview, no current-value display. | P1 | M |
| ERP (`erp.js`) | Mapping matrix + conflict queue + backfill/writeback preview. | Conflict cards use `approval-card` class; no audit-of-merge preview; bespoke table. | P2 | M |
| UNS / i3X (`uns.js`, `i3x.js`) | Tree + composition + live VQT + cross-links + RapiDoc explorer. | UNS write value uses `prompt`; sparkline duplicated (charts.js + inline); subscribe handle leaks across renders. | P2 | M |
| AI (`ai.js`) | Thread + scope + model select + suggested prompts + policy + log. | No clear "permission-denied retrieval" state; `welcome()` is generic; model dropdown isn't permission-filtered. | P1 | M |
| Admin (`admin.js`) | Tabs (Identity, Access, Integrations, Audit, Retention, Health); RBAC matrix; groups tree; tokens; webhooks; n8n; metrics. | Token-revoke uses `confirm()`; webhook delete uses `confirm()`; access review has no SLA; metrics is a `<pre>` block. | P2 | M |
| Spec (`spec.js`), Dashboards (`dashboards.js`) | Static. | Dashboards is 5 KPIs + 1 grid; Spec is a static markdown render. | P3 | S |

## G. Workflow Audit (refreshed)

| Workflow | Today | Friction remaining | Recommended next change |
|---|---|---|---|
| Revision review and approval | Banner + drawer + signed decision implemented. | Compare entry is buried in the banner action; superseded interlock is a badge color rather than a blocked action. | Add a "Compare with current" jump in the banner when not current; lock approve/reject when revision is superseded. |
| Drawing markup → issue | Mode-gated toolbar, click-to-place markup, "Convert to issue" via comment in doc viewer. | Markup itself uses `window.prompt` for text and stamp label; no "Create issue" right on the markup popover. | Replace prompts with a `MarkupComposer` modal that includes severity, link to asset, and "Create work item from markup". |
| Work item lifecycle | Saved views + drawer + batch bar. | New-item modal lacks asset link, due date, labels chip-input; due date never collected on create. | Extend `openNewItem` with date + labels + linked asset/doc/drawing inputs; emit a creation event with traceable provenance. |
| Asset investigation | Tabs implemented; Live values and Signals separated from Summary. | War Room button is one-click "create incident" with no severity / scope confirmation. | Convert War Room into a `CreateIncidentDrawer` requiring severity, blast radius and primary on-call. |
| Incident command | Severity bar + command header + checklist + roster + AI + export. | Three header surfaces; status / severity transitions still use `window.prompt`. | Replace prompts with a `StateTransitionDrawer` that previews FSM-allowed transitions and signs the change. |
| Integration setup → enable | Lifecycle strip + connector cards. | The lifecycle strip references CSS that doesn't exist; rotate-credential confirms inline; no setup wizard. | Either ship the missing `.connector-lifecycle*` CSS or remove the strip; replace `confirm()` with `IntegrationActionDrawer`. |
| AI ask | Citations + scope + log. | No retrieval-zero state; no permission-denied source explanation; no "limits of this answer" disclaimer. | Add a `CitationPanel` and `RetrievalState` (filtered: N · denied: M · indexed: K) row above the assistant bubble. |
| Admin governance | Settings sections + groups + tokens + webhooks + n8n + metrics + retention + audit. | Many destructive actions (revoke, delete, sign-off-all) gated only by `window.confirm`. | Consolidate into a single `dangerAction({ title, body, confirmLabel, cooldownMs })` primitive that records intent in the audit ledger. |

## H. Recommended Enterprise Information Architecture

Largely unchanged from baseline; the implemented portal model is correct.
The remaining gap is **how a single-tab user can move between portals
without losing context**:

- Add a portal switcher to the rail logo (currently a static badge),
  showing the current portal and a quick-switch popover.
- Keep Hub tiles, but make them open in the **current tab** by default
  (Cmd/Ctrl-click for new tab) so workspace continuity matches user
  expectations (`src/screens/hub.js:53-71`).
- Promote `workspaceSwitcher` from a single-icon control
  (`src/shell/rail.js:91-108`) to a header-anchored organization /
  workspace / portal breadcrumb.

## I. Recommended Design System (refreshed)

Tokens already cover revision lifecycle (`--rev-*`) and semantic colors
(`--success`, `--warn`, `--danger`, `--info`, `--purple`, `--accent`).
Still missing:

- **Severity tokens**: `--sev-1, --sev-2, --sev-3, --sev-4` mapped to
  shape + color + icon; a `SeverityBadge` primitive consuming them.
- **Data-quality tokens**: `--dq-live, --dq-stale, --dq-disconnected,
  --dq-simulated, --dq-historical`. Today the variants are inferred via
  `dataVariant()` helpers redeclared in `assetDetail.js` and
  `workBoard.js`.
- **Density**: `--density-comfortable`, `--density-compact`,
  `--density-cozy` controlling table row height, badge padding, kpi
  size; bound to a user preference.
- **Field-mode CSS**: `body.field-mode` is set but has zero rules; add
  larger touch targets (`.btn { min-height: 44px }`), high-contrast
  incident actions, sticky bottom action bar, and offline / queued
  indicators.
- **Status badge taxonomy**: a `StatusBadge` that takes
  `{ kind, value }` and chooses tone + icon centrally
  (`StatusBadge({ kind: "revision", value: "IFR" })`).

Components to extract into `src/core/ui.js`:

- `Tabs({ tabs, activeId, onPick, sessionKey })` — replaces three custom
  implementations.
- `DataTable({ columns, rows, density, sortable, selectable, emptyState })`
  — replaces ~10 hand-rolled `<table>`s.
- `EmptyState({ icon, title, body, primaryAction, permissionHint })` —
  replaces ~25 `el("div", { class: "muted tiny" }, ["..."])` branches.
- `PageHeader({ title, breadcrumbs, status, actions })` — replaces the
  `row spread` pattern repeated in `workBoard.js`, `approvals.js`,
  `assetDetail.js`, `uns.js`, `incident.js`.
- `dangerAction({ title, body, confirmLabel })` returning a Promise —
  replaces every `window.confirm`.
- `prompt({ title, label, defaultValue, validate })` — replaces every
  `window.prompt`.
- `RailIcon({ glyph, label, active })` — formalizes rail buttons; allows
  swapping emoji for SVG icons in one place.

## J. Component Refactor Plan (refreshed)

1. **Add `Tabs`, `DataTable`, `EmptyState`, `PageHeader`, `Confirm`,
   `Prompt` to `src/core/ui.js`.** Replace per-screen implementations in
   one PR each.
2. **Convert clickable `<div class="activity-row">` to `<button>` or
   add `role="button" tabindex="0"` + keydown handlers.** Mechanical
   refactor; affects ~30 sites.
3. **Make `right-context-panel` on-demand.**
   - Add a "Details" button to `header.js` that toggles
     `state.ui.contextOpen`.
   - Default the panel to closed for users without route-specific context.
   - Open it automatically when the user lands on a doc/drawing/asset/
     incident the first time, then remember the choice in `localStorage`.
4. **Add a portal switcher to the rail logo.** Replace the inline
   workspace badge with a popover showing portal + workspace + org.
5. **Replace dock with an unobtrusive notification button.** Move the
   alert dots into a header bell with a dropdown; remove the always-on
   bottom strip from `index.html` and `styles.css:.operations-dock`.
6. **Normalize emoji rail icons.** Either commit to a single icon font
   (lucide-static) or to a SVG sprite; remove emoji glyphs from
   navigation and tools.
7. **Drawing toolbar split.** Three rows: sheet tabs, mode selector,
   tools (only when in markup mode). Tools become an icon palette with
   tooltips; expose an "Issue from markup" affordance.
8. **Document viewer side pane consolidation.** Collapse 8 side cards
   into 4: Properties (metadata + timeline), Discussion (comments),
   Distribution (transmittals + cross-links), Assist (impact + ai).
9. **Asset detail header.** Drop the 5-KPI strip into the Summary tab;
   keep the page header lean (name, hierarchy, status, owner, primary
   action).
10. **Hub flow.** Default tile click opens in the current tab; add
    Cmd/Ctrl click for new tab; show "Last opened" / "Recent in this
    portal" lists per tile.

## K. Industrial and Engineering UX Recommendations (refreshed)

- The `assetDetail` tabs separate live signals from summary — good.
  Make the same separation apply to `workBoard` project context: the
  Signals tab there is functionally identical and can share a
  `SignalHealthList` component.
- OPC UA write-node and MQTT publish should both gate behind a
  `MaintenanceModeDrawer` that requires severity + reason + signature
  preview + audit reference (currently only OPC UA write signs, and the
  signature is hidden behind a toast).
- `uns.js:241-249 writeValue` should also gate through that drawer.
- The forbidden screen at `app.js:194-208` should explain *which* group
  is required (already known via `ROUTE_GROUPS` in `groups.js`) and
  surface a "Request access" button that creates a work item.

## L. Accessibility and Responsive Review (refreshed)

- `styles.css` has skip link, focus-visible rules, and aria attributes
  on the rail / header — solid foundation.
- Still failing: ~30 clickable `div`s as rows; emoji-only buttons in
  drawing toolbar; tab markup is a `<button>` with `role="tab"` but no
  `tabindex` management or roving focus.
- `body.field-mode` has no CSS — touch-target sizing in field mode is
  identical to desktop.
- Below 900 px: rail and bottom dock both stay full-height/full-width;
  no off-canvas drawer. The mobile screenshot at 700 px shows the rail
  + dock taking ~24 % of vertical real estate.
- Modals (`src/core/ui.js:120-177`) trap focus correctly. Drawer
  (`drawer()`) does the same. **Both are good.** Replacing
  `window.prompt`/`confirm` will inherit those wins.
- Color-only state: badges use color + label, but the label is the
  *value* (`pending`, `failed`) and the variant adds redundant
  semantics; severity / quality / revision lack glyphs and are
  indistinguishable to deuteranopic users.

## M. Risk Register (refreshed)

| Risk | Severity | Where | Mitigation |
|---|---|---|---|
| `window.prompt`/`confirm` for industrial writes | High | `opcua.js`, `mqtt.js`, `uns.js` | Replace with `MaintenanceModeDrawer` that requires severity + reason + signature + audit preview. |
| Permanent ops dock + context panel reduce focus | Medium | `dock.js`, `contextPanel.js`, `styles.css:.app-shell` | Make both on-demand. |
| Emoji icons fail across OS / a11y | Medium | `rail.js`, `drawingViewer.js`, `header.js` | Switch to SVG sprite or icon font. |
| Generic forbidden page | Medium | `app.js:194-208` | Add group/required-membership detail + request-access flow. |
| `window.confirm` for token revoke / webhook delete | Medium | `admin.js:111, 165` | Replace with `dangerAction` primitive. |
| Hub fragments workspace continuity | Medium | `hub.js:53-71` | Default to in-tab navigation; preserve cmd-click. |
| Color-only severity/quality | Low/Medium | All badges | Add glyph + abbreviation; introduce sev/dq tokens. |
| `connector-lifecycle*` CSS not defined | Low | `integrations.js:18` | Either author the styles or remove the strip. |
| `body.field-mode` has no CSS | Medium for field users | `styles.css` | Add field-mode token overrides for touch + contrast. |
| Mobile breakpoints stop at 900 px | Medium | `styles.css:1683-1701` | Add `<= 700px` shell with off-canvas rail. |

## N. Prioritized Roadmap (refreshed)

### Phase 5 — Primitive consolidation (current focus)

- Add `Tabs`, `DataTable`, `EmptyState`, `PageHeader`, `Prompt`,
  `Confirm`, `dangerAction` to `src/core/ui.js`.
- Migrate first three screens (`docViewer`, `incident`, `approvals`).
- Establish severity, data-quality, density tokens in `styles.css`.

### Phase 6 — Shell calm-down

- Right context panel becomes on-demand drawer.
- Bottom ops dock becomes a header notification button.
- Rail logo becomes a portal switcher; emoji icons replaced with SVG.
- Hub click defaults to in-tab navigation.

### Phase 7 — Industrial safety polish

- `MaintenanceModeDrawer` for OPC UA write, MQTT publish, UNS write.
- `StateTransitionDrawer` for incident severity / status.
- Markup-to-issue from drawing.

### Phase 8 — Field & a11y

- `body.field-mode` styles, off-canvas mobile shell, touch targets.
- Replace clickable `<div class="activity-row">` with semantic markup
  workspace-wide.
- Roving tab focus on tabs + tools.

### Phase 9 — Role homes & guidance

- `Home` variants per role using existing groups.
- "Request access" affordance on the forbidden page.
- AI retrieval-state row + permission-denied explainer.
- Saved-view inbox.

## O. Developer-Ready Task List (refreshed)

| Task | File / component | Why it matters | Suggested fix | Priority | Effort |
|---|---|---|---|---|---|
| Add `Tabs` primitive | `src/core/ui.js` | Three custom tab strips diverge in markup and a11y. | `Tabs({ tabs, activeId, onPick, sessionKey, label })` returning role-correct tablist + tabpanel. | P1 | S |
| Add `DataTable` primitive | `src/core/ui.js` | Hand-rolled `<table>` everywhere skips sorting, density, selection. | Sortable headers, optional checkboxes, density toggle, empty-state slot. | P1 | M |
| Add `EmptyState` primitive | `src/core/ui.js` | "No data" branches are inconsistent and miss next actions. | `EmptyState({ icon, title, body, primary, permissionHint })`. | P1 | S |
| Replace `window.prompt` / `confirm` | every screen using them | Browser-native dialogs hurt enterprise feel and skip audit context. | Add `prompt()` and `dangerAction()` modals; codemod call sites. | P1 | M |
| Convert clickable `<div class="activity-row">` to `<button>` | ~30 sites | A11y / keyboard reachability. | Mechanical: change `el("div"...)` to `el("button"...)`; CSS already handles focus. | P1 | M |
| Right context panel on-demand | `src/shell/contextPanel.js`, `src/shell/header.js`, `styles.css` | Permanent panel reduces focus and competes with rich detail. | Add toggle in header, default closed except on object pages, persist preference. | P1 | M |
| Replace bottom dock with header notifications | `src/shell/dock.js`, `index.html`, `styles.css:.operations-dock` | Always-on horizontal strip is anti-calm. | Add a `NotificationBell` to the header that opens a popover with the same items. | P1 | M |
| Add SVG icon set for the rail | `src/shell/rail.js`, new `src/core/icons.js` | Emoji icons render inconsistently and don't match enterprise aesthetics. | Bundle lucide-static SVGs and reference by name. | P1 | M |
| Wire up `connector-lifecycle*` CSS or remove the strip | `src/screens/integrations.js`, `styles.css` | Markup references classes that don't exist, so the lifecycle visual is broken. | Either implement step UI or drop the block. | P1 | S |
| `body.field-mode` styles | `styles.css` | Field mode toggle exists with no visual change. | Add larger touch targets, high-contrast incident actions, sticky bottom bar. | P1 | M |
| `MaintenanceModeDrawer` | new component used by `opcua.js`, `mqtt.js`, `uns.js` | Privileged industrial writes still go through `prompt`. | Drawer with severity, reason, current value, signature preview, audit reference. | P1 | M |
| `StateTransitionDrawer` | `src/screens/incident.js` | Incident severity/status changes use `prompt`. | Drawer that previews FSM-allowed transitions and signs the decision. | P1 | M |
| `MarkupComposer` | `src/screens/drawingViewer.js` | Markup creation uses `prompt`; no link-to-issue affordance. | Composer modal with text, severity, asset link, and "create work item" toggle. | P1 | M |
| Role-aware home | `src/screens/home.js` | Same KPI strip for every role. | Switch on `currentRole()` + groups; show approver queue / field tasks / ops health depending on role. | P1 | M |
| Severity / data-quality tokens | `styles.css`, `src/core/ui.js` | Visual taxonomy is inconsistent across screens. | Add tokens + `SeverityBadge`, `DataQualityBadge`; migrate `assetDetail`, `incident`, `workBoard`. | P2 | M |
| Hub default to in-tab navigation | `src/screens/hub.js` | New-tab default fragments work. | Plain click navigates; modifier keys still open in new tab. | P2 | S |
| Forbidden page detail | `app.js:194-208`, `src/core/groups.js` | Generic message gives no remediation. | Show required group(s), current effective groups, "Request access" CTA. | P2 | S |
| Portal switcher in rail logo | `src/shell/rail.js` | Workspace + portal switching is hidden today. | Replace logo with popover showing org / workspace / portal. | P2 | M |
| Document viewer side pane consolidation | `src/screens/docViewer.js` | 8 side cards feel padded with low-priority content. | Merge into 4 collapsible sections (Properties, Discussion, Distribution, Assist). | P2 | M |
| Drawing toolbar three-row layout | `src/screens/drawingViewer.js` | One ~30-button row is hard to scan. | Sheet tabs / mode selector / mode-bound tools; SVG icons; "issue from markup" affordance. | P2 | M |
| Asset header lean-up | `src/screens/assetDetail.js` | Header has 5 KPIs + tabs + War Room button competing for attention. | Move KPIs into Summary tab; keep header to name + status + owner + primary action. | P2 | S |
| Saved-view inbox | `src/screens/inbox.js` | Single mixed list. | Add Mentions / Approvals / Assigned / Incident actions / External requests views. | P2 | S |
| AI retrieval-state row | `src/screens/ai.js` | No feedback when retrieval finds zero or is permission-filtered. | Add a row above the assistant bubble with `filtered: N · denied: M · indexed: K`. | P2 | S |
| Mobile (≤700 px) shell | `styles.css` | Layout collapses but doesn't reorganize. | Off-canvas rail, bottom-sheet inbox, hidden context panel. | P2 | L |
| Roving tab focus and `aria-controls` | new `Tabs` primitive + screens | Keyboard navigation between tabs is inconsistent. | Implement when consolidating tabs in P1. | P2 | S |
| Drop / move "Reset" button from header | `src/shell/header.js:85-89` | Top-level destructive control with single OK/Cancel. | Move to admin > demo settings. | P2 | S |
| Promote breadcrumbs to navigation | `src/shell/header.js:66-70` | Plain text segments. | Make org / workspace clickable; move portal chip into the breadcrumb. | P3 | S |
| Static dashboards expansion | `src/screens/dashboards.js` | Currently 5 static KPI cards. | Bind to live event/metric snapshots; allow saved dashboards. | P3 | M |

## P. Audit Methodology

This refresh re-read every file listed in
`.claude/skills/enterprise-ux-audit/SKILL.md`'s required-files section,
ran the full server (`npm run build && npm start` against a tmp
`FORGE_DATA_DIR`), signed in as `admin@forge.local`, and visited every
route. Findings cite file paths and line ranges so that each task in
the developer-ready list is grounded in code.

Captured artifacts (under `/opt/cursor/artifacts/`):

- `forge_hub.png`, `forge_home.png`, `forge_projects.png`,
  `forge_work_board.png`, `forge_docs.png`, `forge_doc_viewer.png`,
  `forge_drawings.png`, `forge_drawing_not_found.png`,
  `forge_assets.png`, `forge_asset_restricted.png`,
  `forge_incidents.png`, `forge_approvals.png`,
  `forge_integrations_restricted.png`, `forge_mqtt_restricted.png`,
  `forge_opcua_restricted.png`, `forge_uns.png`,
  `forge_admin_restricted.png`, `forge_ai.png`, `forge_mobile_uns.png`.

The "restricted" screenshots (Integrations / MQTT / OPC UA / Admin /
specific assets) revealed an additional issue: the demo `admin@forge.local`
user has the `Organization Owner` server role, which `groups.js`
`isOrgOwner` keys off `state.ui.role` (the dropdown override). When the
SPA boots before the server `/api/me` resolves, `state.ui.role` is
seeded from the demo state, not from the server user, so portals appear
restricted until the user manually switches the role. Treat that as an
additional P1 fix:

| Task | File / component | Why it matters | Suggested fix | Priority | Effort |
|---|---|---|---|---|---|
| Sync `state.ui.role` with server user on login | `app.js:214-228`, `src/core/groups.js` | After server login, the SPA still uses the demo dropdown role; gates can wrongly forbid the signed-in admin. | When `/api/me` resolves, set `state.ui.role` to the server user's role unless the user has manually overridden it. | P1 | S |
