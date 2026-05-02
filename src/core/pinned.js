// Pin / unpin store.
//
// Operators routinely focus on a small set of projects + assets at
// any given time but the left panel can carry dozens of each. This
// module is the canonical place every "pin to my left panel" toggle
// goes through, regardless of which screen surfaced the affordance.
//
// Persistence: localStorage, keyed per FORGE installation. Pins
// survive page reloads but don't sync across browsers — sync would
// require a server-side `user_preferences` table that we'll layer
// on later if real users care.
//
// Shape of a pin: `{ kind, id }`. Today we recognise:
//   * `project`  — id matches `state.data.projects[i].id`
//   * `asset`    — id matches `state.data.assets[i].id`
// Future kinds (document, drawing, incident) drop in by adding the
// corresponding click-handler in the left-panel renderer.

const STORAGE_KEY = "forge.pinned.v1";

/**
 * In-memory copy of the persisted set, keyed `${kind}:${id}` for
 * O(1) membership tests. Loaded lazily on first read so a hot
 * import doesn't touch storage.
 */
let _set = null;

function load() {
  if (_set) return _set;
  _set = new Set();
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return _set;
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      for (const p of arr) {
        if (p && typeof p.kind === "string" && typeof p.id === "string") {
          _set.add(`${p.kind}:${p.id}`);
        }
      }
    }
  } catch { /* private mode / malformed JSON — start empty */ }
  return _set;
}

function save() {
  try {
    const arr = [..._set].map(k => {
      const [kind, ...rest] = k.split(":");
      return { kind, id: rest.join(":") };
    });
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(arr));
  } catch { /* private mode */ }
}

const _listeners = new Set();
function notify() {
  for (const fn of _listeners) {
    try { fn(); } catch (e) { console.warn("[pinned] listener error", e); }
  }
}

/**
 * Subscribe to pin changes. Returns an unsubscribe function. The
 * left panel uses this to re-render when a pin toggles from any
 * screen, not just one.
 */
export function subscribe(fn) {
  if (typeof fn !== "function") return () => {};
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

/** True when the (kind, id) pair is currently pinned. */
export function isPinned(kind, id) {
  if (!kind || !id) return false;
  return load().has(`${kind}:${id}`);
}

/**
 * Toggle the pin state. Returns the new state (`true` = now pinned).
 * Notifies subscribers on change.
 */
export function togglePin(kind, id) {
  if (!kind || !id) return false;
  const set = load();
  const key = `${kind}:${id}`;
  let nowPinned;
  if (set.has(key)) {
    set.delete(key);
    nowPinned = false;
  } else {
    set.add(key);
    nowPinned = true;
  }
  save();
  notify();
  return nowPinned;
}

/**
 * Snapshot of current pins as `[{ kind, id }]`. Order preserved by
 * insertion (ES2015 Set semantics) so the most recently-pinned item
 * shows last in the left panel — operators expect "newest first" or
 * "oldest first" by personal preference; we leave that to the caller.
 */
export function getPinned() {
  return [...load()].map(k => {
    const [kind, ...rest] = k.split(":");
    return { kind, id: rest.join(":") };
  });
}

/** Filter the pinned list to a single kind. Convenience for the left panel. */
export function getPinnedOfKind(kind) {
  return getPinned().filter(p => p.kind === kind);
}

/**
 * Test seam — wipes the in-memory set. Call between test cases to
 * isolate state. localStorage is NOT cleared because tests run
 * against a stub doc/window that doesn't expose it.
 */
export function _reset() {
  _set = new Set();
  _listeners.clear();
}
