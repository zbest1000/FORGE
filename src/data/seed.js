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

  const locations = [
    { id: "LOC-ORG", orgId: "ORG-1", name: "Atlas Global", kind: "enterprise", parentId: null, path: "Atlas Industrial Systems" },
    { id: "SITE-NP", orgId: "ORG-1", workspaceId: "WS-1", name: "North Plant", kind: "site", parentId: "LOC-ORG", path: "Atlas Industrial Systems > North Plant" },
    { id: "AREA-LA", orgId: "ORG-1", workspaceId: "WS-1", name: "Line A", kind: "production_line", parentId: "SITE-NP", path: "Atlas Industrial Systems > North Plant > Line A" },
    { id: "CELL-A1", orgId: "ORG-1", workspaceId: "WS-1", name: "Cell 1", kind: "cell", parentId: "AREA-LA", path: "Atlas Industrial Systems > North Plant > Line A > Cell 1" },
    { id: "CELL-A3", orgId: "ORG-1", workspaceId: "WS-1", name: "Cell 3", kind: "cell", parentId: "AREA-LA", path: "Atlas Industrial Systems > North Plant > Line A > Cell 3" },
    { id: "SITE-S1", orgId: "ORG-1", workspaceId: "WS-1", name: "Site 1 Utilities", kind: "site", parentId: "LOC-ORG", path: "Atlas Industrial Systems > Site 1 Utilities" },
    { id: "SITE-S2", orgId: "ORG-1", workspaceId: "WS-2", name: "Site 2", kind: "site", parentId: "LOC-ORG", path: "Atlas Industrial Systems > Site 2" },
    { id: "PKG-S2-P3", orgId: "ORG-1", workspaceId: "WS-2", name: "Package 3", kind: "project_area", parentId: "SITE-S2", path: "Atlas Industrial Systems > Site 2 > Package 3" },
    { id: "HQ-B3", orgId: "ORG-1", workspaceId: "WS-3", name: "HQ Building B / Level 3", kind: "facility_floor", parentId: "LOC-ORG", path: "Atlas Industrial Systems > HQ > Building B > Level 3" },
  ];

  const users = [
    { id: "U-1", name: "J. Singh",      role: "Engineer/Contributor",  initials: "JS", groupIds: ["G-eng","G-scada"] },
    { id: "U-2", name: "R. Okafor",     role: "Reviewer/Approver",     initials: "RO", groupIds: ["G-eng"] },
    { id: "U-3", name: "M. Torres",     role: "Operator/Technician",   initials: "MT", groupIds: ["G-ops"] },
    { id: "U-4", name: "D. Chen",       role: "Workspace Admin",       initials: "DC", groupIds: ["G-it","G-business","G-mgmt"] },
    { id: "U-5", name: "L. Abidemi",    role: "Integration Admin",     initials: "LA", groupIds: ["G-it","G-automation","G-erp"] },
    { id: "U-6", name: "A. Patel",      role: "Team Space Admin",      initials: "AP", groupIds: ["G-eng","G-mgmt"] },
  ];

  // Groups (with optional parents — sub-groups inherit access). Spec: groups
  // within groups, used for asset assignment & portal/item visibility.
  const groups = [
    { id: "G-it",          name: "IT & Platform Admins",   description: "Server status, MQTT broker, secrets",       parentId: null,           memberIds: ["U-4","U-5"] },
    { id: "G-engineering", name: "Engineering",            description: "All engineering disciplines (parent group)", parentId: null,           memberIds: ["U-4"] },
    { id: "G-eng",         name: "Process Engineering",    description: "Process / controls engineers",              parentId: "G-engineering", memberIds: ["U-1","U-2","U-6"] },
    { id: "G-automation",  name: "Industrial Automation",  description: "i3X, UNS, OPC UA, MQTT consumers",          parentId: "G-engineering", memberIds: ["U-5"] },
    { id: "G-scada",       name: "SCADA Engineers",        description: "PLC/SCADA/HMI",                              parentId: "G-automation",  memberIds: ["U-1"] },
    { id: "G-erp",         name: "ERP Engineers",          description: "ERP integrations & masters",                 parentId: "G-it",          memberIds: ["U-5"] },
    { id: "G-ops",         name: "Plant Operations",       description: "Operators & technicians",                    parentId: null,           memberIds: ["U-3"] },
    { id: "G-mgmt",        name: "Management",             description: "PMs, leads, executives",                     parentId: null,           memberIds: ["U-4","U-6"] },
    { id: "G-business",    name: "Business / ERP",         description: "Procurement, finance, ERP power users",      parentId: null,           memberIds: ["U-4"] },
  ];

  // Demo "current user" — used when no real auth user is present (demo mode).
  // Defaults to the workspace admin so the operator sees most portals; the
  // header user-switcher (in admin/groups panel) lets you flip identities.
  const currentUserId = "U-4";

  const teamSpaces = [
    { id: "TS-1", name: "Controls Engineering", summary: "PLC/HMI/SCADA work for Line A and B", memberIds: ["U-1","U-2","U-3","U-4"] },
    { id: "TS-2", name: "Reliability & Ops",    summary: "Maintenance, incidents, shift handover", memberIds: ["U-3","U-4","U-6"] },
    { id: "TS-3", name: "EPCM Project Delta",   summary: "Capital project — Site 2 expansion",    memberIds: ["U-2","U-4","U-6"] },
  ];

  const projects = [
    { id: "PRJ-1", teamSpaceId: "TS-1", siteId: "SITE-NP", locationId: "AREA-LA", assetIds: ["AS-1","AS-2"], name: "Line A Controls Upgrade", status: "active", dueDate: iso(60*24*14), milestones: ["FAT", "SAT", "Commissioning"] },
    { id: "PRJ-2", teamSpaceId: "TS-3", siteId: "SITE-S2", locationId: "PKG-S2-P3", assetIds: ["AS-3"], name: "Site 2 Expansion — Package 3", status: "active", dueDate: iso(60*24*60), milestones: ["IFR", "IFC", "Handover"] },
    { id: "PRJ-3", teamSpaceId: "TS-2", siteId: "SITE-S1", locationId: "SITE-S1", assetIds: ["AS-4"], name: "Boiler Reliability Initiative", status: "planning", dueDate: iso(60*24*30), milestones: ["Baseline", "PM plan", "Reliability review"] },
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
      scope: "project",
      siteId: "SITE-NP",
      assetIds: ["AS-2"],
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
      scope: "project",
      siteId: "SITE-S2",
      assetIds: ["AS-3"],
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
      scope: "asset",
      siteId: "SITE-S1",
      assetIds: ["AS-1","AS-4"],
    },
    {
      id: "DOC-4",
      teamSpaceId: "TS-2",
      name: "Global Lockout / Tagout Standard",
      kind: "standard",
      discipline: "Safety",
      currentRevisionId: "REV-4-A",
      revisionIds: ["REV-4-A"],
      sensitivity: "controlled",
      scope: "enterprise",
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
    { id: "REV-4-A", docId: "DOC-4", label: "A", status: "IFC", authorId: "U-4", createdAt: iso(-60*24*120),
      summary: "Enterprise-wide LOTO standard for service and commissioning." },
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
    { id: "AS-1", siteId: "SITE-NP", locationId: "CELL-A3", projectIds: ["PRJ-1"], name: "Line A / Cell-3 / HX-01", type: "heat_exchanger", hierarchy: "North Plant > Line A > Cell-3 > HX-01", status: "alarm", opsStatus: "alarm", maintenanceStatus: "watch", daqStatus: "live", mqttTopics: ["line/a1/hx01/temp","line/a1/alarm/high-temp"], opcuaNodes: ["ns=2;s=HX01.Temp"], docIds: ["DOC-3","DOC-4"], assignedUserId: null, assignedGroupId: "G-engineering" },
    { id: "AS-2", siteId: "SITE-NP", locationId: "CELL-A1", projectIds: ["PRJ-1"], name: "Line A / Cell-1 / Feeder A1", type: "motor", hierarchy: "North Plant > Line A > Cell-1 > Feeder A1", status: "warning", opsStatus: "degraded", maintenanceStatus: "planned", daqStatus: "live", mqttTopics: ["line/a1/feeder/current"], opcuaNodes: ["ns=2;s=Feeder.A1.Current"], docIds: ["DOC-1","DOC-4"], assignedUserId: null, assignedGroupId: "G-engineering" },
    { id: "AS-3", siteId: "SITE-S2", locationId: "PKG-S2-P3", projectIds: ["PRJ-2"], name: "Site 2 / Package 3 / Utility Header", type: "piping", hierarchy: "Site 2 > Package 3 > Utility Header", status: "normal", opsStatus: "normal", maintenanceStatus: "none", daqStatus: "not_connected", mqttTopics: [], opcuaNodes: [], docIds: ["DOC-2","DOC-4"], assignedUserId: "U-6", assignedGroupId: "G-eng" },
    { id: "AS-4", siteId: "SITE-S1", locationId: "SITE-S1", projectIds: ["PRJ-3"], name: "Site 1 / Boiler B-201", type: "boiler", hierarchy: "Site 1 > Utilities > Boiler B-201", status: "normal", opsStatus: "normal", maintenanceStatus: "due", daqStatus: "stale", mqttTopics: ["site1/utilities/boiler/steam"], opcuaNodes: ["ns=2;s=B201.Steam.P"], docIds: ["DOC-3","DOC-4"], assignedUserId: null, assignedGroupId: "G-ops" },
    // Spec §6.4 second hierarchy template: Site > Building > Floor > Room.
    { id: "AS-5", siteId: "HQ-B3", locationId: "HQ-B3", projectIds: [], name: "HQ / Building B / L3 / Server Room", type: "facility_room", hierarchy: "HQ > Building B > L3 > Server Room", status: "normal", opsStatus: "normal", maintenanceStatus: "none", daqStatus: "live", mqttTopics: ["hq/b/3/server/temp"], opcuaNodes: [], docIds: ["DOC-4"], assignedUserId: null, assignedGroupId: "G-it" },
    { id: "AS-6", siteId: "HQ-B3", locationId: "HQ-B3", projectIds: [], name: "HQ / Building B / L3 / Test Lab 3-12", type: "lab", hierarchy: "HQ > Building B > L3 > Test Lab 3-12", status: "normal", opsStatus: "normal", maintenanceStatus: "planned", daqStatus: "live", mqttTopics: ["hq/b/3/lab12/temp","hq/b/3/lab12/humidity"], opcuaNodes: [], docIds: ["DOC-4"], assignedUserId: null, assignedGroupId: "G-erp" },
  ];

  const workItems = [
    { id: "WI-101", projectId: "PRJ-1", assetIds: ["AS-2"], type: "Task", title: "Verify terminal wiring A01-W", assigneeId: "U-1", assignedAt: iso(-60*24*5), status: "In Progress", severity: "medium", due: iso(60*24*3), blockers: [] },
    { id: "WI-102", projectId: "PRJ-1", assetIds: ["AS-2"], type: "Issue", title: "Missing terminal strip at TB-3", assigneeId: "U-2", assignedAt: iso(-60*24*4), status: "In Review", severity: "high", due: iso(60*24*2), blockers: [] },
    { id: "WI-103", projectId: "PRJ-1", assetIds: ["AS-1","AS-2"], type: "RFI", title: "Confirm valve tag schema", assigneeId: "U-2", assignedAt: iso(-60*24*3), status: "Open", severity: "low", due: iso(60*24*5), blockers: [] },
    { id: "WI-104", projectId: "PRJ-2", assetIds: ["AS-3"], type: "Change", title: "Add emergency vent interlock", assigneeId: "U-6", assignedAt: iso(-60*24*8), status: "Approved", severity: "high", due: iso(60*24*10), blockers: [] },
    { id: "WI-105", projectId: "PRJ-2", assetIds: ["AS-3"], type: "Punch", title: "Tag PSV-14 mismatch", assigneeId: "U-2", assignedAt: iso(-60*24*2), status: "Open", severity: "medium", due: iso(60*24*7), blockers: [] },
    { id: "WI-106", projectId: "PRJ-3", assetIds: ["AS-4"], type: "CAPA", title: "Root-cause Boiler-B201 trip", assigneeId: "U-3", assignedAt: iso(-60*24*6), status: "In Progress", severity: "high", due: iso(60*24*5), blockers: ["WI-104"] },
    { id: "WI-107", projectId: "PRJ-1", assetIds: ["AS-1","AS-2"], type: "Task", title: "HMI refresh rate tuning", assigneeId: "U-1", assignedAt: iso(-60*24*1), status: "Backlog", severity: "low", due: iso(60*24*14), blockers: [] },
    { id: "WI-108", projectId: "PRJ-1", assetIds: ["AS-2"], type: "Defect", title: "Scan cycle >500ms on PLC-A2", assigneeId: "U-1", assignedAt: iso(-60*24*10), status: "Done", severity: "medium", due: iso(-60*24*2), blockers: [] },
  ];

  const maintenanceItems = [
    { id: "MX-1001", externalId: "WO-44281", source: "MaintainX", sourceUrl: "https://maintainx.example/work-orders/WO-44281", syncStatus: "synced", assetId: "AS-2", projectId: "PRJ-1", type: "PM", title: "Inspect Feeder A1 bearings before SAT", status: "scheduled", priority: "medium", due: iso(60*24*4), ownerId: "U-3" },
    { id: "MX-1002", externalId: "WO-44293", source: "MaintainX", sourceUrl: "https://maintainx.example/work-orders/WO-44293", syncStatus: "needs review", assetId: "AS-1", projectId: "PRJ-1", type: "Corrective", title: "Investigate HX-01 high-temp alarm trend", status: "open", priority: "high", due: iso(60*18), ownerId: "U-3" },
    { id: "MX-1003", externalId: "PM-70014", source: "SAP PM", sourceUrl: "https://sap.example/pm/PM-70014", syncStatus: "synced", assetId: "AS-4", projectId: "PRJ-3", type: "Inspection", title: "Boiler B-201 annual burner inspection", status: "due", priority: "high", due: iso(60*24*5), ownerId: "U-3" },
    { id: "MX-1004", externalId: "UP-1902", source: "UpKeep", sourceUrl: "https://upkeep.example/work-orders/UP-1902", syncStatus: "synced", assetId: "AS-6", projectId: null, type: "Calibration", title: "Lab humidity sensor calibration", status: "scheduled", priority: "low", due: iso(60*24*20), ownerId: "U-5" },
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
    { id: "INT-MODBUS", name: "Modbus TCP — Line A PLC",      kind: "modbus",status: "connected",  lastEvent: iso(-1), eventsPerMin: 60  },
    { id: "INT-ERP",  name: "ERP — SAP S/4",                 kind: "erp",   status: "connected",  lastEvent: iso(-30),eventsPerMin: 2   },
    { id: "INT-WEBH", name: "Webhook — Vendor A",            kind: "rest",  status: "failed",     lastEvent: iso(-180),eventsPerMin: 0  },
  ];

  const dataSources = [
    { id: "DS-1", integrationId: "INT-MQTT", endpoint: "line/a1/#", assetId: "AS-1", projectId: "PRJ-1", kind: "topic", status: "live", quality: "Good", lastValue: "112.3 degC", lastSeen: iso(-2) },
    { id: "DS-2", integrationId: "INT-MQTT", endpoint: "line/a1/feeder/current", assetId: "AS-2", projectId: "PRJ-1", kind: "topic", status: "live", quality: "Good", lastValue: "112% FLA", lastSeen: iso(-5) },
    { id: "DS-3", integrationId: "INT-OPCUA", endpoint: "ns=2;s=HX01.Temp", assetId: "AS-1", projectId: "PRJ-1", kind: "node", status: "live", quality: "Uncertain", lastValue: "111.8 degC", lastSeen: iso(-4) },
    { id: "DS-6", integrationId: "INT-MODBUS", endpoint: "10.20.4.12:502/unit/1/hr/40001", assetId: "AS-2", projectId: "PRJ-1", kind: "modbus_register", status: "live", quality: "Good", lastValue: "46.2 A", lastSeen: iso(-1) },
    { id: "DS-4", integrationId: "INT-ERP", endpoint: "PurchaseOrder", assetId: null, projectId: "PRJ-2", kind: "entity", status: "connected", quality: "Good", lastValue: "3 open POs", lastSeen: iso(-30)},
    { id: "DS-5", integrationId: "INT-OPCUA", endpoint: "ns=2;s=B201.Steam.P", assetId: "AS-4", projectId: "PRJ-3", kind: "node", status: "stale", quality: "GoodNoData", lastValue: "10.8 bar", lastSeen: iso(-180) },
  ];

  const historianPoints = [
    { id: "HP-HX01-TEMP", assetId: "AS-1", sourceId: "DS-3", tag: "NP.LINEA.CELL3.HX01.TEMP", name: "HX-01 outlet temperature", unit: "degC", dataType: "number", historian: "sqlite" },
    { id: "HP-FDR-A1-CURRENT", assetId: "AS-2", sourceId: "DS-6", tag: "NP.LINEA.CELL1.FEEDER_A1.CURRENT", name: "Feeder A1 phase current", unit: "A", dataType: "number", historian: "sqlite" },
    { id: "HP-B201-STEAM-P", assetId: "AS-4", sourceId: "DS-5", tag: "S1.UTIL.B201.STEAM_PRESSURE", name: "Boiler B-201 steam pressure", unit: "bar", dataType: "number", historian: "sqlite" },
  ];

  const historianSamples = historianPoints.flatMap((point, pointIndex) =>
    Array.from({ length: 12 }, (_, i) => {
      const baseline = point.unit === "degC" ? 106 : point.unit === "A" ? 42 : 10.6;
      return {
        id: `HS-SEED-${pointIndex + 1}-${i + 1}`,
        pointId: point.id,
        ts: iso(-60 + i * 5),
        value: Number((baseline + Math.sin(i / 2) * (point.unit === "A" ? 5 : 1.4) + pointIndex).toFixed(2)),
        quality: i === 2 && point.unit === "bar" ? "Uncertain" : "Good",
        sourceType: point.sourceId === "DS-6" ? "modbus_tcp" : point.sourceId === "DS-3" ? "opcua" : "mqtt",
        rawPayload: { seed: true },
      };
    })
  );

  const recipes = [
    { id: "RCP-LINEA-RAMP", assetId: "AS-2", name: "Line A feeder ramp-up", status: "active", currentVersionId: "RCV-LINEA-RAMP-2", createdBy: "U-1", createdAt: iso(-60 * 24 * 20), updatedAt: iso(-60 * 24 * 2) },
    { id: "RCP-HX01-CIP", assetId: "AS-1", name: "HX-01 clean-in-place", status: "draft", currentVersionId: "RCV-HX01-CIP-1", createdBy: "U-3", createdAt: iso(-60 * 24 * 7), updatedAt: iso(-60 * 24 * 7) },
  ];

  const recipeVersions = [
    { id: "RCV-LINEA-RAMP-1", recipeId: "RCP-LINEA-RAMP", version: 1, state: "superseded", parameters: { rampRateHzPerSec: 1.2, currentLimitA: 48, holdSeconds: 30 }, notes: "Initial FAT recipe.", approvedBy: "U-2", approvedAt: iso(-60 * 24 * 12), createdBy: "U-1", createdAt: iso(-60 * 24 * 20) },
    { id: "RCV-LINEA-RAMP-2", recipeId: "RCP-LINEA-RAMP", version: 2, state: "active", parameters: { rampRateHzPerSec: 0.9, currentLimitA: 45, holdSeconds: 45 }, notes: "Reduced ramp after feeder current trend.", approvedBy: "U-2", approvedAt: iso(-60 * 24 * 2), createdBy: "U-1", createdAt: iso(-60 * 24 * 3) },
    { id: "RCV-HX01-CIP-1", recipeId: "RCP-HX01-CIP", version: 1, state: "draft", parameters: { rinseMinutes: 12, causticPercent: 2.1, maxTempDegC: 78 }, notes: "Pending reliability review.", approvedBy: null, approvedAt: null, createdBy: "U-3", createdAt: iso(-60 * 24 * 7) },
  ];

  const modbusDevices = [
    { id: "MBD-LINEA-PLC1", integrationId: "INT-MODBUS", name: "PLC-A1 Modbus gateway", host: "10.20.4.12", port: 502, unitId: 1, status: "connected", lastPollAt: iso(-1), config: { timeoutMs: 1500, byteOrder: "ABCD" } },
  ];

  const modbusRegisters = [
    { id: "MBR-FDR-A1-CURRENT", deviceId: "MBD-LINEA-PLC1", assetId: "AS-2", pointId: "HP-FDR-A1-CURRENT", name: "Feeder A1 current", address: 40001, functionCode: 3, dataType: "float32", scale: 0.1, unit: "A", pollingMs: 1000, lastValue: 46.2, lastQuality: "Good", lastSeen: iso(-1) },
    { id: "MBR-FDR-A1-RUN", deviceId: "MBD-LINEA-PLC1", assetId: "AS-2", pointId: null, name: "Feeder A1 running", address: 1, functionCode: 1, dataType: "bool", scale: 1, unit: null, pollingMs: 1000, lastValue: 1, lastQuality: "Good", lastSeen: iso(-1) },
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

  // -------------------------------------------------------------------
  // Asset Profiles (demo mode).
  //
  // Spec ref: docs/INDUSTRIAL_EDGE_PLATFORM_SPEC.md §4.3 — an "asset
  // class" defines the expected schema (data points + units) for a
  // family of assets (Centrifugal Pump, Heat Exchanger, ...). FORGE's
  // `asset_profile` is the implementation of that concept, plus a
  // source-kind binding (mqtt/opcua/sql) and a path template that
  // resolves to the per-asset address space.
  //
  // The shape mirrors the server tables exactly so the Profiles admin
  // and dashboard demo paths can render the same nodes the API would
  // return when connected to a server.
  // -------------------------------------------------------------------
  const assetProfiles = [
    {
      id: "PROF-PUMP-DEMO",
      orgId: "ORG-1",
      workspaceId: null, // library-scoped
      name: "Centrifugal Pump",
      description: "Standard rotating-equipment profile: temperature, pressure, vibration, motor current.",
      sourceKind: "mqtt",
      latestVersionId: "PVER-PUMP-V2",
      status: "active",
      ownerId: "U-4",
      createdAt: iso(-60 * 24 * 30),
      updatedAt: iso(-60 * 24 * 5),
    },
    {
      id: "PROF-HEX-DEMO",
      orgId: "ORG-1",
      workspaceId: "WS-1",
      name: "Shell-and-Tube Heat Exchanger",
      description: "Inlet/outlet temperatures, tube-side and shell-side pressure drop.",
      sourceKind: "opcua",
      latestVersionId: "PVER-HEX-V1",
      status: "active",
      ownerId: "U-1",
      createdAt: iso(-60 * 24 * 14),
      updatedAt: iso(-60 * 24 * 14),
    },
    {
      id: "PROF-BOILER-DEMO",
      orgId: "ORG-1",
      workspaceId: "WS-1",
      name: "Industrial Boiler",
      description: "Steam pressure, feedwater flow, stack temperature, fuel-gas pressure (MSSQL historian).",
      sourceKind: "sql",
      latestVersionId: "PVER-BOILER-V1",
      status: "draft",
      ownerId: "U-3",
      createdAt: iso(-60 * 24 * 7),
      updatedAt: iso(-60 * 24 * 7),
    },
  ];

  const assetProfileVersions = [
    { id: "PVER-PUMP-V1",   profileId: "PROF-PUMP-DEMO", version: 1, sourceTemplate: { topic_template: "forge/{enterprise}/{site}/{asset}/{point}", qos: 1 }, status: "active",  notes: "initial",            createdBy: "U-4", createdAt: iso(-60 * 24 * 30) },
    { id: "PVER-PUMP-V2",   profileId: "PROF-PUMP-DEMO", version: 2, sourceTemplate: { topic_template: "forge/{enterprise}/{site}/{asset}/{point}", qos: 1 }, status: "active",  notes: "added vibration",    createdBy: "U-4", createdAt: iso(-60 * 24 * 5)  },
    { id: "PVER-HEX-V1",    profileId: "PROF-HEX-DEMO",  version: 1, sourceTemplate: { node_template: "ns=2;s={enterprise}.{site}.{asset}.{point}" },         status: "active",  notes: "initial",            createdBy: "U-1", createdAt: iso(-60 * 24 * 14) },
    { id: "PVER-BOILER-V1", profileId: "PROF-BOILER-DEMO", version: 1, sourceTemplate: { table: "boiler_samples", ts_column: "ts", value_column: "value", point_column: "tag", asset_filter_column: "asset_path", poll_interval_ms: 5000 }, status: "draft", notes: "initial", createdBy: "U-3", createdAt: iso(-60 * 24 * 7) },
  ];

  const assetProfilePoints = [
    // Pump v1
    { id: "PPT-PUMP-V1-1", profileVersionId: "PVER-PUMP-V1", name: "temperature",   unit: "C",   dataType: "number", sourcePathTemplate: "{enterprise}/{site}/{asset}/temperature",   order: 0 },
    { id: "PPT-PUMP-V1-2", profileVersionId: "PVER-PUMP-V1", name: "pressure",      unit: "bar", dataType: "number", sourcePathTemplate: "{enterprise}/{site}/{asset}/pressure",      order: 1 },
    { id: "PPT-PUMP-V1-3", profileVersionId: "PVER-PUMP-V1", name: "motor_current", unit: "A",   dataType: "number", sourcePathTemplate: "{enterprise}/{site}/{asset}/motor_current", order: 2 },
    // Pump v2 — adds vibration
    { id: "PPT-PUMP-V2-1", profileVersionId: "PVER-PUMP-V2", name: "temperature",   unit: "C",   dataType: "number", sourcePathTemplate: "{enterprise}/{site}/{asset}/temperature",   order: 0 },
    { id: "PPT-PUMP-V2-2", profileVersionId: "PVER-PUMP-V2", name: "pressure",      unit: "bar", dataType: "number", sourcePathTemplate: "{enterprise}/{site}/{asset}/pressure",      order: 1 },
    { id: "PPT-PUMP-V2-3", profileVersionId: "PVER-PUMP-V2", name: "motor_current", unit: "A",   dataType: "number", sourcePathTemplate: "{enterprise}/{site}/{asset}/motor_current", order: 2 },
    { id: "PPT-PUMP-V2-4", profileVersionId: "PVER-PUMP-V2", name: "vibration",     unit: "mm/s",dataType: "number", sourcePathTemplate: "{enterprise}/{site}/{asset}/vibration",     order: 3 },
    // Heat Exchanger v1
    { id: "PPT-HEX-V1-1",  profileVersionId: "PVER-HEX-V1", name: "inlet_temp",     unit: "C",   dataType: "number", sourcePathTemplate: "{enterprise}.{site}.{asset}.inlet_temp",  order: 0 },
    { id: "PPT-HEX-V1-2",  profileVersionId: "PVER-HEX-V1", name: "outlet_temp",    unit: "C",   dataType: "number", sourcePathTemplate: "{enterprise}.{site}.{asset}.outlet_temp", order: 1 },
    { id: "PPT-HEX-V1-3",  profileVersionId: "PVER-HEX-V1", name: "shell_dp",       unit: "kPa", dataType: "number", sourcePathTemplate: "{enterprise}.{site}.{asset}.shell_dp",    order: 2 },
    { id: "PPT-HEX-V1-4",  profileVersionId: "PVER-HEX-V1", name: "tube_dp",        unit: "kPa", dataType: "number", sourcePathTemplate: "{enterprise}.{site}.{asset}.tube_dp",     order: 3 },
    // Boiler v1
    { id: "PPT-BOILER-V1-1", profileVersionId: "PVER-BOILER-V1", name: "steam_pressure",  unit: "bar",  dataType: "number", sourcePathTemplate: "{asset}.steam_pressure",    order: 0 },
    { id: "PPT-BOILER-V1-2", profileVersionId: "PVER-BOILER-V1", name: "feedwater_flow",  unit: "m3/h", dataType: "number", sourcePathTemplate: "{asset}.feedwater_flow",    order: 1 },
    { id: "PPT-BOILER-V1-3", profileVersionId: "PVER-BOILER-V1", name: "stack_temp",      unit: "C",    dataType: "number", sourcePathTemplate: "{asset}.stack_temp",        order: 2 },
    { id: "PPT-BOILER-V1-4", profileVersionId: "PVER-BOILER-V1", name: "fuel_gas_press",  unit: "bar",  dataType: "number", sourcePathTemplate: "{asset}.fuel_gas_press",    order: 3 },
  ];

  // A pair of pre-bound assets so the dashboard immediately shows
  // "profile" badges + the rename-re-resolve flow has affected
  // bindings to demo against. The bindings reference existing assets
  // from the assets[] array above (AS-1, AS-2 are pumps).
  const assetPointBindings = [
    { id: "APB-DEMO-1", orgId: "ORG-1", assetId: "AS-1", profileVersionId: "PVER-PUMP-V2", profilePointId: "PPT-PUMP-V2-1", pointId: null, systemId: null, sourceKind: "mqtt", sourcePath: "Atlas Industrial Systems/North Plant/Feeder A1/temperature",   templateVars: { enterprise: "Atlas Industrial Systems", site: "North Plant", asset: "Feeder A1" }, enabled: 1, createdAt: iso(-60 * 24 * 5), updatedAt: iso(-60 * 24 * 5) },
    { id: "APB-DEMO-2", orgId: "ORG-1", assetId: "AS-1", profileVersionId: "PVER-PUMP-V2", profilePointId: "PPT-PUMP-V2-2", pointId: null, systemId: null, sourceKind: "mqtt", sourcePath: "Atlas Industrial Systems/North Plant/Feeder A1/pressure",      templateVars: { enterprise: "Atlas Industrial Systems", site: "North Plant", asset: "Feeder A1" }, enabled: 1, createdAt: iso(-60 * 24 * 5), updatedAt: iso(-60 * 24 * 5) },
    { id: "APB-DEMO-3", orgId: "ORG-1", assetId: "AS-1", profileVersionId: "PVER-PUMP-V2", profilePointId: "PPT-PUMP-V2-4", pointId: null, systemId: null, sourceKind: "mqtt", sourcePath: "Atlas Industrial Systems/North Plant/Feeder A1/vibration",     templateVars: { enterprise: "Atlas Industrial Systems", site: "North Plant", asset: "Feeder A1" }, enabled: 1, createdAt: iso(-60 * 24 * 5), updatedAt: iso(-60 * 24 * 5) },
  ];

  return {
    organization,
    workspace,
    workspaces,
    locations,
    users,
    groups,
    currentUserId,
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
    maintenanceItems,
    incidents,
    approvals,
    forms,
    integrations,
    dataSources,
    historianPoints,
    historianSamples,
    recipes,
    recipeVersions,
    modbusDevices,
    modbusRegisters,
    dashboards,
    aiAgents,
    auditEvents,
    notifications,
    assetProfiles,
    assetProfileVersions,
    assetProfilePoints,
    assetPointBindings,
  };
}
