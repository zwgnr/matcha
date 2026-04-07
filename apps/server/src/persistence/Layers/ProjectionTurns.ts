import { OrchestrationCheckpointFile } from "@matcha/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema, Struct } from "effect";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  ClearCheckpointTurnConflictInput,
  DeleteProjectionTurnsByWorkspaceInput,
  GetProjectionPendingTurnStartInput,
  GetProjectionTurnByTurnIdInput,
  ListProjectionTurnsByWorkspaceInput,
  ProjectionPendingTurnStart,
  ProjectionTurn,
  ProjectionTurnById,
  ProjectionTurnRepository,
  type ProjectionTurnRepositoryShape,
} from "../Services/ProjectionTurns.ts";

const ProjectionTurnDbRowSchema = ProjectionTurn.mapFields(
  Struct.assign({
    checkpointFiles: Schema.fromJsonString(Schema.Array(OrchestrationCheckpointFile)),
  }),
);

const ProjectionTurnByIdDbRowSchema = ProjectionTurnById.mapFields(
  Struct.assign({
    checkpointFiles: Schema.fromJsonString(Schema.Array(OrchestrationCheckpointFile)),
  }),
);

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeProjectionTurnRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionTurnById = SqlSchema.void({
    Request: ProjectionTurnByIdDbRowSchema,
    execute: (row) =>
      sql`
        INSERT INTO projection_turns (
          workspace_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_workspace_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES (
          ${row.workspaceId},
          ${row.turnId},
          ${row.pendingMessageId},
          ${row.sourceProposedPlanWorkspaceId},
          ${row.sourceProposedPlanId},
          ${row.assistantMessageId},
          ${row.state},
          ${row.requestedAt},
          ${row.startedAt},
          ${row.completedAt},
          ${row.checkpointTurnCount},
          ${row.checkpointRef},
          ${row.checkpointStatus},
          ${row.checkpointFiles}
        )
        ON CONFLICT (workspace_id, turn_id)
        DO UPDATE SET
          pending_message_id = excluded.pending_message_id,
          source_proposed_plan_workspace_id = excluded.source_proposed_plan_workspace_id,
          source_proposed_plan_id = excluded.source_proposed_plan_id,
          assistant_message_id = excluded.assistant_message_id,
          state = excluded.state,
          requested_at = excluded.requested_at,
          started_at = excluded.started_at,
          completed_at = excluded.completed_at,
          checkpoint_turn_count = excluded.checkpoint_turn_count,
          checkpoint_ref = excluded.checkpoint_ref,
          checkpoint_status = excluded.checkpoint_status,
          checkpoint_files_json = excluded.checkpoint_files_json
      `,
  });

  const clearPendingProjectionTurnsByWorkspace = SqlSchema.void({
    Request: DeleteProjectionTurnsByWorkspaceInput,
    execute: ({ workspaceId }) =>
      sql`
        DELETE FROM projection_turns
        WHERE workspace_id = ${workspaceId}
          AND turn_id IS NULL
          AND state = 'pending'
          AND checkpoint_turn_count IS NULL
      `,
  });

  const insertPendingProjectionTurn = SqlSchema.void({
    Request: ProjectionPendingTurnStart,
    execute: (row) =>
      sql`
        INSERT INTO projection_turns (
          workspace_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_workspace_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES (
          ${row.workspaceId},
          NULL,
          ${row.messageId},
          ${row.sourceProposedPlanWorkspaceId},
          ${row.sourceProposedPlanId},
          NULL,
          'pending',
          ${row.requestedAt},
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          '[]'
        )
      `,
  });

  const getPendingProjectionTurn = SqlSchema.findOneOption({
    Request: GetProjectionPendingTurnStartInput,
    Result: ProjectionPendingTurnStart,
    execute: ({ workspaceId }) =>
      sql`
        SELECT
          workspace_id AS "workspaceId",
          pending_message_id AS "messageId",
          source_proposed_plan_workspace_id AS "sourceProposedPlanWorkspaceId",
          source_proposed_plan_id AS "sourceProposedPlanId",
          requested_at AS "requestedAt"
        FROM projection_turns
        WHERE workspace_id = ${workspaceId}
          AND turn_id IS NULL
          AND state = 'pending'
          AND pending_message_id IS NOT NULL
          AND checkpoint_turn_count IS NULL
        ORDER BY requested_at DESC
        LIMIT 1
      `,
  });

  const listProjectionTurnsByWorkspace = SqlSchema.findAll({
    Request: ListProjectionTurnsByWorkspaceInput,
    Result: ProjectionTurnDbRowSchema,
    execute: ({ workspaceId }) =>
      sql`
        SELECT
          workspace_id AS "workspaceId",
          turn_id AS "turnId",
          pending_message_id AS "pendingMessageId",
          source_proposed_plan_workspace_id AS "sourceProposedPlanWorkspaceId",
          source_proposed_plan_id AS "sourceProposedPlanId",
          assistant_message_id AS "assistantMessageId",
          state,
          requested_at AS "requestedAt",
          started_at AS "startedAt",
          completed_at AS "completedAt",
          checkpoint_turn_count AS "checkpointTurnCount",
          checkpoint_ref AS "checkpointRef",
          checkpoint_status AS "checkpointStatus",
          checkpoint_files_json AS "checkpointFiles"
        FROM projection_turns
        WHERE workspace_id = ${workspaceId}
        ORDER BY
          CASE
            WHEN checkpoint_turn_count IS NULL THEN 1
            ELSE 0
          END ASC,
          checkpoint_turn_count ASC,
          requested_at ASC,
          turn_id ASC
      `,
  });

  const getProjectionTurnByTurnId = SqlSchema.findOneOption({
    Request: GetProjectionTurnByTurnIdInput,
    Result: ProjectionTurnByIdDbRowSchema,
    execute: ({ workspaceId, turnId }) =>
      sql`
        SELECT
          workspace_id AS "workspaceId",
          turn_id AS "turnId",
          pending_message_id AS "pendingMessageId",
          source_proposed_plan_workspace_id AS "sourceProposedPlanWorkspaceId",
          source_proposed_plan_id AS "sourceProposedPlanId",
          assistant_message_id AS "assistantMessageId",
          state,
          requested_at AS "requestedAt",
          started_at AS "startedAt",
          completed_at AS "completedAt",
          checkpoint_turn_count AS "checkpointTurnCount",
          checkpoint_ref AS "checkpointRef",
          checkpoint_status AS "checkpointStatus",
          checkpoint_files_json AS "checkpointFiles"
        FROM projection_turns
        WHERE workspace_id = ${workspaceId}
          AND turn_id = ${turnId}
        LIMIT 1
      `,
  });

  const clearCheckpointTurnConflictRow = SqlSchema.void({
    Request: ClearCheckpointTurnConflictInput,
    execute: ({ workspaceId, turnId, checkpointTurnCount }) =>
      sql`
        UPDATE projection_turns
        SET
          checkpoint_turn_count = NULL,
          checkpoint_ref = NULL,
          checkpoint_status = NULL,
          checkpoint_files_json = '[]'
        WHERE workspace_id = ${workspaceId}
          AND checkpoint_turn_count = ${checkpointTurnCount}
          AND (turn_id IS NULL OR turn_id <> ${turnId})
      `,
  });

  const deleteProjectionTurnsByWorkspace = SqlSchema.void({
    Request: DeleteProjectionTurnsByWorkspaceInput,
    execute: ({ workspaceId }) =>
      sql`
        DELETE FROM projection_turns
        WHERE workspace_id = ${workspaceId}
      `,
  });

  const upsertByTurnId: ProjectionTurnRepositoryShape["upsertByTurnId"] = (row) =>
    upsertProjectionTurnById(row).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionTurnRepository.upsertByTurnId:query",
          "ProjectionTurnRepository.upsertByTurnId:encodeRequest",
        ),
      ),
    );

  const replacePendingTurnStart: ProjectionTurnRepositoryShape["replacePendingTurnStart"] = (row) =>
    sql
      .withTransaction(
        clearPendingProjectionTurnsByWorkspace({ workspaceId: row.workspaceId }).pipe(
          Effect.flatMap(() => insertPendingProjectionTurn(row)),
        ),
      )
      .pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionTurnRepository.replacePendingTurnStart:query",
            "ProjectionTurnRepository.replacePendingTurnStart:encodeRequest",
          ),
        ),
      );

  const getPendingTurnStartByWorkspaceId: ProjectionTurnRepositoryShape["getPendingTurnStartByWorkspaceId"] =
    (input) =>
      getPendingProjectionTurn(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionTurnRepository.getPendingTurnStartByWorkspaceId:query"),
        ),
      );

  const deletePendingTurnStartByWorkspaceId: ProjectionTurnRepositoryShape["deletePendingTurnStartByWorkspaceId"] =
    (input) =>
      clearPendingProjectionTurnsByWorkspace(input).pipe(
        Effect.mapError(
          toPersistenceSqlError(
            "ProjectionTurnRepository.deletePendingTurnStartByWorkspaceId:query",
          ),
        ),
      );

  const listByWorkspaceId: ProjectionTurnRepositoryShape["listByWorkspaceId"] = (input) =>
    listProjectionTurnsByWorkspace(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionTurnRepository.listByWorkspaceId:query",
          "ProjectionTurnRepository.listByWorkspaceId:decodeRows",
        ),
      ),
      Effect.map((rows) => rows as ReadonlyArray<Schema.Schema.Type<typeof ProjectionTurn>>),
    );

  const getByTurnId: ProjectionTurnRepositoryShape["getByTurnId"] = (input) =>
    getProjectionTurnByTurnId(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionTurnRepository.getByTurnId:query",
          "ProjectionTurnRepository.getByTurnId:decodeRow",
        ),
      ),
      Effect.flatMap((rowOption) =>
        Option.match(rowOption, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (row) =>
            Effect.succeed(Option.some(row as Schema.Schema.Type<typeof ProjectionTurnById>)),
        }),
      ),
    );

  const clearCheckpointTurnConflict: ProjectionTurnRepositoryShape["clearCheckpointTurnConflict"] =
    (input) =>
      clearCheckpointTurnConflictRow(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionTurnRepository.clearCheckpointTurnConflict:query"),
        ),
      );

  const deleteByWorkspaceId: ProjectionTurnRepositoryShape["deleteByWorkspaceId"] = (input) =>
    deleteProjectionTurnsByWorkspace(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionTurnRepository.deleteByWorkspaceId:query")),
    );

  return {
    upsertByTurnId,
    replacePendingTurnStart,
    getPendingTurnStartByWorkspaceId,
    deletePendingTurnStartByWorkspaceId,
    listByWorkspaceId,
    getByTurnId,
    clearCheckpointTurnConflict,
    deleteByWorkspaceId,
  } satisfies ProjectionTurnRepositoryShape;
});

export const ProjectionTurnRepositoryLive = Layer.effect(
  ProjectionTurnRepository,
  makeProjectionTurnRepository,
);
