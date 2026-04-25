// `/go OBJ-ID` parser. Resolves an object-id token to a deep-link route and
// optionally a revision selector, e.g. `/go D-101 Rev C` or `/go INC-4412`.
//
// Returns the resolved route string or null.

import { state } from "./store.js";

export function resolveGo(input) {
  const text = String(input || "").trim();
  if (!text) return null;
  const lower = text.toLowerCase();

  // Strip leading "/go " keyword.
  const stripped = lower.startsWith("/go ") ? text.slice(4).trim() : text;

  // Capture revision tail: "... rev C" or "... revision C-2"
  const revMatch = stripped.match(/^(.+?)\s+(?:rev|revision)\s+([A-Za-z0-9._-]+)\s*$/i);
  const idPart = revMatch ? revMatch[1].trim() : stripped;
  const revLabel = revMatch ? revMatch[2].trim() : null;

  const id = idPart.replace(/^[\[\(]/, "").replace(/[\]\)]$/, "");

  const d = state.data || {};

  // Direct id matches in priority order.
  if (matches(d.documents, id)) {
    const doc = pick(d.documents, id);
    if (revLabel) {
      const rev = (d.revisions || []).find(r => r.docId === doc.id && (r.label || "").toLowerCase() === revLabel.toLowerCase());
      if (rev) {
        // Set the doc viewer's selected revision and jump there.
        sessionStorage.setItem(`doc.${doc.id}.rev`, rev.id);
        return `/doc/${doc.id}`;
      }
    }
    return `/doc/${doc.id}`;
  }
  if (matches(d.drawings, id))   return `/drawing/${pick(d.drawings, id).id}`;
  if (matches(d.assets, id))     return `/asset/${pick(d.assets, id).id}`;
  if (matches(d.workItems, id)) {
    const w = pick(d.workItems, id);
    return `/work-board/${w.projectId}`;
  }
  if (matches(d.incidents, id))  return `/incident/${pick(d.incidents, id).id}`;
  if (matches(d.channels, id))   return `/channel/${pick(d.channels, id).id}`;
  if (matches(d.projects, id))   return `/work-board/${pick(d.projects, id).id}`;
  if (matches(d.teamSpaces, id)) return `/team-space/${pick(d.teamSpaces, id).id}`;

  // Revision id directly.
  const rev = (d.revisions || []).find(r => idEq(r.id, id));
  if (rev) {
    sessionStorage.setItem(`doc.${rev.docId}.rev`, rev.id);
    return `/doc/${rev.docId}`;
  }

  return null;
}

function idEq(a, b) { return String(a || "").toLowerCase() === String(b || "").toLowerCase(); }
function matches(coll, id) { return Array.isArray(coll) && coll.some(x => idEq(x.id, id)); }
function pick(coll, id) { return coll.find(x => idEq(x.id, id)); }
