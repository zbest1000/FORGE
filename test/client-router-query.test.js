// Tests for queryParams() / updateQueryParams() in src/core/router.js.
//
// Phase 2 lifted filter state from sessionStorage to URL query strings
// so views are bookmarkable + shareable. These tests guard the parsing
// + patching round-trip and the "empty value deletes the key" rule.

import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Stub the minimum browser surface the router touches: location.hash
// (read + write), addEventListener, Window-level dispatchEvent for the
// hashchange handler. The router resolves `state.route = currentPath()`
// so we also need a `state` object that the router will mutate.
const fakeLocation = {
  _hash: "",
  get hash() { return this._hash; },
  set hash(v) {
    if (v === this._hash) return;
    this._hash = v;
    // Dispatch hashchange synchronously so listeners pick it up.
    for (const fn of fakeListeners.hashchange || []) fn();
  },
};
const fakeListeners = /** @type {Record<string, Array<Function>>} */ ({});
const fakeWindow = {
  addEventListener(name, fn) { (fakeListeners[name] ||= []).push(fn); },
  removeEventListener(name, fn) {
    const list = fakeListeners[name] || [];
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  },
};

globalThis.location = /** @type any */ (fakeLocation);
globalThis.window = /** @type any */ (fakeWindow);

const { queryParams, updateQueryParams } = await import("../src/core/router.js");

beforeEach(() => {
  fakeLocation._hash = "";
});

describe("queryParams()", () => {
  test("returns empty params for plain hash", () => {
    fakeLocation._hash = "#/work";
    const q = queryParams();
    assert.equal(q.toString(), "");
    assert.equal(q.get("status"), null);
  });

  test("parses simple query strings", () => {
    fakeLocation._hash = "#/work?status=Open&due=overdue";
    const q = queryParams();
    assert.equal(q.get("status"), "Open");
    assert.equal(q.get("due"), "overdue");
  });

  test("URL-decodes values", () => {
    fakeLocation._hash = "#/work?q=" + encodeURIComponent("valve PV-101");
    const q = queryParams();
    assert.equal(q.get("q"), "valve PV-101");
  });

  test("handles missing hash gracefully", () => {
    fakeLocation._hash = "";
    const q = queryParams();
    assert.equal(q.toString(), "");
  });
});

describe("updateQueryParams()", () => {
  test("adds a new key to a path with no params", () => {
    fakeLocation._hash = "#/work";
    updateQueryParams({ status: "Open" });
    assert.equal(fakeLocation._hash, "#/work?status=Open");
  });

  test("adds a key to a path with existing params", () => {
    fakeLocation._hash = "#/work?status=Open";
    updateQueryParams({ due: "overdue" });
    assert.match(fakeLocation._hash, /^#\/work\?/);
    assert.match(fakeLocation._hash, /status=Open/);
    assert.match(fakeLocation._hash, /due=overdue/);
  });

  test("replaces an existing key value", () => {
    fakeLocation._hash = "#/work?status=Open";
    updateQueryParams({ status: "Done" });
    assert.equal(fakeLocation._hash, "#/work?status=Done");
  });

  test("empty / null / false deletes the key", () => {
    fakeLocation._hash = "#/work?status=Open&due=overdue";
    updateQueryParams({ status: "" });
    assert.equal(fakeLocation._hash, "#/work?due=overdue");
    updateQueryParams({ due: null });
    assert.equal(fakeLocation._hash, "#/work");
  });

  test("multi-key patch in one call", () => {
    fakeLocation._hash = "#/work";
    updateQueryParams({ status: "Open", due: "overdue", q: "valve" });
    const q = queryParams();
    assert.equal(q.get("status"), "Open");
    assert.equal(q.get("due"), "overdue");
    assert.equal(q.get("q"), "valve");
  });

  test("clearing all keys leaves a clean path with no trailing ?", () => {
    fakeLocation._hash = "#/work?a=1&b=2";
    updateQueryParams({ a: "", b: "" });
    assert.equal(fakeLocation._hash, "#/work");
  });
});
