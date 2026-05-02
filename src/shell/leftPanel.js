import { el, mount, clickable } from "../core/ui.js";
import { state } from "../core/store.js";
import { navigate } from "../core/router.js";
import { openPalette } from "../core/palette.js";
import { canSeeAsset } from "../core/groups.js";
import { isPinned, togglePin, getPinned, subscribe as subscribePinned } from "../core/pinned.js";

// Re-render the left panel when a pin toggles from any screen so the
// Pinned section + the per-row stars stay in sync. Idempotent — the
// subscribe call returns the same listener if invoked twice.
let _pinSubscribed = false;
function ensurePinSubscription() {
  if (_pinSubscribed) return;
  _pinSubscribed = true;
  subscribePinned(() => renderLeftPanel());
}

const DOMAIN_LABELS = {
  work: { title: "Work", subtitle: "Project execution" },
  docs: { title: "Documents", subtitle: "Controlled records" },
  drawings: { title: "Drawings", subtitle: "Review and markup" },
  assets: { title: "Assets", subtitle: "Industrial context" },
  incidents: { title: "Incidents", subtitle: "Command and response" },
  spaces: { title: "Team spaces", subtitle: "Collaboration" },
  integrations: { title: "Integrations", subtitle: "Connector administration" },
  admin: { title: "Admin", subtitle: "Governance settings" },
  home: { title: "Workspace", subtitle: "Start from a domain" },
};

export function renderLeftPanel() {
  ensurePinSubscription();
  const root = document.getElementById("leftPanel");
  const d = state.data || {};
  const activeRoute = state.route || "";
  const domain = domainFor(activeRoute);
  const meta = DOMAIN_LABELS[domain] || DOMAIN_LABELS.home;

  mount(root, [
    el("div", { class: "panel-header" }, [
      el("div", {}, [
        el("div", { class: "strong" }, [meta.title]),
        el("div", { class: "tiny muted" }, [meta.subtitle]),
      ]),
      el("button", {
        class: "btn sm ghost",
        title: "Command palette (⌘K)",
        onClick: () => openPalette(),
      }, ["⌘K"]),
    ]),
    // Pinned section is cross-domain — it shows whatever the operator
    // has pinned from anywhere so they don't have to switch domains
    // to reach their day-to-day items. Renders before quickActions so
    // it's the first thing the eye lands on.
    pinnedSection(d, activeRoute),
    quickActions(domain, d),
    ...sectionsFor(domain, d),
  ]);

  function section(title, items, map) {
    return el("div", { class: "tree-section" }, [
      el("div", { class: "tree-group-title" }, [title, el("span", { class: "tiny muted" }, [String(items.length)])]),
      ...items.map(item => {
        const m = map(item);
        const isActive = activeRoute === m.route;
        const node = el("div", {
          class: `tree-item ${isActive ? "active" : ""} ${m.unread ? "unread" : ""}`,
          onClick: () => navigate(m.route),
          "aria-current": isActive ? "page" : null,
        }, [
          el("span", { class: "tree-dot" }),
          el("span", { class: "tree-label" }, [m.label]),
          m.badge ? el("span", { class: "tree-count" }, [m.badge]) : null,
        ]);
        clickable(node, () => navigate(m.route), { label: `${m.label}${m.badge ? `, ${m.badge} unread` : ""}` });
        return node;
      }),
    ]);
  }
}

function domainFor(route) {
  const path = (route || "").split("?")[0];
  if (path.startsWith("/work-board") || path === "/projects" || path === "/approvals" || path === "/work") return "work";
  if (path.startsWith("/doc") || path.startsWith("/compare") || path === "/docs") return "docs";
  if (path.startsWith("/drawing") || path === "/drawings") return "drawings";
  if (path.startsWith("/asset") || path === "/assets" || path === "/uns" || path === "/i3x") return "assets";
  if (path.startsWith("/incident") || path === "/incidents") return "incidents";
  if (path.startsWith("/team-space") || path.startsWith("/channel") || path === "/team-spaces") return "spaces";
  if (path.startsWith("/integrations")) return "integrations";
  if (path === "/admin" || path.startsWith("/admin/")) return "admin";
  return "home";
}

function quickActions(domain, d) {
  const firstProject = (d.projects || [])[0];
  const firstIncident = (d.incidents || [])[0];
  const actions = ({
    work: [
      // The cross-project work view is the primary entry point —
      // operators almost always want the firehose first, then narrow
      // down. Per-project boards are a drill-down, listed under
      // "Projects" below.
      { label: "All work", route: "/work", primary: true },
      { label: "+ Work item", route: firstProject ? `/work-board/${firstProject.id}` : "/projects" },
      { label: "Approvals", route: "/approvals" },
    ],
    docs: [
      { label: "All documents", route: "/docs", primary: true },
      { label: "Reviews", route: "/approvals" },
    ],
    drawings: [
      { label: "All drawings", route: "/drawings", primary: true },
      { label: "Search", route: "/search" },
    ],
    assets: [
      { label: "Asset library", route: "/assets", primary: true },
      { label: "UNS", route: "/uns" },
    ],
    incidents: [
      { label: "Incidents", route: "/incidents", primary: true },
      { label: "Active room", route: firstIncident ? `/incident/${firstIncident.id}` : "/incidents" },
    ],
    spaces: [
      { label: "Team spaces", route: "/team-spaces", primary: true },
      { label: "Inbox", route: "/inbox" },
    ],
    integrations: [
      { label: "Overview", route: "/integrations", primary: true },
      { label: "DLQ/events", route: "/integrations" },
    ],
    admin: [
      { label: "Identity", route: "/admin/identity", primary: true },
      { label: "Access", route: "/admin/access" },
      { label: "Integrations", route: "/admin/integrations" },
      { label: "Audit", route: "/admin/audit" },
      { label: "Retention", route: "/admin/retention" },
      { label: "System health", route: "/admin/health" },
    ],
    home: [
      { label: "Command palette", onClick: openPalette, primary: true },
      { label: "Inbox", route: "/inbox" },
    ],
  })[domain] || [];

  return el("div", { class: "row wrap" }, actions.map(a =>
    el("button", {
      class: `btn sm ${a.primary ? "primary" : ""}`.trim(),
      onClick: () => a.onClick ? a.onClick() : navigate(a.route),
    }, [a.label])
  ));
}

function sectionsFor(domain, d) {
  const activeRoute = state.route || "";
  const makeSection = (title, items, map, opts) => sectionNode(title, items, map, activeRoute, opts);
  const recentDocs = [...(d.documents || [])].slice(0, 8);
  const recentDrawings = [...(d.drawings || [])].slice(0, 8);
  const visibleAssets = (d.assets || []).filter(canSeeAsset);

  if (domain === "work") {
    return [
      // Activity = the cross-project firehose. Listed under Views so
      // it reads as a peer concept to per-project boards rather than
      // a one-off button. Projects remain the per-project drill-down
      // — and each project row carries a pin star so operators can
      // promote the ones they live in to the cross-domain Pinned
      // section at the top of the panel.
      // Activity badge counts only items the user can see — keeps
       // the count honest with what they'll actually find on the
       // page after the permission filter applies there.
      makeSection("Views", [
        { route: "/work", label: "Activity", badge: String((d.workItems || []).filter(w => {
          const ids = Array.isArray(w.assetIds) ? w.assetIds : (w.assetIds ? [w.assetIds] : []);
          if (ids.length === 0) return true;
          return ids.some(id => {
            const a = (d.assets || []).find(x => x.id === id);
            return a ? canSeeAsset(a) : true;
          });
        }).length) },
      ], x => x),
      makeSection("Projects", d.projects || [], p => ({ route: `/work-board/${p.id}`, label: p.name, id: p.id }), { pinKind: "project" }),
      makeSection("Queues", [
        { route: "/approvals", label: "Approval queue", badge: String((d.approvals || []).filter(a => a.status === "pending").length) },
        { route: "/inbox", label: "Inbox" },
      ], x => x),
    ];
  }
  if (domain === "docs") {
    return [
      makeSection("Documents", recentDocs, doc => ({ route: `/doc/${doc.id}`, label: doc.name })),
      makeSection("Review", [
        { route: "/approvals", label: "Approvals", badge: String((d.approvals || []).filter(a => a.status === "pending").length) },
        { route: "/search", label: "Find controlled records" },
      ], x => x),
    ];
  }
  if (domain === "drawings") {
    return [makeSection("Drawings", recentDrawings, dr => ({ route: `/drawing/${dr.id}`, label: dr.name }))];
  }
  if (domain === "assets") {
    return [
      makeSection(
        "Assets",
        visibleAssets,
        a => ({ route: `/asset/${a.id}`, label: a.name, unread: a.status === "alarm" || a.status === "warning", id: a.id }),
        { pinKind: "asset" },
      ),
      makeSection("Industrial data & APIs", [
        { route: "/uns", label: "Unified Namespace" },
        { route: "/i3x", label: "i3X API" },
        { route: "/integrations", label: "Integration console" },
      ], x => x),
    ];
  }
  if (domain === "incidents") {
    return [makeSection("Incident rooms", d.incidents || [], i => ({ route: `/incident/${i.id}`, label: i.title, unread: i.status === "active", badge: i.severity }))];
  }
  if (domain === "spaces") {
    return [
      makeSection("Team Spaces", d.teamSpaces || [], ts => ({ route: `/team-space/${ts.id}`, label: ts.name })),
      makeSection("Channels", d.channels || [], c => ({ route: `/channel/${c.id}`, label: `# ${c.name}`, unread: c.unread > 0, badge: c.unread > 0 ? String(c.unread) : null })),
    ];
  }
  if (domain === "integrations") {
    return [
      makeSection("Connectors", [
        { route: "/integrations", label: "Health overview" },
        { route: "/integrations/mqtt", label: "MQTT" },
        { route: "/integrations/opcua", label: "OPC UA" },
        { route: "/integrations/erp", label: "ERP" },
      ], x => x),
      makeSection("Interoperability", [
        { route: "/uns", label: "UNS binding" },
        { route: "/i3x", label: "i3X API" },
      ], x => x),
    ];
  }
  if (domain === "admin") {
    return [makeSection("Settings", [
      { route: "/admin/identity", label: "Identity" },
      { route: "/admin/access", label: "Access and roles" },
      { route: "/admin/integrations", label: "Integrations" },
      { route: "/admin/audit", label: "Audit ledger" },
      { route: "/admin/retention", label: "Retention policies" },
      { route: "/admin/health", label: "System health" },
    ], x => x)];
  }
  return [
    makeSection("Start here", [
      { route: "/work-board/PRJ-1", label: "Work" },
      { route: "/docs", label: "Documents" },
      { route: "/drawings", label: "Drawings" },
      { route: "/assets", label: "Assets" },
      { route: "/incidents", label: "Incidents" },
    ], x => x),
  ];
}

function sectionNode(title, items, map, activeRoute, opts = {}) {
  // `opts.pinKind` ("project" | "asset" | etc.) is set by sections
  // whose rows are pinnable; the section then renders a star button
  // next to each row that toggles the pin. The star sits inside a
  // wrapper <div class="tree-item-row"> alongside the navigate
  // button so a click on the star doesn't fire the row navigation.
  const { pinKind = null } = opts;
  return el("div", { class: "tree-section" }, [
    el("div", { class: "tree-group-title" }, [title, el("span", { class: "tiny muted" }, [String(items.length)])]),
    ...items.map(item => {
      const m = map(item);
      const isActive = activeRoute === m.route;
      const rowBtn = el("button", {
        class: `tree-item ${isActive ? "active" : ""} ${m.unread ? "unread" : ""}`,
        onClick: () => navigate(m.route),
      }, [
        el("span", { class: "tree-dot", "aria-hidden": "true" }),
        el("span", { class: "tree-label" }, [m.label]),
        m.badge ? el("span", { class: "tree-count" }, [m.badge]) : null,
      ]);
      if (!pinKind || !item.id) return rowBtn;
      // Pinnable row — wrap the navigate button alongside a pin
      // toggle. The star uses outline (☆) when not pinned and
      // filled (★) when pinned; clicking it toggles without
      // navigating.
      const pinned = isPinned(pinKind, item.id);
      const starBtn = el("button", {
        class: `pin-star ${pinned ? "is-pinned" : ""}`,
        type: "button",
        title: pinned ? "Unpin from sidebar" : "Pin to sidebar",
        "aria-label": pinned ? `Unpin ${m.label}` : `Pin ${m.label}`,
        "aria-pressed": String(pinned),
        onClick: (e) => {
          e.stopPropagation();
          togglePin(pinKind, item.id);
        },
      }, [pinned ? "★" : "☆"]);
      return el("div", { class: "tree-item-row" }, [rowBtn, starBtn]);
    }),
  ]);
}

// Cross-domain pinned section. Looks up each pinned id against the
// live workspace data; rows whose targets no longer exist (deleted
// project, archived asset) are silently dropped so a stale pin
// doesn't render a broken row.
function pinnedSection(d, activeRoute) {
  const pinned = getPinned();
  if (pinned.length === 0) return null;

  const projects = d.projects || [];
  const assets = (d.assets || []).filter(canSeeAsset);

  const rows = [];
  for (const p of pinned) {
    if (p.kind === "project") {
      const proj = projects.find(x => x.id === p.id);
      if (proj) {
        rows.push({ kind: "project", id: proj.id, label: proj.name, route: `/work-board/${proj.id}` });
      }
    } else if (p.kind === "asset") {
      const a = assets.find(x => x.id === p.id);
      if (a) {
        rows.push({ kind: "asset", id: a.id, label: a.name, route: `/asset/${a.id}` });
      }
    }
  }
  if (rows.length === 0) return null;

  return el("div", { class: "tree-section" }, [
    el("div", { class: "tree-group-title" }, [
      "Pinned",
      el("span", { class: "tiny muted" }, [String(rows.length)]),
    ]),
    ...rows.map(r => {
      const isActive = activeRoute === r.route;
      const rowBtn = el("button", {
        class: `tree-item ${isActive ? "active" : ""}`,
        onClick: () => navigate(r.route),
      }, [
        // Kind-specific glyph: project wrench, asset signal. Decorative.
        el("span", { class: "tree-pin-kind", "aria-hidden": "true" }, [r.kind === "asset" ? "⚙" : "▣"]),
        el("span", { class: "tree-label" }, [r.label]),
      ]);
      const unpin = el("button", {
        class: "pin-star is-pinned",
        type: "button",
        title: "Unpin",
        "aria-label": `Unpin ${r.label}`,
        onClick: (e) => { e.stopPropagation(); togglePin(r.kind, r.id); },
      }, ["★"]);
      return el("div", { class: "tree-item-row" }, [rowBtn, unpin]);
    }),
  ]);
}
