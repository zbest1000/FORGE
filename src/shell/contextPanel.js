import { el, mount, card, badge } from "../core/ui.js";
import { state, getById } from "../core/store.js";
import { roleBanner } from "../core/permissions.js";
import { relative } from "../core/time.js";

export function renderContextPanel() {
  const root = document.getElementById("contextPanel");
  const route = state.route || "/home";

  const blocks = [
    card("Role", el("div", { class: "stack" }, [
      el("div", { class: "strong" }, [state.ui.role]),
      el("div", { class: "tiny muted" }, [roleBanner()]),
    ])),
    routeContextCard(route),
    card("Recent audit", recentAudit()),
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

function recentAudit() {
  const events = (state.data?.auditEvents || []).slice(0, 6);
  if (!events.length) return el("div", { class: "muted tiny" }, ["No audit events yet."]);
  return el("div", { class: "activity-list" },
    events.map(e =>
      el("div", { class: "activity-row" }, [
        el("span", { class: "ts" }, [relative(e.ts)]),
        el("span", {}, [el("span", { class: "strong" }, [e.action]), " · ", String(e.subject)]),
        el("span", { class: "tiny muted" }, [e.actor]),
      ])
    )
  );
}
