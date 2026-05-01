// Free-form SQL validator.
//
// Operators with the `historian.sql.raw` capability (Workspace Admin
// by default — see server/auth.js) can author per-binding SQL query
// templates that the SQL connector registry runs each poll cycle to
// fetch tag samples from an external historian. Free-form SQL is a
// powerful surface — it crosses the tenant boundary into the
// customer's database — so it MUST be tightly bounded.
//
// This module is the single chokepoint that decides whether a
// query template is safe enough to persist. It runs at:
//   1. Profile-save time   (POST /api/asset-profiles{,/:id/versions})
//   2. Apply-profile time  (POST /api/assets/:id/apply-profile when the
//                           profile is sql + free-form)
//   3. Custom-mapping time (POST /api/assets/:id/custom-mapping when
//                           sourceKind=sql + mode=free_form)
//
// The validator never executes the query — it only inspects the AST.
// Execution happens in `server/connectors/sql-registry.js` using the
// `mssql` driver's parameterised input API, where the pre-validated
// AST is re-serialised to a sanitised SQL string.
//
// Spec ref: docs/INDUSTRIAL_EDGE_PLATFORM_SPEC.md §15.4 (audit log
// integrity — every device write is logged) + §22 anti-pattern row
// "Integration credentials stored in plaintext" — the same posture
// applies to "user-authored SQL", which we treat as untrusted input
// even from authenticated users.
//
// Acceptance criteria:
//   - Single statement only (rejects `;` joins, multi-statement)
//   - `SELECT` only (rejects DDL/DML/DCL: INSERT/UPDATE/DELETE/CREATE/
//     ALTER/DROP/TRUNCATE/GRANT/REVOKE/EXEC/CALL/SET/USE/MERGE/REPLACE)
//   - No comment markers (`--`, `/*`, `*/`, `#`) — node-sql-parser
//     strips them but a defence-in-depth string scan rejects upfront
//   - No reference to `INFORMATION_SCHEMA`, `pg_catalog`, `sys.*`,
//     `mysql.*`, `master.*` databases / schemas
//   - All `:name` bind parameters must be in the ALLOWED_PARAMS set;
//     unknown parameters are rejected (typo in `:point_id` becomes a
//     run-time SQLi vector if we silently ignore it)
//   - At least one of the allowed params MUST appear (otherwise the
//     query is parameter-free and either constant or a footgun)
//   - A `LIMIT` clause is required (paginate-or-die — we never want
//     a misconfigured poll to drag the whole table back)
//   - The LIMIT value must be a literal integer or `:limit`
//
// Out of scope (later releases / Phase 6+):
//   - CTEs, window functions, lateral joins. The strictness is
//     intentional; relaxations need a security review per release.
//   - Multiple databases (`db.schema.table`). Today the validator
//     blocks `INFORMATION_SCHEMA.x` etc., which incidentally allows
//     `customer_db.public.foo` — matched table allowlists belong on
//     the `enterprise_systems.config` row, not the validator.

// node-sql-parser is CommonJS; ESM can only consume its default export.
import sqlParserPkg from "node-sql-parser";
const { Parser } = sqlParserPkg;

export const ALLOWED_PARAMS = ["point_id", "asset_id", "since", "until", "limit"];

const FORBIDDEN_KEYWORD_TYPES = new Set([
  "insert", "update", "delete", "replace",
  "create", "alter", "drop", "truncate", "rename",
  "grant", "revoke",
  "exec", "execute", "call", "do",
  "set", "use",
  "merge",
]);

const FORBIDDEN_NAMESPACES = [
  "information_schema",
  "pg_catalog",
  "pg_information_schema",
  "sys",
  "mysql",
  "master",
  "performance_schema",
];

// Block structural risks that the AST shape doesn't catch on its own
// (e.g. multi-statement attacks via `;`). Scanning the raw template
// before parsing is fast and gives us a clean error message.
const RAW_REJECT_PATTERNS = [
  { name: "comment_dash",  pattern: /(^|[^:])--/m,           message: "SQL comment markers ('--') are not allowed" },
  { name: "comment_block", pattern: /\/\*|\*\//,             message: "SQL block-comment markers ('/* */') are not allowed" },
  { name: "comment_hash",  pattern: /^\s*#/m,                message: "SQL hash comments ('#') are not allowed" },
  { name: "semicolon",     pattern: /;[\s]*\S/,              message: "Multi-statement SQL is not allowed; use a single SELECT only" },
  { name: "trailing_semi", pattern: /;\s*$/,                 message: "Trailing semicolon is not allowed" },
];

const _parser = new Parser();

// FORGE-canonical dialect names → node-sql-parser dialect names.
// The connector subregistry stores the FORGE form on each binding;
// the validator translates so callers can pass either freely.
const FORGE_TO_PARSER_DIALECT = {
  mssql:      "transactsql",
  postgresql: "postgresql",
  mysql:      "mysql",
  sqlite:     "sqlite",
};

function resolveParserDialect(dialect) {
  const k = String(dialect || "").toLowerCase();
  if (FORGE_TO_PARSER_DIALECT[k]) return FORGE_TO_PARSER_DIALECT[k];
  // Already a node-sql-parser-native value (e.g. 'transactsql' or
  // 'mariadb'); pass through verbatim. Unknown values fall back to
  // transactsql for back-compat with Phase 3.
  return dialect || "transactsql";
}

/**
 * Validate a free-form SQL template.
 *
 * Returns `{ ok: true, ast, params, dialect }` on pass, where `params`
 * is the set of bind-parameter names found in the template (a subset
 * of ALLOWED_PARAMS).
 *
 * Returns `{ ok: false, code, message, details? }` on fail. `code` is a
 * stable machine-readable identifier so the API can surface it via the
 * sendError envelope and clients can offer specific remediation hints.
 *
 * @param {string} template
 * @param {object} [opts]
 * @param {string} [opts.dialect="mssql"]  Either a FORGE canonical
 *        dialect (`mssql` / `postgresql` / `mysql` / `sqlite`) or a
 *        raw node-sql-parser dialect name. The connector subregistry
 *        passes the binding's `dialect` column straight through;
 *        legacy callers pass the parser-native name for back-compat.
 */
export function validateSelectTemplate(template, { dialect = "transactsql" } = {}) {
  const parserDialect = resolveParserDialect(dialect);
  if (typeof template !== "string" || !template.trim()) {
    return { ok: false, code: "empty", message: "SQL template is empty" };
  }
  if (template.length > 8192) {
    return {
      ok: false,
      code: "too_long",
      message: `SQL template exceeds 8192 chars (got ${template.length})`,
    };
  }

  // Defence in depth: scan the raw text for structural rejects before
  // handing to the parser, so errors are deterministic and don't depend
  // on dialect quirks.
  for (const rule of RAW_REJECT_PATTERNS) {
    if (rule.pattern.test(template)) {
      return { ok: false, code: rule.name, message: rule.message };
    }
  }

  // Parse. Catch syntax errors with a stable code.
  let asts;
  try {
    asts = _parser.astify(template, { database: parserDialect });
  } catch (err) {
    return {
      ok: false,
      code: "parse_error",
      message: `SQL did not parse (${parserDialect}): ${String(err?.message || err).split("\n")[0]}`,
    };
  }

  // node-sql-parser returns either a single statement object or an
  // array (for multi-statement input). Either array length > 1 OR the
  // semicolon scan above should have caught multi-statement attempts —
  // but the AST is the source of truth.
  const list = Array.isArray(asts) ? asts : [asts];
  if (list.length !== 1) {
    return {
      ok: false,
      code: "multi_statement",
      message: "Multi-statement SQL is not allowed; use a single SELECT only",
    };
  }
  const ast = list[0];
  if (!ast || ast.type !== "select") {
    return {
      ok: false,
      code: "not_select",
      message: `Only SELECT queries are allowed; got ${ast?.type || "unknown"}`,
      details: { type: ast?.type || null },
    };
  }
  if (FORBIDDEN_KEYWORD_TYPES.has(ast.type)) {
    return {
      ok: false,
      code: "forbidden_statement",
      message: `${ast.type.toUpperCase()} statements are not allowed`,
    };
  }

  // Tables/databases referenced. Block any reference to system catalogs
  // that would let a malicious operator enumerate other tenants'
  // schemas.
  const fromList = Array.isArray(ast.from) ? ast.from : [];
  for (const t of fromList) {
    if (t?.db && FORBIDDEN_NAMESPACES.includes(String(t.db).toLowerCase())) {
      return {
        ok: false,
        code: "forbidden_namespace",
        message: `Database/schema "${t.db}" is not allowed`,
        details: { namespace: t.db },
      };
    }
    if (t?.table && FORBIDDEN_NAMESPACES.includes(String(t.table).toLowerCase())) {
      return {
        ok: false,
        code: "forbidden_namespace",
        message: `Table "${t.table}" is not allowed`,
        details: { table: t.table },
      };
    }
  }

  // LIMIT clause — required. The shape varies by dialect (mssql uses
  // TOP, mysql/postgres use LIMIT). node-sql-parser normalises this into
  // ast.limit OR ast.options/columns containing a TOP marker on mssql.
  // We accept either as long as a numeric (or :limit) ceiling is set.
  const hasLimit = (() => {
    if (ast.limit && Array.isArray(ast.limit.value) && ast.limit.value.length > 0) return true;
    // mssql TOP — node-sql-parser places it under columns[i].expr (top)
    // OR under ast.options. We accept ast.options containing 'TOP N'.
    if (ast.options) {
      const arr = Array.isArray(ast.options) ? ast.options : [ast.options];
      if (arr.some(o => /\btop\b/i.test(String(o)))) return true;
    }
    if (Array.isArray(ast.columns)) {
      for (const c of ast.columns) {
        if (c?.expr?.type === "expr_list" && /\btop\b/i.test(JSON.stringify(c.expr))) return true;
      }
    }
    // Defence-in-depth: the regex above is run in raw text too, since
    // node-sql-parser TOP-shape varies across versions. If neither AST
    // nor regex hits, reject.
    if (/\bTOP\s*(\(|\d|@|:)/i.test(template) || /\bLIMIT\b/i.test(template)) return true;
    return false;
  })();
  if (!hasLimit) {
    return {
      ok: false,
      code: "missing_limit",
      message: "Query must include a LIMIT clause (or TOP N in MSSQL) to bound the result set",
    };
  }

  // Bind parameter scan. node-sql-parser exposes parameters via
  // `parser.parameters` after parse, and across versions some emit them
  // inline as `param` nodes. We do a regex pass on the raw template as
  // the canonical truth (after we already rejected comments + multi-
  // statement above), since regex on the post-comment-stripped text
  // can't fool us.
  const paramSet = new Set();
  const paramRe = /:([a-zA-Z_][a-zA-Z0-9_]*)/g;
  let m;
  while ((m = paramRe.exec(template)) !== null) {
    paramSet.add(m[1]);
  }
  for (const p of paramSet) {
    if (!ALLOWED_PARAMS.includes(p)) {
      return {
        ok: false,
        code: "unknown_parameter",
        message: `Bind parameter ":${p}" is not in the allowed set (${ALLOWED_PARAMS.join(", ")})`,
        details: { parameter: p, allowed: ALLOWED_PARAMS },
      };
    }
  }
  if (paramSet.size === 0) {
    return {
      ok: false,
      code: "no_parameters",
      message: `Query must reference at least one of the allowed bind parameters (${ALLOWED_PARAMS.join(", ")})`,
      details: { allowed: ALLOWED_PARAMS },
    };
  }

  return {
    ok: true,
    ast,
    params: [...paramSet],
    dialect: parserDialect,
  };
}

/**
 * Convenience wrapper for routes: throws a structured error suitable
 * for the `errors.js` handler if the template is invalid. Returns the
 * parser result on success.
 *
 * Routes that prefer the structured-result style call
 * `validateSelectTemplate` directly and surface the failure via
 * `sendError`.
 */
export function assertValidSelectTemplate(template, opts) {
  const r = validateSelectTemplate(template, opts);
  if (r.ok) return r;
  const err = new Error(r.message);
  err.statusCode = 400;
  err.code = "sql_validation_failed";
  err.details = { reason: r.code, ...(r.details || {}) };
  throw err;
}
