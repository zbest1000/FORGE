import { el, mount, card, badge, toast, modal, formRow, textarea } from "../core/ui.js";
import { state, update, getById, audit } from "../core/store.js";
import { navigate } from "../core/router.js";
import { can } from "../core/permissions.js";

export function renderApprovals() {
  const root = document.getElementById("screenContainer");
  const d = state.data;
  const approvals = d.approvals || [];
  const filterKey = "approvals.filter";
  const filter = sessionStorage.getItem(filterKey) || "pending";

  const filtered = filter === "all" ? approvals : approvals.filter(a => a.status === filter);

  mount(root, [
    card("Approval queue", el("div", { class: "stack" }, [
      el("div", { class: "row" }, ["pending","approved","rejected","all"].map(f =>
        el("button", {
          class: `btn sm ${filter === f ? "primary" : ""}`,
          onClick: () => { sessionStorage.setItem(filterKey, f); renderApprovals(); },
        }, [f])
      )),
      ...filtered.map(a => approvalCard(a)),
      filtered.length ? null : el("div", { class: "muted tiny" }, ["No approvals match filter."]),
    ])),
  ]);

  function approvalCard(a) {
    const subj = resolveSubject(a.subject);
    return el("div", { class: "approval-card" }, [
      el("div", { class: "row spread" }, [
        el("div", {}, [
          el("div", { class: "strong" }, [`${a.id} — ${a.subject.kind} ${a.subject.id}`]),
          el("div", { class: "tiny muted" }, [subj.label]),
        ]),
        el("div", { class: "row" }, [
          badge(a.status, a.status === "approved" ? "success" : a.status === "rejected" ? "danger" : "warn"),
          a.dueTs ? el("span", { class: "tiny muted" }, ["due " + new Date(a.dueTs).toLocaleDateString()]) : null,
        ]),
      ]),
      el("div", { class: "row" }, [
        el("span", { class: "tiny muted" }, [`Approvers: ${(a.approvers || []).join(", ") || "—"}`]),
      ]),
      a.status === "pending" && el("div", { class: "approval-actions" }, [
        el("button", { class: "btn sm primary", disabled: !can("approve"), onClick: () => decide(a, "approved") }, ["Sign & approve"]),
        el("button", { class: "btn sm danger", disabled: !can("approve"), onClick: () => decide(a, "rejected") }, ["Reject"]),
        el("button", { class: "btn sm", onClick: () => subj.route && navigate(subj.route) }, ["Open subject →"]),
      ]),
      a.reasonIfDone && el("div", { class: "tiny muted" }, ["Decision notes: ", a.reasonIfDone]),
    ]);
  }
}

function resolveSubject(subject) {
  if (subject.kind === "Revision") {
    const r = getById("revisions", subject.id);
    const doc = r ? getById("documents", r.docId) : null;
    return { label: doc ? `${doc.name} — Rev ${r.label}` : subject.id, route: r ? `/doc/${r.docId}` : null };
  }
  if (subject.kind === "WorkItem") {
    const w = getById("workItems", subject.id);
    return { label: w ? w.title : subject.id, route: w ? `/work-board/${w.projectId}` : null };
  }
  return { label: subject.id, route: null };
}

function decide(a, outcome) {
  if (!can("approve")) { toast("No approve capability", "warn"); return; }
  const notes = textarea({ placeholder: outcome === "approved" ? "Signature notes..." : "Reason for rejection..." });
  modal({
    title: `${outcome === "approved" ? "Approve" : "Reject"} ${a.id}`,
    body: el("div", { class: "stack" }, [formRow("Notes", notes)]),
    actions: [
      { label: "Cancel" },
      { label: outcome === "approved" ? "Sign & approve" : "Reject",
        variant: outcome === "approved" ? "primary" : "danger",
        onClick: () => {
          update(s => {
            const x = s.data.approvals.find(r => r.id === a.id);
            if (!x) return;
            x.status = outcome;
            x.reasonIfDone = notes.value;
            x.signedBy = s.ui.role;
            x.signedAt = new Date().toISOString();
          });
          // Cascade: if approving a revision, promote status.
          if (a.subject.kind === "Revision" && outcome === "approved") {
            update(s => {
              const r = s.data.revisions.find(r => r.id === a.subject.id);
              if (r) r.status = "Approved";
            });
          }
          audit("approval.decision", a.id, { outcome });
          toast(`Approval ${outcome}`, outcome === "approved" ? "success" : "warn");
        } },
    ],
  });
}
