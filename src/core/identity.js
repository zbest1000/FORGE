// Identity context helper.
//
// Returns the rich shape every audit / event / comment / signed
// payload should carry to attribute an action to a person:
//
//   {
//     userId, name, email, role,
//     orgId, orgName, tenantKey,
//     workspaceId, workspaceName,
//     groupIds, groupNames,
//     ts,
//   }
//
// Why a dedicated helper rather than scattering `state.ui.role`
// reads everywhere: a user-reported screenshot showed an
// `auth_context: { actor: "Organization Owner" }` in the event
// stream. That's the role string only — operators investigating
// an incident can't tell WHO clicked the button. The helper
// centralises the "who was acting + as what + in which org"
// resolution so every emitter benefits at once.

import { state } from "./store.js";
import { currentUserId, listGroups, effectiveGroupIds } from "./groups.js";

// Synthesise an email when the seed user has none. Demo seeds carry
// `name` only; server-mode users come from `/api/me` and DO have an
// email. We honour `user.email` when present and fall back to a
// deterministic synthetic `j.singh@<tenantKey>.local` shape so the
// audit trail reads sensibly in screenshots + e2e tests.
function emailFor(user, tenantKey) {
  if (user?.email) return user.email;
  if (!user?.name) return null;
  const local = String(user.name).toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.+|\.+$/g, "");
  if (!local) return null;
  return `${local}@${tenantKey || "forge"}.local`;
}

/**
 * @typedef {{
 *   id?: string,
 *   name?: string,
 *   email?: string,
 *   role?: string,
 *   orgId?: string,
 *   groupIds?: string[],
 * }} ForgeUser
 */

/**
 * Resolve the current actor's identity context. Returns a `system`
 * shape (no userId) when no user is signed in — enough metadata
 * for the audit trail without crashing emitters.
 */
export function currentIdentityContext() {
  /** @type {any} */
  const d = state.data || {};
  /** @type {any} */
  const ui = state.ui || {};
  const uid = currentUserId();
  /** @type {ForgeUser | null} */
  const user = uid ? (d.users || []).find(u => u.id === uid) || null : null;

  const org = d.organization || null;
  const orgId = org?.id || user?.orgId || null;
  const orgName = org?.name || null;
  const tenantKey = org?.tenantKey || null;

  const workspaceId = ui.workspaceId || d.workspace?.id || null;
  const workspace = (d.workspaces || []).find(w => w.id === workspaceId)
    || d.workspace
    || null;

  // Group memberships drive RBAC + portal scoping. Including them in
  // the identity context lets a reviewer reading the audit trail see
  // why a user had access without re-running the auth resolver.
  const allGroups = listGroups();
  const userGroupIds = uid ? effectiveGroupIds(uid) : [];
  const userGroupNames = userGroupIds
    .map(gid => allGroups.find(g => g.id === gid)?.name)
    .filter(Boolean);

  if (!user) {
    return {
      userId: null,
      name: "system",
      email: null,
      role: ui.role || "system",
      orgId,
      orgName,
      tenantKey,
      workspaceId,
      workspaceName: workspace?.name || null,
      groupIds: [],
      groupNames: [],
      ts: new Date().toISOString(),
    };
  }

  return {
    userId: user.id,
    name: user.name || user.email || user.id,
    email: emailFor(user, tenantKey),
    // ui.role wins over user.role when the user is using the
    // "Acting as" override — that's the privileged role they're
    // exercising right now. user.role stays as the canonical
    // assignment.
    role: ui.role || user.role || null,
    assignedRole: user.role || null,
    orgId,
    orgName,
    tenantKey,
    workspaceId,
    workspaceName: workspace?.name || null,
    groupIds: userGroupIds,
    groupNames: userGroupNames,
    ts: new Date().toISOString(),
  };
}

/**
 * Compact one-line label suitable for badge / chip rendering.
 * Example: `"D. Chen (d.chen@atlas.local) · Workspace Admin · Atlas Industrial Systems"`.
 */
export function identityLabel(ctx) {
  if (!ctx) ctx = currentIdentityContext();
  const parts = [];
  if (ctx.name) parts.push(ctx.email ? `${ctx.name} (${ctx.email})` : ctx.name);
  if (ctx.role) parts.push(ctx.role);
  if (ctx.orgName) parts.push(ctx.orgName);
  return parts.join(" · ");
}
