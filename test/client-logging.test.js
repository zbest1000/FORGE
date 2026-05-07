// Tests for src/core/logging.js — PII scrub + level filtering.
//
// The browser-side logger is the gatekeeper that prevents accidental
// PII (emails, JWTs) from leaving DevTools when a user pastes a
// screenshot. These tests guard the scrub() pipeline against regression.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

const { logger } = await import("../src/core/logging.js");

describe("logger._scrub()", () => {
  test("redacts email addresses anywhere in a string", () => {
    const out = logger._scrub("user@example.com signed in from team@forge.dev");
    assert.equal(out, "<email-redacted> signed in from <email-redacted>");
  });

  test("redacts JWT-shaped tokens", () => {
    const fakeJwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSIsImV4cCI6OTk5OTk5fQ.dGVzdHNpZw";
    const out = logger._scrub("auth header: " + fakeJwt);
    assert.equal(out, "auth header: <token-redacted>");
  });

  test("redacts whole values for PII-named keys", () => {
    const out = logger._scrub({
      email: "u@x.com",
      Password: "hunter2",        // case-insensitive match
      API_KEY: "secret-deadbeef",
      cookie: "sid=abc",
      role: "Engineer",
      id: "U-1",
    });
    assert.equal(out.email, "<redacted>");
    assert.equal(out.Password, "<redacted>");
    assert.equal(out.API_KEY, "<redacted>");
    assert.equal(out.cookie, "<redacted>");
    // Non-PII fields pass through untouched.
    assert.equal(out.role, "Engineer");
    assert.equal(out.id, "U-1");
  });

  test("recurses into nested objects + arrays", () => {
    const out = logger._scrub({
      users: [
        { name: "Alice", email: "alice@a.com" },
        { name: "Bob",   token: "eyJhbGciOiJIUzI1NiJ9.body.sig123456789X" },
      ],
      nested: { deeper: { email: "deep@x.com" } },
    });
    assert.equal(out.users[0].email, "<redacted>");
    assert.equal(out.users[0].name, "Alice");
    assert.equal(out.users[1].token, "<redacted>");
    assert.equal(out.nested.deeper.email, "<redacted>");
  });

  test("Error instances are scrubbed and shape-preserved", () => {
    const err = new Error("Failed to fetch user@x.com profile");
    const out = logger._scrub(err);
    assert.equal(out.name, "Error");
    assert.match(out.message, /<email-redacted>/);
    assert.ok(typeof out.stack === "string");
  });

  test("primitives pass through unchanged", () => {
    assert.equal(logger._scrub(42), 42);
    assert.equal(logger._scrub(true), true);
    assert.equal(logger._scrub(null), null);
    assert.equal(logger._scrub(undefined), undefined);
  });

  test("bails out on deeply recursive structures", () => {
    /** @type any */
    const a = {};
    a.self = a;
    // Should not throw or hang. The scrub bottoms out at depth 4.
    const out = logger._scrub(a);
    assert.ok(out);
  });
});
