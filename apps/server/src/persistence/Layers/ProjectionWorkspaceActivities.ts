import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { NonNegativeInt } from "@matcha/contracts";
import { Effect, Layer, Schema, Struct } from "effect";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";

import {
  DeleteProjectionWorkspaceActivitiesInput,
  ListProjectionWorkspaceActivitiesInput,
  ProjectionWorkspaceActivity,
  ProjectionWorkspaceActivityRepository,
  type ProjectionWorkspaceActivityRepositoryShape,
} from "../Services/ProjectionWorkspaceActivities.ts";

const ProjectionWorkspaceActivityDbRowSchema = ProjectionWorkspaceActivity.mapFields(
  Struct.assign({
    payload: Schema.fromJsonString(Schema.Unknown),
    sequence: Schema.NullOr(NonNegativeInt),
  }),
);

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeProjectionWorkspaceActivityRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionWorkspaceActivityRow = SqlSchema.void({
    Request: ProjectionWorkspaceActivity,
    execute: (row) =>
      sql`
            INSERT INTO projection_workspace_activities (
              activity_id,
              workspace_id,
              turn_id,
              tone,
              kind,
              summary,
              payload_json,
              sequence,
              created_at
            )
            VALUES (
              ${row.activityId},
              ${row.workspaceId},
              ${row.turnId},
              ${row.tone},
              ${row.kind},
              ${row.summary},
              ${JSON.stringify(row.payload)},
              ${row.sequence ?? null},
              ${row.createdAt}
            )
            ON CONFLICT (activity_id)
            DO UPDATE SET
              workspace_id = excluded.workspace_id,
              turn_id = excluded.turn_id,
              tone = excluded.tone,
              kind = excluded.kind,
              summary = excluded.summary,
              payload_json = excluded.payload_json,
              sequence = excluded.sequence,
              created_at = excluded.created_at
          `,
  });

  const listProjectionWorkspaceActivityRows = SqlSchema.findAll({
    Request: ListProjectionWorkspaceActivitiesInput,
    Result: ProjectionWorkspaceActivityDbRowSchema,
    execute: ({ workspaceId }) =>
      sql`
        SELECT
          activity_id AS "activityId",
          workspace_id AS "workspaceId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          payload_json AS "payload",
          sequence,
          created_at AS "createdAt"
        FROM projection_workspace_activities
        WHERE workspace_id = ${workspaceId}
        ORDER BY
          CASE WHEN sequence IS NULL THEN 0 ELSE 1 END ASC,
          sequence ASC,
          created_at ASC,
          activity_id ASC
      `,
  });

  const deleteProjectionWorkspaceActivityRows = SqlSchema.void({
    Request: DeleteProjectionWorkspaceActivitiesInput,
    execute: ({ workspaceId }) =>
      sql`
        DELETE FROM projection_workspace_activities
        WHERE workspace_id = ${workspaceId}
      `,
  });

  const upsert: ProjectionWorkspaceActivityRepositoryShape["upsert"] = (row) =>
    upsertProjectionWorkspaceActivityRow(row).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionWorkspaceActivityRepository.upsert:query",
          "ProjectionWorkspaceActivityRepository.upsert:encodeRequest",
        ),
      ),
    );

  const listByWorkspaceId: ProjectionWorkspaceActivityRepositoryShape["listByWorkspaceId"] = (
    input,
  ) =>
    listProjectionWorkspaceActivityRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionWorkspaceActivityRepository.listByWorkspaceId:query",
          "ProjectionWorkspaceActivityRepository.listByWorkspaceId:decodeRows",
        ),
      ),
      Effect.map((rows) =>
        rows.map((row) => ({
          activityId: row.activityId,
          workspaceId: row.workspaceId,
          turnId: row.turnId,
          tone: row.tone,
          kind: row.kind,
          summary: row.summary,
          payload: row.payload,
          ...(row.sequence !== null ? { sequence: row.sequence } : {}),
          createdAt: row.createdAt,
        })),
      ),
    );

  const deleteByWorkspaceId: ProjectionWorkspaceActivityRepositoryShape["deleteByWorkspaceId"] = (
    input,
  ) =>
    deleteProjectionWorkspaceActivityRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionWorkspaceActivityRepository.deleteByWorkspaceId:query"),
      ),
    );

  return {
    upsert,
    listByWorkspaceId,
    deleteByWorkspaceId,
  } satisfies ProjectionWorkspaceActivityRepositoryShape;
});

export const ProjectionWorkspaceActivityRepositoryLive = Layer.effect(
  ProjectionWorkspaceActivityRepository,
  makeProjectionWorkspaceActivityRepository,
);
