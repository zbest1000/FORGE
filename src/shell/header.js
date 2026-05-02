import { el, mount, select, confirm } from "../core/ui.js";
import { state, update, resetState } from "../core/store.js";
import { openPalette } from "../core/palette.js";
import { navigate } from "../core/router.js";
import { mode as apiMode, login as apiLogin, logout as apiLogout } from "../core/api.js";
import { modal, formRow, input, toast } from "../core/ui.js";
import { portalById, effectiveGroupIds, currentUserId, isOrgOwner } from "../core/groups.js";
import { license as currentLicense, licenseBanner } from "../core/license.js";

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
  "/work":        { title: "Activity",         crumb: "Activity" },
  "/docs":        { title: "Documents",        crumb: "Docs" },
  "/drawings":    { title: "Drawings",         crumb: "Drawings" },
  "/assets":      { title: "Assets",           crumb: "Assets" },
  "/dashboards":  { title: "Dashboards",       crumb: "Dashboards" },
  "/integrations":{ title: "Integrations",     crumb: "Integrations" },
  "/ai":          { title: "AI Workspace",     crumb: "AI" },
  "/admin":       { title: "Admin Governance", crumb: "Admin" },
  "/incidents":   { title: "Incidents",        crumb: "Incidents" },
  "/approvals":   { title: "Approval Queue",   crumb: "Approvals" },
  "/operations":  { title: "Operations Data",  crumb: "Ops Data" },
  "/audit":       { title: "Audit ledger",     crumb: "Audit" },
  "/edit":        { title: "Edit document",    crumb: "Edit" },
  "/spec":        { title: "Product Spec Reference", crumb: "Spec" },
  "/uns":         { title: "Unified Namespace", crumb: "UNS" },
  "/i3x":         { title: "i3X API Workbench", crumb: "i3X" },
};

export function renderHeader() {
  const root = document.getElementById("mainHeader");
  const route = state.route || "/home";
  const meta = resolveTitle(route);

  // Single "Acting as" picker — replaces the old role dropdown.
  // It drives BOTH `state.data.currentUserId` (group gating) and
  // `state.ui.role` (capability gating) so the two can never disagree.
  // Also offers an "Override role" sub-affordance for users who need to
  // test what a different role would see for the same identity.
  const users = state.data?.users || [];
  const me = currentUserId();
  const actingAsSelect = select(
    users.map(u => ({ value: u.id, label: `${u.name} — ${u.role}` })),
    {
      value: me || "",
      "aria-label": "Acting as user",
      onChange: (e) => {
        const u = users.find(x => x.id === e.target.value);
        update(s => {
          s.data.currentUserId = e.target.value;
          if (u && u.role) s.ui.role = u.role;
        });
        toast(`Now acting as ${u?.name || e.target.value}`, "info");
      },
    }
  );

  const searchInput = el("input", {
    class: "search-input",
    type: "search",
    placeholder: "Search or jump (⌘K)",
    "aria-label": "Search",
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

  syncDocumentTitle(meta, portal);

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
      connectivityPill(),
      viewerHasIT() ? serverBadge() : authOnlyBadge(),
      el("button", { class: "btn sm", onClick: openPalette, title: "Command palette", "aria-label": "Open command palette" }, ["⌘K"]),
      viewMenu(),
      el("label", { class: "header-acting", title: "Acting as a user — drives group access and role" }, [
        el("span", { class: "tiny muted", "aria-hidden": "true" }, ["Acting as"]),
        actingAsSelect,
      ]),
      el("button", {
        class: "btn sm ghost",
        title: "Reset demo data",
        onClick: async () => { if (await confirm({ title: "Reset demo data", message: "Reset all local demo data? This cannot be undone.", confirmLabel: "Reset", variant: "danger" })) resetState(); },
      }, ["Reset"]),
    ]),
    licenseBanner(),
  ]);
}

// Stable id for aria-controls so toggling between menu instances keeps the
// relationship intact across re-renders.
const VIEW_MENU_ID = "viewMenuPopover";

function viewMenu() {
  const wrap = el("span", { class: "view-menu" });
  let open = false;
  let pop = null;
  let trigger = null;

  const close = () => {
    open = false;
    if (pop) { pop.remove(); pop = null; }
    if (trigger) {
      trigger.setAttribute("aria-expanded", "false");
      try { trigger.focus(); } catch {}
    }
    document.removeEventListener("mousedown", onDocClick, true);
    document.removeEventListener("keydown", onDocKey, true);
  };
  const onDocClick = (e) => {
    if (pop && !pop.contains(e.target) && !wrap.contains(e.target)) close();
  };
  const onDocKey = (e) => {
    if (e.key === "Escape" && open) { e.preventDefault(); close(); }
  };

  const toggle = (key) => {
    update(s => { s.ui[key] = !s.ui[key]; });
  };
  const row = (key, label) => {
    const cb = el("input", { type: "checkbox", checked: !!state.ui[key], onChange: () => toggle(key) });
    cb.id = `vm-${key}`;
    return el("label", { class: "vm-row", htmlFor: cb.id }, [
      el("span", {}, [label]),
      cb,
    ]);
  };

  trigger = el("button", {
    class: "btn sm",
    title: "View options — show/hide panels",
    "aria-haspopup": "dialog",
    "aria-expanded": "false",
    "aria-controls": VIEW_MENU_ID,
    onClick: (e) => {
      e.stopPropagation();
      if (open) { close(); return; }
      open = true;
      trigger.setAttribute("aria-expanded", "true");
      pop = el("div", {
        class: "view-menu-popover",
        id: VIEW_MENU_ID,
        role: "dialog",
        "aria-label": "View options",
      }, [
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
            toast("Maximized — press the restore button in the corner to bring chrome back", "info");
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
      setTimeout(() => {
        document.addEventListener("mousedown", onDocClick, true);
        document.addEventListener("keydown", onDocKey, true);
        // Move focus into the popover so Escape and Tab are intuitive.
        const first = pop.querySelector("input, button");
        if (first) try { first.focus(); } catch {}
      }, 0);
    },
  }, ["View ▾"]);

  wrap.append(trigger);
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

/**
 * Neutral connectivity pill — visible to every user. Shows just whether
 * we're online/offline and whether queued writes exist. Doesn't expose
 * server identity, version, host, or anything IT-only.
 */
function connectivityPill() {
  const online = navigator.onLine !== false;
  const m = apiMode();
  let label, variant, title;
  if (!online) {
    label = "Offline"; variant = "warn-text"; title = "No network — writes will be queued.";
  } else if (m === "server") {
    label = "Online"; variant = "success-text"; title = "Network connection ok.";
  } else {
    label = "Local"; variant = "muted"; title = "Running in local demo mode (no backend).";
  }
  return el("span", {
    class: "connectivity-pill " + variant,
    title,
    role: "status",
    "aria-label": `Connectivity: ${label}. ${title}`,
  }, [
    el("span", { class: "connectivity-dot " + variant, "aria-hidden": "true" }),
    label,
  ]);
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
          update(s => {
            s.server = { ...(s.server || {}), user };
            if (user?.role) {
              s.ui.role = user.role;
              s.ui.roleOverridden = false;
            }
          });
          toast("Signed in as " + (user.name || user.email), "success");
        } catch (e) {
          toast("Sign-in failed: " + e.message, "danger");
        }
      } },
    ],
  });
}

function signOut() {
  apiLogout();
  update(s => {
    s.server = { ...(s.server || {}), user: null };
    s.ui.roleOverridden = false;
  });
  toast("Signed out", "info");
}

function resolveTitle(route) {
  route = (route || "").split("?")[0];
  if (TITLES[route]) return TITLES[route];
  const base = "/" + route.split("/")[1];
  if (TITLES[base]) return TITLES[base];

  // Object routes — try to resolve the entity by id and use its name in
  // both the page heading and the breadcrumb (and ultimately document.title).
  const d = state.data || {};
  const id = route.split("/")[2];
  const findById = (coll) => (d[coll] || []).find(x => x.id === id);

  if (route.startsWith("/team-space/")) {
    const t = findById("teamSpaces");
    return { title: t?.name || "Team Space", crumb: t?.name || "Team Space" };
  }
  if (route.startsWith("/channel/")) {
    const c = findById("channels");
    return { title: c ? `# ${c.name}` : "Channel", crumb: c ? `# ${c.name}` : "Channel" };
  }
  if (route.startsWith("/work-board/")) {
    const p = findById("projects");
    return { title: p?.name || "Work Board", crumb: p?.name || "Work Board" };
  }
  if (route.startsWith("/doc/")) {
    const doc = findById("documents");
    return { title: doc?.name || "Document", crumb: doc?.name || "Document" };
  }
  if (route.startsWith("/compare/"))    return { title: "Revision Compare", crumb: "Compare" };
  if (route.startsWith("/drawing/")) {
    const dr = findById("drawings");
    return { title: dr?.name || "Drawing", crumb: dr?.name || "Drawing" };
  }
  if (route.startsWith("/asset/")) {
    const a = findById("assets");
    return { title: a?.name || "Asset", crumb: a?.name || "Asset" };
  }
  if (route.startsWith("/incident/")) {
    const inc = findById("incidents");
    return { title: inc ? `${inc.id} · ${inc.title}` : "Incident War Room", crumb: inc?.title || "Incident" };
  }
  return { title: "FORGE", crumb: "" };
}

/**
 * Update `document.title` so each tab is identifiable in the browser
 * tab strip, history, and bookmarks. Format: `<page> · <portal?> · FORGE`.
 */
function syncDocumentTitle(meta, portal) {
  const parts = [meta.title || "FORGE"];
  if (portal) parts.push(portal.label);
  if (parts[parts.length - 1] !== "FORGE") parts.push("FORGE");
  document.title = parts.join(" · ");
}
