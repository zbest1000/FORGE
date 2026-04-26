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
  releaseActivation, reactivateLicense,
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

  // ---- Online activation control ----
  // The new model is one-time activation + lifetime token. The two
  // routes below cover the only legitimate runtime transitions:
  //
  //   POST /api/license/reactivate
  //     Triggers the local LS to (re-)activate against FORGE LLC.
  //     Used to take a previously-released seat back on this machine
  //     or to recover after FORGE LLC operator-released the seat.
  //
  //   POST /api/license/release
  //     Releases this activation back to the customer's seat pool so
  //     the same license can be reused on a different machine. Once
  //     released, this FORGE installation drops to the Community
  //     plan until reactivation.

  app.post("/api/license/reactivate", { preHandler: require_("admin.view") }, async (req, reply) => {
    if (!process.env.FORGE_LOCAL_LS_URL) {
      return reply.code(409).send({
        error: "local_ls_not_configured",
        message: "This installation isn't configured to use a local license server. Set FORGE_LOCAL_LS_URL, or install an offline license token instead.",
      });
    }
    if (req.user.role !== "Organization Owner") {
      return reply.code(403).send({ error: "forbidden", message: "Only the Organization Owner can reactivate the license." });
    }
    try {
      const result = await reactivateLicense();
      audit({
        actor: req.user.id, action: "license.reactivate",
        subject: result?.result?.activation_id || "reactivate",
        detail: { ok: true, status: localLicenseStatus() },
      });
    } catch (err) {
      return reply.code(502).send({
        error: err.code || "reactivate_failed",
        message: err.message || "Couldn't reactivate against the local license server.",
        detail: err.body || null,
      });
    }
    const lic = getLicense({ skipCache: true });
    const out = publicEntitlements(lic);
    out.usage = { active_users: activeUserCount(), seats: lic.seats, hard_seat_cap: lic.hard_seat_cap };
    out.local_ls = localLicenseStatus();
    return out;
  });

  app.post("/api/license/release", { preHandler: require_("admin.view") }, async (req, reply) => {
    if (!process.env.FORGE_LOCAL_LS_URL) {
      return reply.code(409).send({
        error: "local_ls_not_configured",
        message: "This installation isn't configured for online activation. Use the offline token controls instead.",
      });
    }
    if (req.user.role !== "Organization Owner") {
      return reply.code(403).send({ error: "forbidden", message: "Only the Organization Owner can release the activation." });
    }
    try {
      const result = await releaseActivation();
      audit({
        actor: req.user.id, action: "license.release",
        subject: result?.activation_id || "release",
        detail: result || {},
      });
    } catch (err) {
      return reply.code(502).send({
        error: err.code || "release_failed",
        message: err.message || "Couldn't release the activation.",
        detail: err.body || null,
      });
    }
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
