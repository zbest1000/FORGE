// Approval lifecycle (spec §11.14) as an xstate v5 machine.
//
// States: pending / approved / rejected / expired / delegated
// Used by:
//   - server REST    (server/routes/core.js  /api/approvals/:id/decide)
//   - server GraphQL (server/graphql/resolvers.js  Mutation.decideApproval)
//   - client UI      (src/screens/approvals.js)
//
// A delegated approval can be re-approved/re-rejected by the new approver
// (the chain-of-custody captures who delegated to whom). An expired
// approval cannot be revived — the requester must open a new one.

import { createMachine } from "xstate";

export const APPROVAL_STATUSES = ["pending", "approved", "rejected", "expired", "delegated"];

export const approvalMachine = createMachine({
  id: "approval",
  initial: "pending",
  states: {
    pending: {
      on: {
        APPROVE:  "approved",
        REJECT:   "rejected",
        EXPIRE:   "expired",
        DELEGATE: "delegated",
      },
    },
    delegated: {
      // The delegated approver still drives APPROVE / REJECT / EXPIRE.
      on: {
        APPROVE:  "approved",
        REJECT:   "rejected",
        EXPIRE:   "expired",
        DELEGATE: "delegated",
      },
    },
    approved: { type: "final" },
    rejected: { type: "final" },
    expired:  { type: "final" },
  },
});

const STATUS_TO_EVENT = {
  approved:  "APPROVE",
  rejected:  "REJECT",
  expired:   "EXPIRE",
  delegated: "DELEGATE",
};

function transitionsFrom(from) {
  return approvalMachine.config.states[from]?.on || {};
}

export function canTransitionApproval(from, to) {
  if (!APPROVAL_STATUSES.includes(from) || !APPROVAL_STATUSES.includes(to)) return false;
  const event = STATUS_TO_EVENT[to];
  if (!event) return false;
  return transitionsFrom(from)[event] === to;
}

export function transitionApprovalState(from, to) {
  if (!canTransitionApproval(from, to)) {
    throw new Error(`approval: cannot transition ${from} → ${to}`);
  }
  return to;
}

export function describeApprovalMachine() {
  const transitions = [];
  for (const s of APPROVAL_STATUSES) {
    const on = transitionsFrom(s);
    for (const [event, target] of Object.entries(on)) transitions.push({ from: s, to: target, event });
  }
  const finals = APPROVAL_STATUSES.filter(s => approvalMachine.config.states[s]?.type === "final");
  return { id: "approval", initial: "pending", states: APPROVAL_STATUSES, transitions, finals };
}
