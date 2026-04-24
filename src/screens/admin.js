import { el, mount, card, badge } from "../core/ui.js";
import { state } from "../core/store.js";
import { ROLES } from "../core/permissions.js";

export function renderAdmin() {
  const root = document.getElementById("screenContainer");
  const d = state.data;

  mount(root, [
    el("div", { class: "two-col" }, [
      card("Identity (SSO)", el("div", { class: "stack" }, [
        el("div", { class: "row wrap" }, [
          badge("SAML SSO: connected", "success"),
          badge("OIDC: disabled", ""),
          badge("SCIM: connected", "success"),
          badge("MFA: enforced", "success"),
        ]),
        el("div", { class: "tiny muted" }, ["IdP: Keycloak-compatible · Realm: atlas-prod"]),
      ])),
      card("Retention & compliance", el("div", { class: "stack" }, [
        el("div", { class: "row wrap" }, [
          badge("Audit retention: 7y", "info"),
          badge("Legal hold: 2 objects", "warn"),
          badge("Data residency: US-East", "info"),
        ]),
        el("div", { class: "tiny muted" }, ["Immutable audit ledger; exportable governance pack."]),
      ])),
    ]),
    card("RBAC matrix (roles × capabilities)", rbacMatrix()),
    card("Policy violations", el("div", { class: "stack" }, [
      el("div", { class: "activity-row" }, [
        badge("LOW", "warn"),
        el("span", {}, ["External guest role has markup rights on 1 drawing — review recommended."]),
        badge("review", "info"),
      ]),
      el("div", { class: "muted tiny" }, ["No high-severity violations in last 30 days."]),
    ])),
    card("Audit analytics", el("div", { class: "stack" }, [
      el("div", { class: "row wrap" }, [
        badge(`${(d.auditEvents || []).length} audit events loaded`, "info"),
      ]),
      ...((d.auditEvents || []).slice(0, 12).map(e =>
        el("div", { class: "activity-row" }, [
          el("span", { class: "ts" }, [new Date(e.ts).toLocaleString()]),
          el("span", {}, [el("span", { class: "strong" }, [e.action]), " on ", String(e.subject)]),
          el("span", { class: "tiny muted" }, [e.actor]),
        ])
      )),
    ])),
  ]);
}

function rbacMatrix() {
  const caps = ["view", "create", "edit", "approve", "integration.write", "ai.configure", "incident.command"];
  return el("table", { class: "table" }, [
    el("thead", {}, [el("tr", {}, ["Role", ...caps.map(c => el("th", {}, [c]))])]),
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
