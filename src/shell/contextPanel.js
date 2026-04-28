import { el, mount, card, badge } from "../core/ui.js";
import { state, getById } from "../core/store.js";
import { roleBanner } from "../core/permissions.js";
import { relative } from "../core/time.js";
import { navigate } from "../core/router.js";

export function renderContextPanel() {
  const root = document.getElementById("contextPanel");
  const route = state.route || "/home";

  // Scope the audit card to routes where it's actually relevant — content
  // that has a real audit trail (asset config, doc revisions, incident
  // war room, project work items, drawing markups). On other routes
  // (home, hub, projects index, search, etc.) the card is suppressed so
  // the side panel stays focused on the screen at hand. The full ledger
  // lives at /audit with filters; the link below opens it pre-scoped.
  const auditFilter = scopedAuditFilter(route);
  const auditBlock = auditFilter ? scopedAuditCard(route, auditFilter) : null;

  const blocks = [
    card("Role", el("div", { class: "stack" }, [
      el("div", { class: "strong" }, [state.ui.role]),
      el("div", { class: "tiny muted" }, [roleBanner()]),
    ])),
    routeContextCard(route),
    auditBlock,
  ].filter(Boolean);

  mount(root, blocks);
}

function routeContextCard(route) {
  const d = state.data || {};
  if (route.startsWith("/doc/")) {
    const id = route.split("/")[2];
    const doc = getById("documents", id);
    if (!doc) return null;
    const rev = getById("revisions", doc.currentRevisionId);
    return card("Document", el("div", { class: "stack" }, [
      el("div", { class: "strong" }, [doc.name]),
      el("div", { class: "row wrap" }, [
        badge(doc.discipline || "", "info"),
        badge(doc.sensitivity || "", "warn"),
        rev ? badge(`Rev ${rev.label} — ${rev.status}`, `rev-${rev.status.toLowerCase()}`) : null,
      ]),
      el("div", { class: "tiny muted" }, [`${doc.revisionIds?.length || 0} revisions`]),
    ]));
  }
  if (route.startsWith("/drawing/")) {
    const id = route.split("/")[2];
    const dr = getById("drawings", id);
    if (!dr) return null;
    return card("Drawing", el("div", { class: "stack" }, [
      el("div", { class: "strong" }, [dr.name]),
      el("div", { class: "tiny muted" }, [`${dr.sheets?.length || 0} sheets · ${dr.discipline}`]),
    ]));
  }
  if (route.startsWith("/asset/")) {
    const id = route.split("/")[2];
    const a = getById("assets", id);
    if (!a) return null;
    const variant = a.status === "alarm" ? "danger" : a.status === "warning" ? "warn" : "success";
    return card("Asset", el("div", { class: "stack" }, [
      el("div", { class: "strong" }, [a.name]),
      el("div", { class: "tiny muted" }, [a.hierarchy]),
      el("div", {}, [badge(a.status.toUpperCase(), variant)]),
    ]));
  }
  if (route.startsWith("/incident/")) {
    const id = route.split("/")[2];
    const inc = getById("incidents", id);
    if (!inc) return null;
    return card("Incident", el("div", { class: "stack" }, [
      el("div", { class: "strong" }, [inc.title]),
      el("div", { class: "row wrap" }, [
        badge(inc.severity, "danger"),
        badge(inc.status, "warn"),
      ]),
    ]));
  }
  if (route.startsWith("/work-board/")) {
    const id = route.split("/")[2];
    const p = getById("projects", id);
    if (!p) return null;
    const items = (d.workItems || []).filter(w => w.projectId === p.id);
    return card("Project", el("div", { class: "stack" }, [
      el("div", { class: "strong" }, [p.name]),
      el("div", { class: "tiny muted" }, [`${items.length} work items · status ${p.status}`]),
    ]));
  }
  return null;
}

// Returns a predicate that selects audit events relevant to the current
// route, or null if this route doesn't have a contextual audit view.
// The full /audit page uses no scope; everywhere else uses the smallest
// scope that still tells the story of "what changed on this thing".
function scopedAuditFilter(route) {
  const d = state.data || {};
  if (route.startsWith("/asset/")) {
    const id = route.split("/")[2];
    return (e) => e.subject === id;
  }
  if (route.startsWith("/doc/")) {
    const id = route.split("/")[2];
    const doc = getById("documents", id);
    const revIds = new Set([id, ...(doc?.revisionIds || [])]);
    return (e) => revIds.has(e.subject);
  }
  if (route.startsWith("/drawing/")) {
    const id = route.split("/")[2];
    return (e) => e.subject === id;
  }
  if (route.startsWith("/incident/")) {
    const id = route.split("/")[2];
    return (e) => e.subject === id;
  }
  if (route.startsWith("/work-board/")) {
    const id = route.split("/")[2];
    const items = (d.workItems || []).filter(w => w.projectId === id).map(w => w.id);
    const ids = new Set([id, ...items]);
    return (e) => ids.has(e.subject);
  }
  return null;
}

function scopedAuditCard(route, filter) {
  const all = state.data?.auditEvents || [];
  const matches = all.filter(filter).slice(0, 6);
  const subjectId = route.split("/")[2] || "";
  const auditQuery = subjectId ? `?subject=${encodeURIComponent(subjectId)}` : "";
  const body = !matches.length
    ? el("div", { class: "muted tiny" }, ["No audit events for this item yet."])
    : el("div", { class: "activity-list" },
        matches.map(e =>
          el("div", { class: "activity-row" }, [
            el("span", { class: "ts" }, [relative(e.ts)]),
            el("span", {}, [el("span", { class: "strong" }, [e.action]), " · ", String(e.subject)]),
            el("span", { class: "tiny muted" }, [e.actor]),
          ])
        )
      );
  return card("Audit (this item)", el("div", { class: "stack" }, [
    body,
    el("button", {
      class: "btn xs ghost",
      onClick: () => navigate("/audit" + auditQuery),
      title: "Open the full audit ledger pre-filtered to this item",
    }, ["Open in audit log →"]),
  ]));
}
