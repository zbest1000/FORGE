import { el, mount, card, badge } from "../core/ui.js";

export function renderERP() {
  const root = document.getElementById("screenContainer");
  const mappings = [
    { erp: "PurchaseOrder", forge: "WorkItem(RFI)",   status: "in-sync", lastSync: "2 min ago", conflicts: 0 },
    { erp: "WorkOrder",     forge: "WorkItem(Task)",  status: "drift",   lastSync: "15 min ago", conflicts: 2 },
    { erp: "InventoryItem", forge: "Asset",           status: "in-sync", lastSync: "30 min ago", conflicts: 0 },
    { erp: "CostCenter",    forge: "TeamSpace",       status: "conflict",lastSync: "1 hr ago",   conflicts: 3 },
  ];

  mount(root, [
    card("ERP mapping matrix", el("table", { class: "table" }, [
      el("thead", {}, [el("tr", {}, ["ERP entity","FORGE entity","Status","Last sync","Conflicts",""].map(h => el("th", {}, [h])))]),
      el("tbody", {}, mappings.map(m =>
        el("tr", {}, [
          el("td", { class: "mono" }, [m.erp]),
          el("td", { class: "mono" }, [m.forge]),
          el("td", {}, [badge(m.status, m.status === "in-sync" ? "success" : m.status === "conflict" ? "danger" : "warn")]),
          el("td", { class: "tiny muted" }, [m.lastSync]),
          el("td", {}, [m.conflicts ? badge(String(m.conflicts), "warn") : "—"]),
          el("td", {}, [el("button", { class: "btn sm" }, ["Resolve"])]),
        ])
      )),
    ])),
    el("div", { style: { marginTop: "16px" } }, [
      card("AI — Drift diagnosis", el("div", { class: "stack" }, [
        el("div", { class: "small" }, ["WorkOrder drift: 2 ERP work orders created in last 15m were not auto-mapped. Pattern: external vendor PO prefix missing from rule set."]),
      ])),
    ]),
  ]);
}
