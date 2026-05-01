// UX-A — theme resolution unit tests.
//
// `src/core/theme.js` decides which body class (`theme-dark` /
// `theme-light`) to paint on first load. The decision uses two
// signals: a saved-preference blob in localStorage and the OS-level
// `prefers-color-scheme: light` media query. Saved wins; OS is the
// fallback; our historical default ("dark") is the final fallback
// for environments with no signal at all.
//
// The module is browser-pure but every helper accepts dependency-
// injected `savedRaw` and `mql` so we can drive it from a Node test
// without a JSDOM. The applyInitialTheme() side-effecting helper is
// exercised against a tiny stub document + window.

import test from "node:test";
import assert from "node:assert/strict";

const theme = await import("../src/core/theme.js");

// ────────────────────────────────────────────────────────────────────
// readSavedTheme — strict on the JSON shape, never throws.
// ────────────────────────────────────────────────────────────────────

test("readSavedTheme returns null for missing / blank input", () => {
  assert.equal(theme.readSavedTheme(null), null);
  assert.equal(theme.readSavedTheme(undefined), null);
  assert.equal(theme.readSavedTheme(""), null);
});

test("readSavedTheme returns null when JSON is malformed", () => {
  assert.equal(theme.readSavedTheme("{not json"), null);
  assert.equal(theme.readSavedTheme("[]"), null);
  assert.equal(theme.readSavedTheme("123"), null);
});

test("readSavedTheme returns null when the saved theme isn't dark/light", () => {
  assert.equal(theme.readSavedTheme(JSON.stringify({ ui: { theme: "neon" } })), null);
  assert.equal(theme.readSavedTheme(JSON.stringify({ ui: { theme: "" } })), null);
  assert.equal(theme.readSavedTheme(JSON.stringify({ ui: {} })), null);
  assert.equal(theme.readSavedTheme(JSON.stringify({})), null);
});

test("readSavedTheme returns the saved preference verbatim when valid", () => {
  assert.equal(theme.readSavedTheme(JSON.stringify({ ui: { theme: "dark" } })), "dark");
  assert.equal(theme.readSavedTheme(JSON.stringify({ ui: { theme: "light" } })), "light");
});

// ────────────────────────────────────────────────────────────────────
// readOSPreference — `matchMedia` shape, never throws.
// ────────────────────────────────────────────────────────────────────

test("readOSPreference returns 'light' when the OS asks for light", () => {
  assert.equal(theme.readOSPreference({ matches: true }), "light");
});

test("readOSPreference returns 'dark' when matches is false / null / missing", () => {
  assert.equal(theme.readOSPreference({ matches: false }), "dark");
  assert.equal(theme.readOSPreference(null), "dark");
  assert.equal(theme.readOSPreference(undefined), "dark");
});

// ────────────────────────────────────────────────────────────────────
// resolveInitialTheme — composes the precedence ladder.
// ────────────────────────────────────────────────────────────────────

test("resolveInitialTheme: saved preference wins over OS", () => {
  // OS wants light, but the user has explicitly saved dark.
  assert.equal(
    theme.resolveInitialTheme({
      savedRaw: JSON.stringify({ ui: { theme: "dark" } }),
      mql: { matches: true },
    }),
    "dark",
  );
  // Saved light beats matchless mql.
  assert.equal(
    theme.resolveInitialTheme({
      savedRaw: JSON.stringify({ ui: { theme: "light" } }),
      mql: { matches: false },
    }),
    "light",
  );
});

test("resolveInitialTheme: falls through to OS preference when no saved value", () => {
  assert.equal(
    theme.resolveInitialTheme({ savedRaw: null, mql: { matches: true } }),
    "light",
    "OS asks for light, no saved value → light",
  );
  assert.equal(
    theme.resolveInitialTheme({ savedRaw: null, mql: { matches: false } }),
    "dark",
    "OS asks for dark, no saved value → dark",
  );
});

test("resolveInitialTheme: defaults to dark when neither signal is available", () => {
  // First-time visitor on a screen-reader / headless / IE-style browser
  // where matchMedia returns nothing. We picked dark as the conservative
  // default for industrial control rooms — see UX_AUDIT.md.
  assert.equal(theme.resolveInitialTheme({}), "dark");
  assert.equal(theme.resolveInitialTheme({ savedRaw: null, mql: null }), "dark");
});

test("resolveInitialTheme: malformed saved value falls through to OS", () => {
  assert.equal(
    theme.resolveInitialTheme({
      savedRaw: "{garbage",
      mql: { matches: true },
    }),
    "light",
  );
});

// ────────────────────────────────────────────────────────────────────
// applyInitialTheme — side-effects against a stub document/window.
// ────────────────────────────────────────────────────────────────────

function makeStubEnv({ savedRaw = null, prefersLight = false } = {}) {
  const cls = new Set(["theme-dark"]); // simulates the legacy hardcoded body class.
  const body = {
    classList: {
      add: (c) => cls.add(c),
      remove: (...args) => args.forEach(c => cls.delete(c)),
      contains: (c) => cls.has(c),
      _set: cls,
    },
  };
  const doc = { body };
  const win = {
    localStorage: { getItem: (k) => (k === "forge.state.v1" ? savedRaw : null) },
    matchMedia: (q) => ({ matches: q.includes("light") ? prefersLight : false }),
  };
  return { doc, win, cls };
}

test("applyInitialTheme: no saved value + OS dark → body has theme-dark only", () => {
  const { doc, win, cls } = makeStubEnv({ savedRaw: null, prefersLight: false });
  const result = theme.applyInitialTheme(doc, win);
  assert.equal(result, "dark");
  assert.equal(cls.has("theme-dark"), true);
  assert.equal(cls.has("theme-light"), false);
});

test("applyInitialTheme: no saved value + OS light → body switches to theme-light", () => {
  const { doc, win, cls } = makeStubEnv({ savedRaw: null, prefersLight: true });
  const result = theme.applyInitialTheme(doc, win);
  assert.equal(result, "light");
  assert.equal(cls.has("theme-light"), true);
  assert.equal(cls.has("theme-dark"), false, "the legacy hardcoded class is removed");
});

test("applyInitialTheme: saved light + OS dark → body becomes theme-light (saved wins)", () => {
  const { doc, win, cls } = makeStubEnv({
    savedRaw: JSON.stringify({ ui: { theme: "light" } }),
    prefersLight: false,
  });
  const result = theme.applyInitialTheme(doc, win);
  assert.equal(result, "light");
  assert.equal(cls.has("theme-light"), true);
});

test("applyInitialTheme: localStorage throws (private mode) — falls through to OS without crashing", () => {
  const cls = new Set();
  const doc = { body: { classList: { add: c => cls.add(c), remove: (...xs) => xs.forEach(x => cls.delete(x)) } } };
  const win = {
    localStorage: { getItem: () => { throw new Error("SecurityError: localStorage disabled"); } },
    matchMedia: () => ({ matches: true }),
  };
  // Must not throw.
  const result = theme.applyInitialTheme(doc, win);
  assert.equal(result, "light");
});

test("applyInitialTheme: matchMedia throws (legacy browser) — falls through to dark default", () => {
  const cls = new Set();
  const doc = { body: { classList: { add: c => cls.add(c), remove: (...xs) => xs.forEach(x => cls.delete(x)) } } };
  const win = {
    localStorage: { getItem: () => null },
    matchMedia: () => { throw new Error("matchMedia not supported"); },
  };
  const result = theme.applyInitialTheme(doc, win);
  assert.equal(result, "dark");
  assert.equal(cls.has("theme-dark"), true);
});
