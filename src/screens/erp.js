// ERP Integration Mapping v2 — spec §11.12 and §10 #6.
//
// Features:
//   * Mapping matrix: ERP entities ↔ FORGE entities with transform rules
//   * Conflict queue with accept/override flow
//   * Backfill preview: show rows that would be created or updated
//   * Writeback preview: the exact payload that would be sent to ERP
//   * All writes gated by permissions and audited

import { el, mount, card, badge, toast, modal, formRow, textarea, input } from "../core/ui.js";
import { state, update } from "../core/store.js";
import { audit } from "../core/audit.js";
import { can } from "../core/permissions.js";
import { ingest } from "../core/events.js";

const SEED_MAPPINGS = [
  { erp: "PurchaseOrder", forge: "WorkItem(RFI)",    status: "in-sync", lastSync: "2 min ago",  conflicts: 0 },
  { erp: "WorkOrder",     forge: "WorkItem(Task)",   status: "drift",   lastSync: "15 min ago", conflicts: 2 },
  { erp: "InventoryItem", forge: "Asset",            status: "in-sync", lastSync: "30 min ago", conflicts: 0 },
  { erp: "CostCenter",    forge: "TeamSpace",        status: "conflict",lastSync: "1 hr ago",   conflicts: 3 },
];

const SEED_CONFLICTS = [
  { id: "ERP-C-1", erp: "WorkOrder", externalId: "WO-99221", field: "assignee",  erpValue: "jsingh", forgeValue: "U-1", resolved: false },
  { id: "ERP-C-2", erp: "WorkOrder", externalId: "WO-99222", field: "due_date",  erpValue: "2026-05-10", forgeValue: "2026-05-15", resolved: false },
  { id: "ERP-C-3", erp: "CostCenter",externalId: "CC-210",   field: "name",      erpValue: "Controls East", forgeValue: "Controls Engineering", resolved: false },
];

export function renderERP() {
  const root = document.getElementById("screenContainer");
  const d = state.data;
  if (!d.erpMappings) update(s => { s.data.erpMappings = SEED_MAPPINGS.slice(); s.data.erpConflicts = SEED_CONFLICTS.slice(); });

  const mappings = d.erpMappings || SEED_MAPPINGS;
  const conflicts = d.erpConflicts || SEED_CONFLICTS;

  mount(root, [
    card("Mapping matrix", el("table", { class: "table" }, [
      el("thead", {}, [el("tr", {}, ["ERP entity","FORGE entity","Status","Last sync","Conflicts",""].map(h => el("th", {}, [h])))]),
      el("tbody", {}, mappings.map(m =>
        el("tr", {}, [
          el("td", { class: "mono" }, [m.erp]),
          el("td", { class: "mono" }, [m.forge]),
          el("td", {}, [badge(m.status, m.status === "in-sync" ? "success" : m.status === "conflict" ? "danger" : "warn")]),
          el("td", { class: "tiny muted" }, [m.lastSync]),
          el("td", {}, [m.conflicts ? badge(String(m.conflicts), "warn") : "—"]),
          el("td", {}, [el("button", { class: "btn sm", onClick: () => showTransform(m) }, ["Transform"])]),
        ])
      )),
    ])),

    el("div", { class: "two-col", style: { marginTop: "16px" } }, [
      card(`Conflict queue (${conflicts.filter(c => !c.resolved).length})`, el("div", { class: "stack" }, [
        ...conflicts.map(c => el("div", { class: "approval-card", style: { padding: "10px 12px" } }, [
          el("div", { class: "row spread" }, [
            el("div", {}, [
              el("div", { class: "strong small" }, [`${c.erp} · ${c.externalId}`]),
              el("div", { class: "tiny muted" }, [`Field: ${c.field}`]),
            ]),
            badge(c.resolved ? "resolved" : "open", c.resolved ? "success" : "warn"),
          ]),
          el("div", { class: "row wrap", style: { gap: "6px" } }, [
            el("span", { class: "chip" }, [el("span", { class: "chip-kind" }, ["ERP"]), c.erpValue]),
            el("span", { class: "chip" }, [el("span", { class: "chip-kind" }, ["FORGE"]), c.forgeValue]),
          ]),
          c.resolved ? null : el("div", { class: "row" }, [
            el("button", { class: "btn sm primary", disabled: !can("integration.write"), onClick: () => resolveConflict(c, "erp") }, ["Accept ERP"]),
            el("button", { class: "btn sm", disabled: !can("integration.write"), onClick: () => resolveConflict(c, "forge") }, ["Keep FORGE"]),
            el("button", { class: "btn sm ghost", onClick: () => previewWriteback(c) }, ["Preview writeback"]),
          ]),
        ])),
      ])),

      card("Backfill", el("div", { class: "stack" }, [
        el("div", { class: "tiny muted" }, ["Dry-run a backfill to see which rows would be created or updated."]),
        el("button", { class: "btn sm primary", disabled: !can("integration.write"), onClick: () => runBackfill() }, ["Run backfill (dry)"]),
        el("button", { class: "btn sm danger", disabled: !can("integration.write"), onClick: () => commitBackfill() }, ["Commit backfill"]),
      ])),
    ]),

    el("div", { style: { marginTop: "16px" } }, [
      card("AI — Drift diagnosis", el("div", { class: "stack" }, [
        el("div", { class: "small" }, [
          "Drift clusters in WorkOrder mappings correlate with ERP PO prefix `CAPEX-` — recommend adding explicit prefix rule.",
        ]),
      ])),
    ]),
  ]);
}

function showTransform(mapping) {
  const code = textarea({
    value: `// Transform for ${mapping.erp} → ${mapping.forge}\nreturn {\n  id: \"WI-\" + erp.id,\n  title: erp.subject,\n  assigneeId: lookupUser(erp.assignee),\n  due: erp.due_date,\n  severity: erp.priority >= 3 ? \"high\" : \"medium\"\n};`,
  });
  modal({
    title: `${mapping.erp} → ${mapping.forge}`,
    body: el("div", { class: "stack" }, [
      formRow("Transform (read-only)", code),
    ]),
    actions: [{ label: "Close" }],
  });
}

function resolveConflict(c, direction) {
  update(s => {
    const x = (s.data.erpConflicts || []).find(y => y.id === c.id);
    if (!x) return;
    x.resolved = true;
    x.resolution = direction;
  });
  audit("erp.conflict.resolve", c.id, { direction });

  // Route a synthetic ERP event so the event engine creates/updates the FORGE object.
  ingest({
    event_type: direction === "erp" ? "erp.overwrite" : "erp.keep",
    severity: "info",
    asset_ref: null,
    payload: { conflictId: c.id, erp: c.erp, externalId: c.externalId, field: c.field, accepted: direction === "erp" ? c.erpValue : c.forgeValue },
    dedupe_key: `erp:${c.id}:${direction}`,
  }, { source: "erp:s4", source_type: "erp" });

  toast(`Conflict ${c.id} resolved (${direction})`, "success");
}

function previewWriteback(c) {
  const payload = {
    to: "erp.s4",
    entity: c.erp,
    externalId: c.externalId,
    patch: { [c.field]: c.forgeValue },
    signed_at: new Date().toISOString(),
  };
  modal({
    title: "Writeback preview",
    body: el("pre", { class: "mono tiny", style: { background: "var(--panel)", padding: "12px", borderRadius: "6px" } }, [JSON.stringify(payload, null, 2)]),
    actions: [{ label: "Close" }],
  });
}

function runBackfill() {
  const rows = [
    { action: "create", entity: "WorkItem", from: "PurchaseOrder WO-99240" },
    { action: "create", entity: "WorkItem", from: "PurchaseOrder WO-99241" },
    { action: "update", entity: "Asset", from: "InventoryItem INV-5501 (rename)" },
  ];
  modal({
    title: "Backfill dry-run",
    body: el("div", { class: "stack" }, [
      el("div", { class: "tiny muted" }, ["No data was changed. This is the preview of what `Commit` would do."]),
      el("table", { class: "table" }, [
        el("thead", {}, [el("tr", {}, [el("th", {}, ["Action"]), el("th", {}, ["Entity"]), el("th", {}, ["From"])])]),
        el("tbody", {}, rows.map(r => el("tr", {}, [
          el("td", {}, [badge(r.action, r.action === "create" ? "success" : "info")]),
          el("td", {}, [r.entity]),
          el("td", { class: "tiny muted" }, [r.from]),
        ]))),
      ]),
    ]),
    actions: [{ label: "Close" }],
  });
  audit("erp.backfill.dry", "erp.s4", { rows: rows.length });
}

function commitBackfill() {
  if (!can("integration.write")) return;
  if (!window.confirm("Commit backfill? This will create work items.")) return;
  // Route two synthetic PO events.
  for (let i = 0; i < 2; i++) {
    ingest({
      event_type: "po.created",
      severity: "info",
      payload: { title: `ERP PO backfill ${i + 1}` },
      dedupe_key: `erp:backfill:${Date.now()}:${i}`,
    }, { source: "erp:s4", source_type: "erp" });
  }
  audit("erp.backfill.commit", "erp.s4", { count: 2 });
  toast("Backfill committed — 2 work items created", "success");
}
