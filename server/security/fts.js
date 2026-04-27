// SQLite FTS5 query sanitisation.
//
// Earlier callers built FTS5 MATCH expressions by string-concatenating
// the user input inside double quotes:
//
//   const esc = q.replace(/"/g, '""');
//   db.prepare("SELECT … MATCH ?").all(`\"${esc}\"*`);
//
// That escapes the `\"` quote inside the phrase but lets through the
// rest of the FTS5 operator surface (AND, OR, NOT, NEAR, column
// filters like `title:foo`, control characters, NUL bytes, etc.).
// FTS5 errors on bad operators, but a determined attacker can still
// abuse the operator surface to bypass intended search semantics or
// trip ReDoS-style behaviour on malformed input.
//
// `sanitizeFtsTerm()` returns a fully-quoted FTS5 phrase that is safe
// to interpolate. It strips control characters + NUL, doubles inner
// quotes, caps length, and trims FTS5 operators down to literal text
// by surrounding the whole thing in `"…"*` (prefix-match phrase).
//
// Callers should treat the returned string as a complete MATCH
// expression and pass it as the bound parameter — no further wrapping.

const FTS_MAX_LEN = 256;
// 0x00–0x08, 0x0b–0x0c, 0x0e–0x1f are non-printable control bytes.
// 0x09 (\t), 0x0a (\n), 0x0d (\r) we also drop because FTS5 tokenisers
// treat them as word boundaries; including them in a phrase produces
// non-deterministic results across builds.
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;

/**
 * Sanitise a user-supplied search term and produce a FTS5 phrase.
 * Returns `null` when the input has no usable content.
 */
export function sanitizeFtsTerm(input) {
  if (input == null) return null;
  let s = String(input);
  s = s.replace(CONTROL_CHARS, " ");
  s = s.trim();
  if (!s) return null;
  if (s.length > FTS_MAX_LEN) s = s.slice(0, FTS_MAX_LEN);
  // Double every existing `"` so the resulting phrase remains a valid
  // FTS5 string literal.
  s = s.replace(/"/g, '""');
  // Surround in a quoted prefix phrase so FTS5 treats the whole input
  // as literal text — operators (AND/OR/NOT/NEAR), column filters,
  // and special chars inside lose their syntactic meaning.
  return `"${s}"*`;
}
