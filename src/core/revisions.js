// Revision lifecycle state machine (spec §7 #3 and §10 #3 revision promotion).
// States and allowed transitions:
//
//   Draft     → IFR, Archived
//   IFR       → Approved, Rejected, Draft, Archived
//   Approved  → IFC, Rejected, Archived
//   IFC       → Superseded (auto when another IFC arrives), Archived
//   Rejected  → Draft, Archived
//   Superseded, Archived → (terminal)
//
// Promoting a revision to IFC will automatically mark the document's previous
// IFC revision as Superseded (spec §10 #3 "approved revision set current;
// prior set superseded").

import { state, update, getById } from "./store.js";
import { audit } from "./audit.js";
import { touch } from "./normalize.js";
import { fanout } from "./subscriptions.js";

const ALLOWED = {
  Draft: ["IFR", "Archived"],
  IFR: ["Approved", "Rejected", "Draft", "Archived"],
  Approved: ["IFC", "Rejected", "Archived"],
  IFC: ["Superseded", "Archived"],
  Rejected: ["Draft", "Archived"],
  Superseded: [],
  Archived: [],
};

export function canTransition(fromStatus, toStatus) {
  return (ALLOWED[fromStatus] || []).includes(toStatus);
}

/**
 * Transition a revision. Returns the updated revision or throws an Error if
 * the transition is not allowed.
 */
export function transition(revId, toStatus, meta = {}) {
  const rev = getById("revisions", revId);
  if (!rev) throw new Error(`revision ${revId} not found`);
  const from = rev.status;
  if (!canTransition(from, toStatus)) {
    throw new Error(`revision ${revId}: cannot transition ${from} → ${toStatus}`);
  }

  update(s => {
    const r = s.data.revisions.find(x => x.id === revId);
    if (!r) return;
    r.status = toStatus;
    if (toStatus === "IFC") {
      // Auto-supersede the document's previous IFC revision.
      const doc = s.data.documents.find(d => d.id === r.docId);
      if (doc) {
        for (const priorId of doc.revisionIds || []) {
          if (priorId === r.id) continue;
          const prior = s.data.revisions.find(x => x.id === priorId);
          if (prior && prior.status === "IFC") {
            prior.status = "Superseded";
            const entry = audit("revision.auto_supersede", prior.id, { by: r.id, from: "IFC", to: "Superseded" });
            touch(prior, entry);
          }
        }
        doc.currentRevisionId = r.id;
        touch(doc);
      }
    }
    const entry = audit("revision.transition", revId, { from, to: toStatus, ...meta });
    touch(r, entry);
  });

  // Notify followers.
  fanout(revId, "transition", {
    kind: "revision",
    text: `${revId}: ${from} → ${toStatus}`,
    route: `/doc/${rev.docId}`,
  });

  return getById("revisions", revId);
}

/**
 * Impact analysis (spec §6.5 "Impact analysis engine").
 * Returns lists of potentially affected tasks, approvals, and assets for a
 * given revision change. Uses simple reference scans.
 */
export function impactOfRevision(revId) {
  const rev = getById("revisions", revId);
  if (!rev) return { rev: null, tasks: [], approvals: [], assets: [] };
  const doc = getById("documents", rev.docId);
  const docId = doc?.id;

  const tasks = (state.data.workItems || []).filter(w =>
    (w.description || "").includes(revId) ||
    (w.description || "").includes(docId) ||
    (w.labels || []).includes(docId)
  );

  const approvals = (state.data.approvals || []).filter(a =>
    (a.subject?.kind === "Revision" && a.subject?.id === revId) ||
    (a.subject?.kind === "Document" && a.subject?.id === docId)
  );

  const assets = (state.data.assets || []).filter(a =>
    (a.docIds || []).includes(docId)
  );

  return { rev, tasks, approvals, assets };
}
