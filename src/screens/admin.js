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

import { el, mount, card, badge, toast, modal, formRow, input, select, confirm } from "../core/ui.js";
import { state, update } from "../core/store.js";
import { ROLES } from "../core/permissions.js";
import { exportAuditPack, verifyLedger, verifyAuditPack } from "../core/audit.js";
import { canonicalJSON } from "../core/crypto.js";
import { mode as apiMode, api } from "../core/api.js";
import { listGroups, currentUserId, effectiveGroupIds, isOrgOwner } from "../core/groups.js";
import { navigate } from "../core/router.js";
import { license as currentLicense, refreshLicense, installLicense as installLic, uninstallLicense as uninstallLic, reactivateLicense, releaseActivation as releaseAct, FEATURES } from "../core/license.js";

const ADMIN_SECTIONS = new Set(["identity", "access", "integrations", "audit", "retention", "health", "license"]);

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
    { id: "license", label: "License", content: () => adminSection("license", d) },
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
  if (active === "license") return licensePanel();
  if (active === "health") {
    return el("div", { class: "stack" }, [
      apiMode() === "server" ? card("Server admin - Metrics", metricsPanel()) : card("System health", el("div", { class: "muted tiny" }, ["Server metrics are available in server mode."])),
    ]);
  }
  return card("Admin", el("div", { class: "muted tiny" }, ["Choose a settings section."]));
}

// ---------- license panel ----------
function licensePanel() {
  if (apiMode() !== "server") {
    return card("License", el("div", { class: "muted tiny" }, [
      "License management is only available in server mode. Demo builds run with the full Enterprise feature set so you can inspect every screen.",
    ]));
  }
  const lic = currentLicense();
  const isOwner = state.ui?.role === "Organization Owner";
  const isOnlineMode = !!(lic?.local_ls && lic.local_ls.configured);
  const isOfflineMode = !isOnlineMode && lic?.source !== "fallback" && lic?.source !== "local_ls_unreachable";

  const summary = el("div", { class: "stack" }, [
    el("div", { class: "row wrap" }, [
      badge(lic?.tier_label || lic?.tier || "?", statusKindForTier(lic?.tier)),
      lic?.edition_label ? badge(lic.edition_label, "info") : null,
      lic?.term_label ? badge(`${lic.term_label} term`, lic?.term === "perpetual" ? "success" : "info") : null,
      badge(lic?.status_label || "Unknown status", lic?.status === "ok" ? "success" : "danger"),
      badge(activationLabel(lic), isOnlineMode && lic?.local_ls?.online ? "success" : (lic?.source === "fallback" ? "warn" : "info")),
    ]),
    el("dl", { class: "kv" }, [
      kv("Customer", lic?.customer || "—"),
      kv("License ID", lic?.license_id || "—"),
      kv("Contact email", lic?.contact || "—"),
      kv("Issued", fmtDate(lic?.issued_at)),
      kv("Starts", fmtDate(lic?.starts_at)),
      kv("Expires", lic?.expires_at ? fmtDate(lic.expires_at) : "Never (perpetual)"),
      kv("Maintenance through", fmtDate(lic?.maintenance_until)),
      kv("Deployment", lic?.deployment_label || "—"),
      kv("Seats in use", seatLabel(lic)),
      kv("Features enabled", `${lic?.features?.length || 0} of ${lic?.feature_details?.length || lic?.features?.length || 0}`),
    ]),
    (lic?.reason_messages?.length || lic?.reasons?.length)
      ? el("div", { class: "callout warn tiny" }, [
          "Notice: " + (lic.reason_messages?.length ? lic.reason_messages.join(" ") : lic.reasons.join(", ")),
        ])
      : null,
  ]);

  // ---- Activation panel: online (local LS) vs offline (token paste) ----
  const activationStatusLabel = onlineActivationStatusLabel(lic);
  const isActivated = isOnlineMode && lic?.activation_id && (lic?.activation_status === "active" || lic?.local_ls?.activation_status === "active");
  const isSuperseded = lic?.status === "superseded";
  const isReleased   = lic?.status === "released";
  const isRevoked    = lic?.status === "revoked";

  const activationPanel = isOnlineMode
    ? card("Online activation", el("div", { class: "stack" }, [
        el("div", { class: "tiny muted" }, [
          "This installation activates online once and then runs entirely from the cached, signed activation token. The activation only re-checks with FORGE LLC during a daily heartbeat — enough to learn if the seat has been moved to another machine or released by your operator.",
        ]),
        el("dl", { class: "kv" }, [
          kv("Local server", lic.local_ls.url || "—"),
          kv("Activation status", activationStatusLabel),
          kv("Activation ID", lic.activation_id || lic.local_ls.activation_id || "—"),
          kv("Token ID", lic.activation_token_id || lic.local_ls.activation_token_id || "—"),
          kv("Activated at", fmtDateTime(lic.issued_at || lic.local_ls.issued_at)),
          kv("Last heartbeat", fmtDateTime(lic.local_ls.last_fetch_at)),
          (isSuperseded && lic.superseded_by) ? kv("Superseded by", lic.superseded_by) : null,
          (isReleased && lic.released_at) ? kv("Released at", fmtDateTime(lic.released_at)) : null,
          (isRevoked && lic.revoked_at) ? kv("Revoked at", fmtDateTime(lic.revoked_at)) : null,
          lic.local_ls.last_error ? kv("Last error", lic.local_ls.last_error) : null,
        ]),
        (isSuperseded || isReleased || isRevoked)
          ? el("div", { class: "callout warn tiny" }, [
              isSuperseded
                ? "This license is currently activated on another machine. Reactivate here to take the seat back — the previous machine will be downgraded the next time it heartbeats."
                : isReleased
                  ? "This activation was released back to the seat pool. Reactivate here to start using the license on this machine again."
                  : "This activation was revoked by your FORGE LLC operator. Reactivation will create a fresh activation if your license still has a free seat.",
            ])
          : null,
        el("div", { class: "row wrap" }, [
          el("button", {
            class: "btn primary",
            disabled: !isOwner,
            title: isOwner ? "" : "Only the Organization Owner can reactivate the license",
            onClick: async () => {
              try {
                await reactivateLicense();
                toast("Activated. This machine now holds a seat.", "success");
                navigate("/admin/license");
              } catch (err) {
                const msg = err?.body?.message || err.message || String(err);
                toast("Couldn't reactivate: " + msg, "danger");
              }
            },
          }, [isSuperseded ? "Reactivate (take seat back)" : isActivated ? "Reactivate" : "Activate"]),
          isActivated
            ? el("button", {
                class: "btn warn",
                disabled: !isOwner,
                title: isOwner
                  ? "Releases this seat back to your license pool so you can use it on a different machine"
                  : "Only the Organization Owner can release the activation",
                onClick: async () => {
                  if (!isOwner) return;
                  const ok = await dangerAction({
                    title: "Release this activation?",
                    message: "This installation will return its seat to your license pool and drop to the Community plan immediately. You can move the license to another machine, or click Reactivate later to take the seat back here.",
                    confirmLabel: "Release seat",
                  });
                  if (!ok) return;
                  try {
                    await releaseAct();
                    toast("Seat released — running on Community plan.", "warn");
                    navigate("/admin/license");
                  } catch (err) {
                    const msg = err?.body?.message || err.message || String(err);
                    toast("Couldn't release: " + msg, "danger");
                  }
                },
              }, ["Release this seat"])
            : null,
        ]),
      ]))
    : card("Offline activation", el("div", { class: "stack" }, [
        el("div", { class: "tiny muted" }, [
          "Paste the activation token issued by your FORGE LLC portal. The token is signed and verified locally — no internet connection is required to verify it.",
        ]),
        offlineTokenInput(isOwner, lic),
        el("div", { class: "tiny muted" }, [
          "Tip: activation tokens can also be deployed via the FORGE_LICENSE environment variable or a license.txt file in your data directory — handy for Kubernetes or air-gapped installs.",
        ]),
      ]));

  // ---- Feature breakdown by category ----
  const featuresPanel = card("Active features", featureGrid(lic));

  // ---- Catalog modal trigger ----
  const catalogBtn = el("button", {
    class: "btn ghost",
    onClick: () => {
      api("/api/license/catalog").then(cat => {
        const tierCards = cat.tiers.map(tier => card(
          `${tier.label} — ${tier.feature_count} feature${tier.feature_count === 1 ? "" : "s"}`,
          el("div", { class: "stack" }, [
            el("p", { class: "tiny muted" }, [tier.description]),
            el("div", { class: "tags" }, tier.features.map(f =>
              el("span", { class: "feature-pill", title: f.description }, [f.name]))),
          ]),
        ));
        modal({
          title: "Plan & feature catalog",
          body: el("div", { class: "stack" }, [
            el("p", { class: "tiny muted" }, [
              "These are the default features in each plan. A specific license can add or remove individual features per agreement with FORGE LLC.",
            ]),
            ...tierCards,
          ]),
        });
      }).catch(err => toast("We couldn't load the catalog: " + (err.message || err), "danger"));
    },
  }, ["View plan & feature catalog"]);

  return el("div", { class: "stack" }, [
    card("Plan summary", summary),
    activationPanel,
    el("div", {}, [catalogBtn]),
    featuresPanel,
  ]);
}

function onlineActivationStatusLabel(lic) {
  const s = lic?.activation_status || lic?.local_ls?.activation_status;
  switch (s) {
    case "active":     return "Active";
    case "superseded": return "Superseded by another machine";
    case "released":   return "Released to the pool";
    case "revoked":    return "Revoked by operator";
    case "cached":     return "Cached (offline)";
    case "uninitialised": return "Not yet activated";
    default:           return s || "—";
  }
}

function activationLabel(lic) {
  if (!lic) return "Unknown";
  if (lic.source === "local_ls") return "Online activation";
  if (lic.source === "local_ls_unreachable") return "Local server unreachable";
  if (lic.source === "db") return "Offline token (admin-installed)";
  if (lic.source === "env") return "Offline token (environment)";
  if (lic.source === "file") return "Offline token (file)";
  if (lic.source === "fallback") return "Unlicensed (Community)";
  return lic.source || "Unknown";
}

function seatLabel(lic) {
  if (!lic) return "—";
  const used = lic.usage?.active_users ?? "?";
  const total = lic.seats ?? "?";
  const hard = lic.hard_seat_cap;
  return `${used} of ${total}` + (hard && hard !== total ? ` (hard cap ${hard})` : "");
}

function featureGrid(lic) {
  if (!lic?.feature_details?.length) {
    return el("div", { class: "tiny muted" }, ["No features are currently enabled."]);
  }
  const byCategory = {};
  for (const f of lic.feature_details) {
    if (!byCategory[f.category]) byCategory[f.category] = [];
    byCategory[f.category].push(f);
  }
  return el("div", { class: "stack" }, Object.keys(byCategory).map(cat =>
    el("div", { class: "stack" }, [
      el("div", { class: "feature-category-label" }, [cat]),
      el("div", { class: "tags" }, byCategory[cat].map(f =>
        el("span", { class: "feature-pill on", title: f.description }, [f.name]))),
    ]),
  ));
}

function offlineTokenInput(isOwner, lic) {
  const tokenInput = el("textarea", {
    class: "ta",
    placeholder: "forge1.… — paste the token from your FORGE LLC portal",
    rows: "4",
    style: { width: "100%", "font-family": "monospace" },
  });
  return el("div", { class: "stack" }, [
    tokenInput,
    el("div", { class: "row wrap" }, [
      el("button", {
        class: "btn primary",
        disabled: !isOwner,
        title: isOwner ? "" : "Only the Organization Owner can install a license",
        onClick: async () => {
          if (!isOwner) return;
          const tok = tokenInput.value.trim();
          if (!tok) { toast("Paste a license token first.", "warn"); return; }
          try {
            const result = await installLic(tok);
            toast(`Activated: ${result.customer} (${result.tier_label || result.tier})`, "success");
            await refreshLicense();
            navigate("/admin/license");
          } catch (err) {
            const msg = err?.body?.message || err.message || "Couldn't install the license.";
            toast(msg, "danger");
          }
        },
      }, ["Install activation token"]),
      el("button", {
        class: "btn danger",
        disabled: !isOwner || !lic || lic.source === "fallback" || lic.source === "local_ls" || lic.source === "local_ls_unreachable",
        onClick: async () => {
          if (!isOwner) return;
          const ok = await dangerAction({
            title: "Remove the active license?",
            message: "Your installation will downgrade to the Community plan immediately. Paid features will be unavailable until a new license is installed.",
            confirmLabel: "Remove license",
          });
          if (!ok) return;
          try {
            await uninstallLic();
            await refreshLicense();
            toast("License removed — running on the Community plan.", "warn");
            navigate("/admin/license");
          } catch (err) {
            toast("Couldn't remove the license: " + (err.message || err), "danger");
          }
        },
      }, ["Remove license"]),
    ]),
  ]);
}

function statusKindForTier(t) {
  switch (t) {
    case "enterprise": return "success";
    case "team":       return "info";
    case "personal":   return "info";
    case "community":  return "warn";
    default:           return "";
  }
}

function kv(k, v) {
  return el("div", { class: "kv-row" }, [
    el("dt", {}, [k]),
    el("dd", {}, [v ?? "—"]),
  ]);
}

function fmtDate(s) {
  if (!s) return "—";
  try { return new Date(s).toISOString().slice(0, 10); } catch { return String(s); }
}

function fmtDateTime(s) {
  if (!s) return "—";
  try {
    const d = new Date(s);
    return d.toISOString().slice(0, 10) + " " + d.toISOString().slice(11, 16) + " UTC";
  } catch { return String(s); }
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
          if (!await confirm({ title: "Revoke token", message: `Revoke token ${t.id}? This cannot be undone.`, confirmLabel: "Revoke", variant: "danger" })) return;
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
        el("button", { class: "btn sm danger", onClick: async () => { if (!await confirm({ title: "Delete webhook", message: `Delete webhook ${w.name || w.id}?`, confirmLabel: "Delete", variant: "danger" })) return; await api(`/api/webhooks/${w.id}`, { method: "DELETE" }); refresh(); } }, ["×"]),
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
