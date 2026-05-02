// Drawer-chrome regression guard.
//
// A user-reported UX bug exposed a JS/CSS contract drift: the
// `drawer()` primitive in `src/core/ui.js` renders an
// `<aside class="drawer-panel">`, but `styles.css` only carried a
// `.drawer { ... }` rule. Result: the panel rendered with no
// background, no border, and no shadow on desktop — the right
// context panel + project chrome bled through every drawer.
//
// This file enforces the contract going forward:
//
//   1. The drawer-panel selector exists in styles.css and gives the
//      panel a visible background, border, and shadow.
//   2. The drawer-backdrop dim is at least 0.5 opacity (matching
//      the modal contract) so the underlying chrome is properly
//      de-emphasised.
//   3. JS and CSS agree on the class name — `src/core/ui.js` calls
//      `el("aside", { class: "drawer-panel", ... })`, so styles.css
//      MUST style `.drawer-panel` (alias on `.drawer` is fine for
//      back-compat with any future call site that uses the bare
//      class).
//
// Cheap CSS-text checks; no DOM bootstrap needed.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const css = fs.readFileSync(path.join(repoRoot, "styles.css"), "utf8");
const ui = fs.readFileSync(path.join(repoRoot, "src", "core", "ui.js"), "utf8");

function ruleBody(source, selectorRegex) {
  // Selector regex must match start-of-rule, e.g. `\\.drawer-panel\\s*\\{`.
  const m = source.match(new RegExp(selectorRegex.source + "([^}]+)\\}", selectorRegex.flags));
  return m ? m[1] : null;
}

test("`drawer()` in src/core/ui.js still renders `<aside class=\"drawer-panel\">`", () => {
  // If a future refactor renames the class without updating the
  // CSS rule below, this test holds the line.
  assert.match(
    ui,
    /el\(\s*"aside"\s*,\s*\{[\s\S]{0,200}?class:\s*"drawer-panel"/,
    "src/core/ui.js drawer() must produce <aside class=\"drawer-panel\">",
  );
});

test("styles.css carries a `.drawer-panel` rule (matching the JS class) with a visible background", () => {
  // Either the standalone `.drawer-panel { ... }` selector or a
  // grouped `.drawer, .drawer-panel { ... }` selector counts. We
  // require the body to set `background:` to something other than
  // `transparent` / `none`.
  const body = ruleBody(css, /(?:^|\n)(?:\.drawer\s*,\s*)?\.drawer-panel\s*\{/);
  assert.ok(body, "styles.css must define a `.drawer-panel` rule");
  assert.match(body, /background:\s*var\(--surface\)|background:\s*#/, "drawer-panel must paint a background");
  assert.match(body, /border-left:\s*1px/, "drawer-panel must carry a left border so the panel edge is visible");
  assert.match(body, /box-shadow:/, "drawer-panel must carry a shadow so it floats above the chrome");
  assert.match(body, /flex-direction:\s*column/, "drawer-panel must stack header / body / footer vertically");
});

test("the drawer-backdrop dims the underlying app at >= 0.5 opacity (matches modal-backdrop)", () => {
  // The original 0.35 dim left the right context panel readable
  // behind a drawer; bumped to 0.62 to match the modal-backdrop
  // contract. The threshold here is 0.5 so a future contributor
  // can tune within the AA range without rewriting the test.
  const body = ruleBody(css, /\.drawer-backdrop\s*\{/);
  assert.ok(body, "styles.css must define `.drawer-backdrop`");
  const m = body.match(/background:\s*rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*([0-9.]+)\)/);
  assert.ok(m, "drawer-backdrop background must be `rgba(0, 0, 0, X)` for the test to extract X");
  const opacity = parseFloat(m[1]);
  assert.ok(
    opacity >= 0.5,
    `drawer-backdrop dim is ${opacity}; need >= 0.5 so the right context panel doesn't bleed through`,
  );
});

test("drawer-backdrop is fixed full-viewport, sits above modal (z-index >= modal)", () => {
  const body = ruleBody(css, /\.drawer-backdrop\s*\{/);
  assert.ok(body);
  assert.match(body, /position:\s*fixed/, "drawer-backdrop must be position: fixed so it covers the viewport");
  assert.match(body, /inset:\s*0/, "drawer-backdrop must use `inset: 0` for full viewport coverage");
  // z-index ≥ 100 (the modal-backdrop floor) so a drawer opened on
  // top of a modal stacks correctly.
  const z = body.match(/z-index:\s*(\d+)/);
  assert.ok(z, "drawer-backdrop must declare a z-index");
  assert.ok(parseInt(z[1], 10) >= 100, `drawer-backdrop z-index ${z[1]} must be >= 100 (modal floor)`);
});
