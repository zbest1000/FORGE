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
          el("div", { class: "hub-logo", "aria-hidden": "true" }, ["FORGE"]),
          el("div", { class: "stack", style: { gap: "4px" } }, [
            // Use h2 here — the page-level h1 lives in the shell header
            // (WCAG 2.4.6: avoid duplicate h1s on a single page).
            el("h2", { class: "hub-title" }, ["Welcome", me ? `, ${me.name}` : ""]),
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
          "Tip: ",
          el("kbd", {}, [isMac() ? "⌘" : "Ctrl"]), "-click a tile to open it in a new tab. ",
          "Press ", el("kbd", {}, [isMac() ? "⌘" : "Ctrl"]), " + ", el("kbd", {}, ["K"]),
          " anywhere to jump to anything.",
        ]),
        el("button", { class: "btn sm", onClick: () => navigate("/admin") }, ["Manage groups & access →"]),
      ]),
    ]),
  ]);
}

function isMac() {
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || "");
}

function portalTile(p) {
  const href = `#/home?portal=${p.id}`;
  // User-feedback fix: tiles open in the SAME tab by default. The
  // previous `target="_blank"` was disorienting — every click ripped
  // the operator out of context, away from the right side panel and
  // any in-flight selection. Cmd/Ctrl/middle-click + the browser's
  // own modifier handling on `<a href>` still open in a new tab when
  // operators want it; this just removes the implicit jump.
  return el("a", {
    class: "hub-tile",
    href,
    rel: "noopener noreferrer",
    style: {
      "--portal-accent": p.accent,
    },
    "aria-label": `Open ${p.label}`,
  }, [
    el("div", { class: "hub-tile-icon", "aria-hidden": "true" }, [p.icon]),
    el("div", { class: "hub-tile-body" }, [
      el("h3", {}, [p.label]),
      el("p", {}, [p.description]),
      el("div", { class: "hub-tile-routes" }, p.items.slice(0, 5).map(it =>
        el("span", { class: "hub-tile-chip" }, [it.label]))),
    ]),
    el("div", { class: "hub-tile-cta", "aria-hidden": "true" }, ["Open →"]),
  ]);
}
