// sanitizeFtsTerm() defangs FTS5 operator injection and control-char
// pass-through.

import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeFtsTerm } from "../server/security/fts.js";

test("returns null on empty / null input", () => {
  assert.equal(sanitizeFtsTerm(null), null);
  assert.equal(sanitizeFtsTerm(undefined), null);
  assert.equal(sanitizeFtsTerm(""), null);
  assert.equal(sanitizeFtsTerm("   "), null);
});

test("wraps a plain term in a quoted prefix phrase", () => {
  const out = sanitizeFtsTerm("valve");
  assert.equal(out, '"valve"*');
});

test("doubles inner quotes so the phrase stays a valid FTS5 literal", () => {
  const out = sanitizeFtsTerm('he said "hi"');
  assert.equal(out, '"he said ""hi"""*');
});

test("strips control characters", () => {
  const out = sanitizeFtsTerm("foo\x00\x01bar\x1f");
  // Control chars become spaces; surrounding whitespace is then trimmed.
  assert.equal(out, '"foo  bar"*');
});

test("operator injection is neutralised by the surrounding quotes", () => {
  // FTS5 syntax operators (AND, OR, NEAR, column:term) lose their
  // syntactic meaning when wrapped in a quoted phrase.
  const out = sanitizeFtsTerm("title:secret OR docid:9999");
  assert.equal(out, '"title:secret OR docid:9999"*');
});

test("caps long input at 256 chars", () => {
  const long = "a".repeat(500);
  const out = sanitizeFtsTerm(long);
  // Prefix `"` + 256 a's + suffix `"*` → length 259.
  assert.equal(out.length, 259);
  assert.ok(out.startsWith('"') && out.endsWith('"*'));
});
