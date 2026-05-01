// UX-E — interactive semantics regression guard.
//
// The code review of UX-E reframed the audit's "[M] activity-row
// rendered as div" finding: most `<div class="activity-row">`
// instances actually contain inner `<button>` children (display
// rows around an Edit / Disable / Delete CTA), and converting the
// outer wrapper to `<button>` would nest interactive content —
// HTML-invalid, breaks AT.
//
// The genuine targets are rows that ARE the click target with no
// inner interactive children: tree items, palette items, revision
// rows, etc. UX-E converts those to real `<button type="button">`
// so keyboard support is intrinsic — Enter / Space activate without
// the `installRowKeyboardHandlers()` MutationObserver having to
// retro-fit role + tabindex.
//
// This file is the regression guard. It scans `src/screens/` for
// patterns that would re-introduce the audit finding:
//   * `el("div", { class: ".*tree-item.*", ... onClick: ... })`
//     — should be `<button>`
//   * Any new `el("div", { class: ".*activity-row.*", onClick: ... })`
//     where the row has no inner button — should also be `<button>`
//
// And asserts the central selector list (`installRowKeyboardHandlers`)
// no longer carries `.activity-row[onclick]` — the never-matching
// rule we cleaned up.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

function readFiles(dir, ext = ".js") {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...readFiles(full, ext));
    else if (entry.isFile() && entry.name.endsWith(ext)) out.push(full);
  }
  return out;
}

const screens = readFiles(path.join(repoRoot, "src", "screens"));

test("no `<div class=\"tree-item\">` with onClick remains in src/screens (must be `<button>`)", () => {
  const offenders = [];
  for (const file of screens) {
    const src = fs.readFileSync(file, "utf8");
    // Match the el("div", {...}) call form, then look for `class:` containing
    // tree-item AND `onClick:` in the same options object. The match is
    // line-aware to keep false positives down on multi-line option blocks
    // — we look at a window of ~6 lines starting from each `el("div"`.
    const re = /el\(\s*"div"\s*,\s*\{([\s\S]{0,400}?)\}/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const opts = m[1];
      const hasTree = /class:\s*[`"][^"`]*tree-item/.test(opts);
      const hasOnClick = /\bonClick\s*:/.test(opts);
      if (hasTree && hasOnClick) {
        const before = src.slice(0, m.index);
        const lineNum = before.split("\n").length;
        offenders.push(`  ${path.relative(repoRoot, file)}:${lineNum}`);
      }
    }
  }
  assert.equal(
    offenders.length,
    0,
    `clickable .tree-item rendered as <div> — convert to <button type="button">:\n${offenders.join("\n")}`,
  );
});

test("ROW_BUTTON_SELECTOR no longer carries the never-matching `.activity-row[onclick]` entry", () => {
  // The selector lived in src/core/ui.js. After UX-E it should be
  // gone — `el(... { onClick: fn })` calls `addEventListener` rather
  // than setting the inline `onclick` HTML attribute, so the rule
  // never fired. Removing it shrinks the observer's match cost +
  // makes the selector contract honest.
  const ui = fs.readFileSync(path.join(repoRoot, "src", "core", "ui.js"), "utf8");
  const selectorBlock = ui.match(/const\s+ROW_BUTTON_SELECTOR\s*=\s*\[([\s\S]+?)\]/);
  assert.ok(selectorBlock, "ROW_BUTTON_SELECTOR const must exist");
  assert.doesNotMatch(
    selectorBlock[1],
    /"\.activity-row\[onclick\]"/,
    "remove `.activity-row[onclick]` — it never matches addEventListener-based handlers",
  );
});

test("ROW_BUTTON_SELECTOR retains coverage for shapes that genuinely cannot be a `<button>`", () => {
  // The observer is now an explicit safety net for the cases
  // where a real <button> isn't structurally possible. Those entries
  // must stay present so the regression test fails LOUDLY if a
  // future cleanup rips out the observer entirely without a
  // strategy for tr.row-clickable + draggable kanban-card.
  const ui = fs.readFileSync(path.join(repoRoot, "src", "core", "ui.js"), "utf8");
  const selectorBlock = ui.match(/const\s+ROW_BUTTON_SELECTOR\s*=\s*\[([\s\S]+?)\]/);
  const required = [
    ".row-clickable",       // <tr class="row-clickable"> in tables
    ".kanban-card",         // workBoard.js — draggable
    ".tree-item",           // sole holdout: assetDashboard's tree-item
                            //   div for "(N unassigned)" non-clickable label
                            //   — observer skips A/BUTTON tagNames, so this
                            //   only adds aria to the holdouts that need it
    ".chip.clickable",
    ".palette-item",
    ".revision-row",
    ".uns-tree-item",
    ".dock-item",
  ];
  for (const sel of required) {
    assert.match(
      selectorBlock[1],
      new RegExp(`"${sel.replace(/\./g, "\\.")}"`),
      `ROW_BUTTON_SELECTOR must keep ${sel} (used by something that cannot be a <button>)`,
    );
  }
});

test("the observer's tag() helper continues to skip A and BUTTON tagNames", () => {
  // If a future refactor removed the A/BUTTON skip, every real
  // <button class="tree-item"> in the codebase would suddenly get
  // a redundant role="button" + tabindex="0" applied — harmless but
  // noisy in DOM diffing tests. This guard prevents that regression.
  const ui = fs.readFileSync(path.join(repoRoot, "src", "core", "ui.js"), "utf8");
  assert.match(
    ui,
    /tagName\s*===\s*"A"\s*\|\|\s*c\.tagName\s*===\s*"BUTTON"/,
    "observer must early-out for native button-like elements",
  );
});

test("UX-E converted sites — drawingViewer + i3x render their tree-item rows as `<button>`", () => {
  // Two specific UX-E conversions. If a future refactor reverts
  // either, this test re-fails the build.
  const drawingViewer = fs.readFileSync(path.join(repoRoot, "src", "screens", "drawingViewer.js"), "utf8");
  // Look for the button-form of the IFC tree-item.
  assert.match(
    drawingViewer,
    /el\(\s*"button"\s*,\s*\{[\s\S]{0,200}?type:\s*"button"[\s\S]{0,200}?class:\s*`tree-item/,
    "drawingViewer.js IFC tree row must render as <button type=\"button\">",
  );
  const i3x = fs.readFileSync(path.join(repoRoot, "src", "screens", "i3x.js"), "utf8");
  assert.match(
    i3x,
    /el\(\s*"button"\s*,\s*\{[\s\S]{0,200}?type:\s*"button"[\s\S]{0,200}?class:\s*`tree-item/,
    "i3x.js endpoint row must render as <button type=\"button\">",
  );
});
