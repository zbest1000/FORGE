// Verify that the v12 migration installs declared foreign keys with
// appropriate ON DELETE policies, and that PRAGMA foreign_key_check
// finds no orphans on a freshly-migrated DB.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-fk-"));
process.env.FORGE_DATA_DIR = tmpDir;
process.env.FORGE_TENANT_KEY = "forge-fk-test";
process.env.FORGE_JWT_SECRET = "forge-fk-test-jwt";
process.env.LOG_LEVEL = "warn";

const { db } = await import("../server/db.js");

test("schema_version reaches 14", () => {
  const v = Number(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value);
  assert.ok(v >= 14, `expected schema_version >= 14, got ${v}`);
});

test("v14 FK sweep installs declared FKs on auxiliary child tables", () => {
  const expectations = {
    files:                { col: "created_by", on_delete: "SET NULL" },
    transmittals:         { col: "doc_id",     on_delete: "CASCADE" },
    comments:             { col: "rev_id",     on_delete: "CASCADE" },
    subscriptions:        { col: "user_id",    on_delete: "CASCADE" },
    notifications:        { col: "user_id",    on_delete: "CASCADE" },
    connector_runs:       { col: "system_id",  on_delete: "CASCADE" },
    connector_mappings:   { col: "system_id",  on_delete: "CASCADE" },
    external_object_links:{ col: "system_id",  on_delete: "CASCADE" },
  };
  for (const [table, want] of Object.entries(expectations)) {
    const fks = db.pragma(`foreign_key_list(${table})`, { simple: false });
    const fk = fks.find((r) => r.from === want.col);
    assert.ok(fk, `${table}.${want.col} missing FK after v14`);
    assert.equal(fk.on_delete, want.on_delete, `${table}.${want.col} ON DELETE policy mismatch`);
  }
});

test("foreign_key_check passes on a freshly-migrated DB", () => {
  db.pragma("foreign_keys = ON");
  const orphans = db.pragma("foreign_key_check", { simple: false });
  assert.equal(orphans.length, 0, `unexpected orphans: ${JSON.stringify(orphans)}`);
});

test("declared FKs include team_spaces.org_id and work_items.project_id", () => {
  const tsFks = db.pragma("foreign_key_list(team_spaces)", { simple: false });
  const orgFk = tsFks.find((r) => r.from === "org_id");
  assert.ok(orgFk, "team_spaces.org_id missing FK");
  assert.equal(orgFk.on_delete, "CASCADE");

  const wiFks = db.pragma("foreign_key_list(work_items)", { simple: false });
  const projFk = wiFks.find((r) => r.from === "project_id");
  assert.ok(projFk, "work_items.project_id missing FK");
  assert.equal(projFk.on_delete, "CASCADE");
  const assigneeFk = wiFks.find((r) => r.from === "assignee_id");
  assert.ok(assigneeFk, "work_items.assignee_id missing FK");
  assert.equal(assigneeFk.on_delete, "SET NULL");
});

test("DELETE on organizations cascades through the ownership chain", () => {
  db.pragma("foreign_keys = ON");
  const ts = new Date().toISOString();
  // Build a small ownership tree.
  db.exec(`
    INSERT INTO organizations (id, name, tenant_key, created_at) VALUES ('ORG-FK', 'fk', 'fk', '${ts}');
    INSERT INTO workspaces (id, org_id, name, region, created_at) VALUES ('WS-FK', 'ORG-FK', 'fk', 'us', '${ts}');
    INSERT INTO team_spaces (id, org_id, workspace_id, name, status, acl, labels, created_at, updated_at)
      VALUES ('TS-FK', 'ORG-FK', 'WS-FK', 'fk', 'active', '{}', '[]', '${ts}', '${ts}');
    INSERT INTO projects (id, team_space_id, name, status, milestones, acl, labels, created_at, updated_at)
      VALUES ('PRJ-FK', 'TS-FK', 'fk', 'active', '[]', '{}', '[]', '${ts}', '${ts}');
    INSERT INTO work_items (id, project_id, type, title, status, severity, blockers, labels, acl, created_at, updated_at)
      VALUES ('WI-FK', 'PRJ-FK', 'Task', 'fk', 'Open', 'medium', '[]', '[]', '{}', '${ts}', '${ts}');
  `);
  db.prepare("DELETE FROM organizations WHERE id = 'ORG-FK'").run();
  // Cascade should have wiped every descendant.
  const counts = {
    workspaces: db.prepare("SELECT COUNT(*) AS n FROM workspaces WHERE org_id = 'ORG-FK'").get().n,
    team_spaces: db.prepare("SELECT COUNT(*) AS n FROM team_spaces WHERE org_id = 'ORG-FK'").get().n,
    projects: db.prepare("SELECT COUNT(*) AS n FROM projects WHERE id = 'PRJ-FK'").get().n,
    work_items: db.prepare("SELECT COUNT(*) AS n FROM work_items WHERE id = 'WI-FK'").get().n,
  };
  assert.deepEqual(counts, { workspaces: 0, team_spaces: 0, projects: 0, work_items: 0 });
});

test("DELETE on a referenced user nulls work_items.assignee_id (SET NULL)", () => {
  db.pragma("foreign_keys = ON");
  const ts = new Date().toISOString();
  db.exec(`
    INSERT INTO organizations (id, name, tenant_key, created_at) VALUES ('ORG-NULL', 'n', 'null', '${ts}');
    INSERT INTO workspaces (id, org_id, name, region, created_at) VALUES ('WS-NULL', 'ORG-NULL', 'n', 'us', '${ts}');
    INSERT INTO users (id, org_id, email, name, role, password_hash, initials, disabled, created_at, updated_at)
      VALUES ('U-NULL', 'ORG-NULL', 'u@null.test', 'NullU', 'Engineer/Contributor', NULL, 'NU', 0, '${ts}', '${ts}');
    INSERT INTO team_spaces (id, org_id, workspace_id, name, status, acl, labels, created_at, updated_at)
      VALUES ('TS-NULL', 'ORG-NULL', 'WS-NULL', 'n', 'active', '{}', '[]', '${ts}', '${ts}');
    INSERT INTO projects (id, team_space_id, name, status, milestones, acl, labels, created_at, updated_at)
      VALUES ('PRJ-NULL', 'TS-NULL', 'n', 'active', '[]', '{}', '[]', '${ts}', '${ts}');
    INSERT INTO work_items (id, project_id, type, title, assignee_id, status, severity, blockers, labels, acl, created_at, updated_at)
      VALUES ('WI-NULL', 'PRJ-NULL', 'Task', 'n', 'U-NULL', 'Open', 'medium', '[]', '[]', '{}', '${ts}', '${ts}');
  `);
  db.prepare("DELETE FROM users WHERE id = 'U-NULL'").run();
  const wi = db.prepare("SELECT assignee_id FROM work_items WHERE id = 'WI-NULL'").get();
  assert.equal(wi.assignee_id, null, "assignee_id should be NULL after referenced user is deleted");
});
