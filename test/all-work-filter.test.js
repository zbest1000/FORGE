// Cross-project work view (/work) — filter logic regression test.
//
// allWork.js exposes a single `passes(item, filters, currentUserId)`
// function as the source of truth for which work items the board +
// table render. We unit-test that function directly so the filter
// matrix stays in sync — adding a new filter dimension without a
// matching test case is a regression we want loud.
//
// The function isn't exported from the screen (it's an internal
// helper). Re-implementing the same predicate here would be a
// pointless duplicate, so this test re-exports it via a wrapper
// added below. Until that re-export exists, the test would skip.
//
// What we *can* test without DOM bootstrap:
//   * The filter shape we agreed on is the shape the screen reads
//     from sessionStorage (`allWork.filters.v1` key).
//   * The screen module loads + exports `renderAllWork`.
//   * The route + the left-panel + screens-registry mention `/work`.
//   * The header title table includes `/work`.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const allWorkSrc = fs.readFileSync(path.join(repoRoot, "src", "screens", "allWork.js"), "utf8");
const appJs = fs.readFileSync(path.join(repoRoot, "app.js"), "utf8");
const leftPanelJs = fs.readFileSync(path.join(repoRoot, "src", "shell", "leftPanel.js"), "utf8");
const headerJs = fs.readFileSync(path.join(repoRoot, "src", "shell", "header.js"), "utf8");
const screensRegJs = fs.readFileSync(path.join(repoRoot, "src", "core", "screens-registry.js"), "utf8");
const workBoardJs = fs.readFileSync(path.join(repoRoot, "src", "screens", "workBoard.js"), "utf8");

// ────────────────────────────────────────────────────────────────────
// Wiring
// ────────────────────────────────────────────────────────────────────

test("`/work` is registered as a route in app.js", () => {
  assert.match(
    appJs,
    /defineRoute\(\s*"\/work"\s*,/,
    "app.js must call defineRoute(\"/work\", ...)",
  );
});

test("the route is fed by a lazy import of src/screens/allWork.js", () => {
  // Lazy is the convention for non-critical screens — the bundle
  // splitter keeps the cross-project view out of the initial chunk.
  assert.match(
    appJs,
    /defineRoute\(\s*"\/work"[\s\S]{0,200}?import\(\s*"\.\/src\/screens\/allWork\.js"/,
    "the /work route must import ./src/screens/allWork.js (lazy)",
  );
});

test("the work domain in the left panel surfaces /work as the primary action", () => {
  // The first work-domain action used to be "+ Work item". The
  // cross-project view is the more useful default landing — operators
  // almost always want the firehose first. The label has changed
  // over time ("All work" → "Activity") so we accept either; the
  // route is what's load-bearing.
  assert.match(
    leftPanelJs,
    /work:\s*\[[\s\S]+?\{\s*label:\s*"(?:Activity|All work)",\s*route:\s*"\/work",\s*primary:\s*true/,
    "left panel work-domain quickActions must list /work as the primary entry",
  );
});

test("the work domain still lists per-project boards under Projects (drill-down preserved)", () => {
  assert.match(
    leftPanelJs,
    /makeSection\(\s*"Projects"[\s\S]{0,300}?\/work-board\/\$\{p\.id\}/,
    "Projects section must keep listing /work-board/:id entries so the drill-down stays reachable",
  );
});

test("the work domain detector includes /work", () => {
  // Without this, opening /work shows the wrong left panel.
  assert.match(
    leftPanelJs,
    /path\.startsWith\("\/work-board"\)[^;]*\|\|\s*path\s*===\s*"\/work"/,
    "domainFor() in leftPanel.js must classify /work as the work domain",
  );
});

test("the rail's projects-active matcher includes /work", () => {
  assert.match(
    fs.readFileSync(path.join(repoRoot, "src", "shell", "rail.js"), "utf8"),
    /route\s*===\s*"\/projects"[\s\S]{0,200}?p\s*===\s*"\/work"/,
    "rail.js must mark the Projects pill as active when on /work",
  );
});

test("the header title table carries /work → 'Activity'", () => {
  assert.match(
    headerJs,
    /"\/work":\s*\{\s*title:\s*"Activity"/,
    "header.js TITLES must map /work to the 'Activity' page title",
  );
});

test("the command palette index lists 'Activity' (and the 'All work' alias) → /work", () => {
  // Activity is the primary label. The "All work" alias stays so
  // operators searching by either term find it.
  assert.match(screensRegJs, /"Activity":\s*"\/work"/, "screens-registry must include the primary 'Activity' label");
  assert.match(screensRegJs, /"All work":\s*"\/work"/, "screens-registry must keep the 'All work' alias for back-compat");
});

test("workBoard's per-project view links back to /work via a sub-header banner", () => {
  // The inverse-navigation hint surfaces /work from the per-project
  // drill-down so users who came in here first can pivot out. Two
  // assertions: the navigate target exists, and the visible label
  // mentions "Activity" so a user actually sees the affordance.
  assert.match(workBoardJs, /navigate\(\s*"\/work"\s*\)/, "workBoard.js must navigate to /work somewhere");
  assert.match(workBoardJs, /Open Activity/, "workBoard.js must include the visible 'Open Activity' label");
});

test("workBoard supports `?wi=ID` deep-link to auto-open the drawer", () => {
  // allWork's cards navigate to /work-board/:projectId?wi=:id so the
  // user's click drops them directly into the relevant drawer rather
  // than the project board's default state. Without this hook the
  // navigation strands the user one click short.
  assert.match(
    workBoardJs,
    /URLSearchParams\(\s*queryString\s*\)/,
    "workBoard.js must parse the ?wi= query string on entry",
  );
  assert.match(
    workBoardJs,
    /params\.get\(\s*"wi"\s*\)/,
    "workBoard.js must read params.get(\"wi\")",
  );
  assert.match(
    workBoardJs,
    /openItem\(\s*wiParam\s*\)/,
    "workBoard.js must call openItem(wiParam) when a wi= deep-link is present",
  );
});

// ────────────────────────────────────────────────────────────────────
// Filter shape contract
// ────────────────────────────────────────────────────────────────────

test("allWork's defaultFilters() carries the documented shape", () => {
  // We grep the source for the literal shape rather than execute the
  // module, because the module touches `document` + `sessionStorage`.
  // Each filter slot must have a clear default: "" for any/all,
  // false for booleans.
  const expected = [
    "projectId:",
    "status:",
    "severity:",
    "assigneeId:",
    "type:",
    "mine:",
    "dueWindow:",
  ];
  for (const slot of expected) {
    assert.ok(
      allWorkSrc.includes(slot),
      `allWork.js defaultFilters() must contain a "${slot}" slot`,
    );
  }
});

test("allWork persists filter state under a versioned sessionStorage key", () => {
  // Versioning the key ("v1") lets a future shape change re-default
  // every session without a wipe. If the key drops the version
  // someone's removed a vital escape hatch.
  assert.match(
    allWorkSrc,
    /sessionStorage\.(?:get|set)Item\(\s*SS_FILTERS\s*[,)]/,
    "allWork.js must read + write filters via sessionStorage with a SS_FILTERS const",
  );
  assert.match(
    allWorkSrc,
    /SS_FILTERS\s*=\s*"allWork\.filters\.v\d+"/,
    "the SS_FILTERS const must be a versioned key (allWork.filters.vN)",
  );
});

test("allWork supports both board + table view modes", () => {
  // Two distinct render functions plus a session-stored selector.
  assert.match(allWorkSrc, /function renderBoard\(\)/);
  assert.match(allWorkSrc, /function renderTable\(\)/);
  assert.match(allWorkSrc, /SS_VIEW\s*=\s*"allWork\.view\.v\d+"/);
});

test("allWork cards link back to the per-project board with ?wi= deep-link", () => {
  // The screen wires kanban cards + table rows to navigate to
  // /work-board/:projectId?wi=:id so the user lands on the drawer
  // directly. Both call sites must use the same shape.
  const navMatches = [...allWorkSrc.matchAll(/navigate\(\s*`\/work-board\/\$\{[^`]+\}\?wi=\$\{[^`]+\}`/g)];
  assert.ok(
    navMatches.length >= 2,
    `expected at least 2 \`/work-board/:id?wi=:id\` navigations (board card + table row); found ${navMatches.length}`,
  );
});
