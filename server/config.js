// Centralized server configuration.
//
// Production and strict-mode startup must fail when security-critical
// settings are missing, left at documented/demo defaults, or too short for
// enterprise deployments. Tests and local development can still use safe
// defaults unless FORGE_STRICT_CONFIG=1 is set.

const DEFAULTS = {
  host: "0.0.0.0",
  port: 3000,
  jwtSecret: "forge-dev-jwt-secret-please-rotate",
  tenantKey: "forge-dev-tenant-key-please-rotate",
  corsOrigin: true,
  rateLimitMax: 600,
  rateLimitWindow: "1 minute",
  logLevel: "info",
};

const INSECURE_VALUES = new Set([
  "",
  "change-me",
  "changeme",
  "change-me-in-production",
  "change-me-with-openssl-rand-hex-32",
  DEFAULTS.jwtSecret,
  DEFAULTS.tenantKey,
]);

function boolEnv(value) {
  return /^(1|true|yes|on)$/i.test(String(value || ""));
}

function parseCorsOrigin(raw) {
  if (!raw) return true;
  const list = String(raw).split(",").map(s => s.trim()).filter(Boolean);
  return list.length ? list : true;
}

/**
 * Returns true when the resolved CORS configuration reflects any
 * origin (the legacy default). Production strict mode rejects this
 * outright; development is allowed to keep the permissive default but
 * we emit a warning at boot so operators notice.
 */
export function isReflectAnyCorsOrigin(value) {
  return value === true;
}

function readNumber(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function assertSecret({ name, value, minLength, errors }) {
  const normalized = String(value || "").trim();
  if (normalized.length < minLength) {
    errors.push(`${name} must be at least ${minLength} characters`);
  }
  if (INSECURE_VALUES.has(normalized)) {
    errors.push(`${name} must be set to a non-default production value`);
  }
}

export function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || "development";
  const strict = nodeEnv === "production" || boolEnv(env.FORGE_STRICT_CONFIG);
  const config = {
    nodeEnv,
    strict,
    host: env.HOST || DEFAULTS.host,
    port: readNumber(env.PORT, DEFAULTS.port),
    jwtSecret: env.FORGE_JWT_SECRET || DEFAULTS.jwtSecret,
    tenantKey: env.FORGE_TENANT_KEY || DEFAULTS.tenantKey,
    tenantKeyId: env.FORGE_TENANT_KEY_ID || "key:forge:v1",
    corsOrigin: parseCorsOrigin(env.FORGE_CORS_ORIGIN),
    rateLimit: {
      max: readNumber(env.FORGE_RATELIMIT_MAX, DEFAULTS.rateLimitMax),
      timeWindow: env.FORGE_RATELIMIT_WINDOW || DEFAULTS.rateLimitWindow,
    },
    logLevel: env.LOG_LEVEL || DEFAULTS.logLevel,
    serveSourceClient: boolEnv(env.FORGE_SERVE_SOURCE),
    otelEnabled: boolEnv(env.FORGE_OTEL_ENABLED),
    otelEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT || null,
  };

  if (strict) {
    const errors = [];
    assertSecret({ name: "FORGE_JWT_SECRET", value: config.jwtSecret, minLength: 32, errors });
    assertSecret({ name: "FORGE_TENANT_KEY", value: config.tenantKey, minLength: 32, errors });
    if (config.corsOrigin === true) {
      errors.push("FORGE_CORS_ORIGIN must be explicit in production/strict mode");
    }
    if (errors.length) {
      const err = new Error(`Unsafe FORGE configuration:\n- ${errors.join("\n- ")}`);
      err.code = "ERR_FORGE_UNSAFE_CONFIG";
      err.errors = errors;
      throw err;
    }
  }

  return config;
}

export const config = loadConfig();
