// In-app documentation site.
//
// Routed at `/help`. URL takes an optional `?topic=<id>` query that
// scrolls + highlights that topic on load. Open from anywhere via
// `openHelpTopic(id)` from `src/core/help.js` — that helper always
// opens a NEW browser tab so operators can compare two topics side
// by side.

import { el, mount } from "../core/ui.js";
import { state } from "../core/store.js";
import { listTopicsBySection, getTopic, helpLinkChip } from "../core/help.js";

export function renderHelpSite() {
  const root = document.getElementById("screenContainer");
  const params = new URLSearchParams((state.route.split("?")[1] || ""));
  const focusedTopic = params.get("topic");

  const sections = listTopicsBySection();

  // Side TOC
  const toc = el("aside", { class: "doc-toc" }, [
    el("div", { class: "doc-toc-title" }, ["Contents"]),
    ...sections.map(({ section, topics }) => el("div", { class: "doc-toc-section" }, [
      el("div", { class: "doc-toc-section-title" }, [section]),
      ...topics.map(t => el("a", {
        class: `doc-toc-link ${focusedTopic === t.id ? "active" : ""}`,
        href: `#/help?topic=${encodeURIComponent(t.id)}`,
        onClick: (e) => {
          // Same-tab navigation on direct sidebar click — only the helpHint
          // / helpLinkChip helpers force a new tab. Plain TOC clicks stay
          // in this tab.
          e.preventDefault();
          location.hash = `#/help?topic=${encodeURIComponent(t.id)}`;
        },
      }, [t.title]))
    ])),
  ]);

  // Main content — full topic list with anchors.
  const content = el("article", { class: "doc-content" }, [
    el("h1", {}, ["FORGE Documentation"]),
    el("p", { class: "doc-lede" }, [
      "Reference for the i3X API surface, FORGE concepts (assets, documents, work items, incidents, profiles), and the audit / permissions model. ",
      "Each topic is also linked from in-app hover hints — look for the ",
      el("span", { class: "help-hint", style: { display: "inline-flex" }, "aria-hidden": "true" }, [el("span", {}, ["?"])]),
      " icon next to fields and buttons.",
    ]),
    ...sections.map(({ section, topics }) => el("section", { class: "doc-section" }, [
      el("h2", { id: `section-${slug(section)}` }, [section]),
      ...topics.map(t => renderTopic(t, focusedTopic === t.id)),
    ])),
  ]);

  mount(root, [el("div", { class: "doc-layout" }, [toc, content])]);

  if (focusedTopic) {
    setTimeout(() => {
      const target = document.getElementById(`topic-${focusedTopic}`);
      if (target) {
        try { target.scrollIntoView({ behavior: "smooth", block: "start" }); } catch {}
      }
    }, 50);
  }
}

function renderTopic(topic, isFocused) {
  return el("div", {
    class: `doc-topic ${isFocused ? "doc-topic-focused" : ""}`,
    id: `topic-${topic.id}`,
  }, [
    el("h3", {}, [topic.title]),
    el("p", { class: "doc-summary" }, [topic.summary]),
    renderBody(topic.body || ""),
    topic.example ? el("div", { class: "doc-example" }, [
      el("div", { class: "doc-example-label" }, ["Example"]),
      topic.example.request ? el("div", { class: "doc-example-block" }, [
        el("div", { class: "tiny muted" }, ["Request"]),
        el("pre", { class: "mono tiny" }, [JSON.stringify(topic.example.request, null, 2)]),
      ]) : null,
      topic.example.response ? el("div", { class: "doc-example-block" }, [
        el("div", { class: "tiny muted" }, ["Response"]),
        el("pre", { class: "mono tiny" }, [JSON.stringify(topic.example.response, null, 2)]),
      ]) : null,
    ]) : null,
    Array.isArray(topic.seeAlso) && topic.seeAlso.length ? el("div", { class: "doc-seealso" }, [
      el("span", { class: "tiny muted" }, ["See also: "]),
      ...topic.seeAlso.map(id => {
        const t = getTopic(id);
        if (!t) return null;
        return helpLinkChip(id, t.title);
      }),
    ]) : null,
  ]);
}

// Tiny markdown-ish renderer — handles headings, bullet lists, and ```
// fenced code. Deliberately small and string-safe; use innerHTML only
// for inline formatting that can't introduce script. The body strings
// in `HELP_TOPICS` are author-controlled, but we still escape input
// before inserting to defend against future authors making mistakes.
function renderBody(md) {
  const escape = (s) => String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  const lines = String(md || "").split(/\r?\n/);
  const nodes = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      nodes.push(el("pre", { class: "mono tiny" }, [buf.join("\n")]));
      continue;
    }
    if (/^- /.test(line)) {
      const items = [];
      while (i < lines.length && /^- /.test(lines[i])) {
        const li = el("li", {});
        li.innerHTML = inline(escape(lines[i].replace(/^- /, "")));
        items.push(li);
        i++;
      }
      nodes.push(el("ul", {}, items));
      continue;
    }
    if (/^#### /.test(line)) {
      nodes.push(el("h6", {}, [line.replace(/^#### /, "")])); i++; continue;
    }
    if (/^### /.test(line)) {
      nodes.push(el("h5", {}, [line.replace(/^### /, "")])); i++; continue;
    }
    if (/^## /.test(line)) {
      nodes.push(el("h4", {}, [line.replace(/^## /, "")])); i++; continue;
    }
    if (line.trim() === "") { i++; continue; }
    const p = el("p", {});
    p.innerHTML = inline(escape(line));
    nodes.push(p);
    i++;
  }
  return el("div", { class: "doc-body" }, nodes);
}

function inline(s) {
  // Bold **x**, code `x`. Already-escaped input — just rewrap.
  return s
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, '<code class="mono">$1</code>');
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
