import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer } from "effect";

import { toPersistenceSqlError } from "../Errors.ts";

import {
  ProjectionWorkspaceSession,
  ProjectionWorkspaceSessionRepository,
  type ProjectionWorkspaceSessionRepositoryShape,
  DeleteProjectionWorkspaceSessionInput,
  GetProjectionWorkspaceSessionInput,
} from "../Services/ProjectionWorkspaceSessions.ts";

const makeProjectionWorkspaceSessionRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionWorkspaceSessionRow = SqlSchema.void({
    Request: ProjectionWorkspaceSession,
    execute: (row) =>
      sql`
        INSERT INTO projection_workspace_sessions (
          workspace_id,
          status,
          provider_name,
          runtime_mode,
          active_turn_id,
          last_error,
          updated_at
        )
        VALUES (
          ${row.workspaceId},
          ${row.status},
          ${row.providerName},
          ${row.runtimeMode},
          ${row.activeTurnId},
          ${row.lastError},
          ${row.updatedAt}
        )
        ON CONFLICT (workspace_id)
        DO UPDATE SET
          status = excluded.status,
          provider_name = excluded.provider_name,
          runtime_mode = excluded.runtime_mode,
          active_turn_id = excluded.active_turn_id,
          last_error = excluded.last_error,
          updated_at = excluded.updated_at
      `,
  });

  const getProjectionWorkspaceSessionRow = SqlSchema.findOneOption({
    Request: GetProjectionWorkspaceSessionInput,
    Result: ProjectionWorkspaceSession,
    execute: ({ workspaceId }) =>
      sql`
        SELECT
          workspace_id AS "workspaceId",
          status,
          provider_name AS "providerName",
          runtime_mode AS "runtimeMode",
          active_turn_id AS "activeTurnId",
          last_error AS "lastError",
          updated_at AS "updatedAt"
        FROM projection_workspace_sessions
        WHERE workspace_id = ${workspaceId}
      `,
  });

  const deleteProjectionWorkspaceSessionRow = SqlSchema.void({
    Request: DeleteProjectionWorkspaceSessionInput,
    execute: ({ workspaceId }) =>
      sql`
        DELETE FROM projection_workspace_sessions
        WHERE workspace_id = ${workspaceId}
      `,
  });

  const upsert: ProjectionWorkspaceSessionRepositoryShape["upsert"] = (row) =>
    upsertProjectionWorkspaceSessionRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionWorkspaceSessionRepository.upsert:query")),
    );

  const getByWorkspaceId: ProjectionWorkspaceSessionRepositoryShape["getByWorkspaceId"] = (input) =>
    getProjectionWorkspaceSessionRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionWorkspaceSessionRepository.getByWorkspaceId:query"),
      ),
    );

  const deleteByWorkspaceId: ProjectionWorkspaceSessionRepositoryShape["deleteByWorkspaceId"] = (
    input,
  ) =>
    deleteProjectionWorkspaceSessionRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionWorkspaceSessionRepository.deleteByWorkspaceId:query"),
      ),
    );

  return {
    upsert,
    getByWorkspaceId,
    deleteByWorkspaceId,
  } satisfies ProjectionWorkspaceSessionRepositoryShape;
});

export const ProjectionWorkspaceSessionRepositoryLive = Layer.effect(
  ProjectionWorkspaceSessionRepository,
  makeProjectionWorkspaceSessionRepository,
);
