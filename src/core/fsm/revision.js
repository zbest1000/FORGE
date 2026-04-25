// Revision lifecycle (spec §6.3, §7 #3, §10 #3) as an xstate v5 machine.
//
// One source of truth, used by:
//   - server REST    (server/routes/core.js  /api/revisions/:id/transition)
//   - server GraphQL (server/graphql/resolvers.js  Mutation.transitionRevision)
//   - client UI      (src/screens/docViewer.js)
//
// The states match PRODUCT_SPEC exactly:
//   Draft → IFR → Approved → IFC → Superseded/Archived
//   Rejected ↩ from IFR or Approved
//
// The machine config is the authority. Helpers below derive the
// `from → to` table for synchronous validation, since the most common
// use case is a stateless route handler asking "can X go to Y?"
// without spinning up an actor.

import { createMachine } from "xstate";

export const STATUSES = ["Draft", "IFR", "Approved", "IFC", "Superseded", "Archived", "Rejected"];

export const revisionMachine = createMachine({
  id: "revision",
  initial: "Draft",
  states: {
    Draft:      { on: { ISSUE_FOR_REVIEW: "IFR", ARCHIVE: "Archived" } },
    IFR:        { on: { APPROVE: "Approved", REJECT: "Rejected", REWORK: "Draft", ARCHIVE: "Archived" } },
    Approved:   { on: { ISSUE_FOR_CONSTRUCTION: "IFC", REJECT: "Rejected", ARCHIVE: "Archived" } },
    IFC:        { on: { SUPERSEDE: "Superseded", ARCHIVE: "Archived" } },
    Rejected:   { on: { REWORK: "Draft", ARCHIVE: "Archived" } },
    Superseded: { type: "final" },
    Archived:   { type: "final" },
  },
});

// Reverse map: target state → event name. Allows callers to ask
// `transitionRevision(from, to)` without thinking about events.
const STATUS_TO_EVENT = {
  IFR:        "ISSUE_FOR_REVIEW",
  Approved:   "APPROVE",
  IFC:        "ISSUE_FOR_CONSTRUCTION",
  Rejected:   "REJECT",
  Draft:      "REWORK",
  Superseded: "SUPERSEDE",
  Archived:   "ARCHIVE",
};

function transitionsFrom(from) {
  const node = revisionMachine.config.states[from];
  return node?.on || {};
}

/** Pure check: can `from` transition to `to`? */
export function canTransitionRevision(from, to) {
  if (!STATUSES.includes(from) || !STATUSES.includes(to)) return false;
  const event = STATUS_TO_EVENT[to];
  if (!event) return false;
  return transitionsFrom(from)[event] === to;
}

/** Compute the next state. Throws if not allowed. */
export function transitionRevisionState(from, to) {
  if (!canTransitionRevision(from, to)) {
    throw new Error(`revision: cannot transition ${from} → ${to}`);
  }
  return to;
}

/**
 * Cascade rule: approving an IFR → Approved; approving an Approved → IFC,
 * which side-effects "auto-supersede the previous IFC on this document".
 * The caller owns the DB write; this just names the target.
 */
export function cascadeOnApprove(current) {
  if (current === "IFR") return "Approved";
  if (current === "Approved") return "IFC";
  return null;
}

/** All allowed transitions; used by Admin > Lifecycles to render the diagram. */
export function describeRevisionMachine() {
  const transitions = [];
  for (const s of STATUSES) {
    const on = transitionsFrom(s);
    for (const [event, target] of Object.entries(on)) {
      transitions.push({ from: s, to: target, event });
    }
  }
  const finals = STATUSES.filter(s => revisionMachine.config.states[s]?.type === "final");
  return { id: "revision", initial: "Draft", states: STATUSES, transitions, finals };
}
