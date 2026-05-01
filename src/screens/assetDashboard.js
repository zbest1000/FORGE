// Asset Dashboard — phase 1.
//
// Server-backed grid of asset cards grouped by enterprise → location.
// Each card shows the user-uploaded visual (PNG/JPEG/BMP) plus a name +
// "View Data" button. The left tree expands/collapses categories; click
// filters the centre pane. The toolbar exposes "+ Enterprise",
// "+ Location", "+ Asset", and rename actions — rename surfaces the
// re-resolve modal so binding source paths stay in sync.
//
// Phase 2/3 layer profile bindings + live SSE on top of the same shell.
//
// Demo mode (no server): renders a polite placeholder. The dashboard is
// inherently server-backed — it queries `/api/asset-tree`. Offline users
// stay on the legacy `/admin/assets` table view we kept in
// `assetDetail.js#renderAssetsIndex`.

import {
  el, mount, card, badge, kpi, toast, modal, formRow, input, textarea,
  prompt, confirm,
} from "../core/ui.js";
import { state } from "../core/store.js";
import { navigate } from "../core/router.js";
import { api } from "../core/api.js";
import { sparkline } from "../core/charts.js";
import { renderAssetsIndex as legacyAssetsTable } from "./assetDetail.js";

const SS_EXPANDED = "assets.dashboard.expanded";
const SS_FILTER_TEXT = "assets.dashboard.filter";
const SS_SELECTED_NODE = "assets.dashboard.selected";

function getExpanded() {
  try {
    return new Set(JSON.parse(sessionStorage.getItem(SS_EXPANDED) || "[]"));
  } catch { return new Set(); }
}
function saveExpanded(set) {
  sessionStorage.setItem(SS_EXPANDED, JSON.stringify([...set]));
}
function toggleExpanded(key) {
  const s = getExpanded();
  if (s.has(key)) s.delete(key); else s.add(key);
  saveExpanded(s);
}

export async function renderAssetDashboard() {
  const root = document.getElementById("screenContainer");
  if (!root) return;

  if (!state.server?.connected) {
    return mount(root, [
      el("div", { class: "stack", style: { padding: "16px", maxWidth: "640px" } }, [
        card("Asset dashboard", el("div", { class: "stack" }, [
          el("p", { class: "muted" }, [
            "The asset dashboard requires a connected FORGE server. Sign in or run the server in dev mode to see your enterprises, locations, and asset cards.",
          ]),
          el("div", { class: "row" }, [
            el("button", { class: "btn", onClick: () => navigate("/hub") }, ["Go to Hub"]),
          ]),
        ])),
        card("Legacy table view", legacyAssetsTableNote()),
      ]),
    ]);
  }

  // Server mode — render the loading shell synchronously, then populate.
  mount(root, [renderShell({ tree: [], unassigned: [], loading: true })]);

  let payload;
  try {
    payload = await api("/api/asset-tree");
  } catch (err) {
    return mount(root, [
      card("Asset dashboard", el("div", { class: "stack" }, [
        el("div", { class: "callout danger" }, [
          `Failed to load /api/asset-tree: ${err?.message || err}`,
        ]),
        el("button", { class: "btn", onClick: () => renderAssetDashboard() }, ["Retry"]),
      ])),
    ]);
  }

  mount(root, [renderShell(payload)]);
}

// Backward-compat alias for the existing /assets route binding which
// referenced `renderAssetsIndex`. Calling app.js wires this re-export
// through the lazy() loader.
export const renderAssetsIndex = renderAssetDashboard;

// Legacy table view that lives at /admin/assets — we re-export the
// existing helper untouched so the old read-only flow stays available
// for power users who prefer dense tables.
export function renderAssetsTable() { return legacyAssetsTable(); }

function legacyAssetsTableNote() {
  return el("div", { class: "stack" }, [
    el("p", { class: "muted" }, ["The legacy asset table is reachable at /admin/assets while the dashboard is still phase 1."]),
    el("button", { class: "btn", onClick: () => navigate("/admin/assets") }, ["Open table view"]),
  ]);
}

function renderShell({ tree, unassigned, loading }) {
  const filter = (sessionStorage.getItem(SS_FILTER_TEXT) || "").toLowerCase();
  const expanded = getExpanded();
  const selected = sessionStorage.getItem(SS_SELECTED_NODE) || ""; // "ent:..." or "loc:..."
  const counts = computeCounts(tree, unassigned);

  // Apply filter to tree at render-time. Filter matches asset.name; if a
  // location has no matching asset and a filter is active, the location
  // is hidden too. Empty filter = show everything.
  const filtered = filterTree(tree, filter);

  // Decide which cards to show in the centre panel based on the
  // currently-selected tree node. With nothing selected, show every
  // visible asset across the tree (subject to filter).
  const cards = selectedAssetsFor(selected, filtered, unassigned, filter);

  return el("div", { class: "stack" }, [
    headerRow(counts, loading),
    toolbar(filter),
    el("div", { class: "three-col asset-dashboard" }, [
      card("Hierarchy", treePanel(filtered, unassigned, expanded, selected), {
        subtitle: "Enterprise → Location → Assets",
      }),
      card(`Assets (${cards.length})`, cardGrid(cards), {
        subtitle: filter ? `Filtered by "${filter}"` : (selected ? selectedDescriptor(selected, tree) : "All assets"),
        actions: selected ? [el("button", { class: "btn sm ghost", onClick: () => { sessionStorage.removeItem(SS_SELECTED_NODE); renderAssetDashboard(); } }, ["Clear filter"])] : null,
      }),
      summaryPanel(selected, tree, unassigned),
    ]),
  ]);
}

function computeCounts(tree, unassigned) {
  let assets = unassigned.length;
  let locations = 0;
  for (const e of tree) {
    locations += e.locations.length;
    assets += e.ungroupedAssets.length;
    for (const l of e.locations) assets += l.assets.length;
  }
  return { enterprises: tree.length, locations, assets };
}

function headerRow({ enterprises, locations, assets }, loading) {
  return el("div", { class: "row spread", style: { marginBottom: "12px" } }, [
    el("div", {}, [
      el("div", { class: "strong" }, ["Asset dashboard"]),
      el("div", { class: "tiny muted" }, [
        loading ? "Loading…" : `${enterprises} enterprise${enterprises === 1 ? "" : "s"} · ${locations} location${locations === 1 ? "" : "s"} · ${assets} asset${assets === 1 ? "" : "s"}`,
      ]),
    ]),
    el("div", { class: "row wrap" }, [
      badge("Phase 1 · grid + visuals", "accent"),
      el("button", { class: "btn sm", onClick: () => renderAssetDashboard() }, ["Refresh"]),
    ]),
  ]);
}

// Debounce timer for the toolbar's filter input. Module-level so the
// tiny re-render delay survives across re-mounts.
let _filterDebounce = null;

function toolbar(filter) {
  const filterInput = input({
    placeholder: "Filter by asset name…",
    value: filter,
    onInput: (e) => {
      sessionStorage.setItem(SS_FILTER_TEXT, e.target.value);
      // Re-render after a tiny debounce; keystroke perf trumps freshness.
      if (_filterDebounce != null) clearTimeout(_filterDebounce);
      _filterDebounce = setTimeout(() => renderAssetDashboard(), 120);
    },
  });
  return card("", el("div", { class: "row wrap" }, [
    filterInput,
    el("button", { class: "btn sm", onClick: () => createEnterprisePrompt() }, ["+ Enterprise"]),
    el("button", { class: "btn sm", onClick: () => createLocationPrompt() }, ["+ Location"]),
    el("button", { class: "btn sm primary", onClick: () => createAssetPrompt() }, ["+ Asset"]),
  ]));
}

// Recursively count locations + assets under a location node so the
// tree row's "meta" shows total reachable children (helpful in deep
// ISA-95 chains: Enterprise → Site → Area → Line → Asset).
function countLocSubtree(loc) {
  let assets = loc.assets.length;
  let locations = loc.children?.length || 0;
  for (const c of loc.children || []) {
    const sub = countLocSubtree(c);
    assets += sub.assets;
    locations += sub.locations;
  }
  return { assets, locations };
}

function treePanel(tree, unassigned, expanded, selected) {
  if (!tree.length && !unassigned.length) {
    return el("div", { class: "muted" }, [
      "No enterprises yet. Click + Enterprise to start.",
    ]);
  }
  const wrap = el("div", { class: "stack", style: { gap: "2px" } });

  function renderLocationNode(loc, indent) {
    const locKey = `loc:${loc.id}`;
    const hasKids = (loc.children?.length || 0) > 0;
    const open = expanded.has(locKey);
    const sub = countLocSubtree(loc);
    const meta = sub.locations
      ? `${loc.assets.length} direct · ${sub.assets} total · ${sub.locations} sub`
      : `${loc.assets.length} asset${loc.assets.length === 1 ? "" : "s"}`;
    wrap.append(treeRow({
      label: loc.name,
      kind: loc.kind || "Location",
      meta,
      indent,
      open,
      hasChildren: hasKids,
      active: selected === locKey,
      onToggle: hasKids ? () => { toggleExpanded(locKey); renderAssetDashboard(); } : null,
      onSelect: () => { sessionStorage.setItem(SS_SELECTED_NODE, locKey); renderAssetDashboard(); },
      onRename: () => renameLocationPrompt(loc),
    }));
    if (open && hasKids) {
      for (const child of loc.children) renderLocationNode(child, indent + 1);
    }
  }

  for (const e of tree) {
    const entKey = `ent:${e.id}`;
    const open = expanded.has(entKey);
    const childCount = e.locations.length + e.ungroupedAssets.length;
    wrap.append(treeRow({
      label: e.name,
      kind: "Enterprise",
      meta: `${childCount} child${childCount === 1 ? "" : "ren"}`,
      indent: 0,
      open,
      hasChildren: childCount > 0,
      active: selected === entKey,
      onToggle: () => { toggleExpanded(entKey); renderAssetDashboard(); },
      onSelect: () => { sessionStorage.setItem(SS_SELECTED_NODE, entKey); renderAssetDashboard(); },
      onRename: () => renameEnterprisePrompt(e),
    }));
    if (!open) continue;
    for (const l of e.locations) renderLocationNode(l, 1);
    if (e.ungroupedAssets.length) {
      wrap.append(el("div", {
        class: "tree-item",
        style: { paddingLeft: "20px", opacity: 0.7 },
      }, [
        el("span", { class: "tree-dot" }),
        el("span", { class: "tree-label" }, [`(${e.ungroupedAssets.length} unassigned)`]),
      ]));
    }
  }
  if (unassigned.length) {
    wrap.append(el("div", { class: "tiny muted", style: { marginTop: "12px", padding: "6px" } }, [
      `${unassigned.length} asset${unassigned.length === 1 ? "" : "s"} not yet placed in any enterprise/location.`,
    ]));
  }
  return wrap;
}

function treeRow({ label, kind, meta, indent, open, hasChildren, active, onToggle, onSelect, onRename }) {
  const row = el("button", {
    type: "button",
    class: `tree-item ${active ? "active" : ""}`,
    style: { paddingLeft: (8 + indent * 12) + "px" },
    onClick: () => onSelect && onSelect(),
  }, [
    onToggle && hasChildren ? el("span", {
      class: "tree-toggle",
      onClick: (e) => { e.stopPropagation(); onToggle(); },
      style: { width: "12px", display: "inline-block", textAlign: "center", marginRight: "4px" },
    }, [open ? "▾" : "▸"]) : el("span", { style: { width: "16px", display: "inline-block" } }),
    el("span", { class: "tree-dot" }),
    el("span", { class: "tree-label", style: { flex: 1 } }, [label]),
    el("span", { class: "tiny muted", style: { marginLeft: "8px" } }, [meta || ""]),
    onRename ? el("span", {
      class: "tiny",
      title: "Rename",
      onClick: (e) => { e.stopPropagation(); onRename(); },
      style: { marginLeft: "8px", cursor: "pointer", opacity: 0.6 },
    }, ["✎"]) : null,
  ]);
  if (kind) row.title = kind;
  return row;
}

// Flatten a location node + descendants into an asset list. Used both
// for "selected location → cards" and for total counts in the tree.
function flattenLocationAssets(loc) {
  const out = [...loc.assets];
  for (const c of loc.children || []) out.push(...flattenLocationAssets(c));
  return out;
}

// Walk all locations under a given enterprise (top + descendants).
function walkLocations(enterprise, fn) {
  function rec(loc, depth, ancestors) {
    fn(loc, depth, ancestors);
    for (const c of loc.children || []) rec(c, depth + 1, [...ancestors, loc]);
  }
  for (const top of enterprise.locations) rec(top, 1, []);
}

function findLocationInTree(tree, id) {
  for (const e of tree) {
    let found = null;
    walkLocations(e, (loc, depth, ancestors) => {
      if (!found && loc.id === id) found = { ent: e, loc, ancestors };
    });
    if (found) return found;
  }
  return null;
}

function selectedAssetsFor(selected, tree, unassigned, filter) {
  const fmatch = (a) => !filter || a.name.toLowerCase().includes(filter);
  if (!selected) {
    const all = [];
    for (const e of tree) {
      walkLocations(e, (loc) => all.push(...loc.assets.filter(fmatch)));
      all.push(...e.ungroupedAssets.filter(fmatch));
    }
    all.push(...unassigned.filter(fmatch));
    return all;
  }
  const [kind, id] = selected.split(":");
  if (kind === "ent") {
    const e = tree.find(x => x.id === id);
    if (!e) return [];
    const out = [...e.ungroupedAssets.filter(fmatch)];
    walkLocations(e, (loc) => out.push(...loc.assets.filter(fmatch)));
    return out;
  }
  if (kind === "loc") {
    const found = findLocationInTree(tree, id);
    if (!found) return [];
    return flattenLocationAssets(found.loc).filter(fmatch);
  }
  return [];
}

function selectedDescriptor(selected, tree) {
  const [kind, id] = (selected || "").split(":");
  if (kind === "ent") return tree.find(e => e.id === id)?.name || "";
  if (kind === "loc") {
    const found = findLocationInTree(tree, id);
    if (!found) return "";
    const path = [found.ent.name, ...found.ancestors.map(a => a.name), found.loc.name].join(" · ");
    return path;
  }
  return "";
}

function filterTree(tree, filter) {
  if (!filter) return tree;
  const f = filter.toLowerCase();
  const matches = (a) => a.name.toLowerCase().includes(f);
  function pruneLocation(loc) {
    const children = (loc.children || []).map(pruneLocation).filter(Boolean);
    const directAssets = loc.assets.filter(matches);
    const nameMatch = loc.name.toLowerCase().includes(f);
    if (!nameMatch && !directAssets.length && !children.length) return null;
    return { ...loc, assets: directAssets, children };
  }
  return tree.map(e => {
    const locations = e.locations.map(pruneLocation).filter(Boolean);
    const ungroupedAssets = e.ungroupedAssets.filter(matches);
    const nameMatch = e.name.toLowerCase().includes(f);
    if (!nameMatch && !locations.length && !ungroupedAssets.length) return null;
    return { ...e, locations, ungroupedAssets };
  }).filter(Boolean);
}

function cardGrid(assets) {
  if (!assets.length) {
    return el("div", { class: "muted", style: { padding: "32px", textAlign: "center" } }, [
      "No assets match.",
    ]);
  }
  return el("div", { class: "card-grid" }, assets.map(assetCard));
}

function assetCard(a) {
  const visual = a.visualFileId
    ? el("img", {
        src: `/api/files/${a.visualFileId}`,
        alt: a.name,
        loading: "lazy",
        style: { width: "100%", height: "120px", objectFit: "cover", borderRadius: "8px 8px 0 0", background: "#0d1116" },
      })
    : el("div", {
        class: "asset-card-placeholder",
        style: { width: "100%", height: "120px", display: "flex", alignItems: "center", justifyContent: "center", background: "linear-gradient(135deg, rgba(120,160,210,0.1), rgba(120,160,210,0.04))", borderRadius: "8px 8px 0 0", fontSize: "32px", color: "rgba(120,160,210,0.4)" },
      }, [glyphFor(a.type)]);

  return el("div", { class: "card asset-card", style: { padding: 0, overflow: "hidden", display: "flex", flexDirection: "column" } }, [
    visual,
    el("div", { class: "stack", style: { padding: "10px", gap: "6px", flex: 1 } }, [
      el("div", { class: "strong", style: { fontSize: "14px" } }, [a.name]),
      el("div", { class: "row wrap", style: { gap: "6px" } }, [
        a.type ? badge(a.type, "info") : null,
        a.status ? badge(a.status, statusVariant(a.status)) : null,
        a.profileVersionId ? badge("profile", "purple", { title: a.profileVersionId }) : null,
      ]),
      el("div", { class: "row", style: { marginTop: "auto", gap: "6px" } }, [
        el("button", { class: "btn sm primary", onClick: () => navigate(`/asset/${a.id}`) }, ["View data"]),
        el("button", { class: "btn sm", onClick: () => navigate(`/asset/${a.id}?tab=config`) }, ["Edit"]),
        el("button", { class: "btn sm ghost", title: "Upload visual", onClick: () => uploadVisual(a) }, ["📷"]),
      ]),
    ]),
  ]);
}

function glyphFor(type) {
  const t = String(type || "").toLowerCase();
  if (t.includes("pump")) return "⚙";
  if (t.includes("valve")) return "✜";
  if (t.includes("motor")) return "◐";
  if (t.includes("sensor")) return "⌖";
  return "◇";
}

function statusVariant(s) {
  return s === "alarm" ? "danger" : s === "warning" ? "warn" : s === "offline" ? "" : "success";
}

function summaryPanel(selected, tree, unassigned) {
  if (!selected) {
    return card("Selection", el("div", { class: "stack" }, [
      el("p", { class: "muted tiny" }, ["Click an enterprise or location to filter the grid. Click an asset card to open its detail screen."]),
      el("p", { class: "muted tiny" }, ["The grid scales with the asset count — IntersectionObserver-driven chart lazy-init lands in phase 6 once binding wiring is in place."]),
    ]));
  }
  const [kind, id] = selected.split(":");
  if (kind === "ent") {
    const e = tree.find(x => x.id === id);
    if (!e) return card("Selection", el("div", { class: "muted" }, ["Selection no longer exists."]));
    let totalAssets = e.ungroupedAssets.length;
    let totalLocations = 0;
    walkLocations(e, (loc) => { totalAssets += loc.assets.length; totalLocations += 1; });
    return card(e.name, el("div", { class: "stack" }, [
      el("div", { class: "tiny muted" }, [e.description || ""]),
      kpi("Locations", totalLocations),
      kpi("Assets", totalAssets),
      el("div", { class: "row wrap" }, [
        el("button", { class: "btn sm", onClick: () => renameEnterprisePrompt(e) }, ["Rename"]),
        el("button", { class: "btn sm danger", onClick: () => deleteEnterprise(e) }, ["Delete"]),
      ]),
    ]));
  }
  if (kind === "loc") {
    const found = findLocationInTree(tree, id);
    if (!found) return card("Selection", el("div", { class: "muted" }, ["Selection no longer exists."]));
    const { ent, loc, ancestors } = found;
    const breadcrumb = [ent.name, ...ancestors.map(a => a.name)].join(" › ");
    const sub = countLocSubtree(loc);
    return card(loc.name, el("div", { class: "stack" }, [
      el("div", { class: "tiny muted" }, [`${breadcrumb}${loc.kind ? ` · ${loc.kind}` : ""}`]),
      kpi("Direct assets", loc.assets.length),
      kpi("Total (incl. sub-locations)", sub.assets),
      sub.locations > 0 ? kpi("Sub-locations", sub.locations) : null,
      el("div", { class: "row wrap" }, [
        el("button", { class: "btn sm", onClick: () => renameLocationPrompt(loc) }, ["Rename"]),
        el("button", { class: "btn sm danger", onClick: () => deleteLocation(loc) }, ["Delete"]),
      ]),
    ]));
  }
  return card("Selection", el("div", { class: "muted" }, ["Unknown selection."]));
}

// ----- mutations -------------------------------------------------------

async function createEnterprisePrompt() {
  const name = await prompt({ title: "New enterprise", message: "Name your enterprise (top-level grouping for assets).", confirmLabel: "Create" });
  if (!name) return;
  try {
    await api("/api/enterprises", { method: "POST", body: { name } });
    toast("Enterprise created", "success");
    renderAssetDashboard();
  } catch (err) {
    toast(`Create failed: ${err?.message || err}`, "warn");
  }
}

async function createLocationPrompt() {
  // Prompt for an enterprise picker + optional parent location +
  // name + kind. Users can build the full ISA-95 chain
  // (Enterprise → Site → Area → Line → Cell) by repeatedly picking
  // the previously-created location as the parent. We pre-fill from
  // the current sessionStorage selection where possible: a selected
  // location pre-picks itself as the parent; a selected enterprise
  // pre-picks itself with no parent.
  const tree = await api("/api/asset-tree").catch(() => ({ tree: [] }));
  if (!tree.tree.length) {
    toast("Create an enterprise first.", "warn");
    return;
  }
  const selected = sessionStorage.getItem(SS_SELECTED_NODE) || "";
  let chosenEnterpriseId = null;
  let chosenParentLocationId = null;
  if (selected.startsWith("ent:")) {
    chosenEnterpriseId = selected.slice(4);
  } else if (selected.startsWith("loc:")) {
    const found = findLocationInTree(tree.tree, selected.slice(4));
    if (found) {
      chosenEnterpriseId = found.ent.id;
      chosenParentLocationId = found.loc.id;
    }
  }
  if (!chosenEnterpriseId) chosenEnterpriseId = tree.tree[0].id;
  let chosenName = "";
  let kind = chosenParentLocationId ? "" : "site";

  const entSel = el("select", { class: "select" });
  for (const e of tree.tree) {
    const opt = document.createElement("option");
    opt.value = e.id;
    opt.textContent = e.name;
    if (e.id === chosenEnterpriseId) opt.selected = true;
    entSel.append(opt);
  }

  const parentSel = el("select", { class: "select" });
  function refillParents() {
    parentSel.innerHTML = "";
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = "(none — top-level under enterprise)";
    parentSel.append(blank);
    const ent = tree.tree.find(x => x.id === entSel.value);
    if (ent) {
      walkLocations(ent, (loc, depth, ancestors) => {
        const opt = document.createElement("option");
        opt.value = loc.id;
        opt.textContent = `${"— ".repeat(depth - 1)}${loc.name}${loc.kind ? ` (${loc.kind})` : ""}`;
        if (loc.id === chosenParentLocationId) opt.selected = true;
        parentSel.append(opt);
      });
    }
  }
  refillParents();
  entSel.addEventListener("change", () => { chosenEnterpriseId = entSel.value; chosenParentLocationId = ""; refillParents(); });
  parentSel.addEventListener("change", () => { chosenParentLocationId = parentSel.value || null; });

  const nameInput = input({ placeholder: "Plant 1 / Area 1 / Line A …", onInput: (e) => { chosenName = e.target.value; } });
  const kindInput = input({ value: kind, placeholder: "site / area / line / cell", onInput: (e) => { kind = e.target.value; } });

  modal({
    title: "New location",
    body: el("div", { class: "stack" }, [
      formRow("Enterprise", entSel),
      formRow("Parent location (for ISA-95 chains)", parentSel),
      formRow("Name", nameInput),
      formRow("Kind (free text — site / area / line / cell)", kindInput),
    ]),
    actions: [
      { label: "Cancel" },
      { label: "Create", variant: "primary", onClick: async () => {
        if (!chosenName.trim()) { toast("Name required", "warn"); return false; }
        try {
          await api("/api/locations", { method: "POST", body: {
            enterpriseId: chosenEnterpriseId,
            parentLocationId: chosenParentLocationId || null,
            name: chosenName.trim(),
            kind: kind.trim() || null,
          }});
          toast("Location created", "success");
          renderAssetDashboard();
        } catch (err) {
          toast(`Create failed: ${err?.message || err}`, "warn");
          return false;
        }
      }},
    ],
  });
}

async function createAssetPrompt() {
  const tree = await api("/api/asset-tree").catch(() => ({ tree: [] }));
  const selected = sessionStorage.getItem(SS_SELECTED_NODE) || "";
  let chosenEnterpriseId = selected.startsWith("ent:") ? selected.slice(4) : (tree.tree[0]?.id || null);
  let chosenLocationId = null;
  if (selected.startsWith("loc:")) {
    chosenLocationId = selected.slice(4);
    for (const e of tree.tree) {
      if (e.locations.some(l => l.id === chosenLocationId)) { chosenEnterpriseId = e.id; break; }
    }
  }

  const entSel = el("select", { class: "select" });
  for (const e of tree.tree) {
    const opt = document.createElement("option");
    opt.value = e.id;
    opt.textContent = e.name;
    if (e.id === chosenEnterpriseId) opt.selected = true;
    entSel.append(opt);
  }
  const locSel = el("select", { class: "select" });
  function refillLocations() {
    locSel.innerHTML = "";
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = "(none)";
    locSel.append(blank);
    const ent = tree.tree.find(x => x.id === entSel.value);
    if (ent) {
      walkLocations(ent, (loc, depth) => {
        const opt = document.createElement("option");
        opt.value = loc.id;
        opt.textContent = `${"— ".repeat(depth - 1)}${loc.name}${loc.kind ? ` (${loc.kind})` : ""}`;
        if (loc.id === chosenLocationId) opt.selected = true;
        locSel.append(opt);
      });
    }
  }
  refillLocations();
  entSel.addEventListener("change", () => { chosenEnterpriseId = entSel.value; chosenLocationId = ""; refillLocations(); });
  locSel.addEventListener("change", () => { chosenLocationId = locSel.value; });
  const nameInput = input({ placeholder: "Pump-A" });
  const typeInput = input({ placeholder: "pump / valve / motor / sensor" });

  modal({
    title: "New asset",
    body: el("div", { class: "stack" }, [
      formRow("Enterprise", entSel),
      formRow("Location", locSel),
      formRow("Name", nameInput),
      formRow("Type (free text)", typeInput),
    ]),
    actions: [
      { label: "Cancel" },
      { label: "Create", variant: "primary", onClick: async () => {
        const name = nameInput.value.trim();
        if (!name) { toast("Name required", "warn"); return false; }
        try {
          await api("/api/assets", {
            method: "POST",
            body: {
              name,
              type: typeInput.value.trim() || null,
              enterpriseId: chosenEnterpriseId || null,
              locationId: locSel.value || null,
            },
          });
          toast("Asset created", "success");
          renderAssetDashboard();
        } catch (err) {
          toast(`Create failed: ${err?.message || err}`, "warn");
          return false;
        }
      }},
    ],
  });
}

async function renameEnterprisePrompt(e) {
  const newName = await prompt({ title: `Rename ${e.name}`, defaultValue: e.name, confirmLabel: "Rename" });
  if (!newName || newName === e.name) return;
  try {
    const resp = await api(`/api/enterprises/${e.id}`, { method: "PATCH", body: { name: newName } });
    if (resp.affectedBindings && resp.affectedBindings > 0) {
      const reresolveModal = await import("./renameReResolveModal.js");
      reresolveModal.openReResolveModal({
        kind: "enterprise",
        id: e.id,
        oldName: e.name,
        newName,
        affectedBindings: resp.affectedBindings,
        sample: resp.sample || [],
        onComplete: () => renderAssetDashboard(),
      });
    } else {
      toast("Renamed", "success");
      renderAssetDashboard();
    }
  } catch (err) {
    toast(`Rename failed: ${err?.message || err}`, "warn");
  }
}

async function renameLocationPrompt(l) {
  const newName = await prompt({ title: `Rename ${l.name}`, defaultValue: l.name, confirmLabel: "Rename" });
  if (!newName || newName === l.name) return;
  try {
    const resp = await api(`/api/locations/${l.id}`, { method: "PATCH", body: { name: newName } });
    if (resp.affectedBindings && resp.affectedBindings > 0) {
      const reresolveModal = await import("./renameReResolveModal.js");
      reresolveModal.openReResolveModal({
        kind: "location",
        id: l.id,
        oldName: l.name,
        newName,
        affectedBindings: resp.affectedBindings,
        sample: resp.sample || [],
        onComplete: () => renderAssetDashboard(),
      });
    } else {
      toast("Renamed", "success");
      renderAssetDashboard();
    }
  } catch (err) {
    toast(`Rename failed: ${err?.message || err}`, "warn");
  }
}

async function deleteEnterprise(e) {
  const ok = await confirm({ title: "Delete enterprise", message: `Delete ${e.name}? This is refused if any assets reference it.`, confirmLabel: "Delete", variant: "danger" });
  if (!ok) return;
  try {
    await api(`/api/enterprises/${e.id}`, { method: "DELETE" });
    toast("Deleted", "success");
    sessionStorage.removeItem(SS_SELECTED_NODE);
    renderAssetDashboard();
  } catch (err) {
    if (err?.status === 409) {
      toast(`Refused: ${err.body?.count || "?"} asset(s) still reference this enterprise.`, "warn");
    } else {
      toast(`Delete failed: ${err?.message || err}`, "warn");
    }
  }
}

async function deleteLocation(l) {
  const ok = await confirm({ title: "Delete location", message: `Delete ${l.name}? This is refused if any assets reference it.`, confirmLabel: "Delete", variant: "danger" });
  if (!ok) return;
  try {
    await api(`/api/locations/${l.id}`, { method: "DELETE" });
    toast("Deleted", "success");
    sessionStorage.removeItem(SS_SELECTED_NODE);
    renderAssetDashboard();
  } catch (err) {
    if (err?.status === 409) {
      toast(`Refused: ${err.body?.count || "?"} asset(s) still reference this location.`, "warn");
    } else {
      toast(`Delete failed: ${err?.message || err}`, "warn");
    }
  }
}

async function uploadVisual(asset) {
  // Mirror docViewer.js's hidden file-input pattern.
  const fi = el("input", { type: "file", accept: "image/png,image/jpeg,image/bmp", style: { display: "none" } });
  document.body.append(fi);
  fi.addEventListener("change", async () => {
    const f = fi.files?.[0];
    fi.remove();
    if (!f) return;
    try {
      const fd = new FormData();
      fd.append("parent_kind", "asset");
      fd.append("parent_id", asset.id);
      fd.append("file", f, f.name);
      /** @type {Record<string, string>} */
      const headers = {};
      const tok = (await import("../core/api.js")).getToken?.();
      if (tok) headers["Authorization"] = `Bearer ${tok}`;
      const r = await fetch("/api/files", { method: "POST", headers, body: fd });
      if (!r.ok) throw new Error(await r.text());
      const meta = await r.json();
      await api(`/api/assets/${asset.id}`, { method: "PATCH", body: { visualFileId: meta.id } });
      toast("Visual uploaded", "success");
      renderAssetDashboard();
    } catch (err) {
      toast(`Upload failed: ${err?.message || err}`, "warn");
    }
  });
  fi.click();
}
