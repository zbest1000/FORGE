// FORGE Hub — the front door.
//
// A clean, low-density landing page that groups the app into discipline-
// specific "portals". Each tile is a real anchor link with target="_blank"
// so it opens in a new browser tab, and carries `?portal=<id>` in the hash so
// the new tab knows to render in portal-mode (filtered rail/header).

import { el, mount, badge } from "../core/ui.js";
import { state } from "../core/store.js";
import { navigate } from "../core/router.js";
import { visiblePortals, currentUser, currentRole, effectiveGroupIds, listGroups } from "../core/groups.js";

export function renderHub() {
  const root = document.getElementById("screenContainer");
  const portals = visiblePortals().filter(p => p.id !== "hub");
  const me = currentUser();
  const myGroupIds = effectiveGroupIds(me?.id);
  const groupsById = Object.fromEntries(listGroups().map(g => [g.id, g]));

  mount(root, [
    el("section", { class: "hub" }, [
      el("div", { class: "hub-hero" }, [
        el("div", { class: "hub-hero-row" }, [
          el("div", { class: "hub-logo" }, ["FORGE"]),
          el("div", { class: "stack", style: { gap: "4px" } }, [
            el("h1", { class: "hub-title" }, ["Welcome", me ? `, ${me.name}` : ""]),
            el("div", { class: "hub-sub" }, [
              "Pick a workspace to open. Each portal launches in its own browser tab so you can work on several things at once.",
            ]),
          ]),
        ]),
        el("div", { class: "hub-meta row wrap" }, [
          badge(currentRole(), "info"),
          ...myGroupIds.map(gid => badge(groupsById[gid]?.name || gid, "purple")),
          state.data?.organization?.name ? badge(state.data.organization.name, "accent") : null,
        ]),
      ]),

      el("div", { class: "hub-grid" }, portals.map(p => portalTile(p))),

      el("div", { class: "hub-footer" }, [
        el("div", { class: "tiny muted" }, [
          "Tip: hold ", el("kbd", {}, ["Cmd/Ctrl"]), " or use middle-click to open in a new tab. ",
          "Click ", el("kbd", {}, ["⌘K"]), " anywhere to jump to anything.",
        ]),
        el("button", { class: "btn sm", onClick: () => navigate("/admin") }, ["Manage groups & access →"]),
      ]),
    ]),
  ]);
}

function portalTile(p) {
  const href = `#/home?portal=${p.id}`;
  // Real anchor so cmd/ctrl-click still opens in a new tab and the URL
  // appears in the status bar. Plain click navigates in the current tab so
  // workspace continuity is preserved; modifier keys preserve the
  // multi-tab workflow that power users rely on.
  const a = el("a", {
    class: "hub-tile",
    href,
    rel: "noopener",
    style: {
      "--portal-accent": p.accent,
    },
    "aria-label": `Open ${p.label}`,
    title: `Open ${p.label} (Cmd/Ctrl-click for new tab)`,
    onClick: (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
      e.preventDefault();
      location.hash = href.replace(/^#/, "");
    },
  }, [
    el("div", { class: "hub-tile-icon", "aria-hidden": "true" }, [p.icon]),
    el("div", { class: "hub-tile-body" }, [
      el("h3", {}, [p.label]),
      el("p", {}, [p.description]),
      el("div", { class: "hub-tile-routes" }, p.items.slice(0, 5).map(it =>
        el("span", { class: "hub-tile-chip" }, [it.label]))),
    ]),
    el("div", { class: "hub-tile-cta" }, ["Open →"]),
  ]);
  return a;
}
