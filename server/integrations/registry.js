import { db, now, uuid, jsonOrDefault } from "../db.js";
import { audit } from "../audit.js";

export const CONNECTOR_TYPES = {
  erp: ["sap", "oracle", "dynamics", "generic-rest"],
  mes: ["isa95", "generic-mes", "generic-rest"],
  cmms: ["maximo", "servicenow", "eam-generic"],
  edms: ["sharepoint", "autodesk-acc", "document-repository"],
  historian: ["aveva-pi", "influxdb", "timeseries-generic"],
  identity: ["keycloak", "oidc", "scim"],
  compliance: ["vanta", "drata", "secureframe", "generic-evidence-webhook"],
};

function parseSystem(row) {
  if (!row) return null;
  const { secret_ref, ...safe } = row;
  return {
    ...safe,
    has_secret: !!secret_ref,
    has_secret_ref: !!secret_ref,
    capabilities: jsonOrDefault(row.capabilities, []),
    config: jsonOrDefault(row.config, {}),
  };
}

function parseRun(row) {
  return row ? { ...row, run_type: row.run_type || row.action, stats: jsonOrDefault(row.stats, {}) } : null;
}

function parseLink(row) {
  return row ? { ...row, metadata: jsonOrDefault(row.metadata, {}) } : null;
}

export function listEnterpriseSystems() {
  return db.prepare("SELECT * FROM enterprise_systems ORDER BY created_at DESC").all().map(parseSystem);
}

export function getEnterpriseSystem(id, { includeSecret = false } = {}) {
  const row = db.prepare("SELECT * FROM enterprise_systems WHERE id = ?").get(id);
  if (!row) return null;
  if (includeSecret) return { ...row, capabilities: jsonOrDefault(row.capabilities, []), config: jsonOrDefault(row.config, {}) };
  return parseSystem(row);
}

export function createEnterpriseSystem(input, actor) {
  const id = uuid("ES");
  const row = {
    id,
    name: input.name,
    kind: input.category || input.kind,
    vendor: input.vendor || null,
    base_url: input.baseUrl || null,
    auth_type: input.authType || "none",
    secret_ref: input.secretRef || null,
    status: "configured",
    owner_id: input.ownerId || actor || null,
    config: JSON.stringify({ ...(input.config || {}), dataResidency: input.dataResidency || null }),
    capabilities: JSON.stringify(input.capabilities || []),
    created_at: now(),
    updated_at: now(),
  };
  db.prepare(`INSERT INTO enterprise_systems
    (id, name, kind, vendor, base_url, auth_type, secret_ref, status, capabilities, owner_id, config, created_at, updated_at)
    VALUES (@id, @name, @kind, @vendor, @base_url, @auth_type, @secret_ref, @status, @capabilities, @owner_id, @config, @created_at, @updated_at)`).run(row);
  audit({ actor: actor || "system", action: "enterprise_system.create", subject: id, detail: { kind: row.kind, vendor: row.vendor } });
  return parseSystem(row);
}

export function updateEnterpriseSystem(id, patch, actor) {
  const row = db.prepare("SELECT * FROM enterprise_systems WHERE id = ?").get(id);
  if (!row) return null;
  const next = {
    id,
    name: patch.name ?? row.name,
    status: patch.status ?? row.status,
    base_url: patch.baseUrl ?? row.base_url,
    config: patch.config ? JSON.stringify(patch.config) : row.config,
    updated_at: now(),
  };
  db.prepare(`UPDATE enterprise_systems SET name=@name, status=@status, base_url=@base_url,
    config=@config, updated_at=@updated_at WHERE id=@id`).run(next);
  audit({ actor: actor || "system", action: "enterprise_system.update", subject: id, detail: { fields: Object.keys(patch || {}) } });
  return getEnterpriseSystem(id);
}

export function createConnectorRun({ systemId, runType, requestedBy, status = "queued", stats = {}, error = null, traceId = null }) {
  const id = uuid("CR");
  const row = {
    id, system_id: systemId, action: runType, status,
    started_at: now(), finished_at: status === "queued" ? null : now(),
    requested_by: requestedBy || null,
    stats: JSON.stringify(stats), error,
  };
  db.prepare(`INSERT INTO connector_runs (id, system_id, action, status, started_at, finished_at, stats, error, requested_by)
              VALUES (@id, @system_id, @action, @status, @started_at, @finished_at, @stats, @error, @requested_by)`).run(row);
  audit({ actor: requestedBy || "system", action: `connector.${runType}`, subject: systemId, detail: { runId: id, status } });
  return parseRun(row);
}

export function listConnectorRuns(systemId, limit = 50) {
  return db.prepare("SELECT * FROM connector_runs WHERE system_id = ? ORDER BY started_at DESC LIMIT ?").all(systemId, limit).map(parseRun);
}

export function createExternalLink(input, actor) {
  const id = uuid("XLINK");
  const row = {
    id,
    system_id: input.systemId,
    external_kind: input.externalKind,
    external_id: input.externalId,
    forge_kind: input.forgeKind,
    forge_id: input.forgeId,
    metadata: JSON.stringify(input.metadata || {}),
    created_at: now(),
  };
  db.prepare(`INSERT INTO external_object_links (id, system_id, external_kind, external_id, forge_kind, forge_id, metadata, created_at)
              VALUES (@id, @system_id, @external_kind, @external_id, @forge_kind, @forge_id, @metadata, @created_at)`).run(row);
  audit({ actor: actor || "system", action: "external_link.create", subject: id, detail: { systemId: input.systemId, forge: `${input.forgeKind}:${input.forgeId}` } });
  return parseLink(row);
}

export function listExternalLinks({ systemId, forgeKind, forgeId } = {}) {
  const where = []; const params = [];
  if (systemId) { where.push("system_id = ?"); params.push(systemId); }
  if (forgeKind) { where.push("forge_kind = ?"); params.push(forgeKind); }
  if (forgeId) { where.push("forge_id = ?"); params.push(forgeId); }
  let sql = "SELECT * FROM external_object_links";
  if (where.length) sql += " WHERE " + where.join(" AND ");
  sql += " ORDER BY created_at DESC";
  return db.prepare(sql).all(...params).map(parseLink);
}

export const listSystems = () => listEnterpriseSystems();
export const createSystem = (input) => createEnterpriseSystem(input, input.actor);
export const updateSystem = updateEnterpriseSystem;
export const recordRun = (input) => createConnectorRun({ ...input, status: input.status || "succeeded" });
export const listRuns = listConnectorRuns;
