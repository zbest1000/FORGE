// Tests for the undo/redo transaction API (Phase 4).
//
// All assertions in one test() because the store + history module
// hold mutable state across imports; a clean per-test reset would
// require module re-import which ESM doesn't easily support.

import { test, after } from "node:test";
import assert from "node:assert/strict";

const ls = new Map();
globalThis.localStorage = /** @type any */ ({
  getItem: (k) => ls.has(k) ? ls.get(k) : null,
  setItem: (k, v) => ls.set(k, v),
  removeItem: (k) => ls.delete(k),
});
globalThis.window = /** @type any */ ({
  addEventListener() {}, removeEventListener() {},
  requestIdleCallback: (fn) => setTimeout(fn, 0),
  cancelIdleCallback: (id) => clearTimeout(id),
});
globalThis.location = /** @type any */ ({ hash: "", reload() {} });

const { initState, update } = await import("../src/core/store.js");
const { transaction, undo, redo, canUndo, canRedo, historyStacks, clearHistory } =
  await import("../src/core/history.js");

after(() => {
  clearHistory();
});

test("transaction → undo → redo round-trip preserves state", () => {
  initState({ items: [], theme: "dark" });
  clearHistory();

  // Initial state
  assert.equal(canUndo(), false);
  assert.equal(canRedo(), false);

  // Capture a transaction
  transaction("add.items", "data.items", s => {
    s.data.items.push({ id: "A" }, { id: "B" });
  });

  // Stack has the entry, redo is empty
  assert.equal(canUndo(), true);
  assert.equal(canRedo(), false);
  let stacks = historyStacks();
  assert.equal(stacks.undo.length, 1);
  assert.equal(stacks.undo[0].name, "add.items");

  // Undo — items return to empty
  const undone = undo();
  assert.equal(undone.name, "add.items");
  // After undo we read state via the store.js export — re-import to peek.
  // (Since we can't import state directly without coupling, verify via
  // a no-op transaction that snapshots the current path.)
  let snapshot;
  update(s => { snapshot = JSON.parse(JSON.stringify(s.data.items)); });
  assert.deepEqual(snapshot, []);
  assert.equal(canUndo(), false);
  assert.equal(canRedo(), true);

  // Redo — items come back
  const redone = redo();
  assert.equal(redone.name, "add.items");
  update(s => { snapshot = JSON.parse(JSON.stringify(s.data.items)); });
  assert.deepEqual(snapshot, [{ id: "A" }, { id: "B" }]);
  assert.equal(canUndo(), true);
  assert.equal(canRedo(), false);

  // New transaction invalidates redo
  undo(); // back to empty, redo stack has the add.items entry
  assert.equal(canRedo(), true);
  transaction("change.theme", "data.theme", s => { s.data.theme = "light"; });
  assert.equal(canRedo(), false, "new transaction wipes redo stack");

  // Multi-path transaction
  transaction("multi.set", ["data.items", "data.theme"], s => {
    s.data.items = [{ id: "Z" }];
    s.data.theme = "auto";
  });
  update(s => { snapshot = JSON.parse(JSON.stringify({ items: s.data.items, theme: s.data.theme })); });
  assert.deepEqual(snapshot, { items: [{ id: "Z" }], theme: "auto" });

  undo();
  update(s => { snapshot = JSON.parse(JSON.stringify({ items: s.data.items, theme: s.data.theme })); });
  // Both paths roll back together.
  assert.deepEqual(snapshot, { items: [], theme: "light" });

  // Ring buffer cap: push >50 transactions, verify only last 50 are kept.
  clearHistory();
  initState({ counter: 0 });
  for (let i = 0; i < 60; i++) {
    transaction(`tick.${i}`, "data.counter", s => { s.data.counter = i; });
  }
  stacks = historyStacks();
  assert.equal(stacks.undo.length, 50);
  // Oldest 10 should have been dropped — the remaining stack starts at tick.10.
  assert.equal(stacks.undo[0].name, "tick.10");
  assert.equal(stacks.undo[49].name, "tick.59");
});
