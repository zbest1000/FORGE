// DSAR exports must redact third-party PII while preserving the
// subject's own data. Audit-log `actor` ids and `detail` references
// to other users get masked; other users' messages are not included
// even when they mention the subject.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-dsar-"));
process.env.FORGE_DATA_DIR = tmpDir;
process.env.FORGE_TENANT_KEY = "forge-dsar-test";
process.env.FORGE_JWT_SECRET = "forge-dsar-test-jwt";
process.env.LOG_LEVEL = "warn";

const { db } = await import("../server/db.js");
const { audit, drain } = await import("../server/audit.js");
const { exportDsarBundle, createDsar } = await import("../server/compliance.js");

const now = new Date().toISOString();
db.prepare("INSERT INTO organizations (id, name, tenant_key, created_at) VALUES ('ORG-1','x','xx',?)").run(now);
db.prepare("INSERT INTO workspaces (id, org_id, name, region, created_at) VALUES ('WS-1','ORG-1','x','us',?)").run(now);
db.prepare("INSERT INTO users (id, org_id, email, name, role, password_hash, initials, disabled, created_at, updated_at) VALUES ('U-SUBJ','ORG-1','subj@x','Subj','Engineer/Contributor',NULL,'SU',0,?,?)").run(now, now);
db.prepare("INSERT INTO users (id, org_id, email, name, role, password_hash, initials, disabled, created_at, updated_at) VALUES ('U-OTHER','ORG-1','oth@x','Other','Engineer/Contributor',NULL,'OT',0,?,?)").run(now, now);
db.prepare("INSERT INTO team_spaces (id, org_id, workspace_id, name, summary, status, acl, labels, created_at, updated_at) VALUES ('TS-1','ORG-1','WS-1','t','','active','{}','[]',?,?)").run(now, now);
db.prepare("INSERT INTO channels (id, team_space_id, name, kind, acl, created_at, updated_at) VALUES ('CH-1','TS-1','g','team','{}',?,?)").run(now, now);
db.prepare("INSERT INTO messages (id, channel_id, author_id, ts, type, text, attachments, edits, deleted) VALUES ('M-MINE','CH-1','U-SUBJ',?, 'discussion','my message','[]','[]',0)").run(now);
// A message authored by someone else, mentioning the subject — must NOT appear in the bundle.
db.prepare("INSERT INTO messages (id, channel_id, author_id, ts, type, text, attachments, edits, deleted) VALUES ('M-OTHER','CH-1','U-OTHER',?, 'discussion','about U-SUBJ secret','[]','[]',0)").run(now);

// Audit entries:
//   - subject acted on themselves (kept verbatim)
//   - admin acted on subject (admin actor must be masked)
audit({ actor: "U-SUBJ", action: "user.profile.update", subject: "U-SUBJ", detail: { fields: ["name"] } });
audit({ actor: "U-OTHER", action: "user.role.assign", subject: "U-SUBJ", detail: { reviewerId: "U-OTHER" } });
await drain();

test("DSAR bundle masks third-party actors and details", () => {
  const dsar = createDsar({ subjectUserId: "U-SUBJ", requesterId: "U-SUBJ" });
  const bundle = exportDsarBundle(dsar.id, "U-SUBJ");
  assert.ok(bundle, "bundle should be produced");
  assert.equal(bundle.subject?.id, "U-SUBJ");

  // Subject's own message is included.
  const ownMessages = bundle.records.messages.map((m) => m.id);
  assert.ok(ownMessages.includes("M-MINE"), "subject's own message must be in bundle");

  // Other user's message is NOT included even when it mentions the subject.
  assert.ok(!ownMessages.includes("M-OTHER"), "other user's message must not be in bundle");

  // Audit log: subject's self-edit keeps actor=U-SUBJ.
  const ownEdit = bundle.records.auditEvents.find((e) => e.action === "user.profile.update");
  assert.equal(ownEdit?.actor, "U-SUBJ");

  // Admin edit on subject: actor is masked.
  const adminEdit = bundle.records.auditEvents.find((e) => e.action === "user.role.assign");
  assert.ok(adminEdit, "expected admin edit row");
  assert.match(adminEdit.actor, /^REDACTED:[a-f0-9]{12}$/, "admin actor must be masked");
  // The detail body referenced U-OTHER as `reviewerId` — that should
  // also be redacted.
  assert.match(adminEdit.detail.reviewerId, /^REDACTED:[a-f0-9]{12}$/);

  // Bundle includes redaction summary.
  assert.ok(bundle.redactions);
  assert.ok(bundle.redactions.users >= 1, `expected at least one user mask, got ${bundle.redactions.users}`);
  assert.equal(bundle.redactions.policy, "third_party_user_ids_masked");
});
