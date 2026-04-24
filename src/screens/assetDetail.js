import { el, mount, card, badge, kpi, toast, chip } from "../core/ui.js";
import { state, update, getById, audit } from "../core/store.js";
import { navigate } from "../core/router.js";
import { can } from "../core/permissions.js";
import { getServer } from "../core/i3x/client.js";

export function renderAssetsIndex() {
  const root = document.getElementById("screenContainer");
  const d = state.data;
  mount(root, [
    card("Assets", el("table", { class: "table" }, [
      el("thead", {}, [el("tr", {}, ["Asset","Hierarchy","Type","Status",""].map(h => el("th", {}, [h])))]),
      el("tbody", {}, (d.assets || []).map(a =>
        el("tr", { class: "row-clickable", onClick: () => navigate(`/asset/${a.id}`) }, [
          el("td", {}, [a.name, el("div", { class: "tiny muted" }, [a.id])]),
          el("td", { class: "tiny muted" }, [a.hierarchy]),
          el("td", {}, [badge(a.type, "info")]),
          el("td", {}, [badge(a.status.toUpperCase(), statusVariant(a.status))]),
          el("td", {}, [el("button", { class: "btn sm", onClick: (e) => { e.stopPropagation(); navigate(`/asset/${a.id}`); } }, ["Open"])]),
        ])
      )),
    ])),
  ]);
}

export function renderAssetDetail({ id }) {
  const root = document.getElementById("screenContainer");
  const d = state.data;
  const a = getById("assets", id);
  if (!a) return mount(root, el("div", { class: "muted" }, ["Asset not found."]));

  const linkedDocs = (d.documents || []).filter(doc => a.docIds?.includes(doc.id));
  const dataSources = (d.dataSources || []).filter(ds => ds.assetId === a.id);
  const incidents = (d.incidents || []).filter(i => i.assetId === a.id);
  const tasks = (d.workItems || []).filter(w => (w.description || "").includes(a.id));

  mount(root, [
    el("div", { class: "row spread", style: { marginBottom: "12px" } }, [
      el("div", {}, [
        el("div", { class: "strong" }, [a.name]),
        el("div", { class: "tiny muted" }, [a.hierarchy, " · ", a.id]),
      ]),
      el("div", { class: "row" }, [
        badge(a.status.toUpperCase(), statusVariant(a.status)),
        el("button", { class: "btn sm danger", disabled: !can("incident.respond"), onClick: () => openWarRoom(a) }, ["🚨 War room"]),
      ]),
    ]),
    el("div", { class: "card-grid" }, [
      kpi("MQTT topics", (a.mqttTopics || []).length, "", ""),
      kpi("OPC UA nodes", (a.opcuaNodes || []).length, "", ""),
      kpi("Linked docs", linkedDocs.length, "", ""),
      kpi("Open incidents", incidents.filter(i => i.status === "active").length, "", incidents.some(i => i.status === "active") ? "down" : "up"),
    ]),

    unsCard(a),

    el("div", { class: "two-col", style: { marginTop: "16px" } }, [
      card("Telemetry (mock)", telemetry(a)),
      card("Data source mappings", el("div", { class: "stack" }, [
        ...dataSources.map(ds => el("div", { class: "activity-row" }, [
          badge(ds.kind, "info"),
          el("span", { class: "mono small" }, [ds.endpoint]),
          el("span", { class: "tiny muted" }, [ds.integrationId]),
        ])),
        dataSources.length ? null : el("div", { class: "muted tiny" }, ["No mappings yet."]),
      ])),
    ]),

    el("div", { class: "two-col", style: { marginTop: "16px" } }, [
      card(`Linked documents (${linkedDocs.length})`, el("div", { class: "stack" }, linkedDocs.map(doc =>
        el("div", { class: "activity-row", onClick: () => navigate(`/doc/${doc.id}`) }, [
          badge(doc.discipline, "info"),
          el("span", {}, [doc.name]),
          el("span", { class: "tiny muted" }, [doc.id]),
        ])
      ))),
      card("Incidents", el("div", { class: "stack" }, incidents.map(i =>
        el("div", { class: "activity-row", onClick: () => navigate(`/incident/${i.id}`) }, [
          badge(i.severity, "danger"),
          el("span", {}, [i.title]),
          badge(i.status, i.status === "active" ? "danger" : "success"),
        ])
      ).concat(incidents.length ? [] : [el("div", { class: "muted tiny" }, ["No incidents."])]))),
    ]),

    card("AI — What changed in 24h?", el("div", { class: "stack" }, [
      el("div", { class: "small" }, [
        `${a.name}: feeder current exceeded baseline by ~12% for 12s; temperature drift observed on HX-01. No trips.`,
      ]),
      el("div", { class: "tiny muted" }, ["Citations: AS-1, AS-2, DS-1, DS-3"]),
    ])),
  ]);
}

function telemetry(a) {
  const ticks = 40;
  const data = [];
  let v = 50 + (a.id.charCodeAt(a.id.length - 1) % 20);
  for (let i = 0; i < ticks; i++) {
    v += (Math.random() - 0.5) * 8;
    v = Math.max(10, Math.min(95, v));
    data.push(v);
  }
  const W = 300, H = 80;
  const points = data.map((y, i) => `${(i / (ticks - 1) * W).toFixed(1)},${(H - (y / 100) * H).toFixed(1)}`).join(" ");
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, width: "100%", height: "100px" });
  svg.innerHTML = `
    <polyline points="${points}" fill="none" stroke="var(--accent)" stroke-width="1.5"/>
    <line x1="0" x2="${W}" y1="${H*0.2}" y2="${H*0.2}" stroke="var(--border)" stroke-dasharray="3,3"/>
  `;
  return el("div", { class: "stack" }, [
    svg,
    el("div", { class: "row wrap" }, (a.mqttTopics || []).map(t => el("span", { class: "chip" }, [el("span", { class: "chip-kind" }, ["MQTT"]), t]))),
    el("div", { class: "row wrap" }, (a.opcuaNodes || []).map(n => el("span", { class: "chip" }, [el("span", { class: "chip-kind" }, ["OPC"]), n]))),
  ]);
}

function openWarRoom(a) {
  if (!can("incident.respond")) { toast("No incident capability", "warn"); return; }
  const existing = (state.data.incidents || []).find(i => i.assetId === a.id && i.status === "active");
  if (existing) return navigate(`/incident/${existing.id}`);
  const id = "INC-" + Math.floor(Math.random()*9000+1000);
  const inc = {
    id,
    title: `${a.name} — new incident`,
    severity: "SEV-3",
    status: "active",
    assetId: a.id,
    commanderId: null,
    channelId: null,
    startedAt: new Date().toISOString(),
    timeline: [{ ts: new Date().toISOString(), actor: state.ui.role, text: "War room opened from asset page." }],
  };
  update(s => { s.data.incidents.push(inc); });
  audit("incident.create", id, { source: a.id });
  navigate(`/incident/${id}`);
}

function statusVariant(s) {
  return s === "alarm" ? "danger" : s === "warning" ? "warn" : s === "offline" ? "" : "success";
}

function unsCard(asset) {
  let srv;
  try { srv = getServer(); } catch { return null; }
  // Find the UNS equipment object for this asset via alias.
  const obj = srv.resolveObject(asset.id);
  if (!obj) return null;
  const val = srv.queryLastKnownValues({ elementIds: [obj.elementId], maxDepth: 2 }).results[0]?.result;
  const variables = Object.entries(val?.components || {});

  return card("Unified Namespace · i3X", el("div", { class: "stack" }, [
    el("div", { class: "row wrap" }, [
      chip(obj.path, { kind: "UNS path" }),
      chip(obj.elementId, { kind: "i3X elementId" }),
      chip(obj.typeElementId, { kind: "type" }),
    ]),
    variables.length
      ? el("div", { class: "stack" }, variables.map(([name, vq]) =>
          el("div", { class: "activity-row" }, [
            el("span", { class: "mono tiny" }, [name]),
            el("span", { class: "strong" }, [String(vq.value ?? "—")]),
            badge(vq.quality || "", vq.quality === "Good" ? "success" : vq.quality === "Uncertain" ? "warn" : ""),
            el("span", { class: "tiny muted" }, [vq.timestamp ? new Date(vq.timestamp).toLocaleTimeString() : ""]),
          ])
        ))
      : el("div", { class: "muted tiny" }, ["No variables bound."]),
    el("div", { class: "row" }, [
      el("button", { class: "btn sm", onClick: () => navigate("/uns") }, ["Open in UNS →"]),
      el("button", { class: "btn sm", onClick: () => navigate(`/i3x?ep=value`) }, ["Try /objects/value →"]),
    ]),
  ]), { subtitle: "Same asset, canonical UNS address, live VQT from the i3X engine." });
}
