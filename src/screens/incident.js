import { el, mount, card, badge, toast, textarea } from "../core/ui.js";
import { state, update, getById, audit } from "../core/store.js";
import { navigate } from "../core/router.js";
import { can } from "../core/permissions.js";

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

export function renderIncident({ id }) {
  const root = document.getElementById("screenContainer");
  const d = state.data;
  const inc = getById("incidents", id);
  if (!inc) return mount(root, el("div", { class: "muted" }, ["Incident not found."]));

  const asset = inc.assetId ? getById("assets", inc.assetId) : null;
  const channel = inc.channelId ? getById("channels", inc.channelId) : null;

  const entryInput = textarea({ placeholder: "Log a timeline entry (Enter to commit, Shift+Enter for newline)" });
  entryInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      addEntry(entryInput.value);
      entryInput.value = "";
    }
  });

  mount(root, [
    severityBar(inc),
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
          el("div", { class: "row" }, [
            el("button", { class: "btn sm primary", disabled: !can("incident.respond"), onClick: () => { addEntry(entryInput.value); entryInput.value = ""; } }, ["Log entry"]),
            el("button", { class: "btn sm", disabled: !can("incident.command"), onClick: () => changeSeverity(inc) }, ["Change severity"]),
            el("button", { class: "btn sm", disabled: !can("incident.command"), onClick: () => changeStatus(inc) }, ["Change status"]),
          ]),
        ])),
      ]),
      el("div", { class: "stack" }, [
        card("Asset context", asset ? el("div", { class: "stack" }, [
          el("div", { class: "strong" }, [asset.name]),
          el("div", { class: "tiny muted" }, [asset.hierarchy]),
          el("button", { class: "btn sm", onClick: () => navigate(`/asset/${asset.id}`) }, ["Open asset →"]),
        ]) : el("div", { class: "muted tiny" }, ["No asset linked."])),
        card("Command roster", el("div", { class: "stack" }, [
          el("div", {}, ["Commander: ", inc.commanderId || "(unassigned)"]),
          el("button", { class: "btn sm", disabled: !can("incident.command"), onClick: () => assignCommander(inc) }, ["Assign commander"]),
        ])),
        card("Linked channel", channel ? el("div", { class: "stack" }, [
          el("div", {}, [`#${channel.name}`]),
          el("button", { class: "btn sm", onClick: () => navigate(`/channel/${channel.id}`) }, ["Open channel →"]),
        ]) : el("div", { class: "muted tiny" }, ["No channel linked."])),
        card("AI — Recommended next steps", el("div", { class: "stack" }, [
          el("div", { class: "small" }, ["• Reduce feed rate, validate HX-01 tube integrity, cross-check alarm log against OPC UA node HX01.Temp."]),
          el("div", { class: "small" }, ["• Issue CAPA and link to work item if confirmed fouling."]),
          el("div", { class: "tiny muted" }, ["Citations: AS-1, DS-1, DS-3"]),
        ])),
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

function severityBar(inc) {
  return el("div", { class: "incident-severity-bar" }, [
    el("span", { class: "sev-chip" }, [inc.severity]),
    el("div", { style: { flex: 1 } }, [
      el("h2", {}, [inc.title]),
      el("div", { class: "tiny muted" }, [`Started ${new Date(inc.startedAt).toLocaleString()} · ${inc.id}`]),
    ]),
    badge(inc.status.toUpperCase(), inc.status === "active" ? "danger" : "success"),
  ]);
}

function changeSeverity(inc) {
  const next = window.prompt("New severity (SEV-1..SEV-4):", inc.severity);
  if (!next) return;
  update(s => {
    const i = s.data.incidents.find(x => x.id === inc.id);
    if (i) i.severity = next;
  });
  audit("incident.severity", inc.id, { to: next });
}

function changeStatus(inc) {
  const next = window.prompt("New status (active / escalated / stabilized / resolved / postmortem):", inc.status);
  if (!next) return;
  update(s => {
    const i = s.data.incidents.find(x => x.id === inc.id);
    if (i) i.status = next;
    i.timeline = i.timeline || [];
    i.timeline.push({ ts: new Date().toISOString(), actor: s.ui.role, text: `Status changed to ${next}.` });
  });
  audit("incident.status", inc.id, { to: next });
}

function assignCommander(inc) {
  const userId = window.prompt("Commander user ID (e.g. U-4):", inc.commanderId || "U-4");
  if (!userId) return;
  update(s => {
    const i = s.data.incidents.find(x => x.id === inc.id);
    if (i) i.commanderId = userId;
    i.timeline = i.timeline || [];
    i.timeline.push({ ts: new Date().toISOString(), actor: s.ui.role, text: `Commander assigned: ${userId}.` });
  });
  audit("incident.commander", inc.id, { userId });
}
