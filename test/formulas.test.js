// Formula engine — tokeniser + parser + evaluator + every BUILTIN.
//
// The engine powers operator-authored computed fields on work items
// (and, going forward, docs / assets / projects). It needs to be:
//
//   * Safe — no eval, no global scope leakage, every error caught
//   * Predictable — `{ ok, value, error }` envelope on every call
//   * Documented — BUILTINS carry their own description + examples
//
// This file pins the contract so a future contributor renaming or
// re-typing a function fails the build immediately.

import test from "node:test";
import assert from "node:assert/strict";

const { evaluate, BUILTINS, referencedIdentifiers, unknownFunctions, _internals } = await import("../src/core/formulas.js");
const { parse, tokenise } = _internals;

// ────────────────────────────────────────────────────────────────────
// Tokeniser
// ────────────────────────────────────────────────────────────────────

test("tokenise: numbers, strings, identifiers, operators", () => {
  const t = tokenise(`add(1.5, "hi", x) + 2 * y`);
  // Pull just the values for compact assertion.
  assert.deepEqual(
    t.map(x => x.value),
    ["add", "(", 1.5, ",", "hi", ",", "x", ")", "+", 2, "*", "y", null],
  );
});

test("tokenise: two-char operators are recognised before single-char", () => {
  const t = tokenise("a == b && c <= d ?? e");
  const ops = t.filter(x => x.type === "op").map(x => x.value);
  assert.deepEqual(ops, ["==", "&&", "<=", "??"]);
});

test("tokenise: throws on unterminated string", () => {
  assert.throws(() => tokenise('"unterminated'));
});

test("tokenise: throws on unexpected character", () => {
  assert.throws(() => tokenise("a # b"));
});

// ────────────────────────────────────────────────────────────────────
// Parser
// ────────────────────────────────────────────────────────────────────

test("parse: respects precedence (* over +)", () => {
  const ast = parse("1 + 2 * 3");
  // Should be (1 + (2 * 3)), not ((1 + 2) * 3).
  assert.equal(ast.type, "binary");
  assert.equal(ast.op, "+");
  assert.equal(ast.right.type, "binary");
  assert.equal(ast.right.op, "*");
});

test("parse: parens override precedence", () => {
  const ast = parse("(1 + 2) * 3");
  assert.equal(ast.type, "binary");
  assert.equal(ast.op, "*");
  assert.equal(ast.left.op, "+");
});

test("parse: function call with multiple args", () => {
  const ast = parse('add(1, 2, x, "hi")');
  assert.equal(ast.type, "call");
  assert.equal(ast.name, "add");
  assert.equal(ast.args.length, 4);
});

test("parse: trailing tokens trip a clear error", () => {
  assert.throws(() => parse("1 + 2 garbage"));
});

// ────────────────────────────────────────────────────────────────────
// evaluate — { ok, value, error } envelope
// ────────────────────────────────────────────────────────────────────

test("evaluate: empty / blank input returns a useful error, not a throw", () => {
  assert.equal(evaluate("").ok, false);
  assert.equal(evaluate("   ").ok, false);
  assert.equal(evaluate(null).ok, false);
});

test("evaluate: identifiers resolve against scope; missing keys are null", () => {
  assert.deepEqual(evaluate("x", { x: 42 }), { ok: true, value: 42, error: null });
  assert.deepEqual(evaluate("missing", {}), { ok: true, value: null, error: null });
});

test("evaluate: arithmetic + string concat (mirrors JS where one side is a string)", () => {
  assert.equal(evaluate("1 + 2 * 3").value, 7);
  assert.equal(evaluate('"a" + "b"').value, "ab");
  assert.equal(evaluate('"x: " + 5').value, "x: 5");
});

test("evaluate: division by zero returns null, not Infinity", () => {
  // We chose null because Infinity propagates through downstream
  // formulas as "Infinity" strings + breaks badge variants. Null
  // surfaces as a clear "—" in the UI.
  assert.equal(evaluate("10 / 0").value, null);
  assert.equal(evaluate("10 % 0").value, null);
});

test("evaluate: comparison + logical operators", () => {
  assert.equal(evaluate("1 < 2").value, true);
  assert.equal(evaluate("1 == 1").value, true);
  assert.equal(evaluate("1 != 2").value, true);
  assert.equal(evaluate("true && false").value, false);
  assert.equal(evaluate('null ?? "fallback"').value, "fallback");
  assert.equal(evaluate('"set" ?? "fallback"').value, "set");
});

test("evaluate: an unknown function returns a structured error", () => {
  const r = evaluate("nope(1)");
  assert.equal(r.ok, false);
  assert.match(r.error, /Unknown function "nope"/);
});

// ────────────────────────────────────────────────────────────────────
// Built-in functions — one happy-path test per category
// ────────────────────────────────────────────────────────────────────

test("BUILTINS: every entry has signature, description, fn, category", () => {
  for (const [name, def] of Object.entries(BUILTINS)) {
    assert.equal(typeof def.signature, "string", `${name}.signature`);
    assert.equal(typeof def.description, "string", `${name}.description`);
    assert.equal(typeof def.fn, "function", `${name}.fn`);
    assert.equal(typeof def.category, "string", `${name}.category`);
  }
});

test("Date functions: daysUntilDue / daysSince / isOverdue / today / formatDate", () => {
  const future = new Date(Date.now() + 5 * 86400_000).toISOString();
  const past = new Date(Date.now() - 5 * 86400_000).toISOString();
  // ±1 tolerance because Math.ceil/floor on ms-rounding boundaries.
  const days = evaluate("daysUntilDue(d)", { d: future }).value;
  assert.ok(Math.abs(days - 5) <= 1, `expected ~5, got ${days}`);
  assert.equal(evaluate("isOverdue(p)", { p: past }).value, true);
  assert.equal(evaluate("isOverdue(f)", { f: future }).value, false);
  // formatDate of an obviously-bad value returns "" instead of "Invalid Date".
  assert.equal(evaluate('formatDate("not a date")').value, "");
  // today() returns an ISO string at midnight UTC.
  const today = evaluate("today()").value;
  assert.match(today, /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
});

test("Number functions: add / sub / mul / div / round / min / max", () => {
  assert.equal(evaluate("add(1, 2, 3)").value, 6);
  assert.equal(evaluate("sub(10, 3)").value, 7);
  assert.equal(evaluate("mul(2, 3, 4)").value, 24);
  assert.equal(evaluate("div(10, 4)").value, 2.5);
  assert.equal(evaluate("round(3.146, 2)").value, 3.15);
  assert.equal(evaluate("min(7, 2, 9)").value, 2);
  assert.equal(evaluate("max(7, 2, 9)").value, 9);
});

test("String functions: concat / upper / lower / len / contains", () => {
  assert.equal(evaluate('concat("a", "b", "c")').value, "abc");
  assert.equal(evaluate('upper("forge")').value, "FORGE");
  assert.equal(evaluate('lower("FORGE")').value, "forge");
  assert.equal(evaluate('len("hello")').value, 5);
  assert.equal(evaluate('contains("hello world", "world")').value, true);
  assert.equal(evaluate('contains("hello world", "x")').value, false);
});

test("Logic functions: ifThen / coalesce / isEmpty", () => {
  assert.equal(evaluate('ifThen(true, "yes", "no")').value, "yes");
  assert.equal(evaluate('ifThen(false, "yes", "no")').value, "no");
  assert.equal(evaluate('coalesce(null, "", "fallback")').value, "fallback");
  assert.equal(evaluate('isEmpty("")').value, true);
  assert.equal(evaluate('isEmpty(null)').value, true);
  assert.equal(evaluate('isEmpty("x")').value, false);
});

test("Composing functions: ifThen(isOverdue(due), 'OVERDUE', 'on track')", () => {
  const past = new Date(Date.now() - 86400_000).toISOString();
  const future = new Date(Date.now() + 86400_000).toISOString();
  assert.equal(
    evaluate('ifThen(isOverdue(d), "OVERDUE", "on track")', { d: past }).value,
    "OVERDUE",
  );
  assert.equal(
    evaluate('ifThen(isOverdue(d), "OVERDUE", "on track")', { d: future }).value,
    "on track",
  );
});

// ────────────────────────────────────────────────────────────────────
// Static-analysis helpers (used by the formula builder UI)
// ────────────────────────────────────────────────────────────────────

test("referencedIdentifiers collects every ident the expression touches", () => {
  const refs = referencedIdentifiers("add(x, mul(y, z)) + a");
  assert.deepEqual([...refs].sort(), ["a", "x", "y", "z"]);
});

test("unknownFunctions returns an empty list when every call hits BUILTINS", () => {
  assert.deepEqual(unknownFunctions("daysUntilDue(due) + add(1, 2)"), []);
});

test("unknownFunctions surfaces typos so the formula builder can warn", () => {
  // `daysUntilDuee` is a typo. The static check should flag it
  // BEFORE the operator runs the formula and gets a runtime error.
  const unknown = unknownFunctions("daysUntilDuee(due)");
  assert.deepEqual(unknown, ["daysUntilDuee"]);
});

test("custom functions in scope.__functions take precedence over built-ins", () => {
  // Lets a workspace ship its own function library without forking
  // the engine. Our test: override `add` to subtract instead.
  const r = evaluate("add(5, 2)", { __functions: { add: (a, b) => a - b } });
  assert.equal(r.ok, true);
  assert.equal(r.value, 3);
});
