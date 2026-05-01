// UX-G — page-polish regression guard.
//
// The final UX phase added three load-bearing helpers: a breadcrumb
// builder, an idle scheduler, and a print stylesheet. This file
// asserts each survives + behaves correctly:
//
//   1. `breadcrumb([...])` builds a WAI-ARIA-compliant Breadcrumb
//      pattern: `<nav aria-label="Breadcrumb">` wrapping an `<ol>`,
//      separators marked `aria-hidden`, last item rendered as
//      plain text with `aria-current="page"`.
//   2. `idle(fn, { timeout })` runs `fn` (under rIC when available,
//      setTimeout otherwise) and exposes a `cancel()` handle.
//   3. styles.css has an `@media print` block that hides chrome.
//
// Self-contained DOM stub for breadcrumb (same StubNode shape as
// state-primitives.test.js — kept isolated here so the two test
// files can evolve independently).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

// ────────────────────────────────────────────────────────────────────
// DOM stub (same pattern as test/state-primitives.test.js).
// ────────────────────────────────────────────────────────────────────

class StubClassList {
  constructor() { this._set = new Set(); }
  add(...c) { for (const x of c) this._set.add(x); }
  remove(...c) { for (const x of c) this._set.delete(x); }
  contains(c) { return this._set.has(c); }
  toggle(c) { if (this._set.has(c)) this._set.delete(c); else this._set.add(c); }
}

class StubNode {
  constructor(tag) {
    this.tagName = String(tag || "").toUpperCase();
    this.children = [];
    this.attributes = {};
    this.style = {};
    this.classList = new StubClassList();
    this.dataset = {};
    this.listeners = {};
  }
  addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
  removeEventListener() {}
  dispatchEvent(ev) { (this.listeners[ev.type] || []).forEach(fn => fn(ev)); }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return this.attributes[k]; }
  hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k); }
  removeAttribute(k) { delete this.attributes[k]; }
  append(...args) {
    for (const a of args) {
      if (a == null) continue;
      if (typeof a === "string") this.children.push({ nodeType: 3, textContent: a });
      else this.children.push(a);
    }
  }
  appendChild(c) { this.children.push(c); return c; }
  replaceChildren(...args) { this.children = []; this.append(...args); }
  remove() { this._removed = true; }
  set className(v) { this.classList._set = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get className() { return [...this.classList._set].join(" "); }
  set textContent(v) { this.children = [{ nodeType: 3, textContent: String(v) }]; }
  get textContent() {
    const flatten = (n) => {
      if (!n) return "";
      if (n.nodeType === 3) return n.textContent || "";
      return (n.children || []).map(flatten).join("");
    };
    return flatten(this);
  }
  get innerHTML() { return this.textContent; }
  set innerHTML(v) { this.textContent = String(v); }
  focus() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
}
globalThis.Node = StubNode;
globalThis.document = {
  createElement: (tag) => new StubNode(tag),
  createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
  getElementById: () => null,
  body: new StubNode("body"),
};

// `navigate()` lives in src/core/router.js and touches window.location.
// Stub a window object so the import doesn't crash.
globalThis.window = globalThis.window || {
  location: { hash: "", href: "http://localhost/" },
  addEventListener: () => {},
  removeEventListener: () => {},
};

// ────────────────────────────────────────────────────────────────────
// breadcrumb()
// ────────────────────────────────────────────────────────────────────

const { breadcrumb } = await import("../src/core/breadcrumb.js");

test("breadcrumb([]) returns an empty text node (caller can drop it in unconditionally)", () => {
  const node = breadcrumb([]);
  // The empty-input branch creates a TextNode (`document.createTextNode("")`).
  assert.equal(node.nodeType, 3);
  assert.equal(node.textContent, "");
});

test("breadcrumb(items) builds a `<nav aria-label=\"Breadcrumb\">` wrapping an `<ol>`", () => {
  const node = breadcrumb([
    { label: "Projects", route: "/projects" },
    { label: "Project Alpha" },
  ]);
  assert.equal(node.tagName, "NAV");
  assert.equal(node.attributes["aria-label"], "Breadcrumb");
  assert.match(node.className, /\bbreadcrumb-trail\b/);
  // First child is the <ol>.
  const ol = node.children[0];
  assert.equal(ol.tagName, "OL");
  assert.match(ol.className, /\bbreadcrumb-list\b/);
});

test("non-current crumb renders as a clickable button", () => {
  const node = breadcrumb([
    { label: "Projects", route: "/projects" },
    { label: "Current" },
  ]);
  const ol = node.children[0];
  // ol items: [li (link), li (separator), li (current)]
  const linkLi = ol.children[0];
  const linkBtn = linkLi.children[0];
  assert.equal(linkBtn.tagName, "BUTTON");
  assert.equal(linkBtn.attributes.type, "button");
  assert.match(linkBtn.className, /\bbreadcrumb-link\b/);
  assert.equal(linkBtn.textContent, "Projects");
});

test("the last crumb is plain text marked aria-current=\"page\"", () => {
  const node = breadcrumb([
    { label: "Projects", route: "/projects" },
    { label: "Project Alpha", route: "/work-board/PRJ-1" },
    { label: "Sprint 3" },
  ]);
  const ol = node.children[0];
  // children: [li-link, sep, li-link, sep, li-current]
  const currentLi = ol.children[ol.children.length - 1];
  const currentSpan = currentLi.children[0];
  assert.equal(currentSpan.tagName, "SPAN");
  assert.equal(currentSpan.attributes["aria-current"], "page");
  assert.match(currentSpan.className, /\bbreadcrumb-current\b/);
  assert.equal(currentSpan.textContent, "Sprint 3");
});

test("separators between crumbs are aria-hidden", () => {
  const node = breadcrumb([
    { label: "A", route: "/a" },
    { label: "B", route: "/b" },
    { label: "C" },
  ]);
  const ol = node.children[0];
  // Two separators expected (between A↔B and B↔C).
  const seps = (ol.children || []).filter(c => c?.className?.includes?.("breadcrumb-sep"));
  assert.equal(seps.length, 2);
  for (const s of seps) {
    assert.equal(s.attributes["aria-hidden"], "true");
  }
});

test("crumbs without a route fall through to the plain-text form even mid-trail", () => {
  // Edge case: an item with no route that ISN'T the last. We still
  // render it as plain text — a router-less breadcrumb in the middle
  // would be a screen-author bug, but we render gracefully rather
  // than crash.
  const node = breadcrumb([
    { label: "A", route: "/a" },
    { label: "B" },                    // no route, not last
    { label: "C" },                    // no route, last (current)
  ]);
  const ol = node.children[0];
  // Filter out separator <li>s (they carry .breadcrumb-sep) so we
  // only inspect the three labelled crumbs.
  const labels = (ol.children || []).filter(
    c => c?.tagName === "LI" && !c?.className?.includes?.("breadcrumb-sep"),
  );
  assert.equal(labels.length, 3);
  const inner = labels.map(li => li.children[0].tagName);
  assert.deepEqual(inner, ["BUTTON", "SPAN", "SPAN"]);
});

// ────────────────────────────────────────────────────────────────────
// idle()
// ────────────────────────────────────────────────────────────────────

const { idle, idleCancel } = await import("../src/core/idle.js");

test("idle(fn) runs fn and returns a cancel handle (rIC available — Node 22+)", async () => {
  // Node 22 + 24 ship requestIdleCallback. Most CI matrix entries
  // hit this path. Run the function and assert it executed.
  let ran = false;
  const handle = idle(() => { ran = true; });
  assert.equal(typeof handle.cancel, "function");
  // Wait long enough for either rIC or the setTimeout fallback to fire.
  await new Promise(r => setTimeout(r, 50));
  assert.equal(ran, true, "idle() must run the function");
});

test("idle() returns _native indicator so callers can route telemetry", () => {
  const handle = idle(() => {}, { timeout: 100 });
  assert.equal(typeof handle._native, "boolean");
  handle.cancel();
});

test("idleCancel(handle) prevents fn from running", async () => {
  let ran = false;
  const handle = idle(() => { ran = true; }, { timeout: 100 });
  idleCancel(handle);
  await new Promise(r => setTimeout(r, 200));
  assert.equal(ran, false, "cancelled idle callback must not fire");
});

test("idle() handles non-function input safely (no throw, no-op handle)", () => {
  const handle = idle(null);
  assert.equal(typeof handle.cancel, "function");
  // Calling cancel on a no-op handle must not throw.
  handle.cancel();
});

// ────────────────────────────────────────────────────────────────────
// Print stylesheet
// ────────────────────────────────────────────────────────────────────

const css = fs.readFileSync(path.join(repoRoot, "styles.css"), "utf8");

function extractMediaBlock(source, query) {
  const startMarker = `@media ${query}`;
  const start = source.indexOf(startMarker);
  if (start < 0) return null;
  const openBrace = source.indexOf("{", start);
  if (openBrace < 0) return null;
  let depth = 1;
  let i = openBrace + 1;
  while (i < source.length && depth > 0) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") depth--;
    i++;
  }
  return source.slice(openBrace + 1, i - 1);
}

test("styles.css carries an @media print block", () => {
  const block = extractMediaBlock(css, "print");
  assert.ok(block, "@media print block must exist");
});

test("@media print hides the app chrome (rail, panels, header, dock, toasts)", () => {
  const block = extractMediaBlock(css, "print");
  assert.ok(block);
  for (const sel of [
    ".far-left-rail",
    ".left-panel",
    ".right-context-panel",
    ".main-header",
    ".operations-dock",
    ".toast-root",
  ]) {
    assert.ok(
      block.includes(sel),
      `@media print must hide ${sel}`,
    );
  }
  assert.match(block, /display:\s*none/, "must include `display: none` declaration");
});

test("@media print appends the URL after every external link (`a[href]:not([href^=\"#\"])::after`)", () => {
  const block = extractMediaBlock(css, "print");
  assert.match(
    block,
    /a\[href\]:not\(\[href\^="#"\]\)::after/,
    "must append href content after external links so a printed page retains its citations",
  );
});

test("@media print disables motion (animation + transition)", () => {
  const block = extractMediaBlock(css, "print");
  assert.match(block, /animation:\s*none/);
  assert.match(block, /transition:\s*none/);
});

test("@page rule sets a print-safe page margin", () => {
  // The @page rule lives inside the @media print block.
  const block = extractMediaBlock(css, "print");
  assert.match(block, /@page\s*\{[^}]*margin:\s*0\.75in/);
});
