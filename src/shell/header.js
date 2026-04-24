import { el, mount, select } from "../core/ui.js";
import { state, update, resetState } from "../core/store.js";
import { ROLES } from "../core/permissions.js";
import { openPalette } from "../core/palette.js";
import { navigate } from "../core/router.js";

const TITLES = {
  "/home":        { title: "Workspace Home",   crumb: "Home" },
  "/inbox":       { title: "Inbox",            crumb: "Inbox" },
  "/search":      { title: "Search",           crumb: "Search" },
  "/team-spaces": { title: "Team Spaces",      crumb: "Team Spaces" },
  "/projects":    { title: "Projects",         crumb: "Projects" },
  "/docs":        { title: "Documents",        crumb: "Docs" },
  "/drawings":    { title: "Drawings",         crumb: "Drawings" },
  "/assets":      { title: "Assets",           crumb: "Assets" },
  "/dashboards":  { title: "Dashboards",       crumb: "Dashboards" },
  "/integrations":{ title: "Integrations",     crumb: "Integrations" },
  "/ai":          { title: "AI Workspace",     crumb: "AI" },
  "/admin":       { title: "Admin Governance", crumb: "Admin" },
  "/incidents":   { title: "Incidents",        crumb: "Incidents" },
  "/approvals":   { title: "Approval Queue",   crumb: "Approvals" },
  "/spec":        { title: "Product Spec Reference", crumb: "Spec" },
  "/uns":         { title: "Unified Namespace", crumb: "UNS" },
  "/i3x":         { title: "i3X API Explorer",  crumb: "i3X" },
};

export function renderHeader() {
  const root = document.getElementById("mainHeader");
  const route = state.route || "/home";
  const meta = resolveTitle(route);

  const roleSelect = select(ROLES, {
    value: state.ui.role,
    onChange: (e) => update(s => { s.ui.role = e.target.value; }),
  });

  const searchInput = el("input", {
    class: "search-input",
    placeholder: "Search or jump (⌘K)",
    onKeydown: (e) => {
      if (e.key === "Enter" && e.target.value.trim()) {
        const q = encodeURIComponent(e.target.value.trim());
        navigate(`/search?q=${q}`);
      }
    },
  });

  mount(root, [
    el("div", { class: "header-title" }, [
      el("div", { class: "breadcrumb" }, [
        state.data?.organization?.name || "", " / ",
        state.data?.workspace?.name || "", " / ",
        meta.crumb,
      ]),
      el("h1", {}, [meta.title]),
    ]),
    el("div", { class: "header-controls" }, [
      searchInput,
      el("button", { class: "btn sm", onClick: openPalette, title: "Command palette" }, ["⌘K"]),
      roleSelect,
      el("button", {
        class: "btn sm ghost",
        title: "Reset demo data",
        onClick: () => { if (window.confirm("Reset local demo data?")) resetState(); },
      }, ["Reset"]),
    ]),
  ]);
}

function resolveTitle(route) {
  if (TITLES[route]) return TITLES[route];
  const base = "/" + route.split("/")[1];
  if (TITLES[base]) return TITLES[base];
  // Object routes
  if (route.startsWith("/team-space/")) return { title: "Team Space", crumb: "Team Space" };
  if (route.startsWith("/channel/"))    return { title: "Channel", crumb: "Channel" };
  if (route.startsWith("/work-board/")) return { title: "Work Board", crumb: "Work Board" };
  if (route.startsWith("/doc/"))        return { title: "Document", crumb: "Document" };
  if (route.startsWith("/compare/"))    return { title: "Revision Compare", crumb: "Compare" };
  if (route.startsWith("/drawing/"))    return { title: "Drawing", crumb: "Drawing" };
  if (route.startsWith("/asset/"))      return { title: "Asset", crumb: "Asset" };
  if (route.startsWith("/incident/"))   return { title: "Incident War Room", crumb: "Incident" };
  return { title: "FORGE", crumb: "" };
}
