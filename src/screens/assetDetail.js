import { el, mount, card, badge, kpi, toast, chip, modal, formRow, select, tabs } from "../core/ui.js";
import { state, update, getById, audit } from "../core/store.js";
import { navigate } from "../core/router.js";
import { can } from "../core/permissions.js";
import { getServer } from "../core/i3x/client.js";
import { sparkline } from "../core/charts.js";
import { canSeeAsset, listGroups, getGroup } from "../core/groups.js";
import { simulation } from "../core/simulation.js";

export function renderAssetsIndex() {
  const root = document.getElementById("screenContainer");
  const d = state.data;
  const visible = (d.assets || []).filter(canSeeAsset);
  const hidden = (d.assets || []).length - visible.length;
  const userById = Object.fromEntries((d.users || []).map(u => [u.id, u]));
  mount(root, [
    card("Assets", el("div", { class: "stack" }, [
      hidden ? el("div", { class: "tiny muted" }, [`${hidden} asset(s) hidden — not assigned to your user or groups.`]) : null,
      el("table", { class: "table" }, [
        el("thead", {}, [el("tr", {}, ["Asset","Hierarchy","Type","Status","Assigned",""].map(h => el("th", {}, [h])))]),
        el("tbody", {}, visible.map(a => {
          const owner = a.assignedUserId ? userById[a.assignedUserId]?.name || a.assignedUserId : null;
          const grp = a.assignedGroupId ? getGroup(a.assignedGroupId)?.name || a.assignedGroupId : null;
          return el("tr", { class: "row-clickable", onClick: () => navigate(`/asset/${a.id}`) }, [
            el("td", {}, [a.name, el("div", { class: "tiny muted" }, [a.id])]),
            el("td", { class: "tiny muted" }, [a.hierarchy]),
            el("td", {}, [badge(a.type, "info")]),
            el("td", {}, [badge(a.status.toUpperCase(), statusVariant(a.status))]),
            el("td", { class: "tiny" }, [
              owner ? el("div", {}, [owner]) : null,
              grp ? el("div", { class: "muted" }, [grp]) : null,
              !owner && !grp ? el("span", { class: "muted" }, ["—"]) : null,
            ]),
            el("td", {}, [el("button", { class: "btn sm", onClick: (e) => { e.stopPropagation(); navigate(`/asset/${a.id}`); } }, ["Open"])]),
          ]);
        })),
      ]),
    ])),
  ]);
}

export function renderAssetDetail({ id }) {
  const root = document.getElementById("screenContainer");
  const d = state.data;
  const a = getById("assets", id);
  if (!a) return mount(root, el("div", { class: "muted" }, ["Asset not found."]));
  if (!canSeeAsset(a)) {
    return mount(root, el("div", { class: "forbidden" }, [
      el("h2", {}, ["This asset is restricted"]),
      el("p", { class: "muted" }, ["Asset is assigned to a user or group you don't belong to. Ask an administrator for access."]),
      el("button", { class: "btn primary", onClick: () => navigate("/assets") }, ["Back to assets"]),
    ]));
  }

  const linkedProjects = (d.projects || []).filter(p => (a.projectIds || []).includes(p.id) || (p.assetIds || []).includes(a.id));
  const linkedDocs = scopedAssetDocs(a, linkedProjects);
  const dataSources = (d.dataSources || []).filter(ds => ds.assetId === a.id);
  const incidents = (d.incidents || []).filter(i => i.assetId === a.id);
  const tasks = (d.workItems || []).filter(w => (w.assetIds || []).includes(a.id) || (w.description || "").includes(a.id));
  const maintenance = (d.maintenanceItems || []).filter(m => m.assetId === a.id);
  const site = locationById(a.siteId);
  const loc = locationById(a.locationId);

  mount(root, [
    el("div", { class: "row spread", style: { marginBottom: "12px" } }, [
      el("div", {}, [
        el("div", { class: "strong" }, [a.name]),
        el("div", { class: "tiny muted" }, [site?.name || "Unassigned site", " · ", loc?.path || a.hierarchy, " · ", a.id]),
      ]),
      el("div", { class: "row" }, [
        badge(a.status.toUpperCase(), statusVariant(a.status)),
        badge(`Signals ${a.daqStatus || "unknown"}`, dataVariant(a.daqStatus)),
        badge(`Service ${a.maintenanceStatus || "none"}`, maintenanceVariant(a.maintenanceStatus)),
        el("button", { class: "btn sm danger", disabled: !can("incident.respond"), onClick: () => openWarRoom(a) }, ["🚨 War room"]),
      ]),
    ]),
    el("div", { class: "card-grid" }, [
      kpi("Projects", linkedProjects.length, "", ""),
      kpi("Linked docs", linkedDocs.length, "", ""),
      kpi("Operations signals", dataSources.length, a.daqStatus || "", dataSources.some(ds => ds.status === "stale") ? "down" : "up"),
      kpi("Service work", maintenance.length, a.maintenanceStatus || "", maintenance.some(m => ["open","due"].includes(m.status)) ? "down" : "up"),
      kpi("Open incidents", incidents.filter(i => i.status === "active").length, "", incidents.some(i => i.status === "active") ? "down" : "up"),
    ]),

    assetContextTabs(a, {
      orgName: d.organization?.name || "Enterprise",
      site,
      loc,
      linkedProjects,
      linkedDocs,
      dataSources,
      tasks,
      maintenance,
      incidents,
    }),

    assignmentCard(a),

    assetBriefCard(a, { dataSources, incidents, maintenance }),
  ]);
}

function locationById(id) {
  return (state.data?.locations || []).find(l => l.id === id) || null;
}

function scopedAssetDocs(asset, projects) {
  const projectIds = new Set(projects.map(p => p.id));
  return (state.data.documents || []).filter(doc =>
    doc.scope === "enterprise" ||
    (doc.assetIds || []).includes(asset.id) ||
    (doc.siteId && doc.siteId === asset.siteId) ||
    (doc.projectId && projectIds.has(doc.projectId)) ||
    (asset.docIds || []).includes(doc.id)
  );
}

function chipText(kind, value) {
  return el("span", { class: "chip" }, [el("span", { class: "chip-kind" }, [kind]), value || "—"]);
}

function helpHint(text) {
  return el("span", { class: "help-dot", title: text, "aria-label": text }, ["?"]);
}

function assetContextTabs(asset, ctx) {
  const key = `asset.context.${asset.id}`;
  return tabs({
    sessionKey: key,
    ariaLabel: "Asset context",
    tabs: [
      { id: "summary", label: "Summary", content: () => assetSummaryTab(asset, ctx) },
      { id: "docs", label: `Docs (${ctx.linkedDocs.length})`, content: () => card("Linked documents", documentList(ctx.linkedDocs)) },
      { id: "work", label: `Work (${ctx.tasks.length + ctx.maintenance.length})`, content: () => card("Work and service", workMaintenancePanel(ctx.tasks, ctx.maintenance)) },
      { id: "signals", label: `Signals (${ctx.dataSources.length})`, content: () => el("div", { class: "two-col" }, [
        card("Operations trend", telemetry(asset)),
        card("Signal health", signalHealthPanel(ctx.dataSources)),
      ]) },
      { id: "activity", label: "Activity", content: () => card("Asset activity", assetTimeline(asset, ctx)) },
    ],
  });
}

function assetSummaryTab(asset, ctx) {
  return el("div", { class: "stack" }, [
    card(`${ctx.orgName} hierarchy`, el("div", { class: "stack" }, [
      el("div", { class: "row wrap" }, [
        chipText("Organization", ctx.orgName),
        chipText("Site", ctx.site?.name || "—"),
        chipText("Location", ctx.loc?.path || ctx.loc?.name || asset.hierarchy),
        helpHint("Assets are mastered by organization, site, and location. Projects reference assets only while they affect work scope."),
      ]),
      ctx.linkedProjects.length
        ? el("div", { class: "row wrap" }, ctx.linkedProjects.map(p =>
            el("button", { class: "btn sm", onClick: () => navigate(`/work-board/${p.id}`) }, [`Project: ${p.name}`])
          ))
        : el("div", { class: "row wrap" }, [
            badge("No active project", "info"),
            helpHint("This asset remains available through the organization and site hierarchy even when no project references it."),
          ]),
    ])),
    unsCard(asset),
  ]);
}

function documentList(docs) {
  if (!docs.length) return el("div", { class: "muted tiny" }, ["No scoped documents."]);
  return el("div", { class: "stack" }, docs.map(doc =>
    el("button", { class: "activity-row", onClick: () => navigate(`/doc/${doc.id}`) }, [
      scopeBadge(doc),
      el("span", {}, [doc.name]),
      el("span", { class: "tiny muted" }, [doc.id]),
    ])
  ));
}

function scopeBadge(doc) {
  const scope = doc.scope || "project";
  const variant = scope === "enterprise" ? "purple" : scope === "asset" ? "accent" : scope === "site" ? "warn" : "info";
  const title = scope === "enterprise" ? "Enterprise document: visible across the organization."
    : scope === "site" ? "Site document inherited from this asset's site."
    : scope === "asset" ? "Asset document directly linked to this asset."
    : "Project document inherited through this asset's project.";
  return badge(scope, variant, { title });
}

function signalHealthPanel(dataSources) {
  if (!dataSources.length) return el("div", { class: "muted tiny" }, ["No signal mappings yet."]);
  return el("div", { class: "stack" }, dataSources.map(ds => el("div", { class: "activity-row" }, [
    signalBadge(ds),
    el("span", { class: "mono tiny" }, [ds.endpoint]),
    el("span", { class: "tiny muted" }, [ds.lastValue || ds.quality || ds.integrationId]),
  ])));
}

function signalBadge(ds) {
  const status = ds.status || ds.quality || ds.kind;
  const label = status === "live" ? "Live"
    : status === "stale" ? "Stale"
    : status === "not_connected" ? "Not connected"
    : status === "simulated" ? "Simulated"
    : status === "historical" ? "Historical"
    : status;
  const title = `Source: ${ds.integrationId || "unknown"} · Quality: ${ds.quality || "unknown"} · Last seen: ${ds.lastSeen ? new Date(ds.lastSeen).toLocaleString() : "unknown"}`;
  return badge(label, dataVariant(status), { title });
}

function workMaintenancePanel(tasks, maintenance) {
  const rows = [
    ...tasks.map(w => ({ kind: w.type, text: `${w.id} · ${w.title}`, state: w.status, variant: w.severity === "high" ? "danger" : "info", title: "FORGE work item" })),
    ...maintenance.map(m => ({ kind: m.source, text: `${m.externalId || m.id} · ${m.title}`, state: `${m.status} · ${m.priority}`, variant: m.priority === "high" ? "danger" : "warn", title: `${m.source} sync: ${m.syncStatus || "unknown"}` })),
  ];
  if (!rows.length) return el("div", { class: "muted tiny" }, ["No work or service linked."]);
  return el("div", { class: "stack" }, rows.map(r => el("div", { class: "activity-row" }, [
    badge(r.kind, r.kind === "MaintainX" || r.kind === "SAP PM" || r.kind === "UpKeep" ? "purple" : "info", { title: r.title }),
    el("span", {}, [r.text]),
    badge(r.state, r.variant),
  ])));
}

function assetBriefCard(asset, context) {
  const brief = simulation.assetBrief(asset, context);
  return card("AI — What changed in 24h?", el("div", { class: "stack" }, [
    ...brief.bullets.map(text => el("div", { class: "small" }, [text])),
    el("div", { class: "tiny muted" }, ["Citations: ", brief.citations.join(", ")]),
  ]));
}

function assetTimeline(asset, ctx) {
  const rows = [
    ...ctx.linkedDocs.map(doc => ({ ts: revisionTs(doc.currentRevisionId), kind: "Document", text: `${doc.name} current revision`, route: `/doc/${doc.id}` })),
    ...ctx.tasks.map(w => ({ ts: w.due, kind: w.type, text: `${w.id} · ${w.title}`, route: `/work-board/${w.projectId}` })),
    ...ctx.maintenance.map(m => ({ ts: m.due, kind: "Service", text: `${m.source} · ${m.title}`, route: null })),
    ...ctx.incidents.flatMap(i => (i.timeline || []).map(t => ({ ts: t.ts, kind: "Incident", text: `${i.id} · ${t.text}`, route: `/incident/${i.id}` }))),
    ...ctx.dataSources.map(ds => ({ ts: ds.lastSeen, kind: "Signal", text: `${ds.endpoint} · ${ds.lastValue || ds.status}`, route: null })),
  ].filter(r => r.ts).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts)).slice(-10);
  if (!rows.length) return el("div", { class: "muted tiny" }, [`No timeline events for ${asset.id}.`]);
  return el("div", { class: "stack" }, rows.map(r => el(r.route ? "button" : "div", {
    class: "activity-row",
    onClick: r.route ? () => navigate(r.route) : null,
  }, [
    el("span", { class: "ts" }, [new Date(r.ts).toLocaleDateString()]),
    el("span", {}, [r.text]),
    badge(r.kind, "info"),
  ])));
}

function revisionTs(revId) {
  return (state.data.revisions || []).find(r => r.id === revId)?.createdAt || null;
}

function assignmentCard(a) {
  const users = state.data?.users || [];
  const userById = Object.fromEntries(users.map(u => [u.id, u]));
  const owner = a.assignedUserId ? userById[a.assignedUserId] : null;
  const grp = a.assignedGroupId ? getGroup(a.assignedGroupId) : null;
  return card("Assignment", el("div", { class: "stack" }, [
    el("div", { class: "row wrap" }, [
      el("div", { class: "stack", style: { gap: "2px" } }, [
        el("div", { class: "tiny muted" }, ["Owner (user)"]),
        owner
          ? el("div", { class: "row" }, [badge(owner.name, "accent"), el("span", { class: "tiny muted" }, [owner.role])])
          : el("span", { class: "muted small" }, ["Unassigned"]),
      ]),
      el("div", { class: "stack", style: { gap: "2px" } }, [
        el("div", { class: "tiny muted" }, ["Owner (group)"]),
        grp
          ? el("div", { class: "row" }, [badge(grp.name, "purple"), el("span", { class: "tiny muted" }, [grp.id])])
          : el("span", { class: "muted small" }, ["Unassigned"]),
      ]),
    ]),
    el("button", { class: "btn sm", onClick: () => editAssignment(a) }, ["Edit assignment"]),
    el("div", { class: "tiny muted" }, ["When set, only the assigned user or members of the assigned group (and Organization Owners) can see this asset."]),
  ]), { subtitle: "Assets can be assigned to a specific engineer or to a whole group." });
}

function editAssignment(a) {
  const users = state.data?.users || [];
  const groups = listGroups();
  const userSel = select([{ value: "", label: "(unassigned)" }, ...users.map(u => ({ value: u.id, label: `${u.name} — ${u.role}` }))], { value: a.assignedUserId || "" });
  const groupSel = select([{ value: "", label: "(unassigned)" }, ...groups.map(g => ({ value: g.id, label: g.name }))], { value: a.assignedGroupId || "" });
  modal({
    title: `Assign ${a.name}`,
    body: el("div", { class: "stack" }, [
      formRow("Assigned user", userSel),
      formRow("Assigned group", groupSel),
      el("div", { class: "tiny muted" }, ["Either, both, or neither. A user-only assignment makes the asset private to that user; a group makes it visible to all members of that group (and any sub-group descendant)."]),
    ]),
    actions: [
      { label: "Cancel" },
      { label: "Save", variant: "primary", onClick: () => {
        update(s => {
          const x = s.data.assets.find(y => y.id === a.id);
          if (!x) return;
          x.assignedUserId = userSel.value || null;
          x.assignedGroupId = groupSel.value || null;
        });
        audit("asset.assign", a.id, { userId: userSel.value || null, groupId: groupSel.value || null });
        toast("Assignment saved", "success");
      }},
    ],
  });
}

function telemetry(a) {
  const data = simulation.telemetrySeries(a);
  return el("div", { class: "stack" }, [
    sparkline(data, { width: 360, height: 90 }),
    el("div", { class: "row wrap" }, (a.mqttTopics || []).map(t => el("span", { class: "chip" }, [el("span", { class: "chip-kind" }, ["MQTT"]), t]))),
    el("div", { class: "row wrap" }, (a.opcuaNodes || []).map(n => el("span", { class: "chip" }, [el("span", { class: "chip-kind" }, ["OPC"]), n]))),
    el("div", { class: "tiny muted" }, ["Chart rendered by uPlot (MIT) with SVG fallback."]),
  ]);
}

function openWarRoom(a) {
  if (!can("incident.respond")) { toast("No incident capability", "warn"); return; }
  const existing = (state.data.incidents || []).find(i => i.assetId === a.id && i.status === "active");
  if (existing) return navigate(`/incident/${existing.id}`);
  const id = simulation.nextId("INC", state.data.incidents);
  const inc = {
    id,
    title: `${a.name} — new incident`,
    severity: "SEV-3",
    status: "active",
    assetId: a.id,
    commanderId: null,
    channelId: null,
    startedAt: new Date().toISOString(),
    timeline: [{ ts: new Date().toISOString(), actor: state.ui.role, text: "War room opened from asset page." }],
  };
  update(s => { s.data.incidents.push(inc); });
  audit("incident.create", id, { source: a.id });
  navigate(`/incident/${id}`);
}

function statusVariant(s) {
  return s === "alarm" ? "danger" : s === "warning" ? "warn" : s === "offline" ? "" : "success";
}

function dataVariant(s) {
  return s === "live" || s === "Good" || s === "connected" ? "success"
    : s === "stale" || s === "Uncertain" || s === "GoodNoData" ? "warn"
    : s === "not_connected" || s === "failed" || s === "disconnected" ? "danger"
    : "info";
}

function maintenanceVariant(s) {
  return s === "open" || s === "due" ? "danger"
    : s === "watch" || s === "planned" || s === "scheduled" ? "warn"
    : "success";
}

function unsCard(asset) {
  let srv;
  try { srv = getServer(); } catch { return null; }
  // Find the UNS equipment object for this asset via alias.
  const obj = srv.resolveObject(asset.id);
  if (!obj) return null;
  const val = srv.queryLastKnownValues({ elementIds: [obj.elementId], maxDepth: 2 }).results[0]?.result;
  const variables = Object.entries(val?.components || {});

  return card("Unified Namespace · i3X", el("div", { class: "stack" }, [
    el("div", { class: "row wrap" }, [
      chip(obj.path, { kind: "UNS path" }),
      chip(obj.elementId, { kind: "i3X elementId" }),
      chip(obj.typeElementId, { kind: "type" }),
    ]),
    variables.length
      ? el("div", { class: "stack" }, variables.map(([name, vq]) =>
          el("div", { class: "activity-row" }, [
            el("span", { class: "mono tiny" }, [name]),
            el("span", { class: "strong" }, [String(vq.value ?? "—")]),
            badge(vq.quality || "", vq.quality === "Good" ? "success" : vq.quality === "Uncertain" ? "warn" : ""),
            el("span", { class: "tiny muted" }, [vq.timestamp ? new Date(vq.timestamp).toLocaleTimeString() : ""]),
          ])
        ))
      : el("div", { class: "muted tiny" }, ["No variables bound."]),
    el("div", { class: "row" }, [
      el("button", { class: "btn sm", onClick: () => navigate("/uns") }, ["Open in UNS →"]),
      el("button", { class: "btn sm", onClick: () => navigate(`/i3x?ep=value`) }, ["Try /objects/value →"]),
    ]),
  ]), { subtitle: "Same asset, canonical UNS address, live VQT from the i3X engine." });
}
