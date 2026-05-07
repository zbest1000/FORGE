// Undo/redo on top of the store (Phase 4).
//
// Wraps mutations in a "transaction" that captures a before/after
// snapshot of the touched slice(s). Operations recorded here are
// reversible by name — `undo()` pops the last entry and replays its
// `before` snapshot through update(); `redo()` re-applies the
// `after` snapshot. A 50-entry ring buffer caps memory.
//
// What this is NOT:
//   - A general-purpose state machine (xstate handles complex flows;
//     this just records the last N reversible diffs).
//   - A multi-user CRDT — undo is local-only. Server-side mutations
//     don't roll back; this is a UX safety net for accidental
//     "applied profile to 50 wrong assets" mishaps.
//
// The transaction wraps update() so callers don't need to remember to
// snapshot manually:
//
//   transaction("apply.profile.bulk", "data.bindings", (s) => {
//     for (const a of assets) s.data.bindings.push(...);
//   });
//
//   undo();   // restores data.bindings to its pre-transaction value
//   redo();   // re-applies the changes
//
// Multi-slice transactions are supported by passing an array of paths.
// Mixing transaction() with raw update() works — the raw update()
// just doesn't appear in history.

import { state, update, markDirty } from "./store.js";
import { logger } from "./logging.js";

const MAX_HISTORY = 50;

/** @typedef {{ name: string, paths: string[], before: any[], after: any[], ts: string }} HistoryEntry */

/** @type {HistoryEntry[]} */
const _undoStack = [];
/** @type {HistoryEntry[]} */
const _redoStack = [];

/** @param {any} obj @param {string} path @returns {any} */
function getPath(obj, path) {
  if (!path) return obj;
  let cur = obj;
  for (const seg of path.split(".")) {
    if (cur == null) return undefined;
    cur = cur[seg];
  }
  return cur;
}

/** @param {any} obj @param {string} path @param {any} value */
function setPath(obj, path, value) {
  if (!path) return;
  const segs = path.split(".");
  let cur = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    if (cur[segs[i]] == null) cur[segs[i]] = {};
    cur = cur[segs[i]];
  }
  cur[segs[segs.length - 1]] = value;
}

// Deep clone via structuredClone — falls back to JSON for environments
// without it (older test harnesses). Caller should keep transactions
// scoped to JSON-safe slices (no Maps / Sets / functions).
/** @template T @param {T} v @returns {T} */
function clone(v) {
  try { return structuredClone(v); } catch { return JSON.parse(JSON.stringify(v)); }
}

/**
 * Run a mutation with before/after snapshots captured for undo/redo.
 * @param {string} name              human-readable op name (audit + UI)
 * @param {string|string[]} paths    slice path(s) the mutator will touch
 * @param {(s: any) => void} mutator
 */
export function transaction(name, paths, mutator) {
  const pathArr = Array.isArray(paths) ? paths : [paths];
  const before = pathArr.map(p => clone(getPath(state, p)));

  update(/** @param {any} s */ (s) => {
    mutator(s);
    // Multi-path transactions almost always touch arrays in-place;
    // mark each watched slice dirty so subscribers fire even when the
    // reference didn't change.
    for (const p of pathArr) markDirty(p);
  });

  const after = pathArr.map(p => clone(getPath(state, p)));
  const entry = { name, paths: pathArr, before, after, ts: new Date().toISOString() };
  _undoStack.push(entry);
  if (_undoStack.length > MAX_HISTORY) _undoStack.shift();
  // Any new transaction invalidates the redo stack — same model as
  // every text editor.
  _redoStack.length = 0;
  logger.debug("history.transaction", { name, paths: pathArr });
}

/**
 * Roll back the most recent transaction. Returns the entry that was
 * undone, or null if the stack is empty.
 */
export function undo() {
  const entry = _undoStack.pop();
  if (!entry) return null;
  update(/** @param {any} s */ (s) => {
    entry.paths.forEach((p, i) => setPath(s, p, clone(entry.before[i])));
    for (const p of entry.paths) markDirty(p);
  });
  _redoStack.push(entry);
  logger.debug("history.undo", { name: entry.name });
  return entry;
}

/**
 * Re-apply the last undone transaction. Returns the entry that was
 * redone, or null if there's nothing to redo.
 */
export function redo() {
  const entry = _redoStack.pop();
  if (!entry) return null;
  update(/** @param {any} s */ (s) => {
    entry.paths.forEach((p, i) => setPath(s, p, clone(entry.after[i])));
    for (const p of entry.paths) markDirty(p);
  });
  _undoStack.push(entry);
  logger.debug("history.redo", { name: entry.name });
  return entry;
}

/** Synchronous getters for UI buttons (enable/disable based on state). */
export function canUndo() { return _undoStack.length > 0; }
export function canRedo() { return _redoStack.length > 0; }

/**
 * Snapshots of the current stacks. Returns shallow copies so callers
 * can render history menus without mutating the internal arrays.
 */
export function historyStacks() {
  return {
    undo: _undoStack.map(e => ({ name: e.name, ts: e.ts })),
    redo: _redoStack.map(e => ({ name: e.name, ts: e.ts })),
  };
}

/** Test/debug only — drops both stacks. */
export function clearHistory() {
  _undoStack.length = 0;
  _redoStack.length = 0;
}
