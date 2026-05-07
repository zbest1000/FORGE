// Centralized reactive store with localStorage persistence.

import { logger } from "./logging.js";

// Bumped to v2 (2026-05): stale v1 state held a CSP-blocked external PDF URL
// in seed revisions, leaving the doc viewer empty for returning users. v2
// invalidates the cached state so the new local /sample.pdf seed takes effect.
// Users keep their own uploaded docs by re-uploading via the viewer's
// "Attach PDF" action — demo state is otherwise self-replenishing.
const LS_KEY = "forge.state.v2";

const listeners = new Set();

// UX-A: default theme respects the pre-paint resolution. The inline
// script in `index.html` writes `data-initial-theme` onto <html>
// after consulting localStorage + `prefers-color-scheme`, so we read
// it here to seed the in-memory store. If the attribute is missing
// (headless tests, screen-readers, environments where the inline
// script didn't run) we fall back to `"dark"`. The hydrate path
// below still overrides this with whatever was saved last —
// `data-initial-theme` is purely for the very first session.
function _defaultTheme() {
  try {
    const t = globalThis.document?.documentElement?.dataset?.initialTheme;
    if (t === "dark" || t === "light") return t;
  } catch { /* not a browser context */ }
  return "dark";
}

export const state = {
  route: "",
  ui: {
    role: "Engineer/Contributor",
    theme: _defaultTheme(),
    // Operations notifications now surface through the header bell button.
    // Older sessions used a permanent bottom dock — keeping the flag for
    // backwards-compat with the View ▾ menu, but defaulting it to off.
    dockVisible: false,
    workspaceId: "WS-1",
    // Layout toggles — let the user reclaim screen real estate.
    showRail: true,
    showLeftPanel: true,
    // The right context panel is now on-demand; users open it from the
    // header "Details" button. We auto-open it when navigating to an
    // object route with rich detail (doc / drawing / asset / incident /
    // work board) the first time per session — see `app.js`.
    showContextPanel: false,
    showHeader: true,
    // True once the user has manually changed `state.ui.role`. Prevents
    // the post-login server role sync from blowing away an explicit
    // override.
    roleOverridden: false,
    focusMode: false,        // true → hide both side panels
    fieldMode: false,        // larger touch targets and field-friendly density
    portalId: null,          // null = default rail; set to a portal id to filter
    selectedTeamSpaceId: null,
    selectedChannelId: null,
    selectedProjectId: null,
    selectedDocId: null,
    selectedDrawingId: null,
    selectedAssetId: null,
    selectedIncidentId: null,
    compare: { leftRevisionId: null, rightRevisionId: null, opacity: 0.5 },
    aiThread: [],
  },
  data: null,
};

export function initState(seed) {
  state.data = seed;
  hydrate();
}

function hydrate() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (saved.ui) Object.assign(state.ui, saved.ui);
    if (saved.data) {
      // Merge select collections the user may have mutated.
      for (const key of Object.keys(saved.data)) {
        if (state.data[key] != null) state.data[key] = saved.data[key];
      }
    }
  } catch (e) {
    logger.warn("store.hydrate.failed", e);
  }
}

// Debounced persistence — bursts of `update()` calls (typing in an input,
// dragging a kanban card, setInterval rerenders) coalesce into one write
// instead of N writes of ~50 KB JSON.
let _persistTimer = null;
function persistNow() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ ui: state.ui, data: state.data }));
  } catch (e) {
    logger.warn("store.persist.failed", e);
  }
}
function persist() {
  if (_persistTimer) return;
  // Use rIC where available so the write happens during idle time; fall back
  // to a 250 ms timeout otherwise.
  const schedule = window.requestIdleCallback || ((cb) => setTimeout(cb, 250));
  _persistTimer = schedule(() => {
    _persistTimer = null;
    persistNow();
  });
}

// Flush any pending write before the page unloads so a tab close doesn't
// drop the latest mutation.
window.addEventListener("beforeunload", () => {
  if (_persistTimer) {
    if (window.cancelIdleCallback && typeof _persistTimer === "number") {
      try { window.cancelIdleCallback(_persistTimer); } catch {}
    }
    persistNow();
  }
});

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Slice subscriptions (Phase 3 architecture).
//
// `subscribe()` above fires for every mutation. That's fine for top-level
// shell + screen renders, but means every keystroke in a filter input
// causes the whole shell to re-render even though only the filter
// state moved. Slice subscriptions narrow the listener: callers register
// interest in a specific path (e.g. "data.workItems", "ui.theme") and
// only get notified when that path actually changed between the
// pre-mutation snapshot and the post-mutation state.
//
// The contract is intentionally simple — paths are dot-strings,
// equality is reference-equality on the deepest segment, and a
// missing path resolves to undefined (matching JS's "?." behavior).
// This handles the 95 % case without dragging in immutable.js or a
// proper diff engine.
//
// `subscribeSlice("data.workItems", fn)` calls fn(newSlice, oldSlice)
// when the array reference changes. Mutations done in-place via
// `update(s => s.data.workItems.push(...))` won't fire the slice
// listener (the array reference is unchanged) — callers that want
// fine-grained reactivity should swap the array (`s.data.workItems = [...s.data.workItems, x]`)
// or call markDirty(path) explicitly.

/** @type {Map<string, Set<(next: any, prev: any) => void>>} */
const sliceListeners = new Map();
/** @type {Set<string>} */
const dirtyPaths = new Set();

function getPath(obj, path) {
  if (!path) return obj;
  let cur = obj;
  for (const seg of path.split(".")) {
    if (cur == null) return undefined;
    cur = cur[seg];
  }
  return cur;
}

/**
 * Subscribe to a single slice of state. Returns an unsubscribe fn.
 * @param {string} path Dot-separated path, e.g. "data.workItems" or "ui.theme".
 * @param {(next: any, prev: any) => void} fn
 */
export function subscribeSlice(path, fn) {
  if (!sliceListeners.has(path)) sliceListeners.set(path, new Set());
  sliceListeners.get(path).add(fn);
  return () => {
    const set = sliceListeners.get(path);
    if (set) {
      set.delete(fn);
      if (set.size === 0) sliceListeners.delete(path);
    }
  };
}

/**
 * Mark a path as dirty so its slice listeners fire on the next
 * notify(), even if reference-equality says nothing changed. Used by
 * mutation helpers that mutate-in-place (push/splice) and want to
 * still surface the change.
 */
export function markDirty(path) { dirtyPaths.add(path); }

export function notify() {
  persist();
  // Slice subscribers: fire only the ones whose watched path's value
  // actually changed since the last notify. Snapshots are kept on the
  // listener set so each subscription is independent.
  for (const [path, set] of sliceListeners) {
    const next = getPath(state, path);
    const isDirty = dirtyPaths.has(path);
    for (const fn of set) {
      // Each listener carries its own `_lastSeen` weak-cache via a
      // dedicated WeakMap-substitute: the function itself doesn't get a
      // hidden field so we use a separate map keyed by the fn.
      const prev = _slicePrev.get(fn);
      if (isDirty || prev !== next) {
        _slicePrev.set(fn, next);
        try { fn(next, prev); } catch (e) { logger.error("store.slice-listener.threw", { path, err: e }); }
      }
    }
  }
  dirtyPaths.clear();
  // Top-level subscribers: fire unconditionally (matches the legacy
  // contract). Screens that want to opt out of the global storm should
  // migrate to subscribeSlice().
  listeners.forEach(fn => { try { fn(state); } catch (e) { logger.error("store.listener.threw", e); } });
}

/** @type {WeakMap<Function, any>} */
const _slicePrev = new WeakMap();

export function update(mutator) {
  mutator(state);
  notify();
}

export function resetState() {
  localStorage.removeItem(LS_KEY);
  location.reload();
}

// Entity helpers
export function getById(collection, id) {
  return (state.data[collection] || []).find(x => x.id === id) || null;
}

export function byIds(collection, ids) {
  const set = new Set(ids || []);
  return (state.data[collection] || []).filter(x => set.has(x.id));
}

export function listBy(collection, predicate) {
  return (state.data[collection] || []).filter(predicate);
}

export function upsert(collection, item) {
  const list = state.data[collection] || (state.data[collection] = []);
  const idx = list.findIndex(x => x.id === item.id);
  if (idx >= 0) list[idx] = { ...list[idx], ...item };
  else list.push(item);
  return item;
}

export function remove(collection, id) {
  const list = state.data[collection] || [];
  const idx = list.findIndex(x => x.id === id);
  if (idx >= 0) list.splice(idx, 1);
}

// Audit log — delegates to the hash-chained ledger in `core/audit.js`.
// Kept as a thin wrapper so existing screens keep calling `audit(...)`
// without caring about the Web Crypto queue.
export function audit(action, subject, detail = {}) {
  // Lazy require so this module stays framework-free for tests.
  const mod = _auditMod || (_auditMod = globalThis.__forgeAudit || null);
  if (mod && typeof mod.audit === "function") return mod.audit(action, subject, detail);
  // Fallback (during bootstrap before audit.js has registered).
  const entry = {
    id: `AUD-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    ts: new Date().toISOString(),
    actor: state.ui.role,
    action,
    subject: String(subject || ""),
    detail: detail || {},
    prevHash: null,
    hash: null,
  };
  state.data.auditEvents = state.data.auditEvents || [];
  state.data.auditEvents.unshift(entry);
  return entry;
}

let _auditMod = null;
/** Called by `core/audit.js` once loaded so `store.audit` can delegate. */
export function registerAuditImpl(mod) { _auditMod = mod; globalThis.__forgeAudit = mod; }

// ID generator
let _seq = Date.now() % 100000;
export function nextId(prefix) {
  _seq += 1;
  return `${prefix}-${_seq.toString(36).toUpperCase()}`;
}
