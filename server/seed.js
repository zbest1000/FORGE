// Seed demo data into SQLite. Safe to run multiple times — uses INSERT OR
// IGNORE on primary keys.
//
// ACL hand-wave
// -------------
// The demo seed leaves every row with `acl: '{}'` because the demo is
// single-tenant + permissive by default. With
// `FORGE_ACL_DENY_BY_DEFAULT=1` (auto-on in production strict mode),
// `parseAcl` now treats an empty / missing ACL as deny-by-default, so
// every row would become invisible to non-owner roles.
//
// Use `PUBLIC_ACL` for rows that are intentionally world-readable
// inside the demo tenant (the headline channels, the demo team
// spaces, the seeded asset hierarchy). Production data added via the
// real APIs continues to ship explicit ACLs from the route handlers.

import { db, now, uuid } from "./db.js";
import { ensureUser } from "./auth.js";
import { audit } from "./audit.js";
import { buildSeed } from "../src/data/seed.js";

const PUBLIC_ACL = JSON.stringify({ roles: ["*"], users: [], abac: {} });

const orgId = "ORG-1";
const wsId = "WS-1";

db.prepare("INSERT OR IGNORE INTO organizations (id, name, tenant_key, created_at) VALUES (?, ?, ?, ?)")
  .run(orgId, "Atlas Industrial Systems", "atlas", now());
db.prepare("INSERT OR IGNORE INTO workspaces (id, org_id, name, region, created_at) VALUES (?, ?, ?, ?, ?)")
  .run(wsId, orgId, "North Plant", "us-east", now());

// Users — admin + all demo personas. Password for all demo accounts: `forge`.
const people = [
  { id: "U-1", email: "j.singh@forge.local",    name: "J. Singh",   role: "Engineer/Contributor", initials: "JS" },
  { id: "U-2", email: "r.okafor@forge.local",   name: "R. Okafor",  role: "Reviewer/Approver",    initials: "RO" },
  { id: "U-3", email: "m.torres@forge.local",   name: "M. Torres",  role: "Operator/Technician",  initials: "MT" },
  { id: "U-4", email: "d.chen@forge.local",     name: "D. Chen",    role: "Workspace Admin",      initials: "DC" },
  { id: "U-5", email: "l.abidemi@forge.local",  name: "L. Abidemi", role: "Integration Admin",    initials: "LA" },
  { id: "U-6", email: "a.patel@forge.local",    name: "A. Patel",   role: "Team Space Admin",     initials: "AP" },
  { id: "U-ADMIN", email: "admin@forge.local",  name: "Admin",      role: "Organization Owner",   initials: "AD" },
];

// Directly insert so we can pick the ID.
for (const u of people) {
  const existing = db.prepare("SELECT id FROM users WHERE id = ? OR email = ?").get(u.id, u.email);
  if (existing) continue;
  const bcrypt = (await import("bcryptjs")).default;
  const hash = await bcrypt.hash("forge", 10);
  db.prepare(`INSERT INTO users (id, org_id, email, name, role, password_hash, initials, disabled, created_at, updated_at)
              VALUES (@id, @org, @email, @name, @role, @hash, @initials, 0, @now, @now)`)
    .run({ id: u.id, org: orgId, email: u.email, name: u.name, role: u.role, hash, initials: u.initials, now: now() });
}

// Import domain objects from the client seed factory.
const data = buildSeed();

function insertMany(sql, rows, map) {
  const stmt = db.prepare(sql);
  for (const row of rows) { try { stmt.run(map(row)); } catch (err) { /* ignore dup */ } }
}

insertMany(
  `INSERT OR IGNORE INTO team_spaces (id, org_id, workspace_id, name, summary, status, acl, labels, created_at, updated_at)
   VALUES (@id, @org, @ws, @name, @summary, 'active', @acl, '[]', @now, @now)`,
  data.teamSpaces, t => ({ id: t.id, org: orgId, ws: wsId, name: t.name, summary: t.summary, acl: PUBLIC_ACL, now: now() })
);

insertMany(
  `INSERT OR IGNORE INTO projects (id, team_space_id, name, status, due_date, milestones, acl, labels, created_at, updated_at)
   VALUES (@id, @ts, @name, @status, @due, @milestones, @acl, '[]', @now, @now)`,
  data.projects, p => ({ id: p.id, ts: p.teamSpaceId, name: p.name, status: p.status, due: p.dueDate || null, milestones: JSON.stringify(p.milestones || []), acl: PUBLIC_ACL, now: now() })
);

insertMany(
  `INSERT OR IGNORE INTO channels (id, team_space_id, name, kind, unread, acl, created_at, updated_at)
   VALUES (@id, @ts, @name, @kind, @unread, @acl, @now, @now)`,
  data.channels, c => ({ id: c.id, ts: c.teamSpaceId, name: c.name, kind: c.kind, unread: c.unread || 0, acl: PUBLIC_ACL, now: now() })
);

insertMany(
  `INSERT OR IGNORE INTO messages (id, channel_id, author_id, ts, type, text, attachments, edits, deleted)
   VALUES (@id, @ch, @author, @ts, @type, @text, @att, '[]', 0)`,
  data.messages, m => ({ id: m.id, ch: m.channelId, author: m.authorId, ts: m.ts, type: m.type, text: m.text, att: JSON.stringify(m.attachments || []) })
);

insertMany(
  `INSERT OR IGNORE INTO documents (id, team_space_id, project_id, name, kind, discipline, current_revision_id, sensitivity, acl, labels, created_at, updated_at)
   VALUES (@id, @ts, @pr, @name, @kind, @disc, @cur, @sens, @acl, '[]', @now, @now)`,
  data.documents, d => ({ id: d.id, ts: d.teamSpaceId, pr: d.projectId || null, name: d.name, kind: d.kind || null, disc: d.discipline || null, cur: d.currentRevisionId || null, sens: d.sensitivity || null, acl: PUBLIC_ACL, now: now() })
);

insertMany(
  `INSERT OR IGNORE INTO revisions (id, doc_id, label, status, author_id, approver_id, summary, notes, pdf_url, effective_date, created_at, updated_at)
   VALUES (@id, @doc, @label, @status, @author, NULL, @summary, @notes, NULL, NULL, @created, @created)`,
  data.revisions, r => ({ id: r.id, doc: r.docId, label: r.label, status: r.status, author: r.authorId || null, summary: r.summary || null, notes: r.notes || null, created: r.createdAt })
);

insertMany(
  `INSERT OR IGNORE INTO drawings (id, doc_id, team_space_id, project_id, name, discipline, sheets, acl, labels, created_at, updated_at)
   VALUES (@id, @doc, @ts, @pr, @name, @disc, @sheets, @acl, '[]', @now, @now)`,
  data.drawings, d => ({ id: d.id, doc: d.docId, ts: d.teamSpaceId, pr: d.projectId, name: d.name, disc: d.discipline, sheets: JSON.stringify(d.sheets || []), acl: PUBLIC_ACL, now: now() })
);

insertMany(
  `INSERT OR IGNORE INTO markups (id, drawing_id, sheet_id, kind, x, y, text, author, seq, created_at)
   VALUES (@id, @dr, @sh, @kind, @x, @y, @text, @author, @seq, @now)`,
  data.markups, m => ({ id: m.id, dr: m.drawingId, sh: m.sheetId, kind: m.kind || "pin", x: m.x, y: m.y, text: m.text || null, author: m.author, seq: m.seq || null, now: now() })
);

insertMany(
  `INSERT OR IGNORE INTO assets (id, org_id, workspace_id, name, type, hierarchy, status, mqtt_topics, opcua_nodes, doc_ids, acl, labels, created_at, updated_at)
   VALUES (@id, @org, @ws, @name, @type, @h, @status, @mqtt, @opc, @docs, @acl, '[]', @now, @now)`,
  data.assets, a => ({ id: a.id, org: orgId, ws: wsId, name: a.name, type: a.type, h: a.hierarchy, status: a.status, mqtt: JSON.stringify(a.mqttTopics || []), opc: JSON.stringify(a.opcuaNodes || []), docs: JSON.stringify(a.docIds || []), acl: PUBLIC_ACL, now: now() })
);

insertMany(
  `INSERT OR IGNORE INTO work_items (id, project_id, type, title, assignee_id, status, severity, due, blockers, labels, acl, created_at, updated_at)
   VALUES (@id, @pr, @type, @title, @assignee, @status, @severity, @due, @blockers, '[]', @acl, @now, @now)`,
  data.workItems, w => ({ id: w.id, pr: w.projectId, type: w.type, title: w.title, assignee: w.assigneeId, status: w.status, severity: w.severity, due: w.due || null, blockers: JSON.stringify(w.blockers || []), acl: PUBLIC_ACL, now: now() })
);

insertMany(
  `INSERT OR IGNORE INTO incidents (id, org_id, workspace_id, title, severity, status, asset_id, commander_id, channel_id, timeline, checklist_state, roster, started_at, created_at, updated_at)
   VALUES (@id, @org, @ws, @title, @sev, @status, @asset, @cmd, @ch, @tl, '{}', '{}', @started, @now, @now)`,
  data.incidents, i => ({ id: i.id, org: orgId, ws: wsId, title: i.title, sev: i.severity, status: i.status, asset: i.assetId, cmd: i.commanderId, ch: i.channelId, tl: JSON.stringify(i.timeline || []), started: i.startedAt, now: now() })
);

insertMany(
  `INSERT OR IGNORE INTO approvals (id, subject_kind, subject_id, requester_id, approvers, status, due_ts, reason, chain, created_at, updated_at)
   VALUES (@id, @sk, @si, @req, @app, @status, @due, @reason, '[]', @now, @now)`,
  data.approvals, a => ({ id: a.id, sk: a.subject.kind, si: a.subject.id, req: a.requester, app: JSON.stringify(a.approvers || []), status: a.status, due: a.dueTs, reason: a.reasonIfDone || null, now: now() })
);

insertMany(
  `INSERT OR IGNORE INTO integrations (id, name, kind, status, last_event, events_per_min, config)
   VALUES (@id, @name, @kind, @status, @le, @epm, '{}')`,
  data.integrations, i => ({ id: i.id, name: i.name, kind: i.kind, status: i.status, le: i.lastEvent, epm: i.eventsPerMin })
);

insertMany(
  `INSERT OR IGNORE INTO data_sources (id, integration_id, endpoint, asset_id, kind, unit, sampling, qos, retain)
   VALUES (@id, @ii, @ep, @as, @kind, NULL, NULL, 1, 0)`,
  data.dataSources, d => ({ id: d.id, ii: d.integrationId, ep: d.endpoint, as: d.assetId, kind: d.kind })
);

// FTS indexing.
db.exec("DELETE FROM fts_docs;");
db.prepare(`INSERT INTO fts_docs (id, kind, title, body)
            SELECT id, 'Document', name, COALESCE(kind,'')||' '||COALESCE(discipline,'')||' '||COALESCE(sensitivity,'') FROM documents`).run();
db.prepare(`INSERT INTO fts_docs (id, kind, title, body)
            SELECT id, 'Revision', label||' '||status, COALESCE(summary,'')||' '||COALESCE(notes,'') FROM revisions`).run();
db.prepare(`INSERT INTO fts_docs (id, kind, title, body)
            SELECT id, 'Drawing', name, COALESCE(discipline,'') FROM drawings`).run();

db.exec("DELETE FROM fts_messages;");
db.prepare(`INSERT INTO fts_messages (id, channel_id, text) SELECT id, channel_id, text FROM messages WHERE deleted = 0`).run();

db.exec("DELETE FROM fts_workitems;");
db.prepare(`INSERT INTO fts_workitems (id, project_id, title, description, labels)
            SELECT id, project_id, title, COALESCE(description,''), COALESCE(labels,'') FROM work_items`).run();

db.exec("DELETE FROM fts_assets;");
db.prepare(`INSERT INTO fts_assets (id, name, hierarchy, type) SELECT id, name, hierarchy, COALESCE(type,'') FROM assets`).run();

// Default retention policies (spec §13.3).
for (const rp of [
  { id: "RP-1", name: "Default audit retention", scope: "auditEvents", days: 2555, legal_hold: 0 },
  { id: "RP-2", name: "Message history",         scope: "messages",    days: 1825, legal_hold: 0 },
  { id: "RP-3", name: "Revision archive",        scope: "revisions",   days: 3650, legal_hold: 1 },
]) {
  db.prepare("INSERT OR IGNORE INTO retention_policies (id, name, scope, days, legal_hold) VALUES (@id, @name, @scope, @days, @legal_hold)").run(rp);
}

audit({ actor: "seed", action: "seed.applied", subject: "forge", detail: { users: people.length, teamSpaces: data.teamSpaces.length } });
console.log("Seeded. Demo users:");
for (const u of people) console.log(`  ${u.email.padEnd(26)}  ${u.role}   (password: forge)`);
console.log("\nAdmin login: admin@forge.local / forge");
process.exit(0);
