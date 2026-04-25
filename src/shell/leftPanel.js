import { el, mount, clickable } from "../core/ui.js";
import { state } from "../core/store.js";
import { navigate } from "../core/router.js";
import { openPalette } from "../core/palette.js";
import { canSeeAsset } from "../core/groups.js";

export function renderLeftPanel() {
  const root = document.getElementById("leftPanel");
  const d = state.data || {};
  const activeRoute = state.route || "";

  const treeSections = [
    section("Team Spaces", d.teamSpaces || [], ts => ({
      route: `/team-space/${ts.id}`,
      label: ts.name,
    })),
    section("Channels", d.channels || [], c => ({
      route: `/channel/${c.id}`,
      label: `# ${c.name}`,
      unread: c.unread > 0,
      badge: c.unread > 0 ? String(c.unread) : null,
    })),
    section("Projects", d.projects || [], p => ({
      route: `/work-board/${p.id}`,
      label: p.name,
    })),
    section("Docs", d.documents || [], doc => ({
      route: `/doc/${doc.id}`,
      label: doc.name,
    })),
    section("Drawings", d.drawings || [], dr => ({
      route: `/drawing/${dr.id}`,
      label: dr.name,
    })),
    section("Assets", (d.assets || []).filter(canSeeAsset), a => ({
      route: `/asset/${a.id}`,
      label: a.name,
      unread: a.status === "alarm" || a.status === "warning",
    })),
  ];

  mount(root, [
    el("div", { class: "panel-header" }, [
      el("div", {}, [
        el("div", { class: "strong" }, [d.workspace?.name || "Workspace"]),
        el("div", { class: "tiny muted" }, [d.organization?.name || ""]),
      ]),
      el("button", {
        class: "btn sm ghost",
        title: "Command palette (⌘K)",
        onClick: () => openPalette(),
      }, ["⌘K"]),
    ]),
    el("div", { class: "row" }, [
      el("button", { class: "btn sm primary", onClick: () => navigate("/work-board/PRJ-1") }, ["+ Work item"]),
      el("button", { class: "btn sm", onClick: () => navigate("/incident/INC-4412") }, ["+ Incident"]),
    ]),
    ...treeSections,
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
