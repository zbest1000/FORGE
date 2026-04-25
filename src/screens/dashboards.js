import { el, mount, card, badge, kpi } from "../core/ui.js";
import { state } from "../core/store.js";

export function renderDashboards() {
  const root = document.getElementById("screenContainer");
  const d = state.data;
  mount(root, [
    el("div", { class: "card-grid" }, (d.dashboards || []).map(ds => card(ds.name, el("div", { class: "stack" }, [
      el("div", { class: "row wrap" }, (ds.widgets || []).map(w => badge(w, "info"))),
      el("div", { class: "tiny muted" }, [`${ds.widgets.length} widgets · composed from events & telemetry`]),
    ])))),
    card("Workspace KPIs", el("div", { class: "card-grid" }, [
      kpi("Avg revision → approval", "3d 6h", "-1d vs last month", "up"),
      kpi("Work item cycle time", "4.2d", "-0.3d", "up"),
      kpi("Integration event success", "99.2%", "-0.1%", "down"),
      kpi("AI citation rate", "92%", "+2%", "up"),
    ])),
  ]);
}
