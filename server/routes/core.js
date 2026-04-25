// Core CRUD routes — read-heavy, small, spec-aligned.
// Every mutating route goes through `audit(...)` and enforces capability.

import { db, now, uuid, jsonOrDefault } from "../db.js";
import { audit } from "../audit.js";
import { can, require_, listUsers, userById, CAPABILITIES } from "../auth.js";
import { broadcast } from "../sse.js";

function mapRowJson(row, fields) {
  const out = { ...row };
  for (const f of fields) out[f] = jsonOrDefault(row[f], f === "acl" ? {} : []);
  return out;
}

export default async function coreRoutes(fastify) {
  // ---------- me ----------
  fastify.get("/api/me", async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: "unauthenticated" });
    return { user: req.user, capabilities: CAPABILITIES[req.user.role] || [] };
  });

  fastify.get("/api/users", async () => listUsers());

  // ---------- team spaces ----------
  fastify.get("/api/team-spaces", async () => {
    return db.prepare("SELECT * FROM team_spaces ORDER BY name").all()
      .map(r => mapRowJson(r, ["acl", "labels"]));
  });

  fastify.get("/api/team-spaces/:id", async (req, reply) => {
    const row = db.prepare("SELECT * FROM team_spaces WHERE id = ?").get(req.params.id);
    if (!row) return reply.code(404).send({ error: "not found" });
    return mapRowJson(row, ["acl", "labels"]);
  });

  // ---------- projects ----------
  fastify.get("/api/projects", async (req) => {
    const ts = req.query.teamSpaceId;
    const sql = ts ? "SELECT * FROM projects WHERE team_space_id = ? ORDER BY name" : "SELECT * FROM projects ORDER BY name";
    const rows = ts ? db.prepare(sql).all(ts) : db.prepare(sql).all();
    return rows.map(r => mapRowJson(r, ["acl", "labels", "milestones"]));
  });

  // ---------- channels ----------
  fastify.get("/api/channels", async (req) => {
    const ts = req.query.teamSpaceId;
    const sql = ts ? "SELECT * FROM channels WHERE team_space_id = ? ORDER BY name" : "SELECT * FROM channels ORDER BY name";
    const rows = ts ? db.prepare(sql).all(ts) : db.prepare(sql).all();
    return rows.map(r => mapRowJson(r, ["acl"]));
  });

  fastify.get("/api/channels/:id/messages", async (req) => {
    const limit = Math.min(500, Number(req.query.limit || 200));
    const rows = db.prepare("SELECT * FROM messages WHERE channel_id = ? ORDER BY ts DESC LIMIT ?").all(req.params.id, limit);
    return rows.reverse().map(r => ({ ...r, attachments: JSON.parse(r.attachments || "[]"), edits: JSON.parse(r.edits || "[]") }));
  });

  fastify.post("/api/channels/:id/messages", { preHandler: require_("create") }, async (req, reply) => {
    const { text, type = "discussion", attachments = [] } = req.body || {};
    if (!text || !text.trim()) return reply.code(400).send({ error: "text required" });
    const ch = db.prepare("SELECT * FROM channels WHERE id = ?").get(req.params.id);
    if (!ch) return reply.code(404).send({ error: "channel not found" });
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
  fastify.get("/api/documents", async () => {
    return db.prepare("SELECT * FROM documents ORDER BY name").all()
      .map(r => mapRowJson(r, ["acl", "labels"]));
  });

  fastify.get("/api/documents/:id", async (req, reply) => {
    const row = db.prepare("SELECT * FROM documents WHERE id = ?").get(req.params.id);
    if (!row) return reply.code(404).send({ error: "not found" });
    const revs = db.prepare("SELECT * FROM revisions WHERE doc_id = ? ORDER BY created_at").all(req.params.id);
    return { ...mapRowJson(row, ["acl", "labels"]), revisions: revs };
  });

  fastify.get("/api/revisions/:id", async (req, reply) => {
    const row = db.prepare("SELECT * FROM revisions WHERE id = ?").get(req.params.id);
    if (!row) return reply.code(404).send({ error: "not found" });
    return row;
  });

  fastify.post("/api/revisions/:id/transition", { preHandler: require_("approve") }, async (req, reply) => {
    const { to, notes = "" } = req.body || {};
    const rev = db.prepare("SELECT * FROM revisions WHERE id = ?").get(req.params.id);
    if (!rev) return reply.code(404).send({ error: "not found" });
    const ALLOWED = { Draft: ["IFR","Archived"], IFR: ["Approved","Rejected","Draft","Archived"], Approved: ["IFC","Rejected","Archived"], IFC: ["Superseded","Archived"], Rejected: ["Draft","Archived"], Superseded: [], Archived: [] };
    if (!(ALLOWED[rev.status] || []).includes(to)) return reply.code(400).send({ error: `cannot transition ${rev.status} → ${to}` });

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
  fastify.get("/api/assets", async () => {
    return db.prepare("SELECT * FROM assets ORDER BY name").all()
      .map(r => mapRowJson(r, ["acl", "labels", "mqtt_topics", "opcua_nodes", "doc_ids"]));
  });

  // ---------- work items ----------
  fastify.get("/api/work-items", async (req) => {
    const pid = req.query.projectId;
    const rows = pid
      ? db.prepare("SELECT * FROM work_items WHERE project_id = ? ORDER BY created_at DESC").all(pid)
      : db.prepare("SELECT * FROM work_items ORDER BY created_at DESC").all();
    return rows.map(r => mapRowJson(r, ["acl", "labels", "blockers"]));
  });

  fastify.post("/api/work-items", { preHandler: require_("create") }, async (req, reply) => {
    const { projectId, type = "Task", title, severity = "medium", assigneeId = null, due = null } = req.body || {};
    if (!projectId || !title) return reply.code(400).send({ error: "projectId and title required" });
    const id = uuid("WI");
    db.prepare(`INSERT INTO work_items (id, project_id, type, title, description, assignee_id, status, severity, due, blockers, labels, acl, created_at, updated_at)
                VALUES (@id, @pid, @type, @title, '', @assignee_id, 'Open', @severity, @due, '[]', '[]', '{}', @now, @now)`)
      .run({ id, pid: projectId, type, title, assignee_id: assigneeId, severity, due, now: now() });
    audit({ actor: req.user.id, action: "workitem.create", subject: id, detail: { type, title } });
    broadcast("work-items", { id, projectId });
    return { id };
  });

  fastify.patch("/api/work-items/:id", { preHandler: require_("edit") }, async (req, reply) => {
    const row = db.prepare("SELECT * FROM work_items WHERE id = ?").get(req.params.id);
    if (!row) return reply.code(404).send({ error: "not found" });
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
    if (!sets.length) return row;
    sets.push("updated_at = @now");
    db.prepare(`UPDATE work_items SET ${sets.join(", ")} WHERE id = @id`).run(params);
    audit({ actor: req.user.id, action: "workitem.update", subject: row.id, detail: { changes: patch } });
    broadcast("work-items", { id: row.id });
    return db.prepare("SELECT * FROM work_items WHERE id = ?").get(row.id);
  });

  // ---------- incidents ----------
  fastify.get("/api/incidents", async () => {
    return db.prepare("SELECT * FROM incidents ORDER BY started_at DESC").all()
      .map(r => ({ ...r, timeline: JSON.parse(r.timeline || "[]"), checklist_state: JSON.parse(r.checklist_state || "{}"), roster: JSON.parse(r.roster || "{}") }));
  });

  fastify.post("/api/incidents/:id/entry", { preHandler: require_("incident.respond") }, async (req, reply) => {
    const row = db.prepare("SELECT * FROM incidents WHERE id = ?").get(req.params.id);
    if (!row) return reply.code(404).send({ error: "not found" });
    const tl = JSON.parse(row.timeline || "[]");
    tl.push({ ts: now(), actor: req.user.id, text: req.body?.text || "" });
    db.prepare("UPDATE incidents SET timeline = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(tl), now(), row.id);
    audit({ actor: req.user.id, action: "incident.entry", subject: row.id });
    broadcast("incidents", { id: row.id, entry: true });
    return { ok: true };
  });

  // ---------- approvals ----------
  fastify.get("/api/approvals", async () => {
    return db.prepare("SELECT * FROM approvals ORDER BY created_at DESC").all()
      .map(r => ({ ...r, approvers: JSON.parse(r.approvers || "[]"), chain: JSON.parse(r.chain || "[]") }));
  });

  fastify.post("/api/approvals/:id/decide", { preHandler: require_("approve") }, async (req, reply) => {
    const { outcome, notes = "" } = req.body || {};
    if (!["approved","rejected"].includes(outcome)) return reply.code(400).send({ error: "outcome must be approved|rejected" });
    const row = db.prepare("SELECT * FROM approvals WHERE id = ?").get(req.params.id);
    if (!row) return reply.code(404).send({ error: "not found" });
    const { signHMAC, canonicalJSON } = await import("../crypto.js");
    const payload = { approvalId: row.id, subject: { kind: row.subject_kind, id: row.subject_id }, outcome, notes, signer: req.user.id, ts: now() };
    const sig = await signHMAC(canonicalJSON(payload));
    const chain = JSON.parse(row.chain || "[]");
    chain.push({ ts: payload.ts, action: outcome, actor: req.user.id, signature: sig.signature, keyId: sig.keyId });
    db.prepare("UPDATE approvals SET status = ?, reason = ?, signed_by = ?, signed_at = ?, signature = ?, chain = ?, updated_at = ? WHERE id = ?")
      .run(outcome, notes, req.user.id, payload.ts, JSON.stringify(sig), JSON.stringify(chain), now(), row.id);
    audit({ actor: req.user.id, action: outcome === "approved" ? "approval.sign" : "approval.reject", subject: row.id, detail: { signature: sig.signature.slice(0, 12) } });

    // Cascade: promote revision.
    if (row.subject_kind === "Revision" && outcome === "approved") {
      const rev = db.prepare("SELECT * FROM revisions WHERE id = ?").get(row.subject_id);
      if (rev) {
        let to = null;
        if (rev.status === "IFR") to = "Approved";
        else if (rev.status === "Approved") to = "IFC";
        if (to) {
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
  fastify.get("/api/audit", { preHandler: require_("view") }, async (req) => {
    const limit = Math.min(500, Number(req.query.limit || 100));
    const { recent } = await import("../audit.js");
    return recent(limit);
  });

  fastify.get("/api/audit/verify", { preHandler: require_("view") }, async () => {
    const { verifyLedger } = await import("../audit.js");
    return verifyLedger();
  });

  fastify.get("/api/audit/export", { preHandler: require_("view") }, async (req, reply) => {
    const { exportAuditPack } = await import("../audit.js");
    const pack = await exportAuditPack({ since: req.query.since || null, until: req.query.until || null });
    reply.header("Content-Type", "application/json");
    reply.header("Content-Disposition", `attachment; filename=forge-audit-${new Date().toISOString().replace(/[:.]/g,"-")}.json`);
    return pack;
  });

  // ---------- events / DLQ ----------
  fastify.get("/api/events", async () => (await import("../events.js")).listEvents(200));
  fastify.get("/api/dlq", async () => (await import("../events.js")).listDLQ(100));
  fastify.post("/api/events/ingest", { preHandler: require_("integration.read") }, async (req) => (await import("../events.js")).ingest(req.body || {}, { source: req.ip, source_type: "rest" }));
  fastify.post("/api/dlq/:id/replay", { preHandler: require_("integration.write") }, async (req) => (await import("../events.js")).replay(req.params.id));

  // ---------- search ----------
  fastify.get("/api/search", async (req) => {
    const q = String(req.query.q || "").trim();
    if (!q) return { hits: [] };
    const esc = q.replace(/"/g, '""');
    const docs = db.prepare(`SELECT id, kind, title, body FROM fts_docs WHERE fts_docs MATCH ? ORDER BY rank LIMIT 25`).all(`"${esc}"*`);
    const msgs = db.prepare(`SELECT id, channel_id, text FROM fts_messages WHERE fts_messages MATCH ? ORDER BY rank LIMIT 25`).all(`"${esc}"*`);
    const wis  = db.prepare(`SELECT id, project_id, title, description, labels FROM fts_workitems WHERE fts_workitems MATCH ? ORDER BY rank LIMIT 25`).all(`"${esc}"*`);
    const ast  = db.prepare(`SELECT id, name, hierarchy, type FROM fts_assets WHERE fts_assets MATCH ? ORDER BY rank LIMIT 25`).all(`"${esc}"*`);
    return {
      hits: [
        ...docs.map(r => ({ kind: r.kind || "Document", id: r.id, title: r.title, snippet: r.body?.slice(0, 160) })),
        ...msgs.map(r => ({ kind: "Message", id: r.id, title: r.text?.slice(0, 80), route: `/channel/${r.channel_id}` })),
        ...wis.map(r  => ({ kind: "WorkItem", id: r.id, title: r.title, snippet: r.description, route: `/work-board/${r.project_id}` })),
        ...ast.map(r  => ({ kind: "Asset", id: r.id, title: r.name, snippet: r.hierarchy, route: `/asset/${r.id}` })),
      ],
    };
  });
}
