import { el, mount } from "../core/ui.js";
import { state, update } from "../core/store.js";
import { navigate } from "../core/router.js";

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

  mount(root, [
    el("div", { class: "rail-logo", title: "FORGE" }, ["FORGE"]),
    ...ITEMS.map(item =>
      el("button", {
        class: `rail-btn ${matches(path, item.route) ? "active" : ""}`,
        title: item.label,
        onClick: () => navigate(item.route),
      }, [
        el("span", { class: "rail-icon" }, [item.icon]),
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
