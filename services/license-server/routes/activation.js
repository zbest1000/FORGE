// Activation API — customer-facing.
//
// All routes require Bearer authentication with a customer activation
// key (SHA-256 stored in `activation_keys.key_hash`). On success we
// issue a signed entitlement bundle the customer's local LS can hand
// to its FORGE app instances.

import crypto from "node:crypto";

const ENGLISH_ERRORS = {
  auth_invalid: "We couldn't authenticate this activation. Check the customer ID and activation key.",
  auth_revoked: "This activation key has been revoked. Generate a new one in your FORGE LLC portal.",
  customer_disabled: "This customer account is currently disabled. Please contact FORGE LLC support.",
  license_not_found: "No active license is on file for this customer. Contact your FORGE LLC account manager.",
  license_expired: "Your license has expired. Please renew through your FORGE LLC portal.",
  license_starts_in_future: "Your license is dated to start in the future and is not yet active.",
  bad_request: "The request body was missing required fields.",
  rate_limited: "Too many activation attempts — please try again in a minute.",
};

function sha256Hex(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function err(reply, code, status, extra = {}) {
  return reply.code(status).send({
    error: code,
    message: ENGLISH_ERRORS[code] || code,
    ...extra,
  });
}

function getBearer(req) {
  const h = req.headers.authorization || "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : null;
}

function authenticate(req) {
  const tok = getBearer(req);
  if (!tok) return { ok: false, code: "auth_invalid" };
  const hash = sha256Hex(tok);
  const row = req.server.config.db.prepare(`
    SELECT k.id AS key_id, k.customer_id, k.revoked_at, c.status AS customer_status
      FROM activation_keys k JOIN customers c ON c.id = k.customer_id
     WHERE k.key_hash = ? LIMIT 1`).get(hash);
  if (!row) return { ok: false, code: "auth_invalid" };
  if (row.revoked_at) return { ok: false, code: "auth_revoked" };
  if (row.customer_status !== "active") return { ok: false, code: "customer_disabled" };
  // Best-effort `last_used_at` update; non-fatal.
  try {
    req.server.config.db.prepare("UPDATE activation_keys SET last_used_at = ? WHERE id = ?").run(req.server.config.now(), row.key_id);
  } catch {}
  return { ok: true, key_id: row.key_id, customer_id: row.customer_id };
}

function loadActiveLicense(db, customerId) {
  return db.prepare("SELECT * FROM licenses WHERE customer_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1").get(customerId);
}

function jsonOrEmpty(s, fallback) {
  if (!s) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}

function buildPayload(license, customer, activation, opts) {
  const issuedAt = new Date();
  const expires = new Date(issuedAt.getTime() + opts.ttl_s * 1000);
  return {
    v: 1,
    bundle_id: opts.uuid("ENT"),
    customer_id: customer.id,
    customer_name: customer.name,
    contact: customer.contact_email || null,
    license_id: license.id,
    tier: license.tier,
    edition: license.edition || license.tier,
    term: license.term,
    seats: license.seats,
    starts_at: license.starts_at,
    license_expires_at: license.expires_at || null,
    maintenance_until: license.maintenance_until || null,
    deployment: license.deployment,
    features: {
      add: jsonOrEmpty(license.features_add, []),
      remove: jsonOrEmpty(license.features_remove, []),
    },
    issued_at: issuedAt.toISOString(),
    expires_at: expires.toISOString(),
    refresh_at: new Date(issuedAt.getTime() + (opts.ttl_s - 600) * 1000).toISOString(),
    instance_id: activation?.instance_id || null,
  };
}

function recordActivation(db, customerId, keyId, body, ip) {
  const instanceId = String(body.instance_id || "").trim();
  if (!instanceId) return null;
  const fp = JSON.stringify(body.fingerprint || {});
  const ts = new Date().toISOString();
  const existing = db.prepare("SELECT id FROM activations WHERE customer_id = ? AND instance_id = ?").get(customerId, instanceId);
  if (existing) {
    db.prepare("UPDATE activations SET last_seen_at = ?, fingerprint = ?, client_version = ?, remote_ip = ?, activation_key_id = COALESCE(activation_key_id, ?) WHERE id = ?")
      .run(ts, fp, body.client_version || null, ip, keyId, existing.id);
    return existing.id;
  }
  const id = "ACT-" + crypto.randomBytes(6).toString("hex").toUpperCase();
  db.prepare(`INSERT INTO activations (id, customer_id, activation_key_id, instance_id, fingerprint, client_version, remote_ip, first_seen_at, last_seen_at)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, customerId, keyId, instanceId, fp, body.client_version || null, ip, ts, ts);
  return id;
}

function recordIssued(db, customerId, activationId, licenseId, payload) {
  db.prepare(`INSERT INTO issued_entitlements (id, customer_id, activation_id, license_id, issued_at, expires_at)
              VALUES (?,?,?,?,?,?)`)
    .run(payload.bundle_id, customerId, activationId, licenseId, payload.issued_at, payload.expires_at);
}

function audit(db, { actor, action, customer_id, subject, ip, detail }) {
  db.prepare(`INSERT INTO audit_log (id, ts, actor, action, customer_id, subject, remote_ip, detail)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run("AUD-" + crypto.randomBytes(6).toString("hex").toUpperCase(),
         new Date().toISOString(), actor, action, customer_id || null, subject || null,
         ip || null, JSON.stringify(detail || {}));
}

export default async function activationRoutes(fastify) {
  const cfg = fastify.config;

  // ---- POST /activate -------------------------------------------------
  fastify.post("/activate", async (req, reply) => {
    const auth = authenticate(req);
    if (!auth.ok) return err(reply, auth.code, auth.code === "customer_disabled" ? 403 : 401);
    if (!req.body || typeof req.body !== "object") return err(reply, "bad_request", 400);

    const license = loadActiveLicense(cfg.db, auth.customer_id);
    if (!license) return err(reply, "license_not_found", 404);
    const today = new Date();
    if (license.starts_at && new Date(license.starts_at) > today) return err(reply, "license_starts_in_future", 409, { starts_at: license.starts_at });
    if (license.expires_at && new Date(license.expires_at) < today) return err(reply, "license_expired", 410, { expires_at: license.expires_at });

    const customer = cfg.db.prepare("SELECT * FROM customers WHERE id = ?").get(auth.customer_id);
    const activationId = recordActivation(cfg.db, auth.customer_id, auth.key_id, req.body, req.ip);

    const payload = buildPayload(license, customer, { instance_id: req.body.instance_id }, {
      ttl_s: cfg.ENTITLEMENT_TTL_S,
      uuid: cfg.uuid,
    });
    const entitlement = cfg.signEntitlement(payload);
    recordIssued(cfg.db, auth.customer_id, activationId, license.id, payload);
    audit(cfg.db, {
      actor: "system",
      action: "license.activate",
      customer_id: auth.customer_id,
      subject: payload.bundle_id,
      ip: req.ip,
      detail: { activation_id: activationId, license_id: license.id, instance_id: req.body.instance_id || null },
    });

    return {
      entitlement,
      bundle_id: payload.bundle_id,
      issued_at: payload.issued_at,
      expires_at: payload.expires_at,
      refresh_at: payload.refresh_at,
      customer: { id: customer.id, name: customer.name },
      license: {
        id: license.id, tier: license.tier, term: license.term, seats: license.seats,
        starts_at: license.starts_at, expires_at: license.expires_at,
        maintenance_until: license.maintenance_until,
      },
    };
  });

  // ---- POST /refresh --------------------------------------------------
  // Same shape as /activate; refuses if the prior bundle has been
  // explicitly revoked. We don't otherwise enforce sequence: a fresh
  // bundle is fine and the local LS can take it from there.
  fastify.post("/refresh", async (req, reply) => {
    const auth = authenticate(req);
    if (!auth.ok) return err(reply, auth.code, auth.code === "customer_disabled" ? 403 : 401);
    const priorBundleId = String(req.body?.prior_bundle_id || "");
    if (priorBundleId) {
      const prior = cfg.db.prepare("SELECT customer_id, revoked_at FROM issued_entitlements WHERE id = ?").get(priorBundleId);
      if (prior && prior.customer_id !== auth.customer_id) return err(reply, "auth_invalid", 401);
      if (prior && prior.revoked_at) return err(reply, "auth_revoked", 401);
    }
    const license = loadActiveLicense(cfg.db, auth.customer_id);
    if (!license) return err(reply, "license_not_found", 404);
    const today = new Date();
    if (license.expires_at && new Date(license.expires_at) < today) return err(reply, "license_expired", 410, { expires_at: license.expires_at });

    const customer = cfg.db.prepare("SELECT * FROM customers WHERE id = ?").get(auth.customer_id);
    const activationId = recordActivation(cfg.db, auth.customer_id, auth.key_id, req.body || {}, req.ip);

    const payload = buildPayload(license, customer, { instance_id: req.body?.instance_id }, {
      ttl_s: cfg.ENTITLEMENT_TTL_S,
      uuid: cfg.uuid,
    });
    const entitlement = cfg.signEntitlement(payload);
    recordIssued(cfg.db, auth.customer_id, activationId, license.id, payload);
    audit(cfg.db, {
      actor: "system",
      action: "license.refresh",
      customer_id: auth.customer_id,
      subject: payload.bundle_id,
      ip: req.ip,
      detail: { prior_bundle_id: priorBundleId || null, license_id: license.id },
    });

    return {
      entitlement,
      bundle_id: payload.bundle_id,
      issued_at: payload.issued_at,
      expires_at: payload.expires_at,
      refresh_at: payload.refresh_at,
    };
  });

  // ---- POST /heartbeat ------------------------------------------------
  fastify.post("/heartbeat", async (req, reply) => {
    const auth = authenticate(req);
    if (!auth.ok) return err(reply, auth.code, auth.code === "customer_disabled" ? 403 : 401);
    const activationId = recordActivation(cfg.db, auth.customer_id, auth.key_id, req.body || {}, req.ip);
    return { ok: true, customer_id: auth.customer_id, activation_id: activationId, ts: cfg.now() };
  });
}
