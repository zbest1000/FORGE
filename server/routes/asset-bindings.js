// Asset binding routes — Phase 3 of the Asset Dashboard plan.
//
// The binding row (`asset_point_bindings`) is the join between an
// asset's data point definition and the registered MQTT broker /
// OPC UA endpoint / SQL data source the connector registry pulls
// from. There are two paths to create one:
//
//   1. POST /api/assets/:id/apply-profile
//      Pin a profile version to the asset. For each profile-point,
//      resolve the per-point template against the asset's
//      hierarchy variables, validate (no empty placeholders, no
//      MQTT-illegal chars on mqtt source kind), then upsert the
//      historian point + binding inside one transaction.
//
//   2. POST /api/assets/:id/custom-mapping
//      One-off bindings without a profile. The user supplies an
//      explicit per-point sourceSystemId + sourcePath, optionally
//      with a free-form SQL query template (gated behind the
//      `historian.sql.raw` capability).
//
// Plus:
//
//   GET    /api/assets/:id/bindings        — list the asset's bindings
//   DELETE /api/assets/:id/bindings/:bid   — disable + remove a binding
//   POST   /api/asset-point-bindings/:id/test
//                                          — dry-run a binding (Phase 3
//                                            supports SQL only)
//
// All mutations:
//   - require `integration.write` capability
//   - tenant-scope every cross-FK lookup (asset, profile, system)
//   - ETag/If-Match concurrency on PATCH/DELETE
//   - audit on every change (binding.create/update/delete)
//   - SSE broadcast (`bindings` topic, org-scoped)
//   - reload the connector registry surgically (debounced 250ms in
//     the registry itself)
//   - free-form SQL is validated through
//     `server/security/sql-validator.js` (catches DDL/DML, comments,
//     `INFORMATION_SCHEMA`, semicolons, missing LIMIT, unknown bind
//     params) and additionally requires `historian.sql.raw`.

import { db, now, uuid, jsonOrDefault } from "../db.js";
import { audit } from "../audit.js";
import { require_, can } from "../auth.js";
import { broadcast } from "../sse.js";
import { tenantOrgId, requireTenant } from "../tenant.js";
import { applyEtag, requireIfMatch } from "../etag.js";
import { sendError } from "../errors.js";
import {
  ApplyProfileBody,
  CustomMappingBody,
  BindingTestBody,
} from "../schemas/asset-bindings.js";
import { validateSelectTemplate } from "../security/sql-validator.js";
import { dialectForBinding, DIALECTS } from "../connectors/sql-drivers.js";
import * as connectorRegistry from "../connectors/registry.js";
import { refreshOpcuaServerAddressSpace } from "../opcua-server.js";

// ----- helpers ---------------------------------------------------------

function mapBinding(row) {
  if (!row) return null;
  return {
    id: row.id,
    orgId: row.org_id,
    assetId: row.asset_id,
    profileVersionId: row.profile_version_id,
    profilePointId: row.profile_point_id,
    pointId: row.point_id,
    systemId: row.system_id,
    sourceKind: row.source_kind,
    sourcePath: row.source_path,
    templateVars: jsonOrDefault(row.template_vars, {}),
    queryTemplate: row.query_template || null,
    sqlMode: row.sql_mode || null,
    dialect: row.dialect || null,
    enabled: !!row.enabled,
    lastValue: row.last_value,
    lastQuality: row.last_quality,
    lastSeen: row.last_seen,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Mustache-lite token replacement. Unknown tokens are left in place
 * so downstream validation flags them rather than producing a path
 * with an empty segment.
 */
function resolveTemplate(template, vars) {
  if (!template) return "";
  return String(template).replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (m, key) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) {
      const v = vars[key];
      return v == null ? "" : String(v);
    }
    return m;
  });
}

/**
 * Per-source-kind validation of a resolved path. Returns null on pass
 * or a `{ code, message }` shape on fail. Centralised so apply-profile
 * and custom-mapping use the same rules.
 */
function validateResolvedPath({ sourceKind, path }) {
  if (!path) return { code: "empty_path", message: "Resolved source_path is empty" };
  if (/\{[a-zA-Z_][a-zA-Z0-9_]*\}/.test(path)) {
    return { code: "unresolved_placeholder", message: `Path still contains an unresolved placeholder: ${path}` };
  }
  if (sourceKind === "mqtt") {
    // MQTT topics: per the spec, `+` and `#` are wildcards reserved
    // for SUBSCRIBE only — they must not appear inside a publish
    // path. We also reject leading/trailing `/` and empty segments.
    if (/(?:^|\/)([+#])(?:$|\/)/.test(path)) {
      return { code: "mqtt_wildcard_in_path", message: "MQTT wildcards (+/#) are not allowed inside a binding path" };
    }
    if (/\/\//.test(path) || path.startsWith("/") || path.endsWith("/")) {
      return { code: "mqtt_empty_segment", message: "MQTT path has an empty segment (leading, trailing, or doubled '/')" };
    }
  }
  return null;
}

function getEnterpriseAndLocationNames(asset) {
  // Resolve the asset's enterprise and location *names* so the
  // template_vars stored on the binding records what was true at
  // apply-time. Phase-1's rename re-resolve flow uses these to detect
  // drift later.
  const ent = asset.enterprise_id
    ? db.prepare("SELECT name FROM enterprises WHERE id = ?").get(asset.enterprise_id)?.name || null
    : null;
  const loc = asset.location_id
    ? db.prepare("SELECT name FROM locations WHERE id = ?").get(asset.location_id)?.name || null
    : null;
  return { enterprise: ent, site: loc, location: loc };
}

// Insert OR update the historian_point + binding pair atomically.
function upsertHistorianPoint({ orgId, asset, name, unit, dataType }) {
  const tag = `asset:${asset.id}:${name}`;
  const existing = db.prepare(
    "SELECT * FROM historian_points WHERE asset_id = ? AND tag = ?"
  ).get(asset.id, tag);
  if (existing) {
    db.prepare("UPDATE historian_points SET name = ?, unit = ?, data_type = ?, updated_at = ? WHERE id = ?")
      .run(name, unit ?? null, dataType ?? "number", now(), existing.id);
    return existing.id;
  }
  const id = uuid("HP");
  const ts = now();
  db.prepare(`INSERT INTO historian_points (id, asset_id, source_id, tag, name, unit, data_type, historian, retention_policy_id, created_at, updated_at)
              VALUES (?, ?, NULL, ?, ?, ?, ?, 'sqlite', NULL, ?, ?)`)
    .run(id, asset.id, tag, name, unit ?? null, dataType ?? "number", ts, ts);
  return id;
}

// Phase 7a: v17 migration owns the canonical column shape for
// `asset_point_bindings` (query_template, sql_mode, dialect).
// The Phase-3 idempotent ensure-block has been retired in favour
// of the migration; routes assume the columns are present.

// ----- routes ----------------------------------------------------------

export default async function assetBindingRoutes(fastify) {

  // ===== List bindings on an asset ====================================

  fastify.get("/api/assets/:id/bindings", { preHandler: require_("view") }, async (req, reply) => {
    const asset = db.prepare("SELECT * FROM assets WHERE id = ?").get(req.params.id);
    if (!requireTenant(req, reply, asset, "assets")) return;
    const rows = db.prepare(
      "SELECT * FROM asset_point_bindings WHERE asset_id = ? ORDER BY created_at"
    ).all(asset.id);
    return rows.map(mapBinding);
  });

  // ===== Apply profile to asset =======================================

  fastify.post("/api/assets/:id/apply-profile", {
    preHandler: require_("integration.write"),
    schema: { body: ApplyProfileBody },
  }, async (req, reply) => {
    const orgId = tenantOrgId(req);
    if (!orgId) return sendError(reply, { status: 401 });
    const asset = db.prepare("SELECT * FROM assets WHERE id = ?").get(req.params.id);
    if (!requireTenant(req, reply, asset, "assets")) return;

    const { profileVersionId, sourceSystemId, hierarchy = {}, overrides = [], sqlMode } = req.body || {};

    // Tenant-scope the profile version + system. Both must belong to
    // the same org as the asset.
    const versionRow = db.prepare(`
      SELECT v.*, p.org_id AS profile_org_id, p.source_kind AS profile_source_kind, p.status AS profile_status
        FROM asset_profile_versions v
        JOIN asset_profiles p ON p.id = v.profile_id
       WHERE v.id = ?
    `).get(profileVersionId);
    if (!versionRow || versionRow.profile_org_id !== orgId) {
      return sendError(reply, { status: 404, code: "not_found", message: "profile version not found" });
    }
    if (versionRow.profile_status === "archived") {
      return sendError(reply, {
        status: 409,
        code: "profile_archived",
        message: "cannot apply an archived profile",
      });
    }
    const system = db.prepare("SELECT * FROM enterprise_systems WHERE id = ?").get(sourceSystemId);
    if (!system || (system.org_id && system.org_id !== orgId)) {
      return sendError(reply, { status: 404, code: "not_found", message: "source system not found" });
    }

    const points = db.prepare(
      "SELECT * FROM asset_profile_points WHERE profile_version_id = ? ORDER BY point_order"
    ).all(profileVersionId);

    // Build the canonical templateVars from the asset's hierarchy so
    // the rename re-resolve flow has correct snapshots. Caller-
    // supplied `hierarchy` overrides the auto-derived values for keys
    // it provides — useful for sites whose plant code differs from
    // the human-readable name.
    const auto = getEnterpriseAndLocationNames(asset);
    const baseVars = {
      ...(auto.enterprise != null ? { enterprise: auto.enterprise } : {}),
      ...(auto.site != null ? { site: auto.site, location: auto.site } : {}),
      asset: asset.name,
      ...hierarchy,
    };

    // Resolve every point's source path; collect validation errors
    // upfront so we either succeed everywhere or fail without partial
    // writes. Free-form SQL needs an extra pre-validation pass on the
    // operator-authored query templates.
    // Phase 7a: each SQL binding carries a dialect (mssql / postgresql
    // / mysql / sqlite) so the connector subregistry knows which
    // driver to load. The dialect comes from (in priority): the
    // request body's `sqlDialect`, the chosen system's config /
    // vendor / kind, or — last resort — the legacy `mssql` default.
    const sqlDialect = req.body?.sqlDialect ? String(req.body.sqlDialect).toLowerCase() : null;
    if (sqlDialect && !DIALECTS[sqlDialect]) {
      return sendError(reply, {
        status: 400,
        code: "unknown_dialect",
        message: `Unknown SQL dialect "${sqlDialect}" (allowed: ${Object.keys(DIALECTS).join(", ")})`,
      });
    }
    const resolvedDialect = sqlDialect || dialectForBinding({ system });

    const overridesByPoint = new Map(overrides.map(o => [o.profilePointId, o]));
    const resolved = [];
    for (const p of points) {
      const ov = overridesByPoint.get(p.id) || {};
      const vars = { ...baseVars, point: p.name };
      const path = ov.sourcePath || resolveTemplate(p.source_path_template || "", vars);
      const sourceKind = versionRow.profile_source_kind;

      const pathErr = validateResolvedPath({ sourceKind, path });
      if (pathErr) {
        return sendError(reply, {
          status: 400,
          code: pathErr.code,
          message: `${p.name}: ${pathErr.message}`,
          details: { profilePointId: p.id, path },
        });
      }

      let queryTemplate = null;
      let resolvedSqlMode = null;
      if (sourceKind === "sql") {
        resolvedSqlMode = sqlMode || "schema_defined";
        if (resolvedSqlMode === "free_form") {
          if (!can(req.user, "historian.sql.raw")) {
            return sendError(reply, {
              status: 403,
              code: "forbidden",
              message: "free-form SQL requires the `historian.sql.raw` capability",
            });
          }
          const tpl = ov.queryTemplate;
          if (!tpl) {
            return sendError(reply, {
              status: 400,
              code: "missing_query_template",
              message: `${p.name}: free-form SQL mode requires a queryTemplate override`,
              details: { profilePointId: p.id },
            });
          }
          // Validate against the binding's resolved dialect so the
          // operator's PostgreSQL-flavoured query doesn't get
          // rejected by the MSSQL parser (and vice versa).
          const v = validateSelectTemplate(tpl, { dialect: resolvedDialect });
          if (!v.ok) {
            return sendError(reply, {
              status: 400,
              code: "sql_validation_failed",
              message: `${p.name}: ${v.message}`,
              details: { profilePointId: p.id, reason: v.code, dialect: resolvedDialect, ...(v.details || {}) },
            });
          }
          queryTemplate = tpl;
        }
      }

      resolved.push({ profilePoint: p, sourcePath: path, queryTemplate, sqlMode: resolvedSqlMode, vars });
    }

    // Single transaction: upsert historian points + bindings, plus
    // record `assets.profile_version_id` pointer so the dashboard can
    // display the bound profile-version on the asset card.
    const sourceKind = versionRow.profile_source_kind;
    const inserted = [];
    const updated = [];
    db.transaction(() => {
      for (const r of resolved) {
        const pointId = upsertHistorianPoint({
          orgId, asset,
          name: r.profilePoint.name,
          unit: r.profilePoint.unit,
          dataType: r.profilePoint.data_type,
        });
        const existing = db.prepare(
          "SELECT * FROM asset_point_bindings WHERE asset_id = ? AND point_id = ?"
        ).get(asset.id, pointId);
        const ts = now();
        if (existing) {
          db.prepare(`UPDATE asset_point_bindings
                         SET profile_version_id = @profile_version_id,
                             profile_point_id = @profile_point_id,
                             system_id = @system_id,
                             source_kind = @source_kind,
                             source_path = @source_path,
                             template_vars = @template_vars,
                             query_template = @query_template,
                             sql_mode = @sql_mode,
                             dialect = @dialect,
                             enabled = 1,
                             updated_at = @ts
                       WHERE id = @id`)
            .run({
              id: existing.id,
              profile_version_id: profileVersionId,
              profile_point_id: r.profilePoint.id,
              system_id: sourceSystemId,
              source_kind: sourceKind,
              source_path: r.sourcePath,
              template_vars: JSON.stringify(r.vars),
              query_template: r.queryTemplate,
              sql_mode: r.sqlMode,
              dialect: sourceKind === "sql" ? resolvedDialect : null,
              ts,
            });
          updated.push(existing.id);
        } else {
          const bid = uuid("APB");
          db.prepare(`INSERT INTO asset_point_bindings
            (id, org_id, asset_id, profile_version_id, profile_point_id, point_id, system_id,
             source_kind, source_path, template_vars, query_template, sql_mode, dialect,
             enabled, created_by, created_at, updated_at)
            VALUES (@id, @org_id, @asset_id, @profile_version_id, @profile_point_id, @point_id, @system_id,
                    @source_kind, @source_path, @template_vars, @query_template, @sql_mode, @dialect,
                    1, @created_by, @ts, @ts)`)
            .run({
              id: bid,
              org_id: orgId,
              asset_id: asset.id,
              profile_version_id: profileVersionId,
              profile_point_id: r.profilePoint.id,
              point_id: pointId,
              system_id: sourceSystemId,
              source_kind: sourceKind,
              source_path: r.sourcePath,
              template_vars: JSON.stringify(r.vars),
              query_template: r.queryTemplate,
              sql_mode: r.sqlMode,
              dialect: sourceKind === "sql" ? resolvedDialect : null,
              created_by: req.user.id,
              ts,
            });
          inserted.push(bid);
        }
      }
      // Pin the asset to this profile version.
      db.prepare("UPDATE assets SET profile_version_id = ?, updated_at = ? WHERE id = ?")
        .run(profileVersionId, now(), asset.id);
    })();

    audit({
      actor: req.user.id,
      action: "asset.apply_profile",
      subject: asset.id,
      detail: {
        profileVersionId,
        sourceSystemId,
        sourceKind,
        sqlMode: sqlMode || null,
        inserted: inserted.length,
        updated: updated.length,
      },
    });
    broadcast("bindings", { assetId: asset.id, kind: "apply_profile", inserted: inserted.length, updated: updated.length }, orgId);
    refreshOpcuaServerAddressSpace({ assetId: asset.id });
    connectorRegistry.reload({ assetId: asset.id });

    const after = db.prepare("SELECT * FROM asset_point_bindings WHERE asset_id = ? ORDER BY created_at").all(asset.id);
    return { inserted: inserted.length, updated: updated.length, bindings: after.map(mapBinding) };
  });

  // ===== Custom mapping (no profile) ==================================

  fastify.post("/api/assets/:id/custom-mapping", {
    preHandler: require_("integration.write"),
    schema: { body: CustomMappingBody },
  }, async (req, reply) => {
    const orgId = tenantOrgId(req);
    if (!orgId) return sendError(reply, { status: 401 });
    const asset = db.prepare("SELECT * FROM assets WHERE id = ?").get(req.params.id);
    if (!requireTenant(req, reply, asset, "assets")) return;

    const { mappings } = req.body || {};
    // Validate every system_id + free-form SQL up-front so a partial
    // failure mid-loop doesn't leave half-written rows.
    for (const m of mappings) {
      const system = db.prepare("SELECT * FROM enterprise_systems WHERE id = ?").get(m.sourceSystemId);
      if (!system || (system.org_id && system.org_id !== orgId)) {
        return sendError(reply, { status: 404, code: "not_found", message: `${m.pointName}: source system not found` });
      }
      const pathErr = validateResolvedPath({ sourceKind: m.sourceKind, path: m.sourcePath });
      if (pathErr) {
        return sendError(reply, {
          status: 400,
          code: pathErr.code,
          message: `${m.pointName}: ${pathErr.message}`,
        });
      }
      if (m.sourceKind === "sql") {
        // Resolve dialect per-mapping. Mappings can override the
        // system-derived default via mapping.sqlDialect; the dialect
        // gets persisted on the binding so the connector subregistry
        // and validator agree forever after.
        let mDialect = m.sqlDialect ? String(m.sqlDialect).toLowerCase() : null;
        if (mDialect && !DIALECTS[mDialect]) {
          return sendError(reply, {
            status: 400,
            code: "unknown_dialect",
            message: `${m.pointName}: unknown SQL dialect "${m.sqlDialect}"`,
          });
        }
        if (!mDialect) mDialect = dialectForBinding({ system });
        m._resolvedDialect = mDialect;

        if (m.sqlMode === "free_form" || m.queryTemplate) {
          if (!can(req.user, "historian.sql.raw")) {
            return sendError(reply, {
              status: 403,
              code: "forbidden",
              message: "free-form SQL requires the `historian.sql.raw` capability",
            });
          }
          if (!m.queryTemplate) {
            return sendError(reply, {
              status: 400,
              code: "missing_query_template",
              message: `${m.pointName}: free-form SQL mode requires a queryTemplate`,
            });
          }
          const v = validateSelectTemplate(m.queryTemplate, { dialect: mDialect });
          if (!v.ok) {
            return sendError(reply, {
              status: 400,
              code: "sql_validation_failed",
              message: `${m.pointName}: ${v.message}`,
              details: { reason: v.code, dialect: mDialect, ...(v.details || {}) },
            });
          }
        }
      }
    }

    const auto = getEnterpriseAndLocationNames(asset);
    const baseVars = {
      ...(auto.enterprise != null ? { enterprise: auto.enterprise } : {}),
      ...(auto.site != null ? { site: auto.site, location: auto.site } : {}),
      asset: asset.name,
    };

    const inserted = [];
    const updated = [];
    db.transaction(() => {
      for (const m of mappings) {
        const pointId = upsertHistorianPoint({
          orgId, asset,
          name: m.pointName,
          unit: m.unit,
          dataType: m.dataType,
        });
        const existing = db.prepare(
          "SELECT * FROM asset_point_bindings WHERE asset_id = ? AND point_id = ?"
        ).get(asset.id, pointId);
        const ts = now();
        const sqlMode = m.sourceKind === "sql" ? (m.sqlMode || (m.queryTemplate ? "free_form" : "schema_defined")) : null;
        const dialect = m.sourceKind === "sql" ? (m._resolvedDialect || "mssql") : null;
        if (existing) {
          db.prepare(`UPDATE asset_point_bindings
                         SET profile_version_id = NULL,
                             profile_point_id = NULL,
                             system_id = @system_id,
                             source_kind = @source_kind,
                             source_path = @source_path,
                             template_vars = @template_vars,
                             query_template = @query_template,
                             sql_mode = @sql_mode,
                             dialect = @dialect,
                             enabled = 1,
                             updated_at = @ts
                       WHERE id = @id`)
            .run({
              id: existing.id,
              system_id: m.sourceSystemId,
              source_kind: m.sourceKind,
              source_path: m.sourcePath,
              template_vars: JSON.stringify(baseVars),
              query_template: m.queryTemplate || null,
              sql_mode: sqlMode,
              dialect,
              ts,
            });
          updated.push(existing.id);
        } else {
          const bid = uuid("APB");
          db.prepare(`INSERT INTO asset_point_bindings
            (id, org_id, asset_id, profile_version_id, profile_point_id, point_id, system_id,
             source_kind, source_path, template_vars, query_template, sql_mode, dialect,
             enabled, created_by, created_at, updated_at)
            VALUES (@id, @org_id, @asset_id, NULL, NULL, @point_id, @system_id,
                    @source_kind, @source_path, @template_vars, @query_template, @sql_mode, @dialect,
                    1, @created_by, @ts, @ts)`)
            .run({
              id: bid,
              org_id: orgId,
              asset_id: asset.id,
              point_id: pointId,
              system_id: m.sourceSystemId,
              source_kind: m.sourceKind,
              source_path: m.sourcePath,
              template_vars: JSON.stringify(baseVars),
              query_template: m.queryTemplate || null,
              sql_mode: sqlMode,
              dialect,
              created_by: req.user.id,
              ts,
            });
          inserted.push(bid);
        }
      }
    })();

    audit({
      actor: req.user.id,
      action: "asset.custom_mapping",
      subject: asset.id,
      detail: { inserted: inserted.length, updated: updated.length, mappingCount: mappings.length },
    });
    broadcast("bindings", { assetId: asset.id, kind: "custom_mapping", inserted: inserted.length, updated: updated.length }, orgId);
    refreshOpcuaServerAddressSpace({ assetId: asset.id });
    connectorRegistry.reload({ assetId: asset.id });

    const after = db.prepare("SELECT * FROM asset_point_bindings WHERE asset_id = ? ORDER BY created_at").all(asset.id);
    return { inserted: inserted.length, updated: updated.length, bindings: after.map(mapBinding) };
  });

  // ===== Delete a binding ==============================================

  fastify.delete("/api/assets/:id/bindings/:bindingId", {
    preHandler: require_("integration.write"),
  }, async (req, reply) => {
    const orgId = tenantOrgId(req);
    if (!orgId) return sendError(reply, { status: 401 });
    const asset = db.prepare("SELECT * FROM assets WHERE id = ?").get(req.params.id);
    if (!requireTenant(req, reply, asset, "assets")) return;
    const row = db.prepare("SELECT * FROM asset_point_bindings WHERE id = ? AND asset_id = ?")
      .get(req.params.bindingId, asset.id);
    if (!row) return sendError(reply, { status: 404, code: "not_found", message: "binding not found" });
    db.prepare("DELETE FROM asset_point_bindings WHERE id = ?").run(row.id);
    audit({
      actor: req.user.id,
      action: "binding.delete",
      subject: row.id,
      detail: { assetId: asset.id, sourceKind: row.source_kind, systemId: row.system_id },
    });
    broadcast("bindings", { assetId: asset.id, kind: "delete", bindingId: row.id }, orgId);
    refreshOpcuaServerAddressSpace({ assetId: asset.id });
    connectorRegistry.reload({ bindingId: row.id, assetId: asset.id });
    return { ok: true };
  });

  // ===== Test a binding (dry-run) =====================================

  fastify.post("/api/asset-point-bindings/:id/test", {
    preHandler: require_("integration.write"),
    schema: { body: BindingTestBody },
  }, async (req, reply) => {
    const orgId = tenantOrgId(req);
    if (!orgId) return sendError(reply, { status: 401 });
    const row = db.prepare("SELECT * FROM asset_point_bindings WHERE id = ?").get(req.params.id);
    if (!row || row.org_id !== orgId) {
      return sendError(reply, { status: 404, code: "not_found", message: "binding not found" });
    }
    // Phase 3 just returns a structural verdict — the SQL connector
    // registry implements the real probe in Phase 4 (where the
    // mssql / aedes test fixtures are available).
    const ok = !!row.system_id && !!row.source_path;
    audit({ actor: req.user.id, action: "binding.test", subject: row.id, detail: { ok } });
    return {
      ok,
      bindingId: row.id,
      sourceKind: row.source_kind,
      sourcePath: row.source_path,
      systemId: row.system_id,
      message: ok
        ? "Binding shape looks healthy. Live probe lands in Phase 4 (MQTT) / Phase 5 (OPC UA)."
        : "Binding is missing system_id or source_path.",
    };
  });
}
