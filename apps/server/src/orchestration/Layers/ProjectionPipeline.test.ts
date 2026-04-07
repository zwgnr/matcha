import {
  CheckpointRef,
  CommandId,
  CorrelationId,
  EventId,
  MessageId,
  ProjectId,
  WorkspaceId,
  TurnId,
} from "@matcha/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import {
  ORCHESTRATION_PROJECTOR_NAMES,
  OrchestrationProjectionPipelineLive,
} from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { ServerConfig } from "../../config.ts";

const makeProjectionPipelinePrefixedTestLayer = (prefix: string) =>
  OrchestrationProjectionPipelineLive.pipe(
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix })),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  );

const exists = (filePath: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const fileInfo = yield* Effect.result(fileSystem.stat(filePath));
    return fileInfo._tag === "Success";
  });

const BaseTestLayer = makeProjectionPipelinePrefixedTestLayer("matcha-projection-pipeline-test-");

it.layer(BaseTestLayer)("OrchestrationProjectionPipeline", (it) => {
  it.effect("bootstraps all projection states and writes projection rows", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();

      yield* eventStore.append({
        type: "project.created",
        eventId: EventId.makeUnsafe("evt-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.makeUnsafe("project-1"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-1"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.makeUnsafe("project-1"),
          title: "Project 1",
          workspaceRoot: "/tmp/project-1",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "workspace.created",
        eventId: EventId.makeUnsafe("evt-2"),
        aggregateKind: "workspace",
        aggregateId: WorkspaceId.makeUnsafe("workspace-1"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-2"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-2"),
        metadata: {},
        payload: {
          workspaceId: WorkspaceId.makeUnsafe("workspace-1"),
          projectId: ProjectId.makeUnsafe("project-1"),
          title: "Workspace 1",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "workspace.message-sent",
        eventId: EventId.makeUnsafe("evt-3"),
        aggregateKind: "workspace",
        aggregateId: WorkspaceId.makeUnsafe("workspace-1"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-3"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-3"),
        metadata: {},
        payload: {
          workspaceId: WorkspaceId.makeUnsafe("workspace-1"),
          messageId: MessageId.makeUnsafe("message-1"),
          role: "assistant",
          text: "hello",
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* projectionPipeline.bootstrap;

      const projectRows = yield* sql<{
        readonly projectId: string;
        readonly title: string;
        readonly scriptsJson: string;
      }>`
        SELECT
          project_id AS "projectId",
          title,
          scripts_json AS "scriptsJson"
        FROM projection_projects
      `;
      assert.deepEqual(projectRows, [
        { projectId: "project-1", title: "Project 1", scriptsJson: "[]" },
      ]);

      const messageRows = yield* sql<{
        readonly messageId: string;
        readonly text: string;
      }>`
        SELECT
          message_id AS "messageId",
          text
        FROM projection_workspace_messages
      `;
      assert.deepEqual(messageRows, [{ messageId: "message-1", text: "hello" }]);

      const stateRows = yield* sql<{
        readonly projector: string;
        readonly lastAppliedSequence: number;
      }>`
        SELECT
          projector,
          last_applied_sequence AS "lastAppliedSequence"
        FROM projection_state
        ORDER BY projector ASC
      `;
      assert.equal(stateRows.length, Object.keys(ORCHESTRATION_PROJECTOR_NAMES).length);
      for (const row of stateRows) {
        assert.equal(row.lastAppliedSequence, 3);
      }
    }),
  );
});

it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer("matcha-base-")))(
  "OrchestrationProjectionPipeline",
  (it) => {
    it.effect("stores message attachment references without mutating payloads", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const now = new Date().toISOString();

        yield* eventStore.append({
          type: "workspace.message-sent",
          eventId: EventId.makeUnsafe("evt-attachments"),
          aggregateKind: "workspace",
          aggregateId: WorkspaceId.makeUnsafe("workspace-attachments"),
          occurredAt: now,
          commandId: CommandId.makeUnsafe("cmd-attachments"),
          causationEventId: null,
          correlationId: CommandId.makeUnsafe("cmd-attachments"),
          metadata: {},
          payload: {
            workspaceId: WorkspaceId.makeUnsafe("workspace-attachments"),
            messageId: MessageId.makeUnsafe("message-attachments"),
            role: "user",
            text: "Inspect this",
            attachments: [
              {
                type: "image",
                id: "workspace-attachments-att-1",
                name: "example.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        });

        yield* projectionPipeline.bootstrap;

        const rows = yield* sql<{
          readonly attachmentsJson: string | null;
        }>`
            SELECT
              attachments_json AS "attachmentsJson"
            FROM projection_workspace_messages
            WHERE message_id = 'message-attachments'
          `;
        assert.equal(rows.length, 1);
        assert.deepEqual(JSON.parse(rows[0]?.attachmentsJson ?? "null"), [
          {
            type: "image",
            id: "workspace-attachments-att-1",
            name: "example.png",
            mimeType: "image/png",
            sizeBytes: 5,
          },
        ]);
      }),
    );
  },
);

it.layer(
  Layer.fresh(makeProjectionPipelinePrefixedTestLayer("matcha-projection-attachments-safe-")),
)("OrchestrationProjectionPipeline", (it) => {
  it.effect("preserves mixed image attachment metadata as-is", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();

      yield* eventStore.append({
        type: "workspace.message-sent",
        eventId: EventId.makeUnsafe("evt-attachments-safe"),
        aggregateKind: "workspace",
        aggregateId: WorkspaceId.makeUnsafe("workspace-attachments-safe"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-attachments-safe"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-attachments-safe"),
        metadata: {},
        payload: {
          workspaceId: WorkspaceId.makeUnsafe("workspace-attachments-safe"),
          messageId: MessageId.makeUnsafe("message-attachments-safe"),
          role: "user",
          text: "Inspect this",
          attachments: [
            {
              type: "image",
              id: "workspace-attachments-safe-att-1",
              name: "untrusted.exe",
              mimeType: "image/x-unknown",
              sizeBytes: 5,
            },
            {
              type: "image",
              id: "workspace-attachments-safe-att-2",
              name: "not-image.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* projectionPipeline.bootstrap;

      const rows = yield* sql<{
        readonly attachmentsJson: string | null;
      }>`
            SELECT
              attachments_json AS "attachmentsJson"
            FROM projection_workspace_messages
            WHERE message_id = 'message-attachments-safe'
          `;
      assert.equal(rows.length, 1);
      assert.deepEqual(JSON.parse(rows[0]?.attachmentsJson ?? "null"), [
        {
          type: "image",
          id: "workspace-attachments-safe-att-1",
          name: "untrusted.exe",
          mimeType: "image/x-unknown",
          sizeBytes: 5,
        },
        {
          type: "image",
          id: "workspace-attachments-safe-att-2",
          name: "not-image.png",
          mimeType: "image/png",
          sizeBytes: 5,
        },
      ]);
    }),
  );
});

it.layer(BaseTestLayer)("OrchestrationProjectionPipeline", (it) => {
  it.effect(
    "passes explicit empty attachment arrays through the projection pipeline to clear attachments",
    () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const now = new Date().toISOString();
        const later = new Date(Date.now() + 1_000).toISOString();

        yield* eventStore.append({
          type: "project.created",
          eventId: EventId.makeUnsafe("evt-clear-attachments-1"),
          aggregateKind: "project",
          aggregateId: ProjectId.makeUnsafe("project-clear-attachments"),
          occurredAt: now,
          commandId: CommandId.makeUnsafe("cmd-clear-attachments-1"),
          causationEventId: null,
          correlationId: CommandId.makeUnsafe("cmd-clear-attachments-1"),
          metadata: {},
          payload: {
            projectId: ProjectId.makeUnsafe("project-clear-attachments"),
            title: "Project Clear Attachments",
            workspaceRoot: "/tmp/project-clear-attachments",
            defaultModelSelection: null,
            scripts: [],
            createdAt: now,
            updatedAt: now,
          },
        });

        yield* eventStore.append({
          type: "workspace.created",
          eventId: EventId.makeUnsafe("evt-clear-attachments-2"),
          aggregateKind: "workspace",
          aggregateId: WorkspaceId.makeUnsafe("workspace-clear-attachments"),
          occurredAt: now,
          commandId: CommandId.makeUnsafe("cmd-clear-attachments-2"),
          causationEventId: null,
          correlationId: CommandId.makeUnsafe("cmd-clear-attachments-2"),
          metadata: {},
          payload: {
            workspaceId: WorkspaceId.makeUnsafe("workspace-clear-attachments"),
            projectId: ProjectId.makeUnsafe("project-clear-attachments"),
            title: "Workspace Clear Attachments",
            modelSelection: {
              provider: "codex",
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
          },
        });

        yield* eventStore.append({
          type: "workspace.message-sent",
          eventId: EventId.makeUnsafe("evt-clear-attachments-3"),
          aggregateKind: "workspace",
          aggregateId: WorkspaceId.makeUnsafe("workspace-clear-attachments"),
          occurredAt: now,
          commandId: CommandId.makeUnsafe("cmd-clear-attachments-3"),
          causationEventId: null,
          correlationId: CommandId.makeUnsafe("cmd-clear-attachments-3"),
          metadata: {},
          payload: {
            workspaceId: WorkspaceId.makeUnsafe("workspace-clear-attachments"),
            messageId: MessageId.makeUnsafe("message-clear-attachments"),
            role: "user",
            text: "Has attachments",
            attachments: [
              {
                type: "image",
                id: "workspace-clear-attachments-att-1",
                name: "clear.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        });

        yield* eventStore.append({
          type: "workspace.message-sent",
          eventId: EventId.makeUnsafe("evt-clear-attachments-4"),
          aggregateKind: "workspace",
          aggregateId: WorkspaceId.makeUnsafe("workspace-clear-attachments"),
          occurredAt: later,
          commandId: CommandId.makeUnsafe("cmd-clear-attachments-4"),
          causationEventId: null,
          correlationId: CommandId.makeUnsafe("cmd-clear-attachments-4"),
          metadata: {},
          payload: {
            workspaceId: WorkspaceId.makeUnsafe("workspace-clear-attachments"),
            messageId: MessageId.makeUnsafe("message-clear-attachments"),
            role: "user",
            text: "",
            attachments: [],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: later,
          },
        });

        yield* projectionPipeline.bootstrap;

        const rows = yield* sql<{
          readonly attachmentsJson: string | null;
        }>`
          SELECT
            attachments_json AS "attachmentsJson"
          FROM projection_workspace_messages
          WHERE message_id = 'message-clear-attachments'
        `;
        assert.equal(rows.length, 1);
        assert.deepEqual(JSON.parse(rows[0]?.attachmentsJson ?? "null"), []);
      }),
  );
});

it.layer(
  Layer.fresh(makeProjectionPipelinePrefixedTestLayer("matcha-projection-attachments-overwrite-")),
)("OrchestrationProjectionPipeline", (it) => {
  it.effect("overwrites stored attachment references when a message updates attachments", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();
      const later = new Date(Date.now() + 1_000).toISOString();

      yield* eventStore.append({
        type: "project.created",
        eventId: EventId.makeUnsafe("evt-overwrite-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.makeUnsafe("project-overwrite"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-overwrite-1"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-overwrite-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.makeUnsafe("project-overwrite"),
          title: "Project Overwrite",
          workspaceRoot: "/tmp/project-overwrite",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "workspace.created",
        eventId: EventId.makeUnsafe("evt-overwrite-2"),
        aggregateKind: "workspace",
        aggregateId: WorkspaceId.makeUnsafe("workspace-overwrite"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-overwrite-2"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-overwrite-2"),
        metadata: {},
        payload: {
          workspaceId: WorkspaceId.makeUnsafe("workspace-overwrite"),
          projectId: ProjectId.makeUnsafe("project-overwrite"),
          title: "Workspace Overwrite",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "workspace.message-sent",
        eventId: EventId.makeUnsafe("evt-overwrite-3"),
        aggregateKind: "workspace",
        aggregateId: WorkspaceId.makeUnsafe("workspace-overwrite"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-overwrite-3"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-overwrite-3"),
        metadata: {},
        payload: {
          workspaceId: WorkspaceId.makeUnsafe("workspace-overwrite"),
          messageId: MessageId.makeUnsafe("message-overwrite"),
          role: "user",
          text: "first image",
          attachments: [
            {
              type: "image",
              id: "workspace-overwrite-att-1",
              name: "file.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "workspace.message-sent",
        eventId: EventId.makeUnsafe("evt-overwrite-4"),
        aggregateKind: "workspace",
        aggregateId: WorkspaceId.makeUnsafe("workspace-overwrite"),
        occurredAt: later,
        commandId: CommandId.makeUnsafe("cmd-overwrite-4"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-overwrite-4"),
        metadata: {},
        payload: {
          workspaceId: WorkspaceId.makeUnsafe("workspace-overwrite"),
          messageId: MessageId.makeUnsafe("message-overwrite"),
          role: "user",
          text: "",
          attachments: [
            {
              type: "image",
              id: "workspace-overwrite-att-2",
              name: "file.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: later,
        },
      });

      yield* projectionPipeline.bootstrap;

      const rows = yield* sql<{
        readonly attachmentsJson: string | null;
      }>`
              SELECT attachments_json AS "attachmentsJson"
              FROM projection_workspace_messages
              WHERE message_id = 'message-overwrite'
            `;
      assert.equal(rows.length, 1);
      assert.deepEqual(JSON.parse(rows[0]?.attachmentsJson ?? "null"), [
        {
          type: "image",
          id: "workspace-overwrite-att-2",
          name: "file.png",
          mimeType: "image/png",
          sizeBytes: 5,
        },
      ]);
    }),
  );
});

it.layer(
  Layer.fresh(makeProjectionPipelinePrefixedTestLayer("matcha-projection-attachments-rollback-")),
)("OrchestrationProjectionPipeline", (it) => {
  it.effect("does not persist attachment files when projector transaction rolls back", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const path = yield* Path.Path;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();

      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      yield* appendAndProject({
        type: "project.created",
        eventId: EventId.makeUnsafe("evt-rollback-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.makeUnsafe("project-rollback"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-rollback-1"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-rollback-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.makeUnsafe("project-rollback"),
          title: "Project Rollback",
          workspaceRoot: "/tmp/project-rollback",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* appendAndProject({
        type: "workspace.created",
        eventId: EventId.makeUnsafe("evt-rollback-2"),
        aggregateKind: "workspace",
        aggregateId: WorkspaceId.makeUnsafe("workspace-rollback"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-rollback-2"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-rollback-2"),
        metadata: {},
        payload: {
          workspaceId: WorkspaceId.makeUnsafe("workspace-rollback"),
          projectId: ProjectId.makeUnsafe("project-rollback"),
          title: "Workspace Rollback",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* sql`
        CREATE TRIGGER fail_workspace_messages_projection_state_update
        BEFORE UPDATE ON projection_state
        WHEN NEW.projector = 'projection.workspace-messages'
        BEGIN
          SELECT RAISE(ABORT, 'forced-projection-state-failure');
        END;
      `;

      const result = yield* Effect.result(
        appendAndProject({
          type: "workspace.message-sent",
          eventId: EventId.makeUnsafe("evt-rollback-3"),
          aggregateKind: "workspace",
          aggregateId: WorkspaceId.makeUnsafe("workspace-rollback"),
          occurredAt: now,
          commandId: CommandId.makeUnsafe("cmd-rollback-3"),
          causationEventId: null,
          correlationId: CorrelationId.makeUnsafe("cmd-rollback-3"),
          metadata: {},
          payload: {
            workspaceId: WorkspaceId.makeUnsafe("workspace-rollback"),
            messageId: MessageId.makeUnsafe("message-rollback"),
            role: "user",
            text: "Rollback me",
            attachments: [
              {
                type: "image",
                id: "workspace-rollback-att-1",
                name: "rollback.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        }),
      );
      assert.equal(result._tag, "Failure");

      const rows = yield* sql<{
        readonly count: number;
      }>`
        SELECT COUNT(*) AS "count"
        FROM projection_workspace_messages
        WHERE message_id = 'message-rollback'
      `;
      assert.equal(rows[0]?.count ?? 0, 0);

      const { attachmentsDir } = yield* ServerConfig;
      const attachmentPath = path.join(attachmentsDir, "workspace-rollback-att-1.png");
      assert.isFalse(yield* exists(attachmentPath));
      yield* sql`DROP TRIGGER IF EXISTS fail_workspace_messages_projection_state_update`;
    }),
  );
});

it.layer(
  Layer.fresh(makeProjectionPipelinePrefixedTestLayer("matcha-projection-attachments-overwrite-")),
)("OrchestrationProjectionPipeline", (it) => {
  it.effect("removes unreferenced attachment files when a workspace is reverted", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const { attachmentsDir } = yield* ServerConfig;
      const now = new Date().toISOString();
      const workspaceId = WorkspaceId.makeUnsafe("Workspace Revert.Files");
      const keepAttachmentId = "workspace-revert-files-00000000-0000-4000-8000-000000000001";
      const removeAttachmentId = "workspace-revert-files-00000000-0000-4000-8000-000000000002";
      const otherWorkspaceAttachmentId =
        "workspace-revert-files-extra-00000000-0000-4000-8000-000000000003";

      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      yield* appendAndProject({
        type: "project.created",
        eventId: EventId.makeUnsafe("evt-revert-files-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.makeUnsafe("project-revert-files"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-revert-files-1"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-revert-files-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.makeUnsafe("project-revert-files"),
          title: "Project Revert Files",
          workspaceRoot: "/tmp/project-revert-files",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* appendAndProject({
        type: "workspace.created",
        eventId: EventId.makeUnsafe("evt-revert-files-2"),
        aggregateKind: "workspace",
        aggregateId: workspaceId,
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-revert-files-2"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-revert-files-2"),
        metadata: {},
        payload: {
          workspaceId,
          projectId: ProjectId.makeUnsafe("project-revert-files"),
          title: "Workspace Revert Files",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* appendAndProject({
        type: "workspace.turn-diff-completed",
        eventId: EventId.makeUnsafe("evt-revert-files-3"),
        aggregateKind: "workspace",
        aggregateId: workspaceId,
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-revert-files-3"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-revert-files-3"),
        metadata: {},
        payload: {
          workspaceId,
          turnId: TurnId.makeUnsafe("turn-keep"),
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.makeUnsafe(
            "refs/t3/checkpoints/workspace-revert-files/turn/1",
          ),
          status: "ready",
          files: [],
          assistantMessageId: MessageId.makeUnsafe("message-keep"),
          completedAt: now,
        },
      });

      yield* appendAndProject({
        type: "workspace.message-sent",
        eventId: EventId.makeUnsafe("evt-revert-files-4"),
        aggregateKind: "workspace",
        aggregateId: workspaceId,
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-revert-files-4"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-revert-files-4"),
        metadata: {},
        payload: {
          workspaceId,
          messageId: MessageId.makeUnsafe("message-keep"),
          role: "assistant",
          text: "Keep",
          attachments: [
            {
              type: "image",
              id: keepAttachmentId,
              name: "keep.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
          turnId: TurnId.makeUnsafe("turn-keep"),
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* appendAndProject({
        type: "workspace.turn-diff-completed",
        eventId: EventId.makeUnsafe("evt-revert-files-5"),
        aggregateKind: "workspace",
        aggregateId: workspaceId,
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-revert-files-5"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-revert-files-5"),
        metadata: {},
        payload: {
          workspaceId,
          turnId: TurnId.makeUnsafe("turn-remove"),
          checkpointTurnCount: 2,
          checkpointRef: CheckpointRef.makeUnsafe(
            "refs/t3/checkpoints/workspace-revert-files/turn/2",
          ),
          status: "ready",
          files: [],
          assistantMessageId: MessageId.makeUnsafe("message-remove"),
          completedAt: now,
        },
      });

      yield* appendAndProject({
        type: "workspace.message-sent",
        eventId: EventId.makeUnsafe("evt-revert-files-6"),
        aggregateKind: "workspace",
        aggregateId: workspaceId,
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-revert-files-6"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-revert-files-6"),
        metadata: {},
        payload: {
          workspaceId,
          messageId: MessageId.makeUnsafe("message-remove"),
          role: "assistant",
          text: "Remove",
          attachments: [
            {
              type: "image",
              id: removeAttachmentId,
              name: "remove.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
          turnId: TurnId.makeUnsafe("turn-remove"),
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      const keepPath = path.join(attachmentsDir, `${keepAttachmentId}.png`);
      const removePath = path.join(attachmentsDir, `${removeAttachmentId}.png`);
      yield* fileSystem.makeDirectory(attachmentsDir, { recursive: true });
      yield* fileSystem.writeFileString(keepPath, "keep");
      yield* fileSystem.writeFileString(removePath, "remove");
      const otherWorkspacePath = path.join(attachmentsDir, `${otherWorkspaceAttachmentId}.png`);
      yield* fileSystem.writeFileString(otherWorkspacePath, "other");
      assert.isTrue(yield* exists(keepPath));
      assert.isTrue(yield* exists(removePath));
      assert.isTrue(yield* exists(otherWorkspacePath));

      yield* appendAndProject({
        type: "workspace.reverted",
        eventId: EventId.makeUnsafe("evt-revert-files-7"),
        aggregateKind: "workspace",
        aggregateId: workspaceId,
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-revert-files-7"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-revert-files-7"),
        metadata: {},
        payload: {
          workspaceId,
          turnCount: 1,
        },
      });

      assert.isTrue(yield* exists(keepPath));
      assert.isFalse(yield* exists(removePath));
      assert.isTrue(yield* exists(otherWorkspacePath));
    }),
  );
});

it.layer(
  Layer.fresh(makeProjectionPipelinePrefixedTestLayer("matcha-projection-attachments-revert-")),
)("OrchestrationProjectionPipeline", (it) => {
  it.effect("removes workspace attachment directory when workspace is deleted", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const { attachmentsDir } = yield* ServerConfig;
      const now = new Date().toISOString();
      const workspaceId = WorkspaceId.makeUnsafe("Workspace Delete.Files");
      const attachmentId = "workspace-delete-files-00000000-0000-4000-8000-000000000001";
      const otherWorkspaceAttachmentId =
        "workspace-delete-files-extra-00000000-0000-4000-8000-000000000002";

      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      yield* appendAndProject({
        type: "project.created",
        eventId: EventId.makeUnsafe("evt-delete-files-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.makeUnsafe("project-delete-files"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-delete-files-1"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-delete-files-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.makeUnsafe("project-delete-files"),
          title: "Project Delete Files",
          workspaceRoot: "/tmp/project-delete-files",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* appendAndProject({
        type: "workspace.created",
        eventId: EventId.makeUnsafe("evt-delete-files-2"),
        aggregateKind: "workspace",
        aggregateId: workspaceId,
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-delete-files-2"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-delete-files-2"),
        metadata: {},
        payload: {
          workspaceId,
          projectId: ProjectId.makeUnsafe("project-delete-files"),
          title: "Workspace Delete Files",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* appendAndProject({
        type: "workspace.message-sent",
        eventId: EventId.makeUnsafe("evt-delete-files-3"),
        aggregateKind: "workspace",
        aggregateId: workspaceId,
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-delete-files-3"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-delete-files-3"),
        metadata: {},
        payload: {
          workspaceId,
          messageId: MessageId.makeUnsafe("message-delete-files"),
          role: "user",
          text: "Delete",
          attachments: [
            {
              type: "image",
              id: attachmentId,
              name: "delete.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      const workspaceAttachmentPath = path.join(attachmentsDir, `${attachmentId}.png`);
      const otherWorkspaceAttachmentPath = path.join(
        attachmentsDir,
        `${otherWorkspaceAttachmentId}.png`,
      );
      yield* fileSystem.makeDirectory(attachmentsDir, { recursive: true });
      yield* fileSystem.writeFileString(workspaceAttachmentPath, "delete");
      yield* fileSystem.writeFileString(otherWorkspaceAttachmentPath, "other-workspace");
      assert.isTrue(yield* exists(workspaceAttachmentPath));
      assert.isTrue(yield* exists(otherWorkspaceAttachmentPath));

      yield* appendAndProject({
        type: "workspace.deleted",
        eventId: EventId.makeUnsafe("evt-delete-files-4"),
        aggregateKind: "workspace",
        aggregateId: workspaceId,
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-delete-files-4"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-delete-files-4"),
        metadata: {},
        payload: {
          workspaceId,
          deletedAt: now,
        },
      });

      assert.isFalse(yield* exists(workspaceAttachmentPath));
      assert.isTrue(yield* exists(otherWorkspaceAttachmentPath));
    }),
  );
});

it.layer(
  Layer.fresh(makeProjectionPipelinePrefixedTestLayer("matcha-projection-attachments-delete-")),
)("OrchestrationProjectionPipeline", (it) => {
  it.effect("ignores unsafe workspace ids for attachment cleanup paths", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const now = new Date().toISOString();
      const { attachmentsDir: attachmentsRootDir, stateDir } = yield* ServerConfig;
      const attachmentsSentinelPath = path.join(attachmentsRootDir, "sentinel.txt");
      const stateDirSentinelPath = path.join(stateDir, "state-sentinel.txt");
      yield* fileSystem.makeDirectory(attachmentsRootDir, { recursive: true });
      yield* fileSystem.writeFileString(attachmentsSentinelPath, "keep-attachments-root");
      yield* fileSystem.writeFileString(stateDirSentinelPath, "keep-state-dir");

      yield* eventStore.append({
        type: "workspace.deleted",
        eventId: EventId.makeUnsafe("evt-unsafe-workspace-delete"),
        aggregateKind: "workspace",
        aggregateId: WorkspaceId.makeUnsafe(".."),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-unsafe-workspace-delete"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-unsafe-workspace-delete"),
        metadata: {},
        payload: {
          workspaceId: WorkspaceId.makeUnsafe(".."),
          deletedAt: now,
        },
      });

      yield* projectionPipeline.bootstrap;

      assert.isTrue(yield* exists(attachmentsRootDir));
      assert.isTrue(yield* exists(attachmentsSentinelPath));
      assert.isTrue(yield* exists(stateDirSentinelPath));
    }),
  );
});

it.layer(BaseTestLayer)("OrchestrationProjectionPipeline", (it) => {
  it.effect("resumes from projector last_applied_sequence without replaying older events", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();

      yield* eventStore.append({
        type: "project.created",
        eventId: EventId.makeUnsafe("evt-a1"),
        aggregateKind: "project",
        aggregateId: ProjectId.makeUnsafe("project-a"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-a1"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-a1"),
        metadata: {},
        payload: {
          projectId: ProjectId.makeUnsafe("project-a"),
          title: "Project A",
          workspaceRoot: "/tmp/project-a",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "workspace.created",
        eventId: EventId.makeUnsafe("evt-a2"),
        aggregateKind: "workspace",
        aggregateId: WorkspaceId.makeUnsafe("workspace-a"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-a2"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-a2"),
        metadata: {},
        payload: {
          workspaceId: WorkspaceId.makeUnsafe("workspace-a"),
          projectId: ProjectId.makeUnsafe("project-a"),
          title: "Workspace A",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "workspace.message-sent",
        eventId: EventId.makeUnsafe("evt-a3"),
        aggregateKind: "workspace",
        aggregateId: WorkspaceId.makeUnsafe("workspace-a"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-a3"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-a3"),
        metadata: {},
        payload: {
          workspaceId: WorkspaceId.makeUnsafe("workspace-a"),
          messageId: MessageId.makeUnsafe("message-a"),
          role: "assistant",
          text: "hello",
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* projectionPipeline.bootstrap;

      yield* eventStore.append({
        type: "workspace.message-sent",
        eventId: EventId.makeUnsafe("evt-a4"),
        aggregateKind: "workspace",
        aggregateId: WorkspaceId.makeUnsafe("workspace-a"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-a4"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-a4"),
        metadata: {},
        payload: {
          workspaceId: WorkspaceId.makeUnsafe("workspace-a"),
          messageId: MessageId.makeUnsafe("message-a"),
          role: "assistant",
          text: " world",
          turnId: null,
          streaming: true,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* projectionPipeline.bootstrap;
      yield* projectionPipeline.bootstrap;

      const messageRows = yield* sql<{ readonly text: string }>`
        SELECT text FROM projection_workspace_messages WHERE message_id = 'message-a'
      `;
      assert.deepEqual(messageRows, [{ text: "hello world" }]);

      const stateRows = yield* sql<{
        readonly projector: string;
        readonly lastAppliedSequence: number;
      }>`
        SELECT
          projector,
          last_applied_sequence AS "lastAppliedSequence"
        FROM projection_state
      `;
      const maxSequenceRows = yield* sql<{ readonly maxSequence: number }>`
        SELECT MAX(sequence) AS "maxSequence" FROM orchestration_events
      `;
      const maxSequence = maxSequenceRows[0]?.maxSequence ?? 0;
      for (const row of stateRows) {
        assert.equal(row.lastAppliedSequence, maxSequence);
      }
    }),
  );

  it.effect("keeps accumulated assistant text when completion payload text is empty", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();

      yield* eventStore.append({
        type: "project.created",
        eventId: EventId.makeUnsafe("evt-empty-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.makeUnsafe("project-empty"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-empty-1"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-empty-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.makeUnsafe("project-empty"),
          title: "Project Empty",
          workspaceRoot: "/tmp/project-empty",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "workspace.created",
        eventId: EventId.makeUnsafe("evt-empty-2"),
        aggregateKind: "workspace",
        aggregateId: WorkspaceId.makeUnsafe("workspace-empty"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-empty-2"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-empty-2"),
        metadata: {},
        payload: {
          workspaceId: WorkspaceId.makeUnsafe("workspace-empty"),
          projectId: ProjectId.makeUnsafe("project-empty"),
          title: "Workspace Empty",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "workspace.message-sent",
        eventId: EventId.makeUnsafe("evt-empty-3"),
        aggregateKind: "workspace",
        aggregateId: WorkspaceId.makeUnsafe("workspace-empty"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-empty-3"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-empty-3"),
        metadata: {},
        payload: {
          workspaceId: WorkspaceId.makeUnsafe("workspace-empty"),
          messageId: MessageId.makeUnsafe("assistant-empty"),
          role: "assistant",
          text: "Hello",
          turnId: null,
          streaming: true,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "workspace.message-sent",
        eventId: EventId.makeUnsafe("evt-empty-4"),
        aggregateKind: "workspace",
        aggregateId: WorkspaceId.makeUnsafe("workspace-empty"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-empty-4"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-empty-4"),
        metadata: {},
        payload: {
          workspaceId: WorkspaceId.makeUnsafe("workspace-empty"),
          messageId: MessageId.makeUnsafe("assistant-empty"),
          role: "assistant",
          text: " world",
          turnId: null,
          streaming: true,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "workspace.message-sent",
        eventId: EventId.makeUnsafe("evt-empty-5"),
        aggregateKind: "workspace",
        aggregateId: WorkspaceId.makeUnsafe("workspace-empty"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-empty-5"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-empty-5"),
        metadata: {},
        payload: {
          workspaceId: WorkspaceId.makeUnsafe("workspace-empty"),
          messageId: MessageId.makeUnsafe("assistant-empty"),
          role: "assistant",
          text: "",
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* projectionPipeline.bootstrap;

      const messageRows = yield* sql<{ readonly text: string; readonly isStreaming: unknown }>`
        SELECT
          text,
          is_streaming AS "isStreaming"
        FROM projection_workspace_messages
        WHERE message_id = 'assistant-empty'
      `;
      assert.equal(messageRows.length, 1);
      assert.equal(messageRows[0]?.text, "Hello world");
      assert.isFalse(Boolean(messageRows[0]?.isStreaming));
    }),
  );

  it.effect(
    "resolves turn-count conflicts when checkpoint completion rewrites provisional turns",
    () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
          eventStore
            .append(event)
            .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

        yield* appendAndProject({
          type: "project.created",
          eventId: EventId.makeUnsafe("evt-conflict-1"),
          aggregateKind: "project",
          aggregateId: ProjectId.makeUnsafe("project-conflict"),
          occurredAt: "2026-02-26T13:00:00.000Z",
          commandId: CommandId.makeUnsafe("cmd-conflict-1"),
          causationEventId: null,
          correlationId: CorrelationId.makeUnsafe("cmd-conflict-1"),
          metadata: {},
          payload: {
            projectId: ProjectId.makeUnsafe("project-conflict"),
            title: "Project Conflict",
            workspaceRoot: "/tmp/project-conflict",
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-02-26T13:00:00.000Z",
            updatedAt: "2026-02-26T13:00:00.000Z",
          },
        });

        yield* appendAndProject({
          type: "workspace.created",
          eventId: EventId.makeUnsafe("evt-conflict-2"),
          aggregateKind: "workspace",
          aggregateId: WorkspaceId.makeUnsafe("workspace-conflict"),
          occurredAt: "2026-02-26T13:00:01.000Z",
          commandId: CommandId.makeUnsafe("cmd-conflict-2"),
          causationEventId: null,
          correlationId: CorrelationId.makeUnsafe("cmd-conflict-2"),
          metadata: {},
          payload: {
            workspaceId: WorkspaceId.makeUnsafe("workspace-conflict"),
            projectId: ProjectId.makeUnsafe("project-conflict"),
            title: "Workspace Conflict",
            modelSelection: {
              provider: "codex",
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: "2026-02-26T13:00:01.000Z",
            updatedAt: "2026-02-26T13:00:01.000Z",
          },
        });

        yield* appendAndProject({
          type: "workspace.turn-interrupt-requested",
          eventId: EventId.makeUnsafe("evt-conflict-3"),
          aggregateKind: "workspace",
          aggregateId: WorkspaceId.makeUnsafe("workspace-conflict"),
          occurredAt: "2026-02-26T13:00:02.000Z",
          commandId: CommandId.makeUnsafe("cmd-conflict-3"),
          causationEventId: null,
          correlationId: CorrelationId.makeUnsafe("cmd-conflict-3"),
          metadata: {},
          payload: {
            workspaceId: WorkspaceId.makeUnsafe("workspace-conflict"),
            turnId: TurnId.makeUnsafe("turn-interrupted"),
            createdAt: "2026-02-26T13:00:02.000Z",
          },
        });

        yield* appendAndProject({
          type: "workspace.message-sent",
          eventId: EventId.makeUnsafe("evt-conflict-4"),
          aggregateKind: "workspace",
          aggregateId: WorkspaceId.makeUnsafe("workspace-conflict"),
          occurredAt: "2026-02-26T13:00:03.000Z",
          commandId: CommandId.makeUnsafe("cmd-conflict-4"),
          causationEventId: null,
          correlationId: CorrelationId.makeUnsafe("cmd-conflict-4"),
          metadata: {},
          payload: {
            workspaceId: WorkspaceId.makeUnsafe("workspace-conflict"),
            messageId: MessageId.makeUnsafe("assistant-conflict"),
            role: "assistant",
            text: "done",
            turnId: TurnId.makeUnsafe("turn-completed"),
            streaming: false,
            createdAt: "2026-02-26T13:00:03.000Z",
            updatedAt: "2026-02-26T13:00:03.000Z",
          },
        });

        yield* appendAndProject({
          type: "workspace.turn-diff-completed",
          eventId: EventId.makeUnsafe("evt-conflict-5"),
          aggregateKind: "workspace",
          aggregateId: WorkspaceId.makeUnsafe("workspace-conflict"),
          occurredAt: "2026-02-26T13:00:04.000Z",
          commandId: CommandId.makeUnsafe("cmd-conflict-5"),
          causationEventId: null,
          correlationId: CorrelationId.makeUnsafe("cmd-conflict-5"),
          metadata: {},
          payload: {
            workspaceId: WorkspaceId.makeUnsafe("workspace-conflict"),
            turnId: TurnId.makeUnsafe("turn-completed"),
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.makeUnsafe(
              "refs/t3/checkpoints/workspace-conflict/turn/1",
            ),
            status: "ready",
            files: [],
            assistantMessageId: MessageId.makeUnsafe("assistant-conflict"),
            completedAt: "2026-02-26T13:00:04.000Z",
          },
        });

        const turnRows = yield* sql<{
          readonly turnId: string;
          readonly checkpointTurnCount: number | null;
          readonly status: string;
        }>`
        SELECT
          turn_id AS "turnId",
          checkpoint_turn_count AS "checkpointTurnCount",
          state AS "status"
        FROM projection_turns
        WHERE workspace_id = 'workspace-conflict'
        ORDER BY
          CASE
            WHEN checkpoint_turn_count IS NULL THEN 1
            ELSE 0
          END ASC,
          checkpoint_turn_count ASC,
          requested_at ASC
      `;
        assert.deepEqual(turnRows, [
          { turnId: "turn-completed", checkpointTurnCount: 1, status: "completed" },
          { turnId: "turn-interrupted", checkpointTurnCount: null, status: "interrupted" },
        ]);
      }),
  );

  it.effect("does not fallback-retain messages whose turnId is removed by revert", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      yield* appendAndProject({
        type: "project.created",
        eventId: EventId.makeUnsafe("evt-revert-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.makeUnsafe("project-revert"),
        occurredAt: "2026-02-26T12:00:00.000Z",
        commandId: CommandId.makeUnsafe("cmd-revert-1"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-revert-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.makeUnsafe("project-revert"),
          title: "Project Revert",
          workspaceRoot: "/tmp/project-revert",
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-02-26T12:00:00.000Z",
          updatedAt: "2026-02-26T12:00:00.000Z",
        },
      });

      yield* appendAndProject({
        type: "workspace.created",
        eventId: EventId.makeUnsafe("evt-revert-2"),
        aggregateKind: "workspace",
        aggregateId: WorkspaceId.makeUnsafe("workspace-revert"),
        occurredAt: "2026-02-26T12:00:01.000Z",
        commandId: CommandId.makeUnsafe("cmd-revert-2"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-revert-2"),
        metadata: {},
        payload: {
          workspaceId: WorkspaceId.makeUnsafe("workspace-revert"),
          projectId: ProjectId.makeUnsafe("project-revert"),
          title: "Workspace Revert",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: "2026-02-26T12:00:01.000Z",
          updatedAt: "2026-02-26T12:00:01.000Z",
        },
      });

      yield* appendAndProject({
        type: "workspace.turn-diff-completed",
        eventId: EventId.makeUnsafe("evt-revert-3"),
        aggregateKind: "workspace",
        aggregateId: WorkspaceId.makeUnsafe("workspace-revert"),
        occurredAt: "2026-02-26T12:00:02.000Z",
        commandId: CommandId.makeUnsafe("cmd-revert-3"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-revert-3"),
        metadata: {},
        payload: {
          workspaceId: WorkspaceId.makeUnsafe("workspace-revert"),
          turnId: TurnId.makeUnsafe("turn-1"),
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.makeUnsafe("refs/t3/checkpoints/workspace-revert/turn/1"),
          status: "ready",
          files: [],
          assistantMessageId: MessageId.makeUnsafe("assistant-keep"),
          completedAt: "2026-02-26T12:00:02.000Z",
        },
      });

      yield* appendAndProject({
        type: "workspace.message-sent",
        eventId: EventId.makeUnsafe("evt-revert-4"),
        aggregateKind: "workspace",
        aggregateId: WorkspaceId.makeUnsafe("workspace-revert"),
        occurredAt: "2026-02-26T12:00:02.100Z",
        commandId: CommandId.makeUnsafe("cmd-revert-4"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-revert-4"),
        metadata: {},
        payload: {
          workspaceId: WorkspaceId.makeUnsafe("workspace-revert"),
          messageId: MessageId.makeUnsafe("assistant-keep"),
          role: "assistant",
          text: "kept",
          turnId: TurnId.makeUnsafe("turn-1"),
          streaming: false,
          createdAt: "2026-02-26T12:00:02.100Z",
          updatedAt: "2026-02-26T12:00:02.100Z",
        },
      });

      yield* appendAndProject({
        type: "workspace.turn-diff-completed",
        eventId: EventId.makeUnsafe("evt-revert-5"),
        aggregateKind: "workspace",
        aggregateId: WorkspaceId.makeUnsafe("workspace-revert"),
        occurredAt: "2026-02-26T12:00:03.000Z",
        commandId: CommandId.makeUnsafe("cmd-revert-5"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-revert-5"),
        metadata: {},
        payload: {
          workspaceId: WorkspaceId.makeUnsafe("workspace-revert"),
          turnId: TurnId.makeUnsafe("turn-2"),
          checkpointTurnCount: 2,
          checkpointRef: CheckpointRef.makeUnsafe("refs/t3/checkpoints/workspace-revert/turn/2"),
          status: "ready",
          files: [],
          assistantMessageId: MessageId.makeUnsafe("assistant-remove"),
          completedAt: "2026-02-26T12:00:03.000Z",
        },
      });

      yield* appendAndProject({
        type: "workspace.message-sent",
        eventId: EventId.makeUnsafe("evt-revert-6"),
        aggregateKind: "workspace",
        aggregateId: WorkspaceId.makeUnsafe("workspace-revert"),
        occurredAt: "2026-02-26T12:00:03.050Z",
        commandId: CommandId.makeUnsafe("cmd-revert-6"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-revert-6"),
        metadata: {},
        payload: {
          workspaceId: WorkspaceId.makeUnsafe("workspace-revert"),
          messageId: MessageId.makeUnsafe("user-remove"),
          role: "user",
          text: "removed",
          turnId: TurnId.makeUnsafe("turn-2"),
          streaming: false,
          createdAt: "2026-02-26T12:00:03.050Z",
          updatedAt: "2026-02-26T12:00:03.050Z",
        },
      });

      yield* appendAndProject({
        type: "workspace.message-sent",
        eventId: EventId.makeUnsafe("evt-revert-7"),
        aggregateKind: "workspace",
        aggregateId: WorkspaceId.makeUnsafe("workspace-revert"),
        occurredAt: "2026-02-26T12:00:03.100Z",
        commandId: CommandId.makeUnsafe("cmd-revert-7"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-revert-7"),
        metadata: {},
        payload: {
          workspaceId: WorkspaceId.makeUnsafe("workspace-revert"),
          messageId: MessageId.makeUnsafe("assistant-remove"),
          role: "assistant",
          text: "removed",
          turnId: TurnId.makeUnsafe("turn-2"),
          streaming: false,
          createdAt: "2026-02-26T12:00:03.100Z",
          updatedAt: "2026-02-26T12:00:03.100Z",
        },
      });

      yield* appendAndProject({
        type: "workspace.reverted",
        eventId: EventId.makeUnsafe("evt-revert-8"),
        aggregateKind: "workspace",
        aggregateId: WorkspaceId.makeUnsafe("workspace-revert"),
        occurredAt: "2026-02-26T12:00:04.000Z",
        commandId: CommandId.makeUnsafe("cmd-revert-8"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-revert-8"),
        metadata: {},
        payload: {
          workspaceId: WorkspaceId.makeUnsafe("workspace-revert"),
          turnCount: 1,
        },
      });

      const messageRows = yield* sql<{
        readonly messageId: string;
        readonly turnId: string | null;
        readonly role: string;
      }>`
        SELECT
          message_id AS "messageId",
          turn_id AS "turnId",
          role
        FROM projection_workspace_messages
        WHERE workspace_id = 'workspace-revert'
        ORDER BY created_at ASC, message_id ASC
      `;
      assert.deepEqual(messageRows, [
        {
          messageId: "assistant-keep",
          turnId: "turn-1",
          role: "assistant",
        },
      ]);
    }),
  );
});

it.effect("restores pending turn-start metadata across projection pipeline restart", () =>
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig;
    const persistenceLayer = makeSqlitePersistenceLive(dbPath);
    const firstProjectionLayer = OrchestrationProjectionPipelineLive.pipe(
      Layer.provideMerge(OrchestrationEventStoreLive),
      Layer.provideMerge(persistenceLayer),
    );
    const secondProjectionLayer = OrchestrationProjectionPipelineLive.pipe(
      Layer.provideMerge(OrchestrationEventStoreLive),
      Layer.provideMerge(persistenceLayer),
    );

    const workspaceId = WorkspaceId.makeUnsafe("workspace-restart");
    const turnId = TurnId.makeUnsafe("turn-restart");
    const messageId = MessageId.makeUnsafe("message-restart");
    const sourcePlanWorkspaceId = WorkspaceId.makeUnsafe("workspace-plan-source");
    const sourcePlanId = "plan-source";
    const turnStartedAt = "2026-02-26T14:00:00.000Z";
    const sessionSetAt = "2026-02-26T14:00:05.000Z";

    yield* Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;

      yield* eventStore.append({
        type: "workspace.turn-start-requested",
        eventId: EventId.makeUnsafe("evt-restart-1"),
        aggregateKind: "workspace",
        aggregateId: workspaceId,
        occurredAt: turnStartedAt,
        commandId: CommandId.makeUnsafe("cmd-restart-1"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-restart-1"),
        metadata: {},
        payload: {
          workspaceId,
          messageId,
          sourceProposedPlan: {
            workspaceId: sourcePlanWorkspaceId,
            planId: sourcePlanId,
          },
          runtimeMode: "approval-required",
          createdAt: turnStartedAt,
        },
      });

      yield* projectionPipeline.bootstrap;
    }).pipe(Effect.provide(firstProjectionLayer));

    const turnRows = yield* Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;

      yield* eventStore.append({
        type: "workspace.session-set",
        eventId: EventId.makeUnsafe("evt-restart-2"),
        aggregateKind: "workspace",
        aggregateId: workspaceId,
        occurredAt: sessionSetAt,
        commandId: CommandId.makeUnsafe("cmd-restart-2"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-restart-2"),
        metadata: {},
        payload: {
          workspaceId,
          session: {
            workspaceId,
            status: "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: sessionSetAt,
          },
        },
      });

      yield* projectionPipeline.bootstrap;

      const pendingRows = yield* sql<{ readonly workspaceId: string }>`
        SELECT workspace_id AS "workspaceId"
        FROM projection_turns
        WHERE workspace_id = ${workspaceId}
          AND turn_id IS NULL
          AND state = 'pending'
      `;
      assert.deepEqual(pendingRows, []);

      return yield* sql<{
        readonly turnId: string;
        readonly userMessageId: string | null;
        readonly sourceProposedPlanWorkspaceId: string | null;
        readonly sourceProposedPlanId: string | null;
        readonly startedAt: string;
      }>`
        SELECT
          turn_id AS "turnId",
          pending_message_id AS "userMessageId",
          source_proposed_plan_workspace_id AS "sourceProposedPlanWorkspaceId",
          source_proposed_plan_id AS "sourceProposedPlanId",
          started_at AS "startedAt"
        FROM projection_turns
        WHERE turn_id = ${turnId}
      `;
    }).pipe(Effect.provide(secondProjectionLayer));

    assert.deepEqual(turnRows, [
      {
        turnId: "turn-restart",
        userMessageId: "message-restart",
        sourceProposedPlanWorkspaceId: "workspace-plan-source",
        sourceProposedPlanId: "plan-source",
        startedAt: turnStartedAt,
      },
    ]);
  }).pipe(
    Effect.provide(
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "matcha-projection-pipeline-restart-",
        }),
        NodeServices.layer,
      ),
    ),
  ),
);

const engineLayer = it.layer(
  OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "matcha-projection-pipeline-engine-dispatch-",
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

engineLayer("OrchestrationProjectionPipeline via engine dispatch", (it) => {
  it.effect("projects dispatched engine events immediately", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const sql = yield* SqlClient.SqlClient;
      const createdAt = new Date().toISOString();

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-live-project"),
        projectId: ProjectId.makeUnsafe("project-live"),
        title: "Live Project",
        workspaceRoot: "/tmp/project-live",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        createdAt,
      });

      const projectRows = yield* sql<{ readonly title: string; readonly scriptsJson: string }>`
        SELECT
          title,
          scripts_json AS "scriptsJson"
        FROM projection_projects
        WHERE project_id = 'project-live'
      `;
      assert.deepEqual(projectRows, [{ title: "Live Project", scriptsJson: "[]" }]);

      const projectorRows = yield* sql<{ readonly lastAppliedSequence: number }>`
        SELECT
          last_applied_sequence AS "lastAppliedSequence"
        FROM projection_state
        WHERE projector = 'projection.projects'
      `;
      assert.deepEqual(projectorRows, [{ lastAppliedSequence: 1 }]);
    }),
  );

  it.effect("projects persist updated scripts from project.meta.update", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const sql = yield* SqlClient.SqlClient;
      const createdAt = new Date().toISOString();

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-scripts-project-create"),
        projectId: ProjectId.makeUnsafe("project-scripts"),
        title: "Scripts Project",
        workspaceRoot: "/tmp/project-scripts",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        createdAt,
      });

      yield* engine.dispatch({
        type: "project.meta.update",
        commandId: CommandId.makeUnsafe("cmd-scripts-project-update"),
        projectId: ProjectId.makeUnsafe("project-scripts"),
        scripts: [
          {
            id: "script-1",
            name: "Build",
            command: "bun run build",
            icon: "build",
            runOnWorktreeCreate: false,
          },
        ],
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
      });

      const projectRows = yield* sql<{
        readonly scriptsJson: string;
        readonly defaultModelSelection: string;
      }>`
        SELECT
          scripts_json AS "scriptsJson",
          default_model_selection_json AS "defaultModelSelection"
        FROM projection_projects
        WHERE project_id = 'project-scripts'
      `;
      assert.deepEqual(projectRows, [
        {
          scriptsJson:
            '[{"id":"script-1","name":"Build","command":"bun run build","icon":"build","runOnWorktreeCreate":false}]',
          defaultModelSelection: '{"provider":"codex","model":"gpt-5"}',
        },
      ]);
    }),
  );
});
