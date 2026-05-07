import { el, mount, card, badge, table, emptyState } from "../core/ui.js";
import { state, update } from "../core/store.js";
import { navigate } from "../core/router.js";
import { helpHint, helpLinkChip } from "../core/help.js";

export function renderInbox() {
  const root = document.getElementById("screenContainer");
  const d = state.data;
  const items = (d.notifications || []);

  mount(root, [
    el("div", { style: { marginBottom: "12px" } }, [
      el("h2", { style: { display: "inline-flex", alignItems: "center", margin: 0, fontSize: "18px" } }, [
        "Inbox", helpHint("forge.inbox"),
      ]),
      el("div", { class: "tiny muted" }, ["Mentions, approvals, incidents, and follow notifications converge here."]),
      el("div", { class: "row wrap", style: { gap: "6px", marginTop: "6px" } }, [
        helpLinkChip("forge.inbox", "Inbox"),
        helpLinkChip("forge.channels.mentions", "@-mentions"),
        helpLinkChip("forge.approvals", "Approvals"),
      ]),
    ]),
    items.length === 0
      ? emptyState({
          icon: "📬",
          title: "Your inbox is clear",
          message: "@-mentions, approval requests, incident pings, and follow notifications all land here. You'll see them as they come in.",
          action: { label: "Browse approvals", variant: "", onClick: () => navigate("/approvals") },
        })
      : card("Inbox", table({
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
