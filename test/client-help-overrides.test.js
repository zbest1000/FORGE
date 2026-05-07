// Tests for help overrides (Phase 4) — bundled HELP_TOPICS stays the
// safety net; overrides layer on top so operators can keep docs in
// sync with their deployment without a redeploy.

import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Minimal DOM stub for help.js's `import { el } from ./ui.js` chain.
globalThis.window = /** @type any */ ({ addEventListener() {}, removeEventListener() {} });
globalThis.document = /** @type any */ ({
  createElement: () => ({ classList: { add() {} }, style: {}, addEventListener() {}, append() {}, setAttribute() {} }),
  createDocumentFragment: () => ({ append() {} }),
});

const help = await import("../src/core/help.js");

beforeEach(() => help.clearHelpOverrides());

describe("applyHelpOverrides()", () => {
  test("override replaces a bundled topic's body but keeps other fields", () => {
    // Pick any bundled topic — the registry is large but `forge.workitem`
    // is one of the canonical FORGE-concept entries.
    const before = help.getTopic("forge.workitem");
    assert.ok(before, "test setup: bundled topic should exist");
    const baseTitle = before.title;
    const baseSection = before.section;

    help.applyHelpOverrides({ "forge.workitem": { body: "Re-authored body for prod" } });

    const after = help.getTopic("forge.workitem");
    assert.equal(after.body, "Re-authored body for prod");
    // Untouched fields fall through to the bundle.
    assert.equal(after.title, baseTitle);
    assert.equal(after.section, baseSection);
  });

  test("override can introduce a brand-new topic id", () => {
    help.applyHelpOverrides({
      "deploy.specifics": {
        title: "Local rollout playbook",
        section: "Operations",
        summary: "Step-by-step our team uses",
        body: "1. Tag release\n2. Deploy ...",
      },
    });

    const t = help.getTopic("deploy.specifics");
    assert.ok(t);
    assert.equal(t.title, "Local rollout playbook");

    // The new section appears in the section index.
    const sections = help.listTopicsBySection();
    const ops = sections.find(s => s.section === "Operations");
    assert.ok(ops);
    assert.ok(ops.topics.some(t => t.id === "deploy.specifics"));
  });

  test("clearHelpOverrides restores the bundled view", () => {
    const beforeBody = help.getTopic("forge.workitem").body;
    help.applyHelpOverrides({ "forge.workitem": { body: "temporary" } });
    assert.equal(help.getTopic("forge.workitem").body, "temporary");

    help.clearHelpOverrides();
    assert.equal(help.getTopic("forge.workitem").body, beforeBody);
  });

  test("malformed override payloads are ignored, not thrown", () => {
    // Each of these should be dropped silently — the bundled topics
    // are the safety net.
    help.applyHelpOverrides(null);
    help.applyHelpOverrides("not an object");
    help.applyHelpOverrides({ "x": "not an object" });
    help.applyHelpOverrides({ "x": null });
    // No assertion needed — the test passing means no exception was thrown.
    assert.ok(true);
  });

  test("repeated apply with same payload converges (idempotent)", () => {
    const payload = { "forge.workitem": { body: "stable" } };
    help.applyHelpOverrides(payload);
    help.applyHelpOverrides(payload);
    help.applyHelpOverrides(payload);
    assert.equal(help.getTopic("forge.workitem").body, "stable");
  });
});

describe("loadHelpOverrides()", () => {
  test("successful fetch applies the response payload", async () => {
    const fakeFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ "forge.workitem": { body: "from server" } }),
    });
    /** @type any */ (globalThis).fetch = fakeFetch;

    const result = await help.loadHelpOverrides("/api/help/topics");
    assert.equal(result.ok, true);
    assert.equal(result.count, 1);
    assert.equal(help.getTopic("forge.workitem").body, "from server");
  });

  test("fetch failure leaves bundled topics intact", async () => {
    const before = help.getTopic("forge.workitem").body;
    /** @type any */ (globalThis).fetch = async () => ({ ok: false, status: 500 });

    const result = await help.loadHelpOverrides("/api/help/topics");
    assert.equal(result.ok, false);
    assert.equal(help.getTopic("forge.workitem").body, before);
  });

  test("network error is captured, not propagated", async () => {
    /** @type any */ (globalThis).fetch = async () => { throw new Error("network down"); };

    const result = await help.loadHelpOverrides("/api/help/topics");
    assert.equal(result.ok, false);
    assert.match(result.error, /network down/);
  });
});
