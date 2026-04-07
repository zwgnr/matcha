import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // This is an intentional destructive reset. The thread -> workspace rename
  // changes event types, projection table names, and key column names.
  // Rather than carry dual-schema compatibility in this early WIP, reset the
  // local persistence state and recreate the canonical workspace schema.
  yield* sql`DROP TABLE IF EXISTS projection_thread_proposed_plans`;
  yield* sql`DROP TABLE IF EXISTS projection_thread_sessions`;
  yield* sql`DROP TABLE IF EXISTS projection_thread_activities`;
  yield* sql`DROP TABLE IF EXISTS projection_thread_messages`;
  yield* sql`DROP TABLE IF EXISTS projection_threads`;

  yield* sql`DROP TABLE IF EXISTS projection_workspace_proposed_plans`;
  yield* sql`DROP TABLE IF EXISTS projection_workspace_sessions`;
  yield* sql`DROP TABLE IF EXISTS projection_workspace_activities`;
  yield* sql`DROP TABLE IF EXISTS projection_workspace_messages`;
  yield* sql`DROP TABLE IF EXISTS projection_workspaces`;
  yield* sql`DROP TABLE IF EXISTS projection_pending_approvals`;
  yield* sql`DROP TABLE IF EXISTS projection_turns`;
  yield* sql`DROP TABLE IF EXISTS projection_projects`;
  yield* sql`DROP TABLE IF EXISTS projection_state`;

  yield* sql`DROP TABLE IF EXISTS provider_session_runtime`;
  yield* sql`DROP TABLE IF EXISTS checkpoint_diff_blobs`;
  yield* sql`DELETE FROM orchestration_command_receipts`;
  yield* sql`DELETE FROM orchestration_events`;

  yield* sql`
    CREATE TABLE IF NOT EXISTS checkpoint_diff_blobs (
      workspace_id TEXT NOT NULL,
      from_turn_count INTEGER NOT NULL,
      to_turn_count INTEGER NOT NULL,
      diff TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (workspace_id, from_turn_count, to_turn_count)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_checkpoint_diff_blobs_workspace_to_turn
    ON checkpoint_diff_blobs(workspace_id, to_turn_count)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS provider_session_runtime (
      workspace_id TEXT PRIMARY KEY,
      provider_name TEXT NOT NULL,
      adapter_key TEXT NOT NULL,
      runtime_mode TEXT NOT NULL DEFAULT 'full-access',
      status TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      resume_cursor_json TEXT,
      runtime_payload_json TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_provider_session_runtime_status
    ON provider_session_runtime(status)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_provider_session_runtime_provider
    ON provider_session_runtime(provider_name)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_projects (
      project_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      workspace_root TEXT NOT NULL,
      default_model_selection_json TEXT,
      scripts_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_projects_updated_at
    ON projection_projects(updated_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_projects_workspace_root_deleted_at
    ON projection_projects(workspace_root, deleted_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_workspaces (
      workspace_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      model_selection_json TEXT NOT NULL,
      branch TEXT,
      worktree_path TEXT,
      latest_turn_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      runtime_mode TEXT NOT NULL DEFAULT 'full-access',
      interaction_mode TEXT NOT NULL DEFAULT 'default',
      archived_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_workspaces_project_id
    ON projection_workspaces(project_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_workspaces_project_archived_at
    ON projection_workspaces(project_id, archived_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_workspaces_project_deleted_created
    ON projection_workspaces(project_id, deleted_at, created_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_workspace_messages (
      message_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      turn_id TEXT,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      is_streaming INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      attachments_json TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_workspace_messages_workspace_created
    ON projection_workspace_messages(workspace_id, created_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_workspace_activities (
      activity_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      turn_id TEXT,
      tone TEXT NOT NULL,
      kind TEXT NOT NULL,
      summary TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      sequence INTEGER
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_workspace_activities_workspace_created
    ON projection_workspace_activities(workspace_id, created_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_workspace_activities_workspace_sequence
    ON projection_workspace_activities(workspace_id, sequence)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_workspace_sessions (
      workspace_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      provider_name TEXT,
      provider_session_id TEXT,
      provider_workspace_id TEXT,
      active_turn_id TEXT,
      last_error TEXT,
      updated_at TEXT NOT NULL,
      runtime_mode TEXT NOT NULL DEFAULT 'full-access'
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_workspace_sessions_provider_session
    ON projection_workspace_sessions(provider_session_id)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_turns (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id TEXT NOT NULL,
      turn_id TEXT,
      pending_message_id TEXT,
      assistant_message_id TEXT,
      state TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      checkpoint_turn_count INTEGER,
      checkpoint_ref TEXT,
      checkpoint_status TEXT,
      checkpoint_files_json TEXT NOT NULL,
      source_proposed_plan_workspace_id TEXT,
      source_proposed_plan_id TEXT,
      UNIQUE (workspace_id, turn_id),
      UNIQUE (workspace_id, checkpoint_turn_count)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_turns_workspace_requested
    ON projection_turns(workspace_id, requested_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_turns_workspace_checkpoint_completed
    ON projection_turns(workspace_id, checkpoint_turn_count, completed_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_pending_approvals (
      request_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      turn_id TEXT,
      status TEXT NOT NULL,
      decision TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_pending_approvals_workspace_status
    ON projection_pending_approvals(workspace_id, status)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_workspace_proposed_plans (
      plan_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      turn_id TEXT,
      plan_markdown TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      implemented_at TEXT,
      implementation_workspace_id TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_workspace_proposed_plans_workspace_created
    ON projection_workspace_proposed_plans(workspace_id, created_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_state (
      projector TEXT PRIMARY KEY,
      last_applied_sequence INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
});
