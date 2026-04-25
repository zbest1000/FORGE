import { el, mount } from "../core/ui.js";
import { state, update } from "../core/store.js";
import { navigate } from "../core/router.js";
import { audit } from "../core/audit.js";

const ITEMS = [
  { icon: "🏠", label: "Home",     route: "/home" },
  { icon: "📥", label: "Inbox",    route: "/inbox" },
  { icon: "🔎", label: "Search",   route: "/search" },
  { icon: "🗂",  label: "Spaces",   route: "/team-spaces" },
  { icon: "🎯", label: "Projects", route: "/projects" },
  { icon: "📑", label: "Docs",     route: "/docs" },
  { icon: "📐", label: "Drawings", route: "/drawings" },
  { icon: "⚙️", label: "Assets",   route: "/assets" },
  { icon: "🌐", label: "UNS",      route: "/uns" },
  { icon: "🧩", label: "i3X",      route: "/i3x" },
  { icon: "📊", label: "Dash",     route: "/dashboards" },
  { icon: "🔌", label: "Integ",    route: "/integrations" },
  { icon: "🤖", label: "AI",       route: "/ai" },
  { icon: "🛡",  label: "Admin",    route: "/admin" },
];

export function renderRail() {
  const root = document.getElementById("farLeftRail");
  const path = state.route || "/home";

  root.setAttribute("role", "navigation");
  root.setAttribute("aria-label", "Primary navigation");
  mount(root, [
    el("div", { class: "rail-logo", title: "FORGE", "aria-hidden": "true" }, ["FORGE"]),
    workspaceSwitcher(),
    ...ITEMS.map(item =>
      el("button", {
        class: `rail-btn ${matches(path, item.route) ? "active" : ""}`,
        title: item.label,
        "aria-current": matches(path, item.route) ? "page" : null,
        onClick: () => navigate(item.route),
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
        document.body.className = state.ui.theme === "dark" ? "theme-dark" : "theme-light";
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
  if (route === "/home") return path === "/home";
  const base = route.split("/")[1];
  return path.startsWith("/" + base);
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
