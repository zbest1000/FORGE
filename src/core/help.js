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
export function listTopicsBySection() {
  /** @type {Record<string, Array<{id: string} & HelpTopic>>} */
  const groups = {};
  for (const [id, topic] of Object.entries(HELP_TOPICS)) {
    (groups[topic.section] = groups[topic.section] || []).push({ id, ...topic });
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
  return HELP_TOPICS[id] || null;
}
