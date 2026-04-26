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

import { el, mount, card, badge, toast, modal, formRow, input, select, dangerAction, tabs } from "../core/ui.js";
import { state, update } from "../core/store.js";
import { ROLES } from "../core/permissions.js";
import { exportAuditPack, verifyLedger, verifyAuditPack } from "../core/audit.js";
import { canonicalJSON } from "../core/crypto.js";
import { mode as apiMode, api } from "../core/api.js";
import { listGroups, currentUserId, effectiveGroupIds, isOrgOwner } from "../core/groups.js";
import { navigate } from "../core/router.js";

const ADMIN_SECTIONS = new Set(["identity", "access", "integrations", "audit", "retention", "health"]);

export function renderAdmin(params = {}) {
  const root = document.getElementById("screenContainer");
  const d = state.data;
  const sessionKey = "admin.section";
  const routeSection = ADMIN_SECTIONS.has(params.section) ? params.section : null;
  const initial = routeSection || sessionStorage.getItem(sessionKey) || "identity";
  // Keep both URL routing and the shared Tabs primitive in sync. The URL
  // is the source of truth when present, but the Tabs primitive persists
  // the last view to sessionStorage on every click.
  if (sessionStorage.getItem(sessionKey) !== initial) sessionStorage.setItem(sessionKey, initial);

  const sections = [
    { id: "identity", label: "Identity", content: () => adminSection("identity", d) },
    { id: "access", label: "Access", content: () => adminSection("access", d) },
    { id: "integrations", label: "Integrations", content: () => adminSection("integrations", d) },
    { id: "audit", label: "Audit", content: () => adminSection("audit", d) },
    { id: "retention", label: "Retention", content: () => adminSection("retention", d) },
    { id: "health", label: "System health", content: () => adminSection("health", d) },
  ];

  mount(root, [
    tabs({
      tabs: sections,
      sessionKey,
      ariaLabel: "Admin settings",
      defaultId: initial,
      onChange: (id) => {
        // Reflect the section in the URL so deep links still work.
        const target = id === "identity" ? "/admin" : `/admin/${id}`;
        if ((state.route || "").split("?")[0] !== target) navigate(target);
      },
    }),
  ]);
}

function adminSection(active, d) {
  if (active === "identity") {
    return el("div", { class: "two-col" }, [
      card("Identity (SSO / SCIM / MFA)", el("div", { class: "stack" }, [
        el("div", { class: "row wrap" }, [
          badge("SAML SSO: connected", "success"),
          badge("OIDC: disabled", ""),
          badge("SCIM: connected", "success"),
          badge("MFA: enforced", "success"),
        ]),
        el("div", { class: "tiny muted" }, ["IdP: Keycloak-compatible · Realm: atlas-prod · SCIM endpoint: /scim/v2"]),
      ])),
      card("Policy violations", policyPanel(d)),
    ]);
  }
  if (active === "access") {
    return el("div", { class: "stack" }, [
      card("Groups & memberships", groupsPanel(d), { subtitle: "Hierarchical groups gate portals, routes, and asset assignments." }),
      card("RBAC matrix (roles x capabilities)", rbacMatrix()),
      card("Access review", accessReviewPanel(d)),
    ]);
  }
  if (active === "integrations") {
    return el("div", { class: "stack" }, [
      apiMode() === "server" ? card("Server admin - API tokens", apiTokensPanel()) : card("API tokens", el("div", { class: "muted tiny" }, ["Sign in to server mode to manage tokens."])),
      apiMode() === "server" ? card("Server admin - Webhooks", webhooksPanel()) : null,
      apiMode() === "server" ? card("Server admin - Automations (n8n)", automationsPanel()) : null,
    ]);
  }
  if (active === "audit") return card("Audit ledger", auditPanel());
  if (active === "retention") return card("Retention & compliance", el("div", { class: "stack" }, retentionEditor(d)));
  if (active === "health") {
    return el("div", { class: "stack" }, [
      apiMode() === "server" ? card("Server admin - Metrics", metricsPanel()) : card("System health", el("div", { class: "muted tiny" }, ["Server metrics are available in server mode."])),
    ]);
  }
  return card("Admin", el("div", { class: "muted tiny" }, ["Choose a settings section."]));
}

// ---------- server admin panels (only in server mode) ----------
function apiTokensPanel() {
  const list = el("div", { class: "stack" }, [el("div", { class: "tiny muted" }, ["Loading…"])]);
  const refresh = async () => {
    try {
      const tokens = await api("/api/tokens");
      if (!tokens.length) { list.replaceChildren(el("div", { class: "muted tiny" }, ["No tokens issued."])); return; }
      list.replaceChildren(...tokens.map(t => el("div", { class: "activity-row" }, [
        el("span", { class: "mono tiny" }, [t.id]),
        el("span", { class: "small", style: { flex: 1 } }, [t.name]),
        badge((t.scopes || []).join(","), "info"),
        t.revoked_at ? badge("revoked", "danger") : t.expires_at ? badge(`exp ${new Date(t.expires_at).toLocaleDateString()}`, "warn") : badge("active", "success"),
        t.revoked_at ? null : el("button", { class: "btn sm danger", onClick: async () => {
          const ok = await dangerAction({
            title: `Revoke token ${t.id}?`,
            message: `Token “${t.name}” will stop authenticating immediately. Existing sessions using this token will be rejected on their next request.`,
            confirmLabel: "Revoke",
          });
          if (!ok) return;
          await api(`/api/tokens/${t.id}`, { method: "DELETE" });
          refresh();
        } }, ["Revoke"]),
      ])));
    } catch (e) {
      list.replaceChildren(el("div", { class: "muted tiny" }, ["Error: " + e.message]));
    }
  };
  refresh();
  const name = input({ placeholder: "Token name", value: "service client" });
  const ttl = input({ placeholder: "TTL days (blank = no expiry)", value: "" });
  const scopes = select(["view","integration.read","integration.write","approve","incident.command"]);
  return el("div", { class: "stack" }, [
    el("div", { class: "tiny muted" }, ["Long-lived machine bearer tokens. The plaintext is shown once at creation; the server stores only the SHA-256."]),
    list,
    el("div", { class: "row wrap" }, [
      name, scopes, ttl,
      el("button", { class: "btn sm primary", onClick: async () => {
        try {
          const scopesVal = [scopes.value];
          const body = { name: name.value, scopes: scopesVal };
          if (ttl.value) body.ttlDays = Number(ttl.value);
          const r = await api("/api/tokens", { method: "POST", body });
          modal({
            title: "Token issued",
            body: el("div", { class: "stack" }, [
              el("div", { class: "tiny muted" }, ["Copy this now — it will not be shown again:"]),
              el("pre", { class: "mono tiny", style: { background: "var(--panel)", padding: "12px", borderRadius: "6px", wordBreak: "break-all" } }, [r.token]),
            ]),
            actions: [{ label: "Close" }],
          });
          refresh();
        } catch (e) { toast("Error: " + e.message, "danger"); }
      } }, ["+ Issue"]),
    ]),
  ]);
}

function webhooksPanel() {
  const list = el("div", { class: "stack" });
  const refresh = async () => {
    try {
      const whs = await api("/api/webhooks");
      list.replaceChildren(...(whs.length ? whs.map(w => el("div", { class: "activity-row" }, [
        el("span", { class: "mono tiny" }, [w.id]),
        el("div", { class: "stack", style: { flex: 1, gap: "2px" } }, [
          el("span", { class: "small" }, [w.name]),
          el("span", { class: "tiny muted" }, [w.url, " · events: ", (w.events || ["*"]).join(",")]),
          w.last_error ? el("span", { class: "tiny danger-text" }, ["last error: " + w.last_error]) : w.last_success_at ? el("span", { class: "tiny success-text" }, ["ok " + new Date(w.last_success_at).toLocaleString()]) : null,
        ]),
        badge(w.enabled ? "enabled" : "disabled", w.enabled ? "success" : ""),
        el("button", { class: "btn sm", onClick: async () => { await api(`/api/webhooks/${w.id}`, { method: "PATCH", body: { enabled: !w.enabled } }); refresh(); } }, [w.enabled ? "Disable" : "Enable"]),
        el("button", { class: "btn sm danger", onClick: async () => {
          const ok = await dangerAction({
            title: `Delete webhook ${w.id}?`,
            message: `Endpoint ${w.url} will stop receiving events. Existing event records remain in the audit ledger.`,
            confirmLabel: "Delete",
          });
          if (!ok) return;
          await api(`/api/webhooks/${w.id}`, { method: "DELETE" });
          refresh();
        } }, ["×"]),
      ])) : [el("div", { class: "muted tiny" }, ["No webhooks."])]));
    } catch (e) { list.replaceChildren(el("div", { class: "muted tiny" }, ["Error: " + e.message])); }
  };
  refresh();
  const name = input({ placeholder: "Webhook name" });
  const url = input({ placeholder: "https://hook.example/forge" });
  const events = input({ placeholder: "event types (comma-separated; * for all)", value: "*" });
  return el("div", { class: "stack" }, [
    el("div", { class: "tiny muted" }, ["Outbound callbacks carry an X-FORGE-Signature HMAC-SHA256 header and the event type."]),
    list,
    el("div", { class: "row wrap" }, [
      name, url, events,
      el("button", { class: "btn sm primary", onClick: async () => {
        try {
          const r = await api("/api/webhooks", { method: "POST", body: { name: name.value, url: url.value, events: events.value.split(",").map(s => s.trim()).filter(Boolean) } });
          modal({
            title: "Webhook created",
            body: el("div", { class: "stack" }, [
              el("div", { class: "tiny muted" }, ["Configure the signing secret on your receiver:"]),
              el("pre", { class: "mono tiny", style: { background: "var(--panel)", padding: "12px", borderRadius: "6px", wordBreak: "break-all" } }, [r.secret || "(unchanged)"]),
            ]),
            actions: [{ label: "Close" }],
          });
          refresh();
        } catch (e) { toast("Error: " + e.message, "danger"); }
      } }, ["+ Add"]),
    ]),
  ]);
}

function automationsPanel() {
  const root = el("div", { class: "stack" }, [el("div", { class: "tiny muted" }, ["Loading…"])]);
  const refresh = async () => {
    try {
      const status = await api("/api/automations/n8n/status");
      if (!status.configured) {
        root.replaceChildren(
          el("div", { class: "small" }, [
            "n8n is not configured. Set ", el("code", {}, ["FORGE_N8N_URL"]),
            " (and optionally ", el("code", {}, ["FORGE_N8N_API_KEY"]), ") then restart the server. ",
            "The bundled docker-compose stack runs n8n at http://localhost:5678 by default.",
          ]),
          el("div", { class: "tiny muted" }, [
            "Pre-built workflow templates live at deploy/n8n-templates/ (incident → Slack, ERP PO → work item, MQTT alarm → event ingest).",
          ]),
        );
        return;
      }
      const wfs = await api("/api/automations/n8n/workflows").catch(() => []);
      root.replaceChildren(
        el("div", { class: "row spread" }, [
          el("div", { class: "tiny muted" }, [`Connected to `, el("code", {}, [status.url || "?"]), ` · ${wfs.length} workflows`]),
          el("a", {
            class: "btn sm primary", target: "_blank", rel: "noopener", href: status.url || "#",
          }, ["Open n8n UI ↗"]),
        ]),
        wfs.length
          ? el("table", { class: "table" }, [
              el("thead", {}, [el("tr", {}, ["Name","ID","Active",""].map(h => el("th", {}, [h])))]),
              el("tbody", {}, wfs.map(w => el("tr", {}, [
                el("td", {}, [w.name || "(unnamed)"]),
                el("td", { class: "mono tiny" }, [String(w.id || "")]),
                el("td", {}, [badge(w.active ? "active" : "inactive", w.active ? "success" : "")]),
                el("td", { class: "row" }, [
                  el("button", {
                    class: "btn sm",
                    onClick: async () => {
                      try {
                        await api(`/api/automations/n8n/workflows/${encodeURIComponent(w.id)}/${w.active ? "deactivate" : "activate"}`, { method: "POST" });
                        toast(`${w.name} ${w.active ? "deactivated" : "activated"}`, "success");
                        refresh();
                      } catch (e) { toast(e.message, "danger"); }
                    },
                  }, [w.active ? "Deactivate" : "Activate"]),
                ]),
              ]))),
            ])
          : el("div", { class: "muted tiny" }, ["No workflows yet — open n8n and import templates from deploy/n8n-templates/."]),
      );
    } catch (e) {
      root.replaceChildren(el("div", { class: "muted tiny" }, ["Error: " + e.message]));
    }
  };
  refresh();
  return root;
}

function metricsPanel() {
  const target = el("pre", { class: "mono tiny", style: { background: "var(--panel)", padding: "12px", borderRadius: "6px", maxHeight: "260px", overflow: "auto" } }, ["Loading /metrics…"]);
  fetch("/metrics").then(r => r.text()).then(txt => { target.textContent = txt.split("\n").slice(0, 40).join("\n"); });
  return el("div", { class: "stack" }, [
    el("div", { class: "tiny muted" }, ["Prometheus-compatible metrics endpoint. Full output at ", el("code", {}, ["GET /metrics"]), "."]),
    target,
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

function groupsPanel(d) {
  const groups = listGroups();
  const users = d.users || [];
  const userById = Object.fromEntries(users.map(u => [u.id, u]));
  // Render parent → children indent.
  const byParent = new Map();
  for (const g of groups) {
    const k = g.parentId || "__root__";
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k).push(g);
  }

  const rows = [];
  function emit(parentId, depth) {
    const list = byParent.get(parentId || "__root__") || [];
    for (const g of list) {
      rows.push(el("div", { class: `group-row ${depth ? "child" : ""}` }, [
        el("div", { class: "group-name" }, [
          el("span", { class: "strong" }, [g.name]),
          el("span", { class: "tiny muted", style: { marginLeft: "8px" } }, [g.id]),
          el("div", { class: "group-meta" }, [g.description || ""]),
        ]),
        el("div", { class: "row wrap" }, [
          badge(`${(g.memberIds || []).length} members`, "info"),
          ...(g.memberIds || []).slice(0, 4).map(uid => badge(userById[uid]?.name || uid, "")),
        ]),
        el("button", { class: "btn sm", onClick: () => editGroup(g) }, ["Edit"]),
      ]));
      emit(g.id, depth + 1);
    }
  }
  emit(null, 0);

  // "Become user" switcher to make demo testing easy.
  const me = currentUserId();
  const userPicker = select(users.map(u => ({ value: u.id, label: `${u.name} (${u.role})` })), {
    value: me || users[0]?.id,
    onChange: (e) => {
      update(s => { s.data.currentUserId = e.target.value; });
      toast(`Now viewing as ${userById[e.target.value]?.name || e.target.value}`, "info");
    },
  });

  return el("div", { class: "stack" }, [
    el("div", { class: "row wrap" }, [
      el("span", { class: "tiny muted" }, ["Demo identity:"]),
      userPicker,
      el("span", { class: "tiny muted" }, [`Effective groups: ${effectiveGroupIds(me).join(", ") || "(none)"}`]),
      isOrgOwner() ? badge("Organization Owner — bypasses all group gates", "accent") : null,
    ]),
    el("div", { class: "group-tree" }, rows),
    el("button", { class: "btn sm primary", onClick: () => addGroup() }, ["+ New group"]),
  ]);
}

function editGroup(g) {
  const name = input({ value: g.name });
  const desc = input({ value: g.description || "" });
  const parents = listGroups().filter(x => x.id !== g.id);
  const parent = select([{ value: "", label: "(no parent)" }, ...parents.map(p => ({ value: p.id, label: p.name }))], {
    value: g.parentId || "",
  });
  const users = state.data?.users || [];
  const memberRows = users.map(u => {
    const cb = el("input", { type: "checkbox", checked: (g.memberIds || []).includes(u.id) });
    cb.dataset.uid = u.id;
    return el("label", { class: "row", style: { gap: "8px", padding: "4px 0" } }, [
      cb, el("span", {}, [u.name]), el("span", { class: "tiny muted" }, [u.role]),
    ]);
  });
  modal({
    title: `Edit ${g.name}`,
    body: el("div", { class: "stack" }, [
      formRow("Name", name),
      formRow("Description", desc),
      formRow("Parent group", parent),
      el("div", { class: "form-row" }, [
        el("label", {}, ["Members"]),
        el("div", { class: "stack", style: { maxHeight: "240px", overflow: "auto", gap: "0" } }, memberRows),
      ]),
    ]),
    actions: [
      { label: "Cancel" },
      { label: "Save", variant: "primary", onClick: () => {
        const memberIds = memberRows.map(r => r.querySelector("input"))
          .filter(cb => cb.checked).map(cb => cb.dataset.uid);
        update(s => {
          const x = s.data.groups.find(y => y.id === g.id);
          if (!x) return;
          x.name = name.value;
          x.description = desc.value;
          x.parentId = parent.value || null;
          x.memberIds = memberIds;
        });
        toast(`Group ${name.value} saved`, "success");
      }},
    ],
  });
}

function addGroup() {
  const name = input({ placeholder: "Group name" });
  const desc = input({ placeholder: "Description" });
  const parents = listGroups();
  const parent = select([{ value: "", label: "(no parent)" }, ...parents.map(p => ({ value: p.id, label: p.name }))]);
  modal({
    title: "New group",
    body: el("div", { class: "stack" }, [
      formRow("Name", name), formRow("Description", desc), formRow("Parent", parent),
    ]),
    actions: [
      { label: "Cancel" },
      { label: "Create", variant: "primary", onClick: () => {
        if (!name.value.trim()) { toast("Name required", "warn"); return false; }
        update(s => {
          s.data.groups.push({
            id: "G-" + Math.random().toString(36).slice(2,7),
            name: name.value.trim(),
            description: desc.value,
            parentId: parent.value || null,
            memberIds: [],
          });
        });
        toast("Group created", "success");
      }},
    ],
  });
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
