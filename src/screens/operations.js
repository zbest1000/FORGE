import { el, mount, card, badge, kpi, tabs, select, toast } from "../core/ui.js";
import { state, update } from "../core/store.js";
import { audit } from "../core/audit.js";
import { navigate } from "../core/router.js";
import { can } from "../core/permissions.js";
import { historianChart, sparkline } from "../core/charts.js";

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
  const points = state.data.historianPoints || [];
  const assets = assetsWithHistorian(points);
  const selectedAssetId = sessionStorage.getItem("operations.trends.asset") || assets[0]?.id || "";
  const chartType = sessionStorage.getItem("operations.trends.chart") || "line";
  const selectedPoints = points.filter(p => !selectedAssetId || p.assetId === selectedAssetId);
  const assetPick = select(assets.map(a => ({ value: a.id, label: a.name })), {
    value: selectedAssetId,
    onChange: e => {
      sessionStorage.setItem("operations.trends.asset", e.target.value);
      renderOperationsData();
    },
  });
  const chartPick = select([
    { value: "line", label: "Line" },
    { value: "area", label: "Area" },
    { value: "bar", label: "Bar" },
    { value: "scatter", label: "Scatter" },
  ], {
    value: chartType,
    onChange: e => {
      sessionStorage.setItem("operations.trends.chart", e.target.value);
      renderOperationsData();
    },
  });

  return el("div", { class: "stack" }, [
    card("Trend controls", el("div", { class: "row wrap" }, [
      el("label", { class: "stack", style: { gap: "4px" } }, [
        el("span", { class: "tiny muted" }, ["Asset"]),
        assetPick,
      ]),
      el("label", { class: "stack", style: { gap: "4px" } }, [
        el("span", { class: "tiny muted" }, ["Chart type"]),
        chartPick,
      ]),
      badge("ECharts", "accent"),
    ]), { subtitle: "Add different chart views for an asset's live and historical data." }),
    el("div", { class: "two-col" }, [
      card("Asset DAQ history", el("div", { class: "stack" }, selectedPoints.map(pointTrend))),
      card("Historian backends", historianBackendsPanel(points), {
        subtitle: "Production routing: cache locally, write/query configured external historians.",
      }),
    ]),
    card("Asset historian charts", el("div", { class: "card-grid" }, selectedPoints.map(point => pointChart(point, chartType))), {
      subtitle: "Each card renders the selected asset's historical samples with ECharts.",
    }),
  ]);
}

function historianBackendsPanel(points) {
  const configured = new Set(points.map(p => p.historian || "sqlite"));
  const backends = [
    { id: "sqlite", label: "SQLite", role: "local/dev/demo/recent cache", active: true },
    { id: "influxdb", label: "InfluxDB", role: "high-volume time-series trends", active: configured.has("influxdb") || configured.has("influx") },
    { id: "timebase", label: "Timebase", role: "enterprise historian integration", active: configured.has("timebase") },
    { id: "mssql", label: "SQL Server", role: "recipes, batch records, regulated relational history", active: configured.has("mssql") || configured.has("sqlserver") },
  ];
  return el("div", { class: "stack" }, [
        el("div", { class: "small" }, ["Local SQLite stores recent samples now; points carry a historian field so Timebase or another time-series backend can be selected without changing asset tags."]),
        ...Object.entries(groupBy(points, p => p.historian || "sqlite")).map(([name, rows]) =>
          el("div", { class: "activity-row" }, [
            badge(name, name === "sqlite" ? "accent" : "purple"),
            el("span", {}, [`${rows.length} points`]),
            el("span", { class: "tiny muted" }, [rows.map(r => r.tag).slice(0, 2).join(", ")]),
          ])
        ),
        ...backends.map(b => el("div", { class: "activity-row" }, [
          badge(b.label, b.active ? "success" : ""),
          el("span", { class: "tiny muted" }, [b.role]),
        ])),
  ]);
}

function assetsWithHistorian(points) {
  const ids = new Set(points.map(p => p.assetId));
  return (state.data.assets || []).filter(a => ids.has(a.id));
}

function pointChart(point, chartType) {
  const samples = samplesForPoint(point);
  return el("div", { class: "stack" }, [
    el("div", { class: "row spread" }, [
      el("div", {}, [
        el("div", { class: "small strong" }, [point.name]),
        el("div", { class: "tiny muted mono" }, [point.tag]),
      ]),
      badge(point.unit || "value", "info"),
    ]),
    historianChart(samples, { title: point.name, unit: point.unit || "", type: chartType, height: 260 }),
    el("div", { class: "row wrap tiny muted" }, [
      `Latest ${latestValue(samples, point.unit)}`,
      ` · ${samples.length} samples`,
      ` · ${assetName(point.assetId)}`,
    ]),
  ]);
}

function pointTrend(point) {
  const samples = samplesForPoint(point);
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

function samplesForPoint(point) {
  return (state.data.historianSamples || []).filter(s => s.pointId === point.id).slice(-48);
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
        el("span", { class: "tiny mono", style: { flex: 1, whiteSpace: "normal", overflowWrap: "anywhere" } }, [JSON.stringify(v.parameters)]),
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
