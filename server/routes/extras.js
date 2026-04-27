// Routes for the spec gaps closed in this slice:
//   /api/review-cycles                  — review cycle objects (§7 #8)
//   /api/forms                          — form list (already seeded)
//   /api/form-submissions              — signed submissions (§4 #15)
//   /api/commissioning                  — commissioning checklists (§10 #8)
//   /api/rfi/:id/links                  — RFI link graph (§10 #7)
//   /api/search/alerts                  — saved-search alert subscriptions (§15)
//   /api/drawing-uploads                — drawing ingestion auto-parse (§10 #1)
//   /api/model-pins                     — model-element pinned comments (§7 #6)

import path from "node:path";
import { db, now, uuid } from "../db.js";
import { audit } from "../audit.js";
import { require_ } from "../auth.js";
import { signHMAC, canonicalJSON } from "../crypto.js";
import { allows, filterAllowed, requireAccess } from "../acl.js";

function parentFor(kind, id) {
  const table = ({
    document: "documents", revision: "revisions", drawing: "drawings",
    work_item: "work_items", workitem: "work_items", incident: "incidents",
    asset: "assets", project: "projects", channel: "channels",
  })[String(kind || "").toLowerCase()];
  if (!table || !id) return null;
  if (table === "revisions") {
    return db.prepare("SELECT d.* FROM documents d JOIN revisions r ON r.doc_id = d.id WHERE r.id = ?").get(id) || null;
  }
  return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) || null;
}

function projectForChecklist(id) {
  return db.prepare(`SELECT p.* FROM projects p JOIN commissioning_checklists c ON c.project_id = p.id WHERE c.id = ?`).get(id) || null;
}

function drawingParent(drawingId) {
  return db.prepare("SELECT * FROM drawings WHERE id = ?").get(drawingId) || null;
}

export default async function extrasRoutes(fastify) {
  // ------- Review cycles -------
  fastify.get("/api/review-cycles", { preHandler: require_("view") }, async (req) => {
    const { docId, revId } = req.query || {};
    let sql = "SELECT * FROM review_cycles";
    const params = [];
    const wheres = [];
    if (docId) { wheres.push("doc_id = ?"); params.push(docId); }
    if (revId) { wheres.push("rev_id = ?"); params.push(revId); }
    if (wheres.length) sql += " WHERE " + wheres.join(" AND ");
    sql += " ORDER BY created_at DESC";
    return db.prepare(sql).all(...params)
      .filter(r => allows(req.user, parentFor("document", r.doc_id)?.acl, "view"))
      .map(parseReviewCycle);
  });

  fastify.post("/api/review-cycles", { preHandler: require_("create") }, async (req, reply) => {
    const { docId, revId, name, reviewers = [], dueTs = null, notes = null } = req.body || {};
    if (!docId || !revId || !name) return reply.code(400).send({ error: "docId, revId, name required" });
    if (!requireAccess(req, reply, parentFor("document", docId), "create")) return;
    const id = uuid("RC");
    db.prepare(`INSERT INTO review_cycles (id, doc_id, rev_id, name, reviewers, status, due_ts, notes, created_by, created_at)
                VALUES (@id, @doc, @rev, @name, @reviewers, 'open', @due, @notes, @by, @ts)`)
      .run({ id, doc: docId, rev: revId, name, reviewers: JSON.stringify(reviewers), due: dueTs, notes, by: req.user.id, ts: now() });
    audit({ actor: req.user.id, action: "review_cycle.create", subject: id, detail: { docId, revId, reviewers } });
    return { id };
  });

  fastify.post("/api/review-cycles/:id/close", { preHandler: require_("approve") }, async (req, reply) => {
    const row = db.prepare("SELECT * FROM review_cycles WHERE id = ?").get(req.params.id);
    if (!row) return reply.code(404).send({ error: "not found" });
    if (!requireAccess(req, reply, parentFor("document", row.doc_id), "approve")) return;
    db.prepare("UPDATE review_cycles SET status = 'closed', closed_at = ? WHERE id = ?").run(now(), row.id);
    audit({ actor: req.user.id, action: "review_cycle.close", subject: row.id });
    return { ok: true };
  });

  // ------- Forms / submissions -------
  fastify.get("/api/forms", { preHandler: require_("view") }, async () => {
    // Forms are seeded in-memory only; expose a shape consistent with the
    // client's existing seed entry so existing UI keeps working.
    // Client serves the live list.
    return [];
  });

  fastify.post("/api/form-submissions", { preHandler: require_("create") }, async (req, reply) => {
    const { formId, parentKind = null, parentId = null, answers = {} } = req.body || {};
    if (!formId) return reply.code(400).send({ error: "formId required" });
    if (parentKind && parentId && !requireAccess(req, reply, parentFor(parentKind, parentId), "create")) return;
    const id = uuid("FS");
    const ts = now();
    const payload = { formId, parentKind, parentId, answers, submitter: req.user.id, ts };
    // Per-tenant key history: scope signature to the submitter's org.
    const sig = await signHMAC(canonicalJSON(payload), { orgId: req.user.org_id || null });
    db.prepare(`INSERT INTO form_submissions (id, form_id, parent_kind, parent_id, submitter_id, ts, answers, signature, signature_key_id)
                VALUES (@id, @form_id, @pk, @pi, @sub, @ts, @answers, @sig, @kid)`)
      .run({ id, form_id: formId, pk: parentKind, pi: parentId, sub: req.user.id, ts, answers: JSON.stringify(answers), sig: sig.signature, kid: sig.keyId });
    audit({ actor: req.user.id, action: "form.submit", subject: id, detail: { formId, parentKind, parentId, signatureKeyId: sig.keyId } });
    return { id, signature: sig };
  });

  fastify.get("/api/form-submissions", { preHandler: require_("view") }, async (req) => {
    const { formId, parentKind, parentId } = req.query || {};
    let sql = "SELECT * FROM form_submissions";
    const wheres = []; const params = [];
    if (formId)     { wheres.push("form_id = ?"); params.push(formId); }
    if (parentKind) { wheres.push("parent_kind = ?"); params.push(parentKind); }
    if (parentId)   { wheres.push("parent_id = ?"); params.push(parentId); }
    if (wheres.length) sql += " WHERE " + wheres.join(" AND ");
    sql += " ORDER BY ts DESC";
    return db.prepare(sql).all(...params)
      .filter(r => !r.parent_kind || !r.parent_id || allows(req.user, parentFor(r.parent_kind, r.parent_id)?.acl, "view"))
      .map(r => ({ ...r, answers: JSON.parse(r.answers || "{}") }));
  });

  // ------- Commissioning -------
  fastify.get("/api/commissioning", { preHandler: require_("view") }, async (req) => {
    const { projectId } = req.query || {};
    const sql = projectId ? "SELECT * FROM commissioning_checklists WHERE project_id = ?" : "SELECT * FROM commissioning_checklists";
    const rows = projectId ? db.prepare(sql).all(projectId) : db.prepare(sql).all();
    return rows.filter(r => allows(req.user, parentFor("project", r.project_id)?.acl, "view")).map(parseCommissioning);
  });

  fastify.post("/api/commissioning", { preHandler: require_("create") }, async (req, reply) => {
    const { name, projectId, system = null, panel = null, package: pkg = null, items = [] } = req.body || {};
    if (!name || !projectId) return reply.code(400).send({ error: "name + projectId required" });
    if (!requireAccess(req, reply, parentFor("project", projectId), "create")) return;
    const id = uuid("CC");
    db.prepare(`INSERT INTO commissioning_checklists (id, name, project_id, system, panel, package, items, completed, created_at, updated_at)
                VALUES (@id, @name, @pid, @sys, @panel, @pkg, @items, '[]', @ts, @ts)`)
      .run({ id, name, pid: projectId, sys: system, panel, pkg, items: JSON.stringify(items), ts: now() });
    audit({ actor: req.user.id, action: "commissioning.create", subject: id, detail: { name, projectId } });
    return { id };
  });

  fastify.post("/api/commissioning/:id/check", { preHandler: require_("edit") }, async (req, reply) => {
    const row = db.prepare("SELECT * FROM commissioning_checklists WHERE id = ?").get(req.params.id);
    if (!row) return reply.code(404).send({ error: "not found" });
    if (!requireAccess(req, reply, projectForChecklist(row.id), "edit")) return;
    const { index, checked = true } = req.body || {};
    const completed = JSON.parse(row.completed || "[]");
    const idx = Number(index);
    const at = completed.findIndex(c => c.index === idx);
    if (checked) {
      if (at >= 0) completed[at] = { index: idx, by: req.user.id, ts: now() };
      else completed.push({ index: idx, by: req.user.id, ts: now() });
    } else if (at >= 0) {
      completed.splice(at, 1);
    }
    db.prepare("UPDATE commissioning_checklists SET completed = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(completed), now(), row.id);
    audit({ actor: req.user.id, action: "commissioning.check", subject: row.id, detail: { index: idx, checked } });
    return { ok: true, completed };
  });

  // ------- RFI link graph -------
  fastify.get("/api/rfi/:id/links", { preHandler: require_("view") }, async (req, reply) => {
    if (!requireAccess(req, reply, parentFor("work_item", req.params.id), "view")) return;
    return db.prepare("SELECT * FROM rfi_links WHERE rfi_id = ?").all(req.params.id);
  });

  fastify.post("/api/rfi/:id/links", { preHandler: require_("edit") }, async (req, reply) => {
    const { targetKind, targetId, relation = "references" } = req.body || {};
    if (!targetKind || !targetId) return reply.code(400).send({ error: "targetKind, targetId required" });
    if (!requireAccess(req, reply, parentFor("work_item", req.params.id), "edit")) return;
    db.prepare("INSERT OR IGNORE INTO rfi_links (rfi_id, target_kind, target_id, relation) VALUES (?, ?, ?, ?)")
      .run(req.params.id, targetKind, targetId, relation);
    audit({ actor: req.user.id, action: "rfi.link", subject: req.params.id, detail: { targetKind, targetId, relation } });
    return { ok: true };
  });

  fastify.delete("/api/rfi/:id/links", { preHandler: require_("edit") }, async (req, reply) => {
    const { targetKind, targetId } = req.query || {};
    // The matching POST validates these — the DELETE silently dropped no
    // rows when callers omitted them and still returned `{ ok: true }`.
    if (!targetKind || !targetId) return reply.code(400).send({ error: "targetKind, targetId required" });
    if (!requireAccess(req, reply, parentFor("work_item", req.params.id), "edit")) return;
    const r = db.prepare("DELETE FROM rfi_links WHERE rfi_id = ? AND target_kind = ? AND target_id = ?")
      .run(req.params.id, targetKind, targetId);
    audit({ actor: req.user.id, action: "rfi.unlink", subject: req.params.id, detail: { targetKind, targetId, removed: r.changes } });
    return { ok: true, removed: r.changes };
  });

  // ------- Saved-search alert subscriptions -------
  fastify.get("/api/search/alerts", { preHandler: require_() }, async (req) => {
    return db.prepare("SELECT * FROM search_alerts WHERE user_id = ? ORDER BY created_at DESC").all(req.user.id)
      .map(r => ({ ...r, last_seen_ids: JSON.parse(r.last_seen_ids || "[]") }));
  });

  fastify.post("/api/search/alerts", { preHandler: require_() }, async (req, reply) => {
    const { name, query } = req.body || {};
    if (!name || !query) return reply.code(400).send({ error: "name + query required" });
    const id = uuid("SA");
    db.prepare(`INSERT INTO search_alerts (id, user_id, name, query, last_run_at, last_seen_ids, created_at)
                VALUES (@id, @uid, @name, @query, NULL, '[]', @ts)`)
      .run({ id, uid: req.user.id, name, query, ts: now() });
    audit({ actor: req.user.id, action: "search.alert.create", subject: id, detail: { name, query } });
    return { id };
  });

  fastify.delete("/api/search/alerts/:id", { preHandler: require_() }, async (req) => {
    db.prepare("DELETE FROM search_alerts WHERE id = ? AND user_id = ?").run(req.params.id, req.user.id);
    audit({ actor: req.user.id, action: "search.alert.delete", subject: req.params.id });
    return { ok: true };
  });

  // ------- Drawing ingestion auto-parse -------
  fastify.post("/api/drawings/:id/ingest", { preHandler: require_("create") }, async (req, reply) => {
    const dr = db.prepare("SELECT * FROM drawings WHERE id = ?").get(req.params.id);
    if (!dr) return reply.code(404).send({ error: "drawing not found" });
    if (!requireAccess(req, reply, dr, "create")) return;
    const { fileId, reviewerId = null } = req.body || {};
    if (!fileId) return reply.code(400).send({ error: "fileId required" });
    const f = db.prepare("SELECT * FROM files WHERE id = ?").get(fileId);
    if (!f) return reply.code(404).send({ error: "file not found" });
    // A revision must point at a real document. Falling back to the drawing
    // id (as the previous code did) silently produced revisions referencing
    // a non-existent document and broke every downstream join.
    if (!dr.doc_id) return reply.code(409).send({ error: "drawing has no parent document; attach it to a document before ingesting a revision" });

    // Heuristic auto-parse: extract a revision label from the file name
    // ("...-Rev-C.pdf"), discipline tags, drawing number, sheet count.
    const meta = parseFilename(f.name);
    const revLabel = meta.rev || nextRevisionLabel(dr.id);
    const revId = "REV-" + Math.random().toString(36).slice(2, 8).toUpperCase();
    db.prepare(`INSERT INTO revisions (id, doc_id, label, status, author_id, summary, notes, pdf_url, effective_date, created_at, updated_at)
                VALUES (@id, @doc, @label, 'IFR', @author, @summary, NULL, @pdf, NULL, @ts, @ts)`)
      .run({
        id: revId, doc: dr.doc_id, label: revLabel,
        author: req.user.id, summary: `Auto-ingested from ${f.name}`,
        pdf: (f.mime || "").includes("pdf") ? `/api/files/${f.id}` : null, ts: now(),
      });

    const ingestId = uuid("DUP");
    db.prepare(`INSERT INTO drawing_uploads (id, drawing_id, file_id, parsed_metadata, revision_id, reviewer_id, created_at)
                VALUES (@id, @dr, @file, @meta, @rev, @rev_user, @ts)`)
      .run({ id: ingestId, dr: dr.id, file: f.id, meta: JSON.stringify(meta), rev: revId, rev_user: reviewerId, ts: now() });

    audit({ actor: req.user.id, action: "drawing.ingest", subject: dr.id, detail: { fileId: f.id, revisionId: revId, meta, reviewerId } });
    return { ingestId, revisionId: revId, parsed: meta, reviewerId };
  });

  // ------- Model-element pins -------
  fastify.get("/api/model-pins", { preHandler: require_("view") }, async (req, reply) => {
    const { drawingId } = req.query || {};
    if (!drawingId) return [];
    if (!requireAccess(req, reply, drawingParent(drawingId), "view")) return;
    return db.prepare("SELECT * FROM model_pins WHERE drawing_id = ? ORDER BY created_at DESC").all(drawingId);
  });

  fastify.post("/api/model-pins", { preHandler: require_("edit.markup") }, async (req, reply) => {
    const { drawingId, elementId, text } = req.body || {};
    if (!drawingId || !elementId || !text) return reply.code(400).send({ error: "drawingId, elementId, text required" });
    if (!requireAccess(req, reply, drawingParent(drawingId), "edit.markup")) return;
    const id = uuid("MP");
    db.prepare(`INSERT INTO model_pins (id, drawing_id, element_id, author, text, created_at)
                VALUES (@id, @dr, @el, @author, @text, @ts)`)
      .run({ id, dr: drawingId, el: elementId, author: req.user.id, text, ts: now() });
    audit({ actor: req.user.id, action: "model.pin", subject: id, detail: { drawingId, elementId } });
    return { id };
  });
}

// ---------- helpers ----------
function parseReviewCycle(r) {
  return { ...r, reviewers: JSON.parse(r.reviewers || "[]") };
}
function parseCommissioning(r) {
  return { ...r, items: JSON.parse(r.items || "[]"), completed: JSON.parse(r.completed || "[]") };
}

function parseFilename(name) {
  if (!name) return {};
  const out = { name };
  const ext = path.extname(name).slice(1).toLowerCase();
  if (ext) out.format = ext;
  const m = name.match(/[-_\s](?:rev|revision)[-_\s]?([A-Z0-9]{1,4})/i);
  if (m) out.rev = m[1];
  const num = name.match(/\b([A-Z]{1,3}-?\d{2,5})\b/);
  if (num) out.drawingNumber = num[1];
  const disc = name.match(/\b(Process|Mechanical|Electrical|Controls|Civil|Structural|Architectural|HVAC)\b/i);
  if (disc) out.discipline = disc[1];
  return out;
}

function nextRevisionLabel(drawingId) {
  // For the alpha series in the seed: pick the next available letter.
  const used = db.prepare("SELECT label FROM revisions WHERE doc_id IN (SELECT doc_id FROM drawings WHERE id = ?)").all(drawingId).map(r => r.label);
  for (let c = 65; c <= 90; c++) {
    const l = String.fromCharCode(c);
    if (!used.includes(l)) return l;
  }
  return "Z+";
}
