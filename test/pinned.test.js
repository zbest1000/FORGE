// Pin store unit tests.
//
// `src/core/pinned.js` is the canonical place every "pin to my left
// panel" toggle goes through, regardless of which screen surfaced
// the affordance. Contract:
//
//   * isPinned(kind, id)         -> boolean (false on bad input)
//   * togglePin(kind, id)        -> boolean (now-pinned), notifies subscribers
//   * getPinned()                -> [{ kind, id }] in insertion order
//   * getPinnedOfKind(kind)      -> filtered subset
//   * subscribe(fn)              -> unsubscribe handle
//
// The module persists to localStorage under "forge.pinned.v1". We
// stub localStorage on globalThis before importing so the module
// boots cleanly in the Node test environment.

import test from "node:test";
import assert from "node:assert/strict";

// ────────────────────────────────────────────────────────────────────
// localStorage stub. The pinned module reads from globalThis.
// ────────────────────────────────────────────────────────────────────

class StubLocalStorage {
  constructor() { this._map = new Map(); }
  getItem(k) { return this._map.has(k) ? this._map.get(k) : null; }
  setItem(k, v) { this._map.set(k, String(v)); }
  removeItem(k) { this._map.delete(k); }
  clear() { this._map.clear(); }
}
globalThis.localStorage = new StubLocalStorage();

const pinned = await import("../src/core/pinned.js");

test.beforeEach(() => {
  // Reset the module-internal Set + listeners + the stub storage so
  // each test starts from a known baseline.
  pinned._reset();
  globalThis.localStorage.clear();
});

// ────────────────────────────────────────────────────────────────────
// Read API
// ────────────────────────────────────────────────────────────────────

test("isPinned returns false for blank inputs", () => {
  assert.equal(pinned.isPinned(null, "PRJ-1"), false);
  assert.equal(pinned.isPinned("project", null), false);
  assert.equal(pinned.isPinned("", ""), false);
  assert.equal(pinned.isPinned(undefined, undefined), false);
});

test("isPinned returns false when nothing is pinned yet", () => {
  assert.equal(pinned.isPinned("project", "PRJ-1"), false);
});

test("getPinned returns an empty list before any pins are set", () => {
  assert.deepEqual(pinned.getPinned(), []);
});

// ────────────────────────────────────────────────────────────────────
// togglePin
// ────────────────────────────────────────────────────────────────────

test("togglePin(kind, id) flips state + returns the new boolean", () => {
  assert.equal(pinned.togglePin("project", "PRJ-1"), true, "first call pins");
  assert.equal(pinned.isPinned("project", "PRJ-1"), true);
  assert.equal(pinned.togglePin("project", "PRJ-1"), false, "second call unpins");
  assert.equal(pinned.isPinned("project", "PRJ-1"), false);
});

test("togglePin distinguishes (kind, id) tuples — same id different kinds is two pins", () => {
  pinned.togglePin("project", "X-1");
  pinned.togglePin("asset", "X-1");
  assert.equal(pinned.isPinned("project", "X-1"), true);
  assert.equal(pinned.isPinned("asset", "X-1"), true);
  assert.equal(pinned.getPinned().length, 2);
});

test("togglePin ignores blank kind / id", () => {
  assert.equal(pinned.togglePin(null, "X"), false);
  assert.equal(pinned.togglePin("project", ""), false);
  assert.equal(pinned.getPinned().length, 0);
});

// ────────────────────────────────────────────────────────────────────
// getPinned / getPinnedOfKind
// ────────────────────────────────────────────────────────────────────

test("getPinned preserves insertion order", () => {
  pinned.togglePin("project", "A");
  pinned.togglePin("asset", "B");
  pinned.togglePin("project", "C");
  const list = pinned.getPinned();
  assert.deepEqual(list.map(p => p.id), ["A", "B", "C"]);
});

test("getPinnedOfKind filters to a single kind", () => {
  pinned.togglePin("project", "PRJ-1");
  pinned.togglePin("asset", "AS-1");
  pinned.togglePin("project", "PRJ-2");
  const projects = pinned.getPinnedOfKind("project");
  assert.deepEqual(projects.map(p => p.id), ["PRJ-1", "PRJ-2"]);
  assert.equal(pinned.getPinnedOfKind("asset").length, 1);
  assert.equal(pinned.getPinnedOfKind("nothing").length, 0);
});

test("ids containing colons survive the storage round-trip", () => {
  // The persistence format is `${kind}:${id}` — internal ids like
  // `URN:foo:bar` would naively split wrong if we used `split(':')`
  // without a join. Pin one and read back to confirm the id stays
  // intact.
  pinned.togglePin("doc", "URN:NS:DOC-9");
  const list = pinned.getPinned();
  assert.equal(list.length, 1);
  assert.equal(list[0].kind, "doc");
  assert.equal(list[0].id, "URN:NS:DOC-9");
});

// ────────────────────────────────────────────────────────────────────
// subscribe / notify
// ────────────────────────────────────────────────────────────────────

test("subscribe(fn) is invoked on every togglePin and the unsubscribe handle works", () => {
  let calls = 0;
  const unsub = pinned.subscribe(() => { calls += 1; });
  pinned.togglePin("project", "P1");
  pinned.togglePin("project", "P1"); // unpin
  assert.equal(calls, 2);
  unsub();
  pinned.togglePin("project", "P2");
  assert.equal(calls, 2, "no further notifications after unsubscribe");
});

test("subscribe(non-function) returns a no-op handle", () => {
  const unsub = pinned.subscribe(null);
  assert.equal(typeof unsub, "function");
  unsub(); // must not throw
});

test("a throwing listener does not block the next listener from running", () => {
  let secondRan = false;
  pinned.subscribe(() => { throw new Error("boom"); });
  pinned.subscribe(() => { secondRan = true; });
  pinned.togglePin("asset", "A");
  assert.equal(secondRan, true);
});

// ────────────────────────────────────────────────────────────────────
// Persistence
// ────────────────────────────────────────────────────────────────────

test("togglePin writes the JSON list to localStorage under forge.pinned.v1", () => {
  pinned.togglePin("project", "PRJ-7");
  pinned.togglePin("asset", "AS-9");
  const raw = globalThis.localStorage.getItem("forge.pinned.v1");
  assert.ok(raw, "pinned must persist to localStorage");
  const parsed = JSON.parse(raw);
  assert.deepEqual(parsed, [
    { kind: "project", id: "PRJ-7" },
    { kind: "asset", id: "AS-9" },
  ]);
});

test("private-mode localStorage (throws) does not crash the module", () => {
  // Replace localStorage with a stub that throws on every method —
  // this is what Safari does in private browsing.
  const safelyHostile = {
    getItem() { throw new Error("SecurityError"); },
    setItem() { throw new Error("SecurityError"); },
  };
  const original = globalThis.localStorage;
  globalThis.localStorage = safelyHostile;
  pinned._reset();
  // None of these calls should throw.
  assert.doesNotThrow(() => pinned.togglePin("project", "P1"));
  assert.doesNotThrow(() => pinned.isPinned("project", "P1"));
  assert.doesNotThrow(() => pinned.getPinned());
  globalThis.localStorage = original;
});
