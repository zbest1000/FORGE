// Object-level ACL + ABAC overlay enforcement (spec §13.1).
//
// Every FORGE object carries a JSON `acl` column with shape:
//   { roles: ["*"] | ["Engineer/Contributor", ...],
//     users: ["U-1", ...],
//     abac:  { discipline: "...", site: "...", clearance: "..." } }
//
// `allows(user, acl, capability)` returns true when:
//   - user's role is in `acl.roles` or acl.roles contains "*"
//   - user.id is in `acl.users`
//   - user.abac satisfies every constraint in acl.abac
// and the user has the base role capability. Organization Owners bypass.

import { can, tokenScopeAllows } from "./auth.js";

export function parseAcl(raw) {
  if (!raw) return { roles: ["*"], users: [], abac: {} };
  if (typeof raw === "object") return withDefaults(raw);
  try { return withDefaults(JSON.parse(raw)); } catch { return { roles: ["*"], users: [], abac: {} }; }
}
function withDefaults(a) {
  return { roles: Array.isArray(a.roles) ? a.roles : ["*"], users: Array.isArray(a.users) ? a.users : [], abac: a.abac || {} };
}

export function allows(user, acl, capability) {
  if (!user) return false;
  if (user.role === "Organization Owner") return true;
  if (capability && !can(user, capability)) return false;
  const a = parseAcl(acl);
  const roleOk = a.roles.includes("*") || a.roles.includes(user.role);
  const userOk = a.users.includes(user.id);
  if (!roleOk && !userOk) return false;
  const userAbac = user.abac || {};
  for (const [k, required] of Object.entries(a.abac || {})) {
    if (!required) continue;
    if (String(userAbac[k] || "") !== String(required)) return false;
  }
  return true;
}

/**
 * Filter a list of rows to those the user is allowed to see with `capability`.
 */
export function filterAllowed(rows, user, capability, aclField = "acl") {
  return rows.filter(r => allows(user, r[aclField], capability));
}

export function canReadTenantData(user) {
  return !!user && (can(user, "view") || can(user, "view.external") || user.role === "Organization Owner");
}

export function requireAccess(req, reply, row, capability = "view", aclField = "acl") {
  if (!req.user) {
    reply.code(401).send({ error: "unauthenticated" });
    return false;
  }
  if (!row) {
    reply.code(404).send({ error: "not found" });
    return false;
  }
  if (!allows(req.user, row[aclField], capability)) {
    reply.code(403).send({ error: "forbidden by ACL", capability });
    return false;
  }
  if (capability && !tokenScopeAllows(req, capability)) {
    reply.code(403).send({ error: "forbidden", capability, reason: "token_scope" });
    return false;
  }
  return true;
}

export function requireAuth(req, reply) {
  if (req.user) return true;
  reply.code(401).send({ error: "unauthenticated" });
  return false;
}
