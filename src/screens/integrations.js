// Integration Console v2 — spec §11.9 and §9.4.
//
// Surface: per-connector health, test connection, rotate credential,
// live recent-events feed from core/events, DLQ browser with replay.

import { el, mount, card, badge, toast, modal, formRow, input, confirm } from "../core/ui.js";
import { state, update } from "../core/store.js";
import { audit } from "../core/audit.js";
import { navigate } from "../core/router.js";
import { can } from "../core/permissions.js";
import { recentEvents, listDeadLetters, replay } from "../core/events.js";

export function renderIntegrations() {
  const root = document.getElementById("screenContainer");
  const d = state.data;

  mount(root, [
    card("Mapping lifecycle", el("div", { class: "connector-lifecycle" }, [
      ...["Draft", "Validate", "Review", "Publish", "Rollback"].map((step, i) =>
        el("div", { class: "lifecycle-step" }, [
          el("span", { class: "lifecycle-index" }, [String(i + 1)]),
          el("span", {}, [step]),
        ])
      ),
    ]), { subtitle: "Use this sequence for MQTT, OPC UA, ERP, and webhook mapping changes." }),

    el("div", { class: "card-grid" }, (d.integrations || []).map(i => {
      const variant = i.status === "connected" ? "success" : i.status === "failed" ? "danger" : "warn";
      return card(i.name, el("div", { class: "stack" }, [
        el("div", { class: "row wrap" }, [
          badge(i.kind.toUpperCase(), "info"),
          badge(i.status, variant),
          el("span", { class: "tiny muted" }, [`${i.eventsPerMin}/min`]),
        ]),
        el("div", { class: "tiny muted" }, [`Last event ${new Date(i.lastEvent).toLocaleString()}`]),
        el("div", { class: "row wrap" }, [
          el("button", { class: "btn sm", disabled: !can("integration.write"), onClick: () => testConnection(i) }, ["Test"]),
          el("button", { class: "btn sm", disabled: !can("integration.write"), onClick: () => rotateCred(i) }, ["Rotate cred"]),
          i.kind === "mqtt"  ? el("button", { class: "btn sm primary", onClick: () => navigate("/integrations/mqtt") }, ["MQTT browser →"]) : null,
          i.kind === "opcua" ? el("button", { class: "btn sm primary", onClick: () => navigate("/integrations/opcua") }, ["OPC UA browser →"]) : null,
          i.kind === "erp"   ? el("button", { class: "btn sm primary", onClick: () => navigate("/integrations/erp") }, ["ERP mapping →"]) : null,
        ]),
      ]));
    })),

    card("Unified Namespace binding", el("div", { class: "stack" }, [
      el("div", { class: "small" }, ["All connectors publish into the canonical UNS and surface as i3X variables (see /uns, /i3x)."]),
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

    el("div", { class: "two-col", style: { marginTop: "16px" } }, [
      card("Recent events (normalized envelopes)", eventsPanel(), {
        subtitle: "Canonical envelope per §9.2. Click an event to view payload.",
      }),
      card("Dead-letter queue", dlqPanel(), {
        subtitle: "Replay moves a message back into the pipeline with a new trace_id.",
      }),
    ]),
  ]);
}

function testConnection(i) {
  if (!can("integration.write")) { toast("No write capability", "warn"); return; }
  update(s => {
    const item = s.data.integrations.find(x => x.id === i.id);
    if (item) { item.status = "connected"; item.lastEvent = new Date().toISOString(); }
  });
  audit("integration.test", i.id);
  toast(`${i.name}: connection OK`, "success");
}

async function rotateCred(i) {
  if (!can("integration.write")) return;
  if (!await confirm({ title: "Rotate credentials", message: `Rotate credentials for ${i.name}? Existing sessions will be re-authenticated.`, confirmLabel: "Rotate", variant: "danger" })) return;
  audit("integration.cred.rotate", i.id);
  toast(`${i.name}: credential rotated (demo)`, "success");
}

function eventsPanel() {
  const events = recentEvents(20);
  if (!events.length) return el("div", { class: "muted tiny" }, ["No events seen yet. Publish from MQTT or simulate an OPC UA node change."]);
  return el("div", { class: "stack" }, events.map(e => el("div", {
    class: "activity-row",
    onClick: () => showEvent(e),
  }, [
    badge(e.source_type.toUpperCase(), "info"),
    el("div", { class: "stack", style: { gap: "2px", flex: 1 } }, [
      el("span", { class: "small" }, [`${e.event_type}  · ${e.severity}`]),
      el("span", { class: "tiny muted" }, [`asset=${e.asset_ref || "—"} · trace=${e.trace_id}`]),
    ]),
    el("span", { class: "tiny muted mono" }, [e.event_id]),
  ])));
}

function showEvent(e) {
  modal({
    title: `Event ${e.event_id}`,
    body: el("pre", { class: "mono tiny", style: { background: "var(--panel)", padding: "12px", borderRadius: "6px", maxHeight: "60vh", overflow: "auto" } }, [JSON.stringify(e, null, 2)]),
    actions: [{ label: "Close" }],
  });
}

function dlqPanel() {
  const dlqs = listDeadLetters();
  if (!dlqs.length) return el("div", { class: "success-text" }, ["DLQ empty."]);
  return el("div", { class: "stack" }, dlqs.map(d => el("div", { class: "activity-row" }, [
    badge("DLQ", "danger"),
    el("div", { class: "stack", style: { gap: "2px", flex: 1 } }, [
      el("span", { class: "small" }, [d.envelope.event_type]),
      el("span", { class: "tiny muted" }, [`error: ${d.error}`]),
    ]),
    el("button", { class: "btn sm", disabled: !can("integration.write"), onClick: () => { replay(d.id); toast("Replayed", "success"); } }, ["Replay"]),
  ])));
}
