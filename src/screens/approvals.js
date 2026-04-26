// Approval queue v2 — spec §11.14.
//
// Features:
//   * SLA timers with visible countdown and automatic expiry detection
//   * Delegation: transfer to another approver with audit trail
//   * Batch approve / reject with confirmation
//   * Signed chain-of-custody: each decision records an HMAC-SHA256 signature
//     over the canonical decision payload so tampering is detectable
//   * Cascade: approving a Revision promotes it through the lifecycle
//   * Object preview pane (spec layout: queue + preview)
//   * Approver matrix enforcement via permissions.can()

import { el, mount, card, badge, toast, drawer, formRow, textarea, select, dangerAction, modal } from "../core/ui.js";
import { state, update, getById } from "../core/store.js";
import { audit } from "../core/audit.js";
import { navigate } from "../core/router.js";
import { can } from "../core/permissions.js";
import { signHMAC, canonicalJSON } from "../core/crypto.js";
import { transition } from "../core/revisions.js";
import { cascadeOnApprove } from "../core/fsm/revision.js";

export function renderApprovals() {
  const root = document.getElementById("screenContainer");
  const d = state.data;
  const approvals = d.approvals || [];
  const filter = sessionStorage.getItem("approvals.filter") || "pending";
  const selectedId = sessionStorage.getItem("approvals.selected") || approvals[0]?.id;
  expireOverdue();

  const filtered = approvals.filter(a => filter === "all" || a.status === filter);
  const selected = filtered.find(a => a.id === selectedId) || filtered[0];
  const batchIds = JSON.parse(sessionStorage.getItem("approvals.batch") || "[]");

  mount(root, [
    el("div", { class: "row spread", style: { marginBottom: "12px" } }, [
      el("div", {}, [
        el("div", { class: "strong" }, ["Approval queue"]),
        el("div", { class: "tiny muted" }, [
          `${approvals.filter(a => a.status === "pending").length} pending · ${approvals.filter(a => a.status === "expired").length} expired · ${approvals.length} total`,
        ]),
      ]),
      el("div", { class: "row" }, [
        ...["pending","approved","rejected","expired","delegated","all"].map(f => el("button", {
          class: `btn sm ${filter === f ? "primary" : ""}`,
          onClick: () => { sessionStorage.setItem("approvals.filter", f); renderApprovals(); },
        }, [f])),
      ]),
    ]),

    el("div", { class: "row wrap", style: { marginBottom: "12px" } }, [
      el("span", { class: "tiny muted" }, [`Batch: ${batchIds.length} selected`]),
      el("button", { class: "btn sm primary", disabled: !batchIds.length || !can("approve"), onClick: () => batchDecide("approved") }, ["Batch approve"]),
      el("button", { class: "btn sm danger", disabled: !batchIds.length || !can("approve"), onClick: () => batchDecide("rejected") }, ["Batch reject"]),
      el("button", { class: "btn sm", disabled: !batchIds.length, onClick: () => { sessionStorage.setItem("approvals.batch", "[]"); renderApprovals(); } }, ["Clear"]),
    ]),

    el("div", { class: "two-col" }, [
      queueTable(filtered, selectedId, batchIds),
      previewPane(selected),
    ]),
  ]);
}

function queueTable(list, selectedId, batchIds) {
  return card("Queue", el("table", { class: "table" }, [
    el("thead", {}, [el("tr", {}, [
      el("th", {}, [""]),
      el("th", {}, ["ID"]),
      el("th", {}, ["Subject"]),
      el("th", {}, ["Status"]),
      el("th", {}, ["SLA"]),
      el("th", {}, ["Approvers"]),
    ])]),
    el("tbody", {}, list.map(a => el("tr", {
      class: `row-clickable ${a.id === selectedId ? "active" : ""}`,
      style: { background: a.id === selectedId ? "var(--elevated)" : "" },
      onClick: () => { sessionStorage.setItem("approvals.selected", a.id); renderApprovals(); },
    }, [
      el("td", { onClick: (e) => e.stopPropagation() }, [checkbox(a.id, batchIds)]),
      el("td", { class: "mono small" }, [a.id]),
      el("td", { class: "small" }, [`${a.subject.kind} ${a.subject.id}`]),
      el("td", {}, [statusBadge(a)]),
      el("td", {}, [slaChip(a)]),
      el("td", { class: "tiny muted" }, [(a.approvers || []).join(", ")]),
    ]))),
  ]));
}

function checkbox(id, batchIds) {
  const checked = batchIds.includes(id);
  const box = el("input", { type: "checkbox", checked, onChange: () => toggleBatch(id) });
  return box;
}
function toggleBatch(id) {
  const batch = JSON.parse(sessionStorage.getItem("approvals.batch") || "[]");
  const set = new Set(batch);
  if (set.has(id)) set.delete(id); else set.add(id);
  sessionStorage.setItem("approvals.batch", JSON.stringify([...set]));
  renderApprovals();
}

function statusBadge(a) {
  const v = a.status === "approved" ? "success" : a.status === "rejected" ? "danger" : a.status === "expired" ? "warn" : a.status === "delegated" ? "info" : "warn";
  return badge(a.status, v);
}

function slaChip(a) {
  if (a.status !== "pending") return el("span", { class: "tiny muted" }, ["—"]);
  const remain = Date.parse(a.dueTs) - Date.now();
  if (Number.isNaN(remain)) return el("span", { class: "tiny muted" }, ["—"]);
  const hours = remain / 3_600_000;
  if (hours < 0) return badge("expired", "danger");
  if (hours < 4) return badge(`${hours.toFixed(1)}h`, "danger");
  if (hours < 24) return badge(`${hours.toFixed(1)}h`, "warn");
  const days = hours / 24;
  return badge(`${days.toFixed(1)}d`, "info");
}

function previewPane(a) {
  if (!a) return card("Preview", el("div", { class: "muted" }, ["No approval selected."]));
  const subj = resolveSubject(a.subject);
  const chain = (a.chain || []);
  return card("Preview & decision", el("div", { class: "stack" }, [
    el("div", { class: "row wrap" }, [
      badge(a.subject.kind, "info"),
      el("span", { class: "mono small" }, [a.subject.id]),
      subj.route ? el("button", { class: "btn sm", onClick: () => navigate(subj.route) }, ["Open subject →"]) : null,
    ]),
    subj.detail,
    el("div", {}, [
      el("div", { class: "tiny muted" }, ["Chain of custody"]),
      chain.length ? el("div", { class: "stack", style: { gap: "2px" } }, chain.map(step =>
        el("div", { class: "activity-row" }, [
          el("span", { class: "ts" }, [new Date(step.ts).toLocaleString()]),
          el("span", { class: "small" }, [`${step.action} by ${step.actor}`]),
          el("span", { class: "tiny muted mono" }, [truncateSig(step.signature)]),
        ])
      )) : el("div", { class: "muted tiny" }, ["No steps yet."]),
    ]),
    a.status === "pending" ? el("div", { class: "approval-actions" }, [
      el("button", { class: "btn primary", disabled: !can("approve"), onClick: () => decideDrawer(a, "approved") }, ["Review approval"]),
      el("button", { class: "btn danger", disabled: !can("approve"), onClick: () => decideDrawer(a, "rejected") }, ["Review rejection"]),
      el("button", { class: "btn", disabled: !can("approve"), onClick: () => delegate(a) }, ["Delegate"]),
      el("button", { class: "btn ghost", onClick: () => requestChanges(a) }, ["Request changes"]),
    ]) : null,
    a.reasonIfDone ? el("div", { class: "tiny muted" }, ["Decision notes: " + a.reasonIfDone]) : null,
  ]));
}

function truncateSig(s) {
  if (!s) return "—";
  return s.slice(0, 10) + "…" + s.slice(-6);
}

function resolveSubject(subject) {
  if (subject.kind === "Revision") {
    const r = getById("revisions", subject.id);
    const doc = r ? getById("documents", r.docId) : null;
    return {
      route: r ? `/doc/${r.docId}` : null,
      detail: r ? el("div", { class: "stack" }, [
        el("div", { class: "strong small" }, [doc?.name || subject.id]),
        el("div", { class: "small" }, [`Rev ${r.label} · ${r.status}`]),
        el("div", { class: "tiny muted" }, [r.summary || ""]),
      ]) : null,
    };
  }
  if (subject.kind === "WorkItem") {
    const w = getById("workItems", subject.id);
    return {
      route: w ? `/work-board/${w.projectId}` : null,
      detail: w ? el("div", { class: "stack" }, [
        el("div", { class: "strong small" }, [w.title]),
        el("div", { class: "tiny muted" }, [`${w.type} · ${w.severity} · status ${w.status}`]),
      ]) : null,
    };
  }
  return { route: null, detail: null };
}

function expireOverdue() {
  const now = Date.now();
  let changed = false;
  update(s => {
    for (const a of (s.data.approvals || [])) {
      if (a.status === "pending" && a.dueTs && Date.parse(a.dueTs) < now) {
        a.status = "expired";
        const e = audit("approval.expire", a.id, { dueTs: a.dueTs });
        a.chain = a.chain || [];
        a.chain.push({ ts: new Date().toISOString(), action: "expire", actor: "system", signature: "n/a" });
        a.audit_ref = e.id;
        changed = true;
      }
    }
  });
}

function decideDrawer(a, outcome) {
  if (!can("approve")) { toast("Cannot approve", "warn"); return; }
  const notes = textarea({ placeholder: outcome === "approved" ? "Signature notes..." : "Reason for rejection..." });
  const subj = resolveSubject(a.subject);
  const impact = approvalImpact(a);
  drawer({
    title: `${outcome === "approved" ? "Approve" : "Reject"} ${a.id}`,
    body: el("div", { class: "stack" }, [
      el("div", { class: "approval-impact" }, [
        badge(a.subject.kind, "info"),
        el("span", { class: "mono small" }, [a.subject.id]),
        subj.route ? el("button", { class: "btn sm", onClick: () => navigate(subj.route) }, ["Open subject"]) : null,
      ]),
      card("Impact preview", el("div", { class: "stack" }, impact.map(row => el("div", { class: "activity-row" }, [
        badge(row.kind, row.variant),
        el("span", {}, [row.text]),
        el("span", { class: "tiny muted" }, [row.detail]),
      ])))),
      formRow(outcome === "approved" ? "Signature notes" : "Reason", notes),
      el("div", { class: "tiny muted" }, [
        "This decision is signed with HMAC-SHA256 over the decision payload (signer, subject, outcome, notes, timestamp) and appended to the chain of custody.",
      ]),
    ]),
    actions: [
      { label: "Cancel" },
      {
        label: outcome === "approved" ? "Sign & approve" : "Reject",
        variant: outcome === "approved" ? "primary" : "danger",
        onClick: () => finalize(a, outcome, notes.value),
      },
    ],
  });
}

function approvalImpact(a) {
  if (a.subject.kind === "Revision") {
    const r = getById("revisions", a.subject.id);
    const doc = r ? getById("documents", r.docId) : null;
    return [
      { kind: "Revision", variant: "info", text: r ? `Rev ${r.label} moves from ${r.status}` : a.subject.id, detail: doc?.name || "Unknown document" },
      { kind: "Audit", variant: "purple", text: "Signed chain-of-custody entry", detail: "HMAC + audit ledger" },
      { kind: "Safety", variant: "warn", text: "Check linked assets and superseded revisions", detail: "Prevents old-package work" },
    ];
  }
  if (a.subject.kind === "WorkItem") {
    const w = getById("workItems", a.subject.id);
    return [
      { kind: "Work", variant: "info", text: w?.title || a.subject.id, detail: w ? `${w.type} · ${w.status}` : "Unknown item" },
      { kind: "Audit", variant: "purple", text: "Decision recorded", detail: "Approval trail" },
    ];
  }
  return [{ kind: "Object", variant: "info", text: `${a.subject.kind} ${a.subject.id}`, detail: "Review linked context" }];
}

async function finalize(a, outcome, notes) {
  const payload = {
    approvalId: a.id,
    subject: a.subject,
    outcome,
    notes,
    signer: state.ui.role,
    ts: new Date().toISOString(),
  };
  const sig = await signHMAC(canonicalJSON(payload));
  update(s => {
    const x = s.data.approvals.find(r => r.id === a.id);
    if (!x) return;
    x.status = outcome;
    x.reasonIfDone = notes;
    x.signedBy = state.ui.role;
    x.signedAt = payload.ts;
    x.signature = sig;
    x.chain = x.chain || [];
    x.chain.push({ ts: payload.ts, action: outcome, actor: state.ui.role, signature: sig.signature, keyId: sig.keyId });
  });
  const ent = audit(outcome === "approved" ? "approval.sign" : "approval.reject", a.id, { outcome, signature: sig.signature.slice(0, 12), keyId: sig.keyId });

  // Cascade through the FSM-defined sequence (IFR → Approved → IFC).
  if (a.subject.kind === "Revision" && outcome === "approved") {
    const r = getById("revisions", a.subject.id);
    if (r) {
      const target = cascadeOnApprove(r.status);
      if (target) {
        try { transition(r.id, target, { via: a.id }); }
        catch { /* logged by core/revisions */ }
      }
    }
  }
  if (a.subject.kind === "Revision" && outcome === "rejected") {
    const r = getById("revisions", a.subject.id);
    if (r && (r.status === "IFR" || r.status === "Approved")) {
      try { transition(r.id, "Rejected", { via: a.id }); } catch {}
    }
  }
  toast(`Approval ${outcome}`, outcome === "approved" ? "success" : "warn");
  renderApprovals();
}

function delegate(a) {
  if (!can("approve")) return;
  const users = state.data.users.filter(u => u.role !== "Viewer/Auditor");
  const to = select(users.map(u => ({ value: u.id, label: `${u.name} — ${u.role}` })));
  const reason = textarea({ placeholder: "Why are you delegating?" });
  modal({
    title: `Delegate ${a.id}`,
    body: el("div", { class: "stack" }, [
      formRow("Delegate to", to),
      formRow("Reason", reason),
    ]),
    actions: [
      { label: "Cancel" },
      { label: "Delegate", variant: "primary", onClick: () => {
        update(s => {
          const x = s.data.approvals.find(r => r.id === a.id);
          if (!x) return;
          x.approvers = [to.value];
          x.status = "delegated";
          x.chain = x.chain || [];
          x.chain.push({ ts: new Date().toISOString(), action: "delegate", actor: state.ui.role, detail: { to: to.value, reason: reason.value }, signature: "n/a" });
        });
        audit("approval.delegate", a.id, { to: to.value });
        toast("Delegated", "info");
        renderApprovals();
      }},
    ],
  });
}

function requestChanges(a) {
  const reason = textarea({ placeholder: "What needs to change?" });
  modal({
    title: `Request changes on ${a.id}`,
    body: el("div", { class: "stack" }, [formRow("Reason", reason)]),
    actions: [
      { label: "Cancel" },
      { label: "Request changes", variant: "primary", onClick: () => {
        update(s => {
          const x = s.data.approvals.find(r => r.id === a.id);
          if (!x) return;
          x.chain = x.chain || [];
          x.chain.push({ ts: new Date().toISOString(), action: "request_changes", actor: state.ui.role, detail: { reason: reason.value }, signature: "n/a" });
        });
        audit("approval.request_changes", a.id, { reason: reason.value.slice(0, 120) });
        toast("Change request sent", "info");
      }},
    ],
  });
}

async function batchDecide(outcome) {
  const ids = JSON.parse(sessionStorage.getItem("approvals.batch") || "[]");
  if (!ids.length) return;
  if (!can("approve")) return;
  const ok = await dangerAction({
    title: `${outcome === "approved" ? "Batch approve" : "Batch reject"} ${ids.length} item(s)?`,
    message: outcome === "approved"
      ? "Each decision is HMAC-signed and recorded in the audit ledger."
      : "Rejecting will cascade revisions back to Rejected and is audited.",
    confirmLabel: outcome === "approved" ? "Approve all" : "Reject all",
    variant: outcome === "approved" ? "primary" : "danger",
    details: `Selected: ${ids.join(", ")}`,
  });
  if (!ok) return;
  for (const id of ids) {
    const a = (state.data.approvals || []).find(x => x.id === id);
    if (a && a.status === "pending") await finalize(a, outcome, `Batch ${outcome}`);
  }
  sessionStorage.setItem("approvals.batch", "[]");
  audit("approval.batch", "batch", { count: ids.length, outcome });
  toast(`Batch ${outcome}: ${ids.length}`, "success");
}
