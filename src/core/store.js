// Centralized reactive store with localStorage persistence.

const LS_KEY = "forge.state.v1";

const listeners = new Set();

export const state = {
  route: "",
  ui: {
    role: "Engineer/Contributor",
    theme: "dark",
    dockVisible: true,
    workspaceId: "WS-1",
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
    console.warn("hydrate failed", e);
  }
}

function persist() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ ui: state.ui, data: state.data }));
  } catch (e) {
    console.warn("persist failed", e);
  }
}

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
