// Incident War Room v2 — spec §11.13 and §10 #9.
//
// Features:
//   * Severity header with live SLA pill
//   * Alarms strip: recent events related to the linked asset
//   * Live timeline with log-entry composer
//   * Command checklist (configurable per severity) + completion tracking
//   * Role roster: commander, scribe, ops lead, comms
//   * Linked asset, channel, work items, docs, procedures in the side column
//   * Postmortem export: JSON + audit-pack-style signed bundle

import { el, mount, card, badge, toast, textarea, modal, formRow, select, input } from "../core/ui.js";
import { state, update, getById } from "../core/store.js";
import { audit } from "../core/audit.js";
import { navigate } from "../core/router.js";
import { can } from "../core/permissions.js";
import { signHMAC, canonicalJSON } from "../core/crypto.js";
import { recentEvents } from "../core/events.js";
import { canTransitionIncident, INCIDENT_STATUSES } from "../core/fsm/incident.js";

export function renderIncidentsIndex() {
  const root = document.getElementById("screenContainer");
  const d = state.data;
  mount(root, [
    card("Incidents", el("table", { class: "table" }, [
      el("thead", {}, [el("tr", {}, ["ID","Title","Severity","Status","Started",""].map(h => el("th", {}, [h])))]),
      el("tbody", {}, (d.incidents || []).map(i =>
        el("tr", { class: "row-clickable", onClick: () => navigate(`/incident/${i.id}`) }, [
          el("td", { class: "mono" }, [i.id]),
          el("td", {}, [i.title]),
          el("td", {}, [badge(i.severity, "danger")]),
          el("td", {}, [badge(i.status, i.status === "active" ? "danger" : "success")]),
          el("td", { class: "tiny muted" }, [new Date(i.startedAt).toLocaleString()]),
          el("td", {}, [el("button", { class: "btn sm", onClick: (e) => { e.stopPropagation(); navigate(`/incident/${i.id}`); } }, ["Open"])]),
        ])
      )),
    ])),
  ]);
}

const COMMAND_CHECKLIST = {
  "SEV-1": [
    "Assign Incident Commander",
    "Open bridge + paging roster",
    "Confirm scope + blast radius",
    "Isolate affected asset(s)",
    "Notify leadership + external comms",
    "Capture evidence (logs, screenshots, telemetry)",
    "Declare stabilized → resolved",
    "Schedule postmortem",
  ],
  "SEV-2": [
    "Assign Incident Commander",
    "Notify Ops + Engineering on-call",
    "Mitigate at asset/line level",
    "Collect telemetry + audit log",
    "Declare resolved when steady-state",
  ],
  "SEV-3": [
    "Acknowledge",
    "Log mitigation step(s)",
    "Verify steady-state",
    "Resolve and close",
  ],
};

const ROSTER_ROLES = ["Commander", "Scribe", "Ops lead", "Comms lead", "Engineering lead"];

export function renderIncident({ id }) {
  const root = document.getElementById("screenContainer");
  const d = state.data;
  const inc = getById("incidents", id);
  if (!inc) return mount(root, el("div", { class: "muted" }, ["Incident not found."]));

  const asset = inc.assetId ? getById("assets", inc.assetId) : null;
  const channel = inc.channelId ? getById("channels", inc.channelId) : null;
  const workItems = (d.workItems || []).filter(w => (w.event_refs || []).some(ref => (inc.event_refs || []).includes(ref)) || (w.labels || []).includes(inc.id));

  const entryInput = textarea({ placeholder: "Log a timeline entry" });
  entryInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      addEntry(entryInput.value);
      entryInput.value = "";
    }
  });

  mount(root, [
    severityBar(inc),
    incidentCommandHeader(inc, asset),
    alarmsStrip(inc, asset),
    el("div", { class: "incident-layout" }, [
      el("div", { class: "stack" }, [
        card("Timeline", el("div", { class: "timeline" },
          (inc.timeline || []).map(t => el("div", { class: "timeline-entry" }, [
            el("div", { class: "t-head" }, [
              el("span", { class: "mono" }, [new Date(t.ts).toLocaleTimeString()]),
              el("span", { class: "strong" }, [String(t.actor)]),
            ]),
            el("div", { class: "t-body" }, [t.text]),
          ]))
        )),
        card("Add entry", el("div", { class: "stack" }, [
          entryInput,
          el("div", { class: "row wrap" }, [
            el("button", { class: "btn sm primary", disabled: !can("incident.respond"), onClick: () => { addEntry(entryInput.value); entryInput.value = ""; } }, ["Log entry"]),
            el("button", { class: "btn sm", disabled: !can("incident.command"), onClick: () => changeSeverity(inc) }, ["Change severity"]),
            el("button", { class: "btn sm", disabled: !can("incident.command"), onClick: () => changeStatus(inc) }, ["Change status"]),
          ]),
        ])),
        commandChecklistCard(inc),
      ]),
      el("div", { class: "stack" }, [
        rosterCard(inc),
        asset ? assetCard(asset) : null,
        channelCard(channel),
        workItemsCard(inc, workItems),
        aiCard(inc, asset),
        exportCard(inc),
      ]),
    ]),
  ]);

  function addEntry(text) {
    if (!text.trim()) return;
    if (!can("incident.respond")) { toast("No permission", "warn"); return; }
    update(s => {
      const i = s.data.incidents.find(x => x.id === id);
      i.timeline = i.timeline || [];
      i.timeline.push({ ts: new Date().toISOString(), actor: s.ui.role, text: text.trim() });
    });
    audit("incident.entry", id);
    toast("Entry logged", "success");
  }
}

function incidentCommandHeader(inc, asset) {
  const roster = inc.roster || {};
  const checklist = COMMAND_CHECKLIST[inc.severity] || COMMAND_CHECKLIST["SEV-3"];
  const done = Object.values(inc.checklistState || {}).filter(Boolean).length;
  const latest = (inc.timeline || []).slice(-1)[0];
  const objective = inc.status === "active" ? "Stabilize affected operation"
    : inc.status === "escalated" ? "Contain scope and assign decision owner"
    : inc.status === "stabilized" ? "Verify steady state before resolution"
    : inc.status === "resolved" ? "Prepare postmortem and evidence export"
    : "Maintain command record";
  return card("Incident command", el("div", { class: "stack" }, [
    el("div", { class: "card-grid" }, [
      commandMetric("Commander", roster.Commander || inc.commanderId || "Unassigned", !roster.Commander && !inc.commanderId ? "warn" : "success"),
      commandMetric("Current objective", objective, inc.status === "active" ? "danger" : "info"),
      commandMetric("Active actions", `${done}/${checklist.length} complete`, done === checklist.length ? "success" : "warn"),
      commandMetric("Linked asset", asset ? asset.name : "None", asset?.status === "alarm" ? "danger" : "info"),
    ]),
    latest ? el("div", { class: "activity-row" }, [
      badge("latest", "info"),
      el("span", {}, [latest.text]),
      el("span", { class: "tiny muted" }, [new Date(latest.ts).toLocaleTimeString()]),
    ]) : null,
  ]));
}

function commandMetric(label, value, variant) {
  return el("div", { class: "kpi" }, [
    el("div", { class: "kpi-label" }, [label]),
    el("div", { class: "small strong" }, [value]),
    badge(variant === "danger" ? "attention" : variant === "warn" ? "pending" : "ok", variant),
  ]);
}

function severityBar(inc) {
  const sla = incidentSLA(inc);
  return el("div", { class: "incident-severity-bar" }, [
    el("span", { class: "sev-chip" }, [inc.severity]),
    el("div", { style: { flex: 1 } }, [
      el("h2", {}, [inc.title]),
      el("div", { class: "tiny muted" }, [
        `Started ${new Date(inc.startedAt).toLocaleString()} · ${inc.id} · active for ${sla}`,
      ]),
    ]),
    badge(inc.status.toUpperCase(), inc.status === "active" ? "danger" : inc.status === "resolved" ? "success" : "warn"),
  ]);
}

function incidentSLA(inc) {
  const started = Date.parse(inc.startedAt);
  const end = inc.status === "resolved" || inc.status === "postmortem" ? Date.parse(inc.resolvedAt || new Date()) : Date.now();
  const mins = Math.max(0, (end - started) / 60000);
  if (mins < 60) return `${mins.toFixed(0)} min`;
  const hours = mins / 60;
  if (hours < 48) return `${hours.toFixed(1)} h`;
  return `${(hours / 24).toFixed(1)} d`;
}

function alarmsStrip(inc, asset) {
  const events = recentEvents(40).filter(e => e.event_type === "alarm" || (asset && e.asset_ref === asset.id));
  if (!events.length) return el("div", {});
  return card("Alarms & data strip", el("div", { class: "row wrap", style: { gap: "6px" } },
    events.slice(0, 8).map(e => el("span", { class: "chip" }, [
      el("span", { class: "chip-kind" }, [e.source_type]),
      `${e.event_type} · ${e.severity}`,
    ]))
  ), { subtitle: "Recent events from connected sources (MQTT / OPC UA / REST)." });
}

function commandChecklistCard(inc) {
  const items = COMMAND_CHECKLIST[inc.severity] || COMMAND_CHECKLIST["SEV-3"];
  const state = inc.checklistState || {};
  return card("Command checklist", el("div", { class: "stack" }, items.map((item, i) => {
    const done = !!state[i];
    return el("label", { class: "row", style: { gap: "8px" } }, [
      el("input", { type: "checkbox", checked: done, disabled: !can("incident.respond"), onChange: () => toggleChecklist(inc.id, i, !done) }),
      el("span", { class: "small", style: { textDecoration: done ? "line-through" : "none" } }, [item]),
    ]);
  })), { subtitle: `Playbook for ${inc.severity}` });
}

function toggleChecklist(id, i, checked) {
  update(s => {
    const inc = s.data.incidents.find(x => x.id === id);
    if (!inc) return;
    inc.checklistState = inc.checklistState || {};
    inc.checklistState[i] = checked;
    inc.timeline = inc.timeline || [];
    inc.timeline.push({ ts: new Date().toISOString(), actor: s.ui.role, text: `Checklist step ${i} ${checked ? "completed" : "reopened"}` });
  });
  audit("incident.checklist", id, { index: i, checked });
}

function rosterCard(inc) {
  const roster = inc.roster || {};
  return card("Command roster", el("div", { class: "stack" }, [
    ...ROSTER_ROLES.map(r => el("div", { class: "activity-row" }, [
      el("span", { class: "tiny muted", style: { width: "100px" } }, [r]),
      el("span", { class: "small mono" }, [roster[r] || "(unassigned)"]),
      el("button", { class: "btn sm", disabled: !can("incident.command"), onClick: () => assignRole(inc.id, r) }, ["Assign"]),
    ])),
  ]));
}

function assignRole(incId, role) {
  const users = state.data.users.map(u => ({ value: u.id, label: `${u.name} — ${u.role}` }));
  const pick = select(users);
  modal({
    title: `Assign ${role}`,
    body: el("div", { class: "stack" }, [formRow("User", pick)]),
    actions: [
      { label: "Cancel" },
      { label: "Assign", variant: "primary", onClick: () => {
        update(s => {
          const inc = s.data.incidents.find(x => x.id === incId);
          inc.roster = inc.roster || {};
          inc.roster[role] = pick.value;
          if (role === "Commander") inc.commanderId = pick.value;
          inc.timeline = inc.timeline || [];
          inc.timeline.push({ ts: new Date().toISOString(), actor: s.ui.role, text: `${role} = ${pick.value}` });
        });
        audit("incident.roster", incId, { role, userId: pick.value });
        toast(`${role} assigned`, "success");
      }},
    ],
  });
}

function assetCard(asset) {
  return card("Asset context", el("div", { class: "stack" }, [
    el("div", { class: "strong" }, [asset.name]),
    el("div", { class: "tiny muted" }, [asset.hierarchy]),
    el("button", { class: "btn sm", onClick: () => navigate(`/asset/${asset.id}`) }, ["Open asset →"]),
  ]));
}

function channelCard(channel) {
  return card("Linked channel", channel ? el("div", { class: "stack" }, [
    el("div", {}, [`#${channel.name}`]),
    el("button", { class: "btn sm", onClick: () => navigate(`/channel/${channel.id}`) }, ["Open channel →"]),
  ]) : el("div", { class: "muted tiny" }, ["No channel linked."]));
}

function workItemsCard(inc, workItems) {
  return card(`Action items (${workItems.length})`, el("div", { class: "stack" }, [
    ...workItems.map(w => el("div", { class: "activity-row", onClick: () => navigate(`/work-board/${w.projectId}`) }, [
      badge(w.type, "info"),
      el("span", { class: "small" }, [w.title]),
      badge(w.status, ""),
    ])),
    workItems.length ? null : el("div", { class: "muted tiny" }, ["No linked actions."]),
    el("button", { class: "btn sm primary", onClick: () => createActionItem(inc) }, ["+ Action item"]),
  ]));
}

function createActionItem(inc) {
  const title = window.prompt("Action item title:");
  if (!title) return;
  const project = (state.data.projects || [])[0];
  const id = "WI-" + Math.floor(Math.random()*900+100);
  update(s => {
    s.data.workItems.push({
      id, projectId: project.id, type: "Action", title,
      assigneeId: "U-1", status: "Open", severity: inc.severity === "SEV-1" ? "critical" : "high",
      due: null, blockers: [], labels: [inc.id],
      description: `From incident ${inc.id}.`,
    });
  });
  audit("incident.action", inc.id, { workItemId: id });
  toast(`${id} created`, "success");
}

function aiCard(inc, asset) {
  return card("AI — Live summary & next steps", el("div", { class: "stack" }, [
    el("div", { class: "small" }, [
      `${inc.id} is ${inc.status}. ${(inc.timeline || []).length} timeline entries. `,
      asset ? `Asset ${asset.id} is in ${asset.status}.` : "No asset bound.",
    ]),
    el("div", { class: "small" }, [
      "Recommended next steps: follow the command checklist, capture telemetry around the asset's MQTT/OPC UA signals, and verify steady-state for 15 min before resolving.",
    ]),
    el("div", { class: "tiny muted" }, ["Citations: ", inc.id, asset ? ", " + asset.id : ""]),
  ]));
}

function exportCard(inc) {
  return card("Export", el("div", { class: "stack" }, [
    el("button", { class: "btn sm", onClick: () => exportPostmortem(inc, "json") }, ["Export postmortem JSON"]),
    el("button", { class: "btn sm", onClick: () => exportPostmortem(inc, "md") }, ["Export postmortem Markdown"]),
  ]), { subtitle: "Includes timeline, roster, checklist, signed hash." });
}

async function exportPostmortem(inc, fmt) {
  const events = (state.data.auditEvents || []).filter(e => e.subject === inc.id);
  const pack = {
    incident: inc,
    events,
    exported_at: new Date().toISOString(),
    exported_by: state.ui.role,
  };
  const sig = await signHMAC(canonicalJSON(pack));
  const signed = { ...pack, signature: sig };

  let blob, ext;
  if (fmt === "md") {
    const md = renderMarkdown(inc, events, sig);
    blob = new Blob([md], { type: "text/markdown" });
    ext = "md";
  } else {
    blob = new Blob([JSON.stringify(signed, null, 2)], { type: "application/json" });
    ext = "json";
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${inc.id}-postmortem.${ext}`;
  document.body.append(a);
  a.click();
  a.remove();
  audit("incident.export", inc.id, { fmt });
  toast("Postmortem exported", "success");
}

function renderMarkdown(inc, events, sig) {
  const lines = [];
  lines.push(`# Incident ${inc.id} — ${inc.title}`);
  lines.push(``);
  lines.push(`**Severity** ${inc.severity}  `);
  lines.push(`**Status** ${inc.status}  `);
  lines.push(`**Started** ${inc.startedAt}  `);
  lines.push(``);
  lines.push(`## Timeline`);
  for (const t of (inc.timeline || [])) lines.push(`- **${t.ts}** (${t.actor}) — ${t.text}`);
  lines.push(``);
  lines.push(`## Command checklist`);
  const items = COMMAND_CHECKLIST[inc.severity] || COMMAND_CHECKLIST["SEV-3"];
  const st = inc.checklistState || {};
  items.forEach((item, i) => lines.push(`- [${st[i] ? "x" : " "}] ${item}`));
  lines.push(``);
  lines.push(`## Roster`);
  for (const [r, u] of Object.entries(inc.roster || {})) lines.push(`- **${r}** — ${u}`);
  lines.push(``);
  lines.push(`## Audit events (${events.length})`);
  for (const e of events) lines.push(`- ${e.ts} · ${e.action} · ${e.actor}`);
  lines.push(``);
  lines.push(`---`);
  lines.push(`*Signed ${sig.alg} · key ${sig.keyId} · ${sig.signature}*`);
  return lines.join("\n");
}

function changeSeverity(inc) {
  const next = window.prompt("New severity (SEV-1..SEV-4):", inc.severity);
  if (!next) return;
  update(s => { const i = s.data.incidents.find(x => x.id === inc.id); if (i) i.severity = next; });
  audit("incident.severity", inc.id, { to: next });
}

function changeStatus(inc) {
  const next = window.prompt("New status (" + INCIDENT_STATUSES.join(" / ") + "):", inc.status);
  if (!next) return;
  if (!canTransitionIncident(inc.status, next)) {
    toast(`Cannot transition incident from ${inc.status} → ${next}`, "warn");
    return;
  }
  update(s => {
    const i = s.data.incidents.find(x => x.id === inc.id);
    if (!i) return;
    i.status = next;
    if (next === "resolved") i.resolvedAt = new Date().toISOString();
    i.timeline = i.timeline || [];
    i.timeline.push({ ts: new Date().toISOString(), actor: s.ui.role, text: `Status changed to ${next}.` });
  });
  audit("incident.status", inc.id, { to: next });
}
