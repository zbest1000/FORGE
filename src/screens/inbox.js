import { el, mount, card, badge, table } from "../core/ui.js";
import { state, update } from "../core/store.js";
import { navigate } from "../core/router.js";

export function renderInbox() {
  const root = document.getElementById("screenContainer");
  const d = state.data;
  const items = (d.notifications || []);

  mount(root, [
    card("Inbox", table({
      columns: [
        { header: "Time",  render: r => el("span", { class: "mono tiny" }, [new Date(r.ts).toLocaleString()]) },
        { header: "Kind",  render: r => badge(r.kind, variantFor(r.kind)) },
        { header: "Message", key: "text" },
        { header: "", render: r => el("button", {
          class: "btn sm",
          onClick: (e) => { e.stopPropagation(); navigate(r.route); },
        }, ["Open"]) },
      ],
      rows: items,
      onRowClick: (r) => navigate(r.route),
    }), {
      subtitle: `${items.length} notifications · permission-filtered`,
      actions: [
        el("button", {
          class: "btn sm ghost",
          onClick: () => update(s => { s.data.notifications = []; }),
        }, ["Mark all read"]),
      ],
    }),
  ]);
}

function variantFor(kind) {
  switch (kind) {
    case "mention": return "info";
    case "approval": return "warn";
    case "incident": return "danger";
    case "integration": return "warn";
    default: return "";
  }
}
