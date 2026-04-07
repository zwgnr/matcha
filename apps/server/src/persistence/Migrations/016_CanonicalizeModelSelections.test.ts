import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("016_CanonicalizeModelSelections", (it) => {
  it.effect(
    "migrates legacy projection rows and event payloads to the canonical model-selection shape",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        // Setup base state
        {
          yield* runMigrations({ toMigrationInclusive: 15 });

          yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES
          ('project-codex', 'Codex project', '/tmp/project-codex', 'gpt-5.4', '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL),
          ('project-claude', 'Claude project', '/tmp/project-claude', 'claude-sonnet-4-6', '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL),
          ('project-null', 'Null project', '/tmp/project-null', NULL, '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL)
      `;
          yield* sql`
        UPDATE projection_projects
        SET default_model = 'claude-opus-4-6'
        WHERE project_id = 'project-claude'
      `;
          yield* sql`
        INSERT INTO projection_workspaces (
          workspace_id,
          project_id,
          title,
          model,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          deleted_at,
          runtime_mode,
          interaction_mode
        )
        VALUES
          ('workspace-session', 'project-codex', 'Session workspace', 'gpt-5.4', NULL, NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL, 'full-access', 'default'),
          ('workspace-claude', 'project-claude', 'Claude workspace', 'claude-opus-4-6', NULL, NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL, 'full-access', 'default'),
          ('workspace-codex', 'project-codex', 'Codex workspace', 'gpt-5.4', NULL, NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL, 'full-access', 'default'),
          ('workspace-legacy-options', 'project-claude', 'Legacy options workspace', 'claude-opus-4-6', NULL, NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL, 'full-access', 'default')
      `;
          yield* sql`
        INSERT INTO projection_workspace_sessions (
          workspace_id,
          status,
          provider_name,
          provider_session_id,
          provider_workspace_id,
          active_turn_id,
          last_error,
          updated_at,
          runtime_mode
        )
        VALUES (
          'workspace-session',
          'running',
          'claudeAgent',
          'provider-session-1',
          'provider-workspace-1',
          NULL,
          NULL,
          '2026-01-01T00:00:00.000Z',
          'full-access'
        )
      `;
          yield* sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES
        (
          'event-project-created',
          'project',
          'project-1',
          1,
          'project.created',
          '2026-01-01T00:00:00.000Z',
          'command-project-created',
          NULL,
          'correlation-project-created',
          'user',
          '{"projectId":"project-1","title":"Project","workspaceRoot":"/tmp/project","defaultModel":"claude-opus-4-6","defaultModelOptions":{"codex":{"reasoningEffort":"high"},"claudeAgent":{"effort":"max"}},"scripts":[],"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}',
          '{}'
        ),
        (
          'event-project-created-fallback',
          'project',
          'project-2',
          1,
          'project.created',
          '2026-01-01T00:00:00.000Z',
          'command-project-created-fallback',
          NULL,
          'correlation-project-created-fallback',
          'user',
          '{"projectId":"project-2","title":"Fallback Project","workspaceRoot":"/tmp/project-2","defaultModel":"claude-opus-4-6","defaultModelOptions":{"codex":{"reasoningEffort":"low"}},"scripts":[],"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}',
          '{}'
        ),
        (
          'event-project-created-null-model',
          'project',
          'project-3',
          1,
          'project.created',
          '2026-01-01T00:00:00.000Z',
          'command-project-created-null-model',
          NULL,
          'correlation-project-created-null-model',
          'user',
          '{"projectId":"project-3","title":"Null Model Project","workspaceRoot":"/tmp/project-3","defaultModel":null,"scripts":[],"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}',
          '{}'
        ),
        (
          'event-workspace-created',
          'workspace',
          'workspace-1',
          1,
          'workspace.created',
          '2026-01-01T00:00:00.000Z',
          'command-workspace-created',
          NULL,
          'correlation-workspace-created',
          'user',
          '{"workspaceId":"workspace-1","projectId":"project-1","title":"Workspace","model":"claude-opus-4-6","modelOptions":{"codex":{"reasoningEffort":"high"},"claudeAgent":{"effort":"max","thinking":false}},"runtimeMode":"full-access","interactionMode":"default","branch":null,"worktreePath":null,"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}',
          '{}'
        ),
        (
          'event-workspace-created-fallback',
          'workspace',
          'workspace-2',
          1,
          'workspace.created',
          '2026-01-01T00:00:00.000Z',
          'command-workspace-created-fallback',
          NULL,
          'correlation-workspace-created-fallback',
          'user',
          '{"workspaceId":"workspace-2","projectId":"project-1","title":"Fallback Workspace","model":"gpt-5.4","modelOptions":{"claudeAgent":{"effort":"max"}},"runtimeMode":"full-access","interactionMode":"default","branch":null,"worktreePath":null,"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}',
          '{}'
        ),
        (
          'event-turn-start-requested',
          'workspace',
          'workspace-1',
          2,
          'workspace.turn-start-requested',
          '2026-01-01T00:00:00.000Z',
          'command-turn-start-requested',
          NULL,
          'correlation-turn-start-requested',
          'user',
          '{"workspaceId":"workspace-1","turnId":"turn-1","input":"hi","model":"gpt-5.4","modelOptions":{"codex":{"fastMode":true},"claudeAgent":{"effort":"max"}},"deliveryMode":"buffered"}',
          '{}'
        ),
        (
          'event-workspace-created-no-model',
          'workspace',
          'workspace-3',
          1,
          'workspace.created',
          '2026-01-01T00:00:00.000Z',
          'command-workspace-created-no-model',
          NULL,
          'correlation-workspace-created-no-model',
          'user',
          '{"workspaceId":"workspace-3","projectId":"project-1","title":"Ancient Workspace","runtimeMode":"full-access","interactionMode":"default","branch":null,"worktreePath":null,"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}',
          '{}'
        )
      `;
        }

        // Execute migration under test
        yield* runMigrations({ toMigrationInclusive: 16 });

        // Assert expected state
        {
          const projectRows = yield* sql<{
            readonly projectId: string;
            readonly defaultModelSelection: string | null;
          }>`
        SELECT
          project_id AS "projectId",
          default_model_selection_json AS "defaultModelSelection"
        FROM projection_projects
        ORDER BY project_id
      `;
          assert.deepStrictEqual(projectRows, [
            {
              projectId: "project-claude",
              defaultModelSelection: '{"provider":"claudeAgent","model":"claude-opus-4-6"}',
            },
            {
              projectId: "project-codex",
              defaultModelSelection: '{"provider":"codex","model":"gpt-5.4"}',
            },
            { projectId: "project-null", defaultModelSelection: null },
          ]);

          const workspaceRows = yield* sql<{
            readonly workspaceId: string;
            readonly modelSelection: string | null;
          }>`
        SELECT
          workspace_id AS "workspaceId",
          model_selection_json AS "modelSelection"
        FROM projection_workspaces
        ORDER BY workspace_id
      `;
          assert.deepStrictEqual(workspaceRows, [
            {
              workspaceId: "workspace-claude",
              modelSelection: '{"provider":"claudeAgent","model":"claude-opus-4-6"}',
            },
            {
              workspaceId: "workspace-codex",
              modelSelection: '{"provider":"codex","model":"gpt-5.4"}',
            },
            {
              workspaceId: "workspace-legacy-options",
              modelSelection: '{"provider":"claudeAgent","model":"claude-opus-4-6"}',
            },
            {
              workspaceId: "workspace-session",
              modelSelection: '{"provider":"claudeAgent","model":"gpt-5.4"}',
            },
          ]);

          const eventRows = yield* sql<{
            readonly payloadJson: string;
          }>`
        SELECT payload_json AS "payloadJson"
        FROM orchestration_events
        ORDER BY rowid ASC
      `;

          assert.deepStrictEqual(JSON.parse(eventRows[0]!.payloadJson), {
            projectId: "project-1",
            title: "Project",
            workspaceRoot: "/tmp/project",
            defaultModelSelection: {
              provider: "claudeAgent",
              model: "claude-opus-4-6",
              options: {
                effort: "max",
              },
            },
            scripts: [],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          });

          assert.deepStrictEqual(JSON.parse(eventRows[1]!.payloadJson), {
            projectId: "project-2",
            title: "Fallback Project",
            workspaceRoot: "/tmp/project-2",
            defaultModelSelection: {
              provider: "claudeAgent",
              model: "claude-opus-4-6",
              options: {
                reasoningEffort: "low",
              },
            },
            scripts: [],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          });

          assert.deepStrictEqual(JSON.parse(eventRows[2]!.payloadJson), {
            projectId: "project-3",
            title: "Null Model Project",
            workspaceRoot: "/tmp/project-3",
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          });

          assert.deepStrictEqual(JSON.parse(eventRows[3]!.payloadJson), {
            workspaceId: "workspace-1",
            projectId: "project-1",
            title: "Workspace",
            modelSelection: {
              provider: "claudeAgent",
              model: "claude-opus-4-6",
              options: {
                effort: "max",
                thinking: false,
              },
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          });

          assert.deepStrictEqual(JSON.parse(eventRows[4]!.payloadJson), {
            workspaceId: "workspace-2",
            projectId: "project-1",
            title: "Fallback Workspace",
            modelSelection: {
              provider: "codex",
              model: "gpt-5.4",
              options: {
                effort: "max",
              },
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          });

          assert.deepStrictEqual(JSON.parse(eventRows[5]!.payloadJson), {
            workspaceId: "workspace-1",
            turnId: "turn-1",
            input: "hi",
            modelSelection: {
              provider: "codex",
              model: "gpt-5.4",
              options: {
                fastMode: true,
              },
            },
            deliveryMode: "buffered",
          });

          assert.deepStrictEqual(JSON.parse(eventRows[6]!.payloadJson), {
            workspaceId: "workspace-3",
            projectId: "project-1",
            title: "Ancient Workspace",
            modelSelection: {
              provider: "codex",
              model: "gpt-5.4",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          });
        }
      }),
  );
});
