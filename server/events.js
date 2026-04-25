// Server-side event pipeline: canonical §9.2 envelope, DB persistence,
// idempotent dedupe, routing engine, DLQ, replay.
//
// The rule engine cascades into asset timelines, incident creation, and
// work-item creation directly against SQLite.

import { db, now, uuid } from "./db.js";
import { audit } from "./audit.js";
import { broadcast } from "./sse.js";
import { dispatchEvent } from "./webhooks.js";

const insertEvent = db.prepare(`
  INSERT INTO events (id, received_at, source, source_type, asset_ref, project_ref, object_refs,
                      severity, event_type, payload, trace_id, routing_policy, dedupe_key, auth_context)
  VALUES (@id, @received_at, @source, @source_type, @asset_ref, @project_ref, @object_refs,
          @severity, @event_type, @payload, @trace_id, @routing_policy, @dedupe_key, @auth_context)
`);
const findDedupe = db.prepare("SELECT id FROM events WHERE dedupe_key = ?");

const insertIncident = db.prepare(`
  INSERT INTO incidents (id, org_id, workspace_id, title, severity, status, asset_id, commander_id,
                         channel_id, timeline, checklist_state, roster, started_at, resolved_at,
                         created_at, updated_at)
  VALUES (@id, @org_id, @workspace_id, @title, @severity, @status, @asset_id, @commander_id,
          @channel_id, @timeline, @checklist_state, @roster, @started_at, @resolved_at,
          @created_at, @updated_at)
`);

const insertWorkItem = db.prepare(`
  INSERT INTO work_items (id, project_id, type, title, description, assignee_id, status, severity,
                          due, blockers, labels, acl, created_at, updated_at)
  VALUES (@id, @project_id, @type, @title, @description, @assignee_id, @status, @severity,
          @due, @blockers, @labels, @acl, @created_at, @updated_at)
`);

const firstProject = () => db.prepare("SELECT id FROM projects LIMIT 1").get()?.id;
const firstOrg = () => db.prepare("SELECT id FROM organizations LIMIT 1").get()?.id;
const firstWorkspace = () => db.prepare("SELECT id FROM workspaces LIMIT 1").get()?.id;
const incidentChannel = () => db.prepare("SELECT id FROM channels WHERE kind = 'incident' LIMIT 1").get()?.id;

/**
 * Normalize + ingest a raw event. Returns the envelope, or null if deduped.
 */
export function ingest(raw, meta = {}) {
  const env = normalize(raw, meta);
  if (env.dedupe_key) {
    const dup = findDedupe.get(env.dedupe_key);
    if (dup) {
      audit({ actor: env.auth_context?.actor || "system", action: "event.duplicate", subject: env.event_id, detail: { dedupe_key: env.dedupe_key }, traceId: env.trace_id });
      return null;
    }
  }
  insertEvent.run({
    id: env.event_id,
    received_at: env.received_at,
    source: env.source,
    source_type: env.source_type,
    asset_ref: env.asset_ref,
    project_ref: env.project_ref,
    object_refs: JSON.stringify(env.object_refs || []),
    severity: env.severity,
    event_type: env.event_type,
    payload: JSON.stringify(env.payload || {}),
    trace_id: env.trace_id,
    routing_policy: env.routing_policy,
    dedupe_key: env.dedupe_key,
    auth_context: JSON.stringify(env.auth_context || {}),
  });
  try {
    route(env);
    audit({ actor: env.auth_context?.actor || "system", action: "event.ingest", subject: env.event_id, detail: { severity: env.severity }, traceId: env.trace_id });
  } catch (err) {
    deadLetter(env, err);
  }
  broadcast("events", env);
  // Fan out to configured outbound webhooks (signed).
  try { dispatchEvent(env.event_type, env); } catch { /* best-effort */ }
  return env;
}

function normalize(raw, { source, source_type }) {
  return {
    event_id: raw.event_id || uuid("EVT"),
    source: raw.source || source || "unknown",
    source_type: raw.source_type || source_type || "generic",
    received_at: new Date().toISOString(),
    asset_ref: raw.asset_ref || raw.assetId || null,
    project_ref: raw.project_ref || raw.projectId || null,
    object_refs: raw.object_refs || raw.refs || [],
    severity: raw.severity || "info",
    event_type: raw.event_type || raw.type || "generic",
    payload: raw.payload || raw.body || raw,
    trace_id: raw.trace_id || uuid("TRACE"),
    routing_policy: raw.routing_policy || "default",
    dedupe_key: raw.dedupe_key || null,
    auth_context: raw.auth_context || { actor: "system" },
  };
}

function route(env) {
  if (env.event_type === "alarm" && /SEV-1|SEV-2|critical|high/i.test(String(env.severity))) {
    createIncident(env);
  }
  if (env.event_type === "alarm") {
    notifyAlarmChannel(env);
  }
  if (env.event_type === "po.created" || env.source_type === "erp") {
    createWorkItemFromEvent(env);
  }
  if (env.source_type === "opcua" && env.event_type === "state_change") {
    appendAssetTimeline(env);
  }
}

function createIncident(env) {
  const id = uuid("INC");
  insertIncident.run({
    id,
    org_id: firstOrg(),
    workspace_id: firstWorkspace(),
    title: env.payload?.title || `${env.event_type} on ${env.asset_ref || "system"}`,
    severity: String(env.severity).toUpperCase(),
    status: "active",
    asset_id: env.asset_ref,
    commander_id: null,
    channel_id: null,
    timeline: JSON.stringify([{ ts: now(), actor: "events.rule", text: `Auto-created from ${env.source_type} event ${env.event_id}` }]),
    checklist_state: "{}",
    roster: "{}",
    started_at: now(),
    resolved_at: null,
    created_at: now(),
    updated_at: now(),
  });
  audit({ actor: "events.rule", action: "incident.create", subject: id, detail: { fromEvent: env.event_id }, traceId: env.trace_id });
  broadcast("incidents", { id, event: env.event_id });
}

function notifyAlarmChannel(env) {
  const chId = incidentChannel();
  if (!chId) return;
  const id = uuid("M");
  db.prepare(`INSERT INTO messages (id, channel_id, author_id, ts, type, text, attachments, edits, deleted)
              VALUES (@id, @ch, 'system', @ts, 'alarm', @text, '[]', '[]', 0)`)
    .run({ id, ch: chId, ts: now(), text: `[event ${env.event_id}] ${env.event_type} · ${env.severity} · ${JSON.stringify(env.payload)}` });
  broadcast("messages", { channelId: chId, id });
}

function createWorkItemFromEvent(env) {
  const projectId = env.project_ref || firstProject();
  if (!projectId) return;
  const id = uuid("WI");
  insertWorkItem.run({
    id,
    project_id: projectId,
    type: env.source_type === "erp" ? "Task" : "Action",
    title: env.payload?.title || `From ${env.source} ${env.event_type}`,
    description: `Created from event ${env.event_id}`,
    assignee_id: null,
    status: "Open",
    severity: env.severity || "medium",
    due: null,
    blockers: "[]",
    labels: JSON.stringify([env.event_id]),
    acl: "{}",
    created_at: now(),
    updated_at: now(),
  });
  audit({ actor: "events.rule", action: "workitem.create", subject: id, detail: { fromEvent: env.event_id }, traceId: env.trace_id });
}

function appendAssetTimeline(env) {
  if (!env.asset_ref) return;
  const a = db.prepare("SELECT * FROM assets WHERE id = ?").get(env.asset_ref);
  if (!a) return;
  // Timeline stored inline in asset's labels? Keep a separate column.
  // For now, just emit a notification; full asset-timeline table could be v3.
  broadcast("asset.timeline", { assetId: a.id, event: env.event_id, payload: env.payload });
}

function deadLetter(env, err) {
  const dlq = { id: uuid("DLQ"), ts: now(), envelope: JSON.stringify(env), error: String(err?.message || err), resolved: 0 };
  db.prepare("INSERT INTO dead_letters (id, ts, envelope, error, resolved) VALUES (@id, @ts, @envelope, @error, @resolved)").run(dlq);
  audit({ actor: "system", action: "event.dlq", subject: env.event_id, detail: { dlqId: dlq.id, error: dlq.error }, traceId: env.trace_id });
}

export function listEvents(limit = 100) {
  return db.prepare("SELECT * FROM events ORDER BY received_at DESC LIMIT ?").all(limit).map(rowToEnv);
}

export function listDLQ(limit = 100) {
  return db.prepare("SELECT * FROM dead_letters WHERE resolved = 0 ORDER BY ts DESC LIMIT ?").all(limit).map(r => ({ ...r, envelope: JSON.parse(r.envelope) }));
}

export function replay(dlqId) {
  const row = db.prepare("SELECT * FROM dead_letters WHERE id = ?").get(dlqId);
  if (!row) return null;
  db.prepare("UPDATE dead_letters SET resolved = 1 WHERE id = ?").run(dlqId);
  const env = JSON.parse(row.envelope);
  env.trace_id = (env.trace_id || "") + ":replay";
  audit({ actor: "system", action: "event.replay", subject: env.event_id, detail: { dlqId }, traceId: env.trace_id });
  return ingest(env);
}

function rowToEnv(r) {
  return {
    event_id: r.id,
    received_at: r.received_at,
    source: r.source,
    source_type: r.source_type,
    asset_ref: r.asset_ref,
    project_ref: r.project_ref,
    object_refs: JSON.parse(r.object_refs || "[]"),
    severity: r.severity,
    event_type: r.event_type,
    payload: JSON.parse(r.payload || "{}"),
    trace_id: r.trace_id,
    routing_policy: r.routing_policy,
    dedupe_key: r.dedupe_key,
    auth_context: JSON.parse(r.auth_context || "{}"),
  };
}
