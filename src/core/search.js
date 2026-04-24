// Unified search (spec §15) — BM25 inverted index over every object type,
// with facets and saved searches.
//
// The index is lazily built and rebuilt on a debounced tick whenever the
// store mutates. For ~1000 documents this is fast enough to rebuild from
// scratch in the browser; swap for a real incremental indexer later.

import { state, update } from "./store.js";
import { can } from "./permissions.js";
import { audit } from "./audit.js";

const COLLECTIONS = [
  { name: "documents",  kind: "Document",  route: o => `/doc/${o.id}`,                fields: ["name", "discipline", "sensitivity", "labels"] },
  { name: "drawings",   kind: "Drawing",   route: o => `/drawing/${o.id}`,            fields: ["name", "discipline", "labels"] },
  { name: "revisions",  kind: "Revision",  route: o => `/doc/${o.docId}`,             fields: ["summary", "notes", "status", "label"] },
  { name: "assets",     kind: "Asset",     route: o => `/asset/${o.id}`,              fields: ["name", "type", "hierarchy", "mqttTopics", "opcuaNodes"] },
  { name: "workItems",  kind: "WorkItem",  route: o => `/work-board/${o.projectId}`,  fields: ["title", "type", "status", "severity"] },
  { name: "incidents",  kind: "Incident",  route: o => `/incident/${o.id}`,           fields: ["title", "severity", "status"] },
  { name: "messages",   kind: "Message",   route: o => `/channel/${o.channelId}`,     fields: ["text", "type"] },
  { name: "channels",   kind: "Channel",   route: o => `/channel/${o.id}`,            fields: ["name", "kind"] },
  { name: "projects",   kind: "Project",   route: o => `/work-board/${o.id}`,         fields: ["name", "status"] },
  { name: "teamSpaces", kind: "TeamSpace", route: o => `/team-space/${o.id}`,         fields: ["name", "summary"] },
];

let _index = null;
let _rebuildTimer = null;

function tokenize(text) {
  if (!text) return [];
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\-_\/]+/g, " ")
    .split(/\s+/)
    .filter(t => t.length > 1);
}

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

export function buildIndex() {
  const docs = [];
  for (const c of COLLECTIONS) {
    const list = state.data?.[c.name] || [];
    for (const obj of list) {
      docs.push({
        id: `${c.name}:${obj.id}`,
        collection: c.name,
        kind: c.kind,
        route: c.route(obj),
        title: obj.name || obj.title || obj.id,
        text: extractText(c, obj),
        raw: obj,
        tokens: tokenize(extractText(c, obj) + " " + (obj.name || obj.title || "")),
      });
    }
  }

  const N = docs.length || 1;
  const df = new Map();
  for (const d of docs) {
    const seen = new Set();
    for (const t of d.tokens) {
      if (seen.has(t)) continue;
      seen.add(t);
      df.set(t, (df.get(t) || 0) + 1);
    }
  }

  const avgdl = docs.reduce((s, d) => s + d.tokens.length, 0) / N;
  const idf = new Map();
  for (const [t, n] of df) {
    idf.set(t, Math.log(1 + (N - n + 0.5) / (n + 0.5)));
  }

  const postings = new Map(); // token -> [{ doc, tf }]
  for (const d of docs) {
    const tf = {};
    for (const t of d.tokens) tf[t] = (tf[t] || 0) + 1;
    for (const [t, count] of Object.entries(tf)) {
      if (!postings.has(t)) postings.set(t, []);
      postings.get(t).push({ doc: d, tf: count });
    }
  }

  _index = { docs, df, idf, postings, avgdl, N };
  return _index;
}

export function scheduleRebuild() {
  if (_rebuildTimer) return;
  _rebuildTimer = setTimeout(() => {
    _rebuildTimer = null;
    buildIndex();
  }, 250);
}

function ensureIndex() {
  if (!_index) buildIndex();
  return _index;
}

/**
 * BM25 scoring with k1=1.5, b=0.75.
 */
function bm25(queryTokens, idx) {
  const k1 = 1.5, b = 0.75;
  const scores = new Map();
  for (const qt of queryTokens) {
    const post = idx.postings.get(qt) || [];
    const idf = idx.idf.get(qt) || 0;
    for (const { doc, tf } of post) {
      const dl = doc.tokens.length;
      const score = idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (dl / idx.avgdl))));
      scores.set(doc.id, (scores.get(doc.id) || 0) + score);
    }
  }
  // Substring fallback gives partial matches that BM25 alone misses.
  for (const doc of idx.docs) {
    for (const qt of queryTokens) {
      if (doc.text.toLowerCase().includes(qt)) {
        scores.set(doc.id, (scores.get(doc.id) || 0) + 0.5);
      }
    }
  }
  return scores;
}

/**
 * Execute a query with optional facet filters. Returns ranked results
 * filtered by the current role's ACL.
 */
export function query(q, { facets = {}, limit = 50 } = {}) {
  const idx = ensureIndex();
  const qt = tokenize(q);
  if (!qt.length && !Object.keys(facets).length) return { hits: [], total: 0, facetCounts: {} };

  let scores;
  if (qt.length) {
    scores = bm25(qt, idx);
  } else {
    scores = new Map(idx.docs.map(d => [d.id, 0])); // facet-only browse
  }

  const docById = new Map(idx.docs.map(d => [d.id, d]));
  const hits = [...scores.entries()]
    .map(([id, score]) => ({ score, doc: docById.get(id) }))
    .filter(h => h.doc && passesFacets(h.doc, facets) && passesAcl(h.doc));

  hits.sort((a, b) => b.score - a.score);

  // Facet counts across the filtered set.
  const facetCounts = computeFacets(hits.map(h => h.doc));

  return {
    hits: hits.slice(0, limit).map(h => ({
      score: h.score,
      collection: h.doc.collection,
      kind: h.doc.kind,
      route: h.doc.route,
      title: h.doc.title,
      id: h.doc.raw.id,
      snippet: snippet(h.doc.text, qt),
      raw: h.doc.raw,
    })),
    total: hits.length,
    facetCounts,
  };
}

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
  // External guests can only see explicitly external things; in the seed we
  // rely on role-in-acl.
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
function inc(map, key) {
  if (!key) return;
  map[key] = (map[key] || 0) + 1;
}

function snippet(text, qt) {
  if (!text || !qt.length) return "";
  const lower = text.toLowerCase();
  const idx = lower.indexOf(qt[0]);
  if (idx < 0) return text.slice(0, 140);
  const start = Math.max(0, idx - 40);
  return (start > 0 ? "…" : "") + text.slice(start, start + 160) + "…";
}

// Saved searches.
export function saveSearch(name, query, facets) {
  const entry = {
    id: "SS-" + Math.random().toString(36).slice(2, 8).toUpperCase(),
    name,
    query,
    facets,
    created_at: new Date().toISOString(),
  };
  update(s => { s.data.savedSearches = s.data.savedSearches || []; s.data.savedSearches.push(entry); });
  audit("search.save", entry.id, { name });
  return entry;
}

export function listSavedSearches() {
  return (state.data.savedSearches || []).slice();
}

export function deleteSavedSearch(id) {
  update(s => { s.data.savedSearches = (s.data.savedSearches || []).filter(x => x.id !== id); });
  audit("search.delete", id, {});
}
