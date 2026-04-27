import { el, mount, clickable } from "../core/ui.js";
import { state } from "../core/store.js";
import { navigate } from "../core/router.js";
import { effectiveGroupIds, currentUserId, isOrgOwner } from "../core/groups.js";

function viewerCanSeeIntegrations() {
  if (isOrgOwner()) return true;
  const eff = new Set(effectiveGroupIds(currentUserId()));
  return ["G-it","G-automation","G-erp"].some(id => eff.has(id));
}

export function renderDock() {
  const root = document.getElementById("operationsDock");
  const visible = !!state.ui.dockVisible;
  root.classList.toggle("hidden", !visible);
  if (!visible) return;

  const d = state.data || {};
  const items = [];

  (d.incidents || []).filter(i => i.status === "active").forEach(i =>
    items.push({
      dot: "danger",
      text: `${i.id} · ${i.title}`,
      route: `/incident/${i.id}`,
    })
  );

  if (viewerCanSeeIntegrations()) {
    (d.integrations || []).forEach(i => {
      if (i.status === "connected") return;
      items.push({
        dot: i.status === "failed" ? "danger" : "warn",
        text: `${i.kind.toUpperCase()} · ${i.name} · ${i.status}`,
        route: `/integrations`,
      });
    });
  }

  (d.approvals || []).filter(a => a.status === "pending").forEach(a =>
    items.push({
      dot: "warn",
      text: `Approval pending · ${a.id} · ${a.subject.kind} ${a.subject.id}`,
      route: `/approvals`,
    })
  );

  if (!items.length) items.push({ dot: "ok", text: "All systems nominal", route: "/home" });

  mount(root, [
    el("div", { class: "dock-title" }, ["Operations Dock"]),
    el("div", { class: "dock-items", role: "list" }, items.map(it => {
      const node = el("div", {
        class: "dock-item",
        onClick: () => navigate(it.route),
        role: "listitem",
      }, [
        el("span", { class: `dock-dot ${it.dot}`, "aria-hidden": "true" }),
        el("span", {}, [it.text]),
      ]);
      clickable(node, () => navigate(it.route), { label: it.text });
      return node;
    })),
  ]);
}
