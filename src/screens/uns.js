// Unified Namespace browser.
// Shows the hierarchical instance graph with live values pulled from the i3X server.

import { el, mount, card, badge, chip, toast, prompt, confirm } from "../core/ui.js";
import { state } from "../core/store.js";
import { navigate } from "../core/router.js";
import { i3x, getServer } from "../core/i3x/client.js";
import { parentPath } from "../core/i3x/uns.js";
import { sparkline as chartSpark } from "../core/charts.js";
import { helpHint, helpLinkChip } from "../core/help.js";

export function renderUNSIndex() {
  const srv = getServer();
  const info = srv.getInfo().data;
  const objects = srv.getObjects({ includeMetadata: true }).data;

  const selectedKey = "uns.selected";
  const selectedId = sessionStorage.getItem(selectedKey) || pickDefault(objects);

  const root = document.getElementById("screenContainer");

  // Wrap the live-value card in a stable host element so the live-tick
  // refresher (driven from app.js) can swap its contents without tearing
  // down the surrounding DOM. Without this, the entire screen used to be
  // re-rendered every 1.5s, which reset scroll position so users couldn't
  // browse the namespace tree on long pages.
  const liveHost = el("div", { id: "uns-live-host", class: "uns-live-host" }, [renderLiveCard(selectedId)]);

  mount(root, [
    headerRow(info),
    el("div", { class: "three-col" }, [
      card("Namespace tree", renderTree(objects, selectedId, (id) => {
        sessionStorage.setItem(selectedKey, id);
        renderUNSIndex();
      }), { subtitle: "ISA-95 hierarchy · i3X composition graph" }),
      renderDetailCard(selectedId, objects),
      liveHost,
    ]),
  ]);
}

/**
 * Refresh ONLY the live-value card without touching the rest of the DOM.
 * Driven by the slow-cadence interval in app.js — keeps VQT values fresh
 * while leaving scroll position, focus, and tree expand-state intact.
 *
 * Returns true if anything was updated (so the caller knows whether the
 * screen is still on /uns).
 */
export function refreshUNSLive() {
  const host = document.getElementById("uns-live-host");
  if (!host) return false;
  const selectedKey = "uns.selected";
  const selectedId = sessionStorage.getItem(selectedKey);
  if (!selectedId) return false;
  host.replaceChildren(renderLiveCard(selectedId));
  return true;
}

function headerRow(info) {
  return el("div", { class: "row spread", style: { marginBottom: "12px" } }, [
    el("div", {}, [
      el("h2", { style: { display: "inline-flex", alignItems: "center", margin: 0, fontSize: "18px" } }, [
        "Unified Namespace", helpHint("forge.uns"),
      ]),
      el("div", { class: "tiny muted" }, [
        `${info.namespaces} namespaces · ${info.objectTypes} types · ${info.relationshipTypes} rels · ${info.objects} objects · i3X ${info.version}`,
      ]),
      el("div", { class: "row wrap", style: { gap: "6px", marginTop: "6px" } }, [
        helpLinkChip("forge.uns", "Unified Namespace"),
        helpLinkChip("forge.uns.path", "UNS path conventions"),
        helpLinkChip("forge.isa95", "ISA-95 hierarchy"),
      ]),
    ]),
    el("div", { class: "row" }, [
      badge("i3X: Beta 1.0", "accent"),
      badge("UNS: active", "success"),
      el("button", { class: "btn sm", onClick: () => navigate("/i3x") }, ["i3X API →"]),
    ]),
  ]);
}

function pickDefault(objects) {
  const eq = objects.find(o => o.typeElementId === "isa95:Equipment");
  return (eq && eq.elementId) || objects[0].elementId;
}

function renderTree(objects, selectedId, onSelect) {
  const childrenOf = (parentPathStr) => {
    return objects.filter(o => parentPath(o.path) === parentPathStr).sort((a, b) => a.path.localeCompare(b.path));
  };
  const roots = objects.filter(o => !objects.some(p => p.path === parentPath(o.path)))
    .sort((a, b) => a.path.localeCompare(b.path));

  const wrap = el("div", { class: "stack", style: { gap: "2px" } });
  function walk(parentPathStr, indent = 0) {
    const list = parentPathStr === null
      ? roots
      : childrenOf(parentPathStr);
    for (const o of list) {
      wrap.append(el("button", {
    type: "button",
    class: `tree-item ${o.elementId === selectedId ? "active" : ""}`,
        style: { paddingLeft: (8 + indent * 12) + "px" },
        onClick: () => onSelect(o.elementId),
      }, [
        el("span", { class: "tree-dot" }),
        el("span", { class: "tree-label" }, [o.name]),
        typeBadge(o.typeElementId),
      ]));
      walk(o.path, indent + 1);
    }
  }
  walk(null, 0);
  return wrap;
}

function typeBadge(t) {
  const short = (t || "").split(":").pop();
  const v = t?.startsWith("signals:") ? "accent"
    : t === "isa95:Equipment" ? "info"
    : t?.startsWith("forge:") ? "purple"
    : "";
  return el("span", { class: `badge ${v}`.trim() }, [short]);
}

function renderDetailCard(elementId, objects) {
  const srv = getServer();
  const o = objects.find(x => x.elementId === elementId);
  if (!o) return card("Detail", el("div", { class: "muted" }, ["Select a node."]));

  const related = srv.queryRelatedObjects({ elementIds: [elementId] }).results[0];
  const rels = (related?.result || []);

  const aliases = (o.metadata?.aliases || []).filter(a => a !== o.elementId && a !== o.path && a !== o.name);

  return card(o.name || o.elementId, el("div", { class: "stack" }, [
    el("div", { class: "tiny muted" }, [o.typeElementId, " · ", o.namespaceUri]),
    el("div", { class: "mono small" }, [o.path]),
    el("div", { class: "row wrap" }, [
      ...Object.entries(o.attributes || {}).map(([k, v]) =>
        chip(String(v), { kind: k })
      ),
    ]),
    aliases.length ? el("div", {}, [
      el("div", { class: "tiny muted" }, ["Aliases / alternate addresses"]),
      el("div", { class: "row wrap" }, aliases.map(a => chip(a, { kind: aliasKind(a) }))),
    ]) : null,
    el("div", {}, [
      el("div", { class: "tiny muted" }, ["Relationships"]),
      el("div", { class: "stack", style: { gap: "2px" } }, rels.length ? rels.map(r => {
        const label = r.object.name || r.object.elementId;
        return el("button", { class: "activity-row", type: "button", onClick: () => {
          sessionStorage.setItem("uns.selected", r.object.elementId);
          renderUNSIndex();
        }}, [
          badge(r.relationshipType.replace(/^rel:/, ""), "info"),
          el("span", {}, [label]),
          el("span", { class: "tiny muted" }, [r.object.path]),
        ]);
      }) : [el("div", { class: "muted tiny" }, ["(none)"])]),
    ]),
    crossLinkRow(o),
    el("div", {}, [
      el("div", { class: "tiny muted" }, ["i3X elementId"]),
      el("div", { class: "mono small" }, [o.elementId]),
      el("button", { class: "btn sm", onClick: () => { navigator.clipboard?.writeText(o.elementId); toast("ElementId copied", "success"); } }, ["Copy"]),
    ]),
  ]));
}

function aliasKind(a) {
  if (a.startsWith("ns=")) return "OPC UA";
  if (a.includes("/")) return "MQTT";
  return "ID";
}

function crossLinkRow(o) {
  const meta = o.metadata || {};
  const links = [];
  if (meta.forgeAssetId)    links.push({ label: "Open asset →",    route: `/asset/${meta.forgeAssetId}` });
  if (meta.forgeDocId)      links.push({ label: "Open document →", route: `/doc/${meta.forgeDocId}` });
  if (meta.forgeDrawingId)  links.push({ label: "Open drawing →",  route: `/drawing/${meta.forgeDrawingId}` });
  if (meta.forgeIncidentId) links.push({ label: "Open incident →", route: `/incident/${meta.forgeIncidentId}` });
  if (!links.length) return null;
  return el("div", { class: "row wrap" }, links.map(l =>
    el("button", { class: "btn sm", onClick: () => navigate(l.route) }, [l.label])
  ));
}

function renderLiveCard(elementId) {
  const srv = getServer();
  const current = srv.queryLastKnownValues({ elementIds: [elementId], maxDepth: 0 }).results[0];
  const history = srv.getHistoricalValues(elementId, { maxDepth: 1 });
  const result = current?.result;
  const obj = srv.resolveObject(elementId);

  if (!obj) return card("Live", el("div", { class: "muted" }, ["Unknown."]));

  const isVar = obj.typeElementId === "signals:Variable" || obj.typeElementId === "signals:Alarm";

  const body = el("div", { class: "stack" });

  if (isVar) {
    const vq = result;
    body.append(
      el("div", { class: "row wrap" }, [
        el("span", { class: "kpi-value", style: { fontSize: "28px" } }, [String(vq?.value ?? "—")]),
        el("span", { class: "tiny muted" }, [obj.attributes?.unit || ""]),
        badge(vq?.quality || "—", qualityVariant(vq?.quality)),
      ]),
      el("div", { class: "tiny muted" }, [vq?.timestamp ? new Date(vq.timestamp).toLocaleTimeString() : ""]),
      chartSpark((history.data?.values || []).map(v => Number(v.value) || 0), { width: 280, height: 60 }),
      el("div", { class: "row wrap" }, [
        el("button", { class: "btn sm", onClick: () => writeValue(obj) }, ["Write value"]),
        el("button", { class: "btn sm", onClick: () => openSubscribe(obj) }, ["Subscribe → i3X API"]),
      ]),
    );
  } else {
    // Composition: show a rollup from maxDepth=2 so user can see descendant variables.
    const roll = srv.queryLastKnownValues({ elementIds: [elementId], maxDepth: 2 }).results[0]?.result;
    const comps = roll?.components || {};
    body.append(
      el("div", { class: "tiny muted" }, ["Composition — live rollup (maxDepth=2)"]),
      ...(Object.keys(comps).length
        ? Object.entries(comps).map(([k, v]) => el("div", { class: "activity-row" }, [
            el("span", { class: "mono tiny" }, [k]),
            el("span", { class: "strong" }, [String(v.value ?? "—")]),
            badge(v.quality || "—", qualityVariant(v.quality)),
          ]))
        : [el("div", { class: "muted tiny" }, ["No child variables."])]
      )
    );
  }

  // The dead setTimeout block previously here was a no-op; the actual
  // refresh now happens via `refreshUNSLive()` driven from app.js. Leaving
  // the function pure makes that surgical update path simpler.

  return card("Live value / VQT", body, { subtitle: "i3X /objects/value + /history" });
}

function qualityVariant(q) {
  if (q === "Good") return "success";
  if (q === "Uncertain") return "warn";
  if (q === "Bad") return "danger";
  return "";
}

function sparkline(values) {
  if (!values.length) return el("div", { class: "tiny muted" }, ["No history yet."]);
  const nums = values.map(v => Number(v.value) || 0);
  const min = Math.min(...nums), max = Math.max(...nums);
  const range = max - min || 1;
  const W = 280, H = 50;
  const points = nums.map((v, i) => {
    const x = (i / (nums.length - 1 || 1)) * W;
    const y = H - ((v - min) / range) * (H - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, width: "100%", height: "50px" });
  svg.innerHTML = `<polyline points="${points}" fill="none" stroke="var(--accent)" stroke-width="1.5"/>`;
  return svg;
}

async function writeValue(obj) {
  const raw = await prompt({ title: `Write to ${obj.name}`, message: `Current unit: ${obj.attributes?.unit || "?"}`, placeholder: "value" });
  if (raw == null) return;
  const ok = await confirm({
    title: "Confirm UNS write",
    message: `Write to ${obj.name} (${obj.elementId})?\n\nThe change is recorded in the audit ledger.`,
    confirmLabel: "Write",
    variant: "danger",
  });
  if (!ok) return;
  let parsed = raw;
  if (obj.attributes?.dataType === "Boolean") parsed = /^(1|true|yes)$/i.test(raw);
  else if (!isNaN(Number(raw))) parsed = Number(raw);
  const r = i3x.putValue(obj.elementId, { value: parsed, quality: "Good" });
  if (r.success) toast("PUT /objects/{id}/value 200", "success");
  else toast("Write failed: " + r.error?.message, "danger");
}

function openSubscribe(obj) {
  sessionStorage.setItem("i3x.presubscribe", obj.elementId);
  navigate("/i3x");
}
