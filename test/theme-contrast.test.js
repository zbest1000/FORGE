// UX-C — theme contrast audit.
//
// Parses `styles.css` for the dark + light theme token definitions
// and asserts WCAG 2.1 AA compliance for every load-bearing pair
// (text on backgrounds + critical UI semantic colours). The audit
// runs in CI so any future drop in contrast — including a token
// rename or a half-applied palette change — fails the build with
// the offending pair named.
//
// WCAG thresholds applied here:
//   • Normal text     (< 18 pt regular, < 14 pt bold)  ≥ 4.5 : 1
//   • Large text      (≥ 18 pt regular, ≥ 14 pt bold)  ≥ 3   : 1
//   • UI components   (focus rings, icon buttons)      ≥ 3   : 1
//
// FORGE's body copy is 14 px regular (`html { font-size: 14px }`),
// which classifies as normal text — so `--text` on every meaningful
// background must hit 4.5 : 1, not the 3 : 1 large-text threshold.
//
// Reference implementation: WCAG 2.1 § 1.4.3 + § 1.4.11.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const css = fs.readFileSync(path.resolve(__dirname, "..", "styles.css"), "utf8");

// ────────────────────────────────────────────────────────────────────
// Contrast math (WCAG 2.1).
// ────────────────────────────────────────────────────────────────────

function hexToRgb(hex) {
  const h = hex.replace("#", "");
  if (h.length !== 6) throw new Error(`unsupported hex shorthand: ${hex}`);
  return {
    r: parseInt(h.slice(0, 2), 16) / 255,
    g: parseInt(h.slice(2, 4), 16) / 255,
    b: parseInt(h.slice(4, 6), 16) / 255,
  };
}

// sRGB → linear, per WCAG.
function srgbToLinear(c) {
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

// Relative luminance, per WCAG.
function luminance({ r, g, b }) {
  const R = srgbToLinear(r);
  const G = srgbToLinear(g);
  const B = srgbToLinear(b);
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

function contrast(hexA, hexB) {
  const la = luminance(hexToRgb(hexA));
  const lb = luminance(hexToRgb(hexB));
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

// ────────────────────────────────────────────────────────────────────
// Token extraction — grab the token block for a given theme class.
// ────────────────────────────────────────────────────────────────────

function extractThemeBlock(source, themeClass) {
  const startMarker = `.${themeClass} {`;
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`theme block .${themeClass} not found`);
  const openBrace = source.indexOf("{", start);
  let depth = 1;
  let i = openBrace + 1;
  while (i < source.length && depth > 0) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") depth--;
    i++;
  }
  return source.slice(openBrace + 1, i - 1);
}

function tokensFor(themeClass) {
  const block = extractThemeBlock(css, themeClass);
  const out = {};
  // Match `  --name: #hex;` or `  --name:#hex;`. We intentionally only
  // capture hex values — `color-mix()` and rgb() expressions in tokens
  // are evaluated at runtime by the browser, not statically auditable.
  const re = /--([a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g;
  let m;
  while ((m = re.exec(block)) !== null) out[m[1]] = m[2].toLowerCase();
  return out;
}

const dark = tokensFor("theme-dark");
const light = tokensFor("theme-light");

// ────────────────────────────────────────────────────────────────────
// AA contract — critical pairs the eye reads constantly.
// ────────────────────────────────────────────────────────────────────

// Each entry: { fg, bg, min, label }. Defaults to AA normal text
// (4.5). Marked `largeOnly: true` for entries that only carry large
// text (KPI values, page titles) so the 3 : 1 threshold applies.
const PAIRS = [
  // Body text on every meaningful surface tone.
  { fg: "text",        bg: "bg",       min: 4.5 },
  { fg: "text",        bg: "surface",  min: 4.5 },
  { fg: "text",        bg: "panel",    min: 4.5 },
  { fg: "text",        bg: "elevated", min: 4.5 },
  // Strong / emphasised text — used for headings and primary copy.
  { fg: "text-strong", bg: "bg",       min: 4.5 },
  { fg: "text-strong", bg: "surface",  min: 4.5 },
  { fg: "text-strong", bg: "panel",    min: 4.5 },
  { fg: "text-strong", bg: "elevated", min: 4.5 },
  // Muted (sub-copy, timestamps, hint text). FORGE's body size is
  // 14 px regular so muted must clear the normal-text threshold,
  // even though designers often try to slip muted in at 3 : 1.
  { fg: "muted",       bg: "bg",       min: 4.5 },
  { fg: "muted",       bg: "surface",  min: 4.5 },
  { fg: "muted",       bg: "panel",    min: 4.5 },
  // muted-soft is allowed at the AA-Large threshold (3 : 1) — it is
  // documented as the "tertiary, non-essential" tone for decoration.
  { fg: "muted-soft",  bg: "surface",  min: 3.0 },
  // Semantic colours used as text on neutral surfaces (status badges
  // inherit the colour as text — the badge background is a tinted
  // wash of the same, so the text-on-surface measurement is the
  // load-bearing one).
  { fg: "danger",      bg: "surface",  min: 4.5 },
  { fg: "warn",        bg: "surface",  min: 4.5 },
  { fg: "success",     bg: "surface",  min: 4.5 },
  { fg: "info",        bg: "surface",  min: 4.5 },
  // Accent — used as link colour + active tab text on neutral
  // backgrounds. Must hit AA normal text.
  { fg: "accent",      bg: "surface",  min: 4.5 },
  // Border-strong is a UI-component contrast, not text — 3 : 1
  // suffices to delineate panels under WCAG § 1.4.11.
  { fg: "border-strong", bg: "surface", min: 3.0 },
];

function ratio(theme, fgKey, bgKey) {
  const fg = theme[fgKey];
  const bg = theme[bgKey];
  if (!fg) throw new Error(`token --${fgKey} missing from theme`);
  if (!bg) throw new Error(`token --${bgKey} missing from theme`);
  return { value: contrast(fg, bg), fg, bg };
}

function audit(themeName, theme) {
  const failures = [];
  for (const { fg, bg, min } of PAIRS) {
    const r = ratio(theme, fg, bg);
    if (r.value < min) {
      failures.push(
        `  --${fg} (${r.fg}) on --${bg} (${r.bg})  →  ${r.value.toFixed(2)} : 1  (need ≥ ${min} : 1)`,
      );
    }
  }
  return failures;
}

test("WCAG contrast: dark theme tokens hit AA on every load-bearing pair", () => {
  const failures = audit("theme-dark", dark);
  assert.equal(
    failures.length,
    0,
    `dark theme contrast violations:\n${failures.join("\n")}`,
  );
});

test("WCAG contrast: light theme tokens hit AA on every load-bearing pair", () => {
  const failures = audit("theme-light", light);
  assert.equal(
    failures.length,
    0,
    `light theme contrast violations:\n${failures.join("\n")}`,
  );
});

test("WCAG contrast: text-strong is at least as readable as text on every background", () => {
  // text-strong should never be _less_ readable than text — that
  // would mean the design system has an emphasis token that's
  // actually harder to read. Catches accidental token swaps.
  for (const themeName of ["dark", "light"]) {
    const t = themeName === "dark" ? dark : light;
    for (const bg of ["bg", "surface", "panel", "elevated"]) {
      const rText = ratio(t, "text", bg).value;
      const rStrong = ratio(t, "text-strong", bg).value;
      assert.ok(
        rStrong >= rText,
        `${themeName}: --text-strong on --${bg} (${rStrong.toFixed(2)}) is less readable than --text (${rText.toFixed(2)})`,
      );
    }
  }
});

test("WCAG contrast: focus ring (--ring or --accent) hits 3 : 1 on every surface", () => {
  // WCAG § 1.4.11: non-text UI components and focus indicators need
  // ≥ 3 : 1 against adjacent surfaces.
  for (const themeName of ["dark", "light"]) {
    const t = themeName === "dark" ? dark : light;
    const ringToken = t.ring || t.accent; // --ring is added in UX-C
    assert.ok(ringToken, `${themeName}: must define --ring or --accent`);
    for (const bg of ["bg", "surface", "panel"]) {
      const r = (() => {
        try {
          const fgKey = t.ring ? "ring" : "accent";
          return ratio(t, fgKey, bg).value;
        } catch { return 0; }
      })();
      assert.ok(
        r >= 3.0,
        `${themeName}: focus ring on --${bg} is ${r.toFixed(2)} : 1 (need ≥ 3 : 1)`,
      );
    }
  }
});

test("WCAG contrast: --border-strong delineates panels (≥ 3 : 1 vs surface)", () => {
  for (const themeName of ["dark", "light"]) {
    const t = themeName === "dark" ? dark : light;
    const r = ratio(t, "border-strong", "surface").value;
    assert.ok(
      r >= 3.0,
      `${themeName}: --border-strong on --surface is ${r.toFixed(2)} : 1 (need ≥ 3 : 1 for component contrast)`,
    );
  }
});
