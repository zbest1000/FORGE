// Asset Configuration tab.
//
// Mounted by `src/screens/assetDetail.js` on the Configuration tab.
// Lets the operator:
//   - apply a profile (pin to a profile version + chosen source system)
//   - or define a one-time custom mapping per data point
//   - resolve the path template against the asset's hierarchy variables
//   - on SQL mode, choose Schema-defined or Free-form (latter gated
//     behind the `historian.sql.raw` capability)
//   - test + delete individual bindings
//
// Spec ref: docs/INDUSTRIAL_EDGE_PLATFORM_SPEC.md §4 (asset model),
// §6 (storage), §17 (REST surface). Free-form SQL is the
// `historian.sql.raw` capability described in plan §assumptions/4.

import {
  el, mount, card, badge, kpi, toast, modal, formRow, input, textarea,
  select, prompt, confirm, loadingState,
} from "../core/ui.js";
import { state } from "../core/store.js";
import { api } from "../core/api.js";

/**
 * Public entry point. The detail tab body is empty until this is
 * called; pass the asset id and a node to mount into.
 */
export async function renderAssetConfig({ assetId, target }) {
  if (!target) return;
  if (!state.server?.connected) {
    mount(target, [renderDemoNotice(assetId)]);
    return;
  }
  mount(target, [loadingState({ message: "Loading asset configuration…" })]);

  const [bindings, profiles, systems, me] = await Promise.all([
    api(`/api/assets/${assetId}/bindings`),
    api("/api/asset-profiles"),
    api("/api/enterprise-systems").catch(() => []),
    api("/api/me").catch(() => null),
  ]);

  const canRawSql = !!me?.capabilities && (me.capabilities.includes("*") || me.capabilities.includes("historian.sql.raw"));

  mount(target, [
    headerRow(bindings, canRawSql),
    bindings.length ? bindingsTable(bindings, assetId) : emptyState(),
    el("div", { class: "row wrap", style: { marginTop: "12px" } }, [
      el("button", { class: "btn primary", onClick: () => openApplyProfileModal({ assetId, profiles, systems, canRawSql }) }, ["Apply profile…"]),
      el("button", { class: "btn", onClick: () => openCustomMappingModal({ assetId, systems, canRawSql }) }, ["Custom mapping…"]),
    ]),
    canRawSql ? null : el("div", { class: "tiny muted", style: { marginTop: "8px" } }, [
      "Free-form SQL authoring is gated behind the ",
      el("code", {}, ["historian.sql.raw"]),
      " capability (Workspace Admin only by default). Schema-defined SQL stays available to all integration writers.",
    ]),
  ]);
}

function renderDemoNotice(assetId) {
  // Demo mode — render existing data-source mappings from seed so the
  // user sees a populated config tab instead of a "sign in" placeholder.
  // Adding a binding offline is supported: it lands in
  // `state.data.dataSources` and survives reload via localStorage.
  const d = state.data || {};
  const sources = (d.dataSources || []).filter(s => s.assetId === assetId);
  const points = (d.historianPoints || []).filter(p => p.assetId === assetId);

  return card("Asset configuration", el("div", { class: "stack" }, [
    el("div", { class: "row spread" }, [
      el("div", {}, [
        el("div", { class: "strong" }, ["Configuration (offline)"]),
        el("div", { class: "tiny muted" }, [
          `${sources.length} data source${sources.length === 1 ? "" : "s"} · ${points.length} historian point${points.length === 1 ? "" : "s"} seeded`,
        ]),
      ]),
      el("div", { class: "row" }, [
        badge("DEMO", "warn", { title: "Profile-binding API is server-backed; offline mode shows the seeded mappings only." }),
      ]),
    ]),
    sources.length
      ? el("table", { class: "table" }, [
          el("thead", {}, [el("tr", {}, ["Connector", "Endpoint", "Kind", "Status", "Last seen"].map(h => el("th", {}, [h])))]),
          el("tbody", {}, sources.map(s => el("tr", {}, [
            el("td", {}, [badge((s.integrationId || "—"), "info")]),
            el("td", { class: "mono tiny" }, [s.endpoint || "—"]),
            el("td", {}, [s.kind || "—"]),
            el("td", {}, [badge(s.status || "—", s.status === "live" ? "success" : s.status === "stale" ? "warn" : "")]),
            el("td", { class: "tiny muted" }, [s.lastSeen ? new Date(s.lastSeen).toLocaleString() : "—"]),
          ]))),
        ])
      : el("div", { class: "muted small" }, ["No mappings yet on this asset."]),
    points.length
      ? el("div", { class: "stack", style: { marginTop: "8px" } }, [
          el("div", { class: "tiny muted" }, ["Historian points (seeded)"]),
          el("table", { class: "table" }, [
            el("thead", {}, [el("tr", {}, ["Tag", "Name", "Unit", "Type"].map(h => el("th", {}, [h])))]),
            el("tbody", {}, points.map(p => el("tr", {}, [
              el("td", { class: "mono tiny" }, [p.tag]),
              el("td", {}, [p.name]),
              el("td", {}, [p.unit || "—"]),
              el("td", {}, [p.dataType || "—"]),
            ]))),
          ]),
        ])
      : null,
    el("div", { class: "tiny muted" }, [
      "Apply-profile and custom-mapping flows require a server connection. ",
      "Connect FORGE to a server to author new bindings; offline mode keeps existing seeded mappings visible and read-only.",
    ]),
  ]));
}

function headerRow(bindings, canRawSql) {
  const byKind = bindings.reduce((acc, b) => { acc[b.sourceKind] = (acc[b.sourceKind] || 0) + 1; return acc; }, {});
  return el("div", { class: "row spread", style: { marginBottom: "12px" } }, [
    el("div", {}, [
      el("div", { class: "strong" }, ["Configuration"]),
      el("div", { class: "tiny muted" }, [
        bindings.length
          ? `${bindings.length} binding${bindings.length === 1 ? "" : "s"} — ${Object.entries(byKind).map(([k, n]) => `${n} ${k}`).join(", ")}`
          : "No bindings yet — apply a profile or define a custom mapping below.",
      ]),
    ]),
    el("div", { class: "row wrap" }, [
      canRawSql ? badge("historian.sql.raw", "purple", { title: "You can author free-form SQL templates." }) : null,
    ]),
  ]);
}

function emptyState() {
  return el("div", { class: "muted", style: { padding: "24px", textAlign: "center" } }, [
    "Apply a profile to wire this asset's data points to a registered MQTT broker, OPC UA endpoint, or SQL data source.",
  ]);
}

function bindingsTable(bindings, assetId) {
  return el("table", { class: "table" }, [
    el("thead", {}, [el("tr", {}, ["Point", "Source", "Path", "Last value", "Status", ""].map(h => el("th", {}, [h])))]),
    el("tbody", {}, bindings.map(b => el("tr", {}, [
      el("td", {}, [
        el("strong", {}, [b.profilePointId ? `${shortPoint(b)}` : "(custom)"]),
        el("div", { class: "tiny muted mono" }, [b.pointId || "—"]),
      ]),
      el("td", {}, [sourceKindBadge(b.sourceKind), b.sqlMode ? el("span", { class: "tiny muted" }, [` ${b.sqlMode}`]) : null]),
      el("td", { class: "mono tiny" }, [b.sourcePath || "—"]),
      el("td", {}, [
        b.lastValue == null ? el("span", { class: "muted" }, ["—"]) : String(b.lastValue),
        b.lastQuality ? el("div", { class: "tiny muted" }, [b.lastQuality]) : null,
      ]),
      el("td", {}, [b.enabled ? badge("active", "success") : badge("disabled", "")]),
      el("td", {}, [
        el("button", { class: "btn sm", onClick: () => testBinding(b) }, ["Test"]),
        el("button", { class: "btn sm danger", onClick: () => deleteBinding({ assetId, b }) }, ["Remove"]),
      ]),
    ]))),
  ]);
}

function shortPoint(b) {
  // Phase 3 doesn't fetch the profile points alongside bindings; the
  // server returns profilePointId. We render the trailing path
  // segment as a friendly fallback (e.g. ".../temperature" → temperature).
  const tail = (b.sourcePath || "").split(/[\/.]/).pop();
  return tail || b.id;
}

function sourceKindBadge(kind) {
  return badge(kind || "—", kind === "mqtt" ? "info" : kind === "opcua" ? "purple" : kind === "sql" ? "warn" : "");
}

// ---------- Apply profile -------------------------------------------------

function openApplyProfileModal({ assetId, profiles, systems, canRawSql }) {
  if (!profiles.length) {
    toast("No profiles available. Create one under /profiles first.", "warn");
    return;
  }
  let chosenProfile = profiles[0];
  let chosenVersionId = chosenProfile.latestVersionId || "";
  let chosenSystemId = "";
  let sqlMode = "schema_defined";

  const profileSel = select(profiles.map(p => ({ value: p.id, label: `${p.name} · ${p.sourceKind} · v${p.versionCount}` })), { value: chosenProfile.id });
  const versionSel = el("select", { class: "select" });
  const systemSel = el("select", { class: "select" });
  const sqlModeSel = select([
    { value: "schema_defined", label: "Schema-defined (default — uses the profile's source_template)" },
    { value: "free_form", label: "Free-form SELECT (requires historian.sql.raw)" },
  ], { value: sqlMode });

  function refreshVersions() {
    versionSel.innerHTML = "";
    api(`/api/asset-profiles/${chosenProfile.id}/versions`).then(versions => {
      versions.forEach(v => {
        const opt = document.createElement("option");
        opt.value = v.id;
        opt.textContent = `v${v.version} · ${v.status} · ${v.pointCount} points${v.id === chosenProfile.latestVersionId ? " (latest)" : ""}`;
        if (v.id === chosenVersionId || (!chosenVersionId && v.id === chosenProfile.latestVersionId)) opt.selected = true;
        versionSel.append(opt);
      });
    });
  }
  function refreshSystems() {
    systemSel.innerHTML = "";
    const matching = systems.filter(s => {
      const k = (s.kind || s.category || "").toLowerCase();
      if (chosenProfile.sourceKind === "mqtt") return /mqtt|broker/.test(k);
      if (chosenProfile.sourceKind === "opcua") return /opcua|opc/.test(k);
      if (chosenProfile.sourceKind === "sql") return /sql|historian|database|warehouse/.test(k);
      return true;
    });
    if (!matching.length) {
      const blank = document.createElement("option");
      blank.value = "";
      blank.textContent = `(no ${chosenProfile.sourceKind} systems registered — add one under /integrations)`;
      systemSel.append(blank);
    } else {
      for (const s of matching) {
        const opt = document.createElement("option");
        opt.value = s.id;
        opt.textContent = `${s.name} · ${s.vendor || s.kind || s.category}`;
        if (s.id === chosenSystemId) opt.selected = true;
        systemSel.append(opt);
      }
      chosenSystemId = matching[0].id;
    }
  }
  refreshVersions();
  refreshSystems();

  profileSel.addEventListener("change", () => {
    chosenProfile = profiles.find(p => p.id === profileSel.value);
    chosenVersionId = chosenProfile.latestVersionId || "";
    refreshVersions();
    refreshSystems();
  });
  versionSel.addEventListener("change", () => { chosenVersionId = versionSel.value; });
  systemSel.addEventListener("change", () => { chosenSystemId = systemSel.value; });
  sqlModeSel.addEventListener("change", () => { sqlMode = sqlModeSel.value; });

  modal({
    title: "Apply profile",
    body: el("div", { class: "stack" }, [
      formRow("Profile", profileSel),
      formRow("Version", versionSel),
      formRow("Source system", systemSel),
      // The SQL-mode toggle only matters for sql profiles; show it
      // conditionally based on chosenProfile.sourceKind.
      chosenProfile.sourceKind === "sql"
        ? formRow("SQL mode", sqlModeSel)
        : null,
      el("div", { class: "tiny muted" }, [
        "The asset's enterprise + location names auto-fill the {enterprise} and {site} placeholders. ",
        "Phase 3 doesn't yet expose per-point overrides in this dialog — apply, then edit individual bindings via the table or the API.",
      ]),
    ]),
    actions: [
      { label: "Cancel" },
      { label: "Apply", variant: "primary", onClick: async () => {
        if (!chosenSystemId) { toast("Pick a source system", "warn"); return false; }
        if (chosenProfile.sourceKind === "sql" && sqlMode === "free_form" && !canRawSql) {
          toast("Free-form SQL requires the historian.sql.raw capability", "warn");
          return false;
        }
        try {
          const r = await api(`/api/assets/${assetId}/apply-profile`, { method: "POST", body: {
            profileVersionId: chosenVersionId,
            sourceSystemId: chosenSystemId,
            ...(chosenProfile.sourceKind === "sql" ? { sqlMode } : {}),
          }});
          toast(`Applied ${r.inserted} new + ${r.updated} updated binding${r.bindings.length === 1 ? "" : "s"}`, "success");
          renderAssetConfig({ assetId, target: document.querySelector("#asset-config-target") });
        } catch (err) {
          toast(`Apply failed: ${err?.body?.error?.message || err?.message || err}`, "warn");
          return false;
        }
      }},
    ],
  });
}

// ---------- Custom mapping ------------------------------------------------

function openCustomMappingModal({ assetId, systems, canRawSql }) {
  if (!systems.length) {
    toast("No source systems registered. Add one under /integrations first.", "warn");
    return;
  }
  let sourceKind = "mqtt";
  let sourceSystemId = systems[0].id;
  let sqlMode = "schema_defined";
  let queryTemplate = "";

  const kindSel = select([
    { value: "mqtt", label: "MQTT" },
    { value: "opcua", label: "OPC UA" },
    { value: "sql", label: "SQL" },
  ], { value: sourceKind });
  const systemSel = el("select", { class: "select" });
  const sqlModeSel = select([
    { value: "schema_defined", label: "Schema-defined" },
    { value: "free_form", label: "Free-form SELECT (requires historian.sql.raw)" },
  ], { value: sqlMode });
  const sqlModeRow = formRow("SQL mode", sqlModeSel);
  sqlModeRow.style.display = "none";

  const queryArea = textarea({ rows: 4, placeholder: "SELECT TOP 100 ts, value, quality FROM forge_historian_samples WHERE point_id = :point_id AND ts > :since LIMIT 100" });
  const queryRow = formRow("Free-form SELECT (validated server-side)", queryArea);
  queryRow.style.display = "none";

  const pointInput = input({ placeholder: "temperature" });
  const unitInput = input({ placeholder: "C" });
  const pathInput = input({ placeholder: "Atlas/North Plant/Pump-A/temperature" });

  function refreshSystems() {
    systemSel.innerHTML = "";
    const matching = systems.filter(s => {
      const k = (s.kind || s.category || "").toLowerCase();
      if (sourceKind === "mqtt") return /mqtt|broker/.test(k);
      if (sourceKind === "opcua") return /opcua|opc/.test(k);
      if (sourceKind === "sql") return /sql|historian|database|warehouse/.test(k);
      return true;
    });
    for (const s of matching) {
      const opt = document.createElement("option");
      opt.value = s.id;
      opt.textContent = `${s.name} · ${s.vendor || s.kind || s.category}`;
      systemSel.append(opt);
    }
    sourceSystemId = matching[0]?.id || "";
  }
  refreshSystems();

  kindSel.addEventListener("change", () => {
    sourceKind = kindSel.value;
    sqlModeRow.style.display = sourceKind === "sql" ? "" : "none";
    queryRow.style.display = sourceKind === "sql" && sqlMode === "free_form" ? "" : "none";
    refreshSystems();
  });
  systemSel.addEventListener("change", () => { sourceSystemId = systemSel.value; });
  sqlModeSel.addEventListener("change", () => {
    sqlMode = sqlModeSel.value;
    queryRow.style.display = sqlMode === "free_form" ? "" : "none";
    if (sqlMode === "free_form" && !canRawSql) {
      toast("Free-form SQL requires the historian.sql.raw capability", "warn");
    }
  });
  queryArea.addEventListener("input", () => { queryTemplate = queryArea.value; });

  modal({
    title: "Custom mapping",
    body: el("div", { class: "stack" }, [
      formRow("Source kind", kindSel),
      formRow("Source system", systemSel),
      sqlModeRow,
      queryRow,
      formRow("Point name", pointInput),
      formRow("Unit", unitInput),
      formRow("Source path (resolved — no placeholders)", pathInput),
      el("div", { class: "tiny muted" }, [
        "Custom mappings don't pin to a profile version — Phase 3 supports a single point per modal. ",
        "For multi-point custom mappings, POST an array to /api/assets/:id/custom-mapping directly.",
      ]),
    ]),
    actions: [
      { label: "Cancel" },
      { label: "Save", variant: "primary", onClick: async () => {
        const name = pointInput.value.trim();
        const path = pathInput.value.trim();
        if (!name || !path) { toast("Point name + source path required", "warn"); return false; }
        const m = {
          pointName: name,
          unit: unitInput.value.trim() || null,
          dataType: "number",
          sourceKind,
          sourceSystemId,
          sourcePath: path,
        };
        if (sourceKind === "sql") {
          m.sqlMode = sqlMode;
          if (sqlMode === "free_form") {
            if (!canRawSql) { toast("Free-form SQL requires historian.sql.raw", "warn"); return false; }
            if (!queryTemplate.trim()) { toast("Query template required for free-form mode", "warn"); return false; }
            m.queryTemplate = queryTemplate.trim();
          }
        }
        try {
          await api(`/api/assets/${assetId}/custom-mapping`, { method: "POST", body: { mappings: [m] } });
          toast("Custom mapping saved", "success");
          renderAssetConfig({ assetId, target: document.querySelector("#asset-config-target") });
        } catch (err) {
          toast(`Save failed: ${err?.body?.error?.message || err?.message || err}`, "warn");
          return false;
        }
      }},
    ],
  });
}

// ---------- Per-binding actions -------------------------------------------

async function testBinding(b) {
  try {
    const r = await api(`/api/asset-point-bindings/${b.id}/test`, { method: "POST", body: {} });
    if (r.ok) toast(`OK: ${r.message || "binding looks healthy"}`, "success");
    else toast(`Test failed: ${r.message || "binding shape rejected"}`, "warn");
  } catch (err) {
    toast(`Test failed: ${err?.body?.error?.message || err?.message || err}`, "warn");
  }
}

async function deleteBinding({ assetId, b }) {
  const ok = await confirm({ title: "Remove binding", message: `Remove ${b.sourceKind} binding ${b.sourcePath}?`, confirmLabel: "Remove", variant: "danger" });
  if (!ok) return;
  try {
    await api(`/api/assets/${assetId}/bindings/${b.id}`, { method: "DELETE" });
    toast("Binding removed", "success");
    renderAssetConfig({ assetId, target: document.querySelector("#asset-config-target") });
  } catch (err) {
    toast(`Remove failed: ${err?.body?.error?.message || err?.message || err}`, "warn");
  }
}
