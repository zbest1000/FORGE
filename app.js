const ROLES = [
  "Organization Owner",
  "Workspace Admin",
  "Team Space Admin",
  "Engineer/Contributor",
  "Reviewer/Approver",
  "Operator/Technician",
  "Viewer/Auditor",
  "Integration Admin",
  "AI Admin",
  "External Guest/Vendor",
];

const NAV = [
  "Home",
  "Inbox",
  "Search",
  "Team Spaces",
  "Projects",
  "Docs",
  "Drawings",
  "Assets",
  "Dashboards",
  "Integrations",
  "AI",
  "Admin",
];

const OBJECT_MODEL = [
  "Organization",
  "Workspace",
  "Team Space",
  "Project",
  "Channel",
  "Thread",
  "Work Item",
  "Document",
  "Revision",
  "Drawing",
  "Markup",
  "Asset",
  "Incident",
  "Approval",
  "Form",
  "File",
  "Dashboard",
  "Integration",
  "Data Source",
  "AI Agent",
  "Audit Event",
];

const SCREENS = {
  "Workspace home": {
    subtitle: "Cross-functional execution summary with engineering context.",
    layout: ["Summary grid", "Activity feed", "Priority queues"],
    components: ["KPIs", "Review queue", "Incidents snapshot", "Integration health widgets"],
    states: ["normal", "no-data", "degraded integrations", "incident surge"],
    interactions: ["quick create", "pin dashboard", "jump to object"],
    permissions: ["Hidden unauthorized spaces", "Field-level masking for sensitive KPIs"],
    responsive: ["Cards stack on tablet/mobile", "Dock collapses by default"],
    ai: ["Daily engineering brief", "Cross-project risk summary"],
    audit: "Right panel: latest critical actions and approvals",
  },
  "Team Space overview": {
    subtitle: "Domain work hub with channels, docs, projects, and assets.",
    layout: ["Header", "Tabs", "Recent activity list"],
    components: ["Membership panel", "Milestones", "Recent revisions", "Pinned procedures"],
    states: ["active", "archived", "restricted"],
    interactions: ["create channel/project/doc", "invite scoped users"],
    permissions: ["Space ACL governs visibility and write actions"],
    responsive: ["Tabs condense to segmented controls"],
    ai: ["Summarize blockers and recent changes"],
    audit: "Right panel: team activity and membership changes",
  },
  "Channel with structured threads": {
    subtitle: "Operational conversation tied to assets, revisions, and incidents.",
    layout: ["Message stream", "Thread drawer", "Pinned object strip"],
    components: ["Composer", "Thread type badges", "Decision markers"],
    states: ["live", "read-only", "incident-locked", "external-collab"],
    interactions: ["convert message to work item", "link revision", "escalate incident"],
    permissions: ["Posting and mention controls", "External user redaction rules"],
    responsive: ["Thread drawer becomes full-screen"],
    ai: ["Unread summary", "Draft reply with citations"],
    audit: "Inline message edit/delete and decision trail",
  },
  "Work board": {
    subtitle: "Kanban/table execution with dependencies and SLA tracking.",
    layout: ["Board/table toggle", "Filters", "Swimlanes"],
    components: ["Work cards", "SLA chips", "Dependency graph"],
    states: ["backlog", "active window", "release freeze"],
    interactions: ["drag state", "bulk update", "set blockers"],
    permissions: ["Transition rights", "Field-lock for controlled workflows"],
    responsive: ["Defaults to table view on narrow screens"],
    ai: ["Priority recommendations", "Due-date risk scan"],
    audit: "Card-level timeline in context panel",
  },
  "Document viewer with revision history": {
    subtitle: "Controlled record viewing, approval routing, and change traceability.",
    layout: ["Document canvas", "Revision timeline", "Metadata header"],
    components: ["Page navigator", "Comment pins", "Approval banner"],
    states: ["Draft", "IFR", "Approved", "IFC", "Superseded", "Archived"],
    interactions: ["open previous rev", "diff", "request approval"],
    permissions: ["Download watermarking", "Classification-based visibility"],
    responsive: ["Metadata collapses into drawer"],
    ai: ["Ask document", "Summarize change history"],
    audit: "Revision ledger below timeline",
  },
  "Drawing viewer with markup tools": {
    subtitle: "Technical drawing review with anchored markups and issue links.",
    layout: ["Toolbar top/left", "Drawing canvas", "Object metadata panel"],
    components: ["Sheet navigator", "Markup palette", "Measure/callout tools"],
    states: ["view-only", "markup edit", "compare overlay"],
    interactions: ["create markup", "anchor thread", "convert to issue"],
    permissions: ["Discipline-specific markup rights"],
    responsive: ["Simplified tool palette on tablet"],
    ai: ["Changed-region detection", "Markup cluster summary"],
    audit: "Markup provenance and signature panel",
  },
  "Side-by-side revision compare": {
    subtitle: "Synchronized A/B compare for engineering revision deltas.",
    layout: ["Split panes", "Diff legend", "Metadata delta list"],
    components: ["Opacity slider", "Linked issue list", "Approval action bar"],
    states: ["identical", "changed", "conflict"],
    interactions: ["approve/reject change set", "open affected tasks"],
    permissions: ["Can compare only authorized revisions"],
    responsive: ["A/B toggle mode on mobile"],
    ai: ["Impact explanation across tasks/assets/approvals"],
    audit: "Compare session decisions",
  },
  "Asset detail page": {
    subtitle: "Single pane for operational and engineering asset context.",
    layout: ["Asset header", "Tabbed context", "Telemetry side panel"],
    components: ["Hierarchy breadcrumb", "Linked docs/drawings", "Live state widgets"],
    states: ["normal", "warning", "alarm", "offline"],
    interactions: ["open war room", "create work item", "inspect events"],
    permissions: ["Sensitive attributes masked by role"],
    responsive: ["Telemetry panel becomes collapsible"],
    ai: ["What changed in 24h?", "Probable cause hints"],
    audit: "Unified user + machine timeline",
  },
  "Integration console": {
    subtitle: "Connector lifecycle, diagnostics, and event replay.",
    layout: ["Connector list", "Config panel", "Log stream"],
    components: ["Health indicators", "Retry queue", "Dead-letter browser"],
    states: ["connected", "degraded", "failed", "maintenance"],
    interactions: ["test connection", "replay event", "rotate credential"],
    permissions: ["Write actions limited to Integration Admin"],
    responsive: ["Logs and config move into tabs"],
    ai: ["Failure cluster explanation"],
    audit: "Immutable integration change history",
  },
  "MQTT topic browser and mapping": {
    subtitle: "Namespace management and topic-to-asset event mapping.",
    layout: ["Topic tree", "Payload inspector", "Mapping rules"],
    components: ["QoS/retain badges", "Rule builder", "Simulation tool"],
    states: ["subscribed", "paused", "disconnected"],
    interactions: ["bind topic", "simulate message", "validate namespace"],
    permissions: ["Separate publish and subscribe capabilities"],
    responsive: ["Tree stacks above payload panel"],
    ai: ["Taxonomy recommendations", "Anomaly detection"],
    audit: "Topic mapping revision log",
  },
  "OPC UA browser and node mapping": {
    subtitle: "Browse namespaces and map nodes to normalized asset signals.",
    layout: ["Endpoint/session panel", "Node tree", "Mapping editor"],
    components: ["Datatype validator", "Sampling controls", "Transform preview"],
    states: ["active", "cert warning", "endpoint unavailable"],
    interactions: ["browse nodes", "bind node", "validate transform"],
    permissions: ["Credential access gated", "Write-node requires elevated role"],
    responsive: ["Node tree toggles into drawer"],
    ai: ["Semantic mapping suggestions", "Unit normalization hints"],
    audit: "Node mapping + write attempts in audit trail",
  },
  "ERP integration mapping": {
    subtitle: "Map ERP entities (PO/work-order/inventory) into FORGE work context.",
    layout: ["Mapping matrix", "Transform editor", "Sync status strip"],
    components: ["Conflict queue", "Backfill jobs", "Preview writeback"],
    states: ["in-sync", "drift", "conflict"],
    interactions: ["resolve mapping", "run backfill", "approve writeback"],
    permissions: ["Procurement/finance scoped access"],
    responsive: ["Row details open in modal"],
    ai: ["Mapping drift diagnosis"],
    audit: "Writeback and conflict decision ledger",
  },
  "Incident war room": {
    subtitle: "High-urgency command center for incident response.",
    layout: ["Severity header", "Live timeline", "Tasks/docs/procedures column"],
    components: ["Alarm strip", "Role roster", "Command checklist"],
    states: ["active", "escalated", "stabilized", "resolved", "postmortem"],
    interactions: ["assign commander", "open bridge", "generate action items"],
    permissions: ["Role-based command actions"],
    responsive: ["Timeline and checklist prioritized on mobile"],
    ai: ["Live summary", "Next-step recommendations"],
    audit: "Immutable command log export",
  },
  "Approval queue": {
    subtitle: "Time-bound approval routing for revisions and controlled changes.",
    layout: ["Queue table", "Object preview", "Signature panel"],
    components: ["SLA timers", "Delegation controls", "Decision templates"],
    states: ["pending", "approved", "rejected", "expired", "delegated"],
    interactions: ["sign", "request changes", "batch approve"],
    permissions: ["Approver matrix enforced by role and discipline"],
    responsive: ["Compact list with detail modal"],
    ai: ["Risk summary", "Outlier detection"],
    audit: "Signature chain-of-custody trail",
  },
  "AI workspace": {
    subtitle: "Permission-aware AI assistant for engineering analysis and drafting.",
    layout: ["Assistant thread pane", "Source citations panel", "Template actions"],
    components: ["Scope selector", "Model routing selector", "Prompt history"],
    states: ["ready", "retrieval-limited", "policy-blocked"],
    interactions: ["Q&A", "draft reports", "compare revisions"],
    permissions: ["Inherits data ACLs with no privilege escalation"],
    responsive: ["Single-column mode with expandable citations"],
    ai: ["Primary workspace", "Citation-backed answers"],
    audit: "Prompt/output/tool-call logs",
  },
  "Admin governance console": {
    subtitle: "Security, identity, retention, and compliance management.",
    layout: ["Policy nav", "Settings editor", "Audit analytics"],
    components: ["SSO config", "RBAC matrix", "Retention and DLP settings"],
    states: ["compliant", "warning", "violation"],
    interactions: ["update policy", "run access review", "export audit pack"],
    permissions: ["Admin and auditor scoped modules"],
    responsive: ["Section-by-section wizard"],
    ai: ["Policy impact explainer"],
    audit: "Full governance event stream",
  },
};

const WORKSPACE_TREE = [
  "Team Spaces",
  "Projects",
  "Channels",
  "Docs",
  "Drawings",
  "Assets",
  "Dashboards",
  "Integrations",
];

const state = {
  selectedScreen: "Workspace home",
  role: ROLES[3],
  dockVisible: false,
  dark: true,
};

const globalNav = document.getElementById("globalNav");
const screenTitle = document.getElementById("screenTitle");
const screenSubtitle = document.getElementById("screenSubtitle");
const screenLayout = document.getElementById("screenLayout");
const contextPanel = document.getElementById("contextPanel");
const roleSelect = document.getElementById("roleSelect");
const workspaceTree = document.getElementById("workspaceTree");
const operationsDock = document.getElementById("operationsDock");

function renderGlobalNav() {
  globalNav.innerHTML = "";
  Object.keys(SCREENS).forEach((screenName) => {
    const button = document.createElement("button");
    button.className = `nav-btn ${state.selectedScreen === screenName ? "active" : ""}`;
    button.textContent = screenName;
    button.onclick = () => {
      state.selectedScreen = screenName;
      render();
    };
    globalNav.appendChild(button);
  });
}

function renderWorkspaceTree() {
  workspaceTree.innerHTML = WORKSPACE_TREE.map((item) => `<div class="tree-item">${item}</div>`).join("");
}

function renderRoleSelect() {
  roleSelect.innerHTML = ROLES.map((role) => `<option value="${role}">${role}</option>`).join("");
  roleSelect.value = state.role;
  roleSelect.onchange = (event) => {
    state.role = event.target.value;
    render();
  };
}

function block(title, items) {
  return `
    <article class="panel-block">
      <h3>${title}</h3>
      <ul>${items.map((item) => `<li>${item}</li>`).join("")}</ul>
    </article>
  `;
}

function renderScreen() {
  const screen = SCREENS[state.selectedScreen];
  screenTitle.textContent = state.selectedScreen;
  screenSubtitle.textContent = screen.subtitle;

  screenLayout.innerHTML = [
    block("Layout anatomy", screen.layout),
    block("Component inventory", screen.components),
    block("States", screen.states),
    block("Key interactions", screen.interactions),
    block("Permission effects", screen.permissions),
    block("Responsive behavior", screen.responsive),
    block("AI affordances", screen.ai),
  ].join("");

  const permissionBanner = [
    "Organization Owner",
    "Workspace Admin",
    "Integration Admin",
    "AI Admin",
  ].includes(state.role)
    ? "Privileged actions available"
    : "Restricted mode: approval, integration, and admin writes may be limited";

  contextPanel.innerHTML = `
    ${block("Audit history placement", [screen.audit])}
    ${block("Current role", [state.role, permissionBanner])}
    ${block("Required object model", OBJECT_MODEL)}
  `;
}

function renderDock() {
  const records = [
    "INC-4412 · Active incident war room",
    "MQTT · line/a1/alarm/high-temp · degraded QoS",
    "OPCUA · Site-2 namespace sync delayed",
    "ERP · 2 work-order conflicts pending",
  ];

  operationsDock.innerHTML = `
    <div class="dock-title">Operations Dock</div>
    <div class="dock-items">${records.map((item) => `<span>${item}</span>`).join("")}</div>
  `;

  operationsDock.classList.toggle("hidden", !state.dockVisible);
}

function attachActions() {
  document.getElementById("toggleDockBtn").onclick = () => {
    state.dockVisible = !state.dockVisible;
    renderDock();
  };

  document.getElementById("toggleThemeBtn").onclick = () => {
    state.dark = !state.dark;
    document.body.classList.toggle("light", !state.dark);
  };

  document.getElementById("newWorkItemBtn").onclick = () => {
    state.selectedScreen = "Work board";
    render();
  };

  document.getElementById("newIncidentBtn").onclick = () => {
    state.selectedScreen = "Incident war room";
    render();
  };
}

function render() {
  renderGlobalNav();
  renderWorkspaceTree();
  renderRoleSelect();
  renderScreen();
  renderDock();
}

attachActions();
render();
