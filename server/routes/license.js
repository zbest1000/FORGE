// /api/license — read, install, remove license tokens.
//
// All routes other than `GET /api/license` require admin.view; the
// install / uninstall paths additionally require Organization Owner so
// only the org owner can change billing-relevant entitlements.

import { require_, can } from "../auth.js";
import {
  getLicense, installLicense, uninstallLicense,
  publicEntitlements, FEATURES, FEATURE_CATALOG, TIER_DEFAULTS, TIERS,
  TIER_LABELS, TIER_DESCRIPTIONS, describeFeature,
  activeUserCount, localLicenseStatus, pollLocalLicenseServer,
} from "../license.js";
import { audit } from "../audit.js";

// (license install/refresh actions audit-log themselves below)

export default async function licenseRoutes(app) {
  // Public-ish entitlements summary: any authenticated user can fetch
  // this so the SPA knows which screens to render. The raw token is
  // never returned here.
  app.get("/api/license", { preHandler: require_() }, async (req) => {
    const lic = getLicense();
    const out = publicEntitlements(lic);
    out.usage = { active_users: activeUserCount(), seats: lic.seats, hard_seat_cap: lic.hard_seat_cap };
    out.local_ls = localLicenseStatus();
    return out;
  });

  // Force the FORGE app to re-pull from the local license server right
  // now. Useful from the admin UI after the operator has just activated
  // or upgraded the customer's plan.
  app.post("/api/license/refresh", { preHandler: require_("admin.view") }, async (req, reply) => {
    if (!process.env.FORGE_LOCAL_LS_URL) {
      return reply.code(409).send({
        error: "local_ls_not_configured",
        message: "This installation isn't configured to use a local license server. Set FORGE_LOCAL_LS_URL or install an offline license token instead.",
      });
    }
    if (req.user.role !== "Organization Owner") {
      return reply.code(403).send({ error: "forbidden", message: "Only the Organization Owner can refresh the activation." });
    }
    const result = await pollLocalLicenseServer();
    audit({
      actor: req.user.id, action: "license.refresh",
      subject: result?.bundle_id || "no-bundle",
      detail: { ok: !!result, status: localLicenseStatus() },
    });
    const lic = getLicense({ skipCache: true });
    const out = publicEntitlements(lic);
    out.usage = { active_users: activeUserCount(), seats: lic.seats, hard_seat_cap: lic.hard_seat_cap };
    out.local_ls = localLicenseStatus();
    return out;
  });

  // Static catalog so the admin UI can render the full feature list,
  // including ones the current license does NOT have. Returns the
  // English-language display names and descriptions so customers see
  // friendly text everywhere — never raw flag ids like "industrial.mqtt".
  app.get("/api/license/catalog", { preHandler: require_() }, async () => {
    return {
      tiers: TIERS.map(t => ({
        id: t,
        label: TIER_LABELS[t],
        description: TIER_DESCRIPTIONS[t],
        feature_count: (TIER_DEFAULTS[t] || []).length,
        features: (TIER_DEFAULTS[t] || []).map(describeFeature),
      })),
      features: FEATURE_CATALOG,
      categories: groupByCategory(FEATURE_CATALOG),
    };
  });

  // Install (or replace) a license token. Returns the materialised
  // entitlements. 422 if the signature is bad.
  app.post("/api/license", { preHandler: require_("admin.view") }, async (req, reply) => {
    if (req.user.role !== "Organization Owner") {
      return reply.code(403).send({ error: "only Organization Owner may install a license" });
    }
    const token = (req.body && (req.body.token || req.body.license)) || "";
    if (typeof token !== "string" || token.length < 16) {
      return reply.code(400).send({ error: "missing token" });
    }
    try {
      const lic = installLicense(token, { actor: req.user.id });
      audit({
        actor: req.user.id, action: "license.install",
        subject: lic.license_id || "license",
        detail: { customer: lic.customer, tier: lic.tier, seats: lic.seats, expires_at: lic.expires_at },
      });
      return publicEntitlements(lic);
    } catch (err) {
      return reply.code(422).send({
        error: err.code === "ERR_FORGE_LICENSE_INVALID" ? "license_invalid" : "license_error",
        message: err.code === "ERR_FORGE_LICENSE_INVALID"
          ? "We couldn't verify this license — the signature didn't match. Make sure you're pasting the entire activation token from your portal."
          : "Couldn't install the license. Check the server log for details.",
        reasons: err.reasons || [String(err.message || err)],
      });
    }
  });

  app.delete("/api/license", { preHandler: require_("admin.view") }, async (req, reply) => {
    if (req.user.role !== "Organization Owner") {
      return reply.code(403).send({ error: "only Organization Owner may uninstall a license" });
    }
    const before = getLicense();
    const after = uninstallLicense();
    audit({
      actor: req.user.id, action: "license.uninstall",
      subject: before.license_id || "license",
      detail: { customer: before.customer },
    });
    return publicEntitlements(after);
  });
}

function groupByCategory(catalog) {
  const out = {};
  for (const f of catalog) {
    if (!out[f.category]) out[f.category] = [];
    out[f.category].push(f);
  }
  return out;
}
