// FORGE_ACL_DENY_BY_DEFAULT flips parseAcl's fallback from
// `{ roles: ["*"] }` (permissive) to `{ roles: [] }` (deny). The
// flag is intended to default ON in production / strict mode; we
// exercise the toggle directly here so the test suite doesn't have
// to spawn a strict-mode server.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-acl-deny-"));
process.env.FORGE_DATA_DIR = tmpDir;
process.env.FORGE_TENANT_KEY = "forge-acl-deny-test";
process.env.FORGE_JWT_SECRET = "forge-acl-deny-test-jwt";
process.env.LOG_LEVEL = "warn";

await import("../server/db.js");
const aclModule = await import("../server/acl.js");

const owner = { id: "U-OWN", role: "Organization Owner", abac: {} };
const engineer = { id: "U-ENG", role: "Engineer/Contributor", abac: {} };
const auditor = { id: "U-AUD", role: "Viewer/Auditor", abac: {} };

// `parseAcl` is the seam used by `allows()`.
function withFlag(value, fn) {
  const before = process.env.FORGE_ACL_DENY_BY_DEFAULT;
  if (value == null) delete process.env.FORGE_ACL_DENY_BY_DEFAULT;
  else process.env.FORGE_ACL_DENY_BY_DEFAULT = value;
  try { return fn(); }
  finally {
    if (before == null) delete process.env.FORGE_ACL_DENY_BY_DEFAULT;
    else process.env.FORGE_ACL_DENY_BY_DEFAULT = before;
  }
}

test("default (flag unset, NODE_ENV=test): empty ACL is permissive", () => {
  withFlag(null, () => {
    assert.equal(aclModule.allows(engineer, null, "view"), true, "null ACL admits engineer");
    assert.equal(aclModule.allows(auditor, "{}", "view"), true, "empty-object ACL admits auditor");
  });
});

test("flag on: empty ACL denies non-owners", () => {
  withFlag("1", () => {
    assert.equal(aclModule.allows(engineer, null, "view"), false, "engineer denied under empty ACL");
    assert.equal(aclModule.allows(auditor, "{}", "view"), false, "auditor denied under empty ACL");
    // Organization Owner short-circuits ACL — capability still
    // applies, but the wildcard role grants everything.
    assert.equal(aclModule.allows(owner, null, "view"), true, "owner still bypasses");
  });
});

test("flag on: explicit ACL with roles:['*'] still admits everyone", () => {
  withFlag("1", () => {
    const open = JSON.stringify({ roles: ["*"] });
    assert.equal(aclModule.allows(engineer, open, "view"), true);
    assert.equal(aclModule.allows(auditor, open, "view"), true);
  });
});

test("flag on: explicit per-user ACL grants the listed user only", () => {
  withFlag("1", () => {
    const onlyEng = JSON.stringify({ roles: [], users: ["U-ENG"] });
    assert.equal(aclModule.allows(engineer, onlyEng, "view"), true, "named user admitted");
    assert.equal(aclModule.allows(auditor, onlyEng, "view"), false, "non-named user denied");
  });
});

test("flag on: malformed ACL deserialisation falls through to deny", () => {
  withFlag("1", () => {
    // `parseAcl` falls into the catch branch on bad JSON.
    assert.equal(aclModule.allows(engineer, "this is not json", "view"), false);
  });
});
