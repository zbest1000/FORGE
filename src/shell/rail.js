import { el, mount } from "../core/ui.js";
import { state, update } from "../core/store.js";
import { navigate } from "../core/router.js";
import { audit } from "../core/audit.js";
import { portalById, canAccessRoute, isOrgOwner } from "../core/groups.js";

const DEFAULT_ITEMS = [
  { icon: "🏛", label: "Hub",      route: "/hub" },
  { icon: "🏠", label: "Home",     route: "/home" },
  { icon: "✓",  label: "Work",     route: "/projects" },
  { icon: "Docs", label: "Docs",     route: "/docs" },
  { icon: "Draw", label: "Drawings", route: "/drawings" },
  { icon: "⚙️", label: "Assets",   route: "/assets" },
  { icon: "Ops", label: "Ops Data", route: "/operations" },
  { icon: "🚨", label: "Incidents",route: "/incidents" },
  { icon: "Team", label: "Teams",    route: "/team-spaces" },
  { icon: "In", label: "Inbox",    route: "/inbox" },
  { icon: "🤖", label: "AI",       route: "/ai" },
  { icon: "🔌", label: "Integ",    route: "/integrations" },
  { icon: "🛡",  label: "Admin",    route: "/admin" },
];

export function renderRail() {
  const root = document.getElementById("farLeftRail");
  const path = state.route || "/hub";
  const portal = state.ui.portalId ? portalById(state.ui.portalId) : null;

  // Build the nav list — portal mode shows just that portal's items + a Hub
  // button so the user can return to the launcher quickly.
  let items;
  if (portal) {
    items = [{ icon: "🏛", label: "Hub", route: "/hub" }, ...portal.items];
  } else {
    items = DEFAULT_ITEMS;
  }
  // Group-based gating: hide rail items the viewer can't access. Org Owners
  // bypass and see everything for support purposes.
  if (!isOrgOwner()) items = items.filter(it => canAccessRoute(it.route));

  root.setAttribute("role", "navigation");
  root.setAttribute("aria-label", "Primary navigation");
  mount(root, [
    el("div", {
      class: "rail-logo",
      title: portal ? `${portal.label} portal` : "FORGE",
      "aria-hidden": "true",
      style: portal ? { background: portal.accent, color: "#0b1220" } : null,
    }, [portal ? portal.icon : "FORGE"]),
    workspaceSwitcher(),
    ...items.map(item =>
      el("button", {
        class: `rail-btn ${matches(path, item.route) ? "active" : ""}`,
        title: item.label,
        "aria-current": matches(path, item.route) ? "page" : null,
        onClick: () => navigate(item.route + (portal ? `?portal=${portal.id}` : "")),
      }, [
        el("span", { class: "rail-icon", "aria-hidden": "true" }, [item.icon]),
        el("span", {}, [item.label]),
      ])
    ),
    el("div", { class: "rail-spacer" }),
    el("button", {
      class: "rail-btn",
      title: "Toggle theme",
      onClick: () => {
        update(s => { s.ui.theme = s.ui.theme === "dark" ? "light" : "dark"; });
      },
    }, [el("span", { class: "rail-icon" }, ["◐"]), el("span", {}, ["Theme"])]),
    el("button", {
      class: "rail-btn",
      title: "Toggle ops dock",
      onClick: () => update(s => { s.ui.dockVisible = !s.ui.dockVisible; }),
    }, [el("span", { class: "rail-icon" }, ["⚓"]), el("span", {}, ["Dock"])]),
  ]);
}

function matches(path, route) {
  // Strip query string from path for comparison.
  const p = (path || "").split("?")[0];
  if (route === "/home") return p === "/home";
  if (route === "/hub")  return p === "/hub";
  if (route === "/docs") return p === "/docs" || p.startsWith("/doc/") || p.startsWith("/compare/");
  if (route === "/drawings") return p === "/drawings" || p.startsWith("/drawing/");
  if (route === "/projects") return p === "/projects" || p.startsWith("/work-board/") || p === "/approvals";
  if (route === "/assets") return p === "/assets" || p.startsWith("/asset/") || p === "/uns" || p === "/i3x";
  if (route === "/operations") return p === "/operations";
  if (route === "/incidents") return p === "/incidents" || p.startsWith("/incident/");
  if (route === "/team-spaces") return p === "/team-spaces" || p.startsWith("/team-space/") || p.startsWith("/channel/");
  const base = route.split("/")[1];
  return p.startsWith("/" + base);
}

function workspaceSwitcher() {
  const all = state.data?.workspaces || [];
  const current = all.find(w => w.id === state.ui.workspaceId) || all[0] || state.data?.workspace;
  if (!all.length || all.length < 2) {
    return el("div", { class: "rail-ws", title: current?.name || "Workspace" }, [
      el("div", { class: "rail-ws-icon" }, [(current?.icon || "🏭")]),
    ]);
  }
  return el("button", {
    class: "rail-btn",
    title: "Switch workspace · current: " + (current?.name || "?"),
    onClick: openSwitcher,
    "aria-haspopup": "menu",
  }, [
    el("span", { class: "rail-icon", "aria-hidden": "true" }, [current?.icon || "🏭"]),
    el("span", {}, [(current?.name || "WS").slice(0, 7)]),
  ]);
}

function openSwitcher() {
  // Build a quick popover anchored to the rail.
  const all = state.data?.workspaces || [];
  const root = document.getElementById("paletteRoot");
  if (!root) return;
  const close = () => { root.innerHTML = ""; };
  const wrap = el("div", { class: "modal-backdrop", onClick: e => { if (e.target === wrap) close(); } }, [
    el("div", { class: "modal", role: "menu", "aria-label": "Switch workspace" }, [
      el("div", { class: "modal-header" }, [
        el("h3", {}, ["Switch workspace"]),
        el("button", { class: "btn ghost sm", onClick: close }, ["Close"]),
      ]),
      el("div", { class: "modal-body stack" },
        all.map(w => el("button", {
          class: `btn ${w.id === state.ui.workspaceId ? "primary" : ""}`,
          role: "menuitemradio",
          "aria-checked": String(w.id === state.ui.workspaceId),
          onClick: () => {
            update(s => { s.ui.workspaceId = w.id; });
            audit("workspace.switch", w.id, { from: state.ui.workspaceId, to: w.id });
            close();
            navigate("/home");
          },
        }, [
          el("span", { "aria-hidden": "true", style: { marginRight: "8px" } }, [w.icon || "🏭"]),
          el("span", { class: "stack", style: { gap: "0", textAlign: "left" } }, [
            el("span", {}, [w.name]),
            el("span", { class: "tiny muted" }, [w.id, " · ", w.region || ""]),
          ]),
        ]))
      ),
    ]),
  ]);
  root.innerHTML = "";
  root.append(wrap);
}
