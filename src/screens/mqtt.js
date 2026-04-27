// MQTT Topic Browser & Mapping v2 — spec §11.10.
//
// Features:
//   * Topic tree from seeded data sources + any added mappings
//   * Payload inspector (live simulated payloads per topic)
//   * Mapping rules panel with add/edit/delete and simulation
//   * Publish test with QoS, retain flag
//   * Namespace policy checker (naming convention validation)

import { el, mount, card, badge, toast, input, select, formRow, modal, textarea, confirm } from "../core/ui.js";
import { state, update } from "../core/store.js";
import { audit } from "../core/audit.js";
import { can } from "../core/permissions.js";
import { ingest } from "../core/events.js";
import { vendor } from "../core/vendor.js";

let _mqttClient = null;
let _mqttStatus = "disconnected";

export function renderMQTT() {
  const root = document.getElementById("screenContainer");
  const d = state.data;
  const sources = (d.dataSources || []).filter(ds => ds.kind === "topic");
  const selectedKey = "mqtt.selected";
  const selected = sessionStorage.getItem(selectedKey) || sources[0]?.endpoint || null;

  const tree = buildTree(sources.map(s => s.endpoint));

  mount(root, [
    brokerPanel(),
    el("div", { class: "three-col" }, [
      card("Topic tree", renderTree(tree, "", selected, (topic) => {
        sessionStorage.setItem(selectedKey, topic);
        renderMQTT();
      })),
      card("Payload inspector", payloadInspector(selected, sources), {
        actions: [
          el("button", { class: "btn sm", onClick: () => publishTest(selected) }, ["Publish test"]),
        ],
      }),
      card("Mapping rules", mappingRules(sources), {
        actions: [el("button", { class: "btn sm primary", disabled: !can("integration.write"), onClick: addRule }, ["+ Rule"])],
      }),
    ]),
    el("div", { class: "two-col", style: { marginTop: "16px" } }, [
      card("Namespace policy checker", namespaceChecker(sources), {
        subtitle: "Expect segments: site/area/line/cell/equipment/signal",
      }),
      card("AI — Taxonomy suggestions", el("div", { class: "stack" }, [
        el("div", { class: "small" }, [
          "Topics with >5 segments considered valid ISA-95 paths; `#` wildcards flagged for namespace review.",
        ]),
        el("div", { class: "tiny muted" }, ["Citations: ", sources.slice(0, 3).map(s => s.id).join(", ")]),
      ])),
    ]),
  ]);
}

function brokerPanel() {
  const urlInput = input({
    value: sessionStorage.getItem("mqtt.url") || "wss://test.mosquitto.org:8081/mqtt",
    placeholder: "wss://broker.example:8083/mqtt",
  });
  const topicInput = input({
    value: sessionStorage.getItem("mqtt.sub") || "forge/demo/#",
    placeholder: "topic filter to subscribe",
  });
  const status = el("span", {}, [badge(_mqttStatus, _mqttStatus === "connected" ? "success" : _mqttStatus === "connecting" ? "warn" : "")]);

  async function connect() {
    if (!can("integration.write")) { toast("Requires Integration Admin", "warn"); return; }
    sessionStorage.setItem("mqtt.url", urlInput.value);
    sessionStorage.setItem("mqtt.sub", topicInput.value);
    try {
      const mqtt = await vendor.mqtt();
      if (!mqtt) { toast("MQTT.js unavailable; using simulator only", "warn"); return; }
      if (_mqttClient) { try { _mqttClient.end(true); } catch {} _mqttClient = null; }
      _mqttStatus = "connecting"; renderMQTT();
      const client = mqtt.connect(urlInput.value, { connectTimeout: 5000, reconnectPeriod: 0 });
      _mqttClient = client;
      client.on("connect", () => {
        _mqttStatus = "connected";
        client.subscribe(topicInput.value, { qos: 1 }, (err) => {
          if (err) toast("Subscribe error: " + err.message, "danger");
          else toast(`Connected · subscribed ${topicInput.value}`, "success");
          audit("mqtt.broker.connect", urlInput.value, { topic: topicInput.value });
          renderMQTT();
        });
      });
      client.on("message", (topic, payload) => {
        let body = payload.toString();
        try { body = JSON.parse(body); } catch { /* keep as string */ }
        ingest({
          event_type: /alarm/i.test(topic) ? "alarm" : "telemetry",
          severity: /alarm/i.test(topic) ? "SEV-3" : "info",
          asset_ref: null,
          payload: body,
          dedupe_key: `mqtt:${topic}:${Date.now()}`,
        }, { source: topic, source_type: "mqtt" });
      });
      client.on("error", (err) => {
        _mqttStatus = "error";
        toast("MQTT error: " + err.message, "danger");
        audit("mqtt.broker.error", urlInput.value, { error: String(err.message) });
        renderMQTT();
      });
      client.on("close", () => { _mqttStatus = "disconnected"; renderMQTT(); });
    } catch (e) {
      toast("Failed: " + e.message, "danger");
    }
  }

  function disconnect() {
    if (_mqttClient) { try { _mqttClient.end(true); } catch {} _mqttClient = null; }
    _mqttStatus = "disconnected";
    audit("mqtt.broker.disconnect", "");
    renderMQTT();
  }

  return card("Live broker (MQTT.js)", el("div", { class: "stack" }, [
    el("div", { class: "row wrap" }, [
      formRow("WS URL", urlInput),
      formRow("Subscribe", topicInput),
    ]),
    el("div", { class: "row" }, [
      el("button", { class: "btn sm primary", onClick: connect }, ["Connect"]),
      el("button", { class: "btn sm", onClick: disconnect }, ["Disconnect"]),
      status,
    ]),
    el("div", { class: "tiny muted" }, [
      "Uses MQTT.js (MIT). Any incoming message is normalized through the canonical event envelope (§9.2) and routed by the rule engine. Try a public test broker or point at your EMQX/Mosquitto instance.",
    ]),
  ]), { subtitle: "Real WebSocket client — failures fall back to the local simulator below." });
}

function buildTree(paths) {
  const root = {};
  paths.forEach(p => {
    const parts = p.split("/").filter(Boolean);
    let cur = root;
    for (const part of parts) {
      cur[part] = cur[part] || {};
      cur = cur[part];
    }
  });
  return root;
}

function renderTree(node, prefix, selected, onSelect) {
  const wrap = el("div", { class: "stack", style: { gap: "2px" } });
  Object.keys(node).forEach(k => {
    const child = node[k];
    const hasChildren = Object.keys(child).length;
    const full = prefix ? `${prefix}/${k}` : k;
    wrap.append(el("button", {
    type: "button",
    class: `tree-item ${full === selected ? "active" : ""}`,
      onClick: () => onSelect(full),
    }, [
      el("span", { class: "tree-dot" }),
      el("span", { class: "tree-label mono small" }, [k]),
      hasChildren ? el("span", { class: "tree-count" }, [String(Object.keys(child).length)]) : null,
    ]));
    if (hasChildren) {
      wrap.append(el("div", { style: { paddingLeft: "16px" } }, [renderTree(child, full, selected, onSelect)]));
    }
  });
  return wrap;
}

function payloadInspector(topic, sources) {
  const ds = sources.find(s => s.endpoint === topic);
  const qos = ds?.qos ?? 1;
  const retain = ds?.retain ?? false;
  const body = {
    topic,
    qos,
    retain,
    ts: new Date().toISOString(),
    payload: simulatePayload(topic),
  };
  return el("pre", { class: "mono tiny", style: {
    background: "var(--panel)", padding: "12px", borderRadius: "6px", overflow: "auto", maxHeight: "320px",
  }}, [JSON.stringify(body, null, 2)]);
}

function simulatePayload(topic) {
  if (!topic) return null;
  if (/alarm|high-temp|trip/i.test(topic)) return { active: true, threshold: 105, value: 112.3, unit: "degC" };
  if (/temp/i.test(topic)) return { value: 72 + Math.random() * 10, unit: "degC" };
  if (/current/i.test(topic)) return { value: 40 + Math.random() * 20, unit: "A" };
  if (/press/i.test(topic)) return { value: 10 + Math.random() * 2, unit: "bar" };
  return { value: Math.random() };
}

function mappingRules(sources) {
  return el("div", { class: "stack" }, [
    ...sources.map(ds => el("div", { class: "activity-row" }, [
      badge(`QoS ${ds.qos ?? 1}`, "info"),
      el("span", { class: "mono small", style: { flex: 1 } }, [ds.endpoint]),
      el("span", { class: "tiny muted" }, [ds.assetId ? "→ " + ds.assetId : "unmapped"]),
      el("button", { class: "btn sm", disabled: !can("integration.write"), onClick: () => editRule(ds) }, ["Edit"]),
      el("button", { class: "btn sm danger", disabled: !can("integration.write"), onClick: () => deleteRule(ds) }, ["×"]),
    ])),
  ]);
}

function addRule() {
  const topic = input({ placeholder: "e.g. line/a1/#" });
  const assetIds = state.data.assets.map(a => ({ value: a.id, label: a.name }));
  const assetPick = select([{ value: "", label: "(no asset)" }, ...assetIds]);
  const qosPick = select([0, 1, 2], { value: 1 });
  const retainPick = select(["false", "true"]);
  modal({
    title: "Add mapping rule",
    body: el("div", { class: "stack" }, [
      formRow("Topic pattern", topic),
      formRow("Bind to asset", assetPick),
      formRow("QoS", qosPick),
      formRow("Retained", retainPick),
    ]),
    actions: [
      { label: "Cancel" },
      { label: "Add", variant: "primary", onClick: () => {
        const t = topic.value.trim();
        if (!t) { toast("Topic required", "warn"); return false; }
        update(s => {
          s.data.dataSources.push({
            id: "DS-" + Math.floor(Math.random()*9000+1000),
            integrationId: "INT-MQTT",
            endpoint: t,
            assetId: assetPick.value || null,
            kind: "topic",
            qos: Number(qosPick.value),
            retain: retainPick.value === "true",
          });
        });
        audit("mqtt.mapping.create", t, { assetId: assetPick.value, qos: qosPick.value });
        toast("Mapping added", "success");
      }},
    ],
  });
}

function editRule(ds) {
  const assetIds = state.data.assets.map(a => ({ value: a.id, label: a.name }));
  const assetPick = select([{ value: "", label: "(no asset)" }, ...assetIds], { value: ds.assetId || "" });
  const qosPick = select([0, 1, 2], { value: String(ds.qos ?? 1) });
  const retainPick = select(["false", "true"], { value: String(ds.retain || false) });
  modal({
    title: `Edit ${ds.endpoint}`,
    body: el("div", { class: "stack" }, [
      formRow("Bind to asset", assetPick),
      formRow("QoS", qosPick),
      formRow("Retained", retainPick),
    ]),
    actions: [
      { label: "Cancel" },
      { label: "Save", variant: "primary", onClick: () => {
        update(s => {
          const x = s.data.dataSources.find(y => y.id === ds.id);
          if (!x) return;
          x.assetId = assetPick.value || null;
          x.qos = Number(qosPick.value);
          x.retain = retainPick.value === "true";
        });
        audit("mqtt.mapping.update", ds.endpoint, { assetId: assetPick.value });
      }},
    ],
  });
}

async function deleteRule(ds) {
  if (!await confirm({ title: "Delete mapping", message: `Delete mapping for ${ds.endpoint}?`, confirmLabel: "Delete", variant: "danger" })) return;
  update(s => { s.data.dataSources = s.data.dataSources.filter(y => y.id !== ds.id); });
  audit("mqtt.mapping.delete", ds.endpoint);
}

function publishTest(topic) {
  if (!topic) { toast("Select a topic first", "warn"); return; }
  if (!can("integration.write")) { toast("Publish requires Integration Admin", "warn"); return; }
  const payload = textarea({ value: JSON.stringify(simulatePayload(topic), null, 2) });
  const qos = select([0, 1, 2], { value: "1" });
  const sev = select(["info", "SEV-3", "SEV-2", "SEV-1"], { value: /alarm/i.test(topic) ? "SEV-2" : "info" });
  modal({
    title: `Publish to ${topic}`,
    body: el("div", { class: "stack" }, [
      formRow("Payload (JSON)", payload),
      formRow("QoS", qos),
      formRow("Severity", sev),
    ]),
    actions: [
      { label: "Cancel" },
      { label: "Publish", variant: "primary", onClick: () => {
        let body = {};
        try { body = JSON.parse(payload.value); } catch (e) { toast("Invalid JSON", "danger"); return false; }
        const ds = (state.data.dataSources || []).find(x => x.endpoint === topic);
        const env = ingest({
          event_type: /alarm/i.test(topic) ? "alarm" : "telemetry",
          severity: sev.value,
          asset_ref: ds?.assetId || null,
          payload: body,
          dedupe_key: `mqtt:${topic}:${Date.now()}`,
        }, { source: topic, source_type: "mqtt" });
        audit("mqtt.publish", topic, { qos: qos.value, sev: sev.value, event: env?.event_id });
        toast("Published (event routed)", "success");
      }},
    ],
  });
}

function namespaceChecker(sources) {
  const issues = [];
  for (const ds of sources) {
    const parts = ds.endpoint.split("/").filter(Boolean);
    if (parts.some(p => p === "#" || p === "+")) issues.push({ ds, reason: "wildcard in name" });
    if (parts.length < 3) issues.push({ ds, reason: "too shallow (<3 segments)" });
    if (!ds.assetId) issues.push({ ds, reason: "unmapped (no asset)" });
  }
  if (!issues.length) return el("div", { class: "small success-text" }, ["All topics conform to the policy."]);
  return el("div", { class: "stack" }, issues.map(i => el("div", { class: "activity-row" }, [
    badge("issue", "warn"),
    el("span", { class: "mono small" }, [i.ds.endpoint]),
    el("span", { class: "tiny muted" }, [i.reason]),
  ])));
}
