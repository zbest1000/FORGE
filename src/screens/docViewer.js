import { el, mount, card, badge, toast, modal, formRow, select, textarea } from "../core/ui.js";
import { state, update, getById, audit } from "../core/store.js";
import { navigate } from "../core/router.js";
import { can } from "../core/permissions.js";

export function renderDocsIndex() {
  const root = document.getElementById("screenContainer");
  const d = state.data;
  mount(root, [
    card("Documents", el("table", { class: "table" }, [
      el("thead", {}, [el("tr", {}, ["Name","Discipline","Sensitivity","Current Rev","Revisions",""].map(h => el("th", {}, [h])))]),
      el("tbody", {}, (d.documents || []).map(doc => {
        const rev = getById("revisions", doc.currentRevisionId);
        return el("tr", { class: "row-clickable", onClick: () => navigate(`/doc/${doc.id}`) }, [
          el("td", {}, [doc.name, el("div", { class: "tiny muted" }, [doc.id])]),
          el("td", {}, [badge(doc.discipline, "info")]),
          el("td", {}, [doc.sensitivity]),
          el("td", {}, [rev ? badge(`${rev.label} · ${rev.status}`, `rev-${rev.status.toLowerCase()}`) : "—"]),
          el("td", { class: "tiny muted" }, [String(doc.revisionIds?.length || 0)]),
          el("td", {}, [el("button", { class: "btn sm", onClick: (e) => { e.stopPropagation(); navigate(`/doc/${doc.id}`); } }, ["Open"])]),
        ]);
      })),
    ])),
  ]);
}

export function renderDocViewer({ id }) {
  const root = document.getElementById("screenContainer");
  const d = state.data;
  const doc = getById("documents", id);
  if (!doc) return mount(root, el("div", { class: "muted" }, ["Document not found."]));

  const viewKey = `doc.rev.${id}`;
  const activeRevId = sessionStorage.getItem(viewKey) || doc.currentRevisionId;
  const rev = getById("revisions", activeRevId) || getById("revisions", doc.currentRevisionId);

  const banner = bannerFor(rev);

  mount(root, [
    banner,
    el("div", { class: "viewer-layout" }, [
      el("div", { class: "viewer-canvas" }, [
        el("div", { class: "viewer-toolbar" }, [
          el("button", { class: "btn sm" }, ["⟵ Page"]),
          el("span", { class: "tiny muted" }, ["Page 1 of 3"]),
          el("button", { class: "btn sm" }, ["Page ⟶"]),
          el("span", { style: { flex: 1 } }),
          el("button", { class: "btn sm", onClick: () => {
            const other = pickOtherRev(doc, rev);
            if (other) navigate(`/compare/${rev.id}/${other.id}`);
          }}, ["Compare ⇄"]),
          el("button", {
            class: "btn sm primary",
            disabled: !can("approve"),
            onClick: () => openApprovalDialog(rev),
          }, ["Request approval"]),
        ]),
        el("div", { class: "viewer-page" }, [
          el("div", { class: "paper" }, [
            el("h2", {}, [doc.name]),
            el("div", { class: "paper-meta" }, [
              `${doc.id}  ·  Rev ${rev.label}  ·  ${rev.status}  ·  ${new Date(rev.createdAt).toLocaleDateString()}`,
            ]),
            el("p", {}, [rev.summary || "Summary not available."]),
            el("p", {}, [rev.notes || "Notes: (none)"]),
            el("p", { class: "muted tiny" }, [
              "This is a rendered placeholder representing a native doc viewer. In production, PDF.js or similar would render sheets here.",
            ]),
            ...(doc.markupPins || []),
          ]),
        ]),
      ]),
      el("div", { class: "viewer-side" }, [
        card("Revision timeline", el("div", { class: "revision-timeline" },
          doc.revisionIds.map(rid => {
            const r = getById("revisions", rid);
            if (!r) return null;
            return el("div", {
              class: `revision-row ${r.id === rev.id ? "active" : ""}`,
              onClick: () => { sessionStorage.setItem(viewKey, r.id); renderDocViewer({ id }); },
            }, [
              badge(`Rev ${r.label}`, `rev-${r.status.toLowerCase()}`),
              el("div", {}, [
                el("div", { class: "small" }, [r.status]),
                el("div", { class: "tiny muted" }, [new Date(r.createdAt).toLocaleDateString()]),
              ]),
            ]);
          })
        )),
        card("Approvals", el("div", { class: "stack" },
          (d.approvals || []).filter(a => a.subject.kind === "Revision" && a.subject.id === rev.id).map(a =>
            el("div", { class: "row wrap" }, [
              badge(a.status, a.status === "approved" ? "success" : "warn"),
              el("span", { class: "small" }, [a.id]),
            ])
          ).concat([
            el("button", { class: "btn sm", onClick: () => navigate("/approvals") }, ["Approval queue →"]),
          ])
        )),
        card("AI — Ask this document", el("div", { class: "stack" }, [
          el("div", { class: "tiny muted" }, ["Ask a question; answers cite this revision."]),
          el("button", { class: "btn sm", onClick: () => navigate(`/ai?doc=${doc.id}&rev=${rev.id}`) }, ["Open AI →"]),
        ])),
      ]),
    ]),
  ]);
}

function bannerFor(rev) {
  const variant = {
    "Draft": "warn",
    "IFR": "info",
    "Approved": "success",
    "IFC": "accent",
    "Superseded": "warn",
    "Archived": "",
  }[rev.status] || "";
  return el("div", { class: "row spread", style: { marginBottom: "12px" } }, [
    el("div", { class: "row" }, [
      badge(`Rev ${rev.label}`, `rev-${rev.status.toLowerCase()}`),
      badge(rev.status, variant),
      el("span", { class: "tiny muted" }, [`Created ${new Date(rev.createdAt).toLocaleDateString()}`]),
    ]),
  ]);
}

function pickOtherRev(doc, rev) {
  const ids = doc.revisionIds || [];
  const idx = ids.indexOf(rev.id);
  const otherId = ids[idx - 1] || ids[idx + 1];
  return otherId ? getById("revisions", otherId) : null;
}

function openApprovalDialog(rev) {
  if (!can("approve")) { toast("Your role cannot create approvals", "warn"); return; }
  const approverSelect = select(state.data.users.map(u => ({ value: u.id, label: `${u.name} — ${u.role}` })));
  const reasonText = textarea({ placeholder: "Reason / notes for approver..." });
  modal({
    title: `Request approval — ${rev.id}`,
    body: el("div", { class: "stack" }, [
      formRow("Approver", approverSelect),
      formRow("Notes", reasonText),
    ]),
    actions: [
      { label: "Cancel" },
      { label: "Request", variant: "primary", onClick: () => {
        const id = "APR-" + Math.floor(Math.random()*900+100);
        update(s => {
          s.data.approvals.push({
            id,
            subject: { kind: "Revision", id: rev.id },
            requester: "current",
            approvers: [approverSelect.value],
            status: "pending",
            dueTs: new Date(Date.now() + 86400000).toISOString(),
            notes: reasonText.value,
          });
        });
        audit("approval.request", rev.id, { approvalId: id });
        toast("Approval requested", "success");
      }},
    ],
  });
}
