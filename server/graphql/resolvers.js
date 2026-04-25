// Resolvers backed by the same SQLite schema the REST routes use. Only
// reads are unauthenticated-friendly; mutations require an authenticated
// user with the right capability (matches /api semantics).

import { db, now, uuid, jsonOrDefault } from "../db.js";
import { audit, drain } from "../audit.js";
import { can } from "../auth.js";
import { signHMAC, canonicalJSON } from "../crypto.js";
import { ingest } from "../events.js";
import { readSeries } from "../metrics-rollup.js";
import { GraphQLError, GraphQLScalarType, Kind } from "graphql";

const json = arr => (Array.isArray(arr) ? arr : jsonOrDefault(arr, []));
const obj = v => (typeof v === "object" && v ? v : jsonOrDefault(v, {}));

function authError(message = "unauthenticated") {
  return new GraphQLError(message, { extensions: { code: "UNAUTHENTICATED", http: { status: 401 } } });
}
function forbiddenError(capability) {
  return new GraphQLError(`forbidden: requires ${capability}`, { extensions: { code: "FORBIDDEN", capability, http: { status: 403 } } });
}

function requireUser(ctx) {
  if (!ctx.user) throw authError();
  return ctx.user;
}

function requireCap(ctx, capability) {
  const u = requireUser(ctx);
  if (!can(u, capability)) throw forbiddenError(capability);
  return u;
}

const JSONScalar = new GraphQLScalarType({
  name: "JSON",
  description: "Arbitrary JSON",
  serialize: (v) => v == null ? null : (typeof v === "string" ? jsonOrDefault(v, v) : v),
  parseValue: (v) => v,
  parseLiteral(ast) {
    switch (ast.kind) {
      case Kind.STRING: case Kind.BOOLEAN: return ast.value;
      case Kind.INT: case Kind.FLOAT: return Number(ast.value);
      case Kind.OBJECT: {
        const o = {};
        for (const f of ast.fields) o[f.name.value] = parseLiteralRec(f.value);
        return o;
      }
      case Kind.LIST: return ast.values.map(parseLiteralRec);
      default: return null;
    }
  },
});
function parseLiteralRec(node) {
  if (node.kind === Kind.OBJECT) {
    const o = {}; for (const f of node.fields) o[f.name.value] = parseLiteralRec(f.value); return o;
  }
  if (node.kind === Kind.LIST) return node.values.map(parseLiteralRec);
  return node.value ?? null;
}

const DateTimeScalar = new GraphQLScalarType({
  name: "DateTime",
  serialize: v => v == null ? null : (typeof v === "string" ? v : new Date(v).toISOString()),
  parseValue: v => v,
  parseLiteral: ast => ast.value,
});

export const resolvers = {
  JSON: JSONScalar,
  DateTime: DateTimeScalar,

  Query: {
    me: (_, __, ctx) => ctx.user || null,
    organization: () => db.prepare("SELECT id, name, tenant_key AS tenantKey FROM organizations LIMIT 1").get(),
    workspaces: () => db.prepare("SELECT id, name, region FROM workspaces").all(),
    teamSpaces: () => db.prepare("SELECT * FROM team_spaces").all(),
    teamSpace: (_, { id }) => db.prepare("SELECT * FROM team_spaces WHERE id = ?").get(id),
    projects: (_, { teamSpaceId }) => teamSpaceId
      ? db.prepare("SELECT * FROM projects WHERE team_space_id = ?").all(teamSpaceId)
      : db.prepare("SELECT * FROM projects").all(),
    project: (_, { id }) => db.prepare("SELECT * FROM projects WHERE id = ?").get(id),
    channels: (_, { teamSpaceId }) => teamSpaceId
      ? db.prepare("SELECT * FROM channels WHERE team_space_id = ?").all(teamSpaceId)
      : db.prepare("SELECT * FROM channels").all(),
    channel: (_, { id }) => db.prepare("SELECT * FROM channels WHERE id = ?").get(id),
    documents: () => db.prepare("SELECT * FROM documents").all(),
    document: (_, { id }) => db.prepare("SELECT * FROM documents WHERE id = ?").get(id),
    revision: (_, { id }) => db.prepare("SELECT * FROM revisions WHERE id = ?").get(id),
    drawings: () => db.prepare("SELECT * FROM drawings").all(),
    drawing: (_, { id }) => db.prepare("SELECT * FROM drawings WHERE id = ?").get(id),
    assets: () => db.prepare("SELECT * FROM assets").all(),
    asset: (_, { id }) => db.prepare("SELECT * FROM assets WHERE id = ?").get(id),
    workItems: (_, { projectId }) => projectId
      ? db.prepare("SELECT * FROM work_items WHERE project_id = ? ORDER BY created_at DESC").all(projectId)
      : db.prepare("SELECT * FROM work_items ORDER BY created_at DESC").all(),
    workItem: (_, { id }) => db.prepare("SELECT * FROM work_items WHERE id = ?").get(id),
    incidents: () => db.prepare("SELECT * FROM incidents ORDER BY started_at DESC").all(),
    incident: (_, { id }) => db.prepare("SELECT * FROM incidents WHERE id = ?").get(id),
    approvals: (_, { status }) => status
      ? db.prepare("SELECT * FROM approvals WHERE status = ?").all(status)
      : db.prepare("SELECT * FROM approvals").all(),
    approval: (_, { id }) => db.prepare("SELECT * FROM approvals WHERE id = ?").get(id),

    audit: (_, { limit = 100 }) => db.prepare("SELECT * FROM audit_log ORDER BY seq DESC LIMIT ?").all(Math.min(500, limit)),
    events: (_, { limit = 50 }) => db.prepare("SELECT * FROM events ORDER BY received_at DESC LIMIT ?").all(Math.min(500, limit)),

    search: (_, args) => searchHits(args),

    metricsSeries: (_, { metric, days = 14 }) => readSeries(metric, Math.min(60, days)).map(p => ({ day: p.day, value: p.value })),
  },

  Mutation: {
    createWorkItem: (_, { projectId, type, title, severity = "medium", assigneeId = null, due = null }, ctx) => {
      requireCap(ctx, "create");
      const id = uuid("WI");
      db.prepare(`INSERT INTO work_items (id, project_id, type, title, description, assignee_id, status, severity, due, blockers, labels, acl, created_at, updated_at)
                  VALUES (@id, @pid, @type, @title, '', @assignee, 'Open', @sev, @due, '[]', '[]', '{}', @ts, @ts)`)
        .run({ id, pid: projectId, type, title, assignee: assigneeId, sev: severity, due, ts: now() });
      audit({ actor: ctx.user.id, action: "workitem.create", subject: id, detail: { type, title, via: "graphql" } });
      return db.prepare("SELECT * FROM work_items WHERE id = ?").get(id);
    },

    updateWorkItem: (_, args, ctx) => {
      requireCap(ctx, "edit");
      const row = db.prepare("SELECT * FROM work_items WHERE id = ?").get(args.id);
      if (!row) throw new GraphQLError("not found", { extensions: { http: { status: 404 } } });
      const sets = [];
      const params = { id: row.id, now: now() };
      const map = { status: "status", severity: "severity", title: "title", description: "description" };
      for (const [k, col] of Object.entries(map)) if (args[k] != null) { sets.push(`${col} = @${col}`); params[col] = args[k]; }
      if (Array.isArray(args.blockers)) { sets.push("blockers = @blockers"); params.blockers = JSON.stringify(args.blockers); }
      if (Array.isArray(args.labels))   { sets.push("labels = @labels");   params.labels   = JSON.stringify(args.labels); }
      if (sets.length) {
        sets.push("updated_at = @now");
        db.prepare(`UPDATE work_items SET ${sets.join(", ")} WHERE id = @id`).run(params);
        audit({ actor: ctx.user.id, action: "workitem.update", subject: row.id, detail: { via: "graphql", fields: Object.keys(args) } });
      }
      return db.prepare("SELECT * FROM work_items WHERE id = ?").get(row.id);
    },

    postMessage: (_, { channelId, type = "discussion", text }, ctx) => {
      requireCap(ctx, "create");
      const ch = db.prepare("SELECT * FROM channels WHERE id = ?").get(channelId);
      if (!ch) throw new GraphQLError("channel not found", { extensions: { http: { status: 404 } } });
      const id = uuid("M");
      const ts = now();
      db.prepare(`INSERT INTO messages (id, channel_id, author_id, ts, type, text, attachments, edits, deleted)
                  VALUES (@id, @ch, @author, @ts, @type, @text, '[]', '[]', 0)`)
        .run({ id, ch: channelId, author: ctx.user.id, ts, type, text });
      audit({ actor: ctx.user.id, action: "message.post", subject: channelId, detail: { messageId: id, via: "graphql" } });
      return db.prepare("SELECT * FROM messages WHERE id = ?").get(id);
    },

    transitionRevision: (_, { id, to, notes = "" }, ctx) => {
      requireCap(ctx, "approve");
      const rev = db.prepare("SELECT * FROM revisions WHERE id = ?").get(id);
      if (!rev) throw new GraphQLError("not found", { extensions: { http: { status: 404 } } });
      const ALLOWED = { Draft: ["IFR","Archived"], IFR: ["Approved","Rejected","Draft","Archived"], Approved: ["IFC","Rejected","Archived"], IFC: ["Superseded","Archived"], Rejected: ["Draft","Archived"], Superseded: [], Archived: [] };
      if (!(ALLOWED[rev.status] || []).includes(to))
        throw new GraphQLError(`cannot transition ${rev.status} → ${to}`, { extensions: { http: { status: 400 } } });
      db.transaction(() => {
        db.prepare("UPDATE revisions SET status = ?, updated_at = ? WHERE id = ?").run(to, now(), rev.id);
        if (to === "IFC") {
          db.prepare("UPDATE revisions SET status = 'Superseded', updated_at = ? WHERE doc_id = ? AND status = 'IFC' AND id != ?").run(now(), rev.doc_id, rev.id);
          db.prepare("UPDATE documents SET current_revision_id = ?, updated_at = ? WHERE id = ?").run(rev.id, now(), rev.doc_id);
        }
      })();
      audit({ actor: ctx.user.id, action: "revision.transition", subject: rev.id, detail: { from: rev.status, to, notes, via: "graphql" } });
      return db.prepare("SELECT * FROM revisions WHERE id = ?").get(rev.id);
    },

    decideApproval: async (_, { id, outcome, notes = "" }, ctx) => {
      requireCap(ctx, "approve");
      if (!["approved", "rejected"].includes(outcome))
        throw new GraphQLError("outcome must be approved|rejected", { extensions: { http: { status: 400 } } });
      const row = db.prepare("SELECT * FROM approvals WHERE id = ?").get(id);
      if (!row) throw new GraphQLError("not found", { extensions: { http: { status: 404 } } });
      const payload = { approvalId: row.id, subject: { kind: row.subject_kind, id: row.subject_id }, outcome, notes, signer: ctx.user.id, ts: now() };
      const sig = await signHMAC(canonicalJSON(payload));
      const chain = JSON.parse(row.chain || "[]");
      chain.push({ ts: payload.ts, action: outcome, actor: ctx.user.id, signature: sig.signature, keyId: sig.keyId });
      db.prepare("UPDATE approvals SET status = ?, reason = ?, signed_by = ?, signed_at = ?, signature = ?, chain = ?, updated_at = ? WHERE id = ?")
        .run(outcome, notes, ctx.user.id, payload.ts, JSON.stringify(sig), JSON.stringify(chain), now(), row.id);
      audit({ actor: ctx.user.id, action: outcome === "approved" ? "approval.sign" : "approval.reject", subject: row.id, detail: { via: "graphql" } });
      return db.prepare("SELECT * FROM approvals WHERE id = ?").get(row.id);
    },

    ingestEvent: (_, { input }, ctx) => {
      // Either an authenticated user with integration.read OR a system token
      // can ingest. Here we just require auth.
      requireCap(ctx, "integration.read");
      const env = ingest({
        event_type: input.eventType,
        severity: input.severity,
        asset_ref: input.assetRef,
        project_ref: input.projectRef,
        payload: input.payload,
        dedupe_key: input.dedupeKey,
      }, { source: input.source || "graphql", source_type: input.sourceType || "graphql" });
      if (!env) throw new GraphQLError("duplicate (deduped)", { extensions: { http: { status: 409 } } });
      return rowToEvent(env);
    },
  },

  // ---- Field resolvers (server-side joins) ----
  TeamSpace: {
    members: (ts) => db.prepare(`SELECT u.* FROM users u JOIN team_space_members m ON m.user_id = u.id WHERE m.team_space_id = ?`).all(ts.id),
    channels: (ts) => db.prepare("SELECT * FROM channels WHERE team_space_id = ?").all(ts.id),
    projects: (ts) => db.prepare("SELECT * FROM projects WHERE team_space_id = ?").all(ts.id),
    documents: (ts) => db.prepare("SELECT * FROM documents WHERE team_space_id = ?").all(ts.id),
  },

  Project: {
    teamSpace: (p) => db.prepare("SELECT * FROM team_spaces WHERE id = ?").get(p.team_space_id),
    workItems: (p) => db.prepare("SELECT * FROM work_items WHERE project_id = ? ORDER BY created_at DESC").all(p.id),
  },

  Channel: {
    teamSpace: (c) => db.prepare("SELECT * FROM team_spaces WHERE id = ?").get(c.team_space_id),
    messages: (c, { limit = 100 }) => db.prepare("SELECT * FROM messages WHERE channel_id = ? AND deleted = 0 ORDER BY ts DESC LIMIT ?").all(c.id, limit).reverse(),
  },

  Message: {
    author: (m) => db.prepare("SELECT id, name, email, role, initials FROM users WHERE id = ?").get(m.author_id),
    channelId: (m) => m.channel_id,
    authorId: (m) => m.author_id,
    edits: (m) => json(m.edits),
  },

  Document: {
    currentRevision: (d) => d.current_revision_id ? db.prepare("SELECT * FROM revisions WHERE id = ?").get(d.current_revision_id) : null,
    revisions: (d) => db.prepare("SELECT * FROM revisions WHERE doc_id = ? ORDER BY created_at").all(d.id),
    drawings: (d) => db.prepare("SELECT * FROM drawings WHERE doc_id = ?").all(d.id),
    teamSpace: (d) => db.prepare("SELECT * FROM team_spaces WHERE id = ?").get(d.team_space_id),
    project: (d) => d.project_id ? db.prepare("SELECT * FROM projects WHERE id = ?").get(d.project_id) : null,
  },

  Revision: {
    docId: (r) => r.doc_id,
    pdfUrl: (r) => r.pdf_url,
    createdAt: (r) => r.created_at,
    document: (r) => db.prepare("SELECT * FROM documents WHERE id = ?").get(r.doc_id),
    approvals: (r) => db.prepare("SELECT * FROM approvals WHERE subject_kind = 'Revision' AND subject_id = ?").all(r.id),
    reviewCycles: (r) => db.prepare("SELECT * FROM review_cycles WHERE doc_id = ? AND rev_id = ?").all(r.doc_id, r.id).map(rc => ({ ...rc, docId: rc.doc_id, revId: rc.rev_id, dueTs: rc.due_ts, closedAt: rc.closed_at, createdAt: rc.created_at, reviewers: json(rc.reviewers) })),
  },

  Drawing: {
    sheets: (dr) => json(dr.sheets),
    document: (dr) => dr.doc_id ? db.prepare("SELECT * FROM documents WHERE id = ?").get(dr.doc_id) : null,
    markups: (dr) => db.prepare("SELECT * FROM markups WHERE drawing_id = ? ORDER BY created_at").all(dr.id).map(m => ({ ...m, drawingId: m.drawing_id, sheetId: m.sheet_id, createdAt: m.created_at })),
    modelPins: (dr) => db.prepare("SELECT * FROM model_pins WHERE drawing_id = ?").all(dr.id).map(m => ({ ...m, drawingId: m.drawing_id, elementId: m.element_id, createdAt: m.created_at })),
  },

  Asset: {
    mqttTopics: (a) => json(a.mqtt_topics),
    opcuaNodes: (a) => json(a.opcua_nodes),
    docs: (a) => {
      const ids = json(a.doc_ids);
      if (!ids.length) return [];
      const placeholders = ids.map(() => "?").join(",");
      return db.prepare(`SELECT * FROM documents WHERE id IN (${placeholders})`).all(...ids);
    },
    incidents: (a) => db.prepare("SELECT * FROM incidents WHERE asset_id = ?").all(a.id),
  },

  WorkItem: {
    project: (w) => db.prepare("SELECT * FROM projects WHERE id = ?").get(w.project_id),
    assignee: (w) => w.assignee_id ? db.prepare("SELECT id, name, email, role, initials FROM users WHERE id = ?").get(w.assignee_id) : null,
    blockers: (w) => json(w.blockers),
    labels: (w) => json(w.labels),
  },

  Incident: {
    asset: (i) => i.asset_id ? db.prepare("SELECT * FROM assets WHERE id = ?").get(i.asset_id) : null,
    channel: (i) => i.channel_id ? db.prepare("SELECT * FROM channels WHERE id = ?").get(i.channel_id) : null,
    commander: (i) => i.commander_id ? db.prepare("SELECT id, name, email, role, initials FROM users WHERE id = ?").get(i.commander_id) : null,
    timeline: (i) => json(i.timeline),
    startedAt: (i) => i.started_at,
    resolvedAt: (i) => i.resolved_at,
  },

  Approval: {
    subjectKind: (a) => a.subject_kind,
    subjectId: (a) => a.subject_id,
    approvers: (a) => json(a.approvers),
    chain: (a) => json(a.chain),
    dueTs: (a) => a.due_ts,
    signedBy: (a) => a.signed_by,
    signedAt: (a) => a.signed_at,
  },

  AuditEvent: {
    detail: (e) => obj(e.detail),
    traceId: (e) => e.trace_id,
    prevHash: (e) => e.prev_hash,
  },

  Event: {
    eventId: (e) => e.event_id || e.id,
    receivedAt: (e) => e.received_at,
    sourceType: (e) => e.source_type,
    assetRef: (e) => e.asset_ref,
    projectRef: (e) => e.project_ref,
    eventType: (e) => e.event_type,
    payload: (e) => obj(e.payload),
    traceId: (e) => e.trace_id,
    dedupeKey: (e) => e.dedupe_key,
  },
};

// ---------- search shim shared with REST ----------
function searchHits({ q, kind, from, to, revision }) {
  const esc = String(q || "").replace(/"/g, '""');
  const docs = db.prepare("SELECT id, kind, title, body FROM fts_docs WHERE fts_docs MATCH ? ORDER BY rank LIMIT 25").all(`"${esc}"*`);
  const msgs = db.prepare("SELECT id, channel_id, text FROM fts_messages WHERE fts_messages MATCH ? ORDER BY rank LIMIT 25").all(`"${esc}"*`);
  const wis  = db.prepare("SELECT id, project_id, title, description FROM fts_workitems WHERE fts_workitems MATCH ? ORDER BY rank LIMIT 25").all(`"${esc}"*`);
  const ast  = db.prepare("SELECT id, name, hierarchy FROM fts_assets WHERE fts_assets MATCH ? ORDER BY rank LIMIT 25").all(`"${esc}"*`);
  const all = [
    ...docs.map(r => {
      if (r.kind === "Revision") {
        const rev = db.prepare("SELECT label, status, created_at, doc_id FROM revisions WHERE id = ?").get(r.id);
        return { kind: "Revision", id: r.id, title: r.title, snippet: r.body?.slice(0, 160), revision: rev?.label, route: rev ? `/doc/${rev.doc_id}` : null, date: rev?.created_at };
      }
      if (r.kind === "Document") {
        const d = db.prepare("SELECT created_at FROM documents WHERE id = ?").get(r.id);
        return { kind: "Document", id: r.id, title: r.title, snippet: r.body?.slice(0, 160), date: d?.created_at };
      }
      return { kind: r.kind || "Document", id: r.id, title: r.title, snippet: r.body?.slice(0, 160) };
    }),
    ...msgs.map(r => {
      const m = db.prepare("SELECT ts FROM messages WHERE id = ?").get(r.id);
      return { kind: "Message", id: r.id, title: r.text?.slice(0, 80), route: `/channel/${r.channel_id}`, date: m?.ts };
    }),
    ...wis.map(r => {
      const w = db.prepare("SELECT created_at FROM work_items WHERE id = ?").get(r.id);
      return { kind: "WorkItem", id: r.id, title: r.title, snippet: r.description, route: `/work-board/${r.project_id}`, date: w?.created_at };
    }),
    ...ast.map(r => {
      const a = db.prepare("SELECT created_at FROM assets WHERE id = ?").get(r.id);
      return { kind: "Asset", id: r.id, title: r.name, snippet: r.hierarchy, route: `/asset/${r.id}`, date: a?.created_at };
    }),
  ];
  const filtered = all.filter(h => {
    if (kind?.length && !kind.includes(h.kind)) return false;
    if (revision?.length && !(h.revision && revision.includes(h.revision))) return false;
    if (from && h.date && h.date < from) return false;
    if (to && h.date && h.date > to) return false;
    return true;
  });
  const facets = { kind: {}, date: {}, revision: {} };
  for (const h of all) {
    facets.kind[h.kind] = (facets.kind[h.kind] || 0) + 1;
    if (h.date) { const d = h.date.slice(0, 10); facets.date[d] = (facets.date[d] || 0) + 1; }
    if (h.revision) facets.revision[h.revision] = (facets.revision[h.revision] || 0) + 1;
  }
  return { hits: filtered, facets };
}

function rowToEvent(env) {
  return {
    event_id: env.event_id, received_at: env.received_at, source: env.source, source_type: env.source_type,
    asset_ref: env.asset_ref, project_ref: env.project_ref, severity: env.severity, event_type: env.event_type,
    payload: env.payload, trace_id: env.trace_id, dedupe_key: env.dedupe_key,
  };
}
