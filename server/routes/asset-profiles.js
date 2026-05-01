// Asset Profile CRUD + version history.
//
// A Profile is a reusable named data schema (e.g. "Centrifugal Pump"
// with `temperature`, `pressure`, `vibration` data points) bound to a
// source kind (`mqtt` | `opcua` | `sql`) and a path template. Profiles
// are versioned: the metadata row in `asset_profiles` carries the
// stable identity, while `asset_profile_versions` snapshots the
// `source_template` + child points at the moment they were authored.
//
// Versioning model (plan §assumptions/2):
//   - PATCH on /api/asset-profiles/:id only updates metadata fields
//     (name / description / status).
//   - To change versioned content, POST a new version. Old versions
//     stay reachable for upgrade decisions; bindings pin to a
//     specific `profile_version_id`.
//   - DELETE on a profile soft-archives it (`status='archived'`)
//     unless it has zero versions referenced by zero bindings — in
//     which case we hard-delete via cascade.
//
// Spec ref: docs/INDUSTRIAL_EDGE_PLATFORM_SPEC.md §4 (Asset Model and
// ISA-95 Hierarchy) — every asset class in the spec maps to a
// profile in our model.

import { db, now, uuid, jsonOrDefault } from "../db.js";
import { audit } from "../audit.js";
import { require_ } from "../auth.js";
import { broadcast } from "../sse.js";
import { tenantOrgId, tenantWhere, requireTenant } from "../tenant.js";
import { applyEtag, requireIfMatch } from "../etag.js";
import { sendError } from "../errors.js";
import {
  ProfileCreateBody,
  ProfilePatchBody,
  ProfileVersionCreateBody,
} from "../schemas/asset-profiles.js";

// Pagination defaults — match the convention in `server/routes/core.js`.
function readPage(req, { defaultLimit = 100, maxLimit = 500 } = {}) {
  const limit = Math.min(maxLimit, Math.max(1, Number(req.query?.limit || defaultLimit)));
  const offset = Math.max(0, Number(req.query?.offset || 0));
  return { limit, offset };
}

/**
 * Confirm a workspace belongs to the requester's org. An attacker
 * cannot create or move a profile into another tenant's workspace
 * even if they discover (guess) a workspace id. Returns true on pass;
 * sends an envelope and returns false on fail.
 */
function requireWorkspaceTenant(req, reply, workspaceId) {
  if (workspaceId == null) return true; // library scope
  const orgId = tenantOrgId(req);
  const ws = db.prepare("SELECT id, org_id FROM workspaces WHERE id = ?").get(workspaceId);
  if (!ws || ws.org_id !== orgId) {
    sendError(reply, {
      status: 404,
      code: "not_found",
      message: "workspace not found",
    });
    return false;
  }
  return true;
}

// ----- helpers ---------------------------------------------------------

function mapProfile(row) {
  if (!row) return null;
  return {
    id: row.id,
    orgId: row.org_id,
    workspaceId: row.workspace_id,
    name: row.name,
    description: row.description,
    sourceKind: row.source_kind,
    latestVersionId: row.latest_version_id,
    status: row.status,
    ownerId: row.owner_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapVersion(row) {
  if (!row) return null;
  return {
    id: row.id,
    profileId: row.profile_id,
    version: row.version,
    sourceTemplate: jsonOrDefault(row.source_template, {}),
    status: row.status,
    notes: row.notes,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function mapPoint(row) {
  if (!row) return null;
  return {
    id: row.id,
    profileVersionId: row.profile_version_id,
    name: row.name,
    unit: row.unit,
    dataType: row.data_type,
    sourcePathTemplate: row.source_path_template,
    order: row.point_order,
    createdAt: row.created_at,
  };
}

function pointsForVersion(versionId) {
  return db.prepare(
    "SELECT * FROM asset_profile_points WHERE profile_version_id = ? ORDER BY point_order, name"
  ).all(versionId).map(mapPoint);
}

function bindingCountForProfile(profileId) {
  return db.prepare(`
    SELECT COUNT(*) AS n
      FROM asset_point_bindings b
      JOIN asset_profile_versions v ON v.id = b.profile_version_id
     WHERE v.profile_id = ?
  `).get(profileId)?.n || 0;
}

function bindingCountForVersion(versionId) {
  return db.prepare(
    "SELECT COUNT(*) AS n FROM asset_point_bindings WHERE profile_version_id = ?"
  ).get(versionId)?.n || 0;
}

function nextVersionNumber(profileId) {
  const row = db.prepare(
    "SELECT MAX(version) AS v FROM asset_profile_versions WHERE profile_id = ?"
  ).get(profileId);
  return (row?.v || 0) + 1;
}

function defaultWorkspaceId(req) {
  // Mirror asset-hierarchy.js — fall back to the first workspace in
  // the requester's org. Clients typically pass `null` to mean "library
  // scope" (visible to all workspaces in the org); the request body's
  // `workspaceId === null` propagates as-is, so we only fill from the
  // default when it's `undefined`.
  const orgId = tenantOrgId(req);
  if (!orgId) return null;
  return db.prepare(
    "SELECT id FROM workspaces WHERE org_id = ? ORDER BY created_at LIMIT 1"
  ).get(orgId)?.id || null;
}

function insertVersion({ profileId, version, sourceTemplate, points, notes, createdBy }) {
  const versionId = uuid("PVER");
  const ts = now();
  db.prepare(`INSERT INTO asset_profile_versions
    (id, profile_id, version, source_template, status, notes, created_by, created_at)
    VALUES (@id, @profile_id, @version, @source_template, 'active', @notes, @created_by, @ts)`)
    .run({
      id: versionId,
      profile_id: profileId,
      version,
      source_template: JSON.stringify(sourceTemplate || {}),
      notes: notes || null,
      created_by: createdBy,
      ts,
    });
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    db.prepare(`INSERT INTO asset_profile_points
      (id, profile_version_id, name, unit, data_type, source_path_template, point_order, created_at)
      VALUES (@id, @profile_version_id, @name, @unit, @data_type, @source_path_template, @point_order, @ts)`)
      .run({
        id: uuid("PPT"),
        profile_version_id: versionId,
        name: p.name,
        unit: p.unit ?? null,
        data_type: p.dataType ?? "number",
        source_path_template: p.sourcePathTemplate ?? "",
        point_order: typeof p.order === "number" ? p.order : i,
        ts,
      });
  }
  // Update the profile's `latest_version_id` pointer so the common case
  // (apply latest profile) doesn't need a JOIN.
  db.prepare("UPDATE asset_profiles SET latest_version_id = ?, updated_at = ? WHERE id = ?")
    .run(versionId, ts, profileId);
  return versionId;
}

// ----- routes ----------------------------------------------------------

export default async function assetProfileRoutes(fastify) {

  // ===== List + summary =================================================

  fastify.get("/api/asset-profiles", { preHandler: require_("view") }, async (req, reply) => {
    const t = tenantWhere(req, "asset_profiles");
    if (!t) return sendError(reply, { status: 401 });
    const sourceKind = req.query?.sourceKind;
    const scope = req.query?.scope; // "library" | "workspace" | undefined
    const wsId = req.query?.workspaceId;
    const { limit, offset } = readPage(req);

    const filters = [t.where];
    const params = [...t.params];
    if (sourceKind) {
      filters.push("source_kind = ?");
      params.push(String(sourceKind));
    }
    if (scope === "library") {
      filters.push("workspace_id IS NULL");
    } else if (scope === "workspace") {
      filters.push("workspace_id IS NOT NULL");
    }
    if (wsId) {
      filters.push("(workspace_id = ? OR workspace_id IS NULL)");
      params.push(String(wsId));
    }

    const where = filters.join(" AND ");
    // Surface the unfiltered count via a header so the admin UI can
    // page without a second round-trip.
    const total = db.prepare(`SELECT COUNT(*) AS n FROM asset_profiles WHERE ${where}`)
      .get(...params)?.n || 0;
    reply.header("X-Total-Count", String(total));

    const rows = db.prepare(
      `SELECT * FROM asset_profiles WHERE ${where} ORDER BY name LIMIT ? OFFSET ?`
    ).all(...params, limit, offset);

    return rows.map(r => {
      const p = mapProfile(r);
      // Annotate listing with version + binding counts so the admin UI
      // can show "used by N assets across M versions" without N round
      // trips. These are already-tenant-scoped because the JOIN is on
      // asset_profile_versions.profile_id which we just listed.
      const versionCount = db.prepare(
        "SELECT COUNT(*) AS n FROM asset_profile_versions WHERE profile_id = ?"
      ).get(p.id)?.n || 0;
      const bindingCount = bindingCountForProfile(p.id);
      return { ...p, versionCount, bindingCount };
    });
  });

  // ===== Read ===========================================================

  fastify.get("/api/asset-profiles/:id", { preHandler: require_("view") }, async (req, reply) => {
    const row = db.prepare("SELECT * FROM asset_profiles WHERE id = ?").get(req.params.id);
    if (!requireTenant(req, reply, row, "asset_profiles")) return;
    applyEtag(reply, row);
    const profile = mapProfile(row);
    const latest = profile.latestVersionId
      ? mapVersion(db.prepare("SELECT * FROM asset_profile_versions WHERE id = ?").get(profile.latestVersionId))
      : null;
    const points = latest ? pointsForVersion(latest.id) : [];
    return { ...profile, latestVersion: latest, points };
  });

  fastify.get("/api/asset-profiles/:id/versions", { preHandler: require_("view") }, async (req, reply) => {
    const row = db.prepare("SELECT * FROM asset_profiles WHERE id = ?").get(req.params.id);
    if (!requireTenant(req, reply, row, "asset_profiles")) return;
    const versions = db.prepare(
      "SELECT * FROM asset_profile_versions WHERE profile_id = ? ORDER BY version DESC"
    ).all(req.params.id);
    return versions.map(v => {
      const m = mapVersion(v);
      return { ...m, pointCount: pointsForVersion(m.id).length, bindingCount: bindingCountForVersion(m.id) };
    });
  });

  fastify.get("/api/asset-profiles/:id/versions/:versionId", {
    preHandler: require_("view"),
  }, async (req, reply) => {
    const row = db.prepare("SELECT * FROM asset_profiles WHERE id = ?").get(req.params.id);
    if (!requireTenant(req, reply, row, "asset_profiles")) return;
    const v = db.prepare(
      "SELECT * FROM asset_profile_versions WHERE id = ? AND profile_id = ?"
    ).get(req.params.versionId, req.params.id);
    if (!v) return reply.code(404).send({ error: "version not found" });
    return { ...mapVersion(v), points: pointsForVersion(v.id) };
  });

  // ===== Create =========================================================

  fastify.post("/api/asset-profiles", {
    preHandler: require_("integration.write"),
    schema: { body: ProfileCreateBody },
  }, async (req, reply) => {
    const orgId = tenantOrgId(req);
    if (!orgId) return sendError(reply, { status: 401 });

    const {
      name,
      description = null,
      sourceKind,
      sourceTemplate = {},
      workspaceId,
      points = [],
    } = req.body || {};

    // workspaceId === undefined → fill from default; workspaceId === null
    // → keep as library (visible org-wide). Empty string treated as
    // "default workspace" for friendlier client behaviour.
    let wsId;
    if (workspaceId === undefined || workspaceId === "") wsId = defaultWorkspaceId(req);
    else wsId = workspaceId; // may be null (library)
    if (!requireWorkspaceTenant(req, reply, wsId)) return;

    const id = uuid("PROF");
    const ts = now();

    // Single transaction so a partial insert can never leave a profile
    // without its initial version.
    const tx = db.transaction(() => {
      db.prepare(`INSERT INTO asset_profiles
        (id, org_id, workspace_id, name, description, source_kind, latest_version_id, status, owner_id, created_at, updated_at)
        VALUES (@id, @org_id, @workspace_id, @name, @description, @source_kind, NULL, 'active', @owner_id, @ts, @ts)`)
        .run({
          id,
          org_id: orgId,
          workspace_id: wsId,
          name,
          description,
          source_kind: sourceKind,
          owner_id: req.user.id,
          ts,
        });
      const versionId = insertVersion({
        profileId: id,
        version: 1,
        sourceTemplate,
        points,
        notes: null,
        createdBy: req.user.id,
      });
      return versionId;
    });
    const versionId = tx();

    audit({
      actor: req.user.id,
      action: "asset_profile.create",
      subject: id,
      detail: { name, sourceKind, pointCount: points.length, versionId },
    });
    broadcast("asset-profiles", { id, kind: "create" }, orgId);

    const row = db.prepare("SELECT * FROM asset_profiles WHERE id = ?").get(id);
    applyEtag(reply, row);
    const latest = mapVersion(db.prepare("SELECT * FROM asset_profile_versions WHERE id = ?").get(versionId));
    return { ...mapProfile(row), latestVersion: latest, points: pointsForVersion(versionId) };
  });

  // ===== Patch metadata =================================================

  fastify.patch("/api/asset-profiles/:id", {
    preHandler: require_("integration.write"),
    schema: { body: ProfilePatchBody },
  }, async (req, reply) => {
    const row = db.prepare("SELECT * FROM asset_profiles WHERE id = ?").get(req.params.id);
    if (!requireTenant(req, reply, row, "asset_profiles")) return;
    if (!requireIfMatch(req, reply, row)) return;
    const patch = req.body || {};
    const sets = [];
    const params = { id: row.id, ts: now() };
    if ("name" in patch) { sets.push("name = @name"); params.name = patch.name; }
    if ("description" in patch) { sets.push("description = @description"); params.description = patch.description; }
    if ("status" in patch) { sets.push("status = @status"); params.status = patch.status; }
    if (!sets.length) {
      applyEtag(reply, row);
      return mapProfile(row);
    }
    sets.push("updated_at = @ts");
    db.prepare(`UPDATE asset_profiles SET ${sets.join(", ")} WHERE id = @id`).run(params);
    audit({
      actor: req.user.id,
      action: "asset_profile.update",
      subject: row.id,
      detail: { changes: patch },
    });
    broadcast("asset-profiles", { id: row.id, kind: "update" }, row.org_id);
    const updated = db.prepare("SELECT * FROM asset_profiles WHERE id = ?").get(row.id);
    applyEtag(reply, updated);
    return mapProfile(updated);
  });

  // ===== Create new version =============================================

  fastify.post("/api/asset-profiles/:id/versions", {
    preHandler: require_("integration.write"),
    schema: { body: ProfileVersionCreateBody },
  }, async (req, reply) => {
    const row = db.prepare("SELECT * FROM asset_profiles WHERE id = ?").get(req.params.id);
    if (!requireTenant(req, reply, row, "asset_profiles")) return;
    if (row.status === "archived") {
      return sendError(reply, {
        status: 409,
        code: "profile_archived",
        message: "cannot version an archived profile",
        details: { profileId: row.id },
      });
    }
    const { sourceTemplate, points = [], notes = null } = req.body || {};
    const next = nextVersionNumber(row.id);
    const versionId = db.transaction(() => insertVersion({
      profileId: row.id,
      version: next,
      sourceTemplate: sourceTemplate || {},
      points,
      notes,
      createdBy: req.user.id,
    }))();
    audit({
      actor: req.user.id,
      action: "asset_profile.version.create",
      subject: versionId,
      detail: { profileId: row.id, version: next, pointCount: points.length },
    });
    broadcast("asset-profiles", { id: row.id, kind: "version", versionId }, row.org_id);
    const updated = db.prepare("SELECT * FROM asset_profiles WHERE id = ?").get(row.id);
    return {
      profile: mapProfile(updated),
      version: mapVersion(db.prepare("SELECT * FROM asset_profile_versions WHERE id = ?").get(versionId)),
      points: pointsForVersion(versionId),
    };
  });

  // ===== Delete (soft-archive when in use, hard-delete when free) =====

  fastify.delete("/api/asset-profiles/:id", {
    preHandler: require_("integration.write"),
  }, async (req, reply) => {
    const row = db.prepare("SELECT * FROM asset_profiles WHERE id = ?").get(req.params.id);
    if (!requireTenant(req, reply, row, "asset_profiles")) return;
    const inUse = bindingCountForProfile(row.id);
    if (inUse > 0) {
      // Refuse rather than soft-archive; the plan distinguishes "delete"
      // (operator intent: gone) from "archive" (operator intent: keep
      // bindings frozen). Soft-archive flow is via PATCH status:archived.
      return sendError(reply, {
        status: 409,
        code: "profile_in_use",
        message: `${inUse} binding(s) reference this profile across its versions; archive via PATCH status='archived' or migrate the bindings first`,
        details: { profileId: row.id, bindingCount: inUse },
      });
    }
    // Capture cascade impact for the audit trail before the row vanishes.
    const versionCount = db.prepare(
      "SELECT COUNT(*) AS n FROM asset_profile_versions WHERE profile_id = ?"
    ).get(row.id)?.n || 0;
    const pointCount = db.prepare(`
      SELECT COUNT(*) AS n FROM asset_profile_points
       WHERE profile_version_id IN (SELECT id FROM asset_profile_versions WHERE profile_id = ?)
    `).get(row.id)?.n || 0;
    // Cascade through versions + points (FK ON DELETE CASCADE handles
    // the children).
    db.prepare("DELETE FROM asset_profiles WHERE id = ?").run(row.id);
    audit({
      actor: req.user.id,
      action: "asset_profile.delete",
      subject: row.id,
      detail: { name: row.name, sourceKind: row.source_kind, cascade: { versions: versionCount, points: pointCount } },
    });
    broadcast("asset-profiles", { id: row.id, kind: "delete" }, row.org_id);
    return { ok: true };
  });
}
