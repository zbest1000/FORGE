// Admin Governance Console v2 — spec §11.16, §13, §14.
//
// Features:
//   * SSO/SCIM/MFA surface
//   * RBAC capability matrix (existing)
//   * Retention editor (per scope, legal hold toggle)
//   * Access review flow (list users, sign off)
//   * Export audit pack (signed) — uses core/audit.exportAuditPack
//   * Audit ledger tamper check (verifyLedger) with visible result
//   * Policy violations list

import { el, mount, card, badge, toast, modal, formRow, input, select } from "../core/ui.js";
import { state, update } from "../core/store.js";
import { ROLES } from "../core/permissions.js";
import { exportAuditPack, verifyLedger, verifyAuditPack } from "../core/audit.js";
import { canonicalJSON } from "../core/crypto.js";

export function renderAdmin() {
  const root = document.getElementById("screenContainer");
  const d = state.data;

  mount(root, [
    el("div", { class: "two-col" }, [
      card("Identity (SSO / SCIM / MFA)", el("div", { class: "stack" }, [
        el("div", { class: "row wrap" }, [
          badge("SAML SSO: connected", "success"),
          badge("OIDC: disabled", ""),
          badge("SCIM: connected", "success"),
          badge("MFA: enforced", "success"),
        ]),
        el("div", { class: "tiny muted" }, ["IdP: Keycloak-compatible · Realm: atlas-prod · SCIM endpoint: /scim/v2"]),
      ])),
      card("Retention & compliance", el("div", { class: "stack" }, retentionEditor(d))),
    ]),
    card("RBAC matrix (roles × capabilities)", rbacMatrix()),
    card("Audit ledger", auditPanel()),
    card("Access review", accessReviewPanel(d)),
    card("Policy violations", policyPanel(d)),
  ]);
}

function retentionEditor(d) {
  const rows = (d.retentionPolicies || []).map(rp => el("div", { class: "activity-row" }, [
    badge(rp.id, "info"),
    el("div", { class: "stack", style: { gap: "2px", flex: 1 } }, [
      el("span", { class: "small" }, [rp.name]),
      el("span", { class: "tiny muted" }, [`scope: ${rp.scope} · ${rp.days} days`]),
    ]),
    rp.legalHold ? badge("legal hold", "warn") : null,
    el("button", { class: "btn sm", onClick: () => editRetention(rp) }, ["Edit"]),
  ]));
  return [
    ...rows,
    el("button", { class: "btn sm primary", onClick: addRetention }, ["+ Policy"]),
  ];
}

function editRetention(rp) {
  const days = input({ value: String(rp.days) });
  const legal = select(["false","true"], { value: String(rp.legalHold) });
  modal({
    title: `Edit ${rp.name}`,
    body: el("div", { class: "stack" }, [
      formRow("Retention (days)", days),
      formRow("Legal hold", legal),
    ]),
    actions: [
      { label: "Cancel" },
      { label: "Save", variant: "primary", onClick: () => {
        update(s => {
          const x = s.data.retentionPolicies.find(y => y.id === rp.id);
          if (!x) return;
          x.days = Number(days.value);
          x.legalHold = legal.value === "true";
        });
        toast("Policy updated", "success");
      }},
    ],
  });
}

function addRetention() {
  const name = input({ placeholder: "Policy name" });
  const scope = select(["auditEvents","messages","revisions","workItems","incidents","documents"]);
  const days = input({ value: "365" });
  modal({
    title: "New retention policy",
    body: el("div", { class: "stack" }, [
      formRow("Name", name), formRow("Scope", scope), formRow("Retention (days)", days),
    ]),
    actions: [
      { label: "Cancel" },
      { label: "Create", variant: "primary", onClick: () => {
        update(s => {
          s.data.retentionPolicies.push({
            id: "RP-" + Math.floor(Math.random() * 900 + 100),
            name: name.value, scope: scope.value, days: Number(days.value), legalHold: false,
          });
        });
      }},
    ],
  });
}

function rbacMatrix() {
  const caps = ["view", "create", "edit", "approve", "integration.write", "ai.configure", "incident.command"];
  return el("table", { class: "table" }, [
    el("thead", {}, [el("tr", {}, ["Role", ...caps].map(c => el("th", {}, [c])))]),
    el("tbody", {}, ROLES.map(role => {
      const lookup = cap => role === "Organization Owner" ? "✓"
        : role === "Workspace Admin" && cap !== "integration.write" ? "✓"
        : role === "Engineer/Contributor" && ["view","create","edit"].includes(cap) ? "✓"
        : role === "Reviewer/Approver" && ["view","approve"].includes(cap) ? "✓"
        : role === "Integration Admin" && ["view","integration.write"].includes(cap) ? "✓"
        : role === "AI Admin" && ["view","ai.configure"].includes(cap) ? "✓"
        : role === "Operator/Technician" && cap === "view" ? "✓"
        : role === "Viewer/Auditor" && cap === "view" ? "✓"
        : role === "Team Space Admin" && ["view","create","edit","approve","ai.configure"].includes(cap) ? "✓"
        : "";
      return el("tr", {}, [
        el("td", { class: "small" }, [role]),
        ...caps.map(c => el("td", { class: "center tiny" }, [lookup(c)])),
      ]);
    })),
  ]);
}

function auditPanel() {
  const events = (state.data.auditEvents || []);
  return el("div", { class: "stack" }, [
    el("div", { class: "row wrap" }, [
      badge(`${events.length} events`, "info"),
      el("button", { class: "btn sm", onClick: async () => {
        const r = await verifyLedger();
        toast(r.ok ? `Ledger intact: ${r.strictCount} strict + ${r.legacyCount} legacy` : `Tamper detected: ${r.reason}`, r.ok ? "success" : "danger");
      } }, ["Verify ledger"]),
      el("button", { class: "btn sm primary", onClick: async () => doExport() }, ["Export audit pack (signed)"]),
      el("button", { class: "btn sm", onClick: () => verifyPackFile() }, ["Verify an audit pack file"]),
    ]),
    el("div", { class: "tiny muted" }, ["Ledger is hash-chained with SHA-256. Exported packs are signed with HMAC-SHA256 (demo tenant key)."]),
    ...events.slice(0, 10).map(e => el("div", { class: "activity-row" }, [
      el("span", { class: "ts mono" }, [new Date(e.ts).toLocaleString()]),
      el("span", { class: "small" }, [`${e.action} on ${e.subject}`]),
      el("span", { class: "tiny muted" }, [e.actor]),
    ])),
  ]);
}

async function doExport() {
  const pack = await exportAuditPack();
  const blob = new Blob([canonicalJSON(pack)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `forge-audit-pack-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  toast(`Audit pack exported (${pack.entry_count} entries)`, "success");
}

function verifyPackFile() {
  const fi = document.createElement("input");
  fi.type = "file";
  fi.accept = "application/json";
  fi.addEventListener("change", async () => {
    const f = fi.files?.[0];
    if (!f) return;
    const txt = await f.text();
    try {
      const pack = JSON.parse(txt);
      const ok = await verifyAuditPack(pack);
      toast(ok ? `Verified: ${pack.entry_count} entries` : "Signature invalid", ok ? "success" : "danger");
    } catch (e) {
      toast("Parse error: " + e.message, "danger");
    }
  });
  fi.click();
}

function accessReviewPanel(d) {
  return el("div", { class: "stack" }, [
    el("div", { class: "tiny muted" }, ["Periodic access review: sign off that each user's role is appropriate."]),
    ...((d.users || []).map(u => el("div", { class: "activity-row" }, [
      el("span", { class: "mono tiny" }, [u.id]),
      el("span", { class: "small", style: { flex: 1 } }, [u.name]),
      badge(u.role, "info"),
      u.reviewedAt ? badge("reviewed " + new Date(u.reviewedAt).toLocaleDateString(), "success") : null,
      el("button", { class: "btn sm", onClick: () => signOff(u) }, ["Sign off"]),
    ]))),
    el("div", { class: "row" }, [
      el("button", { class: "btn sm primary", onClick: () => signOffAll() }, ["Sign off all"]),
    ]),
  ]);
}

function signOff(u) {
  update(s => { const x = s.data.users.find(y => y.id === u.id); if (x) x.reviewedAt = new Date().toISOString(); });
  toast(`${u.name} reviewed`, "success");
}
function signOffAll() {
  update(s => { for (const u of (s.data.users || [])) u.reviewedAt = new Date().toISOString(); });
  toast("All users reviewed", "success");
}

function policyPanel(d) {
  const violations = d.policyViolations || [];
  if (!violations.length) {
    return el("div", { class: "muted tiny" }, ["No high-severity violations in last 30 days."]);
  }
  return el("div", { class: "stack" }, violations.map(v => el("div", { class: "activity-row" }, [
    badge(v.severity, v.severity === "high" ? "danger" : "warn"),
    el("span", { class: "small" }, [v.text]),
    badge(v.status, "info"),
  ])));
}
