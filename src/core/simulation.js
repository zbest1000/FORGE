// Demo simulation seam.
//
// UI screens should not embed demo-only operational values or canned narratives.
// Keep those here so a real deployment can replace this module with data from a
// historian, CMMS, AI service, or rules engine without rewriting the screens.

const DAY_MS = 86_400_000;

function hash(input = "") {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function seededNoise(seed, index) {
  const x = Math.sin(seed + index * 97.13) * 10000;
  return x - Math.floor(x);
}

export function simulatedTelemetry(asset, data = {}, points = 60) {
  const signals = (data.dataSources || []).filter(ds => ds.assetId === asset.id);
  const seed = hash(asset.id + asset.name);
  const baseline = signals.some(s => /temp/i.test(s.endpoint)) ? 72
    : signals.some(s => /current/i.test(s.endpoint)) ? 48
    : signals.some(s => /steam|press|bar/i.test(s.endpoint)) ? 11
    : 50 + (seed % 18);
  const severityLift = asset.status === "alarm" ? 24 : asset.status === "warning" ? 10 : 0;
  const drift = asset.daqStatus === "stale" ? -3 : asset.daqStatus === "not_connected" ? -8 : 0;
  return Array.from({ length: points }, (_, i) => {
    const wave = Math.sin((i + seed % 13) / 6) * 4;
    const jitter = (seededNoise(seed, i) - 0.5) * 5;
    return Math.max(0, Math.min(140, baseline + severityLift + drift + wave + jitter));
  });
}

export function assetOperationsBrief(asset, data = {}) {
  const signals = (data.dataSources || []).filter(ds => ds.assetId === asset.id);
  const service = (data.maintenanceItems || []).filter(m => m.assetId === asset.id);
  const incidents = (data.incidents || []).filter(i => i.assetId === asset.id && i.status === "active");
  const docs = (data.documents || []).filter(doc => (doc.assetIds || []).includes(asset.id) || (asset.docIds || []).includes(doc.id));
  const topSignal = signals[0];
  const pieces = [];
  if (topSignal) {
    pieces.push(`${topSignal.endpoint} is ${topSignal.status || "mapped"}${topSignal.lastValue ? ` at ${topSignal.lastValue}` : ""}`);
  } else {
    pieces.push("No live operations signal is mapped yet");
  }
  if (incidents.length) pieces.push(`${incidents.length} active incident${incidents.length === 1 ? "" : "s"}`);
  if (service.length) pieces.push(`${service.length} service item${service.length === 1 ? "" : "s"}`);
  if (docs.length) pieces.push(`${docs.length} controlled document${docs.length === 1 ? "" : "s"}`);
  return {
    text: `${asset.name}: ${pieces.join("; ")}.`,
    citations: [
      asset.id,
      ...signals.slice(0, 2).map(s => s.id),
      ...service.slice(0, 2).map(s => s.id),
      ...incidents.slice(0, 2).map(i => i.id),
    ],
  };
}

export function assetBrief(asset, context = {}) {
  const data = {
    dataSources: context.dataSources || [],
    maintenanceItems: context.maintenance || [],
    incidents: context.incidents || [],
    documents: context.documents || [],
  };
  const brief = assetOperationsBrief(asset, data);
  return {
    bullets: [brief.text],
    citations: brief.citations,
  };
}

export function workspaceBrief(data = {}) {
  const activeIncident = (data.incidents || []).find(i => i.status === "active");
  const reviewRev = (data.revisions || []).find(r => r.status === "IFR");
  const pendingApproval = (data.approvals || []).find(a => a.status === "pending");
  const highWork = (data.workItems || []).filter(w => ["high", "critical"].includes(w.severity));
  const staleSignals = (data.dataSources || []).filter(s => ["stale", "not_connected"].includes(s.status));
  const bullets = [];
  if (activeIncident) bullets.push(`${activeIncident.severity} incident "${activeIncident.title}" is active. [cite: ${activeIncident.id}]`);
  if (reviewRev) bullets.push(`${reviewRev.docId} Rev ${reviewRev.label} is ${reviewRev.status}: "${reviewRev.summary}". [cite: ${reviewRev.id}]`);
  if (pendingApproval) bullets.push(`${pendingApproval.id} awaits approval on ${pendingApproval.subject.kind} ${pendingApproval.subject.id}.`);
  bullets.push(`${highWork.length} high-severity work items are open.`);
  if (staleSignals.length) bullets.push(`${staleSignals.length} operations signal${staleSignals.length === 1 ? "" : "s"} need freshness review.`);
  return {
    bullets,
    citations: [
      ...(reviewRev ? [reviewRev.id] : []),
      ...(activeIncident ? [activeIncident.id] : []),
      ...staleSignals.slice(0, 2).map(s => s.id),
    ],
  };
}

export function workspaceIncidentBrief(data = {}) {
  const incident = (data.incidents || []).find(i => i.status === "active");
  return incident ? `${incident.severity} incident "${incident.title}" is active. [cite: ${incident.id}]` : null;
}

export function incidentGuidance(incident, asset, data = {}) {
  const service = asset ? (data.maintenanceItems || []).filter(m => m.assetId === asset.id) : [];
  const signals = asset ? (data.dataSources || []).filter(ds => ds.assetId === asset.id) : [];
  const openService = service.filter(m => ["open", "due"].includes(m.status));
  const staleSignals = signals.filter(s => ["stale", "not_connected"].includes(s.status));
  const steps = [
    "Confirm commander, current objective, and next decision.",
    openService.length ? "Coordinate with open service work before changing asset state." : "Capture operator mitigation steps in the timeline.",
    staleSignals.length ? "Verify signal freshness before relying on operations values." : "Monitor mapped operations signals until steady state is proven.",
  ];
  return {
    summary: `${incident.id} is ${incident.status}. ${(incident.timeline || []).length} timeline entries.${asset ? ` Asset ${asset.id} is ${asset.status}.` : " No asset bound."}`,
    steps,
    citations: [incident.id, asset?.id, ...signals.slice(0, 2).map(s => s.id)].filter(Boolean),
  };
}

export function incidentRecommendation(incident, asset, data = {}) {
  const guidance = incidentGuidance(incident, asset, data);
  return {
    nextSteps: guidance.steps.join(" "),
    citations: guidance.citations,
  };
}

export function nextDemoId(prefix, existing = []) {
  const used = new Set(existing.map(x => x.id));
  for (let i = 1; i < 10_000; i++) {
    const id = `${prefix}-${String(i).padStart(4, "0")}`;
    if (!used.has(id)) return id;
  }
  return `${prefix}-${Date.now()}`;
}

export function daysFromNow(days) {
  return new Date(Date.now() + days * DAY_MS).toISOString();
}

export const simulation = {
  assetBrief,
  assetOperationsBrief,
  incidentRecommendation,
  nextDemoId,
  incidentGuidance,
  simulatedTelemetry,
  telemetrySeries: simulatedTelemetry,
  workspaceBrief,
  workspaceIncidentBrief(data = {}) {
    const incident = (data.incidents || []).find(i => i.status === "active");
    return incident ? `${incident.severity} incident "${incident.title}" is active. [cite: ${incident.id}]` : null;
  },
};
