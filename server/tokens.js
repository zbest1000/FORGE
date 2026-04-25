// Long-lived API tokens for machine clients. Format:
//   fgt_<tokenId>_<random>
// Only the `sha256` of the token is stored; the plaintext is returned to
// the user exactly once at creation.

import crypto from "node:crypto";
import { db, now, uuid } from "./db.js";
import { audit } from "./audit.js";

function hash(plain) { return crypto.createHash("sha256").update(plain).digest("hex"); }

export function createToken({ userId, name, scopes = ["view"], ttlDays = null }) {
  const tokenId = uuid("T").toLowerCase();
  const random = crypto.randomBytes(24).toString("base64url");
  const plain = `fgt_${tokenId}_${random}`;
  const row = {
    id: tokenId,
    user_id: userId,
    name,
    token_hash: hash(plain),
    scopes: JSON.stringify(scopes),
    last_used_at: null,
    expires_at: ttlDays ? new Date(Date.now() + ttlDays * 86400_000).toISOString() : null,
    revoked_at: null,
    created_at: now(),
  };
  db.prepare(`INSERT INTO api_tokens (id, user_id, name, token_hash, scopes, last_used_at, expires_at, revoked_at, created_at)
              VALUES (@id, @user_id, @name, @token_hash, @scopes, @last_used_at, @expires_at, @revoked_at, @created_at)`).run(row);
  audit({ actor: userId, action: "apitoken.create", subject: tokenId, detail: { name, scopes } });
  return { ...row, scopes, plaintext: plain };
}

export function listTokens(userId) {
  return db.prepare("SELECT id, name, scopes, last_used_at, expires_at, revoked_at, created_at FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC").all(userId)
    .map(r => ({ ...r, scopes: JSON.parse(r.scopes || "[]") }));
}

export function revokeToken(tokenId, actorId) {
  const r = db.prepare("UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(now(), tokenId);
  if (r.changes > 0) audit({ actor: actorId || "system", action: "apitoken.revoke", subject: tokenId });
  return r.changes > 0;
}

/**
 * Resolve a plaintext bearer into a user if and only if the token exists,
 * is not revoked, not expired, and matches the stored hash.
 */
export function resolveToken(plain, userById) {
  if (!plain || !plain.startsWith("fgt_")) return null;
  const h = hash(plain);
  const row = db.prepare("SELECT * FROM api_tokens WHERE token_hash = ?").get(h);
  if (!row) return null;
  if (row.revoked_at) return null;
  if (row.expires_at && Date.parse(row.expires_at) < Date.now()) return null;
  // Stamp last_used_at lazily (async-safe in Node, best-effort).
  db.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").run(now(), row.id);
  const user = userById(row.user_id);
  return user ? { user, tokenId: row.id, scopes: JSON.parse(row.scopes || "[]") } : null;
}
