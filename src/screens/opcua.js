// OPC UA Browser & Node Mapping v2 — spec §11.11 and §10 #5.
//
// Features:
//   * Endpoint session status with cert/security info
//   * Namespace browser with node tree and datatype validator
//   * Mapping editor: bind nodes to assets, transforms + unit normalization
//   * Write-node action gated to Integration Admin; confirmed via HMAC sig
//   * Simulation: trigger state_change for a bound node → event pipeline

import { el, mount, card, badge, toast, modal, formRow, input, select, textarea, prompt, dangerAction } from "../core/ui.js";
import { state, update } from "../core/store.js";
import { audit } from "../core/audit.js";
import { can } from "../core/permissions.js";
import { ingest } from "../core/events.js";
import { signHMAC, canonicalJSON } from "../core/crypto.js";

export function renderOPCUA() {
  const root = document.getElementById("screenContainer");
  const d = state.data;

  // OPC UA nodes come from the seeded data sources (kind: "node").
  const nodes = (d.dataSources || [])
    .filter(ds => ds.kind === "node")
    .map(ds => enrichNode(ds))
    // Demo seed nodes for namespace depth
    .concat(DEMO_NODES.filter(n => !d.dataSources.some(ds => ds.endpoint === n.id)));

  const selectedKey = "opcua.selected";
  const selected = sessionStorage.getItem(selectedKey) || nodes[0]?.id;

  mount(root, [
    el("div", { class: "three-col" }, [
      card("Endpoint / session", endpointPanel()),
      card("Node tree", renderNodes(nodes, selected, id => {
        sessionStorage.setItem(selectedKey, id);
        renderOPCUA();
      })),
      card("Mapping editor", mappingEditor(nodes.find(n => n.id === selected), nodes), {
        subtitle: "Bind node → asset signal + transform",
      }),
    ]),
    el("div", { class: "two-col", style: { marginTop: "16px" } }, [
      card("Simulate", el("div", { class: "stack" }, [
        el("div", { class: "tiny muted" }, ["Push a value to a node and route through the event pipeline."]),
        el("button", { class: "btn sm", onClick: () => simulate(selected, nodes) }, ["Write value"]),
        el("button", { class: "btn sm danger", disabled: !can("integration.write"), onClick: () => writeNode(selected, nodes) }, ["Write-node (privileged)"]),
      ])),
      card("AI — Semantic mapping", el("div", { class: "stack" }, [
        el("div", { class: "small" }, [
          "Nodes with similar unit + parent prefix are candidate siblings. Unit normalization recommends: convert °F → °C, psi → bar, in → mm before binding.",
        ]),
      ])),
    ]),
  ]);
}

const DEMO_NODES = [
  { id: "ns=2;s=Line.State",       dt: "Int32",  unit: "",     sampling: "250ms", assetId: null },
  { id: "ns=2;s=Feeder.A1.Speed",  dt: "Double", unit: "rpm",  sampling: "500ms", assetId: "AS-2" },
];

function enrichNode(ds) {
  const inferUnit = () => ds.endpoint.includes("Temp") ? "degC" : ds.endpoint.includes("Current") ? "A" : ds.endpoint.includes("Steam.P") ? "bar" : "";
  return {
    id: ds.endpoint,
    dt: "Double",
    unit: inferUnit(),
    sampling: "1s",
    assetId: ds.assetId,
  };
}

function endpointPanel() {
  return el("div", { class: "stack" }, [
    el("div", { class: "mono small" }, ["opc.tcp://plc.north-plant.local:4840"]),
    el("div", { class: "row wrap" }, [
      badge("Session: active", "success"),
      badge("Cert: valid", "success"),
      badge("Security: Basic256Sha256", "info"),
      badge("Mode: Client", "accent"),
    ]),
    el("div", { class: "tiny muted" }, ["Client/server mode (spec §9.1). Namespace browsing + semantic model support."]),
  ]);
}

function renderNodes(nodes, selected, onSelect) {
  return el("div", { class: "stack", style: { gap: "2px" } }, nodes.map(n => el("button", {
    type: "button",
    class: `tree-item ${n.id === selected ? "active" : ""}`,
    onClick: () => onSelect(n.id),
  }, [
    el("span", { class: "tree-dot" }),
    el("span", { class: "mono tiny" }, [n.id]),
    badge(n.dt, "info"),
    n.assetId ? badge("→ " + n.assetId, "accent") : badge("unmapped", "warn"),
  ])));
}

function mappingEditor(node, nodes) {
  if (!node) return el("div", { class: "muted" }, ["Select a node."]);
  const assets = state.data.assets.map(a => ({ value: a.id, label: a.name }));
  const assetPick = select([{ value: "", label: "(unmap)" }, ...assets], { value: node.assetId || "" });
  const unitPick = select([
    { value: "", label: "(as-is)" }, "degC", "degF→degC", "bar", "psi→bar", "A", "rpm", "mm", "in→mm",
  ], { value: node.unit || "" });
  const samplingPick = select(["100ms", "250ms", "500ms", "1s", "5s"], { value: node.sampling || "1s" });

  return el("div", { class: "stack" }, [
    el("div", { class: "mono tiny" }, [node.id]),
    formRow("Bind to asset", assetPick),
    formRow("Unit / transform", unitPick),
    formRow("Sampling", samplingPick),
    el("div", { class: "row" }, [
      el("button", { class: "btn sm primary", disabled: !can("integration.write"), onClick: () => save(node, assetPick.value, unitPick.value, samplingPick.value) }, ["Save mapping"]),
      el("button", { class: "btn sm", onClick: () => validate(node, unitPick.value) }, ["Validate"]),
    ]),
  ]);
}

function save(node, assetId, unit, sampling) {
  update(s => {
    const ds = (s.data.dataSources || []).find(x => x.endpoint === node.id);
    if (ds) {
      ds.assetId = assetId || null;
      ds.unit = unit;
      ds.sampling = sampling;
    } else {
      s.data.dataSources.push({
        id: "DS-" + Math.floor(Math.random() * 9000 + 1000),
        integrationId: "INT-OPCUA",
        endpoint: node.id,
        assetId: assetId || null,
        unit,
        sampling,
        kind: "node",
      });
    }
  });
  audit("opcua.mapping.update", node.id, { assetId, unit, sampling });
  toast("Mapping saved", "success");
}

function validate(node, transform) {
  const ok = node.dt === "Double" || node.dt === "Float" || !transform.includes("→");
  audit("opcua.mapping.validate", node.id, { transform, ok });
  toast(ok ? "Validation passed" : "Datatype incompatible with transform", ok ? "success" : "warn");
}

async function simulate(nodeId, nodes) {
  const n = nodes.find(x => x.id === nodeId);
  if (!n) return;
  const raw = await prompt({
    title: `Simulate value for ${n.id}`,
    label: "Value",
    defaultValue: "101.2",
    helpText: `Unit: ${n.unit || "(unknown)"}. Routed through the event pipeline as a state_change.`,
    validate: (v) => Number.isNaN(Number(v)) ? "Must be a number" : null,
  });
  if (raw == null) return;
  const val = Number(raw);
  const env = ingest({
    event_type: "state_change",
    severity: "info",
    asset_ref: n.assetId || null,
    payload: { nodeId: n.id, value: val, unit: n.unit },
    dedupe_key: `opcua:${n.id}:${Date.now()}`,
  }, { source: n.id, source_type: "opcua" });
  audit("opcua.simulate", n.id, { value: val, event: env?.event_id });
  toast("State change routed to asset timeline", "success");
}

async function writeNode(nodeId, nodes) {
  const n = nodes.find(x => x.id === nodeId);
  if (!n) return;
  if (!can("integration.write")) return;
  const val = await prompt({
    title: `Privileged write to ${n.id}`,
    label: "Value",
    defaultValue: "0",
    helpText: `This writes to a live OPC UA node. The change is HMAC-signed and recorded in the audit ledger before any value is applied.`,
  });
  if (val == null) return;
  const ok = await dangerAction({
    title: "Confirm OPC UA write",
    message: `Write the value below to ${n.id}? The action will be signed and audited.`,
    body: el("dl", { class: "forbidden-detail" }, [
      el("dt", {}, ["Node"]), el("dd", {}, [n.id]),
      el("dt", {}, ["Value"]), el("dd", {}, [String(val)]),
      el("dt", {}, ["Bound asset"]), el("dd", {}, [n.assetId || "(unmapped)"]),
      el("dt", {}, ["Actor"]), el("dd", {}, [state.ui.role]),
    ]),
    confirmLabel: "Sign & write",
    details: "Signature is HMAC-SHA256 over the canonical payload (node, value, actor, timestamp).",
  });
  if (!ok) return;
  const sig = await signHMAC(canonicalJSON({ nodeId: n.id, value: val, actor: state.ui.role, ts: new Date().toISOString() }));
  audit("opcua.write", n.id, { value: val, signature: sig.signature.slice(0, 12), keyId: sig.keyId });
  toast(`Write accepted · keyId ${sig.keyId} · sig ${sig.signature.slice(0,8)}…`, "success");
}
