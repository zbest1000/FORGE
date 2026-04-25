import { el, mount, card, badge } from "../core/ui.js";

// Preserves the screen-by-screen spec reference from the original prototype.

const SCREENS = {
  "Workspace Home":                { layout: ["Summary grid","Activity feed","Priority queues"], components: ["KPIs","Review queue","Incidents","Integration health"], states: ["normal","no-data","degraded","incident surge"], ai: ["Daily engineering brief"] },
  "Team Space Overview":           { layout: ["Header","Tabs","Recent activity"], components: ["Membership","Milestones","Revisions","Procedures"], states: ["active","archived","restricted"], ai: ["Blocker summary"] },
  "Channel w/ structured threads": { layout: ["Message stream","Thread drawer","Pinned objects"], components: ["Composer","Type badges","Decision markers"], states: ["live","read-only","incident-locked","external"], ai: ["Unread summary","Draft reply"] },
  "Work Board":                    { layout: ["Board/table toggle","Filters","Swimlanes"], components: ["Cards","SLA chips","Dependencies"], states: ["backlog","active","frozen"], ai: ["Priority rec","Due-date risk"] },
  "Document Viewer":               { layout: ["Canvas","Revision timeline","Metadata"], components: ["Page nav","Comment pins","Approval banner"], states: ["Draft","IFR","Approved","IFC","Superseded","Archived"], ai: ["Ask-document","Summarize changes"] },
  "Drawing Viewer":                { layout: ["Toolbar","Canvas","Object metadata"], components: ["Sheet nav","Markup palette","Measure tools"], states: ["view-only","markup-edit","compare-overlay"], ai: ["Changed-region detection"] },
  "Revision Compare":              { layout: ["Split panes","Diff legend","Metadata delta"], components: ["Opacity slider","Linked issues"], states: ["identical","changed","conflict"], ai: ["Impact explanation"] },
  "Asset Detail":                  { layout: ["Header","Tabs","Telemetry"], components: ["Hierarchy","Drawings","Tasks","Dashboards"], states: ["normal","warning","alarm","offline"], ai: ["24h change summary"] },
  "Integration Console":           { layout: ["Connector list","Config","Logs"], components: ["Health","Retry queue","Dead-letter"], states: ["connected","degraded","failed","maintenance"], ai: ["Failure cluster explainer"] },
  "MQTT Browser":                  { layout: ["Topic tree","Payload","Rules"], components: ["QoS/retain","Simulation"], states: ["subscribed","paused","disconnected"], ai: ["Taxonomy suggestions"] },
  "OPC UA Browser":                { layout: ["Session","Node tree","Mapping"], components: ["Datatype validator","Sampling"], states: ["active","cert-warn","unavailable"], ai: ["Semantic mappings"] },
  "ERP Mapping":                   { layout: ["Matrix","Transform","Sync status"], components: ["Conflict queue","Backfill","Preview"], states: ["in-sync","drift","conflict"], ai: ["Drift diagnosis"] },
  "Incident War Room":             { layout: ["Severity header","Timeline","Side column"], components: ["Alarm strip","Roster","Checklist"], states: ["active","escalated","stabilized","resolved","postmortem"], ai: ["Live summary","Next steps"] },
  "Approval Queue":                { layout: ["Queue","Preview","Signature"], components: ["SLA","Delegation","Templates"], states: ["pending","approved","rejected","expired","delegated"], ai: ["Risk summary"] },
  "AI Workspace":                  { layout: ["Thread","Citations","Templates"], components: ["Scope","Model router","History"], states: ["ready","limited","blocked"], ai: ["Primary workspace"] },
  "Admin Governance":              { layout: ["Policy nav","Settings","Audit analytics"], components: ["SSO","RBAC","Retention","DLP"], states: ["compliant","warning","violation"], ai: ["Policy impact explainer"] },
};

export function renderSpec() {
  const root = document.getElementById("screenContainer");
  mount(root, [
    card("Product spec reference", el("div", { class: "stack" }, [
      el("div", { class: "muted" }, ["Read-only summary of each required screen. The full spec lives in PRODUCT_SPEC.md."]),
    ])),
    el("div", { class: "card-grid", style: { marginTop: "12px" } }, Object.entries(SCREENS).map(([name, s]) => card(name, el("div", { class: "stack" }, [
      block("Layout", s.layout),
      block("Components", s.components),
      statesRow(s.states),
      block("AI", s.ai),
    ])))),
  ]);
}

function block(title, items) {
  return el("div", {}, [
    el("div", { class: "tiny muted", style: { marginBottom: "4px" } }, [title]),
    el("div", { class: "row wrap" }, (items || []).map(i => el("span", { class: "chip small" }, [i]))),
  ]);
}

function statesRow(states) {
  return el("div", {}, [
    el("div", { class: "tiny muted", style: { marginBottom: "4px" } }, ["States"]),
    el("div", { class: "row wrap" }, (states || []).map(s => badge(s, ""))),
  ]);
}
