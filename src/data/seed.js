// Seed domain data for FORGE MVP. Small but realistic; covers all MVP object types.

function iso(offsetMinutes = 0) {
  return new Date(Date.now() + offsetMinutes * 60_000).toISOString();
}

export function buildSeed() {
  const organization = {
    id: "ORG-1",
    name: "Atlas Industrial Systems",
    tenantKey: "atlas",
  };

  const workspace = {
    id: "WS-1",
    orgId: "ORG-1",
    name: "North Plant",
    region: "us-east",
  };

  // Spec §5.1 calls for a workspace switcher. Seed a second workspace so the
  // switcher has something to show; objects keep their default workspace_id
  // and the switcher filters them client-side via state.ui.workspaceId.
  const workspaces = [
    workspace,
    { id: "WS-2", orgId: "ORG-1", name: "Site 2 Build",   region: "us-east", icon: "🏗" },
    { id: "WS-3", orgId: "ORG-1", name: "Lab — R&D",      region: "us-west", icon: "🧪" },
  ];

  const users = [
    { id: "U-1", name: "J. Singh",      role: "Engineer/Contributor",  initials: "JS" },
    { id: "U-2", name: "R. Okafor",     role: "Reviewer/Approver",     initials: "RO" },
    { id: "U-3", name: "M. Torres",     role: "Operator/Technician",   initials: "MT" },
    { id: "U-4", name: "D. Chen",       role: "Workspace Admin",       initials: "DC" },
    { id: "U-5", name: "L. Abidemi",    role: "Integration Admin",     initials: "LA" },
    { id: "U-6", name: "A. Patel",      role: "Team Space Admin",      initials: "AP" },
  ];

  const teamSpaces = [
    { id: "TS-1", name: "Controls Engineering", summary: "PLC/HMI/SCADA work for Line A and B", memberIds: ["U-1","U-2","U-3","U-4"] },
    { id: "TS-2", name: "Reliability & Ops",    summary: "Maintenance, incidents, shift handover", memberIds: ["U-3","U-4","U-6"] },
    { id: "TS-3", name: "EPCM Project Delta",   summary: "Capital project — Site 2 expansion",    memberIds: ["U-2","U-4","U-6"] },
  ];

  const projects = [
    { id: "PRJ-1", teamSpaceId: "TS-1", name: "Line A Controls Upgrade", status: "active", dueDate: iso(60*24*14), milestones: ["FAT", "SAT", "Commissioning"] },
    { id: "PRJ-2", teamSpaceId: "TS-3", name: "Site 2 Expansion — Package 3", status: "active", dueDate: iso(60*24*60), milestones: ["IFR", "IFC", "Handover"] },
    { id: "PRJ-3", teamSpaceId: "TS-2", name: "Boiler Reliability Initiative", status: "planning", dueDate: iso(60*24*30) },
  ];

  const channels = [
    { id: "CH-1", teamSpaceId: "TS-1", name: "line-a-controls",     kind: "project",  unread: 2 },
    { id: "CH-2", teamSpaceId: "TS-1", name: "line-b-panels",       kind: "project",  unread: 0 },
    { id: "CH-3", teamSpaceId: "TS-2", name: "ops-floor-a",         kind: "team",     unread: 5 },
    { id: "CH-4", teamSpaceId: "TS-2", name: "incident-b-24h",      kind: "incident", unread: 0 },
    { id: "CH-5", teamSpaceId: "TS-3", name: "delta-review",        kind: "project",  unread: 1 },
  ];

  const threads = [];

  const messages = [
    { id: "M-1", channelId: "CH-1", authorId: "U-1", ts: iso(-90), type: "discussion",
      text: "Uploaded D-101 Rev B with revised valve tags. Requesting review from @RO.",
      attachments: [{ kind: "document", id: "DOC-1" }] },
    { id: "M-2", channelId: "CH-1", authorId: "U-2", ts: iso(-60), type: "review",
      text: "Reviewed markups on sheet 2. Opened issue WI-102 for missing terminal strip." },
    { id: "M-3", channelId: "CH-1", authorId: "U-3", ts: iso(-20), type: "discussion",
      text: "Operator feedback: HMI screen refresh is slow during ramp-up. Logging issue." },
    { id: "M-4", channelId: "CH-3", authorId: "U-4", ts: iso(-180), type: "handover",
      text: "Shift handover: Feeder motor A1 drew 112% of rated current for 12s. No trip. Watch next shift." },
    { id: "M-5", channelId: "CH-3", authorId: "U-3", ts: iso(-10), type: "alarm",
      text: "High-temp alarm on Cell-3 heat exchanger. MQTT topic: line/a1/alarm/high-temp. Incident opened." },
    { id: "M-6", channelId: "CH-5", authorId: "U-6", ts: iso(-240), type: "decision",
      text: "Decision: standardize on OPC UA for PLC-to-historian. Rev B of integration spec to be issued IFC." },
  ];

  const documents = [
    {
      id: "DOC-1",
      teamSpaceId: "TS-1",
      projectId: "PRJ-1",
      name: "D-101 Line A Control Narrative",
      kind: "narrative",
      discipline: "Controls",
      currentRevisionId: "REV-1-B",
      revisionIds: ["REV-1-A","REV-1-B"],
      sensitivity: "internal",
    },
    {
      id: "DOC-2",
      teamSpaceId: "TS-3",
      projectId: "PRJ-2",
      name: "P&ID Package 3 — Utilities",
      kind: "pid",
      discipline: "Process",
      currentRevisionId: "REV-2-C",
      revisionIds: ["REV-2-A","REV-2-B","REV-2-C"],
      sensitivity: "controlled",
    },
    {
      id: "DOC-3",
      teamSpaceId: "TS-2",
      name: "Boiler Startup SOP",
      kind: "sop",
      discipline: "Operations",
      currentRevisionId: "REV-3-A",
      revisionIds: ["REV-3-A"],
      sensitivity: "internal",
    },
  ];

  const revisions = [
    { id: "REV-1-A", docId: "DOC-1", label: "A", status: "Superseded", authorId: "U-1", createdAt: iso(-60*24*30),
      summary: "Initial release; valve tag schema draft.", notes: "Draft narrative. No approval." },
    { id: "REV-1-B", docId: "DOC-1", label: "B", status: "IFR", authorId: "U-1", createdAt: iso(-60*24*2),
      summary: "Added I/O list; re-keyed V-110/111/112.", notes: "Issued for review. Reviewer assigned: RO." },
    { id: "REV-2-A", docId: "DOC-2", label: "A", status: "Superseded", authorId: "U-6", createdAt: iso(-60*24*90),
      summary: "Initial IFR package." },
    { id: "REV-2-B", docId: "DOC-2", label: "B", status: "Superseded", authorId: "U-6", createdAt: iso(-60*24*30),
      summary: "Added emergency vent interlock." },
    { id: "REV-2-C", docId: "DOC-2", label: "C", status: "Approved", authorId: "U-6", createdAt: iso(-60*24*3),
      summary: "Approved for IFC. Utility crossover line added; valve sizing updated." },
    { id: "REV-3-A", docId: "DOC-3", label: "A", status: "Approved", authorId: "U-4", createdAt: iso(-60*24*20),
      summary: "Baseline SOP." },
  ];

  const drawings = [
    {
      id: "DRW-1",
      docId: "DOC-2",
      teamSpaceId: "TS-3",
      projectId: "PRJ-2",
      name: "P&ID-7014 Utility Header",
      sheets: [
        { id: "SH-1", label: "Sheet 1 — Steam Header" },
        { id: "SH-2", label: "Sheet 2 — Condensate Return" },
      ],
      discipline: "Process",
    },
    {
      id: "DRW-2",
      docId: "DOC-1",
      teamSpaceId: "TS-1",
      projectId: "PRJ-1",
      name: "Line A Control Panel Layout",
      sheets: [{ id: "SH-10", label: "Panel A-01" }, { id: "SH-11", label: "Wiring — A01-W" }],
      discipline: "Electrical",
    },
  ];

  const markups = [
    { id: "MK-1", drawingId: "DRW-1", sheetId: "SH-1", author: "U-2", x: 0.32, y: 0.40, text: "Confirm vent valve size — PSV-14." },
    { id: "MK-2", drawingId: "DRW-1", sheetId: "SH-1", author: "U-1", x: 0.68, y: 0.72, text: "Relocate PT-102 upstream of reducer." },
    { id: "MK-3", drawingId: "DRW-2", sheetId: "SH-10", author: "U-2", x: 0.5,  y: 0.3,  text: "Missing terminal strip at TB-3." },
  ];

  const assets = [
    { id: "AS-1", name: "Line A / Cell-3 / HX-01", type: "heat_exchanger", hierarchy: "North Plant > Line A > Cell-3 > HX-01", status: "alarm", mqttTopics: ["line/a1/hx01/temp","line/a1/alarm/high-temp"], opcuaNodes: ["ns=2;s=HX01.Temp"], docIds: ["DOC-3"] },
    { id: "AS-2", name: "Line A / Cell-1 / Feeder A1", type: "motor",      hierarchy: "North Plant > Line A > Cell-1 > Feeder A1", status: "warning", mqttTopics: ["line/a1/feeder/current"], opcuaNodes: ["ns=2;s=Feeder.A1.Current"], docIds: ["DOC-1"] },
    { id: "AS-3", name: "Site 2 / Package 3 / Utility Header", type: "piping", hierarchy: "Site 2 > Package 3 > Utility Header", status: "normal", mqttTopics: [], opcuaNodes: [], docIds: ["DOC-2"] },
    { id: "AS-4", name: "Site 1 / Boiler B-201", type: "boiler", hierarchy: "Site 1 > Utilities > Boiler B-201", status: "normal", mqttTopics: ["site1/utilities/boiler/steam"], opcuaNodes: ["ns=2;s=B201.Steam.P"], docIds: ["DOC-3"] },
    // Spec §6.4 second hierarchy template: Site > Building > Floor > Room.
    { id: "AS-5", name: "HQ / Building B / L3 / Server Room",   type: "facility_room",  hierarchy: "HQ > Building B > L3 > Server Room",   status: "normal",  mqttTopics: ["hq/b/3/server/temp"], opcuaNodes: [], docIds: [] },
    { id: "AS-6", name: "HQ / Building B / L3 / Test Lab 3-12", type: "lab",            hierarchy: "HQ > Building B > L3 > Test Lab 3-12", status: "normal",  mqttTopics: ["hq/b/3/lab12/temp","hq/b/3/lab12/humidity"], opcuaNodes: [], docIds: [] },
  ];

  const workItems = [
    { id: "WI-101", projectId: "PRJ-1", type: "Task",   title: "Verify terminal wiring A01-W", assigneeId: "U-1", status: "In Progress", severity: "medium", due: iso(60*24*3), blockers: [] },
    { id: "WI-102", projectId: "PRJ-1", type: "Issue",  title: "Missing terminal strip at TB-3",assigneeId: "U-2", status: "In Review",   severity: "high",   due: iso(60*24*2), blockers: [] },
    { id: "WI-103", projectId: "PRJ-1", type: "RFI",    title: "Confirm valve tag schema",      assigneeId: "U-2", status: "Open",        severity: "low",    due: iso(60*24*5), blockers: [] },
    { id: "WI-104", projectId: "PRJ-2", type: "Change", title: "Add emergency vent interlock",  assigneeId: "U-6", status: "Approved",    severity: "high",   due: iso(60*24*10), blockers: [] },
    { id: "WI-105", projectId: "PRJ-2", type: "Punch",  title: "Tag PSV-14 mismatch",           assigneeId: "U-2", status: "Open",        severity: "medium", due: iso(60*24*7), blockers: [] },
    { id: "WI-106", projectId: "PRJ-3", type: "CAPA",   title: "Root-cause Boiler-B201 trip",   assigneeId: "U-3", status: "In Progress", severity: "high",   due: iso(60*24*5), blockers: ["WI-104"] },
    { id: "WI-107", projectId: "PRJ-1", type: "Task",   title: "HMI refresh rate tuning",       assigneeId: "U-1", status: "Backlog",     severity: "low",    due: iso(60*24*14), blockers: [] },
    { id: "WI-108", projectId: "PRJ-1", type: "Defect", title: "Scan cycle >500ms on PLC-A2",   assigneeId: "U-1", status: "Done",        severity: "medium", due: iso(-60*24*2), blockers: [] },
  ];

  const incidents = [
    {
      id: "INC-4412",
      title: "High-temp alarm on HX-01",
      severity: "SEV-2",
      status: "active",
      assetId: "AS-1",
      commanderId: "U-4",
      channelId: "CH-4",
      startedAt: iso(-40),
      timeline: [
        { ts: iso(-40), actor: "MQTT", text: "line/a1/alarm/high-temp triggered at 112°C." },
        { ts: iso(-38), actor: "System", text: "Incident auto-created; war room opened." },
        { ts: iso(-30), actor: "U-4", text: "Commander assigned. Paging Reliability on-call." },
        { ts: iso(-25), actor: "U-3", text: "Reduced feed rate to 60%. Monitoring." },
      ],
    },
  ];

  const approvals = [
    { id: "APR-1", subject: { kind: "Revision", id: "REV-1-B" }, requester: "U-1", approvers: ["U-2"], status: "pending", dueTs: iso(60*24), reasonIfDone: null },
    { id: "APR-2", subject: { kind: "Revision", id: "REV-2-C" }, requester: "U-6", approvers: ["U-4"], status: "approved", dueTs: iso(-60), reasonIfDone: "Approved — matches scope" },
    { id: "APR-3", subject: { kind: "WorkItem", id: "WI-104" }, requester: "U-6", approvers: ["U-4"], status: "approved", dueTs: iso(-60*24), reasonIfDone: "OK" },
  ];

  const forms = [
    { id: "FRM-1", name: "Commissioning Checklist — Line A", linkedProjectId: "PRJ-1", items: 12, completed: 7 },
    { id: "FRM-2", name: "Pre-start SOP — Boiler B-201",     linkedAssetId: "AS-4",    items: 9,  completed: 9 },
  ];

  const integrations = [
    { id: "INT-MQTT", name: "MQTT Broker (EMQX-compatible)", kind: "mqtt",  status: "connected",  lastEvent: iso(-2), eventsPerMin: 148 },
    { id: "INT-OPCUA",name: "OPC UA — Site 1",               kind: "opcua", status: "degraded",   lastEvent: iso(-15),eventsPerMin: 12  },
    { id: "INT-ERP",  name: "ERP — SAP S/4",                 kind: "erp",   status: "connected",  lastEvent: iso(-30),eventsPerMin: 2   },
    { id: "INT-WEBH", name: "Webhook — Vendor A",            kind: "rest",  status: "failed",     lastEvent: iso(-180),eventsPerMin: 0  },
  ];

  const dataSources = [
    { id: "DS-1", integrationId: "INT-MQTT", endpoint: "line/a1/#",                 assetId: "AS-1", kind: "topic" },
    { id: "DS-2", integrationId: "INT-MQTT", endpoint: "line/a1/feeder/current",    assetId: "AS-2", kind: "topic" },
    { id: "DS-3", integrationId: "INT-OPCUA", endpoint: "ns=2;s=HX01.Temp",         assetId: "AS-1", kind: "node"  },
    { id: "DS-4", integrationId: "INT-ERP",   endpoint: "PurchaseOrder",            assetId: null,   kind: "entity"},
  ];

  const dashboards = [
    { id: "DASH-1", name: "Line A Overview", widgets: ["feeder_current", "hx_temp", "alarms_24h"] },
    { id: "DASH-2", name: "Utility Health",  widgets: ["boiler_steam_p", "header_flow", "deadletters"] },
  ];

  const aiAgents = [
    { id: "AI-1", name: "Engineering Brief", scope: "workspace", policy: "no-egress" },
    { id: "AI-2", name: "Revision Delta Explainer", scope: "doc",     policy: "citation-required" },
  ];

  const auditEvents = [
    { id: "AUD-seed-1", ts: iso(-60*24), actor: "U-6", action: "approve",  subject: "REV-2-C", detail: { outcome: "approved" } },
    { id: "AUD-seed-2", ts: iso(-60*12), actor: "U-1", action: "upload",   subject: "REV-1-B", detail: { filename: "D-101.pdf" } },
    { id: "AUD-seed-3", ts: iso(-60),    actor: "U-3", action: "acknowledge", subject: "INC-4412", detail: { action: "feed_rate_reduced" } },
  ];

  const notifications = [
    { id: "N-1", ts: iso(-60), kind: "mention",  text: "@JS mentioned you in #line-a-controls",   route: "/channel/CH-1" },
    { id: "N-2", ts: iso(-20), kind: "approval", text: "Approval requested for REV-1-B",           route: "/approvals" },
    { id: "N-3", ts: iso(-10), kind: "incident", text: "Incident SEV-2 opened: INC-4412",           route: "/incident/INC-4412" },
    { id: "N-4", ts: iso(-5),  kind: "integration", text: "Webhook Vendor A failed 3x", route: "/integrations" },
  ];

  return {
    organization,
    workspace,
    workspaces,
    users,
    teamSpaces,
    projects,
    channels,
    threads,
    messages,
    documents,
    revisions,
    drawings,
    markups,
    assets,
    workItems,
    incidents,
    approvals,
    forms,
    integrations,
    dataSources,
    dashboards,
    aiAgents,
    auditEvents,
    notifications,
  };
}
