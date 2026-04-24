// Role -> capabilities matrix. Used across screens to gate actions.

import { state } from "./store.js";

export const ROLES = [
  "Organization Owner",
  "Workspace Admin",
  "Team Space Admin",
  "Engineer/Contributor",
  "Reviewer/Approver",
  "Operator/Technician",
  "Viewer/Auditor",
  "Integration Admin",
  "AI Admin",
  "External Guest/Vendor",
];

const CAPABILITIES = {
  "Organization Owner":   ["*"],
  "Workspace Admin":      ["view", "create", "edit", "approve", "incident.command", "integration.read", "ai.configure", "admin.view"],
  "Team Space Admin":     ["view", "create", "edit", "approve", "integration.read", "ai.configure"],
  "Engineer/Contributor": ["view", "create", "edit"],
  "Reviewer/Approver":    ["view", "approve", "edit.markup"],
  "Operator/Technician":  ["view", "incident.respond", "edit.markup"],
  "Viewer/Auditor":       ["view", "audit.view"],
  "Integration Admin":    ["view", "integration.read", "integration.write"],
  "AI Admin":             ["view", "ai.configure"],
  "External Guest/Vendor":["view.external", "edit.markup.external"],
};

export function can(capability) {
  const role = state.ui.role;
  const caps = CAPABILITIES[role] || [];
  if (caps.includes("*")) return true;
  return caps.includes(capability);
}

export function roleBanner() {
  const role = state.ui.role;
  if (CAPABILITIES[role]?.includes("*")) return "Privileged: all actions available";
  if (role === "Viewer/Auditor") return "Read-only mode — approvals and writes disabled";
  if (role === "External Guest/Vendor") return "Scoped external access — redactions applied";
  return "Standard role — approvals/integration writes may be gated";
}
