// FSM tests — verify the xstate machines enforce the spec lifecycles.

import test from "node:test";
import assert from "node:assert/strict";

const r = await import("../src/core/fsm/revision.js");
const a = await import("../src/core/fsm/approval.js");
const i = await import("../src/core/fsm/incident.js");

test("revision: spec lifecycle Draft→IFR→Approved→IFC", () => {
  assert.equal(r.canTransitionRevision("Draft", "IFR"), true);
  assert.equal(r.canTransitionRevision("IFR", "Approved"), true);
  assert.equal(r.canTransitionRevision("Approved", "IFC"), true);
  assert.equal(r.canTransitionRevision("IFC", "Superseded"), true);
});

test("revision: terminal states reject all events", () => {
  assert.equal(r.canTransitionRevision("Superseded", "Draft"), false);
  assert.equal(r.canTransitionRevision("Archived", "IFR"), false);
});

test("revision: rejected can rework, IFC cannot jump back to Draft", () => {
  assert.equal(r.canTransitionRevision("Rejected", "Draft"), true);
  assert.equal(r.canTransitionRevision("IFC", "Draft"), false);
});

test("revision: cascadeOnApprove drives IFR→Approved and Approved→IFC", () => {
  assert.equal(r.cascadeOnApprove("IFR"), "Approved");
  assert.equal(r.cascadeOnApprove("Approved"), "IFC");
  assert.equal(r.cascadeOnApprove("Draft"), null);
});

test("revision: transitionRevisionState throws on illegal moves", () => {
  assert.throws(() => r.transitionRevisionState("IFC", "Draft"));
  assert.equal(r.transitionRevisionState("Draft", "IFR"), "IFR");
});

test("revision: machine description has the expected transitions", () => {
  const d = r.describeRevisionMachine();
  assert.equal(d.initial, "Draft");
  assert.ok(d.transitions.length >= 12);
  assert.ok(d.finals.includes("Superseded"));
  assert.ok(d.finals.includes("Archived"));
});

test("approval: pending can approve/reject/expire/delegate", () => {
  for (const t of ["approved","rejected","expired","delegated"]) {
    assert.equal(a.canTransitionApproval("pending", t), true, t);
  }
});

test("approval: terminal states are sticky", () => {
  for (const t of ["pending","approved","rejected","delegated"]) {
    assert.equal(a.canTransitionApproval("expired", t), false, t);
    assert.equal(a.canTransitionApproval("approved", t), false, t);
    assert.equal(a.canTransitionApproval("rejected", t), false, t);
  }
});

test("approval: delegated can still be decided", () => {
  assert.equal(a.canTransitionApproval("delegated", "approved"), true);
  assert.equal(a.canTransitionApproval("delegated", "rejected"), true);
  assert.equal(a.canTransitionApproval("delegated", "expired"), true);
});

test("incident: active→escalated→stabilized→resolved", () => {
  assert.equal(i.canTransitionIncident("active", "escalated"), true);
  assert.equal(i.canTransitionIncident("escalated", "stabilized"), true);
  assert.equal(i.canTransitionIncident("stabilized", "resolved"), true);
  assert.equal(i.canTransitionIncident("resolved", "postmortem"), true);
  assert.equal(i.canTransitionIncident("postmortem", "resolved"), true);
});

test("incident: cannot reopen from postmortem directly to active", () => {
  assert.equal(i.canTransitionIncident("postmortem", "active"), false);
  assert.equal(i.canTransitionIncident("resolved", "active"), true);
});

test("incident: same-state transition is rejected", () => {
  assert.equal(i.canTransitionIncident("active", "active"), false);
});
