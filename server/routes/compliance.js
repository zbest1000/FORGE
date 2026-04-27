import { require_ } from "../auth.js";
import {
  createDsar,
  exportDsarBundle,
  listRows,
} from "../compliance.js";
import { db, now, uuid } from "../db.js";
import { audit } from "../audit.js";
import { applyEtag, requireIfMatch } from "../etag.js";
import {
  RopaCreateBody,
  DsarCreateBody,
  LegalHoldCreateBody,
  LegalHoldPatchBody,
  EvidenceCreateBody,
  SubprocessorCreateBody,
  SubprocessorPatchBody,
  RiskCreateBody,
  RiskPatchBody,
  AiSystemCreateBody,
  RegulatoryReportBody,
} from "../schemas/compliance.js";

function parseJson(row, fields) {
  const out = { ...row };
  for (const f of fields) { try { out[f] = JSON.parse(row[f] || "[]"); } catch { out[f] = []; } }
  return out;
}

function insert(table, row, actor, action, subjectPrefix) {
  const keys = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(k => "@" + k).join(", ")})`).run(row);
  audit({ actor, action, subject: row.id, detail: { kind: subjectPrefix } });
  return row;
}

export default async function complianceRoutes(fastify) {
  fastify.get("/api/compliance/processing-activities", { preHandler: require_("admin.view") }, async () =>
    listRows("processing_activities").map(r => parseJson(r, ["data_categories", "data_subjects", "recipients", "cross_border_transfers"])));
  fastify.post("/api/compliance/processing-activities", {
    preHandler: require_("admin.edit"),
    schema: { body: RopaCreateBody },
  }, async (req, reply) => {
    const { name, purpose, lawfulBasis, dataCategories = [], subjectCategories = [], recipients = [], retention, region, systems = [] } = req.body || {};
    if (!name || !purpose || !lawfulBasis) return reply.code(400).send({ error: "name, purpose, lawfulBasis required" });
    const row = { id: uuid("ROPA"), name, controller: "FORGE tenant", processor: "FORGE", purpose, lawful_basis: lawfulBasis, data_categories: JSON.stringify(dataCategories), data_subjects: JSON.stringify(subjectCategories), recipients: JSON.stringify(recipients), retention_policy: retention || null, residency_region: region || null, cross_border_transfers: JSON.stringify(systems), safeguards: null, created_by: req.user.id, created_at: now(), updated_at: now() };
    return insert("processing_activities", row, req.user.id, "compliance.ropa.create", "ROPA");
  });

  fastify.get("/api/compliance/dsar", { preHandler: require_("admin.view") }, async () => listRows("data_subject_requests").map(r => parseJson(r, ["scope"])));
  fastify.post("/api/compliance/dsar", {
    preHandler: require_("admin.edit"),
    schema: { body: DsarCreateBody },
  }, async (req, reply) => {
    const { subjectUserId, requestType = "access", dueAt, scope = {} } = req.body || {};
    if (!subjectUserId) return reply.code(400).send({ error: "subjectUserId required" });
    return createDsar({ subjectUserId, requestType, dueAt, scope, requesterId: req.user.id });
  });
  fastify.get("/api/compliance/dsar/:id/export", { preHandler: require_("admin.view") }, async (req, reply) => {
    const bundle = exportDsarBundle(req.params.id, req.user.id);
    if (!bundle) return reply.code(404).send({ error: "not found" });
    return bundle;
  });

  fastify.get("/api/compliance/legal-holds", { preHandler: require_("admin.view") }, async () => listRows("legal_holds").map(r => parseJson(r, ["object_ids"])));
  fastify.post("/api/compliance/legal-holds", {
    preHandler: require_("admin.edit"),
    schema: { body: LegalHoldCreateBody },
  }, async (req, reply) => {
    const { name, scope, objectRefs = [], objectIds = null, reason, expiresAt = null } = req.body || {};
    if (!name || !scope || !reason) return reply.code(400).send({ error: "name, scope, reason required" });
    const ids = objectIds || objectRefs.map(o => typeof o === "string" ? o : o.id).filter(Boolean);
    const row = { id: uuid("LH"), name, scope_kind: scope, scope_id: ids[0] || null, reason, custodian_user_ids: JSON.stringify(ids), status: "active", created_by: req.user.id, created_at: now(), released_at: expiresAt };
    return insert("legal_holds", row, req.user.id, "compliance.legal_hold.create", "LegalHold");
  });
  fastify.patch("/api/compliance/legal-holds/:id", {
    preHandler: require_("admin.edit"),
    schema: { body: LegalHoldPatchBody },
  }, async (req, reply) => {
    const row = db.prepare("SELECT * FROM legal_holds WHERE id = ?").get(req.params.id);
    if (!row) return reply.code(404).send({ error: "not found" });
    if (!requireIfMatch(req, reply, row)) return;
    const status = req.body?.status || row.status;
    db.prepare("UPDATE legal_holds SET status = ? WHERE id = ?").run(status, row.id);
    audit({ actor: req.user.id, action: "compliance.legal_hold.update", subject: row.id, detail: { status } });
    const updated = db.prepare("SELECT * FROM legal_holds WHERE id = ?").get(row.id);
    applyEtag(reply, updated);
    return updated;
  });

  fastify.get("/api/compliance/evidence", { preHandler: require_("admin.view") }, async () => listRows("compliance_evidence").map(r => parseJson(r, ["object_refs"])));
  fastify.post("/api/compliance/evidence", {
    preHandler: require_("admin.edit"),
    schema: { body: EvidenceCreateBody },
  }, async (req, reply) => {
    const { framework, controlId, title, description = "", objectRefs = [], owner = null, reviewAt = null, evidenceUri = null } = req.body || {};
    if (!framework || !controlId || !title) return reply.code(400).send({ error: "framework, controlId, title required" });
    const firstRef = objectRefs[0] || {};
    const row = { id: uuid("EVD"), framework, control_id: controlId, title, description, object_kind: firstRef.kind || null, object_id: firstRef.id || null, evidence_uri: evidenceUri, collected_by: owner || req.user.id, collected_at: reviewAt || now() };
    return insert("compliance_evidence", row, req.user.id, "compliance.evidence.create", "Evidence");
  });

  fastify.get("/api/compliance/subprocessors", { preHandler: require_("admin.view") }, async () => listRows("subprocessors").map(r => parseJson(r, ["data_categories"])));
  fastify.post("/api/compliance/subprocessors", {
    preHandler: require_("admin.edit"),
    schema: { body: SubprocessorCreateBody },
  }, async (req, reply) => {
    const { name, purpose, dataCategories = [], region, transferMechanism = null, risk = "medium", dpaUrl = null } = req.body || {};
    if (!name || !purpose || !region) return reply.code(400).send({ error: "name, purpose, region required" });
    const row = { id: uuid("SUB"), name, service: purpose, data_categories: JSON.stringify(dataCategories), region, transfer_mechanism: transferMechanism, risk_rating: risk, dpa_uri: dpaUrl, status: "active", created_at: now(), updated_at: now() };
    return insert("subprocessors", row, req.user.id, "compliance.subprocessor.create", "Subprocessor");
  });
  fastify.patch("/api/compliance/subprocessors/:id", {
    preHandler: require_("admin.edit"),
    schema: { body: SubprocessorPatchBody },
  }, async (req, reply) => {
    const row = db.prepare("SELECT * FROM subprocessors WHERE id = ?").get(req.params.id);
    if (!row) return reply.code(404).send({ error: "not found" });
    if (!requireIfMatch(req, reply, row)) return;
    db.prepare("UPDATE subprocessors SET risk_rating = COALESCE(@risk, risk_rating), status = COALESCE(@status, status), updated_at = @ts WHERE id = @id")
      .run({ id: row.id, risk: req.body?.risk || null, status: req.body?.status || null, ts: now() });
    audit({ actor: req.user.id, action: "compliance.subprocessor.update", subject: row.id });
    const updated = db.prepare("SELECT * FROM subprocessors WHERE id = ?").get(row.id);
    applyEtag(reply, updated);
    return updated;
  });

  fastify.get("/api/compliance/risks", { preHandler: require_("admin.view") }, async () => listRows("risk_register"));
  fastify.post("/api/compliance/risks", {
    preHandler: require_("admin.edit"),
    schema: { body: RiskCreateBody },
  }, async (req, reply) => {
    const { title, framework = "enterprise", severity = "medium", likelihood = "medium", mitigation = "", owner = null, status = "open", category = "security" } = req.body || {};
    if (!title) return reply.code(400).send({ error: "title required" });
    const row = { id: uuid("RISK"), title, framework, category, likelihood, impact: severity, treatment: mitigation, owner_id: owner, status, due_at: null, created_at: now(), updated_at: now() };
    return insert("risk_register", row, req.user.id, "compliance.risk.create", "Risk");
  });
  fastify.patch("/api/compliance/risks/:id", {
    preHandler: require_("admin.edit"),
    schema: { body: RiskPatchBody },
  }, async (req, reply) => {
    const row = db.prepare("SELECT * FROM risk_register WHERE id = ?").get(req.params.id);
    if (!row) return reply.code(404).send({ error: "not found" });
    if (!requireIfMatch(req, reply, row)) return;
    db.prepare("UPDATE risk_register SET status = COALESCE(@status, status), treatment = COALESCE(@mitigation, treatment), updated_at = @ts WHERE id = @id")
      .run({ id: row.id, status: req.body?.status || null, mitigation: req.body?.mitigation || null, ts: now() });
    audit({ actor: req.user.id, action: "compliance.risk.update", subject: row.id });
    const updated = db.prepare("SELECT * FROM risk_register WHERE id = ?").get(row.id);
    applyEtag(reply, updated);
    return updated;
  });

  fastify.get("/api/compliance/ai-systems", { preHandler: require_("admin.view") }, async () => listRows("ai_system_inventory").map(r => parseJson(r, ["data_categories"])));
  fastify.post("/api/compliance/ai-systems", {
    preHandler: require_("admin.edit"),
    schema: { body: AiSystemCreateBody },
  }, async (req, reply) => {
    const { name, provider, model = null, purpose, riskClass, riskTier, dataCategories = [], humanOversight = "", evaluation = "", status = "active" } = req.body || {};
    if (!name || !provider || !purpose) return reply.code(400).send({ error: "name, provider, purpose required" });
    const row = { id: uuid("AIS"), name, provider, model, purpose, risk_class: riskClass || riskTier || "limited", data_categories: JSON.stringify(dataCategories), human_oversight: humanOversight, evaluation_notes: evaluation, owner_id: req.user.id, status, created_at: now(), updated_at: now() };
    return insert("ai_system_inventory", row, req.user.id, "compliance.ai_system.create", "AISystem");
  });

  fastify.get("/api/compliance/regulatory-incidents", { preHandler: require_("admin.view") }, async () => listRows("regulatory_incidents"));
  fastify.post("/api/compliance/incidents/:id/regulatory-report", {
    preHandler: require_("admin.edit"),
    schema: { body: RegulatoryReportBody },
  }, async (req, reply) => {
    const { framework = "NIS2", authority = null, summary = "", reportDueAt = null } = req.body || {};
    const inc = db.prepare("SELECT * FROM incidents WHERE id = ?").get(req.params.id);
    if (!inc) return reply.code(404).send({ error: "incident not found" });
    const row = { id: uuid("REG"), incident_id: inc.id, regime: framework, severity: inc.severity || null, report_deadline_at: reportDueAt, status: "draft", report_json: JSON.stringify({ authority, summary }), submitted_at: null, created_by: req.user.id, created_at: now(), updated_at: now() };
    return insert("regulatory_incidents", row, req.user.id, "compliance.regulatory_report.create", "RegulatoryIncident");
  });
}
