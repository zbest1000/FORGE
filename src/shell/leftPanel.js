import { el, mount, clickable } from "../core/ui.js";
import { state, update } from "../core/store.js";
import { navigate } from "../core/router.js";
import { openPalette } from "../core/palette.js";
import { canSeeAsset, portalById } from "../core/groups.js";

// Header text shown at the top of the leftPanel for each domain. The
// title MUST match what the operator just clicked in the rail (or in
// the page they navigated to) — otherwise the panel feels like the
// app teleported them somewhere unexpected. Audit any mismatch when
// adding a new top-level route.
const DOMAIN_LABELS = {
  home:         { title: "Home",         subtitle: "Workspace overview" },
  inbox:        { title: "Inbox",        subtitle: "Notifications & mentions" },
  search:       { title: "Search",       subtitle: "Find anything in FORGE" },
  ai:           { title: "AI",           subtitle: "Assistants & summaries" },
  operations:   { title: "Ops Data",     subtitle: "Live process telemetry" },
  dashboards:   { title: "Dashboards",   subtitle: "KPIs & analytics" },
  profiles:     { title: "Profiles",     subtitle: "Asset profile library" },
  spec:         { title: "Spec",         subtitle: "FORGE specification" },
  work:         { title: "Work",         subtitle: "Project execution" },
  docs:         { title: "Documents",    subtitle: "Controlled records" },
  drawings:     { title: "Drawings",     subtitle: "Review and markup" },
  assets:       { title: "Assets",       subtitle: "Industrial context" },
  incidents:    { title: "Incidents",    subtitle: "Command and response" },
  spaces:       { title: "Team spaces",  subtitle: "Collaboration" },
  integrations: { title: "Integrations", subtitle: "Connector administration" },
  admin:        { title: "Admin",        subtitle: "Governance settings" },
};

export function renderLeftPanel() {
  const root = document.getElementById("leftPanel");
  const d = state.data || {};
  const activeRoute = state.route || "";
  const portal = state.ui?.portalId ? portalById(state.ui.portalId) : null;

  // Specific routes (/docs, /drawings, /work-board/*, ...) lock the
  // panel to that domain regardless of portal — operators expect the
  // panel to follow the page they're actually on.
  //
  // The portal-view override is intentionally scoped to the workspace-
  // landing routes only (`/home`, `/`). It would be wrong to apply it
  // to every route that isn't matched explicitly — `/inbox`, `/search`,
  // `/ai`, etc. each get their own domain handler now, so they no
  // longer fall through to "home" and can't be hijacked.
  const routeDomain = domainFor(activeRoute);
  const activePath = (activeRoute || "").split("?")[0];
  const isPortalLanding = activePath === "/home" || activePath === "/";
  const usePortalView = Boolean(portal && isPortalLanding);
  const domain = usePortalView ? "portal" : routeDomain;
  const meta = usePortalView
    ? { title: portal.label, subtitle: portal.description }
    : (DOMAIN_LABELS[routeDomain] || DOMAIN_LABELS.home);

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
    quickActions(domain, d, portal),
    ...sectionsFor(domain, d, portal),
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
  // Exact-match landing routes — handle each rail destination
  // explicitly so the panel header reflects WHERE the user is, not
  // a generic "Workspace" fallback. Order matters: more-specific
  // checks run first.
  if (path === "/home" || path === "/")  return "home";
  if (path === "/inbox")                 return "inbox";
  if (path === "/search")                return "search";
  if (path === "/ai")                    return "ai";
  if (path === "/operations")            return "operations";
  if (path === "/dashboards")            return "dashboards";
  if (path === "/profiles")              return "profiles";
  if (path === "/spec")                  return "spec";

  // Compound routes — match by prefix.
  if (path.startsWith("/work-board") || path === "/projects" || path === "/approvals") return "work";
  if (path.startsWith("/doc") || path.startsWith("/compare") || path === "/docs") return "docs";
  if (path.startsWith("/drawing") || path === "/drawings") return "drawings";
  if (path.startsWith("/asset") || path === "/assets" || path === "/uns" || path === "/i3x") return "assets";
  if (path.startsWith("/incident") || path === "/incidents") return "incidents";
  if (path.startsWith("/team-space") || path.startsWith("/channel") || path === "/team-spaces") return "spaces";
  if (path.startsWith("/integrations")) return "integrations";
  if (path === "/admin" || path.startsWith("/admin/") || path === "/audit") return "admin";

  // Genuinely unknown route — fall through to the home shortlist.
  return "home";
}

function quickActions(domain, d, portal) {
  const firstProject = (d.projects || [])[0];
  const firstIncident = (d.incidents || [])[0];

  // Portal landing view: surface the same items the rail shows for the
  // active portal as quick-action buttons. Anchors to the portal id so
  // sub-route navigation keeps the portal pinned.
  if (domain === "portal" && portal) {
    const items = (portal.items || []).slice(0, 5);
    if (items.length) {
      return el("div", { class: "row wrap" }, items.map((it, i) =>
        el("button", {
          class: `btn sm ${i === 0 ? "primary" : ""}`.trim(),
          onClick: () => navigate(it.route + (state.ui?.portalId ? `?portal=${state.ui.portalId}` : "")),
        }, [it.label])
      ));
    }
  }

  /** @type {Record<string, Array<{ label: string, route?: string, onClick?: () => void, primary?: boolean }>>} */
  const actionsByDomain = {
    home: [
      { label: "Command palette", onClick: openPalette, primary: true },
      { label: "Hub", route: "/hub" },
      { label: "Inbox", route: "/inbox" },
    ],
    inbox: [
      { label: "Mark all read", primary: true, onClick: () => {
        update(s => { s.data.notifications = []; });
      }},
      { label: "Approvals", route: "/approvals" },
    ],
    search: [
      { label: "Open palette", onClick: openPalette, primary: true },
      { label: "All docs", route: "/docs" },
      { label: "Assets", route: "/assets" },
    ],
    ai: [
      { label: "AI workspace", route: "/ai", primary: true },
      { label: "Search", route: "/search" },
    ],
    operations: [
      { label: "Live ops", route: "/operations", primary: true },
      { label: "UNS", route: "/uns" },
      { label: "i3X API", route: "/i3x" },
      { label: "Integrations", route: "/integrations" },
    ],
    dashboards: [
      { label: "All dashboards", route: "/dashboards", primary: true },
      { label: "Search", route: "/search" },
    ],
    profiles: [
      { label: "Profile library", route: "/profiles", primary: true },
      { label: "Assets", route: "/assets" },
    ],
    spec: [
      { label: "Spec", route: "/spec", primary: true },
      { label: "Audit ledger", route: "/audit" },
    ],
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
  };
  const actions = actionsByDomain[domain] || [];

  return el("div", { class: "row wrap" }, actions.map(a =>
    el("button", {
      class: `btn sm ${a.primary ? "primary" : ""}`.trim(),
      onClick: () => a.onClick ? a.onClick() : navigate(a.route),
    }, [a.label])
  ));
}

function sectionsFor(domain, d, portal) {
  const activeRoute = state.route || "";
  const makeSection = (title, items, map) => sectionNode(title, items, map, activeRoute);
  const recentDocs = [...(d.documents || [])].slice(0, 8);
  const recentDrawings = [...(d.drawings || [])].slice(0, 8);
  const visibleAssets = (d.assets || []).filter(canSeeAsset);

  // Portal landing view: use the portal's own items as the navigation
  // tree. Keeps the panel feeling like "you're inside the Engineering
  // portal" rather than reverting to a generic shortlist on every
  // click of the workspace nav.
  if (domain === "portal" && portal) {
    const items = (portal.items || []).map(it => ({
      route: it.route + (state.ui?.portalId ? `?portal=${state.ui.portalId}` : ""),
      label: it.label,
    }));
    return [makeSection(`In ${portal.label}`, items, x => x)];
  }

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
  if (domain === "inbox") {
    const notifications = [...(d.notifications || [])].slice(0, 12);
    return [
      makeSection("Recent notifications", notifications, n => ({
        route: n.route || "/inbox",
        label: n.text || n.kind || "Notification",
        unread: !n.read,
      })),
      makeSection("Filters", [
        { route: "/inbox?filter=mentions", label: "Mentions" },
        { route: "/inbox?filter=approvals", label: "Approvals" },
        { route: "/inbox?filter=incidents", label: "Incidents" },
      ], x => x),
    ];
  }
  if (domain === "search") {
    return [
      makeSection("Browse by domain", [
        { route: "/docs", label: "Documents" },
        { route: "/drawings", label: "Drawings" },
        { route: "/assets", label: "Assets" },
        { route: "/incidents", label: "Incidents" },
        { route: "/team-spaces", label: "Team spaces" },
      ], x => x),
    ];
  }
  if (domain === "ai") {
    return [
      makeSection("AI workflows", [
        { route: "/ai", label: "Assistant" },
        { route: "/ai?mode=brief", label: "Daily brief" },
        { route: "/ai?mode=summarise", label: "Summarise channel" },
      ], x => x),
      makeSection("Grounded sources", [
        { route: "/docs", label: "Documents" },
        { route: "/drawings", label: "Drawings" },
        { route: "/assets", label: "Assets" },
      ], x => x),
    ];
  }
  if (domain === "operations") {
    return [
      makeSection("Live data", [
        { route: "/operations", label: "Operations console" },
        { route: "/uns", label: "Unified Namespace" },
        { route: "/i3x", label: "i3X API" },
      ], x => x),
      makeSection("Connectors", [
        { route: "/integrations/mqtt", label: "MQTT" },
        { route: "/integrations/opcua", label: "OPC UA" },
        { route: "/integrations", label: "All connectors" },
      ], x => x),
    ];
  }
  if (domain === "dashboards") {
    return [
      makeSection("Browse", [
        { route: "/dashboards", label: "All dashboards" },
        { route: "/operations", label: "Ops data" },
        { route: "/audit", label: "Audit ledger" },
      ], x => x),
    ];
  }
  if (domain === "profiles") {
    const profiles = [...(d.assetProfiles || [])].slice(0, 8);
    return [
      makeSection("Profiles", profiles, p => ({ route: `/profiles?id=${p.id}`, label: p.name || p.id })),
      makeSection("Related", [
        { route: "/assets", label: "Assets" },
        { route: "/admin/integrations", label: "Integrations" },
      ], x => x),
    ];
  }
  if (domain === "spec") {
    return [
      makeSection("Reference", [
        { route: "/spec", label: "Specification" },
        { route: "/audit", label: "Audit ledger" },
      ], x => x),
    ];
  }

  // home (and any genuinely unknown route)
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
  // Strip the query string so an item route of "/home?portal=engineering"
  // still highlights as active when the active route is "/home" (and
  // vice versa). The portal id rides in the URL so the rail can stay
  // pinned, but it shouldn't fragment the "you are here" indicator.
  const activePath = (activeRoute || "").split("?")[0];
  return el("div", { class: "tree-section" }, [
    el("div", { class: "tree-group-title" }, [title, el("span", { class: "tiny muted" }, [String(items.length)])]),
    ...items.map(item => {
      const m = map(item);
      const itemPath = (m.route || "").split("?")[0];
      const isActive = activePath === itemPath;
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
