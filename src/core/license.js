// Client-side license entitlements.
//
// On boot, fetches /api/license once (server mode only) and caches the
// result. Exposes:
//
//   loadLicense()           — promise; resolves on first successful fetch.
//   license()               — synchronous getter for the cached entitlements.
//   hasFeature(name)        — boolean; demo mode returns true (full UI).
//   FEATURES                — string-constant catalog (mirror of server).
//   onLicenseChange(cb)     — subscribe to license updates.
//   refreshLicense()        — re-fetch (after install / uninstall).
//
// Demo mode (no backend): returns a synthetic enterprise license so the
// SPA shows every screen for inspection. Real server mode is the only
// surface that enforces tier gates.

import { mode as apiMode, api } from "./api.js";

export const FEATURES = Object.freeze({
  CORE_AUTH: "core.auth",
  CORE_DOCS: "core.docs",
  CORE_TEAM_SPACES: "core.team_spaces",
  CORE_AUDIT_VIEW: "core.audit.view",
  CORE_SEARCH: "core.search",
  CAD_VIEWER: "cad.viewer",
  CAD_DWG_CONVERSION: "cad.dwg_conversion",
  BIM_IFC_VIEWER: "bim.ifc_viewer",
  PDF_VIEWER: "pdf.viewer",
  MERMAID_DIAGRAMS: "diagrams.mermaid",
  THREE_D_VIEWER: "viewer.three_d",
  REVIEW_CYCLES: "workflow.review_cycles",
  COMMISSIONING_CHECKLISTS: "workflow.commissioning",
  RFI_LINKS: "workflow.rfi_links",
  FORM_SUBMISSIONS: "workflow.forms",
  MQTT_BRIDGE: "industrial.mqtt",
  OPCUA_BRIDGE: "industrial.opcua",
  I3X_API: "industrial.i3x",
  UNS_BROWSER: "industrial.uns",
  ERP_CONNECTORS: "enterprise.erp",
  ENTERPRISE_SYSTEMS: "enterprise.systems",
  WEBHOOKS: "enterprise.webhooks",
  N8N_AUTOMATIONS: "enterprise.n8n",
  AI_PROVIDERS: "enterprise.ai",
  GRAPHQL_API: "enterprise.graphql",
  EXTERNAL_LINKS: "enterprise.external_links",
  COMPLIANCE_CONSOLE: "governance.compliance",
  AUDIT_PACK_EXPORT: "governance.audit_pack",
  RETENTION_POLICIES: "governance.retention",
  LEGAL_HOLD: "governance.legal_hold",
  SSO_SAML: "governance.sso_saml",
  SSO_OIDC: "governance.sso_oidc",
  SCIM_PROVISIONING: "governance.scim",
  MFA_ENFORCEMENT: "governance.mfa_enforce",
  SSE_STREAMS: "ops.sse",
  PROMETHEUS_METRICS: "ops.prom",
  OTEL_TRACING: "ops.otel",
  HA_DEPLOYMENT: "ops.ha",
});

const DEMO_LICENSE = Object.freeze({
  source: "demo",
  customer: "Demo (no backend)",
  tier: "enterprise",
  edition: "demo",
  term: "perpetual",
  seats: 999,
  hard_seat_cap: 999,
  expires_at: null,
  maintenance_until: null,
  status: "ok",
  reasons: [],
  features: Object.values(FEATURES),
  usage: { active_users: 0, seats: 999 },
});

let _cached = null;
let _loadPromise = null;
const subs = new Set();

export function license() { return _cached; }

export function hasFeature(name) {
  if (apiMode() !== "server") return true; // demo mode: don't block UI
  if (!_cached) return false; // until loaded, fail closed for licensed surfaces
  return Array.isArray(_cached.features) && _cached.features.includes(name);
}

export function onLicenseChange(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}

function notify() {
  for (const fn of subs) {
    try { fn(_cached); } catch (err) { console.warn("[license] subscriber error", err); }
  }
}

export async function loadLicense() {
  if (_loadPromise) return _loadPromise;
  _loadPromise = (async () => {
    if (apiMode() !== "server") {
      _cached = DEMO_LICENSE;
      notify();
      return _cached;
    }
    try {
      _cached = await api("/api/license");
    } catch (err) {
      console.warn("[license] fetch failed; falling back to community", err);
      _cached = {
        source: "fallback", customer: "Unlicensed", tier: "community",
        edition: "community", term: "perpetual", seats: 3, hard_seat_cap: 5,
        expires_at: null, maintenance_until: null,
        status: "ok", reasons: [], features: [
          FEATURES.CORE_AUTH, FEATURES.CORE_DOCS, FEATURES.CORE_TEAM_SPACES,
          FEATURES.CORE_AUDIT_VIEW, FEATURES.CORE_SEARCH,
          FEATURES.PDF_VIEWER, FEATURES.MERMAID_DIAGRAMS, FEATURES.UNS_BROWSER,
        ],
        usage: { active_users: 0, seats: 3 },
      };
    }
    notify();
    return _cached;
  })();
  return _loadPromise;
}

export async function refreshLicense() {
  _loadPromise = null;
  _cached = null;
  return loadLicense();
}

export function installLicense(token) {
  return api("/api/license", { method: "POST", body: { token } }).then((data) => {
    _cached = data;
    notify();
    return data;
  });
}

export function uninstallLicense() {
  return api("/api/license", { method: "DELETE" }).then((data) => {
    _cached = data;
    notify();
    return data;
  });
}

/**
 * Force the FORGE app to re-pull from the local license server. Only
 * meaningful when the installation is in online-activation mode
 * (i.e. FORGE_LOCAL_LS_URL is set on the server). Returns the new
 * resolved license, or rejects with the server's error envelope.
 */
export function refreshActivation() {
  return api("/api/license/refresh", { method: "POST" }).then((data) => {
    _cached = data;
    notify();
    return data;
  });
}

/**
 * Banner severity for the header strip:
 *   - "danger"  : invalid, expired, grace expired, not activated
 *   - "warning" : expires within 30 days, seat overage, offline-in-grace
 *   - null      : healthy
 *
 * Always returns a sentence-cased English string suitable to show users.
 */
export function licenseBanner() {
  const lic = _cached;
  if (!lic) return null;
  if (lic.status === "invalid") {
    return { severity: "danger", text: "We couldn't verify the license signature. Running on the Community plan." };
  }
  if (lic.status === "expired") {
    return { severity: "danger", text: `Your license for ${lic.customer} expired on ${lic.expires_at?.slice(0, 10)}. Running on the Community plan.` };
  }
  if (lic.status === "not_activated") {
    return { severity: "danger", text: "This installation hasn't activated yet. Check that the local license server is reachable from this server." };
  }
  if (lic.status === "offline_grace_expired") {
    return { severity: "danger", text: "We haven't been able to reach your local license server for too long. Paid features have been disabled until activation succeeds again." };
  }
  if (lic.status === "not_yet_active") {
    return { severity: "warning", text: `Your license is dated to start on ${lic.starts_at?.slice(0, 10)}.` };
  }
  for (const r of lic.reasons || []) {
    const m = /^expires_in_(\d+)_days$/.exec(r);
    if (m) return { severity: "warning", text: `Your license expires in ${m[1]} day${m[1] === "1" ? "" : "s"}.` };
    if (r === "offline_in_grace_period") {
      return { severity: "warning", text: "The local license server has been unreachable; running on the cached entitlement until contact is restored." };
    }
  }
  if (lic.usage && lic.usage.active_users > lic.seats) {
    return {
      severity: "warning",
      text: `${lic.usage.active_users} of ${lic.seats} licensed seats are in use — you're currently over your plan limit.`,
    };
  }
  return null;
}
