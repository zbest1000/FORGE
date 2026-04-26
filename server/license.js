// FORGE — License module.
//
// Offline-verifiable, Ed25519-signed license tokens that gate product
// editions, feature flags, seat counts, and term (perpetual or annual).
//
// Format
// ------
// A license token is a single string:
//
//     forge1.<base64url(payload-json)>.<base64url(ed25519-signature)>
//
// `payload-json` is canonicalised (stable key order) before signing so
// re-encoding never changes the digest. The vendor signs the canonical
// payload bytes with a long-lived Ed25519 private key. FORGE servers
// (and clients) verify with the matching public key, which is bundled
// at build time and overridable via FORGE_LICENSE_PUBLIC_KEY for
// alternative key rotations / private vendors.
//
// Why Ed25519 (not HMAC, not RSA)
// -------------------------------
// - Verification is asymmetric, so the public key shipping with the
//   product is enough; the signing key never leaves the vendor side.
// - Ed25519 signatures are 64 bytes; payloads stay small enough to
//   paste into a textarea without line-wrapping headaches.
// - `node:crypto` ships Ed25519 in core (no extra deps).
//
// Editions / tiers
// ----------------
// Tiers map to default feature sets; a license MAY override individual
// features (`features.add`, `features.remove`). Order of resolution:
//
//   defaults_for(tier) ⊕ features.add ⊖ features.remove
//
// Term
// ----
// `term: "perpetual"` — license has no `expires_at`. Maintenance runs
// until `maintenance_until` (controls eligibility for new releases).
// `term: "annual"` — license has `expires_at`; after that, the
// installation downgrades to the `community` tier (read-only critical
// data + login still work; gated features fail closed).
//
// Seats
// -----
// `seats` is the licensed maximum count of *enabled* users. Going over
// is soft-allowed up to `seats * 1.1` for ten days (grace), then hard
// blocked from creating new users. An admin sees a banner immediately.
//
// This module is import-safe (no Fastify deps); it can be used by tests
// and the CLI as well as the server runtime.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { db, now } from "./db.js";
import { canonicalJSON } from "./crypto.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Tiers + feature catalog
// ---------------------------------------------------------------------------

/**
 * Authoritative list of feature flags. Adding a new gated feature means
 * adding it here and to the appropriate tier defaults below. Server
 * routes and client screens should call `hasFeature(name)`; never
 * hard-code tier comparisons.
 */
export const FEATURES = Object.freeze({
  // Core (always-on, here for completeness; gating these would brick the app)
  CORE_AUTH:                 "core.auth",
  CORE_DOCS:                 "core.docs",
  CORE_TEAM_SPACES:          "core.team_spaces",
  CORE_AUDIT_VIEW:           "core.audit.view",
  CORE_SEARCH:               "core.search",

  // Engineering surfaces
  CAD_VIEWER:                "cad.viewer",
  CAD_DWG_CONVERSION:        "cad.dwg_conversion",
  BIM_IFC_VIEWER:            "bim.ifc_viewer",
  PDF_VIEWER:                "pdf.viewer",
  MERMAID_DIAGRAMS:          "diagrams.mermaid",
  THREE_D_VIEWER:            "viewer.three_d",

  // Workflow
  REVIEW_CYCLES:             "workflow.review_cycles",
  COMMISSIONING_CHECKLISTS:  "workflow.commissioning",
  RFI_LINKS:                 "workflow.rfi_links",
  FORM_SUBMISSIONS:          "workflow.forms",

  // Industrial / IoT
  MQTT_BRIDGE:               "industrial.mqtt",
  OPCUA_BRIDGE:              "industrial.opcua",
  I3X_API:                   "industrial.i3x",
  UNS_BROWSER:               "industrial.uns",

  // Enterprise integrations
  ERP_CONNECTORS:            "enterprise.erp",
  ENTERPRISE_SYSTEMS:        "enterprise.systems",
  WEBHOOKS:                  "enterprise.webhooks",
  N8N_AUTOMATIONS:           "enterprise.n8n",
  AI_PROVIDERS:              "enterprise.ai",
  GRAPHQL_API:               "enterprise.graphql",
  EXTERNAL_LINKS:            "enterprise.external_links",

  // Compliance / governance
  COMPLIANCE_CONSOLE:        "governance.compliance",
  AUDIT_PACK_EXPORT:         "governance.audit_pack",
  RETENTION_POLICIES:        "governance.retention",
  LEGAL_HOLD:                "governance.legal_hold",
  SSO_SAML:                  "governance.sso_saml",
  SSO_OIDC:                  "governance.sso_oidc",
  SCIM_PROVISIONING:         "governance.scim",
  MFA_ENFORCEMENT:           "governance.mfa_enforce",

  // Scale / ops
  SSE_STREAMS:               "ops.sse",
  PROMETHEUS_METRICS:        "ops.prom",
  OTEL_TRACING:              "ops.otel",
  HA_DEPLOYMENT:             "ops.ha",
});

const ALL_FEATURES = Object.values(FEATURES);

/**
 * Tier-default feature sets. The license payload's `features.add` /
 * `features.remove` modify these per-issuance.
 */
export const TIER_DEFAULTS = Object.freeze({
  community: [
    FEATURES.CORE_AUTH, FEATURES.CORE_DOCS, FEATURES.CORE_TEAM_SPACES,
    FEATURES.CORE_AUDIT_VIEW, FEATURES.CORE_SEARCH,
    FEATURES.PDF_VIEWER, FEATURES.MERMAID_DIAGRAMS,
    FEATURES.UNS_BROWSER,
  ],
  personal: [
    ...[
      FEATURES.CORE_AUTH, FEATURES.CORE_DOCS, FEATURES.CORE_TEAM_SPACES,
      FEATURES.CORE_AUDIT_VIEW, FEATURES.CORE_SEARCH,
      FEATURES.PDF_VIEWER, FEATURES.MERMAID_DIAGRAMS, FEATURES.THREE_D_VIEWER,
      FEATURES.CAD_VIEWER, FEATURES.BIM_IFC_VIEWER,
      FEATURES.REVIEW_CYCLES, FEATURES.RFI_LINKS, FEATURES.FORM_SUBMISSIONS,
      FEATURES.UNS_BROWSER,
    ],
  ],
  team: [
    FEATURES.CORE_AUTH, FEATURES.CORE_DOCS, FEATURES.CORE_TEAM_SPACES,
    FEATURES.CORE_AUDIT_VIEW, FEATURES.CORE_SEARCH,
    FEATURES.PDF_VIEWER, FEATURES.MERMAID_DIAGRAMS, FEATURES.THREE_D_VIEWER,
    FEATURES.CAD_VIEWER, FEATURES.CAD_DWG_CONVERSION, FEATURES.BIM_IFC_VIEWER,
    FEATURES.REVIEW_CYCLES, FEATURES.COMMISSIONING_CHECKLISTS,
    FEATURES.RFI_LINKS, FEATURES.FORM_SUBMISSIONS,
    FEATURES.MQTT_BRIDGE, FEATURES.UNS_BROWSER, FEATURES.I3X_API,
    FEATURES.WEBHOOKS, FEATURES.AI_PROVIDERS, FEATURES.GRAPHQL_API,
    FEATURES.AUDIT_PACK_EXPORT, FEATURES.RETENTION_POLICIES,
    FEATURES.SSE_STREAMS, FEATURES.PROMETHEUS_METRICS,
  ],
  enterprise: ALL_FEATURES.slice(),
});

export const TIERS = Object.freeze(Object.keys(TIER_DEFAULTS));

const ENTERPRISE_LIMITS = { seats: Number.POSITIVE_INFINITY, hard: Number.POSITIVE_INFINITY };
const TIER_DEFAULT_SEATS = Object.freeze({
  community:  { seats: 3,   hard: 5 },
  personal:   { seats: 1,   hard: 1 },
  team:       { seats: 25,  hard: 30 },
  enterprise: ENTERPRISE_LIMITS,
});

// ---------------------------------------------------------------------------
// Public key handling
// ---------------------------------------------------------------------------

const BUNDLED_PUBKEY_PATH = path.resolve(__dirname, "..", "config", "license-pubkey.pem");
const PUBKEY_ENV = "FORGE_LICENSE_PUBLIC_KEY";

/**
 * Resolve the active vendor public key.
 *
 *  1. `FORGE_LICENSE_PUBLIC_KEY` env (PEM string or base64url of the raw
 *     32-byte key) — useful for self-signed vendor distributions.
 *  2. `config/license-pubkey.pem` shipped with the build.
 *  3. Built-in dev key (only in development; refuses to load in
 *     `NODE_ENV=production` so a forgotten dev key cannot ship live).
 */
export function loadVendorPublicKey({ allowDevKey = false } = {}) {
  const envValue = process.env[PUBKEY_ENV];
  if (envValue && envValue.trim()) {
    return parsePublicKey(envValue.trim());
  }
  if (fs.existsSync(BUNDLED_PUBKEY_PATH)) {
    const pem = fs.readFileSync(BUNDLED_PUBKEY_PATH, "utf8");
    return parsePublicKey(pem);
  }
  if (allowDevKey || process.env.NODE_ENV !== "production") {
    return parsePublicKey(DEV_PUBLIC_KEY_PEM);
  }
  throw new Error(
    "no license public key configured: set FORGE_LICENSE_PUBLIC_KEY or " +
    "ship config/license-pubkey.pem with the build",
  );
}

function parsePublicKey(material) {
  if (material.includes("BEGIN PUBLIC KEY")) {
    return crypto.createPublicKey({ key: material, format: "pem" });
  }
  // Treat as base64url of raw 32-byte Ed25519 public key.
  const raw = Buffer.from(material.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (raw.length !== 32) {
    throw new Error(`invalid raw Ed25519 public key length: ${raw.length}`);
  }
  // SPKI prefix for Ed25519 = 302a300506032b6570032100
  const der = Buffer.concat([
    Buffer.from("302a300506032b6570032100", "hex"),
    raw,
  ]);
  return crypto.createPublicKey({ key: der, format: "der", type: "spki" });
}

// Dev key — used in tests + local dev only. Generated once and committed
// here intentionally so unit tests are deterministic without external
// state. Production deployments MUST override via env or bundled PEM.
const DEV_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAE/FssrjASLNaIDkg1Fg3wH3qVTvbWFtdSYSLuzQSlyo=
-----END PUBLIC KEY-----`;

// Matching dev private key. NOT loaded in production paths; only tests
// and the `forge-license` CLI accept --dev-key to use it.
export const DEV_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIPA31a+g4x9IKRb9zfbiaobttc/jU6iuk3JmxBXEbBT8
-----END PRIVATE KEY-----`;

// ---------------------------------------------------------------------------
// Token encode / decode
// ---------------------------------------------------------------------------

const TOKEN_PREFIX = "forge1.";

function b64u(bufOrString) {
  const buf = typeof bufOrString === "string" ? Buffer.from(bufOrString, "utf8") : Buffer.from(bufOrString);
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64uDecode(s) {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  return Buffer.from((s + pad).replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/**
 * Sign a license payload. Caller controls the payload shape; this module
 * sets/normalises a few invariant fields (issued_at, version).
 */
export function signLicense(payload, privateKeyPemOrKeyObj) {
  const key = typeof privateKeyPemOrKeyObj === "string"
    ? crypto.createPrivateKey({ key: privateKeyPemOrKeyObj, format: "pem" })
    : privateKeyPemOrKeyObj;
  const normalised = normalisePayload(payload);
  const canonical = canonicalJSON(normalised);
  const sig = crypto.sign(null, Buffer.from(canonical, "utf8"), key);
  return TOKEN_PREFIX + b64u(canonical) + "." + b64u(sig);
}

/**
 * Verify and decode. Returns `{ payload, key_id, signature_ok }` and
 * never throws for signature mismatches — call sites can tolerate
 * gracefully.
 */
export function verifyLicense(token, publicKey = null) {
  const result = { payload: null, signature_ok: false, error: null, raw: token };
  if (!token || typeof token !== "string" || !token.startsWith(TOKEN_PREFIX)) {
    result.error = "malformed: missing prefix";
    return result;
  }
  const rest = token.slice(TOKEN_PREFIX.length);
  const parts = rest.split(".");
  if (parts.length !== 2) {
    result.error = "malformed: expected payload.signature";
    return result;
  }
  let payload;
  try {
    payload = JSON.parse(b64uDecode(parts[0]).toString("utf8"));
  } catch (err) {
    result.error = "malformed: payload not JSON";
    return result;
  }
  result.payload = payload;
  let signature;
  try {
    signature = b64uDecode(parts[1]);
  } catch (err) {
    result.error = "malformed: signature not base64url";
    return result;
  }
  let key;
  try {
    key = publicKey || loadVendorPublicKey();
  } catch (err) {
    result.error = "no public key: " + err.message;
    return result;
  }
  const canonical = canonicalJSON(normalisePayload(payload));
  result.signature_ok = crypto.verify(null, Buffer.from(canonical, "utf8"), key, signature);
  if (!result.signature_ok) result.error = "signature verification failed";
  return result;
}

function normalisePayload(p) {
  return {
    v: 1,
    license_id: p.license_id,
    customer: p.customer,
    contact: p.contact || null,
    edition: p.edition || "enterprise",
    tier: p.tier || "team",
    term: p.term || "annual",
    seats: Number(p.seats || 1),
    issued_at: p.issued_at,
    starts_at: p.starts_at || p.issued_at,
    expires_at: p.expires_at || null,
    maintenance_until: p.maintenance_until || null,
    features: {
      add: Array.isArray(p.features?.add) ? p.features.add.slice().sort() : [],
      remove: Array.isArray(p.features?.remove) ? p.features.remove.slice().sort() : [],
    },
    deployment: p.deployment || "self_hosted", // self_hosted | cloud
    notes: p.notes || null,
  };
}

// ---------------------------------------------------------------------------
// Active license selection + materialisation
// ---------------------------------------------------------------------------

const COMMUNITY_FALLBACK = Object.freeze({
  source: "fallback",
  tier: "community",
  edition: "community",
  term: "perpetual",
  seats: TIER_DEFAULT_SEATS.community.seats,
  hard_seat_cap: TIER_DEFAULT_SEATS.community.hard,
  customer: "Unlicensed",
  features: TIER_DEFAULTS.community.slice(),
  expires_at: null,
  maintenance_until: null,
  starts_at: null,
  issued_at: null,
  status: "ok",
  reasons: [],
});

let cached = null;
let cachedAt = 0;
const CACHE_MS = 5_000;

export function clearLicenseCache() {
  cached = null;
  cachedAt = 0;
}

/**
 * Resolve the *effective* license. Sources are checked in this order:
 *
 *   1. The license stored in the database (admin-installed).
 *   2. `FORGE_LICENSE` env var (handy for cloud/k8s deployments).
 *   3. A `license.txt` next to the data dir.
 *
 * Returns a fully-materialised entitlement object — never null.
 */
export function getLicense({ skipCache = false } = {}) {
  if (!skipCache && cached && Date.now() - cachedAt < CACHE_MS) return cached;

  const sources = [];
  const stored = readStoredToken();
  if (stored) sources.push({ source: "db", token: stored });
  if (process.env.FORGE_LICENSE) sources.push({ source: "env", token: process.env.FORGE_LICENSE });
  const fileToken = readFileToken();
  if (fileToken) sources.push({ source: "file", token: fileToken });

  for (const s of sources) {
    const verdict = materialiseToken(s.token, s.source);
    if (verdict) {
      cached = verdict;
      cachedAt = Date.now();
      return verdict;
    }
  }

  cached = { ...COMMUNITY_FALLBACK };
  cachedAt = Date.now();
  return cached;
}

function materialiseToken(token, source) {
  const verified = verifyLicense(token);
  const reasons = [];
  if (!verified.signature_ok) {
    reasons.push("signature_invalid: " + (verified.error || "unknown"));
    return {
      ...COMMUNITY_FALLBACK,
      source,
      status: "invalid",
      reasons,
      raw: token,
    };
  }
  const p = verified.payload;
  const tier = TIERS.includes(p.tier) ? p.tier : "community";
  const limits = TIER_DEFAULT_SEATS[tier] || ENTERPRISE_LIMITS;
  const features = computeFeatureSet(tier, p.features);
  const verdict = {
    source,
    raw: token,
    license_id: p.license_id,
    customer: p.customer,
    contact: p.contact,
    edition: p.edition || tier,
    tier,
    term: p.term || "annual",
    seats: Number(p.seats || limits.seats),
    hard_seat_cap: Math.max(Number(p.seats || 0), limits.hard) || limits.hard,
    issued_at: p.issued_at,
    starts_at: p.starts_at,
    expires_at: p.expires_at,
    maintenance_until: p.maintenance_until,
    deployment: p.deployment || "self_hosted",
    features,
    notes: p.notes,
    status: "ok",
    reasons,
  };

  const today = new Date();
  if (verdict.starts_at && new Date(verdict.starts_at) > today) {
    verdict.status = "not_yet_active";
    reasons.push(`starts_at ${verdict.starts_at} is in the future`);
  }
  if (verdict.term === "annual" && verdict.expires_at) {
    const exp = new Date(verdict.expires_at);
    if (exp < today) {
      verdict.status = "expired";
      reasons.push(`expired_at ${verdict.expires_at}`);
      // After expiry annual licenses fall back to community feature set
      // but keep their seats/customer for read-only display purposes.
      verdict.features = TIER_DEFAULTS.community.slice();
      verdict.tier = "community";
    } else {
      const days = Math.ceil((exp - today) / 86_400_000);
      if (days <= 30) reasons.push(`expires_in_${days}_days`);
    }
  }
  return verdict;
}

function computeFeatureSet(tier, override) {
  const base = new Set(TIER_DEFAULTS[tier] || []);
  for (const f of override?.add || []) base.add(f);
  for (const f of override?.remove || []) base.delete(f);
  return [...base].sort();
}

// ---------------------------------------------------------------------------
// Storage (in the existing SQLite db)
// ---------------------------------------------------------------------------

function readStoredToken() {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'license_token'").get();
    return row?.value || null;
  } catch {
    return null;
  }
}

function readFileToken() {
  try {
    const dataDir = process.env.FORGE_DATA_DIR || path.resolve(__dirname, "..", "data");
    const p = path.join(dataDir, "license.txt");
    if (fs.existsSync(p)) return fs.readFileSync(p, "utf8").trim();
  } catch {
    // ignore
  }
  return null;
}

export function installLicense(token, { actor = "system" } = {}) {
  const verdict = materialiseToken(token, "db");
  if (!verdict || verdict.status === "invalid") {
    const e = new Error("license signature verification failed");
    e.code = "ERR_FORGE_LICENSE_INVALID";
    e.reasons = verdict?.reasons || [];
    throw e;
  }
  db.prepare("INSERT INTO meta(key, value) VALUES('license_token', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(token);
  db.prepare("INSERT INTO meta(key, value) VALUES('license_installed_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(new Date().toISOString());
  db.prepare("INSERT INTO meta(key, value) VALUES('license_installed_by', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(String(actor));
  clearLicenseCache();
  return getLicense({ skipCache: true });
}

export function uninstallLicense() {
  db.prepare("DELETE FROM meta WHERE key IN ('license_token','license_installed_at','license_installed_by')").run();
  clearLicenseCache();
  return getLicense({ skipCache: true });
}

// ---------------------------------------------------------------------------
// Runtime helpers used by routes / Fastify hooks
// ---------------------------------------------------------------------------

export function hasFeature(featureName, license = getLicense()) {
  return Array.isArray(license.features) && license.features.includes(featureName);
}

/**
 * Fastify pre-handler: requires that the active license includes the
 * given feature. Designed to be combined with `require_(capability)`
 * which already enforces RBAC.
 */
export function requireFeature(featureName) {
  return async (req, reply) => {
    const lic = getLicense();
    if (!hasFeature(featureName, lic)) {
      reply.code(402).send({
        error: "feature_not_licensed",
        feature: featureName,
        tier: lic.tier,
        edition: lic.edition,
        upgrade_url: process.env.FORGE_UPGRADE_URL || "https://forge.local/upgrade",
      });
      return reply;
    }
  };
}

/**
 * Public "what does this installation have?" payload, suitable for
 * sending to authenticated clients. Strips the raw token.
 */
export function publicEntitlements(license = getLicense()) {
  return {
    source: license.source,
    customer: license.customer,
    contact: license.contact,
    license_id: license.license_id,
    tier: license.tier,
    edition: license.edition,
    term: license.term,
    seats: license.seats,
    hard_seat_cap: license.hard_seat_cap,
    issued_at: license.issued_at,
    starts_at: license.starts_at,
    expires_at: license.expires_at,
    maintenance_until: license.maintenance_until,
    deployment: license.deployment,
    features: license.features.slice(),
    status: license.status,
    reasons: license.reasons.slice(),
  };
}

/** Active (non-disabled) user count, used to enforce seats. */
export function activeUserCount() {
  try {
    const row = db.prepare("SELECT COUNT(*) AS c FROM users WHERE disabled = 0").get();
    return Number(row?.c || 0);
  } catch {
    return 0;
  }
}

/**
 * Returns `{ allowed, reason }` for adding a user. Soft-allows up to the
 * `hard_seat_cap`; hard-blocks beyond that.
 */
export function canAddUser(license = getLicense()) {
  const used = activeUserCount();
  if (used + 1 <= license.seats) return { allowed: true, used, seats: license.seats };
  if (used + 1 <= license.hard_seat_cap) {
    return { allowed: true, soft: true, used, seats: license.seats, hard_cap: license.hard_seat_cap };
  }
  return { allowed: false, used, seats: license.seats, hard_cap: license.hard_seat_cap };
}

/** Marker so `now()` is reachable from CLI without re-importing the db. */
export const _internal = { now };
