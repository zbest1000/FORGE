// Search v2 — spec §15.
//
// BM25 + substring fallback, ACL-filtered, with facet rail and saved
// searches. Query state is deep-linkable via `#/search?q=...&kind=Asset`.

import { el, mount, card, badge, toast, input } from "../core/ui.js";
import { state } from "../core/store.js";
import { navigate } from "../core/router.js";
import { query, saveSearch, listSavedSearches, deleteSavedSearch } from "../core/search.js";

const FACETS = [
  { key: "kind",      label: "Object type" },
  { key: "status",    label: "Status" },
  { key: "discipline",label: "Discipline" },
  { key: "project",   label: "Project" },
  { key: "teamSpace", label: "Team space" },
];

export function renderSearch() {
  const root = document.getElementById("screenContainer");

  const params = new URLSearchParams((state.route.split("?")[1] || ""));
  const q = params.get("q") || "";
  const selected = {};
  for (const f of FACETS) {
    const v = params.get(f.key);
    if (v) selected[f.key] = v.split(",");
  }

  const qInput = input({ placeholder: "Search objects, messages, revisions...", value: q });
  qInput.addEventListener("input", () => {
    const next = new URLSearchParams(params);
    next.set("q", qInput.value);
    writeUrl(next);
  });

  const result = query(q, { facets: selected, limit: 100 });

  mount(root, [
    el("div", { class: "row spread", style: { marginBottom: "12px" } }, [
      el("div", {}, [
        el("div", { class: "strong" }, ["Search"]),
        el("div", { class: "tiny muted" }, [`${result.total} results · BM25 + facet filter`]),
      ]),
      el("div", { class: "row" }, [
        el("button", { class: "btn sm", onClick: () => doSave(q, selected) }, ["Save search"]),
      ]),
    ]),

    el("div", { style: { display: "grid", gridTemplateColumns: "260px 1fr", gap: "12px" } }, [
      facetRail(result.facetCounts, selected, params),
      card("Results", el("div", { class: "stack" }, [
        qInput,
        ...result.hits.map(h => el("div", { class: "activity-row", onClick: () => navigate(h.route) }, [
          badge(h.kind, "info"),
          el("div", { class: "stack", style: { gap: "2px", flex: 1 } }, [
            el("span", { class: "small" }, [h.title]),
            el("span", { class: "tiny muted" }, [h.snippet]),
          ]),
          el("span", { class: "tiny muted mono" }, [h.id]),
          el("span", { class: "tiny muted" }, [h.score ? h.score.toFixed(2) : ""]),
        ])),
        result.hits.length ? null : el("div", { class: "muted tiny" }, ["No matches. Try another query or remove facet filters."]),
      ])),
    ]),

    savedSearchesCard(),
  ]);
  setTimeout(() => qInput.focus(), 0);
}

function writeUrl(params) {
  location.hash = "#/search?" + params.toString();
}

function facetRail(counts, selected, params) {
  const panels = FACETS.map(f => {
    const entries = Object.entries(counts[f.key] || {}).sort((a, b) => b[1] - a[1]).slice(0, 8);
    if (!entries.length) return null;
    return card(f.label, el("div", { class: "stack" }, entries.map(([val, n]) => {
      const active = (selected[f.key] || []).includes(val);
      return el("label", { class: "row", style: { gap: "6px", cursor: "pointer" } }, [
        el("input", {
          type: "checkbox",
          checked: active,
          onChange: () => toggleFacet(params, f.key, val),
        }),
        el("span", { class: "small", style: { flex: 1 } }, [val]),
        el("span", { class: "tiny muted" }, [String(n)]),
      ]);
    })));
  }).filter(Boolean);
  return el("div", { class: "stack" }, panels);
}

function toggleFacet(params, key, val) {
  const current = (params.get(key) || "").split(",").filter(Boolean);
  const s = new Set(current);
  if (s.has(val)) s.delete(val); else s.add(val);
  const next = new URLSearchParams(params);
  if (s.size) next.set(key, [...s].join(",")); else next.delete(key);
  writeUrl(next);
}

function doSave(q, selected) {
  const name = window.prompt("Name this saved search:");
  if (!name) return;
  saveSearch(name, q, selected);
  toast("Saved", "success");
}

function savedSearchesCard() {
  const list = listSavedSearches();
  if (!list.length) return el("div", {});
  return card("Saved searches", el("div", { class: "stack" }, list.map(s => el("div", { class: "activity-row", onClick: () => runSaved(s) }, [
    badge("saved", "info"),
    el("span", { class: "small" }, [s.name]),
    el("span", { class: "tiny muted" }, [`q: "${s.query}"`]),
    el("button", { class: "btn sm ghost", onClick: (e) => { e.stopPropagation(); deleteSavedSearch(s.id); renderSearch(); } }, ["×"]),
  ]))));
}

function runSaved(s) {
  const p = new URLSearchParams();
  if (s.query) p.set("q", s.query);
  for (const [k, vals] of Object.entries(s.facets || {})) if (vals?.length) p.set(k, vals.join(","));
  writeUrl(p);
}
