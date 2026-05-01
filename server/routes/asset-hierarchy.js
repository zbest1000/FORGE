// Asset hierarchy + re-resolve routes.
//
// Owns the new top-of-tree primitives that the Asset Dashboard renders:
//
//   - `enterprises`  — top-level grouping (one per organisational unit)
//   - `locations`    — child nodes under an enterprise; can self-nest
//   - `assets`       — leaves; their CRUD lives in `core.js`, this file
//                      only exposes the read-side `/api/asset-tree`
//                      denormalised query the dashboard uses
//
// Plus the path re-resolve flow that fires when an enterprise/location
// is renamed: bindings store a snapshot of their resolved `source_path`
// so renames don't silently migrate live MQTT/OPC UA subscriptions. The
// PATCH response embeds an `affectedBindings` count + sample so the UI
// can prompt "N bindings reference the old name — re-resolve?"; the
// follow-up `POST .../re-resolve-bindings` does the work atomically.
//
// All read/write paths are tenant-scoped via `tenantWhere(req, "<table>")`
// so `(org_id) IS NOT NULL` rows from another tenant are invisible.

import { db, now, uuid, jsonOrDefault } from "../db.js";
import { audit } from "../audit.js";
import { require_ } from "../auth.js";
import { broadcast } from "../sse.js";
import { allows, filterAllowed, requireAccess } from "../acl.js";
import { tenantOrgId, tenantWhere, requireTenant } from "../tenant.js";
import { applyEtag, requireIfMatch } from "../etag.js";
import {
  EnterpriseCreateBody,
  EnterprisePatchBody,
  LocationCreateBody,
  LocationPatchBody,
  ReResolveBindingsBody,
} from "../schemas/asset-hierarchy.js";

// ----- helpers ---------------------------------------------------------

function mapEnterprise(row) {
  if (!row) return null;
  return { ...row, acl: jsonOrDefault(row.acl, {}) };
}

function mapLocation(row) {
  if (!row) return null;
  return { ...row, acl: jsonOrDefault(row.acl, {}) };
}

function defaultWorkspaceId(req) {
  // Most installations have a single workspace per org. Pick the first
  // workspace in the user's org as the default for newly-created
  // enterprise/location rows when the caller doesn't specify one. The
  // frontend can override per-row.
  const orgId = tenantOrgId(req);
  if (!orgId) return null;
  return db.prepare("SELECT id FROM workspaces WHERE org_id = ? ORDER BY created_at LIMIT 1").get(orgId)?.id || null;
}

/**
 * Resolve a binding's source-path template by looking up the bound profile
 * point. Returns null for custom mappings (no profile_point_id) — those
 * have no template to re-apply against new placeholder values.
 */
function templateForBinding(bindingRow) {
  if (!bindingRow.profile_point_id) return null;
  const pp = db.prepare(
    "SELECT source_path_template FROM asset_profile_points WHERE id = ?"
  ).get(bindingRow.profile_point_id);
  return pp?.source_path_template || null;
}

/**
 * Mustache-lite token replacement. Only substitutes `{name}` tokens whose
 * key exists in `vars`. Empty values are left in place so the validator
 * downstream can flag them — silently producing `acme//pumpA` is exactly
 * the bug class snapshot-on-apply was designed to surface.
 */
function resolveTemplate(template, vars) {
  if (!template) return "";
  return String(template).replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (m, key) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) {
      const v = vars[key];
      return v == null ? "" : String(v);
    }
    return m; // leave unknown tokens for downstream validation
  });
}

function findBindingsForEnterprise(enterpriseId) {
  return db.prepare(`
    SELECT b.*, a.name AS asset_name, a.enterprise_id, a.location_id
      FROM asset_point_bindings b
      JOIN assets a ON a.id = b.asset_id
     WHERE a.enterprise_id = ?
  `).all(enterpriseId);
}

function findBindingsForLocation(locationId) {
  return db.prepare(`
    SELECT b.*, a.name AS asset_name, a.enterprise_id, a.location_id
      FROM asset_point_bindings b
      JOIN assets a ON a.id = b.asset_id
     WHERE a.location_id = ?
  `).all(locationId);
}

/**
 * Compute the shape of the rename impact for the UI prompt. Returns
 *   { affected: [{bindingId, oldPath, newPath, assetName, customMapping}] }
 * where `customMapping` flags bindings whose template is not known
 * (profile_point_id IS NULL) and therefore cannot be auto-re-resolved.
 *
 * `vars` is the post-rename placeholder map for the binding.
 */
// Standard placeholder keys we track per rename axis. Only these are
// auto-re-resolved; users who plumb the rename axis through a custom
// placeholder (e.g. `{org}` instead of `{enterprise}`) won't trip the
// auto-update — they can re-bind via the Configuration tab. Phase 3
// adds an explicit per-binding placeholder→axis map for fully general
// re-resolution.
const ENTERPRISE_KEYS = ["enterprise"];
const LOCATION_KEYS = ["site", "location"];

function previewReResolve(binding, oldName, newName) {
  const vars = jsonOrDefault(binding.template_vars, {});
  const updatedVars = { ...vars };
  let touched = false;
  for (const [k, v] of Object.entries(vars)) {
    if (String(v ?? "") === oldName) {
      updatedVars[k] = newName;
      touched = true;
    }
  }
  if (!touched) return null;
  const tpl = templateForBinding(binding);
  const newPath = tpl ? resolveTemplate(tpl, updatedVars) : binding.source_path;
  return {
    bindingId: binding.id,
    assetId: binding.asset_id,
    assetName: binding.asset_name,
    oldPath: binding.source_path,
    newPath,
    customMapping: !tpl,
    updatedVars,
  };
}

// ----- routes ----------------------------------------------------------

export default async function assetHierarchyRoutes(fastify) {

  // ===== Enterprises ===================================================

  fastify.get("/api/enterprises", { preHandler: require_("view") }, async (req, reply) => {
    const t = tenantWhere(req, "enterprises");
    if (!t) return reply.code(401).send({ error: "unauthenticated" });
    const rows = db.prepare(`SELECT * FROM enterprises WHERE ${t.where} ORDER BY sort_order, name`).all(...t.params);
    return filterAllowed(rows, req.user, "view").map(mapEnterprise);
  });

  fastify.get("/api/enterprises/:id", { preHandler: require_("view") }, async (req, reply) => {
    const row = db.prepare("SELECT * FROM enterprises WHERE id = ?").get(req.params.id);
    if (!requireTenant(req, reply, row, "enterprises")) return;
    if (!requireAccess(req, reply, row, "view")) return;
    applyEtag(reply, row);
    return mapEnterprise(row);
  });

  fastify.post("/api/enterprises", {
    preHandler: require_("create"),
    schema: { body: EnterpriseCreateBody },
  }, async (req, reply) => {
    const orgId = tenantOrgId(req);
    if (!orgId) return reply.code(401).send({ error: "unauthenticated" });
    const { name, description = null, sortOrder = 0, workspaceId = null, acl = {} } = req.body || {};
    const wsId = workspaceId || defaultWorkspaceId(req);
    if (!wsId) return reply.code(400).send({ error: "workspace not resolvable; pass workspaceId" });
    const id = uuid("ENT");
    const ts = now();
    db.prepare(`INSERT INTO enterprises (id, org_id, workspace_id, name, description, sort_order, acl, created_by, created_at, updated_at)
                VALUES (@id, @org_id, @workspace_id, @name, @description, @sort_order, @acl, @created_by, @ts, @ts)`)
      .run({ id, org_id: orgId, workspace_id: wsId, name, description, sort_order: sortOrder, acl: JSON.stringify(acl), created_by: req.user.id, ts });
    audit({ actor: req.user.id, action: "enterprise.create", subject: id, detail: { name } });
    broadcast("asset-hierarchy", { kind: "enterprise.create", id }, orgId);
    const row = db.prepare("SELECT * FROM enterprises WHERE id = ?").get(id);
    applyEtag(reply, row);
    return mapEnterprise(row);
  });

  fastify.patch("/api/enterprises/:id", {
    preHandler: require_("edit"),
    schema: { body: EnterprisePatchBody },
  }, async (req, reply) => {
    const row = db.prepare("SELECT * FROM enterprises WHERE id = ?").get(req.params.id);
    if (!requireTenant(req, reply, row, "enterprises")) return;
    if (!requireAccess(req, reply, row, "edit")) return;
    if (!requireIfMatch(req, reply, row)) return;
    const patch = req.body || {};
    const oldName = row.name;
    const sets = [];
    const params = { id: row.id, ts: now() };
    if ("name" in patch) { sets.push("name = @name"); params.name = patch.name; }
    if ("description" in patch) { sets.push("description = @description"); params.description = patch.description; }
    if ("sortOrder" in patch) { sets.push("sort_order = @sort_order"); params.sort_order = patch.sortOrder; }
    if ("acl" in patch) { sets.push("acl = @acl"); params.acl = JSON.stringify(patch.acl || {}); }
    if (!sets.length) {
      applyEtag(reply, row);
      return mapEnterprise(row);
    }
    sets.push("updated_at = @ts");
    db.prepare(`UPDATE enterprises SET ${sets.join(", ")} WHERE id = @id`).run(params);

    // If the name changed, walk the bindings on assets in this enterprise
    // and report the affected count. We do NOT auto-re-resolve here; the
    // client surfaces a prompt and posts to /re-resolve-bindings to commit.
    let affected = [];
    let total = 0;
    if ("name" in patch && patch.name !== oldName) {
      const bindings = findBindingsForEnterprise(row.id);
      const previews = bindings.map(b => previewReResolve(b, oldName, patch.name)).filter(Boolean);
      total = previews.length;
      affected = previews.slice(0, 25); // sample
    }

    audit({ actor: req.user.id, action: "enterprise.update", subject: row.id, detail: { changes: patch, oldName, affectedBindings: total } });
    broadcast("asset-hierarchy", { kind: "enterprise.update", id: row.id }, row.org_id);
    const updated = db.prepare("SELECT * FROM enterprises WHERE id = ?").get(row.id);
    applyEtag(reply, updated);
    return { ...mapEnterprise(updated), affectedBindings: total, sample: affected };
  });

  fastify.delete("/api/enterprises/:id", { preHandler: require_("edit") }, async (req, reply) => {
    const row = db.prepare("SELECT * FROM enterprises WHERE id = ?").get(req.params.id);
    if (!requireTenant(req, reply, row, "enterprises")) return;
    if (!requireAccess(req, reply, row, "edit")) return;
    const inUse = db.prepare("SELECT COUNT(*) AS n FROM assets WHERE enterprise_id = ?").get(row.id)?.n || 0;
    if (inUse > 0) {
      return reply.code(409).send({ error: "in_use", message: `${inUse} asset(s) reference this enterprise`, count: inUse });
    }
    // ON DELETE CASCADE on locations.enterprise_id removes child locations
    // automatically; nothing else references enterprises.id.
    db.prepare("DELETE FROM enterprises WHERE id = ?").run(row.id);
    audit({ actor: req.user.id, action: "enterprise.delete", subject: row.id, detail: { name: row.name } });
    broadcast("asset-hierarchy", { kind: "enterprise.delete", id: row.id }, row.org_id);
    return { ok: true };
  });

  fastify.post("/api/enterprises/:id/re-resolve-bindings", {
    preHandler: require_("integration.write"),
    schema: { body: ReResolveBindingsBody },
  }, async (req, reply) => {
    const row = db.prepare("SELECT * FROM enterprises WHERE id = ?").get(req.params.id);
    if (!requireTenant(req, reply, row, "enterprises")) return;
    if (!requireAccess(req, reply, row, "edit")) return;
    return reResolveBindings({
      req,
      bindings: findBindingsForEnterprise(row.id),
      orgId: row.org_id,
      scope: { kind: "enterprise", id: row.id },
    });
  });

  // ===== Locations =====================================================

  fastify.get("/api/locations", { preHandler: require_("view") }, async (req, reply) => {
    const t = tenantWhere(req, "locations");
    if (!t) return reply.code(401).send({ error: "unauthenticated" });
    const eid = req.query?.enterpriseId;
    const sql = eid
      ? `SELECT * FROM locations WHERE enterprise_id = ? AND ${t.where} ORDER BY sort_order, name`
      : `SELECT * FROM locations WHERE ${t.where} ORDER BY enterprise_id, sort_order, name`;
    const params = eid ? [eid, ...t.params] : t.params;
    const rows = db.prepare(sql).all(...params);
    return filterAllowed(rows, req.user, "view").map(mapLocation);
  });

  fastify.get("/api/locations/:id", { preHandler: require_("view") }, async (req, reply) => {
    const row = db.prepare("SELECT * FROM locations WHERE id = ?").get(req.params.id);
    if (!requireTenant(req, reply, row, "locations")) return;
    if (!requireAccess(req, reply, row, "view")) return;
    applyEtag(reply, row);
    return mapLocation(row);
  });

  fastify.post("/api/locations", {
    preHandler: require_("create"),
    schema: { body: LocationCreateBody },
  }, async (req, reply) => {
    const orgId = tenantOrgId(req);
    if (!orgId) return reply.code(401).send({ error: "unauthenticated" });
    const { enterpriseId, parentLocationId = null, name, kind = null, sortOrder = 0, acl = {} } = req.body || {};
    const ent = db.prepare("SELECT * FROM enterprises WHERE id = ?").get(enterpriseId);
    if (!requireTenant(req, reply, ent, "enterprises")) return;
    if (parentLocationId) {
      const parent = db.prepare("SELECT * FROM locations WHERE id = ?").get(parentLocationId);
      if (!requireTenant(req, reply, parent, "locations")) return;
      if (parent.enterprise_id !== enterpriseId) {
        return reply.code(400).send({ error: "parentLocationId belongs to a different enterprise" });
      }
    }
    const id = uuid("LOC");
    const ts = now();
    db.prepare(`INSERT INTO locations (id, org_id, workspace_id, enterprise_id, parent_location_id, name, kind, sort_order, acl, created_by, created_at, updated_at)
                VALUES (@id, @org_id, @workspace_id, @enterprise_id, @parent_location_id, @name, @kind, @sort_order, @acl, @created_by, @ts, @ts)`)
      .run({
        id,
        org_id: orgId,
        workspace_id: ent.workspace_id,
        enterprise_id: enterpriseId,
        parent_location_id: parentLocationId,
        name,
        kind,
        sort_order: sortOrder,
        acl: JSON.stringify(acl),
        created_by: req.user.id,
        ts,
      });
    audit({ actor: req.user.id, action: "location.create", subject: id, detail: { name, enterpriseId } });
    broadcast("asset-hierarchy", { kind: "location.create", id }, orgId);
    const row = db.prepare("SELECT * FROM locations WHERE id = ?").get(id);
    applyEtag(reply, row);
    return mapLocation(row);
  });

  fastify.patch("/api/locations/:id", {
    preHandler: require_("edit"),
    schema: { body: LocationPatchBody },
  }, async (req, reply) => {
    const row = db.prepare("SELECT * FROM locations WHERE id = ?").get(req.params.id);
    if (!requireTenant(req, reply, row, "locations")) return;
    if (!requireAccess(req, reply, row, "edit")) return;
    if (!requireIfMatch(req, reply, row)) return;
    const patch = req.body || {};
    const oldName = row.name;
    const sets = [];
    const params = { id: row.id, ts: now() };
    if ("name" in patch) { sets.push("name = @name"); params.name = patch.name; }
    if ("kind" in patch) { sets.push("kind = @kind"); params.kind = patch.kind; }
    if ("parentLocationId" in patch) { sets.push("parent_location_id = @parent_location_id"); params.parent_location_id = patch.parentLocationId; }
    if ("sortOrder" in patch) { sets.push("sort_order = @sort_order"); params.sort_order = patch.sortOrder; }
    if ("acl" in patch) { sets.push("acl = @acl"); params.acl = JSON.stringify(patch.acl || {}); }
    if (!sets.length) {
      applyEtag(reply, row);
      return mapLocation(row);
    }
    sets.push("updated_at = @ts");
    db.prepare(`UPDATE locations SET ${sets.join(", ")} WHERE id = @id`).run(params);

    let affected = [];
    let total = 0;
    if ("name" in patch && patch.name !== oldName) {
      const bindings = findBindingsForLocation(row.id);
      const previews = bindings.map(b => previewReResolve(b, oldName, patch.name)).filter(Boolean);
      total = previews.length;
      affected = previews.slice(0, 25);
    }

    audit({ actor: req.user.id, action: "location.update", subject: row.id, detail: { changes: patch, oldName, affectedBindings: total } });
    broadcast("asset-hierarchy", { kind: "location.update", id: row.id }, row.org_id);
    const updated = db.prepare("SELECT * FROM locations WHERE id = ?").get(row.id);
    applyEtag(reply, updated);
    return { ...mapLocation(updated), affectedBindings: total, sample: affected };
  });

  fastify.delete("/api/locations/:id", { preHandler: require_("edit") }, async (req, reply) => {
    const row = db.prepare("SELECT * FROM locations WHERE id = ?").get(req.params.id);
    if (!requireTenant(req, reply, row, "locations")) return;
    if (!requireAccess(req, reply, row, "edit")) return;
    const inUse = db.prepare("SELECT COUNT(*) AS n FROM assets WHERE location_id = ?").get(row.id)?.n || 0;
    if (inUse > 0) {
      return reply.code(409).send({ error: "in_use", message: `${inUse} asset(s) reference this location`, count: inUse });
    }
    db.prepare("DELETE FROM locations WHERE id = ?").run(row.id);
    audit({ actor: req.user.id, action: "location.delete", subject: row.id, detail: { name: row.name } });
    broadcast("asset-hierarchy", { kind: "location.delete", id: row.id }, row.org_id);
    return { ok: true };
  });

  fastify.post("/api/locations/:id/re-resolve-bindings", {
    preHandler: require_("integration.write"),
    schema: { body: ReResolveBindingsBody },
  }, async (req, reply) => {
    const row = db.prepare("SELECT * FROM locations WHERE id = ?").get(req.params.id);
    if (!requireTenant(req, reply, row, "locations")) return;
    if (!requireAccess(req, reply, row, "edit")) return;
    return reResolveBindings({
      req,
      bindings: findBindingsForLocation(row.id),
      orgId: row.org_id,
      scope: { kind: "location", id: row.id },
    });
  });

  // ===== Asset tree (denormalised for the dashboard) ===================
  //
  // Returns a NESTED tree honoring the ISA-95 5-level chain
  // (Enterprise → Site → Area → Line → Cell → Asset). Locations
  // self-nest via `parent_location_id`; the response embeds a
  // `children` array on each location so the dashboard renders the
  // chain recursively without re-fetching.
  //
  // Spec ref: docs/INDUSTRIAL_EDGE_PLATFORM_SPEC.md §4.

  fastify.get("/api/asset-tree", { preHandler: require_("view") }, async (req, reply) => {
    const orgId = tenantOrgId(req);
    if (!orgId) return reply.code(401).send({ error: "unauthenticated" });
    const enterpriseRows = db.prepare(
      "SELECT * FROM enterprises WHERE org_id = ? ORDER BY sort_order, name"
    ).all(orgId);
    const locationRows = db.prepare(
      "SELECT * FROM locations WHERE org_id = ? ORDER BY enterprise_id, sort_order, name"
    ).all(orgId);
    const assetRows = db.prepare(
      "SELECT id, name, type, status, enterprise_id, location_id, visual_file_id, profile_version_id, acl FROM assets WHERE org_id = ?"
    ).all(orgId);

    // Filter by ACL — same posture as `core.js:223`. `enterprise` /
    // `location` rows currently default to `{}` ACL which `allows()`
    // resolves via the deny-by-default policy in strict mode; in demo
    // mode the permissive fallback grants access. Either way, both the
    // tree node and its assets must pass.
    const visEnterprises = filterAllowed(enterpriseRows, req.user, "view");
    const visLocations = filterAllowed(locationRows, req.user, "view");
    const visAssets = filterAllowed(assetRows, req.user, "view");

    const locById = Object.fromEntries(visLocations.map(l => [l.id, l]));
    const assetsByLocation = {};
    const assetsByEnterpriseUngrouped = {};
    for (const a of visAssets) {
      if (a.location_id && locById[a.location_id]) {
        (assetsByLocation[a.location_id] ||= []).push(a);
      } else if (a.enterprise_id) {
        (assetsByEnterpriseUngrouped[a.enterprise_id] ||= []).push(a);
      }
    }

    // Build the location tree per enterprise. A location whose
    // parent_location_id points at another visible location nests
    // under that parent; otherwise it's a top-level child of the
    // enterprise. Orphans (parent invisible due to ACL) bubble up to
    // the enterprise level so they don't disappear from the tree.
    function buildLocationNodes(entId) {
      const list = visLocations.filter(l => l.enterprise_id === entId);
      const byParent = new Map();
      const tops = [];
      for (const l of list) {
        const node = {
          id: l.id,
          name: l.name,
          kind: l.kind,
          parentLocationId: l.parent_location_id,
          children: [],
          assets: (assetsByLocation[l.id] || []).map(packAsset),
        };
        if (l.parent_location_id && locById[l.parent_location_id] && locById[l.parent_location_id].enterprise_id === entId) {
          if (!byParent.has(l.parent_location_id)) byParent.set(l.parent_location_id, []);
          byParent.get(l.parent_location_id).push(node);
        } else {
          tops.push(node);
        }
      }
      // Wire children. Two passes: first index nodes, then attach.
      const allNodes = [];
      function collect(n) { allNodes.push(n); }
      tops.forEach(collect);
      for (const arr of byParent.values()) for (const n of arr) collect(n);
      const byId = Object.fromEntries(allNodes.map(n => [n.id, n]));
      for (const [parentId, children] of byParent.entries()) {
        if (byId[parentId]) byId[parentId].children = children;
      }
      return tops;
    }

    const tree = visEnterprises.map(ent => ({
      id: ent.id,
      name: ent.name,
      description: ent.description,
      sortOrder: ent.sort_order,
      locations: buildLocationNodes(ent.id),
      ungroupedAssets: (assetsByEnterpriseUngrouped[ent.id] || []).map(packAsset),
    }));

    // Assets with no enterprise/location appear in an "Unassigned" bucket
    // so the operator can fix them up from the dashboard.
    const unassigned = visAssets
      .filter(a => !a.enterprise_id && !a.location_id)
      .map(packAsset);

    return { tree, unassigned };
  });
}

function packAsset(a) {
  return {
    id: a.id,
    name: a.name,
    type: a.type,
    status: a.status,
    visualFileId: a.visual_file_id || null,
    profileVersionId: a.profile_version_id || null,
  };
}

/**
 * Shared re-resolve handler. Walks the bindings on a renamed
 * enterprise/location, applies the bindingIds / skipBindingIds filters,
 * recomputes `source_path` for each profile-bound binding, and writes
 * back atomically inside one transaction so a failure mid-loop doesn't
 * leave partial state. Custom-mapping bindings are reported as `skipped`
 * with `reason: "custom_mapping"`.
 *
 * Axis convention: by default we recognise `vars.enterprise` for the
 * enterprise rename axis and `vars.site` / `vars.location` for the
 * location axis. Bindings using non-standard placeholder names (e.g.
 * `{org}` instead of `{enterprise}`) are not auto-re-resolved here —
 * Phase 3's apply-profile flow will record an explicit
 * placeholder→axis map on each binding so this gets fully general.
 */
function reResolveBindings({ req, bindings, orgId, scope }) {
  const body = req.body || {};
  const whitelist = Array.isArray(body.bindingIds) ? new Set(body.bindingIds) : null;
  const blacklist = Array.isArray(body.skipBindingIds) ? new Set(body.skipBindingIds) : new Set();

  // The rename PATCH already happened, so the *live* enterprise/location
  // names below are the post-rename values. We update the binding's
  // template_vars to match those live names along the rename axis only.
  const enterpriseNameByAsset = db.prepare(
    "SELECT a.id AS asset_id, e.name AS enterprise_name FROM assets a LEFT JOIN enterprises e ON e.id = a.enterprise_id WHERE a.org_id = ?"
  ).all(orgId).reduce((acc, r) => (acc[r.asset_id] = r.enterprise_name, acc), {});
  const locationNameByAsset = db.prepare(
    "SELECT a.id AS asset_id, l.name AS location_name FROM assets a LEFT JOIN locations l ON l.id = a.location_id WHERE a.org_id = ?"
  ).all(orgId).reduce((acc, r) => (acc[r.asset_id] = r.location_name, acc), {});

  const axisKeys = scope.kind === "enterprise" ? ENTERPRISE_KEYS : LOCATION_KEYS;
  const updates = [];
  const skipped = [];
  for (const b of bindings) {
    if (whitelist && !whitelist.has(b.id)) continue;
    if (blacklist.has(b.id)) { skipped.push({ bindingId: b.id, reason: "skip_requested" }); continue; }
    const vars = jsonOrDefault(b.template_vars, {});
    const newVars = { ...vars };
    let touched = false;
    const liveName = scope.kind === "enterprise"
      ? enterpriseNameByAsset[b.asset_id]
      : locationNameByAsset[b.asset_id];
    if (liveName == null) continue;
    for (const k of axisKeys) {
      if (!(k in vars)) continue;
      if (String(vars[k] ?? "") === liveName) continue; // already current
      newVars[k] = liveName;
      touched = true;
    }
    if (!touched) continue;
    const tpl = templateForBinding(b);
    if (!tpl) {
      skipped.push({ bindingId: b.id, reason: "custom_mapping" });
      continue;
    }
    const newPath = resolveTemplate(tpl, newVars);
    updates.push({ id: b.id, source_path: newPath, template_vars: JSON.stringify(newVars) });
  }

  const updateStmt = db.prepare(
    "UPDATE asset_point_bindings SET source_path = ?, template_vars = ?, updated_at = ? WHERE id = ?"
  );
  const ts = now();
  db.transaction(() => {
    for (const u of updates) {
      updateStmt.run(u.source_path, u.template_vars, ts, u.id);
    }
  })();

  for (const u of updates) {
    audit({
      actor: req.user.id,
      action: "binding.reresolve",
      subject: u.id,
      detail: { scope, newPath: u.source_path },
    });
  }
  if (updates.length) broadcast("bindings", { reresolved: updates.length, scope }, orgId);

  return { updated: updates.length, skipped, scope };
}
