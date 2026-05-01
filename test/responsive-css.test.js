// UX-B — responsive CSS smoke test.
//
// CSS isn't unit-testable in the traditional sense, but the
// breakpoint contract is load-bearing: a regression here would
// silently re-break mobile, which is exactly the class of bug the
// audit caught. Cheap insurance — assert the breakpoints exist + the
// load-bearing rules within them are present.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cssPath = path.resolve(__dirname, "..", "styles.css");
const css = fs.readFileSync(cssPath, "utf8");

// Helper: extract the body of an `@media (max-width: Npx) { ... }`
// block. Walks brace-by-brace from the opening `{` after the query
// so nested at-rules and media queries with the same prefix don't
// confuse the matcher.
function extractMediaBlock(source, query) {
  const startMarker = `@media (${query})`;
  const start = source.indexOf(startMarker);
  if (start < 0) return null;
  const openBrace = source.indexOf("{", start);
  if (openBrace < 0) return null;
  let depth = 1;
  let i = openBrace + 1;
  while (i < source.length && depth > 0) {
    const c = source[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    i++;
  }
  return source.slice(openBrace + 1, i - 1);
}

test("`max-width: 1280px` block still hides the right context panel + collapses viewer-style layouts", () => {
  const block = extractMediaBlock(css, "max-width: 1280px");
  assert.ok(block, "1280px breakpoint must exist");
  assert.match(block, /\.right-context-panel\s*\{\s*display:\s*none/, "right context panel must hide");
  assert.match(block, /\.viewer-layout/, "viewer-layout collapses");
  assert.match(block, /\.channel-layout/, "channel-layout collapses");
  assert.match(block, /\.incident-layout/, "incident-layout collapses");
  assert.match(block, /\.ai-layout/, "ai-layout collapses");
});

test("`max-width: 1024px` block collapses .three-col to a 2-up grid", () => {
  const block = extractMediaBlock(css, "max-width: 1024px");
  assert.ok(block, "1024px breakpoint must exist (UX-B tablet)");
  assert.match(
    block,
    /\.three-col\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/,
    ".three-col collapses to 2-up at tablet width",
  );
});

test("`max-width: 768px` block hides the left panel + collapses .two-col / .three-col", () => {
  const block = extractMediaBlock(css, "max-width: 768px");
  assert.ok(block, "768px breakpoint must exist (UX-B large phone)");
  assert.match(block, /\.left-panel\s*\{\s*display:\s*none/, "left panel must hide on large phones");
  // Single regex covering the joined .two-col, .three-col selector.
  assert.match(block, /\.two-col,\s*\.three-col\s*\{\s*grid-template-columns:\s*1fr/);
});

test("`max-width: 640px` block sets up the bottom-bar rail + phone modal/drawer treatment", () => {
  const block = extractMediaBlock(css, "max-width: 640px");
  assert.ok(block, "640px breakpoint must exist (UX-B phone)");

  // Bottom-bar rail.
  assert.match(block, /\.app-shell\s*\{[^}]*grid-template-rows:\s*1fr\s+auto/, "app-shell rows: 1fr auto for bottom-bar");
  assert.match(block, /\.far-left-rail\s*\{[^}]*flex-direction:\s*row/, "rail flex-direction switches to row");
  assert.match(block, /\.rail-btn\s*\{[^}]*width:\s*44px[^}]*height:\s*44px/, "rail buttons hit WCAG 2.5.5 (44 × 44)");

  // Header trim.
  assert.match(block, /\.search-input,\s*\.header-acting\s*\{\s*display:\s*none/, "non-essential header controls hidden");

  // Modal full-bleed.
  assert.match(block, /\.modal\s*\{[^}]*max-width:\s*none/);
  assert.match(block, /\.modal\s*\{[^}]*max-height:\s*100dvh/);
  assert.match(block, /\.modal\s*\{[^}]*border-radius:\s*0/);

  // Drawer full-width.
  assert.match(block, /\.drawer-panel\s*\{[^}]*width:\s*100%\s*!important/);

  // Card-grid tighter on phones.
  assert.match(block, /\.card-grid[^{]*\{[^}]*minmax\(160px/, "card-grid uses 160px minmax for two-up cards");

  // Tables become horizontally scrollable rather than squashing.
  assert.match(block, /\.table[^,{][^{]*\{[^}]*min-width:\s*480px/);
});

test("layout-toggle grid-template-columns rules are gated behind `min-width: 641px`", () => {
  // The body.hide-* / focus-mode toggles were moved INTO a min-width
  // block so they don't fight the phone bottom-bar layout. Without
  // this gate, hide-rail on a phone would trigger a 260px column
  // that breaks the bottom-bar.
  const block = extractMediaBlock(css, "min-width: 641px");
  assert.ok(block, "min-width: 641px gate must exist");
  assert.match(block, /body\.hide-left-panel:not\(\.hide-right-panel\)/);
  assert.match(block, /body\.hide-rail:not\(\.hide-left-panel\)/);
  assert.match(block, /body\.focus-mode\s+\.app-shell/);
});

test("body.hide-* display:none rules remain unconditional (work on every viewport)", () => {
  // The hide rules themselves must not be inside any media query —
  // a user toggling hide-rail on a phone still sees a hidden rail.
  // We assert by finding the rule outside the responsive block.
  const head = css.split("@media")[0]; // everything before the first @media
  // The display:none rules sit AFTER the existing component styles
  // but BEFORE the responsive section. Walk forward from `body.hide-rail`
  // and check the rule body isn't enclosed by a media query.
  const rule = /body\.hide-left-panel\s+\.left-panel\s*\{\s*display:\s*none/;
  assert.match(css, rule, "hide rule exists somewhere");

  // More important: assert it's not solely inside a `@media` block.
  // Strip every @media block and check it still appears.
  let stripped = css;
  while (true) {
    const idx = stripped.indexOf("@media");
    if (idx < 0) break;
    const open = stripped.indexOf("{", idx);
    if (open < 0) break;
    let depth = 1;
    let i = open + 1;
    while (i < stripped.length && depth > 0) {
      if (stripped[i] === "{") depth++;
      else if (stripped[i] === "}") depth--;
      i++;
    }
    stripped = stripped.slice(0, idx) + stripped.slice(i);
  }
  assert.match(stripped, rule, "hide-left-panel display:none must live outside any @media block");
});

test("transition declarations no longer use literal durations (UX-A foundation enforced)", () => {
  // After UX-A every transition in styles.css consumes a `var(--timing-*)`
  // token. A regression here means a phase that re-introduces a literal
  // duration (which would bypass the prefers-reduced-motion override).
  const literalDuration = /transition:[^;]*\b\d+(?:\.\d+)?(?:s|ms)\b/g;
  const matches = css.match(literalDuration) || [];
  assert.equal(
    matches.length,
    0,
    `transitions must use --timing-* tokens; found literal durations:\n  ${matches.join("\n  ")}`,
  );
});
