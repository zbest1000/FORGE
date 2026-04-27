// Authentication: email + password → JWT bearer token.
// Role check helpers are exposed so route handlers can gate per-capability.

import bcrypt from "bcryptjs";
import { db, now, uuid } from "./db.js";
import { audit } from "./audit.js";

export const CAPABILITIES = {
  "Organization Owner":   ["*"],
  "Workspace Admin":      ["view","create","edit","approve","incident.command","integration.read","ai.configure","admin.view"],
  "Team Space Admin":     ["view","create","edit","approve","integration.read","ai.configure"],
  "Engineer/Contributor": ["view","create","edit"],
  "Reviewer/Approver":    ["view","approve","edit.markup"],
  "Operator/Technician":  ["view","incident.respond","edit.markup"],
  "Viewer/Auditor":       ["view","audit.view"],
  "Integration Admin":    ["view","integration.read","integration.write"],
  "AI Admin":             ["view","ai.configure"],
  "External Guest/Vendor":["view.external","edit.markup.external"],
};

export function can(user, capability) {
  if (!user) return false;
  const caps = CAPABILITIES[user.role] || [];
  return caps.includes("*") || caps.includes(capability);
}

export async function ensureUser({ email, name, role, password, orgId, initials = null }) {
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (existing) return existing.id;
  const id = uuid("U");
  const passwordHash = password ? await bcrypt.hash(password, 10) : null;
  db.prepare(`INSERT INTO users (id, org_id, email, name, role, password_hash, initials, disabled, created_at, updated_at)
             VALUES (@id, @org_id, @email, @name, @role, @ph, @initials, 0, @now, @now)`)
    .run({ id, org_id: orgId, email, name, role, ph: passwordHash, initials: initials || initialsOf(name), now: now() });
  return id;
}

export async function verifyPassword(email, password) {
  const row = db.prepare("SELECT * FROM users WHERE email = ? AND disabled = 0").get(email);
  if (!row || !row.password_hash) return null;
  const ok = await bcrypt.compare(password, row.password_hash);
  if (!ok) return null;
  return toUser(row);
}

export function userById(id) {
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  return row ? toUser(row) : null;
}

export function listUsers() {
  return db.prepare("SELECT * FROM users ORDER BY name").all().map(toUser);
}

function toUser(row) {
  const { password_hash, ...safe } = row;
  return { ...safe, abac: JSON.parse(row.abac || "{}") };
}

function initialsOf(name) {
  return (name || "?").split(/\s+/).map(p => p[0] || "").join("").slice(0, 2).toUpperCase();
}

/**
 * Fastify plugin: reads the JWT from the Authorization header (or
 * ?token=… query param for SSE) and sets request.user.
 *
 * Using `onRequest` so auth is resolved before `preHandler` hooks that
 * enforce capability checks. Also decorates the request with a `user`
 * property so referencing it before assignment is safe.
 */
export async function authPlugin(fastify) {
  if (!fastify.hasRequestDecorator("user")) fastify.decorateRequest("user", null);
  fastify.addHook("onRequest", async (req) => {
    const token = extractToken(req);
    if (!token) return;
    try {
      const decoded = fastify.jwt.verify(token);
      if (!decoded?.sub) { req.log.warn({ decoded }, "auth: no sub"); return; }
      const user = userById(decoded.sub);
      if (!user) { req.log.warn({ sub: decoded.sub }, "auth: user not found"); return; }
      req.user = user;
    } catch (err) {
      req.log.warn({ err: String(err?.message || err) }, "auth: verify failed");
    }
  });
}

function extractToken(req) {
  const h = req.headers.authorization || "";
  if (h.startsWith("Bearer ")) return h.slice(7);
  if (req.query && req.query.token) return String(req.query.token);
  return null;
}

/**
 * Returns true when the request's API token (if any) is authorised for the
 * given capability. A token authenticated as a JWT bearer (no `tokenScopes`
 * field) is treated as fully delegated and returns true.
 *
 * Token scopes are matched against capability names. The wildcard `"*"`
 * grants every capability. Without a `capability` argument this returns
 * true so endpoints that only require authentication keep working with
 * any token.
 */
export function tokenScopeAllows(req, capability) {
  if (!req || !Array.isArray(req.tokenScopes)) return true;
  if (!capability) return true;
  if (req.tokenScopes.includes("*")) return true;
  return req.tokenScopes.includes(capability);
}

/**
 * Route pre-handler that requires an authenticated user with a capability.
 *
 * Two layers must allow the request:
 *   1. The user's role grants the capability (`can(...)`).
 *   2. If the request was authenticated via a long-lived API token
 *      (`fgt_…`), the token's scope list must also include the capability
 *      (or the wildcard `"*"`). JWT bearers carry no scope filter and
 *      pass this layer unconditionally.
 */
export function require_(capability) {
  return async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: "unauthenticated" });
    if (capability && !can(req.user, capability)) {
      audit({ actor: req.user.id, action: "authz.deny", subject: capability, detail: { path: req.url } });
      return reply.code(403).send({ error: "forbidden", capability });
    }
    if (capability && !tokenScopeAllows(req, capability)) {
      audit({ actor: req.user.id, action: "authz.deny", subject: capability, detail: { path: req.url, reason: "token_scope", scopes: req.tokenScopes } });
      return reply.code(403).send({ error: "forbidden", capability, reason: "token_scope" });
    }
  };
}
