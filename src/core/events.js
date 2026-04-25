// Event pipeline — canonical envelope, normalization, routing, DLQ, replay.
// Implements spec §9.2, §9.3, §9.4.
//
// Pipeline: ingest → validate → map → enrich → route → audit (→ DLQ on fail).
// Idempotency is enforced via a `dedupe_key` seen-set.

import { state, update } from "./store.js";
import { audit } from "./audit.js";
import { fanout } from "./subscriptions.js";

const seenDedupeKeys = new Set();
let _seq = 0;

/**
 * Ingest a raw event. Returns the normalized envelope (or null if deduped).
 */
export function ingest(raw, { source = "unknown", source_type = "generic" } = {}) {
  const envelope = normalize(raw, { source, source_type });
  if (!envelope) return null;

  if (envelope.dedupe_key && seenDedupeKeys.has(envelope.dedupe_key)) {
    audit("event.duplicate", envelope.event_id, { dedupe_key: envelope.dedupe_key, traceId: envelope.trace_id });
    return null;
  }
  if (envelope.dedupe_key) seenDedupeKeys.add(envelope.dedupe_key);

  update(s => {
    s.data.eventLog = s.data.eventLog || [];
    s.data.eventLog.unshift(envelope);
    if (s.data.eventLog.length > 200) s.data.eventLog.length = 200;
  });

  try {
    route(envelope);
    audit("event.ingest", envelope.event_id, { source: envelope.source, severity: envelope.severity, traceId: envelope.trace_id });
  } catch (err) {
    deadLetter(envelope, err);
  }
  return envelope;
}

function normalize(raw, { source, source_type }) {
  _seq += 1;
  const event_id = raw.event_id || `EVT-${Date.now().toString(36)}-${_seq}`;
  const trace_id = raw.trace_id || `TRACE-${Math.random().toString(36).slice(2, 10)}`;
  return {
    event_id,
    source: raw.source || source,
    source_type: raw.source_type || source_type,
    received_at: new Date().toISOString(),
    asset_ref: raw.asset_ref || raw.assetId || null,
    project_ref: raw.project_ref || raw.projectId || null,
    object_refs: raw.object_refs || raw.refs || [],
    severity: raw.severity || "info",
    event_type: raw.event_type || raw.type || "generic",
    payload: raw.payload || raw.body || raw,
    trace_id,
    routing_policy: raw.routing_policy || "default",
    dedupe_key: raw.dedupe_key || null,
    auth_context: raw.auth_context || { actor: state.ui?.role || "system" },
  };
}

/**
 * Routing rules — spec §9.3 outcomes.
 * Configurable here; real deployments would load rules from storage.
 */
function route(env) {
  const rules = (state.data.routingRules || DEFAULT_RULES).slice();
  let matched = 0;
  for (const rule of rules) {
    try {
      if (rule.when(env)) {
        rule.action(env);
        matched += 1;
        audit("event.rule.match", env.event_id, { rule: rule.name, traceId: env.trace_id });
      }
    } catch (err) {
      audit("event.rule.error", env.event_id, { rule: rule.name, error: String(err), traceId: env.trace_id });
    }
  }
  if (!matched) audit("event.nomatch", env.event_id, { traceId: env.trace_id });
}

const DEFAULT_RULES = [
  {
    name: "high-severity-alarm -> incident",
    when: e => e.event_type === "alarm" && (e.severity === "SEV-1" || e.severity === "SEV-2" || e.severity === "critical" || e.severity === "high"),
    action: e => createIncidentFromEvent(e),
  },
  {
    name: "alarm -> channel notification",
    when: e => e.event_type === "alarm",
    action: e => notifyAlarmChannel(e),
  },
  {
    name: "erp.purchase_order -> work item",
    when: e => e.event_type === "po.created" || e.source_type === "erp",
    action: e => createWorkItemFromEvent(e),
  },
  {
    name: "opcua.state_change -> asset timeline",
    when: e => e.source_type === "opcua" && e.event_type === "state_change",
    action: e => appendAssetTimeline(e),
  },
  {
    name: "any event -> follower fanout",
    when: () => true,
    action: e => {
      if (e.asset_ref) fanout(e.asset_ref, "update", { kind: "event", text: `${e.event_type} on ${e.asset_ref}`, route: `/asset/${e.asset_ref}` });
    },
  },
];

function createIncidentFromEvent(e) {
  update(s => {
    const id = "INC-" + Math.floor(Math.random() * 9000 + 1000);
    const inc = {
      id,
      title: e.payload?.title || `${e.event_type} on ${e.asset_ref || "system"}`,
      severity: e.severity?.toUpperCase() || "SEV-3",
      status: "active",
      assetId: e.asset_ref,
      commanderId: null,
      channelId: null,
      startedAt: new Date().toISOString(),
      timeline: [{ ts: new Date().toISOString(), actor: "events.rule", text: `Auto-created from ${e.source_type} event ${e.event_id}` }],
      event_refs: [e.event_id],
      trace_id: e.trace_id,
    };
    s.data.incidents.push(inc);
  });
}

function notifyAlarmChannel(e) {
  const d = state.data;
  const incChannel = (d.channels || []).find(c => c.kind === "incident");
  if (!incChannel) return;
  update(s => {
    s.data.messages.push({
      id: "M-" + Date.now().toString(36),
      channelId: incChannel.id,
      authorId: "system",
      ts: new Date().toISOString(),
      type: "alarm",
      text: `[event ${e.event_id}] ${e.event_type} · ${e.severity} · ${JSON.stringify(e.payload)}`,
    });
  });
}

function createWorkItemFromEvent(e) {
  const projectId = e.project_ref || (state.data.projects || [])[0]?.id;
  if (!projectId) return;
  update(s => {
    const id = "WI-" + Math.floor(Math.random() * 900 + 100);
    s.data.workItems.push({
      id,
      projectId,
      type: e.source_type === "erp" ? "Task" : "Action",
      title: e.payload?.title || `From ${e.source} ${e.event_type}`,
      assigneeId: "U-1",
      status: "Open",
      severity: e.severity || "medium",
      due: null,
      blockers: [],
      event_refs: [e.event_id],
    });
  });
}

function appendAssetTimeline(e) {
  const a = (state.data.assets || []).find(x => x.id === e.asset_ref);
  if (!a) return;
  update(s => {
    const asset = s.data.assets.find(x => x.id === a.id);
    asset.timeline = asset.timeline || [];
    asset.timeline.unshift({ ts: new Date().toISOString(), actor: "opcua", text: JSON.stringify(e.payload) });
    if (asset.timeline.length > 50) asset.timeline.length = 50;
  });
}

function deadLetter(env, err) {
  const dlq = {
    id: "DLQ-" + Math.random().toString(36).slice(2, 10).toUpperCase(),
    ts: new Date().toISOString(),
    envelope: env,
    error: String(err?.message || err),
  };
  update(s => {
    s.data.deadLetters = s.data.deadLetters || [];
    s.data.deadLetters.unshift(dlq);
    if (s.data.deadLetters.length > 100) s.data.deadLetters.length = 100;
  });
  audit("event.dlq", env.event_id, { dlqId: dlq.id, error: dlq.error, traceId: env.trace_id });
  // Persist for replay even if the store is reset.
  import("./idb.js").then(idb => idb.append("dlq", dlq)).catch(() => {});
  return dlq;
}

export function listDeadLetters() {
  return (state.data.deadLetters || []).slice();
}

export function replay(dlqId) {
  const dlq = (state.data.deadLetters || []).find(x => x.id === dlqId);
  if (!dlq) return null;
  update(s => {
    s.data.deadLetters = (s.data.deadLetters || []).filter(x => x.id !== dlqId);
  });
  const replayed = { ...dlq.envelope, trace_id: (dlq.envelope.trace_id || "") + ":replay" };
  audit("event.replay", dlq.envelope.event_id, { dlqId, traceId: replayed.trace_id });
  return ingest(replayed, { source: replayed.source, source_type: replayed.source_type });
}

export function recentEvents(n = 50) {
  return (state.data.eventLog || []).slice(0, n);
}
