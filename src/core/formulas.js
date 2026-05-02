// Formula engine for FORGE — computed fields on work items, docs,
// and (future) assets / projects. The user-facing model mirrors
// Asana's formula fields: an operator types `daysUntilDue(due)` and
// the cell renders the resolved number, recomputing every render.
//
// Design notes:
//
//   * Pure module — no DOM, no store. The `evaluate(expr, scope)`
//     entry point takes an expression string and a scope object,
//     returns `{ ok, value, error }`. Callers (workBoard drawer,
//     table cell, formulas reference page) wire it into their
//     render path however they want.
//
//   * Pratt-style recursive-descent parser. Handles literals
//     (numbers, strings, true/false/null), identifiers (resolve
//     against scope), function calls, infix operators
//     (+ - * / % == != < <= > >= && || ??), unary - and !, and
//     parenthesized sub-expressions. AST is a tiny `{ type, ... }`
//     tagged-union; evaluator walks it with a switch.
//
//   * Function library lives in `BUILTINS` below. Each entry has
//     `signature`, `description`, `examples` so the
//     `/formulas` reference page can render docs without a
//     separate doc file. Adding a new function = one entry here +
//     a regression test.
//
//   * Errors never throw. The evaluator catches every failure and
//     returns `{ ok: false, error }`; the UI renders the error
//     inline so users can fix their expression without crashing
//     the screen.

// ────────────────────────────────────────────────────────────────────
// Tokeniser
// ────────────────────────────────────────────────────────────────────

const TOKEN_TYPES = {
  NUMBER: "number",
  STRING: "string",
  IDENT: "ident",
  PUNCT: "punct",
  OP: "op",
  EOF: "eof",
};

function tokenise(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];

    // Whitespace.
    if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }

    // Number literal — int or decimal. We don't support exponents
    // (engineering use cases generally don't need them inside a
    // formula cell, and supporting them complicates the lexer).
    if (c >= "0" && c <= "9") {
      let j = i;
      while (j < src.length && (src[j] >= "0" && src[j] <= "9")) j++;
      if (src[j] === ".") {
        j++;
        while (j < src.length && (src[j] >= "0" && src[j] <= "9")) j++;
      }
      tokens.push({ type: TOKEN_TYPES.NUMBER, value: Number(src.slice(i, j)), pos: i });
      i = j;
      continue;
    }

    // String literal — double-quoted or single-quoted, no escapes
    // beyond \\ and \" / \'. Operators don't usually need escaped
    // strings; we can broaden if a user case appears.
    if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      let value = "";
      while (j < src.length && src[j] !== quote) {
        if (src[j] === "\\" && j + 1 < src.length) {
          const next = src[j + 1];
          value += next === "n" ? "\n" : next;
          j += 2;
          continue;
        }
        value += src[j];
        j++;
      }
      if (j >= src.length) throw new ParseError(`Unterminated string starting at column ${i + 1}`);
      tokens.push({ type: TOKEN_TYPES.STRING, value, pos: i });
      i = j + 1;
      continue;
    }

    // Identifier or keyword.
    if ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_") {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      const ident = src.slice(i, j);
      tokens.push({ type: TOKEN_TYPES.IDENT, value: ident, pos: i });
      i = j;
      continue;
    }

    // Two-char operators — must check before single-char.
    const two = src.slice(i, i + 2);
    if (["==", "!=", "<=", ">=", "&&", "||", "??"].includes(two)) {
      tokens.push({ type: TOKEN_TYPES.OP, value: two, pos: i });
      i += 2;
      continue;
    }

    // Single-char operators + punctuation.
    if ("+-*/%<>!".includes(c)) {
      tokens.push({ type: TOKEN_TYPES.OP, value: c, pos: i });
      i++;
      continue;
    }
    if ("(),".includes(c)) {
      tokens.push({ type: TOKEN_TYPES.PUNCT, value: c, pos: i });
      i++;
      continue;
    }

    throw new ParseError(`Unexpected character "${c}" at column ${i + 1}`);
  }
  tokens.push({ type: TOKEN_TYPES.EOF, value: null, pos: src.length });
  return tokens;
}

class ParseError extends Error {}

// ────────────────────────────────────────────────────────────────────
// Parser — Pratt with explicit precedence levels
// ────────────────────────────────────────────────────────────────────

const PRECEDENCE = {
  "||": 1, "??": 1,
  "&&": 2,
  "==": 3, "!=": 3,
  "<": 4, "<=": 4, ">": 4, ">=": 4,
  "+": 5, "-": 5,
  "*": 6, "/": 6, "%": 6,
};

function parse(src) {
  const tokens = tokenise(src);
  let pos = 0;

  const peek = () => tokens[pos];
  const consume = () => tokens[pos++];
  const expect = (type, value) => {
    const t = peek();
    if (t.type !== type || (value != null && t.value !== value)) {
      throw new ParseError(`Expected ${value ?? type} but got ${t.value ?? t.type}`);
    }
    return consume();
  };

  function parseExpression(minPrec = 0) {
    let left = parseUnary();
    while (true) {
      const t = peek();
      if (t.type !== TOKEN_TYPES.OP) break;
      const prec = PRECEDENCE[t.value];
      if (prec == null || prec < minPrec) break;
      consume();
      const right = parseExpression(prec + 1);
      left = { type: "binary", op: t.value, left, right };
    }
    return left;
  }

  function parseUnary() {
    const t = peek();
    if (t.type === TOKEN_TYPES.OP && (t.value === "-" || t.value === "!")) {
      consume();
      return { type: "unary", op: t.value, expr: parseUnary() };
    }
    return parsePrimary();
  }

  function parsePrimary() {
    const t = peek();
    if (t.type === TOKEN_TYPES.NUMBER) {
      consume();
      return { type: "literal", value: t.value };
    }
    if (t.type === TOKEN_TYPES.STRING) {
      consume();
      return { type: "literal", value: t.value };
    }
    if (t.type === TOKEN_TYPES.IDENT) {
      consume();
      const ident = t.value;
      if (ident === "true") return { type: "literal", value: true };
      if (ident === "false") return { type: "literal", value: false };
      if (ident === "null") return { type: "literal", value: null };
      // Function call?
      if (peek().value === "(") {
        consume();
        const args = [];
        if (peek().value !== ")") {
          args.push(parseExpression());
          while (peek().value === ",") {
            consume();
            args.push(parseExpression());
          }
        }
        expect(TOKEN_TYPES.PUNCT, ")");
        return { type: "call", name: ident, args };
      }
      return { type: "ident", name: ident };
    }
    if (t.value === "(") {
      consume();
      const inner = parseExpression();
      expect(TOKEN_TYPES.PUNCT, ")");
      return inner;
    }
    throw new ParseError(`Unexpected token "${t.value ?? t.type}" at column ${t.pos + 1}`);
  }

  const ast = parseExpression();
  if (peek().type !== TOKEN_TYPES.EOF) {
    throw new ParseError(`Unexpected trailing tokens starting at column ${peek().pos + 1}`);
  }
  return ast;
}

// ────────────────────────────────────────────────────────────────────
// Built-in function library
// ────────────────────────────────────────────────────────────────────
//
// Each entry: { fn, signature, description, examples, category }.
// The `/formulas` reference page renders these directly.

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function toDate(v) {
  if (v == null) return null;
  if (v instanceof Date) return v;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toNumber(v) {
  if (v == null || v === "") return 0;
  if (typeof v === "number") return v;
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
}

export const BUILTINS = {
  // ─ Date / time ────────────────────────────────────────────
  daysUntilDue: {
    category: "Date",
    signature: "daysUntilDue(date)",
    description: "Whole days from today until the given date. Negative if the date is in the past.",
    examples: [
      ["daysUntilDue(due)", "if `due` is 5 days away, returns `5`"],
      ["daysUntilDue(\"2026-12-31\")", "days remaining in the year"],
    ],
    fn: (date) => {
      const d = toDate(date);
      if (!d) return null;
      return Math.ceil((d.getTime() - Date.now()) / MS_PER_DAY);
    },
  },
  daysSince: {
    category: "Date",
    signature: "daysSince(date)",
    description: "Whole days from the given date to today. Negative if the date is in the future.",
    examples: [["daysSince(created_at)", "age of the item in days"]],
    fn: (date) => {
      const d = toDate(date);
      if (!d) return null;
      return Math.floor((Date.now() - d.getTime()) / MS_PER_DAY);
    },
  },
  isOverdue: {
    category: "Date",
    signature: "isOverdue(date)",
    description: "True when the given date is in the past.",
    examples: [["isOverdue(due)", "true if the item's due date has passed"]],
    fn: (date) => {
      const d = toDate(date);
      if (!d) return false;
      return d.getTime() < Date.now();
    },
  },
  formatDate: {
    category: "Date",
    signature: "formatDate(date)",
    description: "Locale-formatted date string (no time component). Returns empty string if invalid.",
    examples: [["formatDate(due)", "e.g. \"5/4/2026\""]],
    fn: (date) => {
      const d = toDate(date);
      return d ? d.toLocaleDateString() : "";
    },
  },
  today: {
    category: "Date",
    signature: "today()",
    description: "Today's date at midnight UTC, as an ISO string.",
    examples: [["daysUntilDue(today())", "always 0 — useful as a sanity check"]],
    fn: () => {
      const d = new Date();
      d.setUTCHours(0, 0, 0, 0);
      return d.toISOString();
    },
  },

  // ─ Number ─────────────────────────────────────────────────
  add: {
    category: "Number",
    signature: "add(a, b, ...)",
    description: "Sum of any number of arguments. Non-numeric values count as 0.",
    examples: [["add(1, 2, 3)", "6"]],
    fn: (...xs) => xs.reduce((s, x) => s + toNumber(x), 0),
  },
  sub: {
    category: "Number",
    signature: "sub(a, b)",
    description: "a − b.",
    examples: [["sub(10, 3)", "7"]],
    fn: (a, b) => toNumber(a) - toNumber(b),
  },
  mul: {
    category: "Number",
    signature: "mul(a, b, ...)",
    description: "Product of any number of arguments.",
    examples: [["mul(2, 3, 4)", "24"]],
    fn: (...xs) => xs.reduce((s, x) => s * toNumber(x), 1),
  },
  div: {
    category: "Number",
    signature: "div(a, b)",
    description: "a / b. Returns null if b is 0.",
    examples: [["div(10, 4)", "2.5"]],
    fn: (a, b) => {
      const denom = toNumber(b);
      return denom === 0 ? null : toNumber(a) / denom;
    },
  },
  round: {
    category: "Number",
    signature: "round(n, places=0)",
    description: "Round to the nearest integer, or to `places` decimal places.",
    examples: [
      ["round(3.7)", "4"],
      ["round(3.146, 2)", "3.15"],
    ],
    fn: (n, places = 0) => {
      const m = Math.pow(10, toNumber(places));
      return Math.round(toNumber(n) * m) / m;
    },
  },
  min: {
    category: "Number",
    signature: "min(a, b, ...)",
    description: "Smallest argument.",
    examples: [["min(3, 7, 1, 4)", "1"]],
    fn: (...xs) => Math.min(...xs.map(toNumber)),
  },
  max: {
    category: "Number",
    signature: "max(a, b, ...)",
    description: "Largest argument.",
    examples: [["max(3, 7, 1, 4)", "7"]],
    fn: (...xs) => Math.max(...xs.map(toNumber)),
  },

  // ─ String ─────────────────────────────────────────────────
  concat: {
    category: "String",
    signature: "concat(a, b, ...)",
    description: "Join all arguments as strings.",
    examples: [["concat(\"Hello, \", name)", "e.g. \"Hello, Joanne\""]],
    fn: (...xs) => xs.map(x => x == null ? "" : String(x)).join(""),
  },
  upper: {
    category: "String",
    signature: "upper(s)",
    description: "Upper-case the string.",
    examples: [["upper(\"forge\")", "\"FORGE\""]],
    fn: (s) => s == null ? "" : String(s).toUpperCase(),
  },
  lower: {
    category: "String",
    signature: "lower(s)",
    description: "Lower-case the string.",
    examples: [["lower(\"FORGE\")", "\"forge\""]],
    fn: (s) => s == null ? "" : String(s).toLowerCase(),
  },
  len: {
    category: "String",
    signature: "len(s)",
    description: "Number of characters in the string.",
    examples: [["len(title)", "length of the title"]],
    fn: (s) => s == null ? 0 : String(s).length,
  },
  contains: {
    category: "String",
    signature: "contains(haystack, needle)",
    description: "True if `needle` appears anywhere inside `haystack` (case-sensitive).",
    examples: [["contains(title, \"valve\")", "true if title mentions valve"]],
    fn: (haystack, needle) => {
      if (haystack == null || needle == null) return false;
      return String(haystack).includes(String(needle));
    },
  },

  // ─ Logic ──────────────────────────────────────────────────
  ifThen: {
    category: "Logic",
    signature: "ifThen(cond, thenVal, elseVal)",
    description: "Return `thenVal` when `cond` is truthy, otherwise `elseVal`.",
    examples: [
      ["ifThen(isOverdue(due), \"OVERDUE\", \"on track\")", "label per row"],
      ["ifThen(severity == \"high\", 100, 50)", "weight by severity"],
    ],
    fn: (cond, thenVal, elseVal) => cond ? thenVal : elseVal,
  },
  coalesce: {
    category: "Logic",
    signature: "coalesce(a, b, ...)",
    description: "First argument that isn't null / undefined / empty string.",
    examples: [["coalesce(assignee, \"Unassigned\")", "fallback label"]],
    fn: (...xs) => {
      for (const x of xs) if (x != null && x !== "") return x;
      return null;
    },
  },
  isEmpty: {
    category: "Logic",
    signature: "isEmpty(value)",
    description: "True if the value is null, undefined, or an empty string.",
    examples: [["isEmpty(assignee)", "true if no assignee"]],
    fn: (v) => v == null || v === "",
  },
};

// ────────────────────────────────────────────────────────────────────
// Evaluator
// ────────────────────────────────────────────────────────────────────

function evalNode(node, scope) {
  switch (node.type) {
    case "literal": return node.value;
    case "ident": {
      // Identifiers resolve against the scope object. Missing keys
      // are null — undefined would cascade through downstream
      // calculations as NaN, which is harder to debug.
      return Object.prototype.hasOwnProperty.call(scope, node.name) ? scope[node.name] : null;
    }
    case "unary": {
      const inner = evalNode(node.expr, scope);
      if (node.op === "-") return -toNumber(inner);
      if (node.op === "!") return !inner;
      throw new Error(`Unknown unary op ${node.op}`);
    }
    case "binary": {
      const a = evalNode(node.left, scope);
      const b = evalNode(node.right, scope);
      switch (node.op) {
        case "+":
          // String concat when either side is a string; otherwise
          // numeric addition. Mirrors JS but uses our toNumber()
          // semantics for non-numeric coercion.
          if (typeof a === "string" || typeof b === "string") return String(a ?? "") + String(b ?? "");
          return toNumber(a) + toNumber(b);
        case "-": return toNumber(a) - toNumber(b);
        case "*": return toNumber(a) * toNumber(b);
        case "/": {
          const denom = toNumber(b);
          return denom === 0 ? null : toNumber(a) / denom;
        }
        case "%": {
          const denom = toNumber(b);
          return denom === 0 ? null : toNumber(a) % denom;
        }
        case "==": return a === b;
        case "!=": return a !== b;
        case "<":  return toNumber(a) < toNumber(b);
        case "<=": return toNumber(a) <= toNumber(b);
        case ">":  return toNumber(a) > toNumber(b);
        case ">=": return toNumber(a) >= toNumber(b);
        case "&&": return a && b;
        case "||": return a || b;
        case "??": return a == null ? b : a;
        default: throw new Error(`Unknown binary op ${node.op}`);
      }
    }
    case "call": {
      const fn = (scope.__functions && scope.__functions[node.name]) || (BUILTINS[node.name] && BUILTINS[node.name].fn);
      if (!fn) throw new Error(`Unknown function "${node.name}"`);
      const args = node.args.map(a => evalNode(a, scope));
      return fn(...args);
    }
    default: throw new Error(`Unknown AST node ${node.type}`);
  }
}

/**
 * Evaluate an expression against a scope. Returns `{ ok, value, error }`.
 *
 * @param {string} expr        the formula source text.
 * @param {object} [scope]     identifiers + custom functions. Custom
 *                              functions can be passed via
 *                              `scope.__functions = { name: fn }`.
 */
export function evaluate(expr, scope = {}) {
  if (typeof expr !== "string" || expr.trim() === "") {
    return { ok: false, value: null, error: "Empty formula" };
  }
  let ast;
  try {
    ast = parse(expr);
  } catch (e) {
    return { ok: false, value: null, error: e.message };
  }
  try {
    const value = evalNode(ast, scope);
    return { ok: true, value, error: null };
  } catch (e) {
    return { ok: false, value: null, error: e.message };
  }
}

/**
 * Walk an AST and collect every identifier referenced. Useful for
 * the formula builder's "Available fields" picker — it shows
 * identifiers that are likely to fail at evaluation time.
 */
export function referencedIdentifiers(expr) {
  let ast;
  try { ast = parse(expr); } catch { return []; }
  const out = new Set();
  function walk(n) {
    if (!n) return;
    if (n.type === "ident") out.add(n.name);
    if (n.type === "unary") walk(n.expr);
    if (n.type === "binary") { walk(n.left); walk(n.right); }
    if (n.type === "call") n.args.forEach(walk);
  }
  walk(ast);
  return [...out];
}

/** True if the expression names a function that isn't in BUILTINS or scope.__functions. */
export function unknownFunctions(expr, customFns = {}) {
  let ast;
  try { ast = parse(expr); } catch { return []; }
  const out = new Set();
  function walk(n) {
    if (!n) return;
    if (n.type === "call") {
      if (!BUILTINS[n.name] && !customFns[n.name]) out.add(n.name);
      n.args.forEach(walk);
    }
    if (n.type === "unary") walk(n.expr);
    if (n.type === "binary") { walk(n.left); walk(n.right); }
  }
  walk(ast);
  return [...out];
}

// Test seam — the parse function isn't exported by name to avoid
// leaking AST shape into screen code, but tests need it.
export const _internals = { parse, tokenise };
