// Centralized reactive store with localStorage persistence.

const LS_KEY = "forge.state.v1";

const listeners = new Set();

export const state = {
  route: "",
  ui: {
    role: "Engineer/Contributor",
    theme: "dark",
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
    // User-set widths for the resizable side panels. Null = use the
    // CSS-default (260 / 340). Persisted across reloads via hydrate().
    leftPanelWidth: null,
    rightPanelWidth: null,
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
    if (!saved || typeof saved !== "object") {
      console.warn("hydrate: saved state is not an object, ignoring");
      return;
    }
    // Schema-light validation: only copy keys that already exist on the
    // in-memory shape, and only when the type matches. Prevents an older
    // or corrupted payload from replacing an array with a string and
    // crashing a screen on first render.
    if (saved.ui && typeof saved.ui === "object") {
      for (const key of Object.keys(saved.ui)) {
        if (!(key in state.ui)) continue;
        const expected = state.ui[key];
        const incoming = saved.ui[key];
        if (expected === null || incoming === null) { state.ui[key] = incoming; continue; }
        if (typeof expected !== typeof incoming) continue;
        if (Array.isArray(expected) !== Array.isArray(incoming)) continue;
        state.ui[key] = incoming;
      }
    }
    if (saved.data && typeof saved.data === "object" && state.data) {
      for (const key of Object.keys(saved.data)) {
        if (!(key in state.data)) continue;
        const expected = state.data[key];
        const incoming = saved.data[key];
        if (Array.isArray(expected) !== Array.isArray(incoming)) continue;
        if (expected != null && typeof expected !== typeof incoming) continue;
        state.data[key] = incoming;
      }
    }
  } catch (e) {
    console.warn("hydrate failed; falling back to fresh seed", e);
    try { localStorage.removeItem(LS_KEY); } catch { /* ignore */ }
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
    console.warn("persist failed", e);
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

export function notify() {
  persist();
  listeners.forEach(fn => { try { fn(state); } catch (e) { console.error(e); } });
}

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
