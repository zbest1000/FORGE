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

const SCHEMA_VERSION = 10;

db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);

function getVersion() {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  return row ? Number(row.value) : 0;
}
function setVersion(v) {
  db.prepare("INSERT INTO meta(key, value) VALUES('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(v));
}

function migrate() {
  const current = getVersion();
  if (current >= SCHEMA_VERSION) return;

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
          action TEXT NOT NULL,
          status TEXT NOT NULL,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          stats TEXT NOT NULL DEFAULT '{}',
          error TEXT,
          requested_by TEXT
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
      // Per-session row backing access tokens + refresh tokens. The access
      // JWT carries `sid` (= sessions.id) and `jti` (= sessions.access_jti).
      // Auth resolution rejects any JWT whose `sid` row is revoked, or
      // whose `jti` does not match the session's current access_jti — so
      // a stolen-then-rotated token cannot ride alongside the new one.
      //
      // Refresh tokens are hashed (sha256) at rest. Rotation replaces
      // both `refresh_hash` and `access_jti`; the previous `refresh_hash`
      // is moved into `previous_refresh_hash` exactly once so that a
      // replay of the old refresh token can be detected and invalidate
      // the entire session (suspected token theft).
      db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          access_jti TEXT NOT NULL,
          refresh_hash TEXT,
          previous_refresh_hash TEXT,
          mfa TEXT,
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
        CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, revoked_at);
        CREATE INDEX IF NOT EXISTS idx_sessions_jti ON sessions(access_jti);
        CREATE INDEX IF NOT EXISTS idx_sessions_refresh ON sessions(refresh_hash);
      `);
      setVersion(8);
    }

    if (getVersion() < 9) {
      // Webhook delivery payloads. Earlier versions parked the body on
      // an `audit_log` row and re-read it via `json_extract` at delivery
      // time — that bloated the immutable hash chain forever and would
      // silently break if an audit-retention sweep ever pruned the
      // referenced row. The body now lives in its own table, indexed by
      // `delivery_id` so the dispatcher can fetch it with a primary-key
      // lookup. Rows are deleted once a delivery reaches a terminal
      // state (`delivered`, `failed`, `cancelled`).
      db.exec(`
        CREATE TABLE IF NOT EXISTS webhook_delivery_payloads (
          delivery_id TEXT PRIMARY KEY REFERENCES webhook_deliveries(id) ON DELETE CASCADE,
          body TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
      setVersion(9);
    }

    if (getVersion() < 10) {
      // Idempotency-key cache for write APIs.
      //
      // Keyed by (user, key) so two tenants can independently use the
      // same key without collision; the request fingerprint is hashed
      // so a replay with a *different* body on the same key is rejected
      // with 409 (per RFC draft-ietf-httpapi-idempotency-key §2.4).
      //
      // The cache also tracks an `in_flight` state so concurrent
      // duplicate requests don't both reach the underlying handler.
      db.exec(`
        CREATE TABLE IF NOT EXISTS idempotency_keys (
          user_id TEXT NOT NULL,
          key TEXT NOT NULL,
          method TEXT NOT NULL,
          path TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          status INTEGER,
          response_body TEXT,
          response_headers TEXT,
          state TEXT NOT NULL DEFAULT 'in_flight',
          created_at TEXT NOT NULL,
          completed_at TEXT,
          expires_at TEXT NOT NULL,
          PRIMARY KEY (user_id, key)
        );
        CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency_keys(expires_at);
      `);
      setVersion(10);
    }
  })();
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
