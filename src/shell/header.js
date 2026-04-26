import { el, mount, select } from "../core/ui.js";
import { state, update, resetState } from "../core/store.js";
import { ROLES } from "../core/permissions.js";
import { openPalette } from "../core/palette.js";
import { navigate } from "../core/router.js";
import { mode as apiMode, login as apiLogin, logout as apiLogout } from "../core/api.js";
import { modal, formRow, input, toast } from "../core/ui.js";
import { portalById, effectiveGroupIds, currentUserId, isOrgOwner } from "../core/groups.js";

function viewerHasIT() {
  if (isOrgOwner()) return true;
  return effectiveGroupIds(currentUserId()).includes("G-it");
}

const TITLES = {
  "/hub":         { title: "FORGE Hub",        crumb: "Hub" },
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
    onChange: (e) => update(s => { s.ui.role = e.target.value; s.ui.roleOverridden = true; }),
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

  const portal = state.ui.portalId ? portalById(state.ui.portalId) : null;
  if (portal) {
    root.style.setProperty("--portal-accent", portal.accent);
  } else {
    root.style.removeProperty("--portal-accent");
  }

  mount(root, [
    el("div", { class: "header-title" }, [
      el("div", { class: "breadcrumb" }, [
        state.data?.organization?.name || "", " / ",
        state.data?.workspace?.name || "", " / ",
        meta.crumb,
      ]),
      el("div", { class: "row", style: { gap: "10px", alignItems: "center" } }, [
        el("h1", {}, [meta.title]),
        portal ? el("span", { class: "header-portal-chip", style: { "--portal-accent": portal.accent } }, [
          el("span", { class: "chip-emoji", "aria-hidden": "true" }, [portal.icon]),
          portal.label,
        ]) : null,
      ]),
    ]),
    el("div", { class: "header-controls" }, [
      searchInput,
      notifyBell(),
      contextToggleBtn(),
      viewerHasIT() ? serverBadge() : authOnlyBadge(),
      el("button", { class: "btn sm", onClick: openPalette, title: "Command palette" }, ["⌘K"]),
      viewMenu(),
      roleSelect,
      el("button", {
        class: "btn sm ghost",
        title: "Reset demo data",
        onClick: () => confirmReset(),
      }, ["Reset"]),
    ]),
  ]);
}

async function confirmReset() {
  const { dangerAction } = await import("../core/ui.js");
  const ok = await dangerAction({
    title: "Reset local demo data?",
    message: "This clears your local demo state (drafts, comments, mappings, audit chain). The server-side database is not affected.",
    confirmLabel: "Reset",
  });
  if (ok) resetState();
}

function contextToggleBtn() {
  const open = !!state.ui.showContextPanel;
  return el("button", {
    class: `btn sm ${open ? "primary" : ""}`,
    title: open ? "Hide details panel" : "Show details panel",
    "aria-pressed": String(open),
    onClick: () => {
      sessionStorage.setItem("forge.contextPanelTouched", "1");
      update(s => { s.ui.showContextPanel = !s.ui.showContextPanel; });
    },
  }, ["Details"]);
}

function notifyBell() {
  const d = state.data || {};
  const items = [];
  (d.incidents || []).filter(i => i.status === "active").forEach(i =>
    items.push({ dot: "danger", text: `${i.id} · ${i.title}`, route: `/incident/${i.id}` })
  );
  (d.integrations || []).filter(i => i.status !== "connected").forEach(i =>
    items.push({ dot: i.status === "failed" ? "danger" : "warn",
      text: `${i.kind.toUpperCase()} · ${i.name} · ${i.status}`, route: `/integrations` })
  );
  (d.approvals || []).filter(a => a.status === "pending").forEach(a =>
    items.push({ dot: "warn",
      text: `Approval pending · ${a.id}`, route: `/approvals` })
  );

  const wrap = el("span", { class: "notify-wrap" });
  let pop = null;
  const close = () => {
    if (pop) { pop.remove(); pop = null; }
    document.removeEventListener("mousedown", onDoc, true);
  };
  const onDoc = (e) => { if (pop && !pop.contains(e.target) && !wrap.contains(e.target)) close(); };

  const btn = el("button", {
    class: "btn sm notify-btn",
    title: items.length ? `${items.length} active alerts` : "No active alerts",
    "aria-haspopup": "true",
    "aria-expanded": "false",
    "aria-label": items.length ? `Open notifications (${items.length})` : "Open notifications",
    onClick: (e) => {
      e.stopPropagation();
      if (pop) { close(); return; }
      pop = el("div", { class: "notify-popover", role: "menu" }, [
        el("div", { class: "notify-popover-header" }, [
          el("span", {}, ["Operations"]),
          el("span", { class: "tiny" }, [items.length ? `${items.length} active` : "All clear"]),
        ]),
        items.length
          ? el("div", { class: "dock-items" }, items.map(it =>
              el("button", {
                class: "dock-item",
                onClick: () => { close(); navigate(it.route); },
              }, [
                el("span", { class: `dock-dot ${it.dot}` }),
                el("span", {}, [it.text]),
              ])
            ))
          : el("div", { class: "dock-empty tiny" }, ["No active incidents, pending approvals, or integration failures."]),
      ]);
      wrap.append(pop);
      btn.setAttribute("aria-expanded", "true");
      setTimeout(() => document.addEventListener("mousedown", onDoc, true), 0);
    },
  }, ["🔔"]);
  if (items.length) {
    btn.append(el("span", { class: "notify-count" }, [String(items.length)]));
  }
  wrap.append(btn);
  return wrap;
}

function viewMenu() {
  const wrap = el("span", { class: "view-menu" });
  let open = false;
  let pop = null;

  const close = () => {
    open = false;
    if (pop) { pop.remove(); pop = null; }
    document.removeEventListener("mousedown", onDocClick, true);
  };
  const onDocClick = (e) => {
    if (pop && !pop.contains(e.target) && !wrap.contains(e.target)) close();
  };

  const toggle = (key) => {
    update(s => { s.ui[key] = !s.ui[key]; });
  };
  const row = (key, label) => el("label", { class: "vm-row" }, [
    el("span", {}, [label]),
    el("input", { type: "checkbox", checked: !!state.ui[key], onChange: () => toggle(key) }),
  ]);

  const button = el("button", {
    class: "btn sm",
    title: "View options — show/hide panels",
    onClick: (e) => {
      e.stopPropagation();
      if (open) { close(); return; }
      open = true;
      pop = el("div", { class: "view-menu-popover", role: "menu" }, [
        el("div", { class: "vm-title" }, ["Layout"]),
        row("showRail",         "Far-left rail"),
        row("showLeftPanel",    "Left navigator"),
        row("showContextPanel", "Right context panel"),
        row("showHeader",       "Page header"),
        el("div", { class: "vm-divider" }),
        el("div", { class: "vm-title" }, ["Quick modes"]),
        el("button", {
          class: "btn sm vm-row",
          onClick: () => { update(s => { s.ui.focusMode = !s.ui.focusMode; }); },
        }, [state.ui.focusMode ? "Exit focus mode" : "Focus mode (hide side panels)"]),
        el("button", {
          class: "btn sm vm-row",
          onClick: () => { update(s => { s.ui.fieldMode = !s.ui.fieldMode; }); },
        }, [state.ui.fieldMode ? "Exit field mode" : "Field mode (touch-first)"]),
        el("button", {
          class: "btn sm vm-row",
          onClick: () => {
            update(s => {
              s.ui.showRail = true; s.ui.showLeftPanel = true; s.ui.showContextPanel = true;
              s.ui.showHeader = true; s.ui.focusMode = false;
            });
          },
        }, ["Reset to default layout"]),
        el("button", {
          class: "btn sm vm-row",
          onClick: () => {
            update(s => {
              s.ui.showRail = false; s.ui.showLeftPanel = false; s.ui.showContextPanel = false;
              s.ui.showHeader = false; s.ui.focusMode = true; s.ui.dockVisible = false;
            });
            toast("Maximized — press the rail toggle in the corner to restore", "info");
          },
        }, ["Maximize (full screen)"]),
        el("div", { class: "vm-divider" }),
        el("button", {
          class: "btn sm vm-row",
          onClick: () => { update(s => { s.ui.dockVisible = !s.ui.dockVisible; }); },
        }, [state.ui.dockVisible ? "Hide ops dock" : "Show ops dock"]),
        el("button", {
          class: "btn sm vm-row",
          onClick: () => { update(s => { s.ui.theme = s.ui.theme === "dark" ? "light" : "dark"; }); },
        }, ["Toggle theme"]),
      ]);
      wrap.append(pop);
      // Close after any item action.
      pop.querySelectorAll("button").forEach(b => b.addEventListener("click", () => setTimeout(close, 50)));
      setTimeout(() => document.addEventListener("mousedown", onDocClick, true), 0);
    },
  }, ["View ▾"]);

  wrap.append(button);
  return wrap;
}

function authOnlyBadge() {
  // Non-IT users still need a way to sign in/out — show a minimal pill
  // without the green "● connected" indicator that exposes server status.
  const m = apiMode();
  if (m !== "server") return null;
  const user = state.server?.user;
  if (user) {
    return el("button", { class: "btn sm", onClick: () => signOut(), title: `Signed in as ${user.email}` }, [
      (user.name || user.email),
    ]);
  }
  return el("button", { class: "btn sm", onClick: () => signIn(), title: "Sign in" }, ["Sign in"]);
}

function serverBadge() {
  const m = apiMode();
  if (m === "server") {
    const user = state.server?.user;
    return el("button", {
      class: "btn sm",
      title: user ? `Signed in as ${user.email}` : "Server connected — sign in",
      onClick: user ? () => signOut() : () => signIn(),
    }, [user ? "● " + (user.name || user.email) : "● Sign in"]);
  }
  return el("span", { class: "badge", title: "No backend detected — running in local demo mode" }, ["demo mode"]);
}

function signIn() {
  const emailInput = input({ placeholder: "email", value: "admin@forge.local" });
  const pwInput = input({ type: "password", placeholder: "password", value: "forge" });
  modal({
    title: "Sign in to FORGE",
    body: el("div", { class: "stack" }, [
      el("div", { class: "tiny muted" }, ["Demo users are seeded with password `forge`. Admin: admin@forge.local"]),
      formRow("Email", emailInput),
      formRow("Password", pwInput),
    ]),
    actions: [
      { label: "Cancel" },
      { label: "Sign in", variant: "primary", onClick: async () => {
        try {
          const user = await apiLogin(emailInput.value.trim(), pwInput.value);
          state.server = { ...(state.server || {}), user };
          if (user?.role) {
            update(s => { s.ui.role = user.role; s.ui.roleOverridden = false; });
          }
          toast("Signed in as " + (user.name || user.email), "success");
          renderHeader();
        } catch (e) {
          toast("Login failed: " + e.message, "danger");
        }
      } },
    ],
  });
}

function signOut() {
  apiLogout();
  state.server = { ...(state.server || {}), user: null };
  state.ui.roleOverridden = false;
  toast("Signed out", "info");
  renderHeader();
}

function resolveTitle(route) {
  route = (route || "").split("?")[0];
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
