// Integration Console v2 — spec §11.9 and §9.4.
//
// Surface: per-connector health, test connection, rotate credential,
// live recent-events feed from core/events, DLQ browser with replay.
//
// CRUD: operators with `integration.write` can add / edit / delete the
// connectors that this org publishes through. Delete is refused while
// any data source references the connector (cascading-delete is more
// destructive than the demo wants to model). All mutations audit and
// fire through `update()` so the SSE/event bus picks them up.

import { el, mount, card, badge, toast, modal, formRow, input, select, textarea, confirm } from "../core/ui.js";
import { state, update } from "../core/store.js";
import { audit } from "../core/audit.js";
import { navigate } from "../core/router.js";
import { can } from "../core/permissions.js";
import { recentEvents, listDeadLetters, replay } from "../core/events.js";

// Connector kinds the editor offers. Keep in sync with
// `src/screens/home.js::integrationHealth` and the kind-specific
// browser routes (`/integrations/mqtt`, `/integrations/opcua`, ...).
const KIND_OPTIONS = [
  { value: "mqtt",    label: "MQTT broker"      },
  { value: "opcua",   label: "OPC UA endpoint"  },
  { value: "modbus",  label: "Modbus TCP gateway" },
  { value: "sql",     label: "SQL historian"    },
  { value: "erp",     label: "ERP system"       },
  { value: "rest",    label: "REST / Webhook"   },
];

// Default endpoint hints per kind — used as placeholder text in the
// editor so operators don't have to remember scheme conventions.
const ENDPOINT_PLACEHOLDERS = {
  mqtt:   "tls://broker.example.com:8883",
  opcua:  "opc.tcp://opc.example.com:4840",
  modbus: "10.20.4.12:502",
  sql:    "mssql://host:1433/historian",
  erp:    "https://erp.example.com/api",
  rest:   "https://hooks.example.com/v1",
};

export function renderIntegrations() {
  const root = document.getElementById("screenContainer");
  const d = state.data;
  const writable = can("integration.write");

  mount(root, [
    el("div", { class: "row wrap", style: { justifyContent: "space-between", alignItems: "flex-start", marginBottom: "12px" } }, [
      el("div", { class: "stack", style: { gap: "2px" } }, [
        el("h2", { style: { margin: "0" } }, ["Integrations"]),
        el("div", { class: "tiny muted" }, [
          "Connectors that publish into the canonical UNS. Audit at /admin/audit.",
        ]),
      ]),
      el("button", {
        class: "btn primary",
        disabled: !writable,
        title: writable ? "Add a new connector" : "Requires integration.write capability",
        onClick: () => openIntegrationEditor(null),
      }, ["+ New integration"]),
    ]),

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
      const referenceCount = countReferences(i.id);
      return card(i.name, el("div", { class: "stack" }, [
        el("div", { class: "row wrap" }, [
          badge(i.kind.toUpperCase(), "info"),
          badge(i.status, variant),
          el("span", { class: "tiny muted" }, [`${i.eventsPerMin}/min`]),
          referenceCount > 0
            ? el("span", { class: "tiny muted", title: `${referenceCount} data source(s) bound to this connector` },
                [`· ${referenceCount} binding${referenceCount === 1 ? "" : "s"}`])
            : null,
        ]),
        i.endpoint
          ? el("div", { class: "tiny muted mono", title: "Endpoint" }, [i.endpoint])
          : el("div", { class: "tiny muted" }, ["No endpoint configured — Edit to add."]),
        i.description ? el("div", { class: "small" }, [i.description]) : null,
        el("div", { class: "tiny muted" }, [`Last event ${new Date(i.lastEvent).toLocaleString()}`]),
        el("div", { class: "row wrap" }, [
          el("button", { class: "btn sm", disabled: !writable, onClick: () => openIntegrationEditor(i) }, ["Edit"]),
          el("button", { class: "btn sm", disabled: !writable, onClick: () => testConnection(i) }, ["Test"]),
          el("button", { class: "btn sm", disabled: !writable, onClick: () => rotateCred(i) }, ["Rotate cred"]),
          el("button", {
            class: "btn sm danger",
            disabled: !writable || referenceCount > 0,
            title: referenceCount > 0 ? `Cannot delete — ${referenceCount} binding(s) reference this connector` : "Delete connector",
            onClick: () => deleteIntegration(i),
          }, ["Delete"]),
          i.kind === "mqtt"  ? el("button", { class: "btn sm primary", onClick: () => navigate("/integrations/mqtt") }, ["MQTT browser →"]) : null,
          i.kind === "opcua" ? el("button", { class: "btn sm primary", onClick: () => navigate("/integrations/opcua") }, ["OPC UA browser →"]) : null,
          i.kind === "modbus" ? el("button", { class: "btn sm primary", onClick: () => navigate("/operations") }, ["Historian & Modbus →"]) : null,
          i.kind === "erp"   ? el("button", { class: "btn sm primary", onClick: () => navigate("/integrations/erp") }, ["ERP mapping →"]) : null,
        ]),
      ]));
    })),

    card("Interoperability binding", el("div", { class: "stack" }, [
      el("div", { class: "small" }, ["All connectors publish into the canonical UNS and surface as i3X variables (see /uns, /i3x)."]),
      el("div", { class: "row wrap" }, [
        badge("urn:cesmii:isa95:1", "purple"),
        badge("urn:forge:signals:1", "accent"),
        badge("urn:atlas:workspace:1", "info"),
      ]),
      el("div", { class: "row" }, [
        el("button", { class: "btn sm", onClick: () => navigate("/uns") }, ["Open UNS browser →"]),
        el("button", { class: "btn sm", onClick: () => navigate("/i3x") }, ["Open i3X API →"]),
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

// ---------------------------------------------------------------------------
// CRUD helpers

function countReferences(integrationId) {
  const d = state.data || {};
  return (d.dataSources || []).filter(ds => ds.integrationId === integrationId).length;
}

/**
 * Open the integration editor modal. `existing` may be null (create) or an
 * integration object (edit). Save dispatches through `update()` so any open
 * subscriber rerenders, and writes an audit event.
 */
function openIntegrationEditor(existing) {
  if (!can("integration.write")) { toast("No write capability", "warn"); return; }

  const isNew = !existing;
  const draft = {
    id: existing?.id || `INT-${cryptoSafeId()}`,
    name: existing?.name || "",
    kind: existing?.kind || "mqtt",
    endpoint: existing?.endpoint || "",
    description: existing?.description || "",
    credentialRef: existing?.credentialRef || "",
    status: existing?.status || "idle",
    eventsPerMin: existing?.eventsPerMin ?? 0,
    lastEvent: existing?.lastEvent || new Date().toISOString(),
  };

  const nameInput = input({ value: draft.name, placeholder: "e.g. MQTT broker — Site 1" });
  const kindSelect = select(KIND_OPTIONS, { value: draft.kind });
  const endpointInput = input({ value: draft.endpoint, placeholder: ENDPOINT_PLACEHOLDERS[draft.kind] });
  // Recompute the placeholder when the kind changes so operators always see
  // a kind-appropriate hint without having to clear the field.
  kindSelect.addEventListener("change", () => {
    endpointInput.placeholder = ENDPOINT_PLACEHOLDERS[/** @type {HTMLSelectElement} */ (kindSelect).value] || "";
  });
  const credInput = input({
    value: draft.credentialRef,
    placeholder: "Credential reference (e.g. vault://forge/mqtt-prod) — never the secret itself",
  });
  const descInput = textarea({
    value: draft.description,
    rows: 2,
    placeholder: "Optional — what this connector is used for, owner team, etc.",
  });

  const errEl = el("div", { class: "small danger-text", style: { display: "none", marginTop: "8px" } }, [""]);

  const save = () => {
    const name = String(/** @type {HTMLInputElement} */ (nameInput).value || "").trim();
    const kind = String(/** @type {HTMLSelectElement} */ (kindSelect).value || "");
    const endpoint = String(/** @type {HTMLInputElement} */ (endpointInput).value || "").trim();
    const credentialRef = String(/** @type {HTMLInputElement} */ (credInput).value || "").trim();
    const description = String(/** @type {HTMLTextAreaElement} */ (descInput).value || "").trim();

    if (!name) { showError("Name is required."); return false; }
    if (!KIND_OPTIONS.find(k => k.value === kind)) { showError("Pick a connector kind."); return false; }
    // Reject obvious "I pasted a password into the wrong field" mistakes.
    if (/password=|secret=|apikey=/i.test(credentialRef)) {
      showError("Credential reference should be a vault path, not the secret itself.");
      return false;
    }

    update(s => {
      const list = s.data.integrations || (s.data.integrations = []);
      if (isNew) {
        list.push({ ...draft, name, kind, endpoint, credentialRef, description });
      } else {
        const idx = list.findIndex(x => x.id === draft.id);
        if (idx === -1) {
          list.push({ ...draft, name, kind, endpoint, credentialRef, description });
        } else {
          list[idx] = { ...list[idx], name, kind, endpoint, credentialRef, description };
        }
      }
    });

    audit(isNew ? "integration.create" : "integration.update", draft.id, {
      name, kind, endpoint, hasCredential: Boolean(credentialRef),
    });
    toast(`${name}: ${isNew ? "added" : "updated"}`, "success");
    return true;
  };

  function showError(msg) {
    errEl.textContent = msg;
    /** @type {HTMLElement} */ (errEl).style.display = "block";
  }

  modal({
    title: isNew ? "New integration" : `Edit ${draft.name}`,
    body: el("div", { class: "stack" }, [
      formRow("Name",         nameInput),
      formRow("Kind",         kindSelect),
      formRow("Endpoint",     endpointInput),
      formRow("Credential ref", credInput),
      formRow("Description",  descInput),
      el("div", { class: "tiny muted" }, [
        "Credential references point at the secret store; they are never logged. ",
        "Use ", el("code", {}, ["Rotate cred"]), " on the connector card to swap secrets.",
      ]),
      errEl,
    ]),
    actions: [
      { label: "Cancel" },
      { label: isNew ? "Create" : "Save", variant: "primary", onClick: save },
    ],
  });
}

async function deleteIntegration(i) {
  if (!can("integration.write")) { toast("No write capability", "warn"); return; }
  const refs = countReferences(i.id);
  if (refs > 0) {
    toast(`Cannot delete — ${refs} data source(s) still reference ${i.name}`, "warn");
    return;
  }
  const ok = await confirm({
    title: "Delete integration",
    message: `Delete ${i.name}? This is recorded in the audit ledger and cannot be reversed from this UI.`,
    confirmLabel: "Delete",
    variant: "danger",
  });
  if (!ok) return;
  update(s => {
    s.data.integrations = (s.data.integrations || []).filter(x => x.id !== i.id);
  });
  audit("integration.delete", i.id, { name: i.name, kind: i.kind });
  toast(`${i.name}: deleted`, "success");
}

// Stable-ish id without pulling in a UUID lib. crypto.randomUUID exists in
// every browser FORGE supports plus Node 19+; the Math.random branch is the
// fallback for older runtimes / test stubs.
function cryptoSafeId() {
  try {
    /** @type {any} */ const c = (typeof crypto !== "undefined") ? crypto : null;
    if (c && typeof c.randomUUID === "function") return c.randomUUID().slice(0, 8).toUpperCase();
  } catch { /* fall through */ }
  return Math.random().toString(36).slice(2, 10).toUpperCase();
}

// ---------------------------------------------------------------------------
// Existing operations

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
