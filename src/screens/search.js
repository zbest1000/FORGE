import { el, mount, card, badge, input } from "../core/ui.js";
import { state } from "../core/store.js";
import { navigate } from "../core/router.js";

export function renderSearch() {
  const root = document.getElementById("screenContainer");
  const d = state.data;

  const params = new URLSearchParams((state.route.split("?")[1] || ""));
  const initialQuery = params.get("q") || "";

  const queryInput = input({ placeholder: "Search objects, messages, revisions...", value: initialQuery });
  const results = el("div", { class: "stack" });

  queryInput.addEventListener("input", () => runSearch(queryInput.value));
  setTimeout(() => queryInput.focus(), 0);

  mount(root, [
    card("Search", el("div", { class: "stack" }, [
      queryInput,
      results,
    ]), { subtitle: "Hybrid keyword + semantic (mock) · facets via filter chips" }),
  ]);

  runSearch(initialQuery);

  function runSearch(q) {
    q = (q || "").toLowerCase().trim();
    mount(results, []);
    if (!q) {
      results.append(el("div", { class: "muted tiny" }, ["Enter a query — try 'valve', 'incident', 'hx-01'."]));
      return;
    }
    const kinds = [
      { kind: "Document",    items: d.documents, label: x => x.name, route: x => `/doc/${x.id}` },
      { kind: "Drawing",     items: d.drawings,  label: x => x.name, route: x => `/drawing/${x.id}` },
      { kind: "Asset",       items: d.assets,    label: x => `${x.name} — ${x.hierarchy}`, route: x => `/asset/${x.id}` },
      { kind: "Work Item",   items: d.workItems, label: x => `${x.id} · ${x.title}`, route: x => `/work-board/${x.projectId}` },
      { kind: "Incident",    items: d.incidents, label: x => `${x.id} · ${x.title}`, route: x => `/incident/${x.id}` },
      { kind: "Revision",    items: d.revisions, label: x => `${x.id} · ${x.summary || ""}`, route: x => `/doc/${x.docId}` },
      { kind: "Message",     items: d.messages,  label: x => x.text, route: x => `/channel/${x.channelId}` },
    ];

    let total = 0;
    kinds.forEach(group => {
      const matches = (group.items || []).filter(x => group.label(x).toLowerCase().includes(q));
      if (!matches.length) return;
      total += matches.length;
      results.append(card(`${group.kind} · ${matches.length}`, el("div", { class: "activity-list" },
        matches.slice(0, 8).map(m =>
          el("div", { class: "activity-row", onClick: () => navigate(group.route(m)) }, [
            badge(group.kind, "info"),
            el("span", {}, [group.label(m)]),
            el("span", { class: "tiny muted" }, [m.id || ""]),
          ])
        )
      )));
    });
    if (!total) results.append(el("div", { class: "muted tiny" }, ["No results."]));
  }
}
