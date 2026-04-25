// Incident lifecycle (spec §11.13) as an xstate v5 machine.
//
// States: active / escalated / stabilized / resolved / postmortem
// Used by:
//   - server REST  (server/routes/core.js, server/events.js auto-creation)
//   - client UI    (src/screens/incident.js status select)
//
// Resolved is the lifecycle conclusion; postmortem is a follow-up state
// reachable only after resolved (so retros land in their own "drawer").

import { createMachine } from "xstate";

export const INCIDENT_STATUSES = ["active", "escalated", "stabilized", "resolved", "postmortem"];

export const incidentMachine = createMachine({
  id: "incident",
  initial: "active",
  states: {
    active:     { on: { ESCALATE: "escalated", STABILIZE: "stabilized", RESOLVE: "resolved" } },
    escalated:  { on: { STABILIZE: "stabilized", RESOLVE: "resolved" } },
    stabilized: { on: { RESOLVE: "resolved", REOPEN: "active" } },
    resolved:   { on: { POSTMORTEM: "postmortem", REOPEN: "active" } },
    postmortem: { on: { CLOSE: "resolved" } },
  },
});

const STATUS_TO_EVENT = {
  escalated:  "ESCALATE",
  stabilized: "STABILIZE",
  resolved:   "RESOLVE",
  postmortem: "POSTMORTEM",
  active:     "REOPEN",
};

function transitionsFrom(from) {
  return incidentMachine.config.states[from]?.on || {};
}

export function canTransitionIncident(from, to) {
  if (!INCIDENT_STATUSES.includes(from) || !INCIDENT_STATUSES.includes(to)) return false;
  // Special-case "active → active" no-op rejected.
  if (from === to) return false;
  const event = STATUS_TO_EVENT[to];
  if (!event) return false;
  // postmortem → resolved goes via CLOSE, not a target match → handle directly:
  if (from === "postmortem" && to === "resolved") return true;
  return transitionsFrom(from)[event] === to;
}

export function transitionIncidentState(from, to) {
  if (!canTransitionIncident(from, to)) {
    throw new Error(`incident: cannot transition ${from} → ${to}`);
  }
  return to;
}

export function describeIncidentMachine() {
  const transitions = [];
  for (const s of INCIDENT_STATUSES) {
    const on = transitionsFrom(s);
    for (const [event, target] of Object.entries(on)) transitions.push({ from: s, to: target, event });
  }
  return { id: "incident", initial: "active", states: INCIDENT_STATUSES, transitions, finals: [] };
}
