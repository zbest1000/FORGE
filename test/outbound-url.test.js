// Tests for the outbound-URL safety guard used by the webhooks dispatcher.

import test from "node:test";
import assert from "node:assert/strict";

import { validateOutboundUrl, isPrivateIPv4, isPrivateIPv6 } from "../server/security/outbound.js";

test("rejects private IPv4 ranges", () => {
  for (const ip of ["10.0.0.5", "127.0.0.1", "169.254.169.254", "192.168.1.1", "172.16.5.5", "100.64.1.1", "0.0.0.0"]) {
    assert.equal(isPrivateIPv4(ip), true, ip);
    const res = validateOutboundUrl(`http://${ip}/path`);
    assert.equal(res.ok, false);
    assert.equal(res.reason, "private_ip");
  }
});

test("rejects private IPv6 + IPv4-mapped IPv6", () => {
  for (const ip of ["::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1"]) {
    assert.equal(isPrivateIPv6(ip), true, ip);
  }
  const res = validateOutboundUrl(`http://[::1]/x`);
  assert.equal(res.ok, false);
  assert.equal(res.reason, "private_ip");
});

test("rejects internal hostnames", () => {
  for (const host of ["localhost", "broker.local", "service.internal", "host.lan", "metadata.google.internal", "host.docker.internal"]) {
    const res = validateOutboundUrl(`http://${host}/x`);
    assert.equal(res.ok, false, host);
    assert.equal(res.reason, "internal_host");
  }
});

test("rejects non-http schemes", () => {
  for (const url of ["file:///etc/passwd", "gopher://example.com/", "javascript:alert(1)"]) {
    const res = validateOutboundUrl(url);
    assert.equal(res.ok, false);
    assert.equal(res.reason, "scheme_not_allowed");
  }
});

test("requires https in strict/production mode", () => {
  const res = validateOutboundUrl("http://example.com/", { NODE_ENV: "production" });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "https_required");
  const ok = validateOutboundUrl("https://example.com/", { NODE_ENV: "production" });
  assert.equal(ok.ok, true);
});

test("allowlist overrides hostname heuristic", () => {
  const res = validateOutboundUrl("http://localhost:8080/hook", { FORGE_OUTBOUND_ALLOWLIST: "localhost" });
  assert.equal(res.ok, true);
});

test("public URLs pass", () => {
  const res = validateOutboundUrl("https://api.example.com/path?x=1");
  assert.equal(res.ok, true);
  assert.equal(res.url.hostname, "api.example.com");
});
