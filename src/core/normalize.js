// One-time normalization pass for FORGE entities to include the §4 base fields.
//
// Every object carries:
//   id, org_id, workspace_id, created_by, created_at, updated_at,
//   status, labels[], acl, audit_ref
//
// Missing fields are filled from defaults. `acl` uses a role list and
// optional ABAC attributes.

const COLLECTIONS = [
  "teamSpaces", "projects", "channels", "threads", "messages",
  "documents", "revisions", "drawings", "markups",
  "assets", "workItems", "incidents", "approvals",
  "forms", "files", "integrations", "dataSources",
  "dashboards", "aiAgents",
];

export function normalizeSeed(d) {
  if (!d) return d;
  const orgId = d.organization?.id || "ORG-1";
  const wsId = d.workspace?.id || "WS-1";
  const now = new Date().toISOString();

  const creators = {
    documents: "U-1",
    revisions: "U-1",
    drawings: "U-6",
    markups: "U-2",
    assets: "U-4",
    workItems: "U-1",
    incidents: "U-4",
    approvals: "U-6",
    forms: "U-4",
    messages: "U-1",
    channels: "U-4",
    projects: "U-6",
    teamSpaces: "U-4",
    integrations: "U-5",
    dataSources: "U-5",
    dashboards: "U-4",
    aiAgents: "U-4",
    threads: "U-1",
    files: "U-1",
  };

  // Canonical ACL presets.
  const aclPublic = { roles: ["*"], users: [], abac: {} };
  const aclEngineering = { roles: ["Organization Owner","Workspace Admin","Team Space Admin","Engineer/Contributor","Reviewer/Approver"], users: [], abac: {} };
  const aclOps = { roles: ["Organization Owner","Workspace Admin","Team Space Admin","Operator/Technician","Reviewer/Approver"], users: [], abac: {} };
  const aclRestricted = { roles: ["Organization Owner","Workspace Admin"], users: [], abac: {} };

  const aclFor = (collection) => ({
    documents: aclEngineering,
    revisions: aclEngineering,
    drawings: aclEngineering,
    markups: aclEngineering,
    assets: aclOps,
    workItems: aclEngineering,
    incidents: aclOps,
    approvals: aclEngineering,
    forms: aclOps,
    messages: aclEngineering,
    channels: aclEngineering,
    projects: aclEngineering,
    teamSpaces: aclEngineering,
    integrations: aclRestricted,
    dataSources: aclRestricted,
    dashboards: aclEngineering,
    aiAgents: aclRestricted,
    threads: aclEngineering,
    files: aclEngineering,
  }[collection] || aclPublic);

  for (const collection of COLLECTIONS) {
    const list = d[collection];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      if (!item.org_id) item.org_id = orgId;
      if (!item.workspace_id) item.workspace_id = wsId;
      if (!item.created_by) item.created_by = creators[collection] || "U-1";
      if (!item.created_at) item.created_at = item.startedAt || item.createdAt || now;
      if (!item.updated_at) item.updated_at = item.updatedAt || item.created_at;
      if (!item.status) item.status = item.status || "active";
      if (!Array.isArray(item.labels)) item.labels = [];
      if (!item.acl || typeof item.acl !== "object") item.acl = aclFor(collection);
      if (!("audit_ref" in item)) item.audit_ref = null;
    }
  }

  // Ensure users have the same envelope for consistency in admin/searches.
  for (const u of (d.users || [])) {
    if (!u.org_id) u.org_id = orgId;
    if (!u.created_at) u.created_at = now;
    if (!u.labels) u.labels = [];
    if (!u.acl) u.acl = aclPublic;
  }

  // Forms & files optional in the seed; ensure the arrays exist.
  d.files = d.files || [];
  d.threads = d.threads || [];
  d.savedSearches = d.savedSearches || [];
  d.subscriptions = d.subscriptions || [];   // follow/watch list
  d.transmittals = d.transmittals || [];
  d.eventLog = d.eventLog || [];
  d.deadLetters = d.deadLetters || [];
  d.aiLog = d.aiLog || [];
  d.retentionPolicies = d.retentionPolicies || [
    { id: "RP-1", name: "Default audit retention", scope: "auditEvents", days: 2555, legalHold: false },
    { id: "RP-2", name: "Message history",         scope: "messages",    days: 1825, legalHold: false },
    { id: "RP-3", name: "Revision archive",        scope: "revisions",   days: 3650, legalHold: true  },
  ];
  d.policyViolations = d.policyViolations || [];

  return d;
}

/**
 * Touch `updated_at` on an entity and link its last audit entry.
 */
export function touch(item, auditEntry) {
  if (!item) return;
  item.updated_at = new Date().toISOString();
  if (auditEntry) item.audit_ref = auditEntry.id;
}
