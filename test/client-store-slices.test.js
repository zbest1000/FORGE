// Tests for slice subscriptions added to src/core/store.js (Phase 3).
//
// The store's existing `subscribe()` fires on every notify(); slice
// subscriptions narrow the listener to a specific path so a deep state
// mutation only re-renders the shell sections that actually depend on
// the changed slice. This test set covers:
//   - listener fires only on reference change of the watched path
//   - markDirty() opt-in for in-place mutations
//   - unsubscribe stops the callback firing
//   - multiple subscribers per path each get their own prev tracking

import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Minimal browser stubs so store.js imports cleanly. The store reads
// localStorage on hydrate + subscribes to beforeunload; we provide just
// enough surface for module load.
const ls = new Map();
globalThis.localStorage = /** @type any */ ({
  getItem: (k) => ls.has(k) ? ls.get(k) : null,
  setItem: (k, v) => ls.set(k, v),
  removeItem: (k) => ls.delete(k),
  clear: () => ls.clear(),
});
globalThis.window = /** @type any */ ({
  addEventListener: () => {},
  removeEventListener: () => {},
  requestIdleCallback: (fn) => setTimeout(fn, 0),
  cancelIdleCallback: (id) => clearTimeout(id),
});
globalThis.location = /** @type any */ ({ hash: "", reload() {} });

const { state, update, subscribeSlice, markDirty, initState } = await import("../src/core/store.js");

beforeEach(() => {
  initState({ workItems: [], theme: "dark", nested: { count: 0 } });
});

describe("subscribeSlice()", () => {
  test("fires when the watched path's reference changes", () => {
    let calls = 0;
    let lastNext = null;
    let lastPrev = "sentinel";
    subscribeSlice("data.workItems", (next, prev) => {
      calls++; lastNext = next; lastPrev = prev;
    });
    // First mutation that swaps the array reference.
    update(s => { s.data.workItems = [{ id: "WI-1", title: "A" }]; });
    assert.equal(calls, 1);
    assert.equal(lastNext.length, 1);
    assert.equal(lastPrev, undefined); // first call has no prev

    // Mutation to a DIFFERENT slice should not fire this listener.
    update(s => { s.data.theme = "light"; });
    assert.equal(calls, 1);

    // Re-swap with the same content but new ref — fires again.
    update(s => { s.data.workItems = [{ id: "WI-1", title: "A" }]; });
    assert.equal(calls, 2);
  });

  test("does not fire for in-place mutations without markDirty", () => {
    let calls = 0;
    subscribeSlice("data.workItems", () => { calls++; });
    update(s => { s.data.workItems = []; }); // ref change → fires
    assert.equal(calls, 1);

    // Mutate in place — array ref unchanged → no fire.
    update(s => { s.data.workItems.push({ id: "WI-1" }); });
    assert.equal(calls, 1);
  });

  test("markDirty() forces a fire even when ref is unchanged", () => {
    let calls = 0;
    subscribeSlice("data.workItems", () => { calls++; });
    update(s => { s.data.workItems = []; });
    assert.equal(calls, 1);

    update(s => {
      s.data.workItems.push({ id: "WI-1" });
      markDirty("data.workItems");
    });
    assert.equal(calls, 2);
  });

  test("unsubscribe stops further notifications", () => {
    let calls = 0;
    const off = subscribeSlice("data.theme", () => { calls++; });
    update(s => { s.data.theme = "light"; });
    assert.equal(calls, 1);

    off();
    update(s => { s.data.theme = "dark"; });
    assert.equal(calls, 1);
  });

  test("two subscribers on the same path track prev independently", () => {
    let aCalls = 0, bCalls = 0;
    subscribeSlice("data.theme", () => { aCalls++; });
    update(s => { s.data.theme = "light"; });
    assert.equal(aCalls, 1);

    // Subscriber B joins late — should fire on the NEXT change because
    // its prev is undefined initially and the value is "light" now.
    subscribeSlice("data.theme", () => { bCalls++; });
    update(s => { s.data.theme = "dark"; });
    assert.equal(aCalls, 2);
    assert.equal(bCalls, 1);
  });

  test("nested path resolution", () => {
    let calls = 0; let lastNext = null;
    subscribeSlice("data.nested.count", (next) => { calls++; lastNext = next; });
    update(s => { s.data.nested = { count: 5 }; });
    assert.equal(calls, 1);
    assert.equal(lastNext, 5);
  });

  test("missing path resolves to undefined (no error)", () => {
    let calls = 0;
    subscribeSlice("data.doesNotExist.deep", (next) => { calls++; assert.equal(next, undefined); });
    update(s => { s.data.theme = "light"; }); // unrelated mutation
    // Listener fires once on the very first notify because
    // its prev (undefined-from-WeakMap-miss) === next (undefined-from-path),
    // BUT our impl skips if prev === next ... so it should not fire.
    assert.equal(calls, 0);
  });
});
