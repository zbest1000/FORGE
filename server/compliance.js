import { db, now, uuid, jsonOrDefault } from "./db.js";
import { audit } from "./audit.js";

function parse(row, fields = []) {
  if (!row) return null;
  const out = { ...row };
  for (const f of fields) out[f] = jsonOrDefault(row[f], []);
  return out;
}

export function createDsar({ subjectUserId, requestType = "access", requesterId, scope = {}, dueAt = null }) {
  const id = uuid("DSAR");
  db.prepare(`INSERT INTO data_subject_requests (id, subject_user_id, request_type, status, due_at, notes, created_by, created_at)
              VALUES (@id, @subject, @type, 'open', @due, @notes, @requester, @ts)`)
    .run({ id, subject: subjectUserId, type: requestType, due: dueAt, notes: JSON.stringify({ scope }), requester: requesterId, ts: now() });
  audit({ actor: requesterId || "system", action: "compliance.dsar.create", subject: id, detail: { subjectUserId, requestType } });
  return db.prepare("SELECT * FROM data_subject_requests WHERE id = ?").get(id);
}

export function createAiSystemRecord({ name, purpose, ownerId = null, riskTier = "limited", provider = "local", model = null, dataCategories = [], humanOversight = "" }, actor) {
  const id = uuid("AIS");
  db.prepare(`INSERT INTO ai_system_inventory (id, name, purpose, owner_id, risk_tier, provider, model, data_categories, human_oversight, status, created_at, updated_at)
              VALUES (@id, @name, @purpose, @owner, @risk, @provider, @model, @cats, @oversight, 'active', @ts, @ts)`)
    .run({ id, name, purpose, owner: ownerId, risk: riskTier, provider, model, cats: JSON.stringify(dataCategories), oversight: humanOversight, ts: now() });
  audit({ actor: actor || "system", action: "compliance.ai_system.create", subject: id, detail: { riskTier, provider, model } });
  return parse(db.prepare("SELECT * FROM ai_system_inventory WHERE id = ?").get(id), ["data_categories"]);
}

export function exportDsarBundle(id, actor) {
  const req = db.prepare("SELECT * FROM data_subject_requests WHERE id = ?").get(id);
  if (!req) return null;
  const user = db.prepare("SELECT id, email, name, role, initials, disabled, created_at, updated_at, abac FROM users WHERE id = ?").get(req.subject_user_id);
  const messages = db.prepare("SELECT * FROM messages WHERE author_id = ? ORDER BY ts DESC").all(req.subject_user_id)
    .map(r => ({ ...r, attachments: jsonOrDefault(r.attachments, []), edits: jsonOrDefault(r.edits, []) }));
  const workItems = db.prepare("SELECT * FROM work_items WHERE assignee_id = ? ORDER BY created_at DESC").all(req.subject_user_id)
    .map(r => ({ ...r, blockers: jsonOrDefault(r.blockers, []), labels: jsonOrDefault(r.labels, []) }));
  const approvals = db.prepare("SELECT * FROM approvals WHERE requester_id = ? OR signed_by = ? ORDER BY created_at DESC").all(req.subject_user_id, req.subject_user_id)
    .map(r => ({ ...r, approvers: jsonOrDefault(r.approvers, []), chain: jsonOrDefault(r.chain, []) }));
  const auditEvents = db.prepare("SELECT * FROM audit_log WHERE actor = ? OR subject = ? ORDER BY seq DESC LIMIT 1000").all(req.subject_user_id, req.subject_user_id)
    .map(r => ({ ...r, detail: jsonOrDefault(r.detail, {}) }));
  const aiLogs = db.prepare("SELECT * FROM ai_log WHERE actor = ? ORDER BY ts DESC LIMIT 1000").all(req.subject_user_id)
    .map(r => ({ ...r, citations: jsonOrDefault(r.citations, []) }));
  const bundle = {
    exported_at: now(),
    request: parse(req, ["scope"]),
    subject: user ? { ...user, abac: jsonOrDefault(user.abac, {}) } : null,
    records: { messages, workItems, approvals, auditEvents, aiLogs },
  };
  audit({ actor: actor || "system", action: "compliance.dsar.export", subject: id, detail: { subjectUserId: req.subject_user_id } });
  return bundle;
}

export function isHeld({ objectId, scope }) {
  const rows = db.prepare("SELECT * FROM legal_holds WHERE status = 'active'").all();
  return rows.some(r => {
    const ids = jsonOrDefault(r.object_ids, []);
    return ids.includes(objectId) || (scope && r.scope === scope);
  });
}

export function listRows(table, parserFields = []) {
  return db.prepare(`SELECT * FROM ${table} ORDER BY created_at DESC`).all().map(r => parse(r, parserFields));
}

export const listProcessingActivities = () => listRows("processing_activities", ["data_categories", "subject_categories", "recipients", "systems"]);
export const createProcessingActivity = (v) => insertRecord("processing_activities", "ROPA", {
  name: v.name, purpose: v.purpose, lawful_basis: v.lawfulBasis, data_categories: JSON.stringify(v.dataCategories || []),
  subject_categories: JSON.stringify(v.subjectCategories || []), recipients: JSON.stringify(v.recipients || []),
  retention: v.retention || null, region: v.region || null, systems: JSON.stringify(v.systems || []), owner: v.actor,
}, v.actor, "compliance.ropa.create", ["data_categories", "subject_categories", "recipients", "systems"]);

export const listDataSubjectRequests = () => listRows("data_subject_requests", ["scope"]);
export const createDataSubjectRequest = ({ subjectUserId, subjectEmail, requestType, dueAt, actor }) => createDsar({ subjectUserId: subjectUserId || subjectEmail, requestType, requesterId: actor, dueAt });
export const exportDataSubjectRequest = exportDsarBundle;

export const listLegalHolds = () => listRows("legal_holds", ["object_refs"]);
export const createLegalHold = (v) => insertRecord("legal_holds", "LH", {
  name: v.name, scope: v.scope, object_refs: JSON.stringify(v.objectRefs || []), reason: v.reason,
  status: "active", created_by: v.actor, expires_at: v.expiresAt || null,
}, v.actor, "compliance.legal_hold.create", ["object_refs"]);
export function updateLegalHold(id, patch, actor) {
  const row = db.prepare("SELECT * FROM legal_holds WHERE id = ?").get(id);
  if (!row) return null;
  const status = patch.status || row.status;
  db.prepare("UPDATE legal_holds SET status = ? WHERE id = ?").run(status, id);
  audit({ actor, action: "compliance.legal_hold.update", subject: id, detail: { status } });
  return parse(db.prepare("SELECT * FROM legal_holds WHERE id = ?").get(id), ["object_refs"]);
}

export function listEvidence({ framework, controlId } = {}) {
  let sql = "SELECT * FROM compliance_evidence"; const wh = []; const p = [];
  if (framework) { wh.push("framework = ?"); p.push(framework); }
  if (controlId) { wh.push("control_id = ?"); p.push(controlId); }
  if (wh.length) sql += " WHERE " + wh.join(" AND ");
  sql += " ORDER BY created_at DESC";
  return db.prepare(sql).all(...p).map(r => parse(r, ["object_refs"]));
}
export const createEvidence = (v) => insertRecord("compliance_evidence", "EVD", {
  framework: v.framework, control_id: v.controlId, title: v.title, description: v.description || "",
  object_refs: JSON.stringify(v.objectRefs || []), owner: v.owner, review_at: v.reviewAt,
}, v.actor, "compliance.evidence.create", ["object_refs"]);

export const listSubprocessors = () => listRows("subprocessors", ["data_categories"]);
export const createSubprocessor = (v) => insertRecord("subprocessors", "SUB", {
  name: v.name, purpose: v.purpose, data_categories: JSON.stringify(v.dataCategories || []), region: v.region,
  transfer_mechanism: v.transferMechanism, risk: v.risk, dpa_url: v.dpaUrl, status: "active",
}, v.actor, "compliance.subprocessor.create", ["data_categories"]);
export function updateSubprocessor(id, patch, actor) {
  const row = db.prepare("SELECT * FROM subprocessors WHERE id = ?").get(id);
  if (!row) return null;
  const status = patch.status || row.status;
  const risk = patch.risk || row.risk;
  db.prepare("UPDATE subprocessors SET status = ?, risk = ?, updated_at = ? WHERE id = ?").run(status, risk, now(), id);
  audit({ actor, action: "compliance.subprocessor.update", subject: id, detail: { status, risk } });
  return parse(db.prepare("SELECT * FROM subprocessors WHERE id = ?").get(id), ["data_categories"]);
}

export const listRisks = () => listRows("risk_register");
export const createRisk = (v) => insertRecord("risk_register", "RISK", {
  title: v.title, framework: v.framework, severity: v.severity, likelihood: v.likelihood,
  mitigation: v.mitigation, owner: v.owner, status: v.status,
}, v.actor, "compliance.risk.create");
export function updateRisk(id, patch, actor) {
  const row = db.prepare("SELECT * FROM risk_register WHERE id = ?").get(id);
  if (!row) return null;
  const status = patch.status || row.status;
  db.prepare("UPDATE risk_register SET status = ?, updated_at = ? WHERE id = ?").run(status, now(), id);
  audit({ actor, action: "compliance.risk.update", subject: id, detail: { status } });
  return db.prepare("SELECT * FROM risk_register WHERE id = ?").get(id);
}

export const listAiSystems = () => listRows("ai_system_inventory", ["data_categories"]);
export const createAiSystem = (v) => insertRecord("ai_system_inventory", "AIS", {
  name: v.name, provider: v.provider, model: v.model, purpose: v.purpose, risk_class: v.riskClass,
  data_categories: JSON.stringify(v.dataCategories || []), human_oversight: v.humanOversight,
  evaluation: v.evaluation, status: v.status,
}, v.actor, "compliance.ai_system.create", ["data_categories"]);

export const listRegulatoryIncidents = () => listRows("regulatory_incidents", ["timeline"]);
export function createRegulatoryReport({ incidentId, framework, authority, summary, reportDueAt, actor }) {
  const inc = db.prepare("SELECT id FROM incidents WHERE id = ?").get(incidentId);
  if (!inc) return null;
  return insertRecord("regulatory_incidents", "REG", {
    incident_id: incidentId, framework, authority, report_status: "draft", report_due_at: reportDueAt,
    summary, timeline: JSON.stringify([{ ts: now(), actor, text: "Draft report opened" }]),
  }, actor, "compliance.regulatory_report.create", ["timeline"]);
}

function insertRecord(table, prefix, fields, actor, action, jsonFields = []) {
  const id = uuid(prefix);
  const row = { id, ...fields, created_at: now(), updated_at: now() };
  const cols = Object.keys(row);
  const placeholders = cols.map(c => "@" + c).join(", ");
  db.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${placeholders})`).run(row);
  audit({ actor: actor || "system", action, subject: id });
  return parse(db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id), jsonFields);
}
