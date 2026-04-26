// Tests for the in-process login-lockout tracker.

import test from "node:test";
import assert from "node:assert/strict";

import { isLockedOut, recordLoginFailure, resetLockout, _resetAll } from "../server/security/lockout.js";

test("subject threshold locks after configured failures", () => {
  _resetAll();
  const subject = "email:abc";
  const ip = "1.2.3.4";

  for (let i = 0; i < 4; i++) {
    const r = recordLoginFailure(subject, ip);
    assert.equal(r.locked, false, `attempt ${i + 1} should not lock`);
    assert.equal(isLockedOut(subject, ip).locked, false);
  }
  const final = recordLoginFailure(subject, ip);
  assert.equal(final.locked, true);
  const lock = isLockedOut(subject, ip);
  assert.equal(lock.locked, true);
  assert.equal(lock.reason, "subject");
  assert.ok(lock.retryAfterMs > 0);
});

test("successful login resets the subject + ip counters", () => {
  _resetAll();
  const subject = "email:def";
  const ip = "5.6.7.8";

  for (let i = 0; i < 5; i++) recordLoginFailure(subject, ip);
  assert.equal(isLockedOut(subject, ip).locked, true);

  resetLockout(subject, ip);
  assert.equal(isLockedOut(subject, ip).locked, false);
});

test("ip threshold catches credential-stuffing across emails", () => {
  _resetAll();
  const ip = "9.9.9.9";
  // 25 different subjects, one failure each → trips the per-IP bucket.
  for (let i = 0; i < 25; i++) recordLoginFailure(`email:user-${i}`, ip);
  const lock = isLockedOut("email:fresh", ip);
  assert.equal(lock.locked, true);
  assert.equal(lock.reason, "ip");
});
