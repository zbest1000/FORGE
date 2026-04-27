// Core CRUD routes — read-heavy, small, spec-aligned.
// Every mutating route goes through `audit(...)` and enforces capability.

import { db, now, uuid, jsonOrDefault } from "../db.js";
import { audit } from "../audit.js";
import { can, require_, listUsers, CAPABILITIES } from "../auth.js";
import { broadcast } from "../sse.js";
import { canTransitionRevision, cascadeOnApprove } from "../../src/core/fsm/revision.js";
import { canTransitionApproval } from "../../src/core/fsm/approval.js";
import { allows, filterAllowed, requireAccess, requireAuth } from "../acl.js";
import { tenantOrgId, tenantWhere, requireTenant, orgForRow } from "../tenant.js";
import { applyEtag, requireIfMatch } from "../etag.js";
import {
  WorkItemCreateBody,
  WorkItemPatchBody,
  MessagePostBody,
  RevisionTransitionBody,
  ApprovalDecideBody,
} from "../schemas/core.js";

function mapRowJson(row, fields) {
  const out = { ...row };
  for (const f of fields) out[f] = jsonOrDefault(row[f], f === "acl" ? {} : []);
  return out;
}

/**
 * Resolve `?limit=` and `?offset=` from the request query, clamped to a
 * sensible enterprise cap. Defaults to a high limit so existing clients
 * keep working; callers that page should pass explicit values.
 */
function readPage(req, { defaultLimit = 200, maxLimit = 500 } = {}) {
  const limit = Math.min(maxLimit, Math.max(1, Number(req.query?.limit || defaultLimit)));
  const offset = Math.max(0, Number(req.query?.offset || 0));
  return { limit, offset };
}

function docForRevision(revId) {
  return db.prepare(`SELECT d.* FROM documents d JOIN revisions r ON r.doc_id = d.id WHERE r.id = ?`).get(revId);
}

function rowForApprovalSubject(row) {
  if (!row) return null;
  if (row.subject_kind === "Revision") return docForRevision(row.subject_id);
  if (row.subject_kind === "Document") return db.prepare("SELECT * FROM documents WHERE id = ?").get(row.subject_id);
  if (row.subject_kind === "WorkItem") return db.prepare("SELECT * FROM work_items WHERE id = ?").get(row.subject_id);
  if (row.subject_kind === "Incident") return db.prepare("SELECT * FROM incidents WHERE id = ?").get(row.subject_id);
  return row;
}

function canSeeSearchHit(user, h, orgId) {
  // Helper that returns true only when the hit's owning row exists, is in
  // the requester's tenant, and the user's ACL permits read.
  const inOrg = (table, row) => row && (!orgId || orgForRow(table, row) === orgId);
  if (h.kind === "Revision") {
    const doc = h.docId ? db.prepare("SELECT * FROM documents WHERE id = ?").get(h.docId) : docForRevision(h.id);
    return inOrg("documents", doc) && allows(user, doc?.acl, "view");
  }
  if (h.kind === "Document") {
    const row = db.prepare("SELECT * FROM documents WHERE id = ?").get(h.id);
    return inOrg("documents", row) && allows(user, row?.acl, "view");
  }
  if (h.kind === "Drawing") {
    const row = db.prepare("SELECT * FROM drawings WHERE id = ?").get(h.id);
    return inOrg("drawings", row) && allows(user, row?.acl, "view");
  }
  if (h.kind === "Message") {
    const m = db.prepare("SELECT * FROM messages WHERE id = ?").get(h.id);
    if (!m) return false;
    const ch = db.prepare("SELECT * FROM channels WHERE id = ?").get(m.channel_id);
    return inOrg("channels", ch) && allows(user, ch?.acl, "view");
  }
  if (h.kind === "WorkItem") {
    const row = db.prepare("SELECT * FROM work_items WHERE id = ?").get(h.id);
    return inOrg("work_items", row) && allows(user, row?.acl, "view");
  }
  if (h.kind === "Asset") {
    const row = db.prepare("SELECT * FROM assets WHERE id = ?").get(h.id);
    return inOrg("assets", row) && allows(user, row?.acl, "view");
  }
  return true;
}

export default async function coreRoutes(fastify) {
  // ---------- me ----------
  fastify.get("/api/me", async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: "unauthenticated" });
    return { user: req.user, capabilities: CAPABILITIES[req.user.role] || [] };
  });

  fastify.get("/api/users", { preHandler: require_("view") }, async (req) => {
    const orgId = tenantOrgId(req);
    if (!orgId) return [];
    return listUsers().filter(u => u.org_id === orgId);
  });

  // ---------- team spaces ----------
  fastify.get("/api/team-spaces", { preHandler: require_("view") }, async (req) => {
    const t = tenantWhere(req, "team_spaces");
    const { limit, offset } = readPage(req);
    const rows = db.prepare(`SELECT * FROM team_spaces WHERE ${t.where} ORDER BY name LIMIT ? OFFSET ?`).all(...t.params, limit, offset);
    return filterAllowed(rows, req.user, "view").map(r => mapRowJson(r, ["acl", "labels"]));
  });

  fastify.get("/api/team-spaces/:id", { preHandler: require_("view") }, async (req, reply) => {
    const row = db.prepare("SELECT * FROM team_spaces WHERE id = ?").get(req.params.id);
    if (!requireTenant(req, reply, row, "team_spaces")) return;
    if (!requireAccess(req, reply, row, "view")) return;
    return mapRowJson(row, ["acl", "labels"]);
  });

  // ---------- projects ----------
  fastify.get("/api/projects", { preHandler: require_("view") }, async (req) => {
    const t = tenantWhere(req, "projects");
    const ts = req.query.teamSpaceId;
    const { limit, offset } = readPage(req);
    const sql = ts
      ? `SELECT * FROM projects WHERE team_space_id = ? AND ${t.where} ORDER BY name LIMIT ? OFFSET ?`
      : `SELECT * FROM projects WHERE ${t.where} ORDER BY name LIMIT ? OFFSET ?`;
    const params = ts ? [ts, ...t.params, limit, offset] : [...t.params, limit, offset];
    const rows = db.prepare(sql).all(...params);
    return filterAllowed(rows, req.user, "view").map(r => mapRowJson(r, ["acl", "labels", "milestones"]));
  });

  // ---------- channels ----------
  fastify.get("/api/channels", { preHandler: require_("view") }, async (req) => {
    const t = tenantWhere(req, "channels");
    const ts = req.query.teamSpaceId;
    const { limit, offset } = readPage(req);
    const sql = ts
      ? `SELECT * FROM channels WHERE team_space_id = ? AND ${t.where} ORDER BY name LIMIT ? OFFSET ?`
      : `SELECT * FROM channels WHERE ${t.where} ORDER BY name LIMIT ? OFFSET ?`;
    const params = ts ? [ts, ...t.params, limit, offset] : [...t.params, limit, offset];
    const rows = db.prepare(sql).all(...params);
    return filterAllowed(rows, req.user, "view").map(r => mapRowJson(r, ["acl"]));
  });

  fastify.get("/api/channels/:id/messages", { preHandler: require_("view") }, async (req, reply) => {
    const ch = db.prepare("SELECT * FROM channels WHERE id = ?").get(req.params.id);
    if (!requireTenant(req, reply, ch, "channels")) return;
    if (!requireAccess(req, reply, ch, "view")) return;
    const limit = Math.min(500, Number(req.query.limit || 200));
    const rows = db.prepare("SELECT * FROM messages WHERE channel_id = ? ORDER BY ts DESC LIMIT ?").all(req.params.id, limit);
    return rows.reverse().map(r => ({ ...r, attachments: JSON.parse(r.attachments || "[]"), edits: JSON.parse(r.edits || "[]") }));
  });

  fastify.post("/api/channels/:id/messages", {
    preHandler: require_("create"),
    schema: { body: MessagePostBody },
  }, async (req, reply) => {
    const { text, type = "discussion", attachments = [] } = req.body || {};
    if (!text || !text.trim()) return reply.code(400).send({ error: "text required" });
    const ch = db.prepare("SELECT * FROM channels WHERE id = ?").get(req.params.id);
    if (!requireTenant(req, reply, ch, "channels")) return;
    if (!requireAccess(req, reply, ch, "create")) return;
    const id = uuid("M");
    const ts = now();
    db.prepare(`INSERT INTO messages (id, channel_id, author_id, ts, type, text, attachments, edits, deleted)
                VALUES (@id, @channel_id, @author_id, @ts, @type, @text, @att, '[]', 0)`)
      .run({ id, channel_id: req.params.id, author_id: req.user.id, ts, type, text: text.trim(), att: JSON.stringify(attachments) });
    audit({ actor: req.user.id, action: "message.post", subject: req.params.id, detail: { messageId: id } });
    broadcast("messages", { channelId: req.params.id, id });
    return { id, ts };
  });

  // ---------- documents & revisions ----------
  fastify.get("/api/documents", { preHandler: require_("view") }, async (req) => {
    const t = tenantWhere(req, "documents");
    const { limit, offset } = readPage(req);
    const rows = db.prepare(`SELECT * FROM documents WHERE ${t.where} ORDER BY name LIMIT ? OFFSET ?`).all(...t.params, limit, offset);
    return filterAllowed(rows, req.user, "view").map(r => mapRowJson(r, ["acl", "labels"]));
  });

  fastify.get("/api/documents/:id", { preHandler: require_("view") }, async (req, reply) => {
    const row = db.prepare("SELECT * FROM documents WHERE id = ?").get(req.params.id);
    if (!requireTenant(req, reply, row, "documents")) return;
    if (!requireAccess(req, reply, row, "view")) return;
    const revs = db.prepare("SELECT * FROM revisions WHERE doc_id = ? ORDER BY created_at").all(req.params.id);
    return { ...mapRowJson(row, ["acl", "labels"]), revisions: revs };
  });

  fastify.get("/api/revisions/:id", { preHandler: require_("view") }, async (req, reply) => {
    const row = db.prepare("SELECT * FROM revisions WHERE id = ?").get(req.params.id);
    if (!row) return reply.code(404).send({ error: "not found" });
    const doc = db.prepare("SELECT * FROM documents WHERE id = ?").get(row.doc_id);
    if (!requireTenant(req, reply, doc, "documents")) return;
    if (!requireAccess(req, reply, doc, "view")) return;
    return row;
  });

  fastify.post("/api/revisions/:id/transition", {
    preHandler: require_("approve"),
    schema: { body: RevisionTransitionBody },
  }, async (req, reply) => {
    const { to, notes = "" } = req.body || {};
    const rev = db.prepare("SELECT * FROM revisions WHERE id = ?").get(req.params.id);
    if (!rev) return reply.code(404).send({ error: "not found" });
    const doc = db.prepare("SELECT * FROM documents WHERE id = ?").get(rev.doc_id);
    if (!requireTenant(req, reply, doc, "documents")) return;
    if (!requireAccess(req, reply, doc, "approve")) return;
    if (!canTransitionRevision(rev.status, to)) {
      return reply.code(400).send({ error: `cannot transition ${rev.status} → ${to}` });
    }

    db.transaction(() => {
      db.prepare("UPDATE revisions SET status = ?, updated_at = ? WHERE id = ?").run(to, now(), rev.id);
      if (to === "IFC") {
        // auto-supersede previous IFC for this doc.
        db.prepare("UPDATE revisions SET status = 'Superseded', updated_at = ? WHERE doc_id = ? AND status = 'IFC' AND id != ?").run(now(), rev.doc_id, rev.id);
        db.prepare("UPDATE documents SET current_revision_id = ?, updated_at = ? WHERE id = ?").run(rev.id, now(), rev.doc_id);
      }
    })();

    audit({ actor: req.user.id, action: "revision.transition", subject: rev.id, detail: { from: rev.status, to, notes } });
    broadcast("revisions", { id: rev.id, from: rev.status, to });
    return { id: rev.id, status: to };
  });

  // ---------- assets ----------
  fastify.get("/api/assets", { preHandler: require_("view") }, async (req) => {
    const t = tenantWhere(req, "assets");
    const { limit, offset } = readPage(req);
    const rows = db.prepare(`SELECT * FROM assets WHERE ${t.where} ORDER BY name LIMIT ? OFFSET ?`).all(...t.params, limit, offset);
    return filterAllowed(rows, req.user, "view").map(r => mapRowJson(r, ["acl", "labels", "mqtt_topics", "opcua_nodes", "doc_ids"]));
  });

  // ---------- work items ----------
  fastify.get("/api/work-items", { preHandler: require_("view") }, async (req) => {
    const t = tenantWhere(req, "work_items");
    const pid = req.query.projectId;
    const { limit, offset } = readPage(req);
    const rows = pid
      ? db.prepare(`SELECT * FROM work_items WHERE project_id = ? AND ${t.where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(pid, ...t.params, limit, offset)
      : db.prepare(`SELECT * FROM work_items WHERE ${t.where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...t.params, limit, offset);
    return filterAllowed(rows, req.user, "view").map(r => mapRowJson(r, ["acl", "labels", "blockers"]));
  });

  fastify.post("/api/work-items", {
    preHandler: require_("create"),
    schema: { body: WorkItemCreateBody },
  }, async (req, reply) => {
    const { projectId, type = "Task", title, severity = "medium", assigneeId = null, due = null } = req.body || {};
    if (!projectId || !title) return reply.code(400).send({ error: "projectId and title required" });
    const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId);
    if (!requireTenant(req, reply, project, "projects")) return;
    if (!requireAccess(req, reply, project, "create")) return;
    const id = uuid("WI");
    db.prepare(`INSERT INTO work_items (id, project_id, type, title, description, assignee_id, status, severity, due, blockers, labels, acl, created_at, updated_at)
                VALUES (@id, @pid, @type, @title, '', @assignee_id, 'Open', @severity, @due, '[]', '[]', '{}', @now, @now)`)
      .run({ id, pid: projectId, type, title, assignee_id: assigneeId, severity, due, now: now() });
    audit({ actor: req.user.id, action: "workitem.create", subject: id, detail: { type, title } });
    broadcast("work-items", { id, projectId });
    return { id };
  });

  fastify.get("/api/work-items/:id", { preHandler: require_("view") }, async (req, reply) => {
    const row = db.prepare("SELECT * FROM work_items WHERE id = ?").get(req.params.id);
    if (!requireTenant(req, reply, row, "work_items")) return;
    if (!requireAccess(req, reply, row, "view")) return;
    applyEtag(reply, row);
    return mapRowJson(row, ["acl", "labels", "blockers"]);
  });

  fastify.patch("/api/work-items/:id", {
    preHandler: require_("edit"),
    schema: { body: WorkItemPatchBody },
  }, async (req, reply) => {
    const row = db.prepare("SELECT * FROM work_items WHERE id = ?").get(req.params.id);
    if (!requireTenant(req, reply, row, "work_items")) return;
    if (!requireAccess(req, reply, row, "edit")) return;
    if (!requireIfMatch(req, reply, row)) return;
    const patch = req.body || {};
    const allowed = ["title", "description", "assignee_id", "status", "severity", "due"];
    const sets = [];
    const params = { id: row.id, now: now() };
    for (const k of allowed) {
      if (k in patch) {
        sets.push(`${k} = @${k}`);
        params[k] = patch[k];
      }
    }
    if ("blockers" in patch) { sets.push("blockers = @blockers"); params.blockers = JSON.stringify(patch.blockers); }
    if ("labels" in patch) { sets.push("labels = @labels"); params.labels = JSON.stringify(patch.labels); }
    if (!sets.length) {
      applyEtag(reply, row);
      return row;
    }
    sets.push("updated_at = @now");
    db.prepare(`UPDATE work_items SET ${sets.join(", ")} WHERE id = @id`).run(params);
    audit({ actor: req.user.id, action: "workitem.update", subject: row.id, detail: { changes: patch } });
    broadcast("work-items", { id: row.id });
    const updated = db.prepare("SELECT * FROM work_items WHERE id = ?").get(row.id);
    applyEtag(reply, updated);
    return updated;
  });

  // ---------- incidents ----------
  fastify.get("/api/incidents", { preHandler: require_("view") }, async (req) => {
    const t = tenantWhere(req, "incidents");
    const { limit, offset } = readPage(req);
    const rows = db.prepare(`SELECT * FROM incidents WHERE ${t.where} ORDER BY started_at DESC LIMIT ? OFFSET ?`).all(...t.params, limit, offset);
    return filterAllowed(rows, req.user, "view")
      .map(r => ({ ...r, timeline: JSON.parse(r.timeline || "[]"), checklist_state: JSON.parse(r.checklist_state || "{}"), roster: JSON.parse(r.roster || "{}") }));
  });

  fastify.post("/api/incidents/:id/entry", { preHandler: require_("incident.respond") }, async (req, reply) => {
    const row = db.prepare("SELECT * FROM incidents WHERE id = ?").get(req.params.id);
    if (!requireTenant(req, reply, row, "incidents")) return;
    if (!requireAccess(req, reply, row, "incident.respond")) return;
    const tl = JSON.parse(row.timeline || "[]");
    tl.push({ ts: now(), actor: req.user.id, text: req.body?.text || "" });
    db.prepare("UPDATE incidents SET timeline = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(tl), now(), row.id);
    audit({ actor: req.user.id, action: "incident.entry", subject: row.id });
    broadcast("incidents", { id: row.id, entry: true });
    return { ok: true };
  });

  // ---------- approvals ----------
  fastify.get("/api/approvals", { preHandler: require_("view") }, async (req) => {
    const orgId = tenantOrgId(req);
    if (!orgId) return [];
    return db.prepare("SELECT * FROM approvals ORDER BY created_at DESC").all()
      .filter(r => {
        const subject = rowForApprovalSubject(r);
        if (!subject) return false;
        const subjectTable = ({ Revision: "documents", Document: "documents", WorkItem: "work_items", Incident: "incidents" })[r.subject_kind];
        if (subjectTable && orgForRow(subjectTable, subject) !== orgId) return false;
        return allows(req.user, subject.acl, "view");
      })
      .map(r => ({ ...r, approvers: JSON.parse(r.approvers || "[]"), chain: JSON.parse(r.chain || "[]") }));
  });

  fastify.post("/api/approvals/:id/decide", {
    preHandler: require_("approve"),
    schema: { body: ApprovalDecideBody },
  }, async (req, reply) => {
    const { outcome, notes = "" } = req.body || {};
    if (!["approved","rejected"].includes(outcome)) return reply.code(400).send({ error: "outcome must be approved|rejected" });
    const row = db.prepare("SELECT * FROM approvals WHERE id = ?").get(req.params.id);
    if (!row) return reply.code(404).send({ error: "not found" });
    const subject = rowForApprovalSubject(row);
    const subjectTable = ({ Revision: "documents", Document: "documents", WorkItem: "work_items", Incident: "incidents" })[row.subject_kind];
    if (subjectTable && !requireTenant(req, reply, subject, subjectTable)) return;
    if (!requireAccess(req, reply, subject, "approve")) return;
    if (!canTransitionApproval(row.status, outcome)) {
      return reply.code(400).send({ error: `cannot decide approval in status '${row.status}' → '${outcome}'` });
    }
    const { signHMAC, canonicalJSON } = await import("../crypto.js");
    const payload = { approvalId: row.id, subject: { kind: row.subject_kind, id: row.subject_id }, outcome, notes, signer: req.user.id, ts: now() };
    const sig = await signHMAC(canonicalJSON(payload));
    const chain = JSON.parse(row.chain || "[]");
    chain.push({ ts: payload.ts, action: outcome, actor: req.user.id, signature: sig.signature, keyId: sig.keyId });
    db.prepare("UPDATE approvals SET status = ?, reason = ?, signed_by = ?, signed_at = ?, signature = ?, chain = ?, updated_at = ? WHERE id = ?")
      .run(outcome, notes, req.user.id, payload.ts, JSON.stringify(sig), JSON.stringify(chain), now(), row.id);
    audit({ actor: req.user.id, action: outcome === "approved" ? "approval.sign" : "approval.reject", subject: row.id, detail: { signature: sig.signature.slice(0, 12) } });

    // Cascade: promote revision through the FSM-defined sequence
    // (IFR → Approved → IFC). cascadeOnApprove() lives in
    // src/core/fsm/revision.js so client + server agree.
    if (row.subject_kind === "Revision" && outcome === "approved") {
      const rev = db.prepare("SELECT * FROM revisions WHERE id = ?").get(row.subject_id);
      if (rev) {
        const to = cascadeOnApprove(rev.status);
        if (to && canTransitionRevision(rev.status, to)) {
          // reuse transition logic via HTTP would be overkill; do it inline.
          db.prepare("UPDATE revisions SET status = ?, updated_at = ? WHERE id = ?").run(to, now(), rev.id);
          if (to === "IFC") {
            db.prepare("UPDATE revisions SET status = 'Superseded', updated_at = ? WHERE doc_id = ? AND status = 'IFC' AND id != ?").run(now(), rev.doc_id, rev.id);
            db.prepare("UPDATE documents SET current_revision_id = ?, updated_at = ? WHERE id = ?").run(rev.id, now(), rev.doc_id);
          }
          audit({ actor: req.user.id, action: "revision.transition", subject: rev.id, detail: { from: rev.status, to, via: row.id } });
        }
      }
    }
    broadcast("approvals", { id: row.id, outcome });
    return { id: row.id, outcome, signature: sig };
  });

  // ---------- audit ----------
  // Tenant-scoped: a request from ORG-1 only sees ORG-1's entries plus
  // global system events (`org_id IS NULL`). Cross-tenant audit access
  // is reserved for the global ops backplane (out-of-band CLI), not the
  // REST surface.
  fastify.get("/api/audit", { preHandler: require_("view") }, async (req) => {
    const orgId = tenantOrgId(req);
    const limit = Math.min(500, Number(req.query.limit || 100));
    const { recent } = await import("../audit.js");
    return recent(limit, { orgId });
  });

  fastify.get("/api/audit/verify", { preHandler: require_("view") }, async () => {
    const { verifyLedger } = await import("../audit.js");
    return verifyLedger();
  });

  fastify.get("/api/audit/export", { preHandler: require_("view") }, async (req, reply) => {
    const orgId = tenantOrgId(req);
    const { exportAuditPack } = await import("../audit.js");
    const pack = await exportAuditPack({ since: req.query.since || null, until: req.query.until || null, orgId });
    reply.header("Content-Type", "application/json");
    reply.header("Content-Disposition", `attachment; filename=forge-audit-${new Date().toISOString().replace(/[:.]/g,"-")}.json`);
    return pack;
  });

  // ---------- events / DLQ ----------
  fastify.get("/api/events", { preHandler: require_("integration.read") }, async () => (await import("../events.js")).listEvents(200));
  fastify.get("/api/dlq", { preHandler: require_("integration.write") }, async () => (await import("../events.js")).listDLQ(100));
  fastify.post("/api/events/ingest", { preHandler: require_("integration.write") }, async (req) => (await import("../events.js")).ingest(req.body || {}, { source: req.ip, source_type: "rest" }));
  fastify.post("/api/dlq/:id/replay", { preHandler: require_("integration.write") }, async (req) => (await import("../events.js")).replay(req.params.id));

  // ---------- search ----------
  fastify.get("/api/search", { preHandler: require_("view") }, async (req) => {
    const orgId = tenantOrgId(req);
    if (!orgId) return { hits: [], facets: { kind: {}, date: {}, revision: {} } };
    const { sanitizeFtsTerm } = await import("../security/fts.js");
    const phrase = sanitizeFtsTerm(req.query.q);
    if (!phrase) return { hits: [], facets: { kind: {}, date: {}, revision: {} } };
    const docs = db.prepare(`SELECT id, kind, title, body FROM fts_docs WHERE fts_docs MATCH ? ORDER BY rank LIMIT 25`).all(phrase);
    const msgs = db.prepare(`SELECT id, channel_id, text FROM fts_messages WHERE fts_messages MATCH ? ORDER BY rank LIMIT 25`).all(phrase);
    const wis  = db.prepare(`SELECT id, project_id, title, description, labels FROM fts_workitems WHERE fts_workitems MATCH ? ORDER BY rank LIMIT 25`).all(phrase);
    const ast  = db.prepare(`SELECT id, name, hierarchy, type FROM fts_assets WHERE fts_assets MATCH ? ORDER BY rank LIMIT 25`).all(phrase);

    const hits = [
      ...docs.map(r => {
        if (r.kind === "Revision") {
          const rev = db.prepare("SELECT label, status, created_at, doc_id FROM revisions WHERE id = ?").get(r.id);
          return { kind: "Revision", id: r.id, docId: rev?.doc_id, title: r.title, snippet: r.body?.slice(0, 160), revision: rev?.label, status: rev?.status, route: rev ? `/doc/${rev.doc_id}` : `/docs`, date: rev?.created_at };
        }
        if (r.kind === "Document") {
          const doc = db.prepare("SELECT created_at FROM documents WHERE id = ?").get(r.id);
          return { kind: "Document", id: r.id, title: r.title, snippet: r.body?.slice(0, 160), date: doc?.created_at };
        }
        return { kind: r.kind || "Document", id: r.id, title: r.title, snippet: r.body?.slice(0, 160) };
      }),
      ...msgs.map(r => {
        const m = db.prepare("SELECT ts FROM messages WHERE id = ?").get(r.id);
        return { kind: "Message", id: r.id, title: r.text?.slice(0, 80), route: `/channel/${r.channel_id}`, date: m?.ts };
      }),
      ...wis.map(r  => {
        const w = db.prepare("SELECT created_at FROM work_items WHERE id = ?").get(r.id);
        return { kind: "WorkItem", id: r.id, title: r.title, snippet: r.description, route: `/work-board/${r.project_id}`, date: w?.created_at };
      }),
      ...ast.map(r  => {
        const a = db.prepare("SELECT created_at FROM assets WHERE id = ?").get(r.id);
        return { kind: "Asset", id: r.id, title: r.name, snippet: r.hierarchy, route: `/asset/${r.id}`, date: a?.created_at };
      }),
    ];

    // Facet filters from query string.
    const wantKind = (req.query.kind || "").split(",").map(s => s.trim()).filter(Boolean);
    const wantRev = (req.query.revision || "").split(",").map(s => s.trim()).filter(Boolean);
    const fromDate = req.query.from || null;
    const toDate = req.query.to || null;

    const aclFiltered = hits.filter(h => canSeeSearchHit(req.user, h, orgId));
    const filtered = aclFiltered.filter(h => {
      if (wantKind.length && !wantKind.includes(h.kind)) return false;
      if (wantRev.length && !(h.revision && wantRev.includes(h.revision))) return false;
      if (fromDate && h.date && h.date < fromDate) return false;
      if (toDate && h.date && h.date > toDate) return false;
      return true;
    });

    const facets = { kind: {}, date: {}, revision: {} };
    for (const h of aclFiltered) {
      facets.kind[h.kind] = (facets.kind[h.kind] || 0) + 1;
      if (h.date) {
        const day = h.date.slice(0, 10);
        facets.date[day] = (facets.date[day] || 0) + 1;
      }
      if (h.revision) facets.revision[h.revision] = (facets.revision[h.revision] || 0) + 1;
    }

    return { hits: filtered, facets };
  });
}
