import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Schema, Struct } from "effect";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionWorkspaceInput,
  GetProjectionWorkspaceInput,
  ListProjectionWorkspacesByProjectInput,
  ProjectionWorkspace,
  ProjectionWorkspaceRepository,
  type ProjectionWorkspaceRepositoryShape,
} from "../Services/ProjectionWorkspaces.ts";
import { ModelSelection } from "@matcha/contracts";

const ProjectionWorkspaceDbRow = ProjectionWorkspace.mapFields(
  Struct.assign({
    modelSelection: Schema.fromJsonString(ModelSelection),
  }),
);
type ProjectionWorkspaceDbRow = typeof ProjectionWorkspaceDbRow.Type;

const makeProjectionWorkspaceRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionWorkspaceRow = SqlSchema.void({
    Request: ProjectionWorkspace,
    execute: (row) =>
      sql`
        INSERT INTO projection_workspaces (
          workspace_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES (
          ${row.workspaceId},
          ${row.projectId},
          ${row.title},
          ${JSON.stringify(row.modelSelection)},
          ${row.runtimeMode},
          ${row.interactionMode},
          ${row.branch},
          ${row.worktreePath},
          ${row.latestTurnId},
          ${row.createdAt},
          ${row.updatedAt},
          ${row.archivedAt},
          ${row.deletedAt}
        )
        ON CONFLICT (workspace_id)
        DO UPDATE SET
          project_id = excluded.project_id,
          title = excluded.title,
          model_selection_json = excluded.model_selection_json,
          runtime_mode = excluded.runtime_mode,
          interaction_mode = excluded.interaction_mode,
          branch = excluded.branch,
          worktree_path = excluded.worktree_path,
          latest_turn_id = excluded.latest_turn_id,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          archived_at = excluded.archived_at,
          deleted_at = excluded.deleted_at
      `,
  });

  const getProjectionWorkspaceRow = SqlSchema.findOneOption({
    Request: GetProjectionWorkspaceInput,
    Result: ProjectionWorkspaceDbRow,
    execute: ({ workspaceId }) =>
      sql`
        SELECT
          workspace_id AS "workspaceId",
          project_id AS "projectId",
          title,
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          branch,
          worktree_path AS "worktreePath",
          latest_turn_id AS "latestTurnId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          deleted_at AS "deletedAt"
        FROM projection_workspaces
        WHERE workspace_id = ${workspaceId}
      `,
  });

  const listProjectionWorkspaceRows = SqlSchema.findAll({
    Request: ListProjectionWorkspacesByProjectInput,
    Result: ProjectionWorkspaceDbRow,
    execute: ({ projectId }) =>
      sql`
        SELECT
          workspace_id AS "workspaceId",
          project_id AS "projectId",
          title,
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          branch,
          worktree_path AS "worktreePath",
          latest_turn_id AS "latestTurnId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          deleted_at AS "deletedAt"
        FROM projection_workspaces
        WHERE project_id = ${projectId}
        ORDER BY created_at ASC, workspace_id ASC
      `,
  });

  const deleteProjectionWorkspaceRow = SqlSchema.void({
    Request: DeleteProjectionWorkspaceInput,
    execute: ({ workspaceId }) =>
      sql`
        DELETE FROM projection_workspaces
        WHERE workspace_id = ${workspaceId}
      `,
  });

  const upsert: ProjectionWorkspaceRepositoryShape["upsert"] = (row) =>
    upsertProjectionWorkspaceRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionWorkspaceRepository.upsert:query")),
    );

  const getById: ProjectionWorkspaceRepositoryShape["getById"] = (input) =>
    getProjectionWorkspaceRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionWorkspaceRepository.getById:query")),
    );

  const listByProjectId: ProjectionWorkspaceRepositoryShape["listByProjectId"] = (input) =>
    listProjectionWorkspaceRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionWorkspaceRepository.listByProjectId:query")),
    );

  const deleteById: ProjectionWorkspaceRepositoryShape["deleteById"] = (input) =>
    deleteProjectionWorkspaceRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionWorkspaceRepository.deleteById:query")),
    );

  return {
    upsert,
    getById,
    listByProjectId,
    deleteById,
  } satisfies ProjectionWorkspaceRepositoryShape;
});

export const ProjectionWorkspaceRepositoryLive = Layer.effect(
  ProjectionWorkspaceRepository,
  makeProjectionWorkspaceRepository,
);
