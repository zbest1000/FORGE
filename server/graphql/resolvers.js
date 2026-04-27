// Resolvers backed by the same SQLite schema the REST routes use. Only
// reads are unauthenticated-friendly; mutations require an authenticated
// user with the right capability (matches /api semantics).

import { db, now, uuid, jsonOrDefault } from "../db.js";
import { audit, drain } from "../audit.js";
import { can } from "../auth.js";
import { signHMAC, canonicalJSON } from "../crypto.js";
import { ingest } from "../events.js";
import { readSeries } from "../metrics-rollup.js";
import {
  archiveRecipeEvent,
  listHistorianBackends,
  readHistorianSamples,
  writeHistorianSample,
} from "../historians/index.js";
import { canTransitionRevision, cascadeOnApprove } from "../../src/core/fsm/revision.js";
import { canTransitionApproval } from "../../src/core/fsm/approval.js";
import { GraphQLError, GraphQLScalarType, Kind } from "graphql";
import { allows, filterAllowed } from "../acl.js";
import { tenantWhere, orgForRow } from "../tenant.js";
import { sanitizeFtsTerm } from "../security/fts.js";

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

function requireAcl(ctx, row, capability = "view") {
  const u = requireCap(ctx, capability);
  if (!row) return null;
  if (!allows(u, row.acl, capability)) throw forbiddenError(`${capability}:object`);
  return row;
}

/** Returns the requester's org id, or throws an UNAUTHENTICATED error. */
function tenantOrgIdCtx(ctx) {
  const u = requireUser(ctx);
  if (!u.org_id) throw forbiddenError("tenant:missing");
  return u.org_id;
}

/**
 * Filter a list of rows to those (a) in the requester's tenant and (b)
 * permitted by ACL. The companion to `aclList` for tables that carry an
 * `org_id` either directly or via a known join.
 */
function tenantAclList(ctx, rows, table, capability = "view") {
  const u = requireCap(ctx, capability);
  const orgId = tenantOrgIdCtx(ctx);
  return filterAllowed(rows.filter(r => orgForRow(table, r) === orgId), u, capability);
}

/**
 * Treat a single-row lookup as 'not found' when the row belongs to a
 * different tenant. Avoids leaking row existence across orgs.
 */
function tenantAcl(ctx, row, table, capability = "view") {
  const u = requireCap(ctx, capability);
  if (!row) return null;
  const orgId = tenantOrgIdCtx(ctx);
  if (orgForRow(table, row) !== orgId) return null;
  if (!allows(u, row.acl, capability)) throw forbiddenError(`${capability}:object`);
  return row;
}

function aclList(ctx, rows, capability = "view") {
  const u = requireCap(ctx, capability);
  return filterAllowed(rows, u, capability);
}

function docForRevision(id) {
  return db.prepare("SELECT d.* FROM documents d JOIN revisions r ON r.doc_id = d.id WHERE r.id = ?").get(id);
}

function subjectAclRow(approval) {
  if (!approval) return null;
  if (approval.subject_kind === "Revision") return docForRevision(approval.subject_id);
  if (approval.subject_kind === "Document") return db.prepare("SELECT * FROM documents WHERE id = ?").get(approval.subject_id);
  if (approval.subject_kind === "WorkItem") return db.prepare("SELECT * FROM work_items WHERE id = ?").get(approval.subject_id);
  if (approval.subject_kind === "Incident") return db.prepare("SELECT * FROM incidents WHERE id = ?").get(approval.subject_id);
  return approval;
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
    organization: (_, __, ctx) => {
      const orgId = tenantOrgIdCtx(ctx);
      return db.prepare("SELECT id, name, tenant_key AS tenantKey FROM organizations WHERE id = ?").get(orgId);
    },
    workspaces: (_, __, ctx) => {
      const orgId = tenantOrgIdCtx(ctx);
      return db.prepare("SELECT id, name, region FROM workspaces WHERE org_id = ?").all(orgId);
    },
    teamSpaces: (_, __, ctx) => {
      const orgId = tenantOrgIdCtx(ctx);
      return aclList(ctx, db.prepare("SELECT * FROM team_spaces WHERE org_id = ?").all(orgId));
    },
    teamSpace: (_, { id }, ctx) => tenantAcl(ctx, db.prepare("SELECT * FROM team_spaces WHERE id = ?").get(id), "team_spaces"),
    projects: (_, { teamSpaceId }, ctx) => {
      const orgId = tenantOrgIdCtx(ctx);
      const rows = teamSpaceId
        ? db.prepare("SELECT * FROM projects WHERE team_space_id = ?").all(teamSpaceId)
        : db.prepare("SELECT * FROM projects").all();
      return tenantAclList(ctx, rows, "projects");
    },
    project: (_, { id }, ctx) => tenantAcl(ctx, db.prepare("SELECT * FROM projects WHERE id = ?").get(id), "projects"),
    channels: (_, { teamSpaceId }, ctx) => {
      const rows = teamSpaceId
        ? db.prepare("SELECT * FROM channels WHERE team_space_id = ?").all(teamSpaceId)
        : db.prepare("SELECT * FROM channels").all();
      return tenantAclList(ctx, rows, "channels");
    },
    channel: (_, { id }, ctx) => tenantAcl(ctx, db.prepare("SELECT * FROM channels WHERE id = ?").get(id), "channels"),
    documents: (_, __, ctx) => tenantAclList(ctx, db.prepare("SELECT * FROM documents").all(), "documents"),
    document: (_, { id }, ctx) => tenantAcl(ctx, db.prepare("SELECT * FROM documents WHERE id = ?").get(id), "documents"),
    revision: (_, { id }, ctx) => {
      const rev = db.prepare("SELECT * FROM revisions WHERE id = ?").get(id);
      if (!rev) return null;
      const doc = docForRevision(id);
      if (!tenantAcl(ctx, doc, "documents")) return null;
      return rev;
    },
    drawings: (_, __, ctx) => tenantAclList(ctx, db.prepare("SELECT * FROM drawings").all(), "drawings"),
    drawing: (_, { id }, ctx) => tenantAcl(ctx, db.prepare("SELECT * FROM drawings WHERE id = ?").get(id), "drawings"),
    assets: (_, __, ctx) => tenantAclList(ctx, db.prepare("SELECT * FROM assets").all(), "assets"),
    asset: (_, { id }, ctx) => tenantAcl(ctx, db.prepare("SELECT * FROM assets WHERE id = ?").get(id), "assets"),
    workItems: (_, { projectId }, ctx) => {
      const rows = projectId
        ? db.prepare("SELECT * FROM work_items WHERE project_id = ? ORDER BY created_at DESC").all(projectId)
        : db.prepare("SELECT * FROM work_items ORDER BY created_at DESC").all();
      return tenantAclList(ctx, rows, "work_items");
    },
    workItem: (_, { id }, ctx) => tenantAcl(ctx, db.prepare("SELECT * FROM work_items WHERE id = ?").get(id), "work_items"),
    incidents: (_, __, ctx) => tenantAclList(ctx, db.prepare("SELECT * FROM incidents ORDER BY started_at DESC").all(), "incidents"),
    incident: (_, { id }, ctx) => tenantAcl(ctx, db.prepare("SELECT * FROM incidents WHERE id = ?").get(id), "incidents"),
    approvals: (_, { status }, ctx) => {
      const u = requireCap(ctx, "view");
      const orgId = tenantOrgIdCtx(ctx);
      const rows = status
        ? db.prepare("SELECT * FROM approvals WHERE status = ?").all(status)
        : db.prepare("SELECT * FROM approvals").all();
      return rows.filter(a => {
        const subject = subjectAclRow(a);
        if (!subject) return false;
        const subjectTable = ({ Revision: "documents", Document: "documents", WorkItem: "work_items", Incident: "incidents" })[a.subject_kind];
        if (subjectTable && orgForRow(subjectTable, subject) !== orgId) return false;
        return allows(u, subject.acl, "view");
      });
    },
    approval: (_, { id }, ctx) => {
      const row = db.prepare("SELECT * FROM approvals WHERE id = ?").get(id);
      if (!row) return null;
      const subject = subjectAclRow(row);
      const subjectTable = ({ Revision: "documents", Document: "documents", WorkItem: "work_items", Incident: "incidents" })[row.subject_kind];
      if (subjectTable && !tenantAcl(ctx, subject, subjectTable)) return null;
      return row;
    },

    audit: (_, { limit = 100 }, ctx) => {
      requireCap(ctx, "view");
      return db.prepare("SELECT * FROM audit_log ORDER BY seq DESC LIMIT ?").all(Math.min(500, limit));
    },
    events: (_, { limit = 50 }, ctx) => {
      requireCap(ctx, "integration.read");
      return db.prepare("SELECT * FROM events ORDER BY received_at DESC LIMIT ?").all(Math.min(500, limit));
    },

    search: (_, args, ctx) => {
      requireCap(ctx, "view");
      return searchHits(args, ctx.user);
    },

    metricsSeries: (_, { metric, days = 14 }) => readSeries(metric, Math.min(60, days)).map(p => ({ day: p.day, value: p.value })),

    // ---------- Operations queries (v15) ----------
    historianBackends: (_, __, ctx) => {
      requireCap(ctx, "view");
      return listHistorianBackends();
    },
    historianPoints: (_, { assetId }, ctx) => {
      requireCap(ctx, "view");
      const rows = assetId
        ? db.prepare("SELECT * FROM historian_points WHERE asset_id = ? ORDER BY tag").all(assetId)
        : db.prepare("SELECT * FROM historian_points ORDER BY tag").all();
      return rows;
    },
    historianPoint: (_, { id, tag }, ctx) => {
      requireCap(ctx, "view");
      if (id) return db.prepare("SELECT * FROM historian_points WHERE id = ?").get(id) || null;
      if (tag) return db.prepare("SELECT * FROM historian_points WHERE tag = ?").get(tag) || null;
      return null;
    },
    historianSamples: async (_, { pointId, tag, from, to, limit = 200 }, ctx) => {
      requireCap(ctx, "view");
      const point = pointId
        ? db.prepare("SELECT * FROM historian_points WHERE id = ?").get(pointId)
        : tag ? db.prepare("SELECT * FROM historian_points WHERE tag = ?").get(tag) : null;
      if (!point) throw new GraphQLError("point not found", { extensions: { http: { status: 404 } } });
      const result = await readHistorianSamples(point, { from, to, limit: Math.min(2000, Number(limit) || 200) });
      return Array.isArray(result?.samples) ? result.samples : [];
    },
    recipes: (_, { assetId }, ctx) => {
      requireCap(ctx, "view");
      return assetId
        ? db.prepare("SELECT * FROM recipes WHERE asset_id = ? ORDER BY name").all(assetId)
        : db.prepare("SELECT * FROM recipes ORDER BY name").all();
    },
    recipe: (_, { id }, ctx) => {
      requireCap(ctx, "view");
      return db.prepare("SELECT * FROM recipes WHERE id = ?").get(id) || null;
    },
    modbusDevices: (_, __, ctx) => {
      requireCap(ctx, "view");
      return db.prepare("SELECT * FROM modbus_devices ORDER BY name").all();
    },
    modbusDevice: (_, { id }, ctx) => {
      requireCap(ctx, "view");
      return db.prepare("SELECT * FROM modbus_devices WHERE id = ?").get(id) || null;
    },
    modbusRegisters: (_, { deviceId }, ctx) => {
      requireCap(ctx, "view");
      return deviceId
        ? db.prepare("SELECT * FROM modbus_registers WHERE device_id = ? ORDER BY address").all(deviceId)
        : db.prepare("SELECT * FROM modbus_registers ORDER BY address").all();
    },
  },

  Mutation: {
    createWorkItem: (_, { projectId, type, title, severity = "medium", assigneeId = null, due = null }, ctx) => {
      requireCap(ctx, "create");
      const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId);
      if (!tenantAcl(ctx, project, "projects", "create")) throw forbiddenError("create:object");
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
      if (!tenantAcl(ctx, row, "work_items", "edit")) throw new GraphQLError("not found", { extensions: { http: { status: 404 } } });
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
      if (!tenantAcl(ctx, ch, "channels", "create")) throw new GraphQLError("channel not found", { extensions: { http: { status: 404 } } });
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
      const doc = docForRevision(id);
      if (!tenantAcl(ctx, doc, "documents", "approve")) throw new GraphQLError("not found", { extensions: { http: { status: 404 } } });
      if (!canTransitionRevision(rev.status, to))
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
      const subject = subjectAclRow(row);
      const subjectTable = ({ Revision: "documents", Document: "documents", WorkItem: "work_items", Incident: "incidents" })[row.subject_kind];
      if (subjectTable && !tenantAcl(ctx, subject, subjectTable, "approve")) throw new GraphQLError("not found", { extensions: { http: { status: 404 } } });
      if (!canTransitionApproval(row.status, outcome))
        throw new GraphQLError(`cannot decide approval in status '${row.status}'`, { extensions: { http: { status: 400 } } });
      const payload = { approvalId: row.id, subject: { kind: row.subject_kind, id: row.subject_id }, outcome, notes, signer: ctx.user.id, ts: now() };
      // Per-tenant key history: bind signature to the requester's org.
      const sig = await signHMAC(canonicalJSON(payload), { orgId: ctx.user.org_id || null });
      const chain = JSON.parse(row.chain || "[]");
      chain.push({ ts: payload.ts, action: outcome, actor: ctx.user.id, signature: sig.signature, keyId: sig.keyId });
      db.prepare("UPDATE approvals SET status = ?, reason = ?, signed_by = ?, signed_at = ?, signature = ?, chain = ?, updated_at = ? WHERE id = ?")
        .run(outcome, notes, ctx.user.id, payload.ts, JSON.stringify(sig), JSON.stringify(chain), now(), row.id);
      audit({ actor: ctx.user.id, action: outcome === "approved" ? "approval.sign" : "approval.reject", subject: row.id, detail: { via: "graphql" } });
      return db.prepare("SELECT * FROM approvals WHERE id = ?").get(row.id);
    },

    ingestEvent: (_, { input }, ctx) => {
      // Event ingest is a write operation: the resulting event drops
      // into the rule engine, fans out to webhooks, and may trigger
      // alerts. `integration.read` was a misclassification; we now
      // require `integration.write`.
      requireCap(ctx, "integration.write");
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

    // ---------- Operations mutations (v15) ----------
    createHistorianPoint: (_, { input }, ctx) => {
      requireCap(ctx, "integration.write");
      const asset = db.prepare("SELECT id FROM assets WHERE id = ?").get(input.assetId);
      if (!asset) throw new GraphQLError("asset not found", { extensions: { http: { status: 404 } } });
      const id = uuid("PT");
      const ts = now();
      db.prepare(`INSERT INTO historian_points
                  (id, asset_id, source_id, tag, name, unit, data_type, historian, retention_policy_id, created_at, updated_at)
                  VALUES (@id, @asset, @source, @tag, @name, @unit, @dtype, @hist, @rp, @ts, @ts)`)
        .run({
          id,
          asset: input.assetId,
          source: input.sourceId || null,
          tag: input.tag,
          name: input.name,
          unit: input.unit || null,
          dtype: input.dataType || "number",
          hist: input.historian || "sqlite",
          rp: input.retentionPolicyId || null,
          ts,
        });
      audit({ actor: ctx.user.id, action: "historian.point.create", subject: id, detail: { tag: input.tag, via: "graphql" } });
      return db.prepare("SELECT * FROM historian_points WHERE id = ?").get(id);
    },

    writeHistorianSample: async (_, { input }, ctx) => {
      requireCap(ctx, "integration.write");
      const point = input.pointId
        ? db.prepare("SELECT * FROM historian_points WHERE id = ?").get(input.pointId)
        : input.tag ? db.prepare("SELECT * FROM historian_points WHERE tag = ?").get(input.tag) : null;
      if (!point) throw new GraphQLError("point not found", { extensions: { http: { status: 404 } } });
      const sample = {
        id: uuid("SM"),
        point_id: point.id,
        ts: input.ts || now(),
        value: Number(input.value),
        quality: input.quality || "Good",
        source_type: input.sourceType || "graphql",
        raw_payload: "{}",
      };
      await writeHistorianSample(point, sample);
      audit({ actor: ctx.user.id, action: "historian.sample.write", subject: point.id, detail: { ts: sample.ts, via: "graphql" } });
      return sample;
    },

    createRecipe: async (_, { input }, ctx) => {
      requireCap(ctx, "edit");
      const id = uuid("RC");
      const ts = now();
      db.prepare(`INSERT INTO recipes (id, asset_id, name, status, created_by, created_at, updated_at)
                  VALUES (@id, @asset, @name, 'draft', @by, @ts, @ts)`)
        .run({ id, asset: input.assetId || null, name: input.name, by: ctx.user.id, ts });
      // Initial version 1 with the supplied parameters/notes.
      const versionId = uuid("RV");
      db.prepare(`INSERT INTO recipe_versions (id, recipe_id, version, state, parameters, notes, created_by, created_at)
                  VALUES (@id, @recipe, 1, 'draft', @params, @notes, @by, @ts)`)
        .run({
          id: versionId,
          recipe: id,
          params: JSON.stringify(input.parameters || {}),
          notes: input.notes || null,
          by: ctx.user.id,
          ts,
        });
      db.prepare("UPDATE recipes SET current_version_id = ? WHERE id = ?").run(versionId, id);
      audit({ actor: ctx.user.id, action: "recipe.create", subject: id, detail: { name: input.name, via: "graphql" } });
      const created = db.prepare("SELECT * FROM recipes WHERE id = ?").get(id);
      await archiveRecipeEvent("recipe.create", created).catch((err) =>
        console.warn("recipe.create archive failed", String(err?.message || err)),
      );
      return created;
    },

    activateRecipeVersion: async (_, { versionId }, ctx) => {
      requireCap(ctx, "approve");
      const version = db.prepare("SELECT * FROM recipe_versions WHERE id = ?").get(versionId);
      if (!version) throw new GraphQLError("version not found", { extensions: { http: { status: 404 } } });
      const recipe = db.prepare("SELECT * FROM recipes WHERE id = ?").get(version.recipe_id);
      if (!recipe) throw new GraphQLError("recipe not found", { extensions: { http: { status: 404 } } });
      const ts = now();
      db.transaction(() => {
        db.prepare("UPDATE recipe_versions SET state = 'approved', approved_by = ?, approved_at = ? WHERE id = ?")
          .run(ctx.user.id, ts, versionId);
        db.prepare("UPDATE recipes SET status = 'active', current_version_id = ?, updated_at = ? WHERE id = ?")
          .run(versionId, ts, recipe.id);
      })();
      audit({ actor: ctx.user.id, action: "recipe.activate", subject: recipe.id, detail: { versionId, via: "graphql" } });
      const updated = db.prepare("SELECT * FROM recipes WHERE id = ?").get(recipe.id);
      await archiveRecipeEvent("recipe.activate", updated, db.prepare("SELECT * FROM recipe_versions WHERE id = ?").get(versionId))
        .catch((err) => console.warn("recipe.activate archive failed", String(err?.message || err)));
      return updated;
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

  // ---------- Operations field resolvers (v15) ----------
  HistorianPoint: {
    assetId: (p) => p.asset_id,
    sourceId: (p) => p.source_id,
    dataType: (p) => p.data_type,
    retentionPolicyId: (p) => p.retention_policy_id,
    createdAt: (p) => p.created_at,
    updatedAt: (p) => p.updated_at,
    asset: (p) => p.asset_id ? db.prepare("SELECT * FROM assets WHERE id = ?").get(p.asset_id) : null,
    samples: (p, { limit = 50 }) =>
      db.prepare("SELECT * FROM historian_samples WHERE point_id = ? ORDER BY ts DESC LIMIT ?").all(p.id, Math.min(500, Number(limit) || 50)),
  },

  HistorianSample: {
    pointId: (s) => s.point_id,
    sourceType: (s) => s.source_type,
    rawPayload: (s) => obj(s.raw_payload),
  },

  Recipe: {
    assetId: (r) => r.asset_id,
    currentVersionId: (r) => r.current_version_id,
    createdBy: (r) => r.created_by,
    createdAt: (r) => r.created_at,
    updatedAt: (r) => r.updated_at,
    asset: (r) => r.asset_id ? db.prepare("SELECT * FROM assets WHERE id = ?").get(r.asset_id) : null,
    versions: (r) => db.prepare("SELECT * FROM recipe_versions WHERE recipe_id = ? ORDER BY version DESC").all(r.id),
    currentVersion: (r) => r.current_version_id
      ? db.prepare("SELECT * FROM recipe_versions WHERE id = ?").get(r.current_version_id) || null
      : null,
  },

  RecipeVersion: {
    recipeId: (v) => v.recipe_id,
    parameters: (v) => obj(v.parameters),
    approvedBy: (v) => v.approved_by,
    approvedAt: (v) => v.approved_at,
    createdBy: (v) => v.created_by,
    createdAt: (v) => v.created_at,
  },

  ModbusDevice: {
    integrationId: (d) => d.integration_id,
    unitId: (d) => d.unit_id,
    lastPollAt: (d) => d.last_poll_at,
    config: (d) => obj(d.config),
    createdAt: (d) => d.created_at,
    updatedAt: (d) => d.updated_at,
    registers: (d) => db.prepare("SELECT * FROM modbus_registers WHERE device_id = ? ORDER BY address").all(d.id),
  },

  ModbusRegister: {
    deviceId: (r) => r.device_id,
    assetId: (r) => r.asset_id,
    pointId: (r) => r.point_id,
    functionCode: (r) => r.function_code,
    dataType: (r) => r.data_type,
    scale: (r) => Number(r.scale),
    pollingMs: (r) => r.polling_ms,
    lastValue: (r) => r.last_value,
    lastQuality: (r) => r.last_quality,
    lastSeen: (r) => r.last_seen,
    device: (r) => db.prepare("SELECT * FROM modbus_devices WHERE id = ?").get(r.device_id),
  },
};

// ---------- search shim shared with REST ----------
function searchHits({ q, kind, from, to, revision }) {
  const phrase = sanitizeFtsTerm(q);
  if (!phrase) return { hits: [], facets: { kind: {}, date: {}, revision: {} } };
  const docs = db.prepare("SELECT id, kind, title, body FROM fts_docs WHERE fts_docs MATCH ? ORDER BY rank LIMIT 25").all(phrase);
  const msgs = db.prepare("SELECT id, channel_id, text FROM fts_messages WHERE fts_messages MATCH ? ORDER BY rank LIMIT 25").all(phrase);
  const wis  = db.prepare("SELECT id, project_id, title, description FROM fts_workitems WHERE fts_workitems MATCH ? ORDER BY rank LIMIT 25").all(phrase);
  const ast  = db.prepare("SELECT id, name, hierarchy FROM fts_assets WHERE fts_assets MATCH ? ORDER BY rank LIMIT 25").all(phrase);
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
