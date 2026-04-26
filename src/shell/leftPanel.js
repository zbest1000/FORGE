import { el, mount } from "../core/ui.js";
import { state } from "../core/store.js";
import { navigate } from "../core/router.js";
import { openPalette } from "../core/palette.js";
import { canSeeAsset } from "../core/groups.js";

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
    quickActions(domain, d),
    ...sectionsFor(domain, d),
  ]);

  function section(title, items, map) {
    return el("div", { class: "tree-section" }, [
      el("div", { class: "tree-group-title" }, [title, el("span", { class: "tiny muted" }, [String(items.length)])]),
      ...items.map(item => {
        const m = map(item);
        const isActive = activeRoute === m.route;
        return el("button", {
    type: "button",
    class: `tree-item ${isActive ? "active" : ""} ${m.unread ? "unread" : ""}`,
          onClick: () => navigate(m.route),
        }, [
          el("span", { class: "tree-dot" }),
          el("span", { class: "tree-label" }, [m.label]),
          m.badge ? el("span", { class: "tree-count" }, [m.badge]) : null,
        ]);
      }),
    ]);
  }
}

function domainFor(route) {
  const path = (route || "").split("?")[0];
  if (path.startsWith("/work-board") || path === "/projects" || path === "/approvals") return "work";
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
      { label: "+ Work item", route: firstProject ? `/work-board/${firstProject.id}` : "/projects", primary: true },
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
  const makeSection = (title, items, map) => sectionNode(title, items, map, activeRoute);
  const recentDocs = [...(d.documents || [])].slice(0, 8);
  const recentDrawings = [...(d.drawings || [])].slice(0, 8);
  const visibleAssets = (d.assets || []).filter(canSeeAsset);

  if (domain === "work") {
    return [
      makeSection("Projects", d.projects || [], p => ({ route: `/work-board/${p.id}`, label: p.name })),
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
      makeSection("Assets", visibleAssets, a => ({ route: `/asset/${a.id}`, label: a.name, unread: a.status === "alarm" || a.status === "warning" })),
      makeSection("Industrial tools", [
        { route: "/uns", label: "Unified Namespace" },
        { route: "/i3x", label: "i3X explorer" },
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
        { route: "/integrations/mqtt", label: "MQTT" },
        { route: "/integrations/opcua", label: "OPC UA" },
        { route: "/integrations/erp", label: "ERP" },
      ], x => x),
      makeSection("Diagnostics", [
        { route: "/integrations", label: "Health overview" },
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

function sectionNode(title, items, map, activeRoute) {
  return el("div", { class: "tree-section" }, [
    el("div", { class: "tree-group-title" }, [title, el("span", { class: "tiny muted" }, [String(items.length)])]),
    ...items.map(item => {
      const m = map(item);
      const isActive = activeRoute === m.route;
      return el("button", {
        class: `tree-item ${isActive ? "active" : ""} ${m.unread ? "unread" : ""}`,
        onClick: () => navigate(m.route),
      }, [
        el("span", { class: "tree-dot", "aria-hidden": "true" }),
        el("span", { class: "tree-label" }, [m.label]),
        m.badge ? el("span", { class: "tree-count" }, [m.badge]) : null,
      ]);
    }),
  ]);
}
