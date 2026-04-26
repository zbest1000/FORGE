// Activation API — customer-facing.
//
// New activation model (v2):
//
//   - POST /api/v1/activate    Claim a seat slot. Marks any prior
//                              active activation for this customer
//                              with the same instance_id as
//                              superseded; if there is room in the
//                              license's seat budget, claims a new
//                              slot; otherwise replaces the oldest
//                              activation (last-writer-wins).
//                              Returns a long-lived signed
//                              activation1.* token.
//
//   - POST /api/v1/release     Voluntarily return an activation to
//                              the pool. Caller proves possession of
//                              the activation token id.
//
//   - POST /api/v1/heartbeat   Lightweight, opportunistic check: tells
//                              the caller whether the activation is
//                              still active (or superseded/released/
//                              revoked) so the customer's machine can
//                              react. Does NOT issue a new token.
//
// Authentication: bearer activation_key (sha256 stored in DB).

import crypto from "node:crypto";

const ENGLISH_ERRORS = {
  auth_invalid: "We couldn't authenticate this request. Check the customer ID and activation key.",
  auth_revoked: "This activation key has been revoked. Generate a new one in your FORGE LLC portal.",
  customer_disabled: "This customer account is currently disabled. Please contact FORGE LLC support.",
  license_not_found: "No active license is on file for this customer. Contact your FORGE LLC account manager.",
  license_expired: "Your license has expired. Please renew through your FORGE LLC portal.",
  license_starts_in_future: "Your license is dated to start in the future and is not yet active.",
  bad_request: "The request body was missing required fields.",
  rate_limited: "Too many requests — please try again in a minute.",
  not_active: "This activation is no longer active.",
  superseded: "This activation has been replaced by another machine. Run activate again to take over the seat.",
  released: "This activation has been released back to the pool.",
  revoked: "This activation has been revoked by the FORGE LLC operator.",
  not_found: "No matching activation was found for this customer.",
};

function sha256Hex(s) { return crypto.createHash("sha256").update(s).digest("hex"); }

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
  try {
    req.server.config.db.prepare("UPDATE activation_keys SET last_used_at = ? WHERE id = ?")
      .run(req.server.config.now(), row.key_id);
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
  const issuedAt = new Date().toISOString();
  return {
    v: 1,
    activation_id: activation.id,
    activation_token_id: opts.activation_token_id,
    instance_id: activation.instance_id,
    bound_fingerprint: jsonOrEmpty(activation.bound_fingerprint, {}),
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
    issued_at: issuedAt,
    // No `expires_at` for the activation token itself — only the
    // license `license_expires_at` constrains validity. The FORGE
    // app re-checks the license expiry against wall clock on every
    // boot.
  };
}

function audit(db, { actor, action, customer_id, subject, ip, detail }) {
  db.prepare(`INSERT INTO audit_log (id, ts, actor, action, customer_id, subject, remote_ip, detail)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run("AUD-" + crypto.randomBytes(6).toString("hex").toUpperCase(),
         new Date().toISOString(), actor, action, customer_id || null, subject || null,
         ip || null, JSON.stringify(detail || {}));
}

/**
 * Mark all prior active activations for a (customer, license) tuple
 * as superseded by a new activation. Returns the count.
 */
function supersedeRest(db, customerId, licenseId, exceptActivationId, byActivationId) {
  const ts = new Date().toISOString();
  const sup = db.prepare(`
    UPDATE activations SET status = 'superseded', superseded_at = ?, superseded_by = ?
    WHERE customer_id = ? AND status = 'active' AND id != ?
  `).run(ts, byActivationId, customerId, exceptActivationId).changes;
  if (sup > 0) {
    db.prepare(`
      UPDATE activation_tokens SET status = 'superseded', status_changed_at = ?
      WHERE customer_id = ? AND status = 'active' AND license_id = ?
        AND activation_id != ?
    `).run(ts, customerId, licenseId, exceptActivationId);
  }
  return sup;
}

/**
 * Reuse an existing activation row for the same instance_id, or
 * create a fresh one. Always sets status='active'. The unique
 * (customer_id, instance_id) index handles dedup.
 */
function upsertActivation(db, { customer_id, key_id, instance_id, fingerprint, client_version, ip }) {
  const ts = new Date().toISOString();
  const existing = db.prepare("SELECT * FROM activations WHERE customer_id = ? AND instance_id = ?")
    .get(customer_id, instance_id);
  if (existing) {
    db.prepare(`UPDATE activations
                   SET status = 'active', released_at = NULL, released_by = NULL,
                       superseded_at = NULL, superseded_by = NULL, revoked_at = NULL,
                       last_seen_at = ?, fingerprint = ?, bound_fingerprint = ?,
                       client_version = ?, remote_ip = ?, activation_key_id = ?
                 WHERE id = ?`)
      .run(ts, JSON.stringify(fingerprint || {}), JSON.stringify(fingerprint || {}),
           client_version || null, ip, key_id, existing.id);
    return { id: existing.id, instance_id, fingerprint, bound_fingerprint: JSON.stringify(fingerprint || {}), reused: true };
  }
  const id = "ACT-" + crypto.randomBytes(6).toString("hex").toUpperCase();
  db.prepare(`INSERT INTO activations
              (id, customer_id, activation_key_id, instance_id, fingerprint, bound_fingerprint,
               client_version, remote_ip, first_seen_at, last_seen_at, status)
              VALUES (?,?,?,?,?,?,?,?,?,?, 'active')`)
    .run(id, customer_id, key_id, instance_id,
         JSON.stringify(fingerprint || {}), JSON.stringify(fingerprint || {}),
         client_version || null, ip, ts, ts);
  return { id, instance_id, fingerprint, bound_fingerprint: JSON.stringify(fingerprint || {}), reused: false };
}

export default async function activationRoutes(fastify) {
  const cfg = fastify.config;

  // ---- POST /activate -------------------------------------------------
  fastify.post("/activate", async (req, reply) => {
    const auth = authenticate(req);
    if (!auth.ok) return err(reply, auth.code, auth.code === "customer_disabled" ? 403 : 401);
    if (!req.body || typeof req.body !== "object") return err(reply, "bad_request", 400);
    const instanceId = String(req.body.instance_id || "").trim();
    if (!instanceId) return err(reply, "bad_request", 400, { detail: "instance_id is required" });

    const license = loadActiveLicense(cfg.db, auth.customer_id);
    if (!license) return err(reply, "license_not_found", 404);
    const today = new Date();
    if (license.starts_at && new Date(license.starts_at) > today)
      return err(reply, "license_starts_in_future", 409, { starts_at: license.starts_at });
    if (license.expires_at && new Date(license.expires_at) < today)
      return err(reply, "license_expired", 410, { expires_at: license.expires_at });

    const customer = cfg.db.prepare("SELECT * FROM customers WHERE id = ?").get(auth.customer_id);

    // 1) Upsert this machine's activation row + mark it active.
    const act = upsertActivation(cfg.db, {
      customer_id: auth.customer_id,
      key_id: auth.key_id,
      instance_id: instanceId,
      fingerprint: req.body.fingerprint || {},
      client_version: req.body.client_version || null,
      ip: req.ip,
    });

    // 2) Enforce the seat budget. Count *other* still-active rows for
    //    this customer; if we're over license.seats, evict the oldest
    //    by `last_seen_at` ascending. Last-writer-wins.
    const supersededRows = [];
    cfg.db.transaction(() => {
      const others = cfg.db.prepare(`
        SELECT id, last_seen_at FROM activations
         WHERE customer_id = ? AND status = 'active' AND id != ?
         ORDER BY last_seen_at ASC
      `).all(auth.customer_id, act.id);
      const overage = others.length + 1 - Number(license.seats || 1);
      if (overage > 0) {
        const ts = new Date().toISOString();
        for (let i = 0; i < overage; i++) {
          const victim = others[i];
          cfg.db.prepare(`UPDATE activations SET status = 'superseded', superseded_at = ?, superseded_by = ? WHERE id = ?`)
            .run(ts, act.id, victim.id);
          cfg.db.prepare(`UPDATE activation_tokens SET status = 'superseded', status_changed_at = ?
                          WHERE activation_id = ? AND status = 'active'`)
            .run(ts, victim.id);
          supersededRows.push(victim.id);
        }
      }
    })();

    // 3) Issue a fresh activation token (replacing the previous one
    //    for this activation, if any).
    const tokenId = "TOK-" + crypto.randomBytes(6).toString("hex").toUpperCase();
    const issuedAt = new Date().toISOString();
    cfg.db.prepare(`UPDATE activation_tokens SET status = 'superseded', status_changed_at = ?
                    WHERE activation_id = ? AND status = 'active'`)
      .run(issuedAt, act.id);
    cfg.db.prepare(`INSERT INTO activation_tokens (id, customer_id, activation_id, license_id, issued_at, status)
                    VALUES (?,?,?,?,?, 'active')`)
      .run(tokenId, auth.customer_id, act.id, license.id, issuedAt);
    cfg.db.prepare(`UPDATE activations SET activation_token_id = ? WHERE id = ?`).run(tokenId, act.id);

    const fullAct = cfg.db.prepare("SELECT * FROM activations WHERE id = ?").get(act.id);
    const payload = buildPayload(license, customer, fullAct, { activation_token_id: tokenId });
    const activationToken = cfg.signEntitlement(payload);

    audit(cfg.db, {
      actor: "system",
      action: "license.activate",
      customer_id: auth.customer_id,
      subject: act.id,
      ip: req.ip,
      detail: {
        token_id: tokenId, license_id: license.id, instance_id: instanceId,
        superseded: supersededRows, reused: act.reused,
      },
    });

    return {
      activation_token: activationToken,
      activation_id: act.id,
      activation_token_id: tokenId,
      issued_at: issuedAt,
      customer: { id: customer.id, name: customer.name },
      license: {
        id: license.id, tier: license.tier, term: license.term, seats: license.seats,
        starts_at: license.starts_at, expires_at: license.expires_at,
        maintenance_until: license.maintenance_until,
      },
      superseded_activation_ids: supersededRows,
      reused: act.reused,
    };
  });

  // ---- POST /release --------------------------------------------------
  // Voluntary return of an activation slot. Caller proves possession by
  // sending activation_token_id; we also accept activation_id + customer
  // for operator-initiated reclaim.
  fastify.post("/release", async (req, reply) => {
    const auth = authenticate(req);
    if (!auth.ok) return err(reply, auth.code, auth.code === "customer_disabled" ? 403 : 401);
    const tokenId = String(req.body?.activation_token_id || "").trim();
    const activationId = String(req.body?.activation_id || "").trim();
    if (!tokenId && !activationId) return err(reply, "bad_request", 400, { detail: "activation_token_id or activation_id required" });

    const tokenRow = tokenId
      ? cfg.db.prepare("SELECT * FROM activation_tokens WHERE id = ? AND customer_id = ?").get(tokenId, auth.customer_id)
      : null;
    const targetActId = tokenRow?.activation_id || activationId;
    const act = targetActId
      ? cfg.db.prepare("SELECT * FROM activations WHERE id = ? AND customer_id = ?").get(targetActId, auth.customer_id)
      : null;
    if (!act) return err(reply, "not_found", 404);
    if (act.status !== "active") return err(reply, act.status, 409, { current_status: act.status });

    const ts = new Date().toISOString();
    cfg.db.transaction(() => {
      cfg.db.prepare(`UPDATE activations SET status = 'released', released_at = ?, released_by = ? WHERE id = ?`)
        .run(ts, "self", act.id);
      cfg.db.prepare(`UPDATE activation_tokens SET status = 'released', status_changed_at = ?
                      WHERE activation_id = ? AND status = 'active'`)
        .run(ts, act.id);
    })();
    audit(cfg.db, {
      actor: "system", action: "license.release", customer_id: auth.customer_id, subject: act.id,
      ip: req.ip, detail: { token_id: tokenRow?.id || null, by: "self" },
    });
    return { ok: true, activation_id: act.id, status: "released", released_at: ts };
  });

  // ---- POST /heartbeat ------------------------------------------------
  // Opportunistic liveness + supersession detection.
  // Body: { activation_token_id, instance_id, fingerprint?, client_version? }
  // Returns: { active, status, superseded_by, last_seen_at } and updates last_seen_at.
  fastify.post("/heartbeat", async (req, reply) => {
    const auth = authenticate(req);
    if (!auth.ok) return err(reply, auth.code, auth.code === "customer_disabled" ? 403 : 401);
    const tokenId = String(req.body?.activation_token_id || "").trim();
    if (!tokenId) return err(reply, "bad_request", 400, { detail: "activation_token_id required" });

    const tokenRow = cfg.db.prepare("SELECT * FROM activation_tokens WHERE id = ? AND customer_id = ?")
      .get(tokenId, auth.customer_id);
    if (!tokenRow) return err(reply, "not_found", 404);
    const act = cfg.db.prepare("SELECT * FROM activations WHERE id = ? AND customer_id = ?")
      .get(tokenRow.activation_id, auth.customer_id);

    const ts = new Date().toISOString();
    cfg.db.prepare("UPDATE activations SET last_seen_at = ?, remote_ip = COALESCE(?, remote_ip) WHERE id = ?")
      .run(ts, req.ip || null, act.id);

    return {
      active: tokenRow.status === "active",
      status: tokenRow.status,
      activation_status: act.status,
      superseded_by: act.superseded_by || null,
      released_at: act.released_at || null,
      revoked_at: act.revoked_at || null,
      last_seen_at: ts,
      message: tokenRow.status === "active"
        ? "This activation is active."
        : tokenRow.status === "superseded"
          ? "This activation has been replaced by another machine. To take this seat back, run activation again."
          : tokenRow.status === "released"
            ? "This activation was released and is no longer in use."
            : tokenRow.status === "revoked"
              ? "This activation has been revoked by the FORGE LLC operator."
              : "Unknown status.",
    };
  });
}
