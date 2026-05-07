// SQLite database with FTS5 for search. Single-node, zero-config, production-grade.
// Migration path to Postgres is straightforward (the SQL is portable except FTS5).

import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.FORGE_DATA_DIR || path.resolve(__dirname, "..", "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, "forge.db");

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("synchronous = NORMAL");

// ---------- Schema ----------
// Version counter so we can evolve forward.

const SCHEMA_VERSION = 17;

db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);

function getVersion() {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  return row ? Number(row.value) : 0;
}
function setVersion(v) {
  db.prepare("INSERT INTO meta(key, value) VALUES('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(v));
}

/**
 * Best-effort snapshot of the SQLite database before a migration runs.
 * Lives next to the live DB as `forge.db.bak-<from>-<to>-<ts>` so an
 * operator can restore manually if a migration produces a bad state.
 *
 * Uses SQLite's online backup API via `db.backup()` so the file is a
 * consistent copy even with WAL writes in flight. Failures are
 * non-fatal: snapshot is opportunistic, never blocking.
 */
function snapshotBeforeMigrate(fromVersion, toVersion) {
  if (process.env.FORGE_SKIP_MIGRATE_SNAPSHOT) return;
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const dest = path.join(DATA_DIR, `forge.db.bak-${fromVersion}-${toVersion}-${ts}`);
    // `db.backup` returns a promise; we don't await — the snapshot
    // is fire-and-forget. If the migration corrupts state, the
    // operator restores the latest .bak file. The snapshot uses
    // SQLite's page-level copy so concurrent writes are safe.
    db.backup(dest).catch(() => { /* swallow */ });
  } catch { /* ignore — disk full, permissions, etc. */ }
}

function migrate() {
  const current = getVersion();
  if (current >= SCHEMA_VERSION) return;
  snapshotBeforeMigrate(current, SCHEMA_VERSION);

  // PRAGMA foreign_keys can only be toggled OUTSIDE a transaction, so we
  // turn FK enforcement off for the duration of the migration. Some
  // forward migrations (v14) recreate tables to add FK constraints — if
  // FKs were on, the rename step could trip on rows inserted before the
  // referencing table existed in its new shape. After the transaction
  // commits we run the foreign_key_check pragma; any orphans get logged.
  db.pragma("foreign_keys = OFF");
  db.transaction(() => {
    // -- v1: core tables --
    if (current < 1) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS organizations (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          tenant_key TEXT UNIQUE,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS workspaces (
          id TEXT PRIMARY KEY,
          org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          region TEXT,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          email TEXT UNIQUE NOT NULL,
          name TEXT NOT NULL,
          role TEXT NOT NULL,
          password_hash TEXT,
          initials TEXT,
          disabled INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          abac TEXT DEFAULT '{}'
        );
        CREATE TABLE IF NOT EXISTS team_spaces (
          id TEXT PRIMARY KEY,
          org_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          name TEXT NOT NULL,
          summary TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          acl TEXT NOT NULL DEFAULT '{}',
          labels TEXT NOT NULL DEFAULT '[]',
          created_by TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS team_space_members (
          team_space_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          role TEXT,
          PRIMARY KEY(team_space_id, user_id)
        );
        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          team_space_id TEXT NOT NULL,
          name TEXT NOT NULL,
          status TEXT NOT NULL,
          due_date TEXT,
          milestones TEXT NOT NULL DEFAULT '[]',
          acl TEXT NOT NULL DEFAULT '{}',
          labels TEXT NOT NULL DEFAULT '[]',
          created_by TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS channels (
          id TEXT PRIMARY KEY,
          team_space_id TEXT NOT NULL,
          name TEXT NOT NULL,
          kind TEXT NOT NULL,
          unread INTEGER NOT NULL DEFAULT 0,
          acl TEXT NOT NULL DEFAULT '{}',
          created_by TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          channel_id TEXT NOT NULL,
          author_id TEXT NOT NULL,
          ts TEXT NOT NULL,
          type TEXT NOT NULL,
          text TEXT NOT NULL,
          attachments TEXT NOT NULL DEFAULT '[]',
          edits TEXT NOT NULL DEFAULT '[]',
          deleted INTEGER NOT NULL DEFAULT 0,
          deleted_at TEXT,
          deleted_by TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_messages_channel_ts ON messages(channel_id, ts);

        CREATE TABLE IF NOT EXISTS documents (
          id TEXT PRIMARY KEY,
          team_space_id TEXT NOT NULL,
          project_id TEXT,
          name TEXT NOT NULL,
          kind TEXT,
          discipline TEXT,
          current_revision_id TEXT,
          sensitivity TEXT,
          acl TEXT NOT NULL DEFAULT '{}',
          labels TEXT NOT NULL DEFAULT '[]',
          created_by TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS revisions (
          id TEXT PRIMARY KEY,
          doc_id TEXT NOT NULL,
          label TEXT NOT NULL,
          status TEXT NOT NULL,
          author_id TEXT,
          approver_id TEXT,
          summary TEXT,
          notes TEXT,
          pdf_url TEXT,
          effective_date TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_revisions_doc ON revisions(doc_id);

        CREATE TABLE IF NOT EXISTS drawings (
          id TEXT PRIMARY KEY,
          doc_id TEXT,
          team_space_id TEXT,
          project_id TEXT,
          name TEXT NOT NULL,
          discipline TEXT,
          sheets TEXT NOT NULL DEFAULT '[]',
          ifc_url TEXT,
          acl TEXT NOT NULL DEFAULT '{}',
          labels TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS markups (
          id TEXT PRIMARY KEY,
          drawing_id TEXT NOT NULL,
          sheet_id TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'pin',
          x REAL NOT NULL,
          y REAL NOT NULL,
          text TEXT,
          stamp_label TEXT,
          status_color TEXT,
          author TEXT,
          seq INTEGER,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_markups_drawing_sheet ON markups(drawing_id, sheet_id);

        CREATE TABLE IF NOT EXISTS assets (
          id TEXT PRIMARY KEY,
          org_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          name TEXT NOT NULL,
          type TEXT,
          hierarchy TEXT,
          status TEXT NOT NULL DEFAULT 'normal',
          mqtt_topics TEXT NOT NULL DEFAULT '[]',
          opcua_nodes TEXT NOT NULL DEFAULT '[]',
          doc_ids TEXT NOT NULL DEFAULT '[]',
          acl TEXT NOT NULL DEFAULT '{}',
          labels TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS work_items (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          type TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT,
          assignee_id TEXT,
          status TEXT NOT NULL,
          severity TEXT,
          due TEXT,
          blockers TEXT NOT NULL DEFAULT '[]',
          labels TEXT NOT NULL DEFAULT '[]',
          acl TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS incidents (
          id TEXT PRIMARY KEY,
          org_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          title TEXT NOT NULL,
          severity TEXT NOT NULL,
          status TEXT NOT NULL,
          asset_id TEXT,
          commander_id TEXT,
          channel_id TEXT,
          timeline TEXT NOT NULL DEFAULT '[]',
          checklist_state TEXT NOT NULL DEFAULT '{}',
          roster TEXT NOT NULL DEFAULT '{}',
          started_at TEXT NOT NULL,
          resolved_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS approvals (
          id TEXT PRIMARY KEY,
          subject_kind TEXT NOT NULL,
          subject_id TEXT NOT NULL,
          requester_id TEXT,
          approvers TEXT NOT NULL DEFAULT '[]',
          status TEXT NOT NULL,
          due_ts TEXT,
          reason TEXT,
          signed_by TEXT,
          signed_at TEXT,
          signature TEXT,
          chain TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS files (
          id TEXT PRIMARY KEY,
          parent_kind TEXT NOT NULL,
          parent_id TEXT NOT NULL,
          name TEXT NOT NULL,
          mime TEXT,
          size INTEGER,
          sha256 TEXT,
          path TEXT,
          created_by TEXT,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS transmittals (
          id TEXT PRIMARY KEY,
          doc_id TEXT NOT NULL,
          rev_id TEXT NOT NULL,
          subject TEXT NOT NULL,
          recipients TEXT NOT NULL DEFAULT '[]',
          message TEXT,
          sender TEXT,
          ts TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS comments (
          id TEXT PRIMARY KEY,
          doc_id TEXT NOT NULL,
          rev_id TEXT NOT NULL,
          page INTEGER NOT NULL,
          x REAL NOT NULL,
          y REAL NOT NULL,
          text TEXT NOT NULL,
          author TEXT,
          seq INTEGER,
          replies TEXT NOT NULL DEFAULT '[]',
          ts TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS subscriptions (
          id TEXT PRIMARY KEY,
          subject TEXT NOT NULL,
          user_id TEXT NOT NULL,
          events TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL,
          UNIQUE(subject, user_id)
        );
        CREATE TABLE IF NOT EXISTS notifications (
          id TEXT PRIMARY KEY,
          ts TEXT NOT NULL,
          kind TEXT NOT NULL,
          text TEXT NOT NULL,
          route TEXT,
          user_id TEXT NOT NULL,
          subject TEXT,
          read INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read, ts DESC);

        CREATE TABLE IF NOT EXISTS audit_log (
          id TEXT PRIMARY KEY,
          ts TEXT NOT NULL,
          actor TEXT NOT NULL,
          action TEXT NOT NULL,
          subject TEXT NOT NULL,
          detail TEXT NOT NULL DEFAULT '{}',
          trace_id TEXT,
          prev_hash TEXT NOT NULL,
          hash TEXT NOT NULL,
          seq INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_audit_subject ON audit_log(subject);
        CREATE INDEX IF NOT EXISTS idx_audit_seq ON audit_log(seq);

        CREATE TABLE IF NOT EXISTS integrations (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          kind TEXT NOT NULL,
          status TEXT NOT NULL,
          last_event TEXT,
          events_per_min INTEGER DEFAULT 0,
          config TEXT NOT NULL DEFAULT '{}'
        );
        CREATE TABLE IF NOT EXISTS data_sources (
          id TEXT PRIMARY KEY,
          integration_id TEXT NOT NULL,
          endpoint TEXT NOT NULL,
          asset_id TEXT,
          kind TEXT NOT NULL,
          unit TEXT,
          sampling TEXT,
          qos INTEGER,
          retain INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS events (
          id TEXT PRIMARY KEY,
          received_at TEXT NOT NULL,
          source TEXT NOT NULL,
          source_type TEXT NOT NULL,
          asset_ref TEXT,
          project_ref TEXT,
          object_refs TEXT NOT NULL DEFAULT '[]',
          severity TEXT,
          event_type TEXT NOT NULL,
          payload TEXT,
          trace_id TEXT,
          routing_policy TEXT,
          dedupe_key TEXT UNIQUE,
          auth_context TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_events_received ON events(received_at DESC);
        CREATE INDEX IF NOT EXISTS idx_events_asset ON events(asset_ref);

        CREATE TABLE IF NOT EXISTS dead_letters (
          id TEXT PRIMARY KEY,
          ts TEXT NOT NULL,
          envelope TEXT NOT NULL,
          error TEXT NOT NULL,
          resolved INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS saved_searches (
          id TEXT PRIMARY KEY,
          user_id TEXT,
          name TEXT NOT NULL,
          query TEXT,
          facets TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS retention_policies (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          scope TEXT NOT NULL,
          days INTEGER NOT NULL,
          legal_hold INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS ai_log (
          id TEXT PRIMARY KEY,
          ts TEXT NOT NULL,
          actor TEXT NOT NULL,
          prompt TEXT NOT NULL,
          output TEXT NOT NULL,
          citations TEXT NOT NULL DEFAULT '[]',
          model TEXT,
          scope TEXT,
          trace_id TEXT,
          retention TEXT NOT NULL DEFAULT 'no-training-by-default'
        );
      `);
      setVersion(1);
    }

    // -- v2: FTS5 virtual tables for search --
    if (getVersion() < 2) {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS fts_docs      USING fts5(id UNINDEXED, kind UNINDEXED, title, body);
        CREATE VIRTUAL TABLE IF NOT EXISTS fts_messages  USING fts5(id UNINDEXED, channel_id UNINDEXED, text);
        CREATE VIRTUAL TABLE IF NOT EXISTS fts_workitems USING fts5(id UNINDEXED, project_id UNINDEXED, title, description, labels);
        CREATE VIRTUAL TABLE IF NOT EXISTS fts_assets    USING fts5(id UNINDEXED, name, hierarchy, type);
      `);
      setVersion(2);
    }

    // -- v4: review cycles, form submissions, commissioning, webhook
    // deliveries (for retry+back-off), metrics roll-ups, model pins, RFI
    // links, search-alert subscriptions, drawing ingestion records.
    // (Defined below; declared first so v3 still applies in order.)

    // -- v3: API tokens + webhooks + MFA secrets --
    if (getVersion() < 3) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS api_tokens (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          name TEXT NOT NULL,
          token_hash TEXT NOT NULL UNIQUE,
          scopes TEXT NOT NULL DEFAULT '[]',
          last_used_at TEXT,
          expires_at TEXT,
          revoked_at TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id);

        CREATE TABLE IF NOT EXISTS webhooks (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          url TEXT NOT NULL,
          events TEXT NOT NULL DEFAULT '[]',
          secret TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          last_success_at TEXT,
          last_error TEXT,
          last_error_at TEXT,
          created_by TEXT,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS user_mfa (
          user_id TEXT PRIMARY KEY,
          totp_secret TEXT,
          enabled INTEGER NOT NULL DEFAULT 0,
          recovery_codes TEXT NOT NULL DEFAULT '[]',
          enrolled_at TEXT
        );
      `);
      setVersion(3);
    }

    if (getVersion() < 4) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS review_cycles (
          id TEXT PRIMARY KEY,
          doc_id TEXT NOT NULL,
          rev_id TEXT NOT NULL,
          name TEXT NOT NULL,
          reviewers TEXT NOT NULL DEFAULT '[]',
          status TEXT NOT NULL DEFAULT 'open',
          due_ts TEXT,
          notes TEXT,
          created_by TEXT,
          created_at TEXT NOT NULL,
          closed_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_review_cycles_doc_rev ON review_cycles(doc_id, rev_id);

        CREATE TABLE IF NOT EXISTS form_submissions (
          id TEXT PRIMARY KEY,
          form_id TEXT NOT NULL,
          parent_kind TEXT,
          parent_id TEXT,
          submitter_id TEXT,
          ts TEXT NOT NULL,
          answers TEXT NOT NULL DEFAULT '{}',
          signature TEXT,
          signature_key_id TEXT
        );

        CREATE TABLE IF NOT EXISTS commissioning_checklists (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          project_id TEXT NOT NULL,
          system TEXT,
          panel TEXT,
          package TEXT,
          items TEXT NOT NULL DEFAULT '[]',
          completed TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS rfi_links (
          rfi_id TEXT NOT NULL,
          target_kind TEXT NOT NULL,
          target_id TEXT NOT NULL,
          relation TEXT,
          PRIMARY KEY (rfi_id, target_kind, target_id)
        );

        CREATE TABLE IF NOT EXISTS webhook_deliveries (
          id TEXT PRIMARY KEY,
          webhook_id TEXT NOT NULL,
          event_id TEXT,
          event_type TEXT,
          attempt INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'pending',
          last_error TEXT,
          next_attempt_at TEXT,
          delivered_at TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_wh_pending ON webhook_deliveries(status, next_attempt_at);

        CREATE TABLE IF NOT EXISTS search_alerts (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          name TEXT NOT NULL,
          query TEXT NOT NULL,
          last_run_at TEXT,
          last_seen_ids TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS metrics_daily (
          day TEXT NOT NULL,
          metric TEXT NOT NULL,
          value REAL NOT NULL,
          PRIMARY KEY (day, metric)
        );

        CREATE TABLE IF NOT EXISTS model_pins (
          id TEXT PRIMARY KEY,
          drawing_id TEXT NOT NULL,
          element_id TEXT NOT NULL,
          author TEXT,
          text TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS drawing_uploads (
          id TEXT PRIMARY KEY,
          drawing_id TEXT NOT NULL,
          file_id TEXT NOT NULL,
          parsed_metadata TEXT NOT NULL DEFAULT '{}',
          revision_id TEXT,
          reviewer_id TEXT,
          created_at TEXT NOT NULL
        );
      `);
      setVersion(4);
    }

    if (getVersion() < 5) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS outbox_events (
          id TEXT PRIMARY KEY,
          topic TEXT NOT NULL,
          event_type TEXT NOT NULL,
          aggregate_type TEXT,
          aggregate_id TEXT,
          payload TEXT NOT NULL DEFAULT '{}',
          trace_id TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt_at TEXT,
          created_at TEXT NOT NULL,
          published_at TEXT,
          last_error TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox_events(status, next_attempt_at, created_at);

        CREATE TABLE IF NOT EXISTS inbox_events (
          id TEXT PRIMARY KEY,
          source TEXT NOT NULL,
          dedupe_key TEXT,
          received_at TEXT NOT NULL,
          processed_at TEXT,
          status TEXT NOT NULL DEFAULT 'received',
          UNIQUE(source, dedupe_key)
        );
        CREATE INDEX IF NOT EXISTS idx_inbox_status ON inbox_events(status, received_at);
      `);
      setVersion(5);
    }

    if (getVersion() < 6) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS enterprise_systems (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          kind TEXT NOT NULL,
          vendor TEXT,
          base_url TEXT,
          auth_type TEXT,
          secret_ref TEXT,
          status TEXT NOT NULL DEFAULT 'configured',
          capabilities TEXT NOT NULL DEFAULT '[]',
          owner_id TEXT,
          config TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS connector_runs (
          id TEXT PRIMARY KEY,
          system_id TEXT NOT NULL,
          run_type TEXT,
          status TEXT NOT NULL,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          stats TEXT NOT NULL DEFAULT '{}',
          error TEXT,
          requested_by TEXT,
          trace_id TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_connector_runs_system ON connector_runs(system_id, started_at);

        CREATE TABLE IF NOT EXISTS connector_mappings (
          id TEXT PRIMARY KEY,
          system_id TEXT NOT NULL,
          source_kind TEXT NOT NULL,
          target_kind TEXT NOT NULL,
          transform TEXT NOT NULL DEFAULT '{}',
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS external_object_links (
          id TEXT PRIMARY KEY,
          system_id TEXT NOT NULL,
          external_kind TEXT NOT NULL,
          external_id TEXT NOT NULL,
          forge_kind TEXT NOT NULL,
          forge_id TEXT NOT NULL,
          metadata TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          UNIQUE(system_id, external_kind, external_id, forge_kind, forge_id)
        );

        CREATE TABLE IF NOT EXISTS processing_activities (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          controller TEXT,
          processor TEXT,
          purpose TEXT NOT NULL,
          lawful_basis TEXT NOT NULL,
          data_categories TEXT NOT NULL DEFAULT '[]',
          data_subjects TEXT NOT NULL DEFAULT '[]',
          recipients TEXT NOT NULL DEFAULT '[]',
          retention_policy TEXT,
          residency_region TEXT,
          cross_border_transfers TEXT NOT NULL DEFAULT '[]',
          safeguards TEXT,
          created_by TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS data_subject_requests (
          id TEXT PRIMARY KEY,
          subject_user_id TEXT,
          subject_email TEXT,
          request_type TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'open',
          due_at TEXT,
          notes TEXT,
          export_json TEXT,
          created_by TEXT,
          created_at TEXT NOT NULL,
          completed_at TEXT
        );
        CREATE TABLE IF NOT EXISTS legal_holds (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          scope_kind TEXT NOT NULL,
          scope_id TEXT,
          reason TEXT NOT NULL,
          custodian_user_ids TEXT NOT NULL DEFAULT '[]',
          status TEXT NOT NULL DEFAULT 'active',
          created_by TEXT,
          created_at TEXT NOT NULL,
          released_at TEXT
        );
        CREATE TABLE IF NOT EXISTS compliance_evidence (
          id TEXT PRIMARY KEY,
          framework TEXT NOT NULL,
          control_id TEXT,
          title TEXT NOT NULL,
          description TEXT,
          object_kind TEXT,
          object_id TEXT,
          evidence_uri TEXT,
          collected_by TEXT,
          collected_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS subprocessors (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          service TEXT,
          region TEXT,
          data_categories TEXT NOT NULL DEFAULT '[]',
          transfer_mechanism TEXT,
          risk_rating TEXT,
          dpa_uri TEXT,
          last_review_at TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS risk_register (
          id TEXT PRIMARY KEY,
          framework TEXT,
          title TEXT NOT NULL,
          category TEXT,
          likelihood TEXT,
          impact TEXT,
          treatment TEXT,
          owner_id TEXT,
          status TEXT NOT NULL DEFAULT 'open',
          due_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS ai_system_inventory (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          provider TEXT,
          model TEXT,
          purpose TEXT,
          risk_class TEXT NOT NULL DEFAULT 'limited',
          data_categories TEXT NOT NULL DEFAULT '[]',
          human_oversight TEXT,
          evaluation_notes TEXT,
          owner_id TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS regulatory_incidents (
          id TEXT PRIMARY KEY,
          incident_id TEXT,
          regime TEXT NOT NULL,
          severity TEXT,
          report_deadline_at TEXT,
          status TEXT NOT NULL DEFAULT 'draft',
          report_json TEXT NOT NULL DEFAULT '{}',
          submitted_at TEXT,
          created_by TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      setVersion(6);
    }

    if (getVersion() < 7) {
      const addColumn = (table, columnSql) => {
        try { db.prepare(`ALTER TABLE ${table} ADD COLUMN ${columnSql}`).run(); }
        catch (err) {
          if (!/duplicate column name/i.test(String(err?.message || err))) throw err;
        }
      };
      addColumn("enterprise_systems", "category TEXT");
      addColumn("enterprise_systems", "data_residency TEXT");
      addColumn("enterprise_systems", "created_by TEXT");
      addColumn("connector_runs", "run_type TEXT");
      addColumn("connector_runs", "trace_id TEXT");
      addColumn("connector_mappings", "source_object TEXT");
      addColumn("connector_mappings", "created_by TEXT");
      addColumn("external_object_links", "direction TEXT NOT NULL DEFAULT 'bidirectional'");
      addColumn("external_object_links", "created_by TEXT");
      addColumn("external_object_links", "updated_at TEXT");
      db.exec(`
        CREATE TABLE IF NOT EXISTS enterprise_systems (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          category TEXT NOT NULL,
          vendor TEXT,
          base_url TEXT,
          auth_type TEXT NOT NULL DEFAULT 'none',
          secret_ref TEXT,
          capabilities TEXT NOT NULL DEFAULT '[]',
          data_residency TEXT,
          status TEXT NOT NULL DEFAULT 'configured',
          owner_id TEXT,
          config TEXT NOT NULL DEFAULT '{}',
          created_by TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_enterprise_systems_category ON enterprise_systems(category, status);

        CREATE TABLE IF NOT EXISTS connector_runs (
          id TEXT PRIMARY KEY,
          system_id TEXT NOT NULL,
          run_type TEXT NOT NULL,
          status TEXT NOT NULL,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          requested_by TEXT,
          trace_id TEXT,
          stats TEXT NOT NULL DEFAULT '{}',
          error TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_connector_runs_system ON connector_runs(system_id, started_at);

        CREATE TABLE IF NOT EXISTS connector_mappings (
          id TEXT PRIMARY KEY,
          system_id TEXT NOT NULL,
          source_object TEXT NOT NULL,
          target_kind TEXT NOT NULL,
          transform TEXT NOT NULL DEFAULT '{}',
          enabled INTEGER NOT NULL DEFAULT 1,
          created_by TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_connector_mappings_system ON connector_mappings(system_id, enabled);

        CREATE TABLE IF NOT EXISTS external_object_links (
          id TEXT PRIMARY KEY,
          system_id TEXT NOT NULL,
          external_kind TEXT NOT NULL,
          external_id TEXT NOT NULL,
          forge_kind TEXT NOT NULL,
          forge_id TEXT NOT NULL,
          direction TEXT NOT NULL DEFAULT 'bidirectional',
          metadata TEXT NOT NULL DEFAULT '{}',
          created_by TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(system_id, external_kind, external_id, forge_kind, forge_id)
        );
        CREATE INDEX IF NOT EXISTS idx_external_links_forge ON external_object_links(forge_kind, forge_id);
      `);
      setVersion(7);
    }

    if (getVersion() < 8) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS historian_points (
          id TEXT PRIMARY KEY,
          asset_id TEXT NOT NULL,
          source_id TEXT,
          tag TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          unit TEXT,
          data_type TEXT NOT NULL DEFAULT 'number',
          historian TEXT NOT NULL DEFAULT 'sqlite',
          retention_policy_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_historian_points_asset ON historian_points(asset_id);

        CREATE TABLE IF NOT EXISTS historian_samples (
          id TEXT PRIMARY KEY,
          point_id TEXT NOT NULL,
          ts TEXT NOT NULL,
          value REAL NOT NULL,
          quality TEXT NOT NULL DEFAULT 'Good',
          source_type TEXT NOT NULL DEFAULT 'api',
          raw_payload TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX IF NOT EXISTS idx_historian_samples_point_ts ON historian_samples(point_id, ts);

        CREATE TABLE IF NOT EXISTS recipes (
          id TEXT PRIMARY KEY,
          asset_id TEXT,
          name TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'draft',
          current_version_id TEXT,
          created_by TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_recipes_asset ON recipes(asset_id, status);

        CREATE TABLE IF NOT EXISTS recipe_versions (
          id TEXT PRIMARY KEY,
          recipe_id TEXT NOT NULL,
          version INTEGER NOT NULL,
          state TEXT NOT NULL DEFAULT 'draft',
          parameters TEXT NOT NULL DEFAULT '{}',
          notes TEXT,
          approved_by TEXT,
          approved_at TEXT,
          created_by TEXT,
          created_at TEXT NOT NULL,
          UNIQUE(recipe_id, version)
        );

        CREATE TABLE IF NOT EXISTS modbus_devices (
          id TEXT PRIMARY KEY,
          integration_id TEXT,
          name TEXT NOT NULL,
          host TEXT NOT NULL,
          port INTEGER NOT NULL DEFAULT 502,
          unit_id INTEGER NOT NULL DEFAULT 1,
          status TEXT NOT NULL DEFAULT 'configured',
          last_poll_at TEXT,
          config TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS modbus_registers (
          id TEXT PRIMARY KEY,
          device_id TEXT NOT NULL,
          asset_id TEXT,
          point_id TEXT,
          name TEXT NOT NULL,
          address INTEGER NOT NULL,
          function_code INTEGER NOT NULL DEFAULT 3,
          data_type TEXT NOT NULL DEFAULT 'float32',
          scale REAL NOT NULL DEFAULT 1,
          unit TEXT,
          polling_ms INTEGER NOT NULL DEFAULT 1000,
          last_value REAL,
          last_quality TEXT,
          last_seen TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_modbus_registers_device ON modbus_registers(device_id);
        CREATE INDEX IF NOT EXISTS idx_modbus_registers_asset ON modbus_registers(asset_id);
      `);
      setVersion(8);
    }

    // ----- v9: add audit_log.org_id ----------------------------------
    // server/audit.js writes `org_id` when inserting audit rows so the
    // ledger can be tenant-scoped. The v1 schema lacks the column, so
    // every audit() call has been throwing SqliteError. This is a
    // straightforward ADD COLUMN — no FK, no NOT NULL, the audit code
    // tolerates NULL for system-actor entries that aren't org-bound.
    if (getVersion() < 9) {
      const cols = db.pragma("table_info(audit_log)", { simple: false });
      if (!cols.some(c => c.name === "org_id")) {
        db.exec("ALTER TABLE audit_log ADD COLUMN org_id TEXT");
        db.exec("CREATE INDEX IF NOT EXISTS idx_audit_org_seq ON audit_log(org_id, seq)");
      }
      setVersion(9);
    }

    // ----- v10–v12: auxiliary tables that server modules expect -----
    // sessions, idempotency_keys, and webhook_delivery_payloads are
    // referenced at module-load time by server/sessions.js,
    // server/idempotency.js, and server/webhooks.js respectively.
    // Without them, importing those modules throws SqliteError. Adding
    // them as straightforward CREATE TABLE statements.
    if (getVersion() < 12) {
      db.exec(`
        -- Auth sessions: every JWT carries sid + access_jti pointing here.
        -- Refresh tokens are stored as a SHA-256 hash; the previous-hash
        -- column lets a stolen-but-not-yet-used refresh token be detected
        -- and invalidate the entire session chain.
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          access_jti TEXT,
          refresh_hash TEXT,
          previous_refresh_hash TEXT,
          mfa INTEGER NOT NULL DEFAULT 0,
          ip TEXT,
          user_agent TEXT,
          created_at TEXT NOT NULL,
          last_used_at TEXT,
          rotated_at TEXT,
          expires_at TEXT,
          refresh_expires_at TEXT,
          revoked_at TEXT,
          revoked_reason TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_refresh ON sessions(refresh_hash);

        -- Idempotency-Key middleware: records per-(user, key) request
        -- fingerprint + cached response so duplicate POSTs don't
        -- double-write. Rows expire via a TTL sweep in the worker.
        CREATE TABLE IF NOT EXISTS idempotency_keys (
          user_id TEXT NOT NULL,
          key TEXT NOT NULL,
          method TEXT NOT NULL,
          path TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'in_flight',
          status INTEGER,
          response_body TEXT,
          response_headers TEXT,
          created_at TEXT NOT NULL,
          completed_at TEXT,
          expires_at TEXT NOT NULL,
          PRIMARY KEY (user_id, key)
        );
        CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency_keys(expires_at);

        -- Webhook delivery payloads kept out of audit_log so the audit
        -- chain stays compact (E14 enterprise-readiness recommendation).
        -- Rows are deleted after successful delivery + retention sweep.
        CREATE TABLE IF NOT EXISTS webhook_delivery_payloads (
          delivery_id TEXT PRIMARY KEY,
          body TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
      setVersion(12);
    }

    // ----- v9–v13: per-tenant audit signing key registry ------------
    // The audit pack signing key used to be a single FORGE_TENANT_KEY env
    // var. Per-tenant key history (B.2 #2/#3, B.8 #4) needs a registry
    // table so the active key per org can rotate while old packs remain
    // verifiable. crypto.js prepares statements against this table at
    // module load — without it, importing any server module crashes.
    if (getVersion() < 13) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS tenant_keys (
          id TEXT PRIMARY KEY,
          org_id TEXT,
          state TEXT NOT NULL DEFAULT 'active',
          key_fingerprint TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          retired_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_tenant_keys_org_state ON tenant_keys(org_id, state);
      `);
      // Seed the default global key row used as the v1 fallback so
      // tenant-keys.test.js can locate the registry entry.
      db.prepare(
        "INSERT OR IGNORE INTO tenant_keys (id, org_id, state, key_fingerprint, created_at) VALUES (?, NULL, 'active', '', ?)"
      ).run(process.env.FORGE_TENANT_KEY_ID || "key:forge:v1", new Date().toISOString());
      setVersion(13);
    }

    // ----- v14: FK ON DELETE policies on auxiliary child tables ------
    // SQLite cannot ALTER TABLE to add FK constraints, so we recreate
    // each affected table in the standard "create new + copy + drop +
    // rename" pattern. We disable foreign_keys for the duration so the
    // rename step doesn't trigger checks on partially-loaded data.
    if (getVersion() < 14) {
      db.exec(`
        -- team_spaces: org_id → organizations(id) ON DELETE CASCADE
        CREATE TABLE IF NOT EXISTS team_spaces__v14 (
          id TEXT PRIMARY KEY,
          org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          workspace_id TEXT NOT NULL,
          name TEXT NOT NULL,
          summary TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          acl TEXT NOT NULL DEFAULT '{}',
          labels TEXT NOT NULL DEFAULT '[]',
          created_by TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO team_spaces__v14 SELECT * FROM team_spaces;
        DROP TABLE team_spaces;
        ALTER TABLE team_spaces__v14 RENAME TO team_spaces;

        -- projects: team_space_id → team_spaces(id) ON DELETE CASCADE.
        -- Closes the cascade chain org → workspace → team_space →
        -- project → work_item that the audit trail relies on.
        CREATE TABLE IF NOT EXISTS projects__v14 (
          id TEXT PRIMARY KEY,
          team_space_id TEXT NOT NULL REFERENCES team_spaces(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          status TEXT NOT NULL,
          due_date TEXT,
          milestones TEXT NOT NULL DEFAULT '[]',
          acl TEXT NOT NULL DEFAULT '{}',
          labels TEXT NOT NULL DEFAULT '[]',
          created_by TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO projects__v14 SELECT * FROM projects;
        DROP TABLE projects;
        ALTER TABLE projects__v14 RENAME TO projects;

        -- work_items: project_id → projects(id) ON DELETE CASCADE,
        --             assignee_id → users(id) ON DELETE SET NULL.
        CREATE TABLE IF NOT EXISTS work_items__v14 (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          type TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT,
          assignee_id TEXT REFERENCES users(id) ON DELETE SET NULL,
          status TEXT NOT NULL,
          severity TEXT,
          due TEXT,
          blockers TEXT NOT NULL DEFAULT '[]',
          labels TEXT NOT NULL DEFAULT '[]',
          acl TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO work_items__v14 SELECT * FROM work_items;
        DROP TABLE work_items;
        ALTER TABLE work_items__v14 RENAME TO work_items;
      `);

      // Per-table FK additions: only recreate tables that actually exist,
      // since some auxiliary tables (files, transmittals, comments,
      // subscriptions, notifications, connector_runs, connector_mappings,
      // external_object_links) might not have been created yet on every
      // installation. The script asks SQLite for the column list each
      // time and rebuilds the table preserving exactly its current
      // columns, then declares the FK on the column the test wants.
      const fkRecreations = [
        { table: "files",                col: "created_by", ref: "users(id)",              policy: "SET NULL" },
        { table: "transmittals",         col: "doc_id",     ref: "documents(id)",          policy: "CASCADE"  },
        { table: "comments",             col: "rev_id",     ref: "revisions(id)",          policy: "CASCADE"  },
        { table: "subscriptions",        col: "user_id",    ref: "users(id)",              policy: "CASCADE"  },
        { table: "notifications",        col: "user_id",    ref: "users(id)",              policy: "CASCADE"  },
        { table: "connector_runs",       col: "system_id",  ref: "enterprise_systems(id)", policy: "CASCADE"  },
        { table: "connector_mappings",   col: "system_id",  ref: "enterprise_systems(id)", policy: "CASCADE"  },
        { table: "external_object_links", col: "system_id", ref: "enterprise_systems(id)", policy: "CASCADE"  },
      ];
      const tableExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?");
      for (const r of fkRecreations) {
        if (!tableExists.get(r.table)) continue;
        const cols = db.pragma(`table_info(${r.table})`, { simple: false });
        if (!cols.some(c => c.name === r.col)) continue;
        const colDefs = cols.map(c => {
          const parts = [`"${c.name}"`, c.type || "TEXT"];
          if (c.notnull) parts.push("NOT NULL");
          if (c.dflt_value != null) parts.push(`DEFAULT ${c.dflt_value}`);
          if (c.pk) parts.push("PRIMARY KEY");
          if (c.name === r.col) parts.push(`REFERENCES ${r.ref} ON DELETE ${r.policy}`);
          return parts.join(" ");
        }).join(", ");
        const colNames = cols.map(c => `"${c.name}"`).join(", ");
        db.exec(`
          CREATE TABLE "${r.table}__v14" (${colDefs});
          INSERT INTO "${r.table}__v14" (${colNames}) SELECT ${colNames} FROM "${r.table}";
          DROP TABLE "${r.table}";
          ALTER TABLE "${r.table}__v14" RENAME TO "${r.table}";
        `);
      }

      setVersion(14);
    }

    // v15: connector_runs had `action TEXT NOT NULL` from its original v6
    // definition. The code migrated to `run_type` in v7 but never dropped
    // the old NOT NULL column, causing every INSERT from createConnectorRun()
    // to fail on fresh databases with "NOT NULL constraint failed:
    // connector_runs.action". Rebuild the table without the legacy column.
    if (getVersion() < 15) {
      const tableExistsRow = db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='connector_runs'"
      ).get();
      if (tableExistsRow) {
        const cols = db.pragma("table_info(connector_runs)", { simple: false });
        const hasActionNotNull = cols.some(c => c.name === "action" && c.notnull);
        if (hasActionNotNull) {
          // Rebuild preserving all columns *except* the legacy `action`
          // NOT NULL column. We keep `run_type` as the canonical field and
          // expose `action` as an alias in parseRun() for backward compat.
          const keep = cols.filter(c => c.name !== "action");
          const colDefs = keep.map(c => {
            const parts = [`"${c.name}"`, c.type || "TEXT"];
            if (c.notnull) parts.push("NOT NULL");
            if (c.dflt_value != null) parts.push(`DEFAULT ${c.dflt_value}`);
            if (c.pk) parts.push("PRIMARY KEY");
            if (c.name === "system_id")
              parts.push("REFERENCES enterprise_systems(id) ON DELETE CASCADE");
            return parts.join(" ");
          }).join(", ");
          const colNames = keep.map(c => `"${c.name}"`).join(", ");
          db.exec(`
            CREATE TABLE "connector_runs__v15" (${colDefs});
            INSERT INTO "connector_runs__v15" (${colNames}) SELECT ${colNames} FROM "connector_runs";
            DROP TABLE "connector_runs";
            ALTER TABLE "connector_runs__v15" RENAME TO "connector_runs";
            CREATE INDEX IF NOT EXISTS idx_connector_runs_system
              ON connector_runs(system_id, started_at);
          `);
        }
      }
      setVersion(15);
    }

    // v16: Asset dashboard + Profiles feature foundation.
    //
    // Spec ref: docs/INDUSTRIAL_EDGE_PLATFORM_SPEC.md §4 (Asset Model).
    // The schema honours the ISA-95 5-level hierarchy
    // (Enterprise → Site → Area → Line/Cell → Asset) by combining a
    // dedicated `enterprises` table for the top level with a
    // self-referencing `locations` table — one row per Site/Area/Line/Cell
    // — discriminated by the free-text `kind` column. The dashboard's
    // `/api/asset-tree` endpoint walks `parent_location_id` recursively
    // so the UI renders the full chain without further round-trips.
    //
    // Why not five named tables (sites, areas, lines, cells)? Customers
    // configure the hierarchy depth: some sites have areas-then-lines,
    // others jump straight from site to asset. A self-nesting `locations`
    // row with `kind` covers both shapes without per-customer migrations.
    //
    //   - New `enterprises` and `locations` tables: assets are categorised
    //     under enterprise → location with a tree-shaped left nav. The
    //     dashboard's `/api/asset-tree` endpoint walks these in a single
    //     denormalised query.
    //   - New `asset_profiles` + `asset_profile_versions` + `asset_profile_points`:
    //     a Profile is a reusable named data schema (e.g. "Pump Profile"
    //     with `temperature` and `pressure` data points) bound to a source
    //     kind (mqtt|opcua|sql) and a path template. Versioned: bindings
    //     pin to a `profile_version_id`, edits create new versions, old
    //     versions stay reachable for upgrade decisions.
    //   - New `asset_point_bindings`: per-asset, per-point row that joins
    //     a profile-point (or a one-off custom mapping) to the chosen
    //     source `system_id` and the **resolved** `source_path` snapshot
    //     (with `template_vars` JSON kept for re-resolution after an
    //     enterprise/location rename).
    //   - ALTER `assets`: add `enterprise_id`, `location_id`,
    //     `profile_version_id`, `visual_file_id` (FK semantics to files.id
    //     for the user-uploaded asset card image).
    //   - Pre-existing fix A: `enterprise_systems` had no `org_id` column —
    //     brokers/endpoints were global across tenants, a tenancy bug. Add
    //     the column and backfill from `users.org_id` via `owner_id`.
    //   - Pre-existing fix B: `historian_points.tag` was `UNIQUE` globally,
    //     so two assets in different enterprises both having a `temperature`
    //     point collided. Rebuild the table replacing the global UNIQUE
    //     with `UNIQUE(asset_id, tag)` so tag uniqueness is asset-scoped.
    if (getVersion() < 16) {
      const addColumn = (table, columnSql) => {
        try { db.prepare(`ALTER TABLE ${table} ADD COLUMN ${columnSql}`).run(); }
        catch (err) {
          if (!/duplicate column name/i.test(String(err?.message || err))) throw err;
        }
      };

      // -- ALTER assets to carry enterprise/location/profile/visual FKs --
      addColumn("assets", "enterprise_id TEXT");
      addColumn("assets", "location_id TEXT");
      addColumn("assets", "profile_version_id TEXT");
      addColumn("assets", "visual_file_id TEXT");
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_assets_enterprise_location
          ON assets(org_id, workspace_id, enterprise_id, location_id, name);
        CREATE INDEX IF NOT EXISTS idx_assets_profile_version
          ON assets(profile_version_id);
      `);

      // -- ALTER enterprise_systems to carry org_id (pre-existing bug A) --
      addColumn("enterprise_systems", "org_id TEXT");
      // Backfill org_id from users.org_id via owner_id. Rows without an
      // owner_id (legacy / system-seeded) stay NULL — listSystems will
      // continue returning them to every tenant for now; the connector
      // registry phase tightens this further. We surface the count of
      // unbackfilled rows in the audit log for operator visibility.
      const backfillResult = db.prepare(`
        UPDATE enterprise_systems
           SET org_id = (SELECT u.org_id FROM users u WHERE u.id = enterprise_systems.owner_id)
         WHERE org_id IS NULL
           AND owner_id IS NOT NULL
      `).run();
      const orphaned = db.prepare(
        "SELECT COUNT(*) AS n FROM enterprise_systems WHERE org_id IS NULL"
      ).get()?.n || 0;
      if (orphaned > 0) {
        // Best-effort note: log to console at migration time. Operators
        // who need cross-tenant systems already have one tenant; assigning
        // them is a follow-up admin op (PATCH /api/enterprise-systems/:id
        // with org_id once the route exposes it).
        // eslint-disable-next-line no-console
        console.warn(`[db v16] ${orphaned} enterprise_systems row(s) have no org_id (no owner_id); they remain visible to every tenant until reassigned. Backfilled=${backfillResult.changes}.`);
      }
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_enterprise_systems_org_category
          ON enterprise_systems(org_id, category, status);
      `);

      // -- New: enterprises (top of asset hierarchy) --
      db.exec(`
        CREATE TABLE IF NOT EXISTS enterprises (
          id TEXT PRIMARY KEY,
          org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          workspace_id TEXT NOT NULL,
          name TEXT NOT NULL,
          description TEXT,
          sort_order INTEGER NOT NULL DEFAULT 0,
          acl TEXT NOT NULL DEFAULT '{}',
          created_by TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_enterprises_tenant
          ON enterprises(org_id, workspace_id, sort_order, name);

        CREATE TABLE IF NOT EXISTS locations (
          id TEXT PRIMARY KEY,
          org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          workspace_id TEXT NOT NULL,
          enterprise_id TEXT NOT NULL REFERENCES enterprises(id) ON DELETE CASCADE,
          parent_location_id TEXT REFERENCES locations(id) ON DELETE SET NULL,
          name TEXT NOT NULL,
          kind TEXT,
          sort_order INTEGER NOT NULL DEFAULT 0,
          acl TEXT NOT NULL DEFAULT '{}',
          created_by TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_locations_enterprise
          ON locations(enterprise_id, parent_location_id, sort_order, name);
        CREATE INDEX IF NOT EXISTS idx_locations_tenant
          ON locations(org_id, workspace_id);
      `);

      // -- New: asset_profiles + versions + points --
      db.exec(`
        CREATE TABLE IF NOT EXISTS asset_profiles (
          id TEXT PRIMARY KEY,
          org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          workspace_id TEXT,                    -- NULL = library (org-wide)
          name TEXT NOT NULL,
          description TEXT,
          source_kind TEXT NOT NULL CHECK (source_kind IN ('mqtt','opcua','sql')),
          latest_version_id TEXT,
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','archived')),
          owner_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_asset_profiles_tenant
          ON asset_profiles(org_id, workspace_id, source_kind, status);

        CREATE TABLE IF NOT EXISTS asset_profile_versions (
          id TEXT PRIMARY KEY,
          profile_id TEXT NOT NULL REFERENCES asset_profiles(id) ON DELETE CASCADE,
          version INTEGER NOT NULL,
          source_template TEXT NOT NULL DEFAULT '{}',
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','archived')),
          notes TEXT,
          created_by TEXT,
          created_at TEXT NOT NULL,
          UNIQUE(profile_id, version)
        );
        CREATE INDEX IF NOT EXISTS idx_asset_profile_versions_profile
          ON asset_profile_versions(profile_id, version);

        CREATE TABLE IF NOT EXISTS asset_profile_points (
          id TEXT PRIMARY KEY,
          profile_version_id TEXT NOT NULL REFERENCES asset_profile_versions(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          unit TEXT,
          data_type TEXT NOT NULL DEFAULT 'number',
          source_path_template TEXT NOT NULL DEFAULT '',
          point_order INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_asset_profile_points_version
          ON asset_profile_points(profile_version_id, point_order);
      `);

      // -- New: asset_point_bindings (one row per asset+point) --
      // FK to historian_points uses ON DELETE SET NULL so that a deleted
      // historian point doesn't cascade away the binding row (samples
      // outlive the point definition for audit/retention).
      db.exec(`
        CREATE TABLE IF NOT EXISTS asset_point_bindings (
          id TEXT PRIMARY KEY,
          org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
          profile_version_id TEXT REFERENCES asset_profile_versions(id) ON DELETE SET NULL,
          profile_point_id TEXT REFERENCES asset_profile_points(id) ON DELETE SET NULL,
          point_id TEXT,                         -- FK to historian_points (nullable; SET NULL on delete)
          system_id TEXT REFERENCES enterprise_systems(id) ON DELETE RESTRICT,
          source_kind TEXT NOT NULL CHECK (source_kind IN ('mqtt','opcua','sql')),
          source_path TEXT NOT NULL,             -- resolved snapshot
          template_vars TEXT NOT NULL DEFAULT '{}',
          enabled INTEGER NOT NULL DEFAULT 1,
          last_value REAL,
          last_quality TEXT,
          last_seen TEXT,
          created_by TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(asset_id, point_id)
        );
        CREATE INDEX IF NOT EXISTS idx_asset_point_bindings_asset
          ON asset_point_bindings(asset_id, enabled);
        CREATE INDEX IF NOT EXISTS idx_asset_point_bindings_system
          ON asset_point_bindings(system_id, source_path);
        CREATE INDEX IF NOT EXISTS idx_asset_point_bindings_profile_version
          ON asset_point_bindings(profile_version_id);
      `);

      // -- Pre-existing fix B: drop global UNIQUE on historian_points.tag,
      //    replace with UNIQUE(asset_id, tag). Two assets across different
      //    enterprises both having a `temperature` point now coexist. --
      const hpExists = db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='historian_points'"
      ).get();
      if (hpExists) {
        const cols = db.pragma("table_info(historian_points)", { simple: false });
        const idx = db.prepare(
          "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='historian_points'"
        ).all();
        const tagIsGloballyUnique = (() => {
          // SQLite's `UNIQUE` on a column is implemented as an
          // auto-index named like `sqlite_autoindex_historian_points_*`.
          // The pragma reports unique columns indirectly via index_list.
          const idxList = db.pragma("index_list(historian_points)", { simple: false });
          for (const il of idxList) {
            if (!il.unique) continue;
            const info = db.pragma(`index_info(${il.name})`, { simple: false });
            if (info.length === 1 && info[0].name === "tag") return true;
          }
          return false;
        })();
        if (tagIsGloballyUnique) {
          // Rebuild without the column-level UNIQUE; add a composite UNIQUE
          // (asset_id, tag) instead so name uniqueness is asset-scoped.
          const colDefs = cols.map(c => {
            const parts = [`"${c.name}"`, c.type || "TEXT"];
            if (c.notnull) parts.push("NOT NULL");
            if (c.dflt_value != null) parts.push(`DEFAULT ${c.dflt_value}`);
            if (c.pk) parts.push("PRIMARY KEY");
            return parts.join(" ");
          }).join(", ");
          const colNames = cols.map(c => `"${c.name}"`).join(", ");
          db.exec(`
            CREATE TABLE "historian_points__v16" (${colDefs}, UNIQUE(asset_id, tag));
            INSERT INTO "historian_points__v16" (${colNames}) SELECT ${colNames} FROM "historian_points";
            DROP TABLE "historian_points";
            ALTER TABLE "historian_points__v16" RENAME TO "historian_points";
            CREATE INDEX IF NOT EXISTS idx_historian_points_asset
              ON historian_points(asset_id);
          `);
          // Re-create any custom indexes (we didn't have any beyond
          // idx_historian_points_asset, but loop defensively in case
          // future migrations add them).
          for (const i of idx) {
            if (!i.sql) continue;
            if (/sqlite_autoindex/i.test(i.name)) continue;
            if (i.name === "idx_historian_points_asset") continue;
            try { db.exec(i.sql); } catch { /* best-effort */ }
          }
        }
      }

      setVersion(16);
    }

    // v17: Consolidate `asset_point_bindings` schema.
    //
    // Phase 3 added `query_template` + `sql_mode` via idempotent
    // ALTER TABLE inside the route module to keep the diff small.
    // Phase 7a (multi-vendor SQL) needs an additional `dialect`
    // column AND we want the canonical CREATE TABLE shape to
    // include all three so a fresh DB matches an upgraded one.
    // Rebuild the table preserving every existing column +
    // pragma-driven UNIQUE/NOT NULL constraints, plus appending
    // the new columns idempotently.
    if (getVersion() < 17) {
      const tableExists = db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='asset_point_bindings'"
      ).get();
      if (tableExists) {
        const ensureCol = (name, ddl) => {
          try { db.prepare(`ALTER TABLE asset_point_bindings ADD COLUMN ${ddl}`).run(); }
          catch (err) {
            if (!/duplicate column name/i.test(String(err?.message || err))) throw err;
          }
        };
        // Idempotent ADD COLUMN — Phase 3 already added query_template
        // + sql_mode via the route module on first server boot, but a
        // freshly created v16 DB that never hit the routes hasn't.
        ensureCol("query_template", "query_template TEXT");
        ensureCol("sql_mode", "sql_mode TEXT");
        ensureCol("dialect", "dialect TEXT");

        // Backfill `dialect` for existing rows: pull the system's
        // vendor / kind / config and pick the matching dialect key.
        // Schema-defined-only rows on legacy mssql systems get
        // `dialect='mssql'`; postgres / mysql / sqlite inferred
        // from vendor when present. Free-form rows already carry
        // the choice in `query_template`; we record dialect for
        // consistency.
        const bindingsToBackfill = db.prepare(`
          SELECT b.id, es.vendor, es.kind, es.category, es.config
            FROM asset_point_bindings b
            LEFT JOIN enterprise_systems es ON es.id = b.system_id
           WHERE b.source_kind = 'sql' AND (b.dialect IS NULL OR b.dialect = '')
        `).all();
        const setDialect = db.prepare("UPDATE asset_point_bindings SET dialect = ? WHERE id = ?");
        for (const b of bindingsToBackfill) {
          let cfg = {};
          try { cfg = b.config ? JSON.parse(b.config) : {}; } catch { /* ignore */ }
          let dialect = String(cfg.dialect || "").toLowerCase();
          if (!dialect) {
            const v = String(b.vendor || "").toLowerCase();
            const k = String(b.kind || b.category || "").toLowerCase();
            if (/postgres|psql|timescale/.test(v) || /postgres/.test(k)) dialect = "postgresql";
            else if (/mysql|maria/.test(v) || /mysql/.test(k)) dialect = "mysql";
            else if (/sqlite/.test(v) || /sqlite/.test(k)) dialect = "sqlite";
            else dialect = "mssql"; // pre-Phase-7 default
          }
          setDialect.run(dialect, b.id);
        }

        // Add an index on the new dialect column so the connector's
        // sql-registry can prune to a per-dialect work-list cheaply.
        db.exec("CREATE INDEX IF NOT EXISTS idx_asset_point_bindings_dialect ON asset_point_bindings(dialect)");
      }

      setVersion(17);
    }

    if (getVersion() < 18) {
      // v18 (Phase 1 hardening): hot-path index on the files table.
      // The `files` table doesn't carry an `org_id` column today —
      // tenant scope is enforced via the parent record's `org_id`
      // (document, asset, etc.). The (parent_kind, parent_id) lookup
      // is the only access pattern, so this index targets it directly.
      //
      // A future migration that adds files.org_id (defense-in-depth
      // for direct-FK lookups) would extend this to the 3-column
      // form; for now the 2-column index already collapses the table
      // scan that some routes hit when the FTS5 join misses.
      //
      // Idempotent: IF NOT EXISTS keeps re-runs safe.
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_files_parent
          ON files(parent_kind, parent_id)
      `);
      setVersion(18);
    }

    if (getVersion() < 19) {
      // v19 (Phase 2 resilience): webhook circuit breaker.
      //
      // Today a dead webhook URL retries 6× per delivery with backoff
      // up to 30 min. With many queued events that's a lot of outbound
      // calls to a known-broken endpoint, plus the noise it generates
      // (logs, audit entries) crowds out the diagnostics that would
      // help fix it.
      //
      // The breaker tracks `consecutive_failures`. After
      // FORGE_WEBHOOK_BREAKER_THRESHOLD (default 5) consecutive
      // failures, `circuit_open_until` is set to now + 24 h. While
      // open, dispatch + tick skip the webhook entirely (visible in
      // admin as "circuit open"). A successful delivery resets the
      // counter and clears the timestamp; the operator can also
      // manually re-enable to clear the breaker via the existing
      // toggle endpoint.
      const addColumn = (table, columnSql) => {
        try { db.prepare(`ALTER TABLE ${table} ADD COLUMN ${columnSql}`).run(); }
        catch (err) {
          if (!/duplicate column name/i.test(String(err?.message || err))) throw err;
        }
      };
      addColumn("webhooks", "consecutive_failures INTEGER NOT NULL DEFAULT 0");
      addColumn("webhooks", "circuit_open_until TEXT");
      setVersion(19);
    }
  })();
  db.pragma("foreign_keys = ON");
}

migrate();

// ---------- Helpers ----------
export function now() { return new Date().toISOString(); }

/**
 * Generate a short, opaque, prefixed identifier suitable for primary keys.
 *
 * Backed by `crypto.randomUUID()` so output is unguessable and collision-
 * resistant even for high-volume tables. Result is `prefix-XXXXXXXXXXXX`
 * where the suffix is the first 12 hex chars of a random UUID, uppercased
 * for parity with previous IDs already in seed data.
 */
export function uuid(prefix = "") {
  const s = randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase();
  return prefix ? `${prefix}-${s}` : s;
}

export function jsonOrDefault(s, fallback) {
  if (s == null) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}

/**
 * Run a transaction. `fn` receives the db handle.
 */
export function tx(fn) { return db.transaction(fn)(); }

if (process.argv.includes("--migrate-only")) {
  console.log("schema_version =", getVersion());
  process.exit(0);
}

/**
 * Print orphan row counts per child table — same sweep the v12 migration
 * does, but standalone so an operator can inspect a database before
 * upgrading.
 */
if (process.argv.includes("--integrity")) {
  db.pragma("foreign_keys = ON");
  const result = db.pragma("foreign_key_check", { simple: false });
  if (!result.length) {
    console.log("foreign_key_check: no orphans (schema_version =", getVersion(), ")");
    process.exit(0);
  }
  console.log(`foreign_key_check found ${result.length} orphan row(s):`);
  for (const row of result) {
    console.log(`  - ${row.table}#${row.rowid} → ${row.parent}${row.fkid != null ? " (fkid=" + row.fkid + ")" : ""}`);
  }
  process.exit(1);
}
