// In-app documentation site — Inductive Automation manual style.
//
// Routed at `/help`. URL takes an optional `?topic=<id>` query that
// shows just that topic in full-page view. Open from anywhere via
// `openHelpTopic(id)` from `src/core/help.js`.
//
// UX design:
//   - Left sidebar: searchable, collapsible section tree (IA manual style)
//   - Right main area: single-topic view when ?topic= is set, else home grid
//   - Breadcrumb: Documentation > Section > Topic
//   - Prev / Next navigation at the bottom of each topic page

import { el, mount } from "../core/ui.js";
import { state } from "../core/store.js";
import { HELP_TOPICS, listTopicsBySection, getTopic, helpLinkChip } from "../core/help.js";

export function renderHelpSite() {
  const root = document.getElementById("screenContainer");
  const params = new URLSearchParams((state.route.split("?")[1] || ""));
  const focusedTopic = params.get("topic");

  const sections = listTopicsBySection();
  // Flat ordered list of all topics (for prev/next calculation)
  const allTopics = sections.flatMap(s => s.topics);

  // --- Build sidebar ---
  const searchState = { q: "" };
  const tocSections = el("div", { class: "doc-toc-sections" }, []);
  const renderTocSections = () => {
    const q = searchState.q.toLowerCase();
    tocSections.replaceChildren(...sections.map(({ section, topics }) => {
      const filtered = q ? topics.filter(t =>
        t.title.toLowerCase().includes(q) ||
        t.summary.toLowerCase().includes(q) ||
        t.section.toLowerCase().includes(q)
      ) : topics;
      if (!filtered.length) return null;
      const isOpen = !q ? (sessionStorage.getItem(`help.open.${slug(section)}`) !== "0") : true;
      const toggle = () => {
        const next = !isOpen;
        sessionStorage.setItem(`help.open.${slug(section)}`, next ? "1" : "0");
        renderTocSections();
      };
      const sectionEl = el("div", { class: "doc-toc-section" }, [
        el("button", {
          class: "doc-toc-section-btn",
          "aria-expanded": String(isOpen),
          onClick: toggle,
        }, [
          el("span", { class: "doc-toc-chevron" }, [isOpen ? "▾" : "▸"]),
          el("span", {}, [section]),
        ]),
        isOpen ? el("div", { class: "doc-toc-links" }, filtered.map(t =>
          el("a", {
            class: `doc-toc-link${focusedTopic === t.id ? " active" : ""}`,
            href: `#/help?topic=${encodeURIComponent(t.id)}`,
            title: t.summary,
            onClick: (e) => {
              e.preventDefault();
              location.hash = `#/help?topic=${encodeURIComponent(t.id)}`;
            },
          }, [t.title])
        )) : null,
      ]);
      return sectionEl;
    }).filter(Boolean));
  };
  renderTocSections();

  const searchInput = el("input", {
    type: "search",
    class: "doc-toc-search",
    placeholder: "Search docs…",
    "aria-label": "Search documentation",
    onInput: (e) => {
      searchState.q = e.target.value;
      renderTocSections();
    },
  });

  const toc = el("aside", { class: "doc-toc" }, [
    el("div", { class: "doc-toc-header" }, [
      el("div", { class: "doc-toc-title" }, ["Documentation"]),
      el("a", {
        class: `doc-toc-home${!focusedTopic ? " active" : ""}`,
        href: "#/help",
        onClick: (e) => { e.preventDefault(); location.hash = "#/help"; },
      }, ["🏠 Home"]),
    ]),
    searchInput,
    tocSections,
  ]);

  // --- Build main content ---
  let content;
  if (focusedTopic) {
    const topic = getTopic(focusedTopic);
    if (!topic) {
      content = el("article", { class: "doc-article" }, [
        el("div", { class: "doc-breadcrumb" }, [
          breadcrumbLink("#/help", "Documentation"), " › ", "Not found",
        ]),
        el("h1", {}, ["Topic not found"]),
        el("p", { class: "muted" }, [`No topic with ID "${focusedTopic}" exists.`]),
        el("a", { class: "btn", href: "#/help", onClick: (e) => { e.preventDefault(); location.hash = "#/help"; } }, ["← Back to home"]),
      ]);
    } else {
      const idx = allTopics.findIndex(t => t.id === focusedTopic);
      const prevTopic = idx > 0 ? allTopics[idx - 1] : null;
      const nextTopic = idx < allTopics.length - 1 ? allTopics[idx + 1] : null;
      content = el("article", { class: "doc-article" }, [
        el("div", { class: "doc-breadcrumb" }, [
          breadcrumbLink("#/help", "Documentation"), " › ",
          el("span", { class: "doc-breadcrumb-section" }, [topic.section]), " › ",
          el("span", { class: "doc-breadcrumb-current" }, [topic.title]),
        ]),
        el("h1", { class: "doc-article-title" }, [topic.title]),
        el("p", { class: "doc-article-summary" }, [topic.summary]),
        renderBody(topic.body || ""),
        topic.example ? renderExample(topic.example) : null,
        Array.isArray(topic.seeAlso) && topic.seeAlso.length
          ? el("div", { class: "doc-seealso" }, [
              el("span", { class: "tiny muted" }, ["See also: "]),
              ...topic.seeAlso.map(id => {
                const t = getTopic(id);
                return t ? helpLinkChip(id, t.title) : null;
              }),
            ])
          : null,
        // Prev / Next navigation
        el("div", { class: "doc-prevnext" }, [
          prevTopic ? el("a", {
            class: "doc-prevnext-btn doc-prevnext-prev",
            href: `#/help?topic=${encodeURIComponent(prevTopic.id)}`,
            onClick: (e) => { e.preventDefault(); location.hash = `#/help?topic=${encodeURIComponent(prevTopic.id)}`; },
          }, [
            el("span", { class: "doc-prevnext-arrow" }, ["←"]),
            el("span", { class: "stack", style: { gap: "2px" } }, [
              el("span", { class: "tiny muted" }, ["Previous"]),
              el("span", { class: "doc-prevnext-label" }, [prevTopic.title]),
            ]),
          ]) : el("span"),
          nextTopic ? el("a", {
            class: "doc-prevnext-btn doc-prevnext-next",
            href: `#/help?topic=${encodeURIComponent(nextTopic.id)}`,
            onClick: (e) => { e.preventDefault(); location.hash = `#/help?topic=${encodeURIComponent(nextTopic.id)}`; },
          }, [
            el("span", { class: "stack", style: { gap: "2px", textAlign: "right" } }, [
              el("span", { class: "tiny muted" }, ["Next"]),
              el("span", { class: "doc-prevnext-label" }, [nextTopic.title]),
            ]),
            el("span", { class: "doc-prevnext-arrow" }, ["→"]),
          ]) : el("span"),
        ]),
      ]);
    }
  } else {
    // Home page — section overview grid (like IA manual landing page)
    content = el("article", { class: "doc-article" }, [
      el("h1", { class: "doc-article-title" }, ["FORGE Documentation"]),
      el("p", { class: "doc-article-summary" }, [
        "Reference for the FORGE platform — assets, documents, work items, incidents, profiles, the i3X API surface, and the audit/permissions model. ",
        "Select a topic from the navigation on the left, or browse sections below.",
      ]),
      el("div", { class: "doc-section-grid" },
        sections.map(({ section, topics }) => el("a", {
          class: "doc-section-card",
          href: `#/help?topic=${encodeURIComponent(topics[0]?.id || "")}`,
          onClick: (e) => {
            e.preventDefault();
            if (topics[0]) location.hash = `#/help?topic=${encodeURIComponent(topics[0].id)}`;
          },
        }, [
          el("div", { class: "doc-section-card-title" }, [section]),
          el("div", { class: "doc-section-card-count tiny muted" }, [`${topics.length} topic${topics.length !== 1 ? "s" : ""}`]),
        ]))
      ),
    ]);
  }

  mount(root, [el("div", { class: "doc-layout" }, [toc, content])]);

  // Scroll active topic into view in the sidebar
  setTimeout(() => {
    const active = toc.querySelector(".doc-toc-link.active");
    if (active) {
      try { active.scrollIntoView({ block: "nearest" }); } catch {}
    }
    // Scroll content to top on navigation
    const mainEl = root.querySelector(".doc-article");
    if (mainEl) try { mainEl.scrollTo({ top: 0 }); } catch {}
    root.scrollTo({ top: 0 });
  }, 0);
}

function breadcrumbLink(hash, label) {
  return el("a", {
    class: "doc-breadcrumb-link",
    href: hash,
    onClick: (e) => { e.preventDefault(); location.hash = hash; },
  }, [label]);
}

function renderExample(example) {
  return el("div", { class: "doc-example" }, [
    el("div", { class: "doc-example-label" }, ["Example"]),
    example.request ? el("div", { class: "doc-example-block" }, [
      el("div", { class: "tiny muted" }, ["Request"]),
      el("pre", { class: "mono tiny" }, [JSON.stringify(example.request, null, 2)]),
    ]) : null,
    example.response ? el("div", { class: "doc-example-block" }, [
      el("div", { class: "tiny muted" }, ["Response"]),
      el("pre", { class: "mono tiny" }, [JSON.stringify(example.response, null, 2)]),
    ]) : null,
  ]);
}

// Tiny markdown-ish renderer — handles headings, bullet lists, callouts,
// and ``` fenced code. Deliberately small; author-controlled body strings
// only, but still escapes before innerHTML to defend against future authors.
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
    // Fenced code block
    if (/^```/.test(line)) {
      const lang = line.replace(/^```/, "").trim();
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      const pre = el("pre", { class: `doc-code mono tiny${lang ? ` lang-${lang}` : ""}` }, [buf.join("\n")]);
      nodes.push(pre);
      continue;
    }
    // Callout: > NOTE: ... or > WARNING: ...
    if (/^> /.test(line)) {
      const buf = [];
      while (i < lines.length && /^> /.test(lines[i])) {
        buf.push(lines[i].replace(/^> /, ""));
        i++;
      }
      const text = buf.join(" ");
      const isWarn = /^warning:/i.test(text) || /^caution:/i.test(text);
      const callout = el("div", { class: `doc-callout ${isWarn ? "doc-callout-warn" : "doc-callout-info"}` });
      callout.innerHTML = inline(escape(text));
      nodes.push(callout);
      continue;
    }
    // Bullet list
    if (/^- /.test(line)) {
      const items = [];
      while (i < lines.length && /^- /.test(lines[i])) {
        const li = el("li", {});
        li.innerHTML = inline(escape(lines[i].replace(/^- /, "")));
        items.push(li);
        i++;
      }
      nodes.push(el("ul", { class: "doc-list" }, items));
      continue;
    }
    // Numbered list
    if (/^\d+\. /.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\. /.test(lines[i])) {
        const li = el("li", {});
        li.innerHTML = inline(escape(lines[i].replace(/^\d+\. /, "")));
        items.push(li);
        i++;
      }
      nodes.push(el("ol", { class: "doc-list" }, items));
      continue;
    }
    // Headings
    if (/^#### /.test(line)) { const h = el("h5", { class: "doc-h5" }, []); h.innerHTML = inline(escape(line.replace(/^#### /, ""))); nodes.push(h); i++; continue; }
    if (/^### /.test(line))  { const h = el("h4", { class: "doc-h4" }, []); h.innerHTML = inline(escape(line.replace(/^### /, ""))); nodes.push(h); i++; continue; }
    if (/^## /.test(line))   { const h = el("h3", { class: "doc-h3" }, []); h.innerHTML = inline(escape(line.replace(/^## /, ""))); nodes.push(h); i++; continue; }
    if (/^# /.test(line))    { const h = el("h2", { class: "doc-h2" }, []); h.innerHTML = inline(escape(line.replace(/^# /, ""))); nodes.push(h); i++; continue; }
    // Horizontal rule
    if (/^---+$/.test(line.trim())) { nodes.push(el("hr", { class: "doc-hr" })); i++; continue; }
    // Empty line
    if (line.trim() === "") { i++; continue; }
    // Paragraph
    const p = el("p", { class: "doc-p" });
    p.innerHTML = inline(escape(line));
    nodes.push(p);
    i++;
  }
  return el("div", { class: "doc-body" }, nodes);
}

function inline(s) {
  return s
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, '<code class="doc-inline-code mono">$1</code>');
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
