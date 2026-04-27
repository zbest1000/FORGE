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
// and the user has the base role capability. Organization Owners bypass
// (within their own tenant — cross-tenant access is blocked separately
// by `server/tenant.js`).
//
// Deny-by-default fallback (B.3 #4)
// ---------------------------------
// Historic behaviour: when a stored ACL is missing or malformed,
// `parseAcl` returned `{ roles: ["*"] }` — i.e. every authenticated
// role with the right capability could read the row. This was a
// reasonable default for a single-tenant demo but is the wrong
// default for multi-tenant production.
//
// `FORGE_ACL_DENY_BY_DEFAULT=1` flips the fallback to
// `{ roles: [] }` — a missing ACL denies everyone except the
// Organization Owner (whose `allows()` short-circuit bypass remains
// intact). The flag defaults to ON in production / strict mode and
// OFF otherwise so demo deployments and the existing test suite stay
// permissive.

import { can, tokenScopeAllows } from "./auth.js";
import { config } from "./config.js";

function envFlag(name) {
  const v = process.env[name];
  if (v == null) return null;
  if (/^(0|false|no|off)$/i.test(v)) return false;
  if (/^(1|true|yes|on)$/i.test(v)) return true;
  return null;
}

function denyByDefault() {
  const explicit = envFlag("FORGE_ACL_DENY_BY_DEFAULT");
  if (explicit !== null) return explicit;
  return !!config.strict;
}

function permissiveFallback() {
  return { roles: ["*"], users: [], abac: {} };
}
function denyFallback() {
  return { roles: [], users: [], abac: {} };
}
function makeFallback() {
  return denyByDefault() ? denyFallback() : permissiveFallback();
}

export function parseAcl(raw) {
  if (!raw) return makeFallback();
  if (typeof raw === "object") return withDefaults(raw);
  try { return withDefaults(JSON.parse(raw)); } catch { return makeFallback(); }
}
function withDefaults(a) {
  // When the caller passed a partially-valid object (e.g. only `users`
  // set, no `roles` key), keep their explicit values and patch the
  // missing fields with the current fallback policy. That preserves
  // existing demo data shapes (`acl: '{}'` deserialises to `{}`) while
  // letting strict-mode deployments deny by default.
  const fb = makeFallback();
  return {
    roles: Array.isArray(a.roles) ? a.roles : fb.roles,
    users: Array.isArray(a.users) ? a.users : fb.users,
    abac: a.abac || {},
  };
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
