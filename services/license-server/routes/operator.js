// Operator API — staff-facing CRUD over customers, licenses, and
// activation keys. Authentication is a single shared bearer token
// (`OPERATOR_API_TOKEN`) intended to be locked down by a network
// policy / private hostname; this is NOT a public-internet surface.
//
// In a real deployment, put this behind your corporate VPN, IP allow-
// list, or mTLS edge.

import crypto from "node:crypto";

function authenticated(req) {
  const expected = process.env.OPERATOR_API_TOKEN || "";
  if (!expected || expected.length < 16) return false;
  const h = req.headers.authorization || "";
  if (!h.startsWith("Bearer ")) return false;
  const provided = h.slice(7).trim();
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

function audit(db, { actor, action, customer_id, subject, ip, detail }) {
  db.prepare(`INSERT INTO audit_log (id, ts, actor, action, customer_id, subject, remote_ip, detail)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run("AUD-" + crypto.randomBytes(6).toString("hex").toUpperCase(),
         new Date().toISOString(), actor, action, customer_id || null, subject || null,
         ip || null, JSON.stringify(detail || {}));
}

export default async function operatorRoutes(fastify) {
  const { db, uuid, now } = fastify.config;

  fastify.addHook("onRequest", async (req, reply) => {
    if (!authenticated(req)) {
      reply.code(401).send({ error: "operator_auth_invalid", message: "Provide a valid OPERATOR_API_TOKEN bearer." });
      return reply;
    }
  });

  // ---- Customers ----
  fastify.get("/customers", async () => {
    return db.prepare(`
      SELECT c.*, (SELECT COUNT(*) FROM activations WHERE customer_id = c.id) AS activation_count,
             (SELECT MAX(last_seen_at) FROM activations WHERE customer_id = c.id) AS last_seen_at,
             (SELECT id FROM licenses WHERE customer_id = c.id AND status = 'active' ORDER BY created_at DESC LIMIT 1) AS active_license_id
        FROM customers c ORDER BY c.created_at DESC
    `).all();
  });

  fastify.post("/customers", async (req, reply) => {
    const b = req.body || {};
    if (!b.name) return reply.code(400).send({ error: "bad_request", message: "name is required" });
    const id = b.id || uuid("CUST");
    const ts = now();
    db.prepare(`INSERT INTO customers (id, name, contact_email, status, created_at, updated_at, notes)
                VALUES (?,?,?,?,?,?,?)`).run(id, b.name, b.contact_email || null, "active", ts, ts, b.notes || null);
    audit(db, { actor: "operator", action: "customer.create", customer_id: id, subject: id, ip: req.ip, detail: { name: b.name } });
    return { id, name: b.name, contact_email: b.contact_email || null };
  });

  fastify.patch("/customers/:id", async (req, reply) => {
    const b = req.body || {};
    const cur = db.prepare("SELECT * FROM customers WHERE id = ?").get(req.params.id);
    if (!cur) return reply.code(404).send({ error: "not_found", message: "Unknown customer." });
    const next = {
      name: b.name ?? cur.name,
      contact_email: b.contact_email ?? cur.contact_email,
      status: b.status ?? cur.status,
      notes: b.notes ?? cur.notes,
    };
    db.prepare("UPDATE customers SET name = ?, contact_email = ?, status = ?, notes = ?, updated_at = ? WHERE id = ?")
      .run(next.name, next.contact_email, next.status, next.notes, now(), req.params.id);
    audit(db, { actor: "operator", action: "customer.update", customer_id: req.params.id, subject: req.params.id, ip: req.ip, detail: next });
    return { id: req.params.id, ...next };
  });

  // ---- Activation keys ----
  fastify.post("/customers/:id/keys", async (req, reply) => {
    const customer = db.prepare("SELECT id FROM customers WHERE id = ?").get(req.params.id);
    if (!customer) return reply.code(404).send({ error: "not_found", message: "Unknown customer." });
    const label = (req.body && req.body.label) || "default";
    const raw = "fla_" + crypto.randomBytes(24).toString("base64url");
    const hash = crypto.createHash("sha256").update(raw).digest("hex");
    const id = uuid("KEY");
    try {
      db.prepare(`INSERT INTO activation_keys (id, customer_id, label, key_hash, created_by, created_at)
                  VALUES (?,?,?,?,?,?)`).run(id, req.params.id, label, hash, "operator", now());
    } catch (err) {
      return reply.code(409).send({ error: "duplicate_label", message: `An activation key labelled "${label}" already exists for this customer.` });
    }
    audit(db, { actor: "operator", action: "activation_key.create", customer_id: req.params.id, subject: id, ip: req.ip, detail: { label } });
    // Return the raw token ONCE; we never store it again.
    return { id, customer_id: req.params.id, label, activation_key: raw };
  });

  fastify.delete("/keys/:id", async (req, reply) => {
    const cur = db.prepare("SELECT * FROM activation_keys WHERE id = ?").get(req.params.id);
    if (!cur) return reply.code(404).send({ error: "not_found", message: "Unknown activation key." });
    db.prepare("UPDATE activation_keys SET revoked_at = ? WHERE id = ?").run(now(), req.params.id);
    audit(db, { actor: "operator", action: "activation_key.revoke", customer_id: cur.customer_id, subject: req.params.id, ip: req.ip });
    return { ok: true, id: req.params.id };
  });

  fastify.get("/customers/:id/keys", async (req) => {
    return db.prepare(
      "SELECT id, label, last_used_at, revoked_at, created_at FROM activation_keys WHERE customer_id = ? ORDER BY created_at DESC"
    ).all(req.params.id);
  });

  // ---- Licenses ----
  fastify.post("/customers/:id/licenses", async (req, reply) => {
    const customer = db.prepare("SELECT id FROM customers WHERE id = ?").get(req.params.id);
    if (!customer) return reply.code(404).send({ error: "not_found", message: "Unknown customer." });
    const b = req.body || {};
    if (!b.tier) return reply.code(400).send({ error: "bad_request", message: "tier is required" });
    if (!b.term) return reply.code(400).send({ error: "bad_request", message: "term is required" });
    if (b.term === "annual" && !b.expires_at) return reply.code(400).send({ error: "bad_request", message: "annual licenses require expires_at" });
    const id = uuid("LIC");
    const startsAt = b.starts_at || now();
    db.transaction(() => {
      // Mark prior actives as superseded.
      db.prepare("UPDATE licenses SET status = 'superseded', updated_at = ? WHERE customer_id = ? AND status = 'active'").run(now(), req.params.id);
      db.prepare(`INSERT INTO licenses (id, customer_id, tier, edition, term, seats, features_add, features_remove, deployment, starts_at, expires_at, maintenance_until, status, notes, created_by, created_at, updated_at)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        id, req.params.id, b.tier, b.edition || null, b.term,
        Number(b.seats || 1),
        JSON.stringify(b.features?.add || []), JSON.stringify(b.features?.remove || []),
        b.deployment || "self_hosted",
        startsAt, b.expires_at || null, b.maintenance_until || null,
        "active", b.notes || null, "operator", now(), now()
      );
    })();
    audit(db, { actor: "operator", action: "license.create", customer_id: req.params.id, subject: id, ip: req.ip, detail: { tier: b.tier, term: b.term, seats: b.seats } });
    return { id, customer_id: req.params.id, tier: b.tier, term: b.term, seats: Number(b.seats || 1), starts_at: startsAt, expires_at: b.expires_at || null };
  });

  fastify.post("/licenses/:id/revoke", async (req, reply) => {
    const cur = db.prepare("SELECT * FROM licenses WHERE id = ?").get(req.params.id);
    if (!cur) return reply.code(404).send({ error: "not_found", message: "Unknown license." });
    db.prepare("UPDATE licenses SET status = 'revoked', updated_at = ? WHERE id = ?").run(now(), req.params.id);
    // Also revoke all in-flight entitlements so the next refresh fails.
    db.prepare("UPDATE issued_entitlements SET revoked_at = ? WHERE license_id = ? AND revoked_at IS NULL").run(now(), req.params.id);
    audit(db, { actor: "operator", action: "license.revoke", customer_id: cur.customer_id, subject: req.params.id, ip: req.ip });
    return { ok: true, id: req.params.id };
  });

  fastify.get("/customers/:id/licenses", async (req) => {
    return db.prepare("SELECT * FROM licenses WHERE customer_id = ? ORDER BY created_at DESC").all(req.params.id);
  });

  // ---- Activations / audit ----
  fastify.get("/customers/:id/activations", async (req) => {
    return db.prepare("SELECT id, instance_id, fingerprint, client_version, remote_ip, first_seen_at, last_seen_at FROM activations WHERE customer_id = ? ORDER BY last_seen_at DESC").all(req.params.id);
  });

  fastify.get("/customers/:id/audit", async (req) => {
    const limit = Math.min(500, Number(req.query?.limit || 100));
    return db.prepare("SELECT * FROM audit_log WHERE customer_id = ? ORDER BY ts DESC LIMIT ?").all(req.params.id, limit);
  });
}
