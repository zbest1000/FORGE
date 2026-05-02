// Identity context — currentIdentityContext() shape contract.
//
// Reviewers reading the audit trail expect to see WHO acted, not
// just what role they held. This test pins the rich shape so a
// future refactor that drops a field (email, role, orgName) fails
// the build.
//
// The helper reads from `state` (live store) + `groups` (resolver).
// We stub the store via `globalThis.__forgeStateStub` and re-import
// the module under test against the stub.

import test from "node:test";
import assert from "node:assert/strict";

// `src/core/store.js` calls `window.addEventListener("beforeunload",
// ...)` at module top-level. Stub a tiny window before the import
// so the module loads cleanly in Node.
globalThis.window = globalThis.window || {
  addEventListener: () => {},
  removeEventListener: () => {},
  requestIdleCallback: undefined,
  cancelIdleCallback: undefined,
};
globalThis.localStorage = globalThis.localStorage || {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

// Set up an in-memory shape that mirrors `src/core/store.js::state`.
// The identity helper imports from "./store.js" + "./groups.js"; we
// override their state references via the actual modules' internal
// state (those modules export a `state` const, not a getter, so we
// have to populate it before the helper imports).

const { state } = await import("../src/core/store.js");

state.data = {
  organization: { id: "ORG-1", name: "Atlas Industrial Systems", tenantKey: "atlas" },
  workspace: { id: "WS-1", name: "North Plant", region: "us-east" },
  workspaces: [
    { id: "WS-1", name: "North Plant" },
    { id: "WS-2", name: "Site 2 Build" },
  ],
  users: [
    { id: "U-1", name: "J. Singh", role: "Engineer/Contributor", groupIds: ["G-eng", "G-scada"], orgId: "ORG-1" },
    { id: "U-4", name: "D. Chen", role: "Workspace Admin", groupIds: ["G-it"], orgId: "ORG-1" },
    { id: "U-7", name: "A. Patel", email: "a.patel@external.example", role: "Team Space Admin", groupIds: ["G-eng"], orgId: "ORG-1" },
  ],
  groups: [
    { id: "G-eng", name: "Engineering", memberIds: ["U-1", "U-7"] },
    { id: "G-scada", name: "SCADA", memberIds: ["U-1"] },
    { id: "G-it", name: "IT", memberIds: ["U-4"] },
  ],
  currentUserId: "U-1",
};
state.ui = {
  role: "Engineer/Contributor",
  workspaceId: "WS-1",
};

const { currentIdentityContext, identityLabel } = await import("../src/core/identity.js");

test("currentIdentityContext: returns the rich shape for a signed-in user", () => {
  const ctx = currentIdentityContext();
  assert.equal(ctx.userId, "U-1");
  assert.equal(ctx.name, "J. Singh");
  assert.equal(ctx.role, "Engineer/Contributor");
  assert.equal(ctx.assignedRole, "Engineer/Contributor");
  assert.equal(ctx.orgId, "ORG-1");
  assert.equal(ctx.orgName, "Atlas Industrial Systems");
  assert.equal(ctx.tenantKey, "atlas");
  assert.equal(ctx.workspaceId, "WS-1");
  assert.equal(ctx.workspaceName, "North Plant");
  // The synthesised email follows `${name}@${tenantKey}.local` so
  // demo screenshots read sensibly.
  assert.equal(ctx.email, "j.singh@atlas.local");
  // Group memberships flow through.
  assert.ok(Array.isArray(ctx.groupIds));
  assert.ok(Array.isArray(ctx.groupNames));
  assert.ok(ctx.groupNames.includes("Engineering"));
  // Timestamp is ISO.
  assert.match(ctx.ts, /^\d{4}-\d{2}-\d{2}T/);
});

test("currentIdentityContext: explicit `email` on the user wins over the synthesised default", () => {
  state.data.currentUserId = "U-7";
  const ctx = currentIdentityContext();
  assert.equal(ctx.email, "a.patel@external.example");
  // Reset for downstream tests.
  state.data.currentUserId = "U-1";
});

test("currentIdentityContext: ui.role overrides the user's assigned role (Acting As mode)", () => {
  state.ui.role = "Workspace Admin";
  const ctx = currentIdentityContext();
  assert.equal(ctx.role, "Workspace Admin", "role reflects the active 'Acting as' override");
  assert.equal(ctx.assignedRole, "Engineer/Contributor", "assignedRole still carries the user's canonical role");
  state.ui.role = "Engineer/Contributor";
});

test("currentIdentityContext: returns a `system` shape when no user is signed in", () => {
  state.data.currentUserId = null;
  state.ui.role = "system";
  const ctx = currentIdentityContext();
  assert.equal(ctx.userId, null);
  assert.equal(ctx.name, "system");
  assert.equal(ctx.email, null);
  // Org / workspace info still flows through — useful for system
  // events that fire inside a tenant.
  assert.equal(ctx.orgId, "ORG-1");
  assert.equal(ctx.workspaceId, "WS-1");
  state.data.currentUserId = "U-1";
  state.ui.role = "Engineer/Contributor";
});

test("identityLabel: human-readable one-liner for chip rendering", () => {
  state.data.currentUserId = "U-1";
  state.ui.role = "Engineer/Contributor";
  const label = identityLabel();
  // Format: "Name (email) · Role · Org"
  assert.match(label, /J\. Singh/);
  assert.match(label, /j\.singh@atlas\.local/);
  assert.match(label, /Engineer\/Contributor/);
  assert.match(label, /Atlas Industrial Systems/);
});

test("identityLabel: skips missing fields cleanly (no leading/trailing separators)", () => {
  // Pass a slim ctx — only name + role.
  const label = identityLabel({ name: "Anon", role: "Reader" });
  assert.equal(label, "Anon · Reader");
});
