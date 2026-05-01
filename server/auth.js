// Authentication: email + password → JWT bearer token.
// Role check helpers are exposed so route handlers can gate per-capability.

import bcrypt from "bcryptjs";
import { db, now, uuid } from "./db.js";
import { audit } from "./audit.js";

// Capability matrix.
//
// Capabilities are role-bound and additive. The wildcard `"*"` grants
// every capability and is reserved for `Organization Owner`. Every
// other role enumerates exactly what it can do — adding a new
// capability to a role is the only way to extend its surface.
//
// Recent additions (B.3 from the enterprise readiness audit):
//   - `webhook.write`  separates outbound-webhook mutation from
//     `admin.view`. Read-only auditors with `admin.view` can no
//     longer create or delete webhooks.
//   - `admin.edit`     gates compliance writes (DSAR, legal-hold,
//     ROPA, evidence, AI-system inventory). `admin.view` keeps
//     read-only access.
// Two narrow privileges layered on top of the role grants:
//
// `historian.sql.raw` — authoring free-form SELECT templates
//   against external SQL historian sources (Phase 3). Workspace
//   Admin only; Org Owner inherits via "*". Integration Admin
//   intentionally NOT granted: integration writers can wire
//   schema-defined sources without authoring raw SQL. Spec ref:
//   docs/INDUSTRIAL_EDGE_PLATFORM_SPEC.md §6 + §8.
//
// `device.write` — Phase 7c. Pushes a value back to a physical
//   device through the connector orchestrator (publish on MQTT,
//   Session.write on OPC UA, future Modbus). Per spec §15.2:
//
//     "Write operations to devices (tag writeback, OPC UA write,
//      MQTT command publish) are gated by a separate
//      CAN_WRITE_DEVICE capability, not just general write
//      permission. This is the highest-risk operation in the
//      system."
//
//   Granted ONLY to Workspace Admin + Org Owner (via "*"). Every
//   call audits — see server/routes/tag-writeback.js. Integration
//   Admin is NOT granted: they configure connectors but don't
//   push setpoints to running plants. Engineer / Operator can read
//   + acknowledge incidents but cannot write to a device.
export const CAPABILITIES = {
  "Organization Owner":   ["*"],
  "Workspace Admin":      ["view","create","edit","approve","incident.command","integration.read","integration.write","ai.configure","admin.view","admin.edit","webhook.write","historian.sql.raw","device.write"],
  "Team Space Admin":     ["view","create","edit","approve","integration.read","ai.configure"],
  "Engineer/Contributor": ["view","create","edit"],
  "Reviewer/Approver":    ["view","approve","edit.markup"],
  "Operator/Technician":  ["view","incident.respond","edit.markup"],
  "Viewer/Auditor":       ["view","audit.view","admin.view"],
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
