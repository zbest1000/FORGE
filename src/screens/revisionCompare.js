import { el, mount, card, badge } from "../core/ui.js";
import { state, getById } from "../core/store.js";
import { navigate } from "../core/router.js";

export function renderRevisionCompare({ left, right }) {
  const root = document.getElementById("screenContainer");
  const a = getById("revisions", left);
  const b = getById("revisions", right);
  if (!a || !b) return mount(root, el("div", { class: "muted" }, ["Revisions not found."]));
  const doc = getById("documents", a.docId);

  mount(root, [
    el("div", { class: "row spread", style: { marginBottom: "12px" } }, [
      el("div", { class: "strong" }, [doc?.name || "Compare"]),
      el("button", { class: "btn sm", onClick: () => navigate(`/doc/${a.docId}`) }, ["← Back to document"]),
    ]),
    el("div", { class: "compare-grid" }, [
      pane(a, "A"),
      pane(b, "B"),
    ]),
    card("Metadata diff", diffList(a, b), { subtitle: "Semantic delta of revision metadata" }),
    card("AI — Impact analysis", el("div", { class: "stack" }, [
      el("div", { class: "small" }, [
        `Between Rev ${a.label} and Rev ${b.label}, ${b.summary ? `the following change is recorded: "${b.summary}".` : "no summary recorded."}`,
      ]),
      el("div", { class: "tiny muted" }, [
        "Potential impacts: tasks linked to this document, approvals in-flight, and assets referencing the revised objects.",
      ]),
    ])),
  ]);
}

function pane(rev, label) {
  return el("div", { class: "compare-pane" }, [
    el("div", { class: "row spread" }, [
      el("div", { class: "strong" }, [`Pane ${label} — Rev ${rev.label}`]),
      badge(rev.status, `rev-${rev.status.toLowerCase()}`),
    ]),
    el("div", { class: "tiny muted", style: { margin: "8px 0" } }, [
      `${rev.id} · ${new Date(rev.createdAt).toLocaleDateString()}`,
    ]),
    el("p", { class: "small" }, [rev.summary || "(no summary)"]),
    el("p", { class: "tiny muted" }, [rev.notes || ""]),
  ]);
}

function diffList(a, b) {
  const rows = [];
  const fields = ["label", "status", "summary", "notes", "createdAt"];
  for (const f of fields) {
    if ((a[f] || "") === (b[f] || "")) {
      rows.push(el("div", { class: "diff-line diff-same" }, [`  ${f}: ${a[f] || ""}`]));
    } else {
      rows.push(el("div", { class: "diff-line diff-removed" }, [`- ${f}: ${a[f] || ""}`]));
      rows.push(el("div", { class: "diff-line diff-added" }, [`+ ${f}: ${b[f] || ""}`]));
    }
  }
  return el("div", {}, rows);
}
