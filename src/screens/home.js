import { el, card, kpi, badge, mount } from "../core/ui.js";
import { state } from "../core/store.js";
import { navigate } from "../core/router.js";
import { effectiveGroupIds, currentUserId, isOrgOwner } from "../core/groups.js";
import { workspaceIncidentBrief } from "../core/simulation.js";
import { helpHint, helpLinkChip } from "../core/help.js";

function viewerInGroups(...ids) {
  if (isOrgOwner()) return true;
  const eff = new Set(effectiveGroupIds(currentUserId()));
  return ids.some(id => eff.has(id));
}

export function renderHome() {
  const root = document.getElementById("screenContainer");
  const d = state.data;

  const approvalsPending = (d.approvals || []).filter(a => a.status === "pending").length;
  const incidentsActive  = (d.incidents || []).filter(i => i.status === "active").length;
  const reviewQueue      = (d.revisions || []).filter(r => r.status === "IFR").length;
  const openWork         = (d.workItems || []).filter(w => !["Done","Approved"].includes(w.status)).length;
  const degradedInteg    = (d.integrations || []).filter(i => i.status !== "connected").length;

  const aiBrief = buildAIBrief(d);

  mount(root, [
    el("div", { style: { marginBottom: "12px" } }, [
      el("h2", { style: { display: "inline-flex", alignItems: "center", margin: 0, fontSize: "18px" } }, [
        "Workspace home", helpHint("forge.audit-chain"),
      ]),
      el("div", { class: "tiny muted" }, ["Tamper-evident audit ledger, capability-based RBAC, and connector health at a glance."]),
      el("div", { class: "row wrap", style: { gap: "6px", marginTop: "6px" } }, [
        helpLinkChip("forge.audit-chain", "Audit ledger"),
        helpLinkChip("forge.permissions", "Permissions"),
        helpLinkChip("forge.integrations", "Integrations"),
      ]),
    ]),
    el("div", { class: "card-grid" }, [
      kpi("Open work items", openWork, "+3 this week", "up"),
      kpi("Review queue", reviewQueue, "↑ awaiting you", "up"),
      kpi("Pending approvals", approvalsPending, "SLA 24h", ""),
      kpi("Active incidents", incidentsActive, incidentsActive ? "SEV-2 open" : "clear", incidentsActive ? "down" : "up"),
      kpi("Degraded integrations", degradedInteg, "", degradedInteg ? "down" : "up"),
    ]),

    el("div", { class: "two-col", style: { marginTop: "16px" } }, [
      card("Priority queue", priorityQueue(d), { subtitle: "What needs you next", actions: [
        el("button", { class: "btn sm", onClick: () => navigate("/approvals") }, ["Approvals →"]),
      ]}),
      card("Daily engineering brief (AI)", aiBrief, { subtitle: "Citation-backed summary", actions: [
        el("button", { class: "btn sm", onClick: () => navigate("/ai") }, ["Open AI →"]),
      ]}),
    ]),

    el("div", { class: "two-col", style: { marginTop: "16px" } }, [
      card("Recent revisions", recentRevisions(d), { actions: [
        el("button", { class: "btn sm", onClick: () => navigate("/docs") }, ["All docs →"]),
      ]}),
      viewerInGroups("G-it","G-automation","G-erp")
        ? card("Integration health", integrationHealth(d), { actions: [
            el("button", { class: "btn sm", onClick: () => navigate("/integrations") }, ["Console →"]),
          ]})
        : card("Engineering picks for you", engineeringPicks(d), { subtitle: "Recently active in your spaces" }),
    ]),
  ]);
}

function engineeringPicks(d) {
  const items = [
    ...(d.documents || []).slice(0, 3).map(doc => ({ kind: "Doc", label: doc.name, route: `/doc/${doc.id}` })),
    ...(d.projects || []).slice(0, 2).map(p => ({ kind: "Project", label: p.name, route: `/work-board/${p.id}` })),
  ];
  return el("div", { class: "activity-list" }, items.map(it =>
    el("button", { class: "activity-row", type: "button", onClick: () => navigate(it.route) }, [
      badge(it.kind, "info"),
      el("span", {}, [it.label]),
      el("span", { class: "tiny muted" }, [it.route]),
    ])
  ));
}

function priorityQueue(d) {
  const rows = [];
  (d.approvals || []).filter(a => a.status === "pending").slice(0, 4).forEach(a =>
    rows.push(el("button", { class: "activity-row", type: "button", onClick: () => navigate("/approvals") }, [
      el("span", { class: "ts" }, ["Approval"]),
      el("span", {}, [a.subject.kind, " ", el("span", { class: "mono" }, [a.subject.id])]),
      badge("SLA 24h", "warn"),
    ]))
  );
  (d.incidents || []).filter(i => i.status === "active").forEach(i =>
    rows.push(el("button", { class: "activity-row", type: "button", onClick: () => navigate(`/incident/${i.id}`) }, [
      el("span", { class: "ts" }, ["Incident"]),
      el("span", {}, [i.title]),
      badge(i.severity, "danger"),
    ]))
  );
  (d.workItems || []).filter(w => ["In Progress","In Review","Open"].includes(w.status)).slice(0, 4).forEach(w =>
    rows.push(el("button", { class: "activity-row", type: "button", onClick: () => navigate(`/work-board/${w.projectId}`) }, [
      el("span", { class: "ts" }, [w.type]),
      el("span", {}, [el("span", { class: "mono" }, [w.id + " "]), w.title]),
      badge(w.status, "info"),
    ]))
  );
  return el("div", { class: "activity-list" }, rows);
}

function buildAIBrief(d) {
  const pendingApproval = (d.approvals || []).find(a => a.status === "pending");
  const reviewRev = (d.revisions || []).find(r => r.status === "IFR");
  const incidentBrief = workspaceIncidentBrief(d);

  const bullets = [
    incidentBrief ? `• ${incidentBrief}` : null,
    reviewRev ? `• ${reviewRev.docId} Rev ${reviewRev.label} is ${reviewRev.status}: "${reviewRev.summary}". [cite: ${reviewRev.id}]` : null,
    pendingApproval ? `• ${pendingApproval.id} awaits approval on ${pendingApproval.subject.kind} ${pendingApproval.subject.id}.` : null,
    `• ${(d.workItems || []).filter(w => w.severity === "high").length} high-severity work items are open.`,
  ].filter(Boolean);

  return el("div", { class: "stack" }, [
    ...bullets.map(b => el("div", { class: "small" }, [b])),
    el("div", { class: "row wrap tiny muted" }, [
      "Citations:",
      (d.revisions || []).filter(r => r.status === "IFR").map(r => badge(r.id, "accent")),
      (d.incidents || []).filter(i => i.status === "active").map(i => badge(i.id, "danger")),
    ]),
  ]);
}

function recentRevisions(d) {
  const revs = [...(d.revisions || [])].sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")).slice(0, 5);
  return el("div", { class: "activity-list" }, revs.map(r => {
    const doc = (d.documents || []).find(x => x.id === r.docId);
    return el("button", { class: "activity-row", type: "button", onClick: () => navigate(`/doc/${r.docId}`) }, [
      el("span", { class: "ts" }, [new Date(r.createdAt).toLocaleDateString()]),
      el("span", {}, [el("span", { class: "mono" }, [`${r.id}  `]), doc?.name || r.docId]),
      badge(`${r.label} · ${r.status}`, `rev-${r.status.toLowerCase()}`),
    ]);
  }));
}

function integrationHealth(d) {
  return el("div", { class: "activity-list" }, (d.integrations || []).map(i => {
    const v = i.status === "connected" ? "success" : i.status === "failed" ? "danger" : "warn";
    return el("div", { class: "activity-row" }, [
      el("span", { class: "ts" }, [i.kind.toUpperCase()]),
      el("span", {}, [i.name, " · ", el("span", { class: "tiny muted" }, [`${i.eventsPerMin}/min`])]),
      badge(i.status, v),
    ]);
  }));
}
