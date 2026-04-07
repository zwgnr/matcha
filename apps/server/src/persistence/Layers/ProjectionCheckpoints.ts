import { OrchestrationCheckpointFile } from "@matcha/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema, Struct } from "effect";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteByWorkspaceIdInput,
  GetByWorkspaceAndTurnCountInput,
  ListByWorkspaceIdInput,
  ProjectionCheckpoint,
  ProjectionCheckpointRepository,
  type ProjectionCheckpointRepositoryShape,
} from "../Services/ProjectionCheckpoints.ts";

const ProjectionCheckpointDbRowSchema = ProjectionCheckpoint.mapFields(
  Struct.assign({
    files: Schema.fromJsonString(Schema.Array(OrchestrationCheckpointFile)),
  }),
);

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeProjectionCheckpointRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const clearCheckpointConflict = SqlSchema.void({
    Request: GetByWorkspaceAndTurnCountInput,
    execute: ({ workspaceId, checkpointTurnCount }) =>
      sql`
        UPDATE projection_turns
        SET
          checkpoint_turn_count = NULL,
          checkpoint_ref = NULL,
          checkpoint_status = NULL,
          checkpoint_files_json = '[]'
        WHERE workspace_id = ${workspaceId}
          AND checkpoint_turn_count = ${checkpointTurnCount}
      `,
  });

  const upsertProjectionCheckpointRow = SqlSchema.void({
    Request: ProjectionCheckpointDbRowSchema,
    execute: (row) =>
      sql`
        INSERT INTO projection_turns (
          workspace_id,
          turn_id,
          pending_message_id,
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
          NULL,
          ${row.assistantMessageId},
          ${row.status === "error" ? "error" : "completed"},
          ${row.completedAt},
          ${row.completedAt},
          ${row.completedAt},
          ${row.checkpointTurnCount},
          ${row.checkpointRef},
          ${row.status},
          ${row.files}
        )
        ON CONFLICT (workspace_id, turn_id)
        DO UPDATE SET
          assistant_message_id = excluded.assistant_message_id,
          state = excluded.state,
          completed_at = excluded.completed_at,
          checkpoint_turn_count = excluded.checkpoint_turn_count,
          checkpoint_ref = excluded.checkpoint_ref,
          checkpoint_status = excluded.checkpoint_status,
          checkpoint_files_json = excluded.checkpoint_files_json
      `,
  });

  const listProjectionCheckpointRows = SqlSchema.findAll({
    Request: ListByWorkspaceIdInput,
    Result: ProjectionCheckpointDbRowSchema,
    execute: ({ workspaceId }) =>
      sql`
        SELECT
          workspace_id AS "workspaceId",
          turn_id AS "turnId",
          checkpoint_turn_count AS "checkpointTurnCount",
          checkpoint_ref AS "checkpointRef",
          checkpoint_status AS "status",
          checkpoint_files_json AS "files",
          assistant_message_id AS "assistantMessageId",
          completed_at AS "completedAt"
        FROM projection_turns
        WHERE workspace_id = ${workspaceId}
          AND checkpoint_turn_count IS NOT NULL
        ORDER BY checkpoint_turn_count ASC
      `,
  });

  const getProjectionCheckpointRow = SqlSchema.findOneOption({
    Request: GetByWorkspaceAndTurnCountInput,
    Result: ProjectionCheckpointDbRowSchema,
    execute: ({ workspaceId, checkpointTurnCount }) =>
      sql`
        SELECT
          workspace_id AS "workspaceId",
          turn_id AS "turnId",
          checkpoint_turn_count AS "checkpointTurnCount",
          checkpoint_ref AS "checkpointRef",
          checkpoint_status AS "status",
          checkpoint_files_json AS "files",
          assistant_message_id AS "assistantMessageId",
          completed_at AS "completedAt"
        FROM projection_turns
        WHERE workspace_id = ${workspaceId}
          AND checkpoint_turn_count = ${checkpointTurnCount}
      `,
  });

  const deleteProjectionCheckpointRows = SqlSchema.void({
    Request: DeleteByWorkspaceIdInput,
    execute: ({ workspaceId }) =>
      sql`
        UPDATE projection_turns
        SET
          checkpoint_turn_count = NULL,
          checkpoint_ref = NULL,
          checkpoint_status = NULL,
          checkpoint_files_json = '[]'
        WHERE workspace_id = ${workspaceId}
          AND checkpoint_turn_count IS NOT NULL
      `,
  });

  const upsertCheckpointRow = (row: Schema.Schema.Type<typeof ProjectionCheckpointDbRowSchema>) =>
    sql.withTransaction(
      clearCheckpointConflict({
        workspaceId: row.workspaceId,
        checkpointTurnCount: row.checkpointTurnCount,
      }).pipe(Effect.flatMap(() => upsertProjectionCheckpointRow(row))),
    );

  const upsert: ProjectionCheckpointRepositoryShape["upsert"] = (row) =>
    upsertCheckpointRow(row).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionCheckpointRepository.upsert:query",
          "ProjectionCheckpointRepository.upsert:encodeRequest",
        ),
      ),
    );

  const listByWorkspaceId: ProjectionCheckpointRepositoryShape["listByWorkspaceId"] = (input) =>
    listProjectionCheckpointRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionCheckpointRepository.listByWorkspaceId:query",
          "ProjectionCheckpointRepository.listByWorkspaceId:decodeRows",
        ),
      ),
      Effect.map((rows) => rows as ReadonlyArray<Schema.Schema.Type<typeof ProjectionCheckpoint>>),
    );

  const getByWorkspaceAndTurnCount: ProjectionCheckpointRepositoryShape["getByWorkspaceAndTurnCount"] =
    (input) =>
      getProjectionCheckpointRow(input).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionCheckpointRepository.getByWorkspaceAndTurnCount:query",
            "ProjectionCheckpointRepository.getByWorkspaceAndTurnCount:decodeRow",
          ),
        ),
        Effect.flatMap((rowOption) =>
          Option.match(rowOption, {
            onNone: () => Effect.succeed(Option.none()),
            onSome: (row) =>
              Effect.succeed(Option.some(row as Schema.Schema.Type<typeof ProjectionCheckpoint>)),
          }),
        ),
      );

  const deleteByWorkspaceId: ProjectionCheckpointRepositoryShape["deleteByWorkspaceId"] = (input) =>
    deleteProjectionCheckpointRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionCheckpointRepository.deleteByWorkspaceId:query"),
      ),
    );

  return {
    upsert,
    listByWorkspaceId,
    getByWorkspaceAndTurnCount,
    deleteByWorkspaceId,
  } satisfies ProjectionCheckpointRepositoryShape;
});

export const ProjectionCheckpointRepositoryLive = Layer.effect(
  ProjectionCheckpointRepository,
  makeProjectionCheckpointRepository,
);
