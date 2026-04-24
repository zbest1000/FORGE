import { el, mount, card, badge } from "../core/ui.js";
import { state } from "../core/store.js";

export function renderOPCUA() {
  const root = document.getElementById("screenContainer");
  const d = state.data;
  const sources = (d.dataSources || []).filter(ds => ds.kind === "node");

  const nodes = [
    { id: "ns=2;s=HX01.Temp",       dt: "Double",   unit: "degC", sampling: "1s", assetId: "AS-1" },
    { id: "ns=2;s=Feeder.A1.Current", dt: "Double", unit: "A",    sampling: "500ms", assetId: "AS-2" },
    { id: "ns=2;s=B201.Steam.P",    dt: "Double",   unit: "bar",  sampling: "1s", assetId: "AS-4" },
    { id: "ns=2;s=Line.State",      dt: "Int32",    unit: "",     sampling: "250ms", assetId: null },
  ];

  mount(root, [
    el("div", { class: "three-col" }, [
      card("Endpoint / session", el("div", { class: "stack" }, [
        el("div", { class: "mono small" }, ["opc.tcp://plc.north-plant.local:4840"]),
        el("div", { class: "row wrap" }, [
          badge("Session: active", "success"),
          badge("Cert: valid", "success"),
          badge("Sec policy: Basic256Sha256", "info"),
        ]),
      ])),
      card("Node tree", el("div", { class: "stack" }, nodes.map(n => el("div", { class: "tree-item" }, [
        el("span", { class: "tree-dot" }),
        el("span", { class: "mono tiny" }, [n.id]),
        badge(n.dt, "info"),
      ])))),
      card("Mapping editor", el("div", { class: "stack" }, nodes.map(n => el("div", { class: "activity-row" }, [
        el("span", { class: "mono tiny" }, [n.id]),
        el("span", { class: "tiny muted" }, [`${n.dt} ${n.unit || ""} · ${n.sampling}`]),
        n.assetId ? badge("→ " + n.assetId, "accent") : badge("unmapped", "warn"),
      ])))),
    ]),
    el("div", { style: { marginTop: "16px" } }, [
      card("AI — Semantic mapping", el("div", { class: "stack" }, [
        el("div", { class: "small" }, ["Node 'Line.State' has no asset binding but shares prefix with Line.A1 nodes. Suggest binding to Line A area."]),
      ])),
    ]),
  ]);
}
