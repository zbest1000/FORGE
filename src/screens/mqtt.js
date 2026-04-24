import { el, mount, card, badge, toast } from "../core/ui.js";
import { state, update, audit } from "../core/store.js";
import { can } from "../core/permissions.js";

export function renderMQTT() {
  const root = document.getElementById("screenContainer");
  const d = state.data;
  const sources = (d.dataSources || []).filter(ds => ds.kind === "topic");

  const tree = buildTree(sources.map(s => s.endpoint));

  mount(root, [
    el("div", { class: "three-col" }, [
      card("Topic tree", renderTree(tree)),
      card("Payload inspector", payload()),
      card("Mapping rules", el("div", { class: "stack" }, [
        ...sources.map(ds => el("div", { class: "activity-row" }, [
          badge(`QoS ${Math.floor(Math.random()*2)}`, "info"),
          el("span", { class: "mono small" }, [ds.endpoint]),
          el("span", { class: "tiny muted" }, [ds.assetId ? "→ " + ds.assetId : "unmapped"]),
        ])),
        el("button", { class: "btn sm primary", disabled: !can("integration.write"), onClick: () => addRule() }, ["+ Mapping rule"]),
      ])),
    ]),
    el("div", { style: { marginTop: "16px" } }, [
      card("AI — Taxonomy suggestions", el("div", { class: "stack" }, [
        el("div", { class: "small" }, ["Namespace 'line/a1/alarm/*' is consistent; consider standardizing 'line/a1/feeder/*' topics to include asset ID suffix."]),
        el("div", { class: "tiny muted" }, ["Citations: DS-1, DS-2"]),
      ])),
    ]),
  ]);
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

function renderTree(node, prefix = "") {
  const wrap = el("div", { class: "stack", style: { gap: "2px" } });
  Object.keys(node).forEach(k => {
    const children = node[k];
    const hasChildren = Object.keys(children).length;
    wrap.append(
      el("div", { class: "tree-item" }, [
        el("span", { class: "tree-dot" }),
        el("span", { class: "tree-label mono small" }, [prefix ? `${prefix}/${k}` : k]),
        hasChildren ? el("span", { class: "tree-count" }, [String(Object.keys(children).length)]) : null,
      ])
    );
    if (hasChildren) {
      wrap.append(el("div", { style: { paddingLeft: "16px" } }, [renderTree(children, prefix ? `${prefix}/${k}` : k)]));
    }
  });
  return wrap;
}

function payload() {
  return el("pre", { class: "mono tiny", style: { background: "var(--panel)", padding: "12px", borderRadius: "6px", overflow: "auto" } }, [
`{
  "topic": "line/a1/alarm/high-temp",
  "qos": 1,
  "retain": false,
  "ts": "${new Date().toISOString()}",
  "payload": {
    "asset": "HX-01",
    "value": 112.3,
    "unit": "degC",
    "threshold": 105
  }
}`
  ]);
}

function addRule() {
  const topic = window.prompt("Topic pattern (e.g. line/a1/#):");
  if (!topic) return;
  const assetId = window.prompt("Bind to asset ID (e.g. AS-1), leave empty to skip:") || null;
  update(s => {
    s.data.dataSources.push({
      id: "DS-" + Math.floor(Math.random()*9000+1000),
      integrationId: "INT-MQTT",
      endpoint: topic,
      assetId,
      kind: "topic",
    });
  });
  audit("mqtt.mapping.create", topic, { assetId });
  toast("Mapping rule added", "success");
}
