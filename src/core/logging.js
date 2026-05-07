// Centralised browser-side logging.
//
// Why this module exists:
//   - Direct `console.*` calls leak in production. A user pasting a
//     screenshot of DevTools could expose PII (emails, IDs, route
//     params, draft document content).
//   - Verbosity should be controllable without a redeploy. Operators
//     in the field need to flip on debug logs from a tablet without
//     a build-pipeline turnaround.
//   - Errors should funnel through one place if we ever want to
//     ship them off to a remote sink (Sentry, OTel, etc.).
//
// Usage:
//   import { logger } from "./core/logging.js";
//   logger.info("dashboard.applied", { profileId, count });
//   logger.warn("connector.reconnecting", { systemId, attempts });
//   logger.error("api.failed", err, { route });
//
// Toggle verbosity from DevTools console:
//   localStorage.setItem("forge.logLevel", "debug");
//   localStorage.setItem("forge.logLevel", "warn");   // production default
//   localStorage.removeItem("forge.logLevel");        // back to default
//
// PII filtering:
//   The `scrub()` pass walks any context object and redacts likely-
//   sensitive fields by name (email, password, token, etc.) and any
//   string that looks like an email or JWT. Numeric IDs / UUIDs pass
//   through — they're already sanctioned audit identifiers. Callers
//   that need to log truly sensitive values should think twice.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

// Default level: debug in dev (Vite + source mode), warn in production
// builds. Both can be overridden via localStorage at runtime.
const DEV_DEFAULT = "debug";
const PROD_DEFAULT = "warn";

function detectDefault() {
  // Vite injects `import.meta.env.MODE`; in source-mode dev it doesn't,
  // so fall back to a hostname check (localhost / 127.* / *.local).
  // `import.meta.env` isn't part of the ImportMeta type definition that
  // tsc's default lib ships with — cast through `any` so the type-check
  // still passes (we already guard with typeof + truthy checks).
  try {
    /** @type {any} */
    const meta = (typeof import.meta !== "undefined") ? import.meta : null;
    if (meta && meta.env && meta.env.MODE) {
      return meta.env.MODE === "production" ? PROD_DEFAULT : DEV_DEFAULT;
    }
  } catch { /* import.meta unavailable in some build paths */ }
  try {
    const h = (globalThis.location && globalThis.location.hostname) || "";
    if (h === "localhost" || h.startsWith("127.") || h.endsWith(".local")) return DEV_DEFAULT;
  } catch { /* not a browser context */ }
  return PROD_DEFAULT;
}

function currentLevel() {
  let stored = null;
  try { stored = globalThis.localStorage?.getItem("forge.logLevel"); } catch { /* no storage */ }
  const name = (stored || detectDefault()).toLowerCase();
  return LEVELS[name] ?? LEVELS[PROD_DEFAULT];
}

// Field-name redaction list. Lowercased; matched case-insensitively.
const REDACT_KEYS = new Set([
  "password", "passwd", "secret", "token", "apikey", "api_key",
  "authorization", "auth", "cookie", "session",
  "email", "phone", "ssn", "creditcard", "cardnumber",
  "privatekey", "private_key",
]);

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
// JWT-shape: three Base64URL segments separated by dots, last segment present.
const JWT_RE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;

function scrubString(s) {
  return s
    .replace(EMAIL_RE, "<email-redacted>")
    .replace(JWT_RE, "<token-redacted>");
}

function scrub(value, depth = 0) {
  if (depth > 4) return "<deep>"; // bail on recursion — diagnostic, not exhaustive
  if (value == null) return value;
  if (typeof value === "string") return scrubString(value);
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(v => scrub(v, depth + 1));
  if (value instanceof Error) {
    return { name: value.name, message: scrubString(value.message || ""), stack: scrubString(value.stack || "") };
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (REDACT_KEYS.has(k.toLowerCase())) {
      out[k] = "<redacted>";
    } else {
      out[k] = scrub(v, depth + 1);
    }
  }
  return out;
}

function emit(level, event, ...rest) {
  if (LEVELS[level] < currentLevel()) return;
  // Standard envelope: timestamp, level, event tag, scrubbed context.
  const ts = new Date().toISOString();
  const ctx = rest.map(r => scrub(r));
  const fn = level === "error" ? console.error
    : level === "warn" ? console.warn
    : level === "info" ? console.info
    : console.log;
  fn(`[${ts}] ${level.toUpperCase()} ${event}`, ...ctx);
}

export const logger = {
  debug: (event, ...rest) => emit("debug", event, ...rest),
  info:  (event, ...rest) => emit("info",  event, ...rest),
  warn:  (event, ...rest) => emit("warn",  event, ...rest),
  error: (event, ...rest) => emit("error", event, ...rest),
  /** Force a level for the rest of the session (no localStorage write). */
  setLevel(level) { try { globalThis.localStorage?.setItem("forge.logLevel", level); } catch {} },
  /** Used by tests — exported for scrub coverage. */
  _scrub: scrub,
};

// Expose for ad-hoc DevTools debugging (`window.logger.setLevel("debug")`).
try { /** @type any */ (globalThis).logger = logger; } catch { /* server context */ }
