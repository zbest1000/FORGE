// Full audit ledger view (`/audit`). Replaces the side-panel "Recent
// audit" as the canonical place to read the chain. The side-panel card
// is scoped to whatever object is in view; this page is unfiltered (or
// pre-filtered via ?subject=, ?actor=, ?action= query string).

import { el, mount, card, badge, table, input, select } from "../core/ui.js";
import { state } from "../core/store.js";
import { navigate } from "../core/router.js";
import { relative } from "../core/time.js";
import { helpHint, helpLinkChip } from "../core/help.js";

const PAGE_SIZE = 100;

function parseQuery() {
  const raw = (state.route || "").split("?")[1] || "";
  const sp = new URLSearchParams(raw);
  return {
    subject: sp.get("subject") || "",
    actor: sp.get("actor") || "",
    action: sp.get("action") || "",
    q: sp.get("q") || "",
  };
}

function setQuery(updates) {
  const cur = parseQuery();
  const next = { ...cur, ...updates };
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(next)) if (v) sp.set(k, v);
  const qs = sp.toString();
  navigate("/audit" + (qs ? `?${qs}` : ""));
}

export function renderAudit() {
  const root = document.getElementById("screenContainer");
  const filters = parseQuery();

  const all = (state.data?.auditEvents || []).slice().reverse();
  const matched = all.filter(e => {
    if (filters.subject && String(e.subject) !== filters.subject) return false;
    if (filters.actor && String(e.actor) !== filters.actor) return false;
    if (filters.action && String(e.action) !== filters.action) return false;
    if (filters.q) {
      const hay = `${e.action} ${e.subject} ${e.actor} ${JSON.stringify(e.detail || {})}`.toLowerCase();
      if (!hay.includes(filters.q.toLowerCase())) return false;
    }
    return true;
  });

  const actors = Array.from(new Set(all.map(e => e.actor))).filter(Boolean).sort();
  const actions = Array.from(new Set(all.map(e => e.action))).filter(Boolean).sort();

  const subjectInput = input({ value: filters.subject, placeholder: "Subject id (e.g. REV-1-B)" });
  subjectInput.addEventListener("change", () => setQuery({ subject: subjectInput.value.trim() }));

  const actorSelect = select(
    [{ value: "", label: "Any actor" }, ...actors.map(a => ({ value: a, label: a }))],
    { value: filters.actor, onChange: (e) => setQuery({ actor: e.target.value }) }
  );
  const actionSelect = select(
    [{ value: "", label: "Any action" }, ...actions.map(a => ({ value: a, label: a }))],
    { value: filters.action, onChange: (e) => setQuery({ action: e.target.value }) }
  );
  const qInput = input({ value: filters.q, placeholder: "Search action / subject / detail..." });
  qInput.addEventListener("input", () => {
    clearTimeout(qInput._t);
    qInput._t = setTimeout(() => setQuery({ q: qInput.value.trim() }), 200);
  });

  const visible = matched.slice(0, PAGE_SIZE);

  const filterCard = card("Filters", el("div", { class: "stack" }, [
    el("div", { class: "row wrap", style: { gap: "8px" } }, [
      el("label", { class: "tiny muted", style: { display: "flex", flexDirection: "column", gap: "2px" } }, [
        "Subject", subjectInput,
      ]),
      el("label", { class: "tiny muted", style: { display: "flex", flexDirection: "column", gap: "2px" } }, [
        "Actor", actorSelect,
      ]),
      el("label", { class: "tiny muted", style: { display: "flex", flexDirection: "column", gap: "2px" } }, [
        "Action", actionSelect,
      ]),
      el("label", { class: "tiny muted", style: { flex: "1", display: "flex", flexDirection: "column", gap: "2px", minWidth: "200px" } }, [
        "Search", qInput,
      ]),
      el("button", { class: "btn sm ghost", onClick: () => navigate("/audit") }, ["Clear"]),
    ]),
    el("div", { class: "tiny muted" }, [
      `${visible.length} of ${matched.length} shown · ${all.length} total events in ledger`,
    ]),
  ]));

  const ledgerTable = table({
    columns: [
      { key: "ts", header: "When", render: (r) => el("span", { class: "tiny" }, [relative(r.ts), " · ", new Date(r.ts).toLocaleString()]) },
      { key: "actor", header: "Actor", render: (r) => badge(r.actor || "system", "info") },
      { key: "action", header: "Action", render: (r) => el("span", { class: "strong small" }, [r.action]) },
      { key: "subject", header: "Subject", render: (r) => r.subject
        ? el("button", { class: "btn xs ghost", title: "Filter to this subject", onClick: () => setQuery({ subject: String(r.subject) }) }, [String(r.subject)])
        : el("span", { class: "tiny muted" }, ["—"]) },
      { key: "detail", header: "Detail", render: (r) => el("span", { class: "tiny", style: { fontFamily: "var(--font-mono, ui-monospace, monospace)" } }, [
        r.detail ? JSON.stringify(r.detail) : "—",
      ]) },
    ],
    rows: visible,
  });

  mount(root, [
    el("div", { class: "stack", style: { gap: "12px" } }, [
      el("div", {}, [
        el("h1", { class: "page-title", style: { display: "inline-flex", alignItems: "center" } }, [
          "Audit ledger", helpHint("forge.audit-chain"),
        ]),
        el("div", { class: "tiny muted" }, [
          "Hash-chained, HMAC-signed event log. Every authentication, authz decision, mutation, ",
          "lifecycle transition, retention sweep, and worker action lands here. Filters narrow the view; ",
          "the underlying chain is never modified.",
        ]),
        el("div", { class: "row wrap", style: { gap: "6px", marginTop: "6px" } }, [
          helpLinkChip("forge.audit-chain", "How chaining works"),
          helpLinkChip("forge.permissions", "Capability model"),
        ]),
      ]),
      filterCard,
      card("Events", ledgerTable),
    ]),
  ]);
}
