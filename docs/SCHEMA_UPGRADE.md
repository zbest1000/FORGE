# FORGE schema upgrade guide

How `migrate()` works, what each `schema_version` brings, how to roll
back if a migration goes sideways, and what to do when
`PRAGMA foreign_key_check` is unhappy.

## Migration model

- Migrations live in `server/db.js`. Each version branch runs once,
  in order, inside a single `db.transaction(...)` block.
- The current target is read from `SCHEMA_VERSION`. Boot calls
  `migrate()` automatically. `node server/db.js --migrate-only`
  runs migrations only and prints the final version.
- A fresh DB walks the full sequence v1 → vN. An upgrade walks
  `current+1` → vN.
- The transaction wraps every branch, so if any branch throws, the
  outer transaction rolls back and `schema_version` stays at the
  previous version.

## Pre-migration snapshot

Before any branch runs, `migrate()` opportunistically copies the
live database to:

```
$FORGE_DATA_DIR/forge.db.bak-<from>-<to>-<timestamp>
```

The copy uses better-sqlite3's online backup API so it is
consistent under concurrent writes. If the migration produces a bad
state, you can roll back by:

1. Stopping the server.
2. Copying the snapshot back over `forge.db`:
   `cp forge.db.bak-<from>-<to>-<ts> forge.db`.
3. Removing any WAL / SHM remnants:
   `rm -f forge.db-wal forge.db-shm`.
4. Restarting the older FORGE binary.

The snapshot is best-effort — a full disk, read-only mount, or
permissions error skips it silently. Set
`FORGE_SKIP_MIGRATE_SNAPSHOT=1` to disable explicitly.

## Integrity check CLI

```
node server/db.js --integrity
```

Runs `PRAGMA foreign_key_check` against the current data dir and
prints any orphan rows. Exit code 0 means clean; exit code 1 means
orphans were found, with one line per offending row.

Use this:

- **Before** upgrading a populated DB to a version that introduces
  FKs (v12). The migration will refuse to apply if orphans exist;
  this CLI tells you what to clean up.
- **As a sanity check** in CI/CD against a database snapshot pulled
  from production.

## Per-version notes

### v1 — core tables

Originals: organizations, workspaces, users, team_spaces, projects,
channels, messages, documents, revisions, drawings, markups, assets,
work_items, incidents, approvals, files, comments, transmittals,
subscriptions, notifications, audit_log, integrations,
data_sources, events, dead_letters, saved_searches,
retention_policies, ai_log.

Only `users.org_id` and `workspaces.org_id` declare FKs. The rest
have implicit references that v12 will tighten.

### v2 — FTS5 virtual tables

`fts_docs`, `fts_messages`, `fts_workitems`, `fts_assets`. FTS5
contentless tables — populated by `npm run seed` and incremental
write paths in the routes.

### v3 — API tokens, webhooks, MFA

`api_tokens`, `webhooks`, `user_mfa`. The MFA table sat unused
until v8 sessions and the E4 MFA work landed.

### v4 — review cycles, forms, commissioning

`review_cycles`, `form_submissions`, `commissioning_checklists`,
`rfi_links`, `webhook_deliveries`, `search_alerts`,
`metrics_daily`, `model_pins`, `drawing_uploads`.

### v5 — outbox / inbox

`outbox_events`, `inbox_events`. Backs the transactional outbox
pattern in `server/outbox.js`.

### v6 — enterprise systems registry

`enterprise_systems`, `connector_runs`, `connector_mappings`,
`external_object_links`, `processing_activities`,
`data_subject_requests`, `legal_holds`, `compliance_evidence`,
`subprocessors`, `risk_register`, `ai_system_inventory`,
`regulatory_incidents`.

### v7 — ALTER + table re-creation for enterprise systems

Adds columns to enterprise_systems / connector_runs /
connector_mappings / external_object_links and re-creates the same
tables with the final shape. Idempotent: `addColumn` swallows
"duplicate column" errors.

### v8 — sessions

Adds `sessions` for refresh-token rotation, JWT jti pinning, and
sign-out-everywhere. Backed `auth.refresh` and the Devices /
Sessions admin screen.

### v9 — webhook delivery payloads

`webhook_delivery_payloads`. Earlier versions read the body back
from `audit_log` JSON, which polluted the chain. v9 isolates
delivery bodies in their own table with `ON DELETE CASCADE`.

### v10 — idempotency keys

`idempotency_keys`. Implements the Idempotency-Key contract for
write APIs (RFC draft-ietf-httpapi-idempotency-key).

### v11 — audit_log.org_id

Adds a nullable `org_id` column on `audit_log` and a backfill UPDATE
that joins through `users.id = audit_log.actor`. System rows (actor
= `system` / `webhooks` / `retention`) stay `NULL` and are visible
to every tenant. The hash chain is unchanged: `org_id` is metadata
and is not part of the canonicalised payload, so historic rows keep
verifying after the bump.

### v12 — foreign keys with ON DELETE policies

This is the most invasive migration. SQLite cannot ALTER an
existing table to add FKs, so each child table is rebuilt:

```
PRAGMA foreign_keys = OFF;
CREATE TABLE foo_new (... REFERENCES parent(id) ON DELETE CASCADE);
INSERT INTO foo_new SELECT ... FROM foo;
DROP TABLE foo;
ALTER TABLE foo_new RENAME TO foo;
PRAGMA foreign_keys = ON;
```

Tables touched: team_spaces, projects, channels, messages,
documents, revisions, drawings, markups, assets, work_items,
incidents, webhook_deliveries.

Policies:

- **CASCADE** for ownership chains
  (org → workspace → team_space → project / channel / document;
   document → revision / drawing; project → work_item;
   channel → message; webhook → delivery; drawing → markup).
- **SET NULL** for soft refs (incident.commander_id,
  incident.asset_id, incident.channel_id, work_items.assignee_id,
  documents.project_id, drawings.project_id).
- **untyped** for polymorphic refs (approvals.subject_id,
  files.parent_id, audit_log.subject).

After every rebuild, the migration runs `PRAGMA
foreign_key_check`. If any orphan row remains, it throws — the
outer migrate() transaction rolls back and `schema_version` stays
at v11. Resolve by:

1. Run `node server/db.js --integrity` to print the offending
   rows.
2. For each one, decide: was the parent meant to exist? If so,
   re-insert the parent. Otherwise delete the orphan.
3. Re-run `node server/db.js --migrate-only`.

## Upgrade SOP for production

1. Stop the server gracefully (`SIGTERM`).
2. Take a full backup outside the SQLite process:
   ```bash
   sqlite3 ./data/forge.db ".backup ./data/forge.db.pre-upgrade-$(date +%s)"
   ```
3. Run the migration in dry-run mode:
   ```bash
   FORGE_DATA_DIR=./data node server/db.js --migrate-only
   ```
   Inspect the output for warnings.
4. Run `node server/db.js --integrity` to confirm no orphans.
5. Start the new binary. Tail `pino` logs for any
   `migrate failed` line.

## Known sharp edges

- v7 silently re-creates tables that already exist with different
  columns. Verified safe via the same INSERT … SELECT pattern, but
  if you see a column that didn't survive, restore the snapshot.
- Future-version downgrades are not supported. SQLite has no
  built-in migration framework with reversible ops; we rely on the
  pre-migrate snapshot for rollback.
- The migration uses one outer transaction. Long migrations on
  large DBs can hold the WAL open for minutes — schedule during a
  maintenance window.
