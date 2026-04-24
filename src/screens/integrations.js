import { el, mount, card, badge, toast } from "../core/ui.js";
import { state, update, getById, audit } from "../core/store.js";
import { navigate } from "../core/router.js";
import { can } from "../core/permissions.js";

export function renderIntegrations() {
  const root = document.getElementById("screenContainer");
  const d = state.data;
  mount(root, [
    el("div", { class: "card-grid" }, (d.integrations || []).map(i => {
      const variant = i.status === "connected" ? "success" : i.status === "failed" ? "danger" : "warn";
      return card(i.name, el("div", { class: "stack" }, [
        el("div", { class: "row wrap" }, [
          badge(i.kind.toUpperCase(), "info"),
          badge(i.status, variant),
          el("span", { class: "tiny muted" }, [`${i.eventsPerMin}/min`]),
        ]),
        el("div", { class: "tiny muted" }, [`Last event ${new Date(i.lastEvent).toLocaleString()}`]),
        el("div", { class: "row" }, [
          el("button", { class: "btn sm", disabled: !can("integration.write"), onClick: () => testConnection(i) }, ["Test"]),
          el("button", { class: "btn sm", disabled: !can("integration.write"), onClick: () => replay(i) }, ["Replay"]),
          i.kind === "mqtt" ? el("button", { class: "btn sm primary", onClick: () => navigate("/integrations/mqtt") }, ["MQTT browser →"]) : null,
          i.kind === "opcua" ? el("button", { class: "btn sm primary", onClick: () => navigate("/integrations/opcua") }, ["OPC UA browser →"]) : null,
          i.kind === "erp" ? el("button", { class: "btn sm primary", onClick: () => navigate("/integrations/erp") }, ["ERP mapping →"]) : null,
        ]),
      ]));
    })),
    card("Unified Namespace binding", el("div", { class: "stack" }, [
      el("div", { class: "small" }, ["All connectors publish into the canonical UNS and surface as i3X variables."]),
      el("div", { class: "row wrap" }, [
        badge("urn:cesmii:isa95:1", "purple"),
        badge("urn:forge:signals:1", "accent"),
        badge("urn:atlas:workspace:1", "info"),
      ]),
      el("div", { class: "row" }, [
        el("button", { class: "btn sm", onClick: () => navigate("/uns") }, ["Open UNS browser →"]),
        el("button", { class: "btn sm", onClick: () => navigate("/i3x") }, ["Open i3X Explorer →"]),
      ]),
    ])),
    card("Dead-letter queue (mock)", el("div", { class: "stack" }, [
      (d.integrations || []).filter(i => i.status === "failed").map(i =>
        el("div", { class: "activity-row" }, [
          badge("DLQ", "danger"),
          el("span", {}, [i.name]),
          el("span", { class: "tiny muted" }, ["3 messages pending retry"]),
        ])
      ),
    ])),
  ]);
}

function testConnection(i) {
  if (!can("integration.write")) { toast("No write capability", "warn"); return; }
  update(s => {
    const item = s.data.integrations.find(x => x.id === i.id);
    if (item) {
      item.status = "connected";
      item.lastEvent = new Date().toISOString();
    }
  });
  audit("integration.test", i.id);
  toast(`${i.name}: connection OK`, "success");
}

function replay(i) {
  if (!can("integration.write")) return;
  audit("integration.replay", i.id);
  toast(`Replayed 3 messages for ${i.name}`, "info");
}
