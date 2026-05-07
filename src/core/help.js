// In-app documentation registry + UX helpers.
//
// `HELP_TOPICS` is the single source of truth for every doc topic the
// app links to. Each topic carries:
//   - a short `summary` (used as the hover tooltip on `helpHint()`)
//   - a `body` (markdown-ish — the help-site renderer turns headings,
//     bullets, and ``` fenced code into proper HTML)
//   - optional `example` (request / response object pair)
//   - optional `seeAlso` (related topic ids)
//
// `helpHint(topicId)` returns a small "?" pill that:
//   1. shows `summary` on hover via the native `title` attr
//      (good a11y story; screen readers announce it)
//   2. on click opens `/help?topic=<id>` in a brand new browser tab
//      (unique window name guarantees a fresh tab every press —
//      operators sometimes want to compare two topics side by side).
//
// `helpLinkChip(topicId, label)` is the same idea but renders as a
// pill chip, suitable for "Spec conformance"-style strips where the
// label IS the call-to-action.

import { el } from "./ui.js";

/**
 * @typedef {{
 *   title: string,
 *   section: string,
 *   summary: string,
 *   body: string,
 *   example?: { request?: any, response?: any },
 *   seeAlso?: string[],
 * }} HelpTopic
 */

/** @type {Record<string, HelpTopic>} */
export const HELP_TOPICS = {

  // ---------------------------------------------------------------- i3X concepts
  "i3x.explore": {
    title: "Explore — namespaces, types, objects",
    section: "i3X concepts",
    summary: "Discovery surface: list namespaces / types / objects in the i3X server.",
    body: `
The **Explore** capability covers the read-only "what's here" endpoints. An i3X
client uses these to discover the namespaces, object types, relationship types,
and instance objects published by a server, without yet asking for live values.

The five Explore endpoints:

- \`GET /namespaces\` — list every namespace this server publishes (e.g.
  \`urn:cesmii:isa95:1\`, \`urn:forge:signals:1\`).
- \`GET /objecttypes?namespaceUri=...\` — list the type definitions inside
  a namespace (Equipment, ProductionLine, Variable, Alarm, …).
- \`GET /relationshiptypes?namespaceUri=...\` — list the relationship types
  (\`composition\`, \`reference\`, …).
- \`GET /objects?typeElementId=...\` — list instance objects of a given type.
- \`POST /objects/list\` and \`POST /objects/related\` — bulk fetch by element
  id and follow relationships.

Use this surface BEFORE Query — you can't ask for the value of an element
you haven't discovered.
`,
    seeAlso: ["i3x.query", "i3x.composition"],
  },

  "i3x.query": {
    title: "Query — last-known values & history",
    section: "i3X concepts",
    summary: "Read live VQT values and historical traces for one or more elements.",
    body: `
The **Query** capability covers the live and historical read paths.

- \`POST /objects/value\` — last-known **VQT** (Value, Quality, Timestamp) for
  one or more element ids. The optional \`maxDepth\` parameter pulls
  children's values too, returning a composition rollup.
- \`POST /objects/history\` — time-series history for the same shape.

VQT is the heart of i3X. Every value carries a timestamp and a quality flag
(\`Good\`, \`Uncertain\`, \`Bad\`, \`GoodNoData\`). Operators MUST check quality
before acting on a reading — a "Good" pressure of zero is far more
trustworthy than an "Uncertain" one of 50 bar.
`,
    example: {
      request: { elementIds: ["asset.AS-1"], maxDepth: 1 },
      response: {
        success: true,
        data: {
          results: [{
            elementId: "asset.AS-1",
            result: { value: 112.3, quality: "Good", timestamp: "2026-05-02T08:00:00Z", unit: "degC" },
          }],
        },
      },
    },
    seeAlso: ["i3x.explore", "i3x.subscribe"],
  },

  "i3x.update": {
    title: "Update — write a value",
    section: "i3X concepts",
    summary: "Write a VQT to a writable variable (PUT /objects/{id}/value).",
    body: `
The **Update** capability is a single endpoint: \`PUT /objects/{id}/value\`.

It writes a VQT to a *writable* variable — not every variable in the
namespace is writable, the type definition controls that. Writes are
gated by capability \`integration.write\` plus the per-route rate limit
(default 10 writes/minute/user) so a runaway script can't flood the
device.

Every write is audited with the requesting user, the resolved tenant
key, and the prior value (so you can roll back).
`,
    example: {
      request: { elementId: "asset.AS-1.setpoint", value: 110, quality: "Good" },
      response: { success: true, data: { acknowledged: true, sequenceNumber: 42 } },
    },
    seeAlso: ["i3x.query"],
  },

  "i3x.subscribe": {
    title: "Subscribe + Stream — change-driven updates",
    section: "i3X concepts",
    summary: "Open a subscription, register element ids, sync to receive deltas.",
    body: `
The **Subscribe** capability turns the polling-style Query model into a
push model. The flow:

1. \`POST /subscriptions\` — create a subscription handle for your client.
2. \`POST /subscriptions/register\` — tell the server which element ids
   you want updates for.
3. \`POST /subscriptions/sync\` — long-poll: returns every value-change
   that's happened since the last \`lastSequenceNumber\` you sent in.
4. \`POST /subscriptions/delete\` — clean up when you're done.

The Workbench shows the subscription stream live in the bottom card —
each tick simulates an MQTT/OPC UA ingress event so you can watch the
deltas roll in.

Use Subscribe for dashboards (the only data you re-fetch is the data
that *changed*). Use Query for one-shot reads and historical
inspection.
`,
    seeAlso: ["i3x.query", "i3x.bulk"],
  },

  "i3x.bulk": {
    title: "Bulk responses",
    section: "i3X concepts",
    summary: "Every i3X endpoint returns a uniform { success, data, errors[] } envelope.",
    body: `
i3X envelopes are uniform across every endpoint:

\`\`\`json
{
  "success": true,
  "data":    { /* result-shape varies */ },
  "errors":  [ /* optional per-item errors when success === true */ ]
}
\`\`\`

The point of the **Bulk** convention: \`success: true\` does NOT mean
"every item in the request succeeded". It means "the request was well-
formed and the server processed it". Per-item failures land in the
\`errors\` array with the offending element id.

This is what lets a client send \`elementIds: [a, b, c]\` and get back a
useful response even if \`b\` is unauthorised — \`a\` and \`c\` come back
in \`data.results\`, \`b\` lands in \`errors\` with \`code: "unauthorized"\`.

Always inspect both \`data\` and \`errors\` before declaring success.
`,
  },

  "i3x.composition": {
    title: "Composition (instance-only)",
    section: "i3X concepts",
    summary: "Element ids form a composition tree; rollups query parents to children.",
    body: `
Every i3X object lives at a path in a **composition graph**. A piece
of equipment is composed of variables and alarms; a production line
is composed of cells; a cell is composed of equipment.

The element id reflects the path:

\`\`\`
asset.AS-1                            (Equipment)
asset.AS-1.temp                       (Variable, child of AS-1)
asset.AS-1.alarms.high-temp           (Alarm, child of AS-1)
\`\`\`

Most read endpoints accept a \`maxDepth\` parameter. \`maxDepth: 1\`
returns just the element you asked for. \`maxDepth: 2\` rolls up its
direct children. \`maxDepth: -1\` returns the entire subtree (used
sparingly — large equipment can have thousands of children).

Composition is **instance-only**: you cannot query a *type's* children
this way. Object-type relationships are described separately by
\`/objecttypes\` and \`/relationshiptypes\`.
`,
    seeAlso: ["i3x.isa95"],
  },

  "i3x.isa95": {
    title: "ISA-95 types",
    section: "i3X concepts",
    summary: "ISA-95 is the standard hierarchy for industrial assets — Site / Area / Line / Cell / Equipment.",
    body: `
ISA-95 (IEC 62264) is the industrial-automation standard for the
hierarchy of assets in a manufacturing operation. The CESMII i3X
\`urn:cesmii:isa95:1\` namespace publishes the canonical type set:

- **Enterprise** — the company.
- **Site** — a physical location.
- **Area** — a subdivision of a site (e.g. North Plant > Utilities).
- **ProductionLine** — a connected sequence of equipment producing a
  product (Line A, Line B).
- **Cell** / **WorkUnit** — a station within a line.
- **Equipment** — a discrete machine (HX-01, Feeder A1, Boiler B-201).
- **Variable** — a measurable signal on a piece of equipment.
- **Alarm** — a condition derived from one or more variables.

FORGE's UNS browser lays these out as a tree (left pane in /uns).

Vendors don't have to use exactly the ISA-95 structure — i3X allows
custom namespaces alongside — but ISA-95 is the lingua franca that
makes cross-vendor / cross-site queries work.
`,
    seeAlso: ["i3x.composition"],
  },

  // ---------------------------------------------------------------- i3X endpoints (one entry per workbench row)
  "i3x.endpoint.info":              { section: "i3X endpoints", title: "GET /info",                      summary: "Server identity, version, and counts of namespaces / types / objects / subscriptions.", body: "Returns the server's implementation name, the i3X spec version it conforms to, and quick health counts you can use as a smoke check." },
  "i3x.endpoint.namespaces":        { section: "i3X endpoints", title: "GET /namespaces",                summary: "List published namespaces (URIs + descriptions).", body: "Each namespace is a distinct vocabulary of types and relationships. Most servers publish at least the ISA-95 namespace plus one or more vendor / FORGE-specific namespaces." },
  "i3x.endpoint.objecttypes":       { section: "i3X endpoints", title: "GET /objecttypes",               summary: "List object types in a namespace (Equipment, Variable, Alarm, …).", body: "Pass `?namespaceUri=...` to scope. Returns each type's element id, parent type, and attribute schema." },
  "i3x.endpoint.relationshiptypes": { section: "i3X endpoints", title: "GET /relationshiptypes",         summary: "List relationship types (composition, reference, …).", body: "Composition is the parent-child relationship; references are loose pointers (e.g. an alarm referencing the variable that triggered it)." },
  "i3x.endpoint.objects":           { section: "i3X endpoints", title: "GET /objects",                   summary: "List instance objects, optionally filtered by type / root.", body: "`typeElementId` filters to a single type; `root=true` returns only top-level objects (no parent in the composition graph). `includeMetadata=true` adds the `path` and the `attributes` map per object." },
  "i3x.endpoint.objects.list":      { section: "i3X endpoints", title: "POST /objects/list",             summary: "Bulk fetch instance objects by element id.", body: "More efficient than calling `/objects` once per id when you have a known set. Returns the same shape as `/objects` for each requested id." },
  "i3x.endpoint.objects.related":   { section: "i3X endpoints", title: "POST /objects/related",          summary: "Follow relationships from a set of starting objects.", body: "Body: `{ elementIds, relationshipType }`. Returns objects related to the input set via the named relationship — e.g. all variables composed of a given equipment." },
  "i3x.endpoint.objects.value":     { section: "i3X endpoints", title: "POST /objects/value",            summary: "Last-known VQT for one or more elements.", body: "Body: `{ elementIds, maxDepth }`. `maxDepth: 1` returns the element's own value; `maxDepth: 2+` rolls up children's values into a `components` map." },
  "i3x.endpoint.objects.history":   { section: "i3X endpoints", title: "POST /objects/history",          summary: "Time-series history for one or more elements.", body: "Body accepts `since` / `until` / `limit` to bound the window. Quality flags accompany every sample." },
  "i3x.endpoint.objects.id.value":  { section: "i3X endpoints", title: "PUT /objects/{id}/value",        summary: "Write a VQT to a writable variable.", body: "Capability-gated by `integration.write`. Rate-limited per user. The previous value is captured in the audit log." },
  "i3x.endpoint.subscriptions":           { section: "i3X endpoints", title: "POST /subscriptions",            summary: "Create a subscription handle.", body: "Returns a `subscriptionId` you reuse on every subsequent register / sync call." },
  "i3x.endpoint.subscriptions.register":  { section: "i3X endpoints", title: "POST /subscriptions/register",   summary: "Register element ids you want delta updates for.", body: "Idempotent — re-registering the same ids is a no-op." },
  "i3x.endpoint.subscriptions.sync":      { section: "i3X endpoints", title: "POST /subscriptions/sync",       summary: "Pull deltas since lastSequenceNumber.", body: "The first call should set `lastSequenceNumber: null`. Subsequent calls echo back the latest sequence number from the previous response." },
  "i3x.endpoint.subscriptions.list":      { section: "i3X endpoints", title: "POST /subscriptions/list",       summary: "Inspect existing subscriptions on the server.", body: "Body: `{ subscriptionIds }`. Useful for dashboards reconciling state after a reload." },
  "i3x.endpoint.subscriptions.delete":    { section: "i3X endpoints", title: "POST /subscriptions/delete",     summary: "Clean up subscription handles.", body: "Always call before the client exits. The server times out abandoned subscriptions but explicit cleanup avoids leaking sequence buffers." },

  // ---------------------------------------------------------------- FORGE concepts (a starter set — extend over time)
  "forge.asset":      { section: "FORGE concepts", title: "Assets",     summary: "Industrial things FORGE tracks: equipment, lines, sites.", body: "An asset is the FORGE primitive for industrial things — a piece of equipment, a production line, a site. Assets carry hierarchy, status, ACLs, and a list of attached docs / drawings. Every UNS object surfaces as an asset in /assets." },
  "forge.document":   { section: "FORGE concepts", title: "Documents",  summary: "Controlled records (specs, SOPs, P&IDs) with revisions and approvals.", body: "Documents in FORGE are revision-controlled. Each revision has a status (Draft → IFR → Approved → IFC → Superseded) and an approval queue. The doc viewer pins regional comments at normalised (page, x, y) coordinates so they survive re-flow." },
  "forge.workitem":   { section: "FORGE concepts", title: "Work items", summary: "Tasks, issues, RFIs, punch items — the unit of project execution.", body: "Work items live on a kanban board per project. They cross-reference docs / assets / incidents and accept multi-author comments. Formula fields support live expressions (e.g. `daysUntilDue(due)`)." },
  "forge.incident":   { section: "FORGE concepts", title: "Incidents",  summary: "Operational events with severity, command roster, and audit timeline.", body: "Incidents have a severity (SEV-1 to SEV-5), a status FSM (active → escalated → stabilized → resolved → postmortem), a configurable command roster (Commander/Scribe/Ops lead/...), and a tamper-evident timeline." },
  "forge.profile":    { section: "FORGE concepts", title: "Asset profiles", summary: "Reusable schema mapping data points (temp, pressure) to MQTT topics / OPC UA nodes / SQL.", body: "An asset profile is a versioned template. Apply it to an asset + a registered system and FORGE generates the bindings, subscribes to the right topic patterns, and ingests samples into the historian." },
  "forge.audit":      { section: "FORGE concepts", title: "Audit ledger", summary: "Tamper-evident chain of every state-changing action.", body: "Every mutation in FORGE writes an audit row with a hash chain back to the previous row. The ledger is queryable at /audit and exports as JSON / CSV. Hash chain integrity is checked by a worker on a slow cadence." },
  "forge.permissions":{ section: "FORGE concepts", title: "Permissions", summary: "Capability-based RBAC — view, create, edit, approve, integration.write, ...", body: "FORGE uses capabilities, not role strings. Capabilities are mapped to roles in `server/auth.js`. Custom capabilities like `historian.sql.raw` (write free-form SQL queries against historians) are gated to Workspace Admin by default." },
  "forge.integrations": { section: "FORGE concepts", title: "Integrations", summary: "Connectors that publish into the canonical UNS — MQTT / OPC UA / Modbus / SQL / ERP / REST.", body: "Integrations ingest source data and surface it as variables on assets. Each connector has a kind, an endpoint, an optional credential reference, and a status (connected / degraded / failed). Mutations are gated by `integration.write` and audited; deletes are refused while data sources reference the connector." },
  "forge.operations":   { section: "FORGE concepts", title: "Operations data", summary: "Live process telemetry — historian samples, MQTT messages, OPC UA monitored items.", body: "The Operations console surfaces live VQT data flowing through the registered connectors. Each sample lands in the historian (SQLite by default) and broadcasts as an SSE `historian` event. Use Ops Data for at-a-glance monitoring; the asset detail Data tab gives per-asset trend charts." },
  "forge.audit-chain":  { section: "FORGE concepts", title: "Audit ledger (hash-chained)", summary: "Each audit row carries a hash of the previous row — tamper-evident.", body: "Every state-changing action writes an audit row containing the action, subject, actor, timestamp, and a SHA-256 hash chained back to the previous row's hash. A background worker periodically verifies the chain and surfaces breaks at /admin/audit. Rotating tenant keys does not invalidate prior chain entries — each row's hash is HMAC'd at write time." },
  "forge.mqtt":         { section: "FORGE concepts", title: "MQTT bridge",   summary: "Publish/subscribe broker integration — Sparkplug B / MQTT 3 / 5 supported.", body: "FORGE subscribes to topic patterns from registered MQTT brokers and ingests messages as historian samples. The encoding selector on the bridge config picks between Sparkplug B (with metric metadata), raw JSON, and raw text. Messages route through dedupe keys and enter the canonical event envelope in `events.js`." },
  "forge.opcua":        { section: "FORGE concepts", title: "OPC UA bridge", summary: "Industrial OPC UA endpoint integration — bucketed monitored items.", body: "FORGE creates one OPCUAClient per registered endpoint and subscribes via batched `CreateMonitoredItems` calls bucketed by publishing interval (250 ms / 1 s / 5 s / 60 s). Reload uses surgical `addMonitoredItems` / `deleteMonitoredItems` rather than reconnecting." },
  "forge.spec":         { section: "FORGE concepts", title: "FORGE spec",    summary: "The canonical spec for FORGE's industrial-edge surface (UNS, audit, integrations, RBAC).", body: "The full specification lives at `docs/INDUSTRIAL_EDGE_PLATFORM_SPEC.md`. The /spec route renders a read-only view of section IDs and brief descriptions; cite spec section numbers (e.g. §6.2) in audit notes and PR descriptions." },

  // Document control
  "forge.doc.revisions":  { section: "Document control", title: "Revision lifecycle", summary: "Draft → IFR → Approved → IFC → Superseded — the controlled-document FSM.", body: "Each revision moves through: **Draft** (work in progress), **IFR** (Issued For Review — circulating for comment), **Approved** (signed off but not yet released), **IFC** (Issued For Construction — released to downstream parties), **Superseded** (replaced by a newer revision), **Rejected** / **Archived** (terminal). Transitions write to the audit chain; transmittals record outbound IFC issuance to specific recipients." },
  "forge.doc.transmittal":{ section: "Document control", title: "Transmittals", summary: "The record of releasing a revision externally — to whom, when, and what attachments.", body: "A transmittal pairs a revision with a recipient list and a date. FORGE generates a draft cover letter from the revision's metadata (discipline, package, area, line) which the operator edits before sending. The transmittal record is immutable once sent." },
  "forge.doc.regional-comments":{ section: "Document control", title: "Regional comments (pins)", summary: "Discussion threads pinned to (page, x, y) coordinates on a doc revision.", body: "Pins anchor to normalised coordinates so they survive page re-flow. Each pin holds a comment thread; threads roll up onto the revision and surface in approval review. Drop a pin: in Annotate mode click the page; in View mode hold Alt and click." },
  "forge.doc.metadata":   { section: "Document control", title: "Metadata fields", summary: "Discipline, Package, Area, Line, System, Vendor, Sensitivity — the indexable axes of a document.", body: "Metadata controls who can SEE the document (Sensitivity), how it shows up in search, and how the revision compare/impact analyses cluster results. Area / Line / System / Package / Vendor autocomplete from existing assets and documents in the workspace." },

  // Drawings + CAD
  "forge.drawing":        { section: "Drawings", title: "Drawing viewer", summary: "PDF / DWG / DXF / IFC / STEP / IGES / STL / OBJ / glTF — unified viewer with markup palette.", body: "Each format routes to the appropriate engine (PDF.js for PDFs, three.js for 3D, mlightcad for in-browser DWG, web-ifc for IFC). Markup palette overlays survive across format kinds and round-trip through the comparison view." },
  "forge.drawing.compare":{ section: "Drawings", title: "Revision compare", summary: "Side-by-side or overlay comparison of two drawing revisions.", body: "Split panes show the two revisions; the opacity slider blends them. Changed regions are detected automatically and listed in the diff legend with linked issues. Compare is symmetric — choose either revision as the base." },
  "forge.drawing.markup": { section: "Drawings", title: "Markup palette", summary: "Stamps, text, arrows, dimensions — drawing markups stored as overlays.", body: "Markups are non-destructive — the underlying CAD/PDF is never modified. Each markup carries an author, timestamp, and audit row. Use markups for redlines, queries, and approvals." },

  // Spaces + channels + messaging
  "forge.spaces":         { section: "Collaboration", title: "Team spaces", summary: "A workspace primitive containing channels, projects, members, and shared docs.", body: "Team spaces are the unit of access scoping below the workspace level. Each space has its own channels, projects, document subset, and member list. ACLs cascade from the space to its children unless overridden." },
  "forge.channels":       { section: "Collaboration", title: "Channels", summary: "Structured threads — discussion / review / decision / handover / alarm.", body: "Channels carry typed messages. Each post has a `type` (discussion, review, decision, handover, alarm). Decisions are highlighted as DECISION badges and roll up in the channel summary. Live channels can be locked to read-only when an incident is bound to them." },
  "forge.channels.mentions": { section: "Collaboration", title: "@-mentions", summary: "Resolve users by initials, name, or @handle; mentions notify the recipient.", body: "Type `@` to start a mention. The mention resolver matches against initials, full name, or handle (case-insensitive). Mentioned users get a notification in their inbox with a back-link to the message." },
  "forge.channels.decisions":{ section: "Collaboration", title: "Decision markers", summary: "Posts of type=decision are pinned to the channel and roll up in audit/AI summaries.", body: "Decisions create an immutable record of WHO decided WHAT and WHEN. The decision type promotes the post in summaries and exports; it does not change visibility." },

  // Approvals
  "forge.approvals":      { section: "Approvals", title: "Approval queue", summary: "Per-user queue of items awaiting your signature; SLA, delegation, expiry.", body: "Approvals are typed by subject (Revision / WorkItem / Project). Each row shows SLA (time remaining), severity, and delegation. Approve / Reject prompts capture signature notes; Delegate transfers the item to another approver with audited reason." },
  "forge.approvals.sla":  { section: "Approvals", title: "SLA timers", summary: "Each approval carries a deadline; missed SLAs escalate to incidents.", body: "SLA timers start when the approval enters the queue. The colour shifts from info → warn → danger as the deadline approaches. After expiry, the approval is auto-escalated to an incident with severity matching the subject's risk." },

  // AI + search
  "forge.ai":             { section: "AI", title: "AI workspace",  summary: "Permission-filtered, citation-backed answers grounded in workspace data.", body: "The AI workspace runs a model router (configurable per workspace) over your indexed corpus. Every answer carries citations back to the source docs / messages / assets. Answers respect the asker's permissions — anything they can't see in the UI is invisible to the model." },
  "forge.ai.citations":   { section: "AI", title: "Citations", summary: "Every AI answer cites source docs / messages / assets — clickable back-links.", body: "Citations appear as `[REV-1-B]`, `[INC-4412]`, etc. Click any citation to jump to the cited object. The citation set is the model's grounding window — if a fact isn't backed by a citation, treat the AI's claim with extra scrutiny." },
  "forge.search":         { section: "Search", title: "Workspace search", summary: "Cross-domain search — docs / drawings / assets / work-items / incidents / channels.", body: "The command palette (⌘K) and the /search route share the same index. Results are permission-filtered. Quotes match phrases; `kind:Document` narrows by domain." },
  "forge.inbox":          { section: "Inbox", title: "Inbox & notifications", summary: "Mentions, approvals, incidents, and follow notifications converge here.", body: "Each notification carries a `kind` (mention / approval / incident / follow / system) and a back-link. Marking all read clears the badge but does not remove notifications from the audit ledger." },

  // ISA-95 hierarchy + asset model
  "forge.isa95":          { section: "Industrial hierarchy", title: "ISA-95 hierarchy",  summary: "Enterprise → Site → Area → ProductionLine → Cell → Equipment.", body: "ISA-95 (IEC 62264) is the standard hierarchy for industrial assets. FORGE's UNS uses these levels for navigation and for the canonical UNS path (`acme/site42/lineA/cell3/HX-01/temperature`). Custom levels are allowed alongside the standard hierarchy." },
  "forge.uns":            { section: "Industrial hierarchy", title: "Unified Namespace", summary: "Canonical addressing layer over MQTT / OPC UA / SQL — single hierarchy across vendors.", body: "UNS publishes a hierarchical, ISA-95-aligned graph of every asset and variable in the workspace. Every connector (MQTT broker / OPC UA endpoint / SQL historian) maps its source path to a UNS path. The UNS browser at /uns walks this graph; the i3X API queries it programmatically." },
  "forge.uns.path":       { section: "Industrial hierarchy", title: "UNS path conventions", summary: "Slash-separated, lowercase, ISA-95-aligned — `enterprise/site/area/line/equipment/variable`.", body: "Conventions: lowercase ASCII, slash separators, no spaces, no special chars. Variables/alarms hang off equipment as the leaf level. Profiles use template tokens like `{enterprise}/{site}/{asset}/{point}` that resolve against the asset's hierarchy on bind." },

  // Incidents
  "forge.incidents.severity":{ section: "Incidents", title: "Severity levels", summary: "SEV-1 (critical) → SEV-5 (informational) — drives SLA, paging, and command structure.", body: "Severity sets the SLA timer, the on-call paging policy, and the size of the command roster. SEV-1 incidents are auto-paged to the workspace's pager rotation; SEV-3 and below are routed to channels only." },
  "forge.incidents.postmortem":{ section: "Incidents", title: "Postmortem", summary: "Post-resolution analysis — timeline, contributing factors, action items.", body: "Resolved incidents enter the postmortem state. The system pulls the timeline + linked work items into a structured doc; the IC fills in contributing factors and remediation. Postmortems are searchable as documents." },

  // Profiles
  "forge.profile.versions":{ section: "Profiles", title: "Profile versions", summary: "Profiles are immutable — every edit creates a new version; bindings pin to a version.", body: "Editing a profile (its template, points, or kind) creates a new immutable version. Existing asset bindings stay pinned to the version they were created against; upgrade is explicit per-asset or fleet-wide. This avoids silent drift across hundreds of bound assets." },
  "forge.profile.binding":{ section: "Profiles", title: "Asset point bindings", summary: "The per-asset link from a profile point to a real source path on a real connector.", body: "When you apply a profile to an asset + a registered system, FORGE resolves the path template against the asset's hierarchy variables and creates one binding per point. Each binding stores the resolved path, the system id, and the pinned profile-version id. Custom mappings have null profile_version_id." },

  // ERP
  "forge.erp.mapping":   { section: "ERP", title: "Mapping matrix", summary: "Bidirectional ERP↔FORGE entity map — PurchaseOrder ↔ WorkItem(RFI), CostCenter ↔ TeamSpace, etc.", body: "Each ERP entity type maps to a FORGE entity type with a transform script. Status badges show the sync health: in-sync (no drift), drift (some fields differ but not flagged), conflict (active conflict needing resolution). Conflicts queue up in the conflict queue with side-by-side diff." },
  "forge.erp.drift":     { section: "ERP", title: "Drift vs conflict", summary: "Drift = differences detected; conflict = differences flagged for resolution.", body: "Drift is informational — fields differ but the system can keep syncing in a chosen direction. Conflicts arrive when the drift exceeds a configured tolerance, when both sides updated the same field since last sync, or when the transform fails on a row. Conflicts block the sync until resolved." },
  "forge.erp.backfill":  { section: "ERP", title: "Backfill", summary: "Dry-run + commit a bulk migration of historical ERP data into FORGE.", body: "Backfill walks an ERP entity type and creates / updates the matching FORGE objects. Dry-run shows what would change without writing; commit writes everything in a single audited batch. Use for initial integration or after a transform-rule change." },

};

let _helpSeq = 0;

/**
 * Render a small inline "?" hint that opens the topic in a new tab.
 * Always opens a NEW tab even if one's already open — uses a unique
 * window name so the browser doesn't reuse an existing FORGE help tab.
 *
 * @param {string} topicId
 * @param {{ tooltip?: string, label?: string }} [opts]
 * @returns {HTMLElement}
 */
export function helpHint(topicId, opts = {}) {
  const topic = HELP_TOPICS[topicId];
  const id = ++_helpSeq;
  return el("button", {
    type: "button",
    class: "help-hint",
    "aria-label": `Open help: ${topic?.title || topicId}`,
    title: opts.tooltip || topic?.summary || (topic?.title || topicId),
    "data-help-id": String(id),
    "data-topic": topicId,
    onClick: (e) => { e.preventDefault(); e.stopPropagation(); openHelpTopic(topicId); },
  }, [el("span", { "aria-hidden": "true" }, [opts.label || "?"])]);
}

/**
 * Render a chip that BOTH links to the topic AND shows the topic
 * summary on hover. Used for "Spec conformance" badge strips and
 * similar surfaces where the label IS the call-to-action.
 *
 * @param {string} topicId
 * @param {string} label
 * @param {{ variant?: string }} [opts]
 * @returns {HTMLElement}
 */
export function helpLinkChip(topicId, label, opts = {}) {
  const topic = HELP_TOPICS[topicId];
  return el("button", {
    type: "button",
    class: `chip help-link ${opts.variant ? "chip-" + opts.variant : ""}`,
    "aria-label": `Open help: ${label}`,
    title: topic?.summary || label,
    "data-topic": topicId,
    onClick: (e) => { e.preventDefault(); e.stopPropagation(); openHelpTopic(topicId); },
  }, [
    el("span", { class: "help-link-label" }, [label]),
    el("span", { class: "help-link-icon", "aria-hidden": "true" }, [" ↗"]),
  ]);
}

/**
 * Open a help topic in a new browser tab. Each call uses a unique
 * window name so the browser opens a separate tab every press —
 * users sometimes want to compare two topics side-by-side, and the
 * default `_blank` would happily reuse the same tab on some
 * browsers.
 *
 * @param {string} topicId
 */
export function openHelpTopic(topicId) {
  const url = `${location.origin}${location.pathname}#/help?topic=${encodeURIComponent(topicId)}`;
  const name = `forge-help-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    window.open(url, name, "noopener");
  } catch {
    // Pop-up blocker — fallback: navigate the current tab.
    location.href = url;
  }
}

/** @returns {Array<{ section: string, topics: Array<{id: string} & HelpTopic> }>} Grouped + sorted topic list for the help-site renderer. */
// Live-overrides store (Phase 4). Bundled HELP_TOPICS stays the
// always-available default — drift between product and docs was the
// audit's concern. Operators can layer overrides on top via:
//
//   applyHelpOverrides({ "forge.workitem": { body: "<new>", ... } })
//
// or an HTTP fetch:
//
//   await loadHelpOverrides("/api/help/topics");
//
// Overrides ride at runtime; the bundled topics remain the safety net
// (e.g. when the fetch fails, when the operator hasn't authored their
// own content, or when the override JSON is malformed).
//
// Override payload shape: a plain object mapping topicId → partial
// HelpTopic. Fields present on the override replace the bundled
// values; missing fields fall through to the default. Unknown topic
// ids are also accepted — they appear as new entries in the index.
/** @type {Record<string, Partial<HelpTopic>>} */
const _overrides = Object.create(null);

/**
 * Merge in an overrides bundle. Idempotent — calling repeatedly with
 * the same payload converges to the same effective topic set.
 */
export function applyHelpOverrides(overrides) {
  if (!overrides || typeof overrides !== "object") return;
  for (const [id, patch] of Object.entries(overrides)) {
    if (!patch || typeof patch !== "object") continue;
    _overrides[id] = { ..._overrides[id], ...patch };
  }
}

/** Drop all overrides and revert to the bundled set. */
export function clearHelpOverrides() {
  for (const k of Object.keys(_overrides)) delete _overrides[k];
}

/**
 * Fetch a JSON overrides bundle from `url` and apply it. Failures are
 * silent (the bundled topics remain in effect) — callers that want to
 * surface failures can check the returned promise.
 *
 * Expected response shape:
 *   { topicId: { title?, summary?, body?, section?, example?, seeAlso? }, ... }
 */
export async function loadHelpOverrides(url) {
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    applyHelpOverrides(json);
    return { ok: true, count: Object.keys(json).length };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

/**
 * Look up the effective topic — overrides win over bundled, with
 * field-level merging so an override that sets only `body` keeps the
 * bundled `title` / `summary` / `section` etc.
 */
function resolveTopic(id) {
  const base = HELP_TOPICS[id] || null;
  const over = _overrides[id];
  if (!base && !over) return null;
  if (!over) return base;
  return { ...(base || {}), ...over };
}

export function listTopicsBySection() {
  /** @type {Record<string, Array<{id: string} & HelpTopic>>} */
  const groups = {};
  // Union of bundled + overridden topic ids. Lets a remote bundle
  // introduce a brand-new topic without re-shipping the client.
  const ids = new Set([...Object.keys(HELP_TOPICS), ...Object.keys(_overrides)]);
  for (const id of ids) {
    const topic = resolveTopic(id);
    // Skip topics that don't have the minimum render fields. A
    // valid topic needs at least a section + title; without those
    // it can't appear in the index. This catches malformed override
    // payloads (e.g. an override that only sets `body` for an id
    // that has no bundled counterpart).
    if (!topic || !topic.section || !topic.title || !topic.summary || !topic.body) continue;
    /** @type {{id: string} & HelpTopic} */
    const entry = {
      id,
      title: topic.title,
      section: topic.section,
      summary: topic.summary,
      body: topic.body,
      example: topic.example,
      seeAlso: topic.seeAlso,
    };
    (groups[topic.section] = groups[topic.section] || []).push(entry);
  }
  for (const k of Object.keys(groups)) {
    groups[k].sort((a, b) => a.title.localeCompare(b.title));
  }
  // Stable section ordering — concepts before endpoints before objects.
  const order = ["i3X concepts", "i3X endpoints", "FORGE concepts"];
  const known = order.filter(k => groups[k]);
  const extras = Object.keys(groups).filter(k => !order.includes(k)).sort();
  return [...known, ...extras].map(s => ({ section: s, topics: groups[s] }));
}

export function getTopic(id) {
  return resolveTopic(id);
}
