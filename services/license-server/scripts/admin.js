#!/usr/bin/env node
// FORGE LLC license-server admin CLI.
//
// Usage:
//   FORGE_LICENSE_SIGNING_KEY_PATH=… node scripts/admin.js print-pubkey
//   node scripts/admin.js create-customer --name "Acme" --email billing@acme
//   node scripts/admin.js create-key --customer CUST-… --label "main"
//   node scripts/admin.js create-license --customer CUST-… --tier team --term annual --years 1 --seats 25
//   node scripts/admin.js list-customers
//   node scripts/admin.js revoke-license --license LIC-…
//
// All operations are direct DB calls — no HTTP, intentional. Run on
// the license-server host or via SSH. The HTTP `OPERATOR_API_TOKEN`
// surface is for remote tooling.

import crypto from "node:crypto";
import { db, uuid, now } from "../db.js";
import { publicKeyPem } from "../signing.js";

const args = process.argv.slice(2);
const cmd = args.shift();

function flag(name, opts = {}) {
  const i = args.indexOf("--" + name);
  if (i === -1) return opts.default;
  if (opts.boolean) return true;
  return args[i + 1];
}

function audit(actor, action, customerId, subject, detail) {
  db.prepare(`INSERT INTO audit_log (id, ts, actor, action, customer_id, subject, detail)
              VALUES (?,?,?,?,?,?,?)`)
    .run("AUD-" + crypto.randomBytes(6).toString("hex").toUpperCase(),
         new Date().toISOString(), actor, action, customerId || null, subject || null,
         JSON.stringify(detail || {}));
}

function die(msg, code = 2) { process.stderr.write("error: " + msg + "\n"); process.exit(code); }

function jsonOrEmpty(s, fallback) { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } }

const commands = {
  "print-pubkey": () => {
    process.stdout.write(publicKeyPem() + "\n");
  },

  "create-customer": () => {
    const name = flag("name") || die("--name required");
    const email = flag("email");
    const id = flag("id") || uuid("CUST");
    const ts = now();
    db.prepare(`INSERT INTO customers (id, name, contact_email, status, created_at, updated_at, notes)
                VALUES (?,?,?,?,?,?,?)`).run(id, name, email || null, "active", ts, ts, flag("notes") || null);
    audit("cli", "customer.create", id, id, { name });
    console.log(JSON.stringify({ id, name, contact_email: email || null }, null, 2));
  },

  "list-customers": () => {
    const rows = db.prepare(`
      SELECT c.id, c.name, c.contact_email, c.status,
             (SELECT id FROM licenses WHERE customer_id = c.id AND status = 'active' ORDER BY created_at DESC LIMIT 1) AS active_license_id,
             (SELECT MAX(last_seen_at) FROM activations WHERE customer_id = c.id) AS last_seen_at
        FROM customers c ORDER BY c.created_at DESC`).all();
    console.table(rows);
  },

  "create-key": () => {
    const customerId = flag("customer") || die("--customer required");
    const label = flag("label") || "default";
    const customer = db.prepare("SELECT id FROM customers WHERE id = ?").get(customerId);
    if (!customer) die("customer not found: " + customerId);
    const raw = "fla_" + crypto.randomBytes(24).toString("base64url");
    const hash = crypto.createHash("sha256").update(raw).digest("hex");
    const id = uuid("KEY");
    try {
      db.prepare(`INSERT INTO activation_keys (id, customer_id, label, key_hash, created_by, created_at)
                  VALUES (?,?,?,?,?,?)`).run(id, customerId, label, hash, "cli", now());
    } catch (err) {
      die("a key with that label already exists for this customer");
    }
    audit("cli", "activation_key.create", customerId, id, { label });
    console.log("Activation key (shown ONCE — copy it now):");
    console.log("  customer_id:    " + customerId);
    console.log("  label:          " + label);
    console.log("  activation_key: " + raw);
  },

  "list-keys": () => {
    const customerId = flag("customer") || die("--customer required");
    console.table(db.prepare("SELECT id, label, last_used_at, revoked_at, created_at FROM activation_keys WHERE customer_id = ? ORDER BY created_at DESC").all(customerId));
  },

  "revoke-key": () => {
    const id = flag("key") || die("--key required");
    db.prepare("UPDATE activation_keys SET revoked_at = ? WHERE id = ?").run(now(), id);
    audit("cli", "activation_key.revoke", null, id, {});
    console.log("revoked key " + id);
  },

  "create-license": () => {
    const customerId = flag("customer") || die("--customer required");
    const tier = flag("tier") || die("--tier required (community|personal|team|enterprise)");
    const term = flag("term") || "annual";
    const years = Number(flag("years") || (term === "annual" ? 1 : 0));
    const seats = Number(flag("seats") || 1);
    const startsAt = flag("starts") ? new Date(flag("starts") + "T00:00:00Z") : new Date();
    let expiresAt = null;
    if (term === "annual") {
      const e = new Date(startsAt);
      e.setUTCFullYear(e.getUTCFullYear() + (years || 1));
      expiresAt = e.toISOString();
    }
    let maintenanceUntil = null;
    if (term === "perpetual" && flag("maintenance")) {
      const m = new Date(startsAt);
      m.setUTCFullYear(m.getUTCFullYear() + Number(flag("maintenance")));
      maintenanceUntil = m.toISOString();
    }
    const featuresAdd = (flag("add") ? flag("add").split(",") : []).filter(Boolean);
    const featuresRemove = (flag("remove") ? flag("remove").split(",") : []).filter(Boolean);
    const id = uuid("LIC");
    db.transaction(() => {
      db.prepare("UPDATE licenses SET status = 'superseded', updated_at = ? WHERE customer_id = ? AND status = 'active'").run(now(), customerId);
      db.prepare(`INSERT INTO licenses (id, customer_id, tier, edition, term, seats, features_add, features_remove, deployment, starts_at, expires_at, maintenance_until, status, notes, created_by, created_at, updated_at)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        id, customerId, tier, flag("edition") || null, term, seats,
        JSON.stringify(featuresAdd), JSON.stringify(featuresRemove),
        flag("deployment") || "self_hosted",
        startsAt.toISOString(), expiresAt, maintenanceUntil,
        "active", flag("notes") || null, "cli", now(), now()
      );
    })();
    audit("cli", "license.create", customerId, id, { tier, term, seats });
    console.log(JSON.stringify({ id, customer_id: customerId, tier, term, seats, starts_at: startsAt.toISOString(), expires_at: expiresAt }, null, 2));
  },

  "revoke-license": () => {
    const id = flag("license") || die("--license required");
    const cur = db.prepare("SELECT customer_id FROM licenses WHERE id = ?").get(id);
    if (!cur) die("license not found: " + id);
    db.prepare("UPDATE licenses SET status = 'revoked', updated_at = ? WHERE id = ?").run(now(), id);
    db.prepare("UPDATE issued_entitlements SET revoked_at = ? WHERE license_id = ? AND revoked_at IS NULL").run(now(), id);
    audit("cli", "license.revoke", cur.customer_id, id, {});
    console.log("revoked license " + id);
  },

  "show-customer": () => {
    const id = flag("customer") || die("--customer required");
    const row = db.prepare("SELECT * FROM customers WHERE id = ?").get(id);
    if (!row) die("customer not found");
    const lic = db.prepare("SELECT * FROM licenses WHERE customer_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1").get(id);
    const keys = db.prepare("SELECT id, label, last_used_at, revoked_at FROM activation_keys WHERE customer_id = ?").all(id);
    const acts = db.prepare("SELECT id, instance_id, status, last_seen_at, client_version FROM activations WHERE customer_id = ? ORDER BY last_seen_at DESC LIMIT 10").all(id);
    const seatsUsed = db.prepare("SELECT COUNT(*) AS c FROM activations WHERE customer_id = ? AND status = 'active'").get(id);
    console.log(JSON.stringify({
      customer: row,
      active_license: lic ? { ...lic, features_add: jsonOrEmpty(lic.features_add, []), features_remove: jsonOrEmpty(lic.features_remove, []) } : null,
      seats_used: seatsUsed.c,
      keys, recent_activations: acts,
    }, null, 2));
  },

  "list-activations": () => {
    const customerId = flag("customer") || die("--customer required");
    const status = flag("status");
    const sql = status
      ? "SELECT id, instance_id, status, client_version, first_seen_at, last_seen_at, released_at, superseded_by FROM activations WHERE customer_id = ? AND status = ? ORDER BY last_seen_at DESC"
      : "SELECT id, instance_id, status, client_version, first_seen_at, last_seen_at, released_at, superseded_by FROM activations WHERE customer_id = ? ORDER BY last_seen_at DESC";
    const rows = status ? db.prepare(sql).all(customerId, status) : db.prepare(sql).all(customerId);
    console.table(rows);
  },

  "release-activation": () => {
    const id = flag("activation") || die("--activation required");
    const reason = flag("reason") || "operator-reclaim";
    const cur = db.prepare("SELECT customer_id, status, instance_id FROM activations WHERE id = ?").get(id);
    if (!cur) die("activation not found");
    if (cur.status !== "active") die(`activation is already ${cur.status}`);
    const ts = now();
    db.transaction(() => {
      db.prepare("UPDATE activations SET status = 'released', released_at = ?, released_by = ? WHERE id = ?")
        .run(ts, "operator", id);
      db.prepare("UPDATE activation_tokens SET status = 'released', status_changed_at = ? WHERE activation_id = ? AND status = 'active'")
        .run(ts, id);
    })();
    audit("cli", "activation.release", cur.customer_id, id, { reason, instance_id: cur.instance_id });
    console.log(`released activation ${id} (instance ${cur.instance_id}); seat returned to the pool`);
  },

  "revoke-activation": () => {
    const id = flag("activation") || die("--activation required");
    const reason = flag("reason") || "operator-revoke";
    const cur = db.prepare("SELECT customer_id, instance_id FROM activations WHERE id = ?").get(id);
    if (!cur) die("activation not found");
    const ts = now();
    db.transaction(() => {
      db.prepare("UPDATE activations SET status = 'revoked', revoked_at = ? WHERE id = ?").run(ts, id);
      db.prepare("UPDATE activation_tokens SET status = 'revoked', status_changed_at = ? WHERE activation_id = ? AND status = 'active'")
        .run(ts, id);
    })();
    audit("cli", "activation.revoke", cur.customer_id, id, { reason });
    console.log(`revoked activation ${id}`);
  },

  help: () => print_usage(),
};

function print_usage() {
  console.log(`forge-license-server admin
Commands:
  print-pubkey
  create-customer     --name STR [--email] [--id] [--notes]
  list-customers
  show-customer       --customer CUST-…
  create-key          --customer CUST-… [--label]
  list-keys           --customer CUST-…
  revoke-key          --key KEY-…
  create-license      --customer CUST-… --tier T --term annual|perpetual
                      [--years N] [--seats N] [--starts YYYY-MM-DD]
                      [--maintenance YEARS] [--add f1,f2] [--remove f1,f2]
                      [--edition STR] [--deployment self_hosted|cloud] [--notes]
  revoke-license      --license LIC-…
  list-activations    --customer CUST-… [--status active|superseded|released|revoked]
  release-activation  --activation ACT-…  [--reason STR]
                      Release an unreachable customer's seat back to the pool.
  revoke-activation   --activation ACT-…  [--reason STR]
                      Hard-revoke an activation (anti-piracy / fraud).`);
}

if (!cmd || !commands[cmd]) { print_usage(); process.exit(cmd ? 2 : 0); }
commands[cmd]();
