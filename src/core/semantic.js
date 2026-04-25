// Tiny semantic-ish re-rank built on character-trigram cosine similarity.
// Not an embedding model, but it captures partial-word and morphological
// overlap that BM25 alone misses ("valve sizing" ↔ "valves sized") and
// runs in pure JS without any external dependency. Provides the missing
// "semantic stage" of spec §15 hybrid retrieval.

function trigrams(s) {
  const t = " " + (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() + " ";
  const out = new Map();
  for (let i = 0; i <= t.length - 3; i++) {
    const g = t.slice(i, i + 3);
    out.set(g, (out.get(g) || 0) + 1);
  }
  return out;
}

function magnitude(map) {
  let s = 0;
  for (const v of map.values()) s += v * v;
  return Math.sqrt(s);
}

export function similarity(a, b) {
  if (!a || !b) return 0;
  const ta = trigrams(a);
  const tb = trigrams(b);
  let dot = 0;
  for (const [k, v] of ta) {
    const w = tb.get(k);
    if (w) dot += v * w;
  }
  const m = magnitude(ta) * magnitude(tb);
  return m === 0 ? 0 : dot / m;
}

/**
 * Re-rank an array of {doc, score} entries by mixing the BM25 score with
 * the trigram similarity to the original query. The mix weight (default
 * 0.4) is tuned empirically; raising it favors the semantic signal.
 */
export function semanticRerank(query, hits, mix = 0.4) {
  if (!query || !hits.length) return hits;
  const max = Math.max(1, ...hits.map(h => h.score || 0));
  return hits
    .map(h => {
      const s = similarity(query, (h.doc?.title || "") + " " + (h.doc?.text || "").slice(0, 240));
      const bm = (h.score || 0) / max; // normalize to 0..1
      return { ...h, score: (1 - mix) * bm + mix * s };
    })
    .sort((a, b) => b.score - a.score);
}
