// Outbound URL safety helpers.
//
// These guard server → external HTTP calls (webhooks today, AI providers
// and connector calls in future) against SSRF: an authenticated user
// pointing FORGE at `http://169.254.169.254/...` to dump cloud metadata,
// or at internal-only services like `http://localhost:11434` (Ollama),
// `http://gitea.internal/...`, etc.
//
// Policy
// ------
// 1. Only `http:` and `https:` schemes are allowed; `file:`, `gopher:`,
//    `ftp:` are rejected unconditionally.
// 2. In production (or `FORGE_STRICT_CONFIG=1`) only `https:` is allowed
//    by default. Set `FORGE_OUTBOUND_ALLOW_HTTP=1` to relax.
// 3. The hostname must resolve only to public-routable addresses. We do
//    not actually resolve DNS here (that requires per-call work); we
//    instead reject:
//      - Bare IP literals in private/loopback/link-local/CGNAT ranges.
//      - Hostnames that are well-known internal aliases (`localhost`,
//        `*.local`, `*.internal`, `*.lan`, `metadata.google.internal`).
//    Callers performing the actual fetch SHOULD additionally pass the
//    resolved socket address to `assertPublicAddress(addr)` once Node's
//    `lookup` callback fires; we expose that hook for future hardening.
// 4. An explicit allowlist (`FORGE_OUTBOUND_ALLOWLIST` =
//    comma-separated hostnames) overrides the heuristic check, which is
//    useful for self-hosted deployments that intentionally call an
//    internal webhook endpoint.

import net from "node:net";

const PRIVATE_V4 = [
  // 10.0.0.0/8
  (n) => (n[0] === 10),
  // 172.16.0.0/12
  (n) => (n[0] === 172 && (n[1] & 0xf0) === 16),
  // 192.168.0.0/16
  (n) => (n[0] === 192 && n[1] === 168),
  // 127.0.0.0/8 loopback
  (n) => (n[0] === 127),
  // 169.254.0.0/16 link-local + cloud metadata
  (n) => (n[0] === 169 && n[1] === 254),
  // 100.64.0.0/10 CGNAT
  (n) => (n[0] === 100 && (n[1] & 0xc0) === 64),
  // 0.0.0.0/8 reserved
  (n) => (n[0] === 0),
  // 224.0.0.0/4 multicast
  (n) => ((n[0] & 0xf0) === 224),
  // 240.0.0.0/4 reserved
  (n) => ((n[0] & 0xf0) === 240),
];

const INTERNAL_HOST_RES = [
  /^localhost$/i,
  /(^|\.)local$/i,
  /(^|\.)internal$/i,
  /(^|\.)lan$/i,
  /(^|\.)home\.arpa$/i,
  /(^|\.)docker\.internal$/i,
  /^metadata\.google\.internal$/i,
];

function ipv4ToBytes(s) {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const out = parts.map((p) => Number(p));
  if (out.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return out;
}

export function isPrivateIPv4(s) {
  const bytes = ipv4ToBytes(s);
  if (!bytes) return false;
  return PRIVATE_V4.some((m) => m(bytes));
}

export function isPrivateIPv6(s) {
  if (!s || typeof s !== "string") return false;
  const norm = s.toLowerCase().replace(/^\[|\]$/g, "");
  if (norm === "::" || norm === "::1") return true;
  if (norm.startsWith("fe80:") || norm.startsWith("fc") || norm.startsWith("fd")) return true;
  if (norm.startsWith("::ffff:")) {
    const v4 = norm.slice("::ffff:".length);
    return isPrivateIPv4(v4);
  }
  return false;
}

function isInternalHost(host) {
  if (!host) return true;
  return INTERNAL_HOST_RES.some((re) => re.test(host));
}

function readAllowlist(env = process.env) {
  return String(env.FORGE_OUTBOUND_ALLOWLIST || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function strictMode(env = process.env) {
  if (/^(1|true|yes|on)$/i.test(String(env.FORGE_STRICT_CONFIG || ""))) return true;
  return env.NODE_ENV === "production";
}

function allowHttp(env = process.env) {
  return /^(1|true|yes|on)$/i.test(String(env.FORGE_OUTBOUND_ALLOW_HTTP || ""));
}

/**
 * Validate an outbound URL string. Returns `{ ok: true, url }` on success,
 * `{ ok: false, reason }` on failure.
 */
export function validateOutboundUrl(input, env = process.env) {
  let u;
  try { u = new URL(String(input || "")); }
  catch { return { ok: false, reason: "invalid_url" }; }
  const proto = u.protocol;
  if (proto !== "http:" && proto !== "https:") return { ok: false, reason: "scheme_not_allowed" };
  if (proto === "http:" && strictMode(env) && !allowHttp(env)) {
    return { ok: false, reason: "https_required" };
  }

  // URL.hostname keeps the surrounding `[]` for IPv6 literals; strip them
  // so the IPv4/IPv6 detection below sees the bare address.
  const rawHost = (u.hostname || "").toLowerCase();
  const host = rawHost.replace(/^\[|\]$/g, "");
  if (!host) return { ok: false, reason: "no_host" };

  const allowlist = readAllowlist(env);
  if (allowlist.includes(host)) return { ok: true, url: u };

  if (net.isIPv4(host) && isPrivateIPv4(host)) return { ok: false, reason: "private_ip" };
  if (net.isIPv6(host) && isPrivateIPv6(host)) return { ok: false, reason: "private_ip" };
  if (isInternalHost(host)) return { ok: false, reason: "internal_host" };

  return { ok: true, url: u };
}

/**
 * Caller hook: once a socket address is resolved, assert it isn't
 * a private/loopback/link-local target. Returns `null` on pass,
 * a `{ reason }` object on fail. Callers can wire this into the
 * `lookup` option of `http.request` for defence-in-depth.
 */
export function assertPublicAddress(addr) {
  if (!addr) return { reason: "no_addr" };
  if (typeof addr === "string") {
    if (net.isIPv4(addr) && isPrivateIPv4(addr)) return { reason: "private_ip" };
    if (net.isIPv6(addr) && isPrivateIPv6(addr)) return { reason: "private_ip" };
    return null;
  }
  return null;
}
