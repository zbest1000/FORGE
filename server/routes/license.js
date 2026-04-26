// /api/license — read, install, remove license tokens.
//
// All routes other than `GET /api/license` require admin.view; the
// install / uninstall paths additionally require Organization Owner so
// only the org owner can change billing-relevant entitlements.

import { require_, can } from "../auth.js";
import {
  getLicense, installLicense, uninstallLicense,
  publicEntitlements, FEATURES, TIER_DEFAULTS, TIERS,
  activeUserCount,
} from "../license.js";
import { audit } from "../audit.js";

export default async function licenseRoutes(app) {
  // Public-ish entitlements summary: any authenticated user can fetch
  // this so the SPA knows which screens to render. The raw token is
  // never returned here.
  app.get("/api/license", { preHandler: require_() }, async (req) => {
    const lic = getLicense();
    const out = publicEntitlements(lic);
    out.usage = { active_users: activeUserCount(), seats: lic.seats, hard_seat_cap: lic.hard_seat_cap };
    return out;
  });

  // Static catalog so the admin UI can render the full feature list,
  // including ones the current license does NOT have.
  app.get("/api/license/catalog", { preHandler: require_() }, async () => {
    return {
      tiers: TIERS,
      tier_defaults: TIER_DEFAULTS,
      features: FEATURES,
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
