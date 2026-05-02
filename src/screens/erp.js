// ERP Integration Mapping v2 — spec §11.12 and §10 #6.
//
// Features:
//   * Mapping matrix: ERP entities ↔ FORGE entities with transform rules
//   * Conflict queue with accept/override flow
//   * Backfill preview: show rows that would be created or updated
//   * Writeback preview: the exact payload that would be sent to ERP
//   * All writes gated by permissions and audited

import { el, mount, card, badge, toast, modal, formRow, textarea, input, confirm } from "../core/ui.js";
import { state, update } from "../core/store.js";
import { audit } from "../core/audit.js";
import { can } from "../core/permissions.js";
import { ingest } from "../core/events.js";
import { helpHint, helpLinkChip } from "../core/help.js";

const SEED_MAPPINGS = [
  { erp: "PurchaseOrder", forge: "WorkItem(RFI)",    status: "in-sync", lastSync: "2 min ago",  conflicts: 0 },
  { erp: "WorkOrder",     forge: "WorkItem(Task)",   status: "drift",   lastSync: "15 min ago", conflicts: 2 },
  { erp: "InventoryItem", forge: "Asset",            status: "in-sync", lastSync: "30 min ago", conflicts: 0 },
  { erp: "CostCenter",    forge: "TeamSpace",        status: "conflict",lastSync: "1 hr ago",   conflicts: 3 },
];

// Each conflict carries a full snapshot of both records so the
// "View differences" modal can show the entire side-by-side diff,
// not just the single conflicting field. The `field` named on the
// conflict is the field that triggered the queue entry; other fields
// may also differ and the diff view surfaces them all.
const SEED_CONFLICTS = [
  {
    id: "ERP-C-1", erp: "WorkOrder", externalId: "WO-99221",
    field: "assignee", erpValue: "jsingh", forgeValue: "U-1", resolved: false,
    erpRecord: {
      id: "WO-99221", subject: "Inspect HX-01 outlet temperature alarm",
      assignee: "jsingh", priority: 2, status: "open",
      due_date: "2026-05-08", cost_center: "CC-210",
      created_at: "2026-04-30T10:12:00Z", updated_at: "2026-05-02T08:55:00Z",
    },
    forgeRecord: {
      id: "WI-101", title: "Verify terminal wiring A01-W",
      assigneeId: "U-1", severity: "medium", status: "In Progress",
      due: "2026-05-08", projectId: "PRJ-1",
      createdAt: "2026-04-30T10:12:00Z", updatedAt: "2026-05-02T07:01:00Z",
    },
  },
  {
    id: "ERP-C-2", erp: "WorkOrder", externalId: "WO-99222",
    field: "due_date", erpValue: "2026-05-10", forgeValue: "2026-05-15", resolved: false,
    erpRecord: {
      id: "WO-99222", subject: "P&ID Package 3 — utilities revision",
      assignee: "rokafor", priority: 3, status: "in_progress",
      due_date: "2026-05-10", cost_center: "CC-210",
      created_at: "2026-04-22T09:00:00Z", updated_at: "2026-05-01T14:32:00Z",
    },
    forgeRecord: {
      id: "WI-102", title: "Missing terminal strip at TB-3",
      assigneeId: "U-2", severity: "high", status: "In Review",
      due: "2026-05-15", projectId: "PRJ-2",
      createdAt: "2026-04-22T09:00:00Z", updatedAt: "2026-04-30T11:42:00Z",
    },
  },
  {
    id: "ERP-C-3", erp: "CostCenter", externalId: "CC-210",
    field: "name", erpValue: "Controls East", forgeValue: "Controls Engineering", resolved: false,
    erpRecord: {
      id: "CC-210", code: "CC-210", name: "Controls East",
      owner: "lpatel", region: "NA-East", active: true,
      created_at: "2024-01-15T00:00:00Z", updated_at: "2026-04-12T08:00:00Z",
    },
    forgeRecord: {
      id: "TS-1", code: "CC-210", name: "Controls Engineering",
      ownerId: "U-2", region: "NA-East", active: true,
      createdAt: "2024-01-15T00:00:00Z", updatedAt: "2026-03-01T08:00:00Z",
    },
  },
];

export function renderERP() {
  const root = document.getElementById("screenContainer");
  const d = state.data;
  if (!d.erpMappings) update(s => { s.data.erpMappings = SEED_MAPPINGS.slice(); s.data.erpConflicts = SEED_CONFLICTS.slice(); });

  const mappings = d.erpMappings || SEED_MAPPINGS;
  const conflicts = d.erpConflicts || SEED_CONFLICTS;

  mount(root, [
    el("div", { style: { marginBottom: "12px" } }, [
      el("h2", { style: { display: "inline-flex", alignItems: "center", margin: 0, fontSize: "18px" } }, [
        "ERP integration", helpHint("forge.erp.mapping"),
      ]),
      el("div", { class: "tiny muted" }, ["Bidirectional ERP↔FORGE entity map with conflict resolution and backfill."]),
      el("div", { class: "row wrap", style: { gap: "6px", marginTop: "6px" } }, [
        helpLinkChip("forge.erp.mapping", "Mapping matrix"),
        helpLinkChip("forge.erp.drift", "Drift vs conflict"),
        helpLinkChip("forge.erp.backfill", "Backfill"),
      ]),
    ]),
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
          c.resolved ? null : el("div", { class: "row wrap" }, [
            el("button", { class: "btn sm primary", disabled: !can("integration.write"), onClick: () => resolveConflict(c, "erp") }, ["Accept ERP"]),
            el("button", { class: "btn sm", disabled: !can("integration.write"), onClick: () => resolveConflict(c, "forge") }, ["Keep FORGE"]),
            el("button", { class: "btn sm", onClick: () => viewDifferences(c) }, ["View differences"]),
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

/**
 * Side-by-side diff modal. Computes the union of fields across both
 * records (ERP and FORGE) and renders a row per field, highlighting
 * rows where the values differ. The conflict's named field is
 * specifically marked so it stands out in the noise.
 */
function viewDifferences(c) {
  const erpRec   = c.erpRecord   || synthRecord(c, "erp");
  const forgeRec = c.forgeRecord || synthRecord(c, "forge");

  // Build the union of keys, preserving order: ERP record's keys first
  // (operators tend to think in the source-of-record's shape) then
  // anything FORGE has that ERP doesn't.
  const seen = new Set();
  /** @type {string[]} */
  const fields = [];
  for (const k of Object.keys(erpRec))   { if (!seen.has(k)) { seen.add(k); fields.push(k); } }
  for (const k of Object.keys(forgeRec)) { if (!seen.has(k)) { seen.add(k); fields.push(k); } }

  const equiv = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

  let differingCount = 0;
  const rows = fields.map(k => {
    const ev = erpRec[k];
    const fv = forgeRec[k];
    const same = equiv(ev, fv);
    if (!same) differingCount++;
    const isFocused = k === c.field;
    return el("tr", {
      class: `diff-row ${same ? "diff-same" : "diff-different"} ${isFocused ? "diff-focused" : ""}`,
    }, [
      el("td", { class: "mono tiny", style: { whiteSpace: "nowrap", color: same ? "var(--muted)" : "var(--text-strong)" } }, [
        k, isFocused ? el("span", { class: "tiny", style: { color: "var(--warn)", marginLeft: "4px" } }, ["⚑"]) : null,
      ]),
      el("td", { class: "mono tiny", style: { whiteSpace: "pre-wrap", wordBreak: "break-all" } }, [fmt(ev)]),
      el("td", { class: "mono tiny", style: { whiteSpace: "pre-wrap", wordBreak: "break-all" } }, [fmt(fv)]),
      el("td", { class: "tiny" }, [
        same
          ? el("span", { class: "muted" }, ["="])
          : el("span", { style: { color: "var(--danger)", fontWeight: 700 } }, ["≠"]),
      ]),
    ]);
  });

  modal({
    title: `Differences · ${c.erp} ${c.externalId}`,
    body: el("div", { class: "stack" }, [
      el("div", { class: "row wrap", style: { gap: "8px" } }, [
        badge(`${differingCount} differing`, differingCount > 0 ? "warn" : "success"),
        badge(`${fields.length} field${fields.length === 1 ? "" : "s"} compared`, "info"),
        c.field ? el("span", { class: "tiny muted" }, [`Triggering field: ${c.field}`]) : null,
      ]),
      el("div", { class: "diff-table-wrap", style: { maxHeight: "60vh", overflow: "auto", border: "1px solid var(--border)", borderRadius: "6px" } }, [
        el("table", { class: "table diff-table" }, [
          el("thead", {}, [el("tr", {}, [
            el("th", { style: { width: "20%" } }, ["Field"]),
            el("th", {}, [el("span", { class: "chip" }, [el("span", { class: "chip-kind" }, ["ERP"]), c.erp])]),
            el("th", {}, [el("span", { class: "chip" }, [el("span", { class: "chip-kind" }, ["FORGE"]), forgeRec?.id || "—"])]),
            el("th", { style: { width: "40px" } }, [""]),
          ])]),
          el("tbody", {}, rows),
        ]),
      ]),
      el("div", { class: "tiny muted" }, [
        "Rows with ≠ differ between systems. The triggering field is marked ⚑. ",
        "Use ", el("strong", {}, ["Accept ERP"]), " to overwrite FORGE with the ERP value, ",
        el("strong", {}, ["Keep FORGE"]), " to push FORGE's value back through the writeback queue.",
      ]),
    ]),
    actions: [
      { label: "Close" },
      { label: "Accept ERP", variant: "primary", onClick: () => {
        if (!can("integration.write")) { toast("Requires integration.write", "warn"); return; }
        resolveConflict(c, "erp");
      }},
      { label: "Keep FORGE", onClick: () => {
        if (!can("integration.write")) { toast("Requires integration.write", "warn"); return; }
        resolveConflict(c, "forge");
      }},
    ],
  });
}

// Build a minimal record from a conflict when the seed lacks the
// full snapshot. Enough to make the diff modal show something
// meaningful even for newly-arrived conflicts.
function synthRecord(c, side) {
  const base = { id: c.externalId, [c.field]: side === "erp" ? c.erpValue : c.forgeValue };
  return base;
}

function fmt(v) {
  if (v == null) return "—";
  if (typeof v === "object") return JSON.stringify(v, null, 2);
  return String(v);
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

async function commitBackfill() {
  if (!can("integration.write")) return;
  if (!await confirm({ title: "Commit backfill", message: "Commit backfill? This will create work items.", confirmLabel: "Commit", variant: "primary" })) return;
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
