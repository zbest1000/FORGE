// Unified search (spec §15).
//
// Primary path: MiniSearch (MIT) — BM25 + prefix + fuzzy full-text engine.
// Fallback: hand-rolled BM25 + substring scorer kept in this file, used only
// when MiniSearch fails to load (offline / CDN blocked).
//
// Behaviour the UI depends on:
//   buildIndex()                         (re)indexes every collection
//   query(q, { facets, limit }) -> { hits, total, facetCounts }
//   saveSearch(name, query, facets)
//   listSavedSearches(), deleteSavedSearch(id)

import { state, update } from "./store.js";
import { audit } from "./audit.js";
import { vendor } from "./vendor.js";
import { semanticRerank } from "./semantic.js";
import { HELP_TOPICS } from "./help.js";

const COLLECTIONS = [
  { name: "documents",  kind: "Document",  route: o => `/doc/${o.id}`,               fields: ["name", "discipline", "sensitivity", "labels"] },
  { name: "drawings",   kind: "Drawing",   route: o => `/drawing/${o.id}`,           fields: ["name", "discipline", "labels"] },
  { name: "revisions",  kind: "Revision",  route: o => `/doc/${o.docId}`,            fields: ["summary", "notes", "status", "label"] },
  { name: "assets",     kind: "Asset",     route: o => `/asset/${o.id}`,             fields: ["name", "type", "hierarchy", "mqttTopics", "opcuaNodes"] },
  { name: "workItems",  kind: "WorkItem",  route: o => `/work-board/${o.projectId}`, fields: ["title", "type", "status", "severity"] },
  { name: "incidents",  kind: "Incident",  route: o => `/incident/${o.id}`,          fields: ["title", "severity", "status"] },
  { name: "messages",   kind: "Message",   route: o => `/channel/${o.channelId}`,    fields: ["text", "type"] },
  { name: "channels",   kind: "Channel",   route: o => `/channel/${o.id}`,           fields: ["name", "kind"] },
  { name: "projects",   kind: "Project",   route: o => `/work-board/${o.id}`,        fields: ["name", "status"] },
  { name: "teamSpaces", kind: "TeamSpace", route: o => `/team-space/${o.id}`,        fields: ["name", "summary"] },
  // Help topics are pulled from the help registry, not from state.data,
  // so collectDocs() has a special case below to populate them. The
  // route opens the help page anchored to the topic id.
  { name: "helpTopics", kind: "Help",      route: o => `/help?topic=${encodeURIComponent(o.id)}`, fields: ["title", "summary", "section", "body"] },
];

let _miniSearch = null;
let _docsById = new Map();  // `${collection}:${id}` -> enriched doc
let _fallback = null;        // hand-rolled index, used if MiniSearch failed
let _rebuildTimer = null;
let _lastEngine = "none";

function extractText(collection, obj) {
  const parts = [];
  for (const f of collection.fields) {
    const v = obj[f];
    if (Array.isArray(v)) parts.push(v.join(" "));
    else if (v != null) parts.push(String(v));
  }
  parts.push(obj.id || "");
  return parts.join(" ");
}

/** Sources for each collection: most read from state.data, but help
 *  topics come from the bundled registry (and any runtime overrides
 *  applied via applyHelpOverrides()). Returns the list of objects
 *  that the indexer will tokenise. */
function sourceFor(collectionName) {
  if (collectionName === "helpTopics") {
    // Map id → object with `id` field included so extractText + the
    // route closure can both reach it. Bundled HELP_TOPICS plus any
    // operator-supplied overrides are visible to search the same way.
    return Object.entries(HELP_TOPICS).map(([id, t]) => ({ id, ...t }));
  }
  return state.data?.[collectionName] || [];
}

function collectDocs() {
  const docs = [];
  _docsById = new Map();
  for (const c of COLLECTIONS) {
    const list = sourceFor(c.name);
    for (const obj of list) {
      const text = extractText(c, obj);
      const doc = {
        id: `${c.name}:${obj.id}`,
        collection: c.name,
        kind: c.kind,
        route: c.route(obj),
        title: obj.name || obj.title || obj.id,
        text,
        raw: obj,
      };
      docs.push(doc);
      _docsById.set(doc.id, doc);
    }
  }
  return docs;
}

export async function buildIndex() {
  const docs = collectDocs();
  try {
    const MiniSearchCtor = await vendor.minisearch();
    const ms = new MiniSearchCtor({
      fields: ["title", "text", "kind"],
      storeFields: ["title", "kind"],
      idField: "id",
      searchOptions: {
        boost: { title: 2 },
        fuzzy: 0.2,
        prefix: true,
        combineWith: "AND",
      },
    });
    ms.addAll(docs);
    _miniSearch = ms;
    _lastEngine = "minisearch";
    _fallback = null;
  } catch {
    _miniSearch = null;
    _lastEngine = "fallback";
    _fallback = buildFallback(docs);
  }
}

// Debounce window. Bumped from 250 ms to 500 ms because the catch-all
// rebuild path is the slow one (full re-add of every collection); when
// callers know precisely what changed they should use addEntity /
// removeEntity below for an O(1) update instead of waiting on the
// debounced rebuild.
const REBUILD_DEBOUNCE_MS = Number(globalThis.process?.env?.FORGE_SEARCH_DEBOUNCE_MS || 500);

export function scheduleRebuild() {
  if (_rebuildTimer) return;
  _rebuildTimer = setTimeout(() => { _rebuildTimer = null; buildIndex(); }, REBUILD_DEBOUNCE_MS);
}

/**
 * Differential update — add (or replace) a single object in the index
 * without rebuilding the rest. Callers that just mutated one entity
 * should prefer this over scheduleRebuild() so a 200-asset workspace
 * doesn't re-index 200 docs every time the user types in a filter.
 *
 * Falls through to scheduleRebuild() if the index hasn't been built
 * yet — the first build still has to be a full pass.
 */
export function addEntity(collectionName, obj) {
  if (!_miniSearch) { scheduleRebuild(); return; }
  const c = COLLECTIONS.find(x => x.name === collectionName);
  if (!c) return;
  const id = `${collectionName}:${obj.id}`;
  const text = extractText(c, obj);
  const doc = {
    id, collection: collectionName, kind: c.kind, route: c.route(obj),
    title: obj.name || obj.title || obj.id, text, raw: obj,
  };
  // MiniSearch's `addOrReplace` is sync and O(log N) on the postings —
  // a full rebuild over 10 collections × N docs is O(N) per collection
  // PER REBUILD, so the differential path saves real cycles.
  if (typeof _miniSearch.replace === "function") {
    try { _miniSearch.discard(id); } catch { /* unknown id is fine */ }
    _miniSearch.add(doc);
  } else {
    _miniSearch.add(doc);
  }
  _docsById.set(id, doc);
}

export function removeEntity(collectionName, id) {
  if (!_miniSearch) { scheduleRebuild(); return; }
  const fullId = `${collectionName}:${id}`;
  try { _miniSearch.discard(fullId); } catch { /* not indexed yet */ }
  _docsById.delete(fullId);
}

export function indexEngine() { return _lastEngine; }

/**
 * Execute a query. Returns `{ hits, total, facetCounts }`.
 */
export function query(q, { facets = {}, limit = 50 } = {}) {
  if (!_miniSearch && !_fallback) {
    // Hadn't built yet — build synchronously with fallback for first call.
    _fallback = buildFallback(collectDocs());
    _lastEngine = _lastEngine === "none" ? "fallback" : _lastEngine;
  }

  const rawHits = _miniSearch ? miniQuery(q, limit) : fallbackQuery(q, limit);
  const ranked = q ? semanticRerank(q, rawHits, 0.35) : rawHits;
  const filtered = ranked.filter(h => passesFacets(h.doc, facets) && passesAcl(h.doc));
  const hits = filtered;
  const facetCounts = computeFacets(filtered.map(h => h.doc));

  return {
    engine: _lastEngine,
    hits: filtered.slice(0, limit).map(h => ({
      score: h.score,
      collection: h.doc.collection,
      kind: h.doc.kind,
      route: h.doc.route,
      title: h.doc.title,
      id: h.doc.raw.id,
      snippet: snippet(h.doc.text, q),
      raw: h.doc.raw,
    })),
    total: filtered.length,
    facetCounts,
  };
}

function miniQuery(q, limit) {
  if (!q || !q.trim()) {
    // Facet-only browse: return every doc at score 0.
    return [..._docsById.values()].slice(0, 500).map(doc => ({ score: 0, doc }));
  }
  const raw = _miniSearch.search(q, { fuzzy: 0.2, prefix: true });
  const out = [];
  for (const r of raw) {
    const doc = _docsById.get(r.id);
    if (doc) out.push({ score: r.score || 0, doc });
    if (out.length >= Math.max(limit * 3, 60)) break;
  }
  return out;
}

// --- Fallback hand-rolled BM25 (used only if MiniSearch won't load) ---

function tokenize(text) {
  if (!text) return [];
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\-_\/]+/g, " ")
    .split(/\s+/)
    .filter(t => t.length > 1);
}

function buildFallback(docs) {
  const N = docs.length || 1;
  const df = new Map();
  const tokens = new Map();
  for (const d of docs) {
    const t = tokenize(d.text + " " + (d.title || ""));
    tokens.set(d.id, t);
    const seen = new Set();
    for (const w of t) { if (seen.has(w)) continue; seen.add(w); df.set(w, (df.get(w) || 0) + 1); }
  }
  const avgdl = docs.reduce((s, d) => s + tokens.get(d.id).length, 0) / N;
  const idf = new Map();
  for (const [t, n] of df) idf.set(t, Math.log(1 + (N - n + 0.5) / (n + 0.5)));
  const postings = new Map();
  for (const d of docs) {
    const tf = {};
    for (const w of tokens.get(d.id)) tf[w] = (tf[w] || 0) + 1;
    for (const [w, c] of Object.entries(tf)) {
      if (!postings.has(w)) postings.set(w, []);
      postings.get(w).push({ doc: d, tf: c });
    }
  }
  return { docs, idf, postings, avgdl, tokens };
}

function fallbackQuery(q, limit) {
  if (!_fallback) return [];
  const qt = tokenize(q);
  const k1 = 1.5, b = 0.75;
  const scores = new Map();
  for (const t of qt) {
    const idf = _fallback.idf.get(t) || 0;
    for (const { doc, tf } of (_fallback.postings.get(t) || [])) {
      const dl = _fallback.tokens.get(doc.id).length;
      const s = idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (dl / _fallback.avgdl))));
      scores.set(doc.id, (scores.get(doc.id) || 0) + s);
    }
  }
  for (const doc of _fallback.docs) {
    for (const t of qt) if (doc.text.toLowerCase().includes(t)) scores.set(doc.id, (scores.get(doc.id) || 0) + 0.5);
  }
  const byId = new Map(_fallback.docs.map(d => [d.id, d]));
  return [...scores.entries()]
    .map(([id, score]) => ({ score, doc: byId.get(id) }))
    .filter(h => h.doc)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit * 3);
}

// --- common helpers ---

function passesFacets(doc, facets) {
  for (const [k, vals] of Object.entries(facets || {})) {
    if (!vals || !vals.length) continue;
    const got =
      k === "kind" ? doc.kind :
      k === "status" ? doc.raw.status :
      k === "discipline" ? doc.raw.discipline :
      k === "project" ? doc.raw.projectId :
      k === "teamSpace" ? doc.raw.teamSpaceId :
      null;
    if (!vals.includes(got)) return false;
  }
  return true;
}

function passesAcl(doc) {
  const acl = doc.raw.acl;
  if (!acl) return true;
  if (acl.roles && acl.roles.includes("*")) return true;
  if (acl.roles && acl.roles.includes(state.ui.role)) return true;
  return false;
}

function computeFacets(docs) {
  const out = { kind: {}, status: {}, discipline: {}, project: {}, teamSpace: {} };
  for (const d of docs) {
    inc(out.kind, d.kind);
    inc(out.status, d.raw.status);
    inc(out.discipline, d.raw.discipline);
    inc(out.project, d.raw.projectId);
    inc(out.teamSpace, d.raw.teamSpaceId);
  }
  return out;
}
function inc(map, key) { if (!key) return; map[key] = (map[key] || 0) + 1; }

function snippet(text, q) {
  if (!text) return "";
  if (!q) return text.slice(0, 140);
  const lower = text.toLowerCase();
  const first = (q || "").toLowerCase().split(/\s+/).find(Boolean) || "";
  const idx = first ? lower.indexOf(first) : -1;
  if (idx < 0) return text.slice(0, 140);
  const start = Math.max(0, idx - 40);
  return (start > 0 ? "…" : "") + text.slice(start, start + 160) + "…";
}

// --- saved searches ---
export function saveSearch(name, query, facets) {
  const entry = {
    id: "SS-" + Math.random().toString(36).slice(2, 8).toUpperCase(),
    name, query, facets, created_at: new Date().toISOString(),
  };
  update(s => { s.data.savedSearches = s.data.savedSearches || []; s.data.savedSearches.push(entry); });
  audit("search.save", entry.id, { name });
  return entry;
}
export function listSavedSearches() { return (state.data.savedSearches || []).slice(); }
export function deleteSavedSearch(id) {
  update(s => { s.data.savedSearches = (s.data.savedSearches || []).filter(x => x.id !== id); });
  audit("search.delete", id, {});
}
