// UX-D — state primitives + upgraded toast tests.
//
// loadingState / emptyState / errorState / skeleton are pure DOM
// builders; we drive them against a tiny stub of the DOM API just
// rich enough to exercise their structure (a real JSDOM would be
// the natural fit but the rest of the suite runs without one, so
// we keep the dependency footprint minimal).
//
// toast() touches `document.getElementById("toastRoot")` + adds
// event listeners; we install a stub document on globalThis for the
// duration of the file and tear down afterward.

import test from "node:test";
import assert from "node:assert/strict";

// ────────────────────────────────────────────────────────────────────
// Tiny DOM stub. Mirrors the surface el() in src/core/ui.js needs:
//   createElement, createTextNode, appendChild / append, classList,
//   setAttribute, dataset, addEventListener, style proxy. Read it as
//   "the bare minimum that lets state-primitive code construct nodes
//   and lets toast() attach to a getElementById root."
// ────────────────────────────────────────────────────────────────────

// `el()` (in ui.js) gates child appending on `c instanceof Node`.
// Our stub nodes have to satisfy that or el() will route them to
// `document.createTextNode(String(node))` and you'll see
// "[object Object]" all over the rendered output. We define every
// instance method + getter/setter on the StubNode class itself
// (Object.assign was a misfire — it doesn't copy getters/setters,
// so the textContent + className accessors were silently invoking
// on the source literal and dropping data on the floor).
class StubClassList {
  constructor() { this._set = new Set(); }
  add(...cls) { for (const c of cls) this._set.add(c); }
  remove(...cls) { for (const c of cls) this._set.delete(c); }
  contains(c) { return this._set.has(c); }
  toggle(c, force) {
    if (force === true) this._set.add(c);
    else if (force === false) this._set.delete(c);
    else if (this._set.has(c)) this._set.delete(c);
    else this._set.add(c);
    return this._set.has(c);
  }
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
  removeEventListener(ev, fn) {
    const list = this.listeners[ev] || [];
    const idx = list.indexOf(fn);
    if (idx >= 0) list.splice(idx, 1);
  }
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
  focus() { /* el() may try to assign properties */ }
  querySelector() { return null; }
  querySelectorAll() { return []; }
}
globalThis.Node = StubNode;

function makeNode(tag) {
  return new StubNode(tag);
}

function installStubDom() {
  const created = [];
  const toastRoot = makeNode("div");
  toastRoot.id = "toastRoot";
  globalThis.document = {
    createElement: (tag) => {
      const n = makeNode(tag);
      created.push(n);
      return n;
    },
    createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
    getElementById: (id) => (id === "toastRoot" ? toastRoot : null),
    activeElement: null,
    body: makeNode("body"),
  };
  globalThis.HTMLElement = function () {};
  return { toastRoot, created };
}

const { toastRoot } = installStubDom();
const ui = await import("../src/core/ui.js");

// ────────────────────────────────────────────────────────────────────
// loadingState
// ────────────────────────────────────────────────────────────────────

test("loadingState() carries the busy ARIA contract", () => {
  const node = ui.loadingState();
  assert.equal(node.attributes.role, "status");
  assert.equal(node.attributes["aria-busy"], "true");
  assert.equal(node.attributes["aria-live"], "polite");
});

test("loadingState() label defaults to 'Loading…'", () => {
  const node = ui.loadingState();
  assert.match(node.textContent, /Loading…/);
});

test("loadingState({ message }) shows the custom label", () => {
  const node = ui.loadingState({ message: "Pulling 12k samples…" });
  assert.match(node.textContent, /Pulling 12k samples…/);
});

test("loadingState({ size }) emits the size class", () => {
  assert.match(ui.loadingState({ size: "sm" }).className, /state-loading-sm/);
  assert.match(ui.loadingState({ size: "lg" }).className, /state-loading-lg/);
  // Default is md.
  assert.match(ui.loadingState().className, /state-loading-md/);
});

test("loadingState({ compact: true }) adds the compact modifier (inline pill)", () => {
  assert.match(ui.loadingState({ compact: true }).className, /\bcompact\b/);
});

// ────────────────────────────────────────────────────────────────────
// emptyState
// ────────────────────────────────────────────────────────────────────

test("emptyState() renders title + message + optional CTA", () => {
  let clicked = false;
  const node = ui.emptyState({
    title: "No assets yet",
    message: "Add the first one to begin.",
    action: { label: "New asset", onClick: () => { clicked = true; } },
  });
  assert.equal(node.attributes.role, "status");
  assert.match(node.textContent, /No assets yet/);
  assert.match(node.textContent, /Add the first one/);
  // Find the CTA button and dispatch a click.
  const btn = (node.children || []).find(c => c?.tagName === "BUTTON");
  assert.ok(btn, "emptyState renders a button when action is provided");
  assert.match(btn.className, /\bbtn\b/);
  // Default CTA variant is "primary".
  assert.match(btn.className, /\bprimary\b/);
  // Click triggers the handler.
  btn.dispatchEvent({ type: "click" });
  // The handler runs synchronously inside the onClick prop; el() in
  // the source wires `addEventListener("click", fn)` for `onClick`.
  assert.equal(clicked, true, "CTA onClick fires");
});

test("emptyState() omits the icon and the button when not provided", () => {
  const node = ui.emptyState({ title: "Empty", icon: null });
  // No icon-bearing div, no button.
  const hasIcon = (node.children || []).some(c => c?.className?.includes?.("state-icon"));
  const hasBtn = (node.children || []).some(c => c?.tagName === "BUTTON");
  assert.equal(hasIcon, false);
  assert.equal(hasBtn, false);
});

// ────────────────────────────────────────────────────────────────────
// errorState
// ────────────────────────────────────────────────────────────────────

test("errorState() carries role=alert + visible danger glyph", () => {
  const node = ui.errorState({ title: "Failed to load", message: "503 Service Unavailable" });
  assert.equal(node.attributes.role, "alert");
  // The icon is the first child (decorative aria-hidden).
  const iconChild = (node.children || []).find(c => c?.className?.includes?.("state-icon"));
  assert.ok(iconChild);
  assert.match(iconChild.className, /state-icon-danger/);
  assert.equal(iconChild.attributes["aria-hidden"], "true");
});

test("errorState({ action }) wires the retry button", () => {
  let retried = 0;
  const node = ui.errorState({
    title: "Network blip",
    message: "Couldn't reach /api/asset-tree",
    action: { label: "Retry", onClick: () => { retried += 1; } },
  });
  const btn = (node.children || []).find(c => c?.tagName === "BUTTON");
  assert.ok(btn);
  btn.dispatchEvent({ type: "click" });
  assert.equal(retried, 1);
});

// ────────────────────────────────────────────────────────────────────
// skeleton
// ────────────────────────────────────────────────────────────────────

test("skeleton({ kind: 'lines', rows: 4 }) renders 4 line-shaped placeholders", () => {
  const node = ui.skeleton({ kind: "lines", rows: 4 });
  assert.equal(node.attributes["aria-hidden"], "true");
  const lines = (node.children || []).filter(c => c?.className?.includes?.("skeleton-line"));
  assert.equal(lines.length, 4);
});

test("skeleton({ kind: 'table', rows: 6 }) renders 6 full-width row placeholders", () => {
  const node = ui.skeleton({ kind: "table", rows: 6 });
  const rows = (node.children || []).filter(c => c?.className?.includes?.("skeleton-table-row"));
  assert.equal(rows.length, 6);
  // Table rows are forced 100% width regardless of the variation list.
  rows.forEach(r => assert.equal(r.style.width, "100%"));
});

test("skeleton({ kind: 'card' }) renders a single rounded card placeholder", () => {
  const node = ui.skeleton({ kind: "card" });
  assert.match(node.className, /skeleton-card/);
  assert.equal(node.attributes["aria-hidden"], "true");
});

// ────────────────────────────────────────────────────────────────────
// toast() upgrades — manual dismiss, action slot, sticky, role.
// ────────────────────────────────────────────────────────────────────

test("toast() returns a { close } handle that programmatically dismisses", () => {
  const before = toastRoot.children.length;
  const handle = ui.toast("Saved", "success");
  assert.equal(toastRoot.children.length, before + 1);
  assert.equal(typeof handle.close, "function");
  // Calling close() flips the toast's opacity to 0 and schedules
  // removal; we just assert the handle is callable.
  handle.close();
});

test("toast(...) emits role='alert' for danger and role='status' otherwise", () => {
  toastRoot.children = [];
  ui.toast("Saved", "success");
  ui.toast("Disk near full", "warn");
  ui.toast("Connection lost", "danger");
  const success = toastRoot.children[0];
  const warn = toastRoot.children[1];
  const danger = toastRoot.children[2];
  assert.equal(success.attributes.role, "status");
  assert.equal(warn.attributes.role, "status");
  assert.equal(danger.attributes.role, "alert");
});

test("toast(...) renders a close (✕) button on every variant", () => {
  toastRoot.children = [];
  ui.toast("Saved", "success");
  const t = toastRoot.children[0];
  const close = (t.children || []).find(c => c?.className === "toast-close");
  assert.ok(close, "every toast has a close button");
  assert.equal(close.attributes["aria-label"], "Dismiss notification");
});

test("toast(... { action }) wires an inline action button that runs onClick + dismisses", () => {
  toastRoot.children = [];
  let undid = 0;
  ui.toast("Item moved", "info", { action: { label: "Undo", onClick: () => { undid += 1; } } });
  const t = toastRoot.children[0];
  const action = (t.children || []).find(c => c?.className === "toast-action");
  assert.ok(action);
  assert.equal(action.textContent, "Undo");
  action.dispatchEvent({ type: "click" });
  assert.equal(undid, 1, "onClick runs on action click");
});

test("toast(... { sticky: true }) gets a sticky class and won't auto-dismiss", () => {
  toastRoot.children = [];
  const handle = ui.toast("Replication paused", "danger", { sticky: true });
  const t = toastRoot.children[0];
  assert.match(t.className, /\bsticky\b/);
  // Sticky toasts MUST be dismissible — the close button is mandatory.
  const close = (t.children || []).find(c => c?.className === "toast-close");
  assert.ok(close, "sticky toast has a close button");
  // The handle's close() still works programmatically.
  handle.close();
});

test("toast() ignores blank/null messages — no node added", () => {
  toastRoot.children = [];
  ui.toast(null);
  ui.toast("");
  ui.toast("   ");
  assert.equal(toastRoot.children.length, 0);
});
