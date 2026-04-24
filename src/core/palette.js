// Command palette: quick navigation to objects and screens.

import { el, clear } from "./ui.js";
import { state } from "./store.js";
import { navigate } from "./router.js";
import { SCREEN_ROUTES } from "./screens-registry.js";
import { getServer } from "./i3x/client.js";

let open = false;

export function openPalette() {
  const root = document.getElementById("paletteRoot");
  if (!root || open) return;
  open = true;

  const results = el("div", { class: "palette-results" });
  const input = el("input", {
    placeholder: "Jump to object, screen, or command (/go D-101, @JS)",
    autofocus: true,
  });

  let activeIdx = 0;
  const allEntries = collectEntries();

  function render(query) {
    const q = (query || "").trim().toLowerCase();
    const matched = q
      ? allEntries.filter(e => (e.label + " " + (e.kind || "") + " " + (e.meta || "")).toLowerCase().includes(q))
      : allEntries.slice(0, 30);

    clear(results);
    matched.slice(0, 60).forEach((entry, i) => {
      results.append(
        el(
          "div",
          {
            class: `palette-item ${i === activeIdx ? "active" : ""}`,
            onClick: () => run(entry),
            onMouseover: () => {
              activeIdx = i;
              [...results.children].forEach((c, j) => c.classList.toggle("active", i === j));
            },
          },
          [
            el("div", {}, [
              el("div", {}, [entry.label]),
              entry.meta ? el("div", { class: "tiny muted" }, [entry.meta]) : null,
            ]),
            el("div", { class: "pi-kind" }, [entry.kind || ""]),
          ]
        )
      );
    });
    return matched;
  }

  let matched = render("");

  const backdrop = el("div", {
    class: "palette-backdrop",
    onClick: (e) => { if (e.target === backdrop) close(); },
  }, [
    el("div", { class: "palette" }, [
      input,
      results,
    ]),
  ]);

  input.addEventListener("input", (e) => {
    activeIdx = 0;
    matched = render(e.target.value);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "ArrowDown") {
      e.preventDefault();
      activeIdx = Math.min(matched.length - 1, activeIdx + 1);
      matched = render(input.value);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      activeIdx = Math.max(0, activeIdx - 1);
      matched = render(input.value);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (matched[activeIdx]) run(matched[activeIdx]);
    }
  });

  root.append(backdrop);
  setTimeout(() => input.focus(), 0);

  function close() {
    open = false;
    clear(root);
  }

  function run(entry) {
    close();
    if (entry.route) navigate(entry.route);
  }
}

function collectEntries() {
  const d = state.data || {};
  const entries = [];

  for (const [label, route] of Object.entries(SCREEN_ROUTES)) {
    entries.push({ label, kind: "Screen", route });
  }

  (d.teamSpaces || []).forEach(t =>
    entries.push({ label: t.name, kind: "Team Space", meta: t.id, route: `/team-space/${t.id}` })
  );
  (d.channels || []).forEach(c =>
    entries.push({ label: `#${c.name}`, kind: "Channel", meta: c.id, route: `/channel/${c.id}` })
  );
  (d.projects || []).forEach(p =>
    entries.push({ label: p.name, kind: "Project", meta: p.id, route: `/work-board/${p.id}` })
  );
  (d.documents || []).forEach(doc =>
    entries.push({ label: doc.name, kind: "Document", meta: doc.id, route: `/doc/${doc.id}` })
  );
  (d.drawings || []).forEach(dr =>
    entries.push({ label: dr.name, kind: "Drawing", meta: dr.id, route: `/drawing/${dr.id}` })
  );
  (d.assets || []).forEach(a =>
    entries.push({ label: a.name, kind: "Asset", meta: a.id, route: `/asset/${a.id}` })
  );
  (d.incidents || []).forEach(i =>
    entries.push({ label: i.title, kind: "Incident", meta: i.id, route: `/incident/${i.id}` })
  );

  try {
    const srv = getServer();
    const objects = srv.getObjects({}).data || [];
    objects.forEach(o => {
      entries.push({
        label: o.name || o.elementId,
        kind: "UNS:" + (o.typeElementId || "").split(":").pop(),
        meta: o.path,
        route: `/uns`,
      });
    });
  } catch { /* server not ready yet */ }

  return entries;
}
