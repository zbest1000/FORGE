// Tests for help-topic indexing in src/core/search.js (unified search,
// Phase 4). Help topics are now a first-class collection in the
// search engine — searching for terms inside an article's body should
// surface the topic with a `Help` kind tag.

import { test, before } from "node:test";
import assert from "node:assert/strict";

// Stubs for module load.
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

const { initState } = await import("../src/core/store.js");
const { buildIndex, query } = await import("../src/core/search.js");

before(async () => {
  // Minimal seed — just enough to populate the data collections so
  // indexing doesn't throw. The help collection is always available
  // because it sources from the bundled HELP_TOPICS registry.
  initState({
    documents: [], drawings: [], revisions: [], assets: [],
    workItems: [], incidents: [], messages: [], channels: [],
    projects: [], teamSpaces: [],
  });
  await buildIndex();
});

test("help topics are indexed and queryable by title", () => {
  // forge.workitem is a known bundled topic. Searching its title
  // should return a Help-kind hit.
  const r = query("Work items", { limit: 10 });
  const helpHit = r.hits.find(h => h.kind === "Help");
  assert.ok(helpHit, "expected a Help-kind hit for query 'Work items'");
  assert.equal(helpHit.collection, "helpTopics");
  assert.match(helpHit.route, /^\/help\?topic=/);
});

test("help topic IDs are searchable", () => {
  // Searching for a known topic id (forge.workitem) should land us on
  // the help topic itself.
  const r = query("forge.workitem", { limit: 10 });
  const helpHit = r.hits.find(h => h.kind === "Help");
  assert.ok(helpHit, "expected to find the topic via its id token");
});

test("help collection is reflected in facetCounts", () => {
  const r = query("forge", { limit: 30 });
  // facetCounts includes per-kind tallies; Help should be present
  // because at least one help topic mentions "forge" in its body.
  assert.ok(r.facetCounts);
  const helpCount = (r.facetCounts.kind || {}).Help || 0;
  assert.ok(helpCount >= 1, `expected at least one Help hit; got ${helpCount}`);
});
