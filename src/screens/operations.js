import { el, mount, card, badge, kpi, tabs } from "../core/ui.js";
import { state, update } from "../core/store.js";
import { audit } from "../core/audit.js";
import { navigate } from "../core/router.js";
import { can } from "../core/permissions.js";
import { sparkline } from "../core/charts.js";

export function renderOperationsData() {
  const root = document.getElementById("screenContainer");
  const d = state.data;
  const points = d.historianPoints || [];
  const samples = d.historianSamples || [];
  const recipes = d.recipes || [];
  const activeRecipes = recipes.filter(r => r.status === "active");
  const registers = d.modbusRegisters || [];

  mount(root, [
    el("div", { class: "row spread", style: { marginBottom: "12px" } }, [
      el("div", {}, [
        el("div", { class: "strong" }, ["Operations data"]),
        el("div", { class: "tiny muted" }, ["Historians, time-series trends, recipes, and Modbus TCP mappings."]),
      ]),
      el("div", { class: "row wrap" }, [
        badge("SQLite historian", "accent"),
        badge("Timebase-ready", "purple"),
        badge("Modbus TCP", "info"),
      ]),
    ]),
    el("div", { class: "card-grid" }, [
      kpi("Historian points", points.length, `${samples.length} samples`, "up"),
      kpi("Active recipes", activeRecipes.length, `${recipes.length} total`, "up"),
      kpi("Modbus registers", registers.length, `${(d.modbusDevices || []).length} device`, "up"),
      kpi("Mapped assets", new Set(points.map(p => p.assetId)).size, "with trends", "up"),
    ]),
    tabs({
      sessionKey: "operations.data.tab",
      ariaLabel: "Operations data",
      tabs: [
        { id: "trends", label: "Historical trends", content: trendsTab },
        { id: "recipes", label: "Recipe management", content: recipesTab },
        { id: "modbus", label: "Modbus TCP", content: modbusTab },
      ],
    }),
  ]);
}

function trendsTab() {
  return el("div", { class: "two-col" }, [
    card("Asset DAQ history", el("div", { class: "stack" }, (state.data.historianPoints || []).map(pointTrend))),
    card("Historian backends", el("div", { class: "stack" }, [
      el("div", { class: "small" }, ["Local SQLite stores recent samples now; points carry a historian field so Timebase or another time-series backend can be selected without changing asset tags."]),
      ...Object.entries(groupBy(state.data.historianPoints || [], p => p.historian || "sqlite")).map(([name, rows]) =>
        el("div", { class: "activity-row" }, [
          badge(name, name === "sqlite" ? "accent" : "purple"),
          el("span", {}, [`${rows.length} points`]),
          el("span", { class: "tiny muted" }, [rows.map(r => r.tag).slice(0, 2).join(", ")]),
        ])
      ),
    ])),
  ]);
}

function pointTrend(point) {
  const samples = (state.data.historianSamples || []).filter(s => s.pointId === point.id).slice(-24);
  const asset = assetName(point.assetId);
  return el("div", { class: "activity-row" }, [
    badge(point.unit || point.dataType || "value", "info"),
    el("div", { class: "stack", style: { gap: "2px", flex: 1 } }, [
      el("span", { class: "small" }, [point.name]),
      el("span", { class: "tiny muted mono" }, [point.tag]),
      el("span", { class: "tiny muted" }, [asset]),
    ]),
    sparkline(samples.map(s => s.value), { width: 160, height: 44 }),
    el("span", { class: "strong" }, [latestValue(samples, point.unit)]),
  ]);
}

function recipesTab() {
  const versions = state.data.recipeVersions || [];
  return el("div", { class: "two-col" }, [
    card("Recipes", el("div", { class: "stack" }, (state.data.recipes || []).map(recipe => {
      const current = versions.find(v => v.id === recipe.currentVersionId);
      return el("div", { class: "activity-row" }, [
        badge(recipe.status, recipe.status === "active" ? "success" : "warn"),
        el("div", { class: "stack", style: { gap: "2px", flex: 1 } }, [
          el("span", { class: "small" }, [recipe.name]),
          el("span", { class: "tiny muted" }, [assetName(recipe.assetId), " · v", current?.version || "?"]),
        ]),
        current ? el("span", { class: "tiny muted mono" }, [Object.keys(current.parameters || {}).join(", ")]) : null,
        recipe.status !== "active" ? el("button", { class: "btn sm", disabled: !can("approve"), onClick: () => activateRecipe(recipe) }, ["Activate"]) : null,
      ]);
    }))),
    card("Version parameters", el("div", { class: "stack" }, versions.map(v =>
      el("div", { class: "activity-row" }, [
        badge(`v${v.version}`, v.state === "active" ? "success" : v.state === "superseded" ? "" : "warn"),
        el("span", { class: "tiny mono", style: { flex: 1 } }, [JSON.stringify(v.parameters)]),
        el("span", { class: "tiny muted" }, [v.notes || "No notes"]),
      ])
    ))),
  ]);
}

function modbusTab() {
  const devices = state.data.modbusDevices || [];
  return el("div", { class: "two-col" }, [
    card("Devices", el("div", { class: "stack" }, devices.map(device =>
      el("div", { class: "activity-row" }, [
        badge(device.status, device.status === "connected" ? "success" : "warn"),
        el("div", { class: "stack", style: { gap: "2px", flex: 1 } }, [
          el("span", { class: "small" }, [device.name]),
          el("span", { class: "tiny muted mono" }, [`${device.host}:${device.port} · unit ${device.unitId}`]),
        ]),
        el("span", { class: "tiny muted" }, [device.lastPollAt ? new Date(device.lastPollAt).toLocaleString() : "Not polled"]),
      ])
    ))),
    card("Register map", el("div", { class: "stack" }, (state.data.modbusRegisters || []).map(reg =>
      el("div", { class: "activity-row" }, [
        badge(`FC${reg.functionCode}`, "info"),
        el("div", { class: "stack", style: { gap: "2px", flex: 1 } }, [
          el("span", { class: "small" }, [reg.name]),
          el("span", { class: "tiny muted mono" }, [`${reg.address} · ${reg.dataType} · scale ${reg.scale}`]),
          reg.assetId ? el("button", { class: "btn ghost sm", onClick: () => navigate(`/asset/${reg.assetId}`) }, [assetName(reg.assetId)]) : null,
        ]),
        el("span", { class: "strong" }, [reg.lastValue == null ? "—" : `${reg.lastValue} ${reg.unit || ""}`.trim()]),
        el("button", { class: "btn sm", onClick: () => simulateModbusRead(reg) }, ["Sim read"]),
      ])
    ))),
  ]);
}

function activateRecipe(recipe) {
  update(s => {
    const item = s.data.recipes.find(r => r.id === recipe.id);
    if (!item) return;
    item.status = "active";
    const versions = s.data.recipeVersions.filter(v => v.recipeId === recipe.id);
    versions.forEach(v => { v.state = v.id === item.currentVersionId ? "active" : v.state === "active" ? "superseded" : v.state; });
  });
  audit("recipe.activate", recipe.id);
  toast(`${recipe.name} activated`, "success");
}

function simulateModbusRead(reg) {
  const raw = Number((420 + Math.random() * 80).toFixed(1));
  const value = Number((raw * Number(reg.scale || 1)).toFixed(2));
  update(s => {
    const row = s.data.modbusRegisters.find(r => r.id === reg.id);
    if (!row) return;
    row.lastValue = value;
    row.lastQuality = "Good";
    row.lastSeen = new Date().toISOString();
    const point = row.pointId && s.data.historianPoints.find(p => p.id === row.pointId);
    if (point) {
      s.data.historianSamples.push({
        id: `HS-${Date.now()}`,
        pointId: point.id,
        ts: row.lastSeen,
        value,
        quality: "Good",
        sourceType: "modbus_tcp",
        rawPayload: { rawValue: raw, registerId: row.id },
      });
    }
  });
  audit("modbus.register.read", reg.id, { rawValue: raw, value });
}

function latestValue(samples, unit) {
  const last = samples[samples.length - 1];
  return last ? `${last.value} ${unit || ""}`.trim() : "—";
}

function assetName(id) {
  return (state.data.assets || []).find(a => a.id === id)?.name || id || "Unassigned asset";
}

function groupBy(items, keyFn) {
  return items.reduce((acc, item) => {
    const key = keyFn(item);
    (acc[key] ||= []).push(item);
    return acc;
  }, {});
}
