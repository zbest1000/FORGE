// Tests for src/screens/docViewerConstants.js — the pure helpers
// extracted from the doc viewer (Phase 4 decomposition). Pure module:
// no DOM stubbing required.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const m = await import("../src/screens/docViewerConstants.js");
const { VIEWER_MODES, ANNOTATE_TOOLS, SHAPE_TOOLS, ZOOM_LEVELS, prevZoom, nextZoom } = m;

describe("constants", () => {
  test("VIEWER_MODES has the six expected modes in stable order", () => {
    const ids = VIEWER_MODES.map(v => v.id);
    assert.deepEqual(ids, ["view", "annotate", "shapes", "insert", "form", "redact"]);
  });

  test("each annotation tool advertises its impl flag (used to grey-out unfinished ones)", () => {
    for (const t of ANNOTATE_TOOLS) {
      assert.ok(t.id && t.label && t.icon, "annotate tool must have id/label/icon");
      assert.equal(typeof t.impl, "boolean");
    }
  });

  test("shape tools cover the basic primitives", () => {
    const ids = SHAPE_TOOLS.map(t => t.id);
    assert.deepEqual(ids.sort(), ["arrow", "ellipse", "line", "rect"]);
  });

  test("zoom levels are sorted ascending", () => {
    const sorted = [...ZOOM_LEVELS].sort((a, b) => a - b);
    assert.deepEqual(sorted, ZOOM_LEVELS);
  });
});

describe("prevZoom()", () => {
  test("steps to the next-lower level", () => {
    assert.equal(prevZoom(1.25), 1);
    assert.equal(prevZoom(2), 1.5);
  });

  test("clamps at the smallest level", () => {
    assert.equal(prevZoom(0.5), 0.5);
    // Even an out-of-range value below the floor still returns the floor.
    assert.equal(prevZoom(0.1), 0.5);
  });

  test("between-levels values snap to the nearest lower defined level", () => {
    // 1.1 is between 1 and 1.25 — prev should be 1 (one step below 1.25,
    // since findIndex(l => l >= 1.1) lands at the index of 1.25).
    assert.equal(prevZoom(1.1), 1);
  });
});

describe("nextZoom()", () => {
  test("steps to the next-higher level", () => {
    assert.equal(nextZoom(1), 1.25);
    assert.equal(nextZoom(1.5), 2);
  });

  test("clamps at the largest level", () => {
    assert.equal(nextZoom(3), 3);
    assert.equal(nextZoom(10), 3);
  });

  test("between-levels values snap to the nearest higher defined level", () => {
    assert.equal(nextZoom(1.1), 1.25);
  });
});
