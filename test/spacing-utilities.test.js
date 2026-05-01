// UX-F — spacing-utility regression guard.
//
// styles.css gains a Tailwind-flavoured single-purpose utility set
// (`.mt-1` through `.mt-6`, plus `.mb-`, `.ml-`, `.mr-`, `.mx-`,
// `.my-`, `.p-`, `.pt-`, `.pb-`, `.pl-`, `.pr-`, `.px-`, `.py-`,
// `.gap-`) so screens can drop the most common
// `style: { marginBottom: "12px" }` literals.
//
// This file enforces:
//
//   1. Every utility class exists in styles.css.
//   2. Each class binds to the matching `--space-N` token (so a
//      future token re-tune still flows through to every site).
//   3. The migration left no `style: { marginBottom|marginTop|gap|
//      padding: "Npx" }` sites in the top-3 audited offenders
//      where N matches a --space-* token. Composite or computed
//      values are still allowed inline; the test only fails on the
//      single-property mappings the policy says should be classes.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const css = fs.readFileSync(path.join(repoRoot, "styles.css"), "utf8");

// ────────────────────────────────────────────────────────────────────
// Shape of the utility set.
//
// `prefixes` map a class prefix to the CSS property (or property
// pair, for x/y/all variants) it should produce. The test walks
// every (prefix × scale) combination and asserts the class block
// exists with the right `var(--space-N)` reference(s).
// ────────────────────────────────────────────────────────────────────

const PROP_BY_PREFIX = {
  m:   ["margin"],
  mt:  ["margin-top"],
  mb:  ["margin-bottom"],
  ml:  ["margin-left"],
  mr:  ["margin-right"],
  mx:  ["margin-left", "margin-right"],
  my:  ["margin-top", "margin-bottom"],
  p:   ["padding"],
  pt:  ["padding-top"],
  pb:  ["padding-bottom"],
  pl:  ["padding-left"],
  pr:  ["padding-right"],
  px:  ["padding-left", "padding-right"],
  py:  ["padding-top", "padding-bottom"],
  gap: ["gap"],
};

const SCALE = [1, 2, 3, 4, 5, 6];

test("every spacing utility class exists in styles.css", () => {
  const missing = [];
  for (const prefix of Object.keys(PROP_BY_PREFIX)) {
    for (const n of SCALE) {
      const cls = `.${prefix}-${n}`;
      // Look for the class block — `.mb-3 { margin-bottom: var(--space-3); }`.
      // We require an exact match of the selector at the start of a rule
      // so we don't false-positive on `.mb-3:hover` etc.
      const re = new RegExp(`(^|\\s)\\${cls}\\s*\\{`, "m");
      if (!re.test(css)) missing.push(cls);
    }
  }
  assert.equal(
    missing.length,
    0,
    `missing utility classes:\n  ${missing.join("\n  ")}`,
  );
});

test("each utility class binds to the matching --space-N token", () => {
  // Pull every utility-class block + assert its body wires the
  // expected property to the expected token. Catches the regression
  // where someone "fixes" .mt-3 to use a literal 12px, breaking the
  // theme-token chain.
  const wrong = [];
  for (const [prefix, props] of Object.entries(PROP_BY_PREFIX)) {
    for (const n of SCALE) {
      const cls = `.${prefix}-${n}`;
      // Capture the rule body up to the closing `}`.
      const m = css.match(new RegExp(`(^|\\n)\\${cls}\\s*\\{([^}]+)\\}`));
      if (!m) continue; // first test catches this
      const body = m[2];
      for (const prop of props) {
        const expected = `${prop}: var(--space-${n});`;
        if (!body.includes(expected)) {
          wrong.push(`${cls} body must contain "${expected}" (got: ${body.trim()})`);
        }
      }
    }
  }
  assert.equal(
    wrong.length,
    0,
    `utility classes with mismatched tokens or properties:\n  ${wrong.join("\n  ")}`,
  );
});

test("UX-F migrated the top-3 offenders' simple inline-style sites", () => {
  // The migration policy says any `style: { X: "Npx" }` where
  // `X` is one of the token-mapped properties (margin*, padding*,
  // gap) AND `N` is a --space-* value (4, 8, 12, 16, 24, 32) must
  // become a utility class. Composite or computed cases are still
  // allowed inline.
  //
  // Run the policy across the three offenders the audit named.
  const screens = [
    "src/screens/workBoard.js",
    "src/screens/assetDashboard.js",
    "src/screens/docViewer.js",
  ];
  const TOKEN_PX = new Set([4, 8, 12, 16, 24, 32]);
  const PROP_RE = /^(margin|marginTop|marginBottom|marginLeft|marginRight|padding|paddingTop|paddingBottom|paddingLeft|paddingRight|gap)$/;

  const offenders = [];
  for (const rel of screens) {
    const src = fs.readFileSync(path.join(repoRoot, rel), "utf8");
    // Walk every `style: { ... }` block and check if it's a SIMPLE
    // single-property mapping that would hit a utility class.
    const styleRe = /style:\s*\{\s*([^}]+?)\s*\}/g;
    let m;
    while ((m = styleRe.exec(src)) !== null) {
      const inner = m[1];
      // We only flag sites whose ENTIRE style object is a single
      // prop:px pair where prop is token-mapped + px hits the
      // token scale. Composite blocks pass through.
      const single = /^([a-zA-Z]+)\s*:\s*"(\d+)px"\s*,?\s*$/;
      const sm = inner.match(single);
      if (!sm) continue;
      const prop = sm[1];
      const px = Number(sm[2]);
      if (!PROP_RE.test(prop)) continue;
      if (!TOKEN_PX.has(px)) continue;
      // Compute the line number for the offence message.
      const lineNum = src.slice(0, m.index).split("\n").length;
      offenders.push(`  ${rel}:${lineNum} — \`style: { ${inner} }\` should be the matching utility class`);
    }
  }
  assert.equal(
    offenders.length,
    0,
    `top-3 offenders still have simple inline-style sites that map to utilities:\n${offenders.join("\n")}`,
  );
});

test("the utility set documentation block survives in styles.css", () => {
  // The doc block at the top of the utility section names the
  // migration policy. If it gets accidentally deleted, future
  // contributors lose the rationale.
  assert.match(
    css,
    /Spacing utilities \(UX-F\)/,
    "styles.css must keep the 'Spacing utilities (UX-F)' header",
  );
  assert.match(
    css,
    /Migration policy: replace `style: \{ marginTop:/,
    "styles.css must keep the migration-policy paragraph",
  );
});
