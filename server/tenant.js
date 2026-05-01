// Multi-tenant scoping helpers.
//
// Every authenticated user belongs to exactly one organization
// (`users.org_id`). Until FORGE supports cross-org users (e.g. external
// auditors, vendor staff loaned across customers), every read and write
// must constrain itself to the requester's org.
//
// This module exposes:
//   - `tenantOrgId(req)` — read the requester's org id, or null when
//     unauthenticated. Routes should treat `null` as "deny".
//   - Per-table helpers that produce SQL fragments + params so routes
//     can compose `db.prepare(BASE + tenantWhere(...))`. For tables
//     that don't carry a direct `org_id`, the helper joins through
//     `team_spaces` (via `team_space_id`) or `documents` (via `doc_id`,
//     `revisions.doc_id`, etc.).
//
// Cross-tenant bypass is intentionally NOT exposed here. Org Owners
// only "bypass ACLs" inside their own org; an Org Owner of ORG-1
// cannot see ORG-2 data through these helpers.

import { db } from "./db.js";

/** Returns the requester's org id, or null. */
export function tenantOrgId(req) {
  return req?.user?.org_id || null;
}

/**
 * SQL fragment + params that scopes a query to the user's org. Returns
 * `{ where, params }` or `null` when the request is unauthenticated.
 *
 * Example:
 *   const t = tenantWhere(req, "team_spaces");
 *   if (!t) return reply.code(401).send({ error: "unauthenticated" });
 *   db.prepare(`SELECT * FROM team_spaces WHERE ${t.where}`).all(...t.params);
 */
export function tenantWhere(req, table, alias = null) {
  const orgId = tenantOrgId(req);
  if (!orgId) return null;
  const a = alias ? `${alias}.` : "";
  switch (table) {
    case "organizations":
      return { where: `${a}id = ?`, params: [orgId] };
    case "workspaces":
    case "team_spaces":
    case "assets":
    case "incidents":
    case "users":
    case "enterprises":
    case "locations":
    case "asset_profiles":
    case "asset_point_bindings":
      return { where: `${a}org_id = ?`, params: [orgId] };
    case "enterprise_systems":
      // Pre-existing rows (created before v16) have NULL org_id and are
      // visible to every tenant until reassigned. New rows carry org_id.
      return { where: `(${a}org_id = ? OR ${a}org_id IS NULL)`, params: [orgId] };
    case "asset_profile_versions":
      return {
        where: `${a}profile_id IN (SELECT id FROM asset_profiles WHERE org_id = ?)`,
        params: [orgId],
      };
    case "asset_profile_points":
      return {
        where: `${a}profile_version_id IN (SELECT v.id FROM asset_profile_versions v JOIN asset_profiles p ON p.id = v.profile_id WHERE p.org_id = ?)`,
        params: [orgId],
      };
    case "projects":
    case "channels":
    case "documents":
      return { where: `${a}team_space_id IN (SELECT id FROM team_spaces WHERE org_id = ?)`, params: [orgId] };
    case "messages":
      return { where: `${a}channel_id IN (SELECT id FROM channels WHERE team_space_id IN (SELECT id FROM team_spaces WHERE org_id = ?))`, params: [orgId] };
    case "revisions":
      return { where: `${a}doc_id IN (SELECT id FROM documents WHERE team_space_id IN (SELECT id FROM team_spaces WHERE org_id = ?))`, params: [orgId] };
    case "drawings":
      return { where: `(${a}team_space_id IN (SELECT id FROM team_spaces WHERE org_id = ?) OR ${a}doc_id IN (SELECT id FROM documents WHERE team_space_id IN (SELECT id FROM team_spaces WHERE org_id = ?)))`, params: [orgId, orgId] };
    case "work_items":
      return { where: `${a}project_id IN (SELECT id FROM projects WHERE team_space_id IN (SELECT id FROM team_spaces WHERE org_id = ?))`, params: [orgId] };
    case "approvals":
      // Approvals are scoped via their subject. We allow the approval row
      // through if the subject row passes a tenant check; routes apply
      // the per-subject filter separately. Returning null forces callers
      // to be explicit.
      return null;
    default:
      return { where: "1 = 1", params: [] };
  }
}

const tsOrg = db.prepare("SELECT org_id FROM team_spaces WHERE id = ?");
const docOrg = db.prepare("SELECT t.org_id AS org_id FROM team_spaces t JOIN documents d ON d.team_space_id = t.id WHERE d.id = ?");
const projectOrg = db.prepare("SELECT t.org_id AS org_id FROM team_spaces t JOIN projects p ON p.team_space_id = t.id WHERE p.id = ?");
const channelOrg = db.prepare("SELECT t.org_id AS org_id FROM team_spaces t JOIN channels c ON c.team_space_id = t.id WHERE c.id = ?");

/**
 * Resolve the org id for a row of a given table. Returns null when the
 * row is missing or we cannot determine the owning org.
 */
export function orgForRow(table, row) {
  if (!row) return null;
  switch (table) {
    case "organizations": return row.id || null;
    case "workspaces":
    case "team_spaces":
    case "assets":
    case "incidents":
    case "users":
    case "enterprises":
    case "locations":
    case "asset_profiles":
    case "asset_point_bindings":
    case "enterprise_systems":
      return row.org_id || null;
    case "projects": return tsOrg.get(row.team_space_id)?.org_id || null;
    case "channels": return tsOrg.get(row.team_space_id)?.org_id || null;
    case "documents": return tsOrg.get(row.team_space_id)?.org_id || null;
    case "drawings":
      return (row.team_space_id ? tsOrg.get(row.team_space_id)?.org_id : null)
        || (row.doc_id ? docOrg.get(row.doc_id)?.org_id : null)
        || null;
    case "revisions": return row.doc_id ? docOrg.get(row.doc_id)?.org_id : null;
    case "work_items": return row.project_id ? projectOrg.get(row.project_id)?.org_id : null;
    case "messages": return row.channel_id ? channelOrg.get(row.channel_id)?.org_id : null;
    default: return null;
  }
}

/**
 * Assert that a row belongs to the requester's tenant. Returns true on
 * pass; sets the reply to 404 (not 403, to avoid leaking existence) and
 * returns false on fail.
 */
export function requireTenant(req, reply, row, table) {
  const orgId = tenantOrgId(req);
  if (!orgId) { reply.code(401).send({ error: "unauthenticated" }); return false; }
  if (!row) { reply.code(404).send({ error: "not found" }); return false; }
  const rowOrg = orgForRow(table, row);
  if (rowOrg && rowOrg !== orgId) { reply.code(404).send({ error: "not found" }); return false; }
  return true;
}
