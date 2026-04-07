import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionWorkspaceProposedPlansInput,
  ListProjectionWorkspaceProposedPlansInput,
  ProjectionWorkspaceProposedPlan,
  ProjectionWorkspaceProposedPlanRepository,
  type ProjectionWorkspaceProposedPlanRepositoryShape,
} from "../Services/ProjectionWorkspaceProposedPlans.ts";

const makeProjectionWorkspaceProposedPlanRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionWorkspaceProposedPlanRow = SqlSchema.void({
    Request: ProjectionWorkspaceProposedPlan,
    execute: (row) => sql`
      INSERT INTO projection_workspace_proposed_plans (
        plan_id,
        workspace_id,
        turn_id,
        plan_markdown,
        implemented_at,
        implementation_workspace_id,
        created_at,
        updated_at
      )
      VALUES (
        ${row.planId},
        ${row.workspaceId},
        ${row.turnId},
        ${row.planMarkdown},
        ${row.implementedAt},
        ${row.implementationWorkspaceId},
        ${row.createdAt},
        ${row.updatedAt}
      )
      ON CONFLICT (plan_id)
      DO UPDATE SET
        workspace_id = excluded.workspace_id,
        turn_id = excluded.turn_id,
        plan_markdown = excluded.plan_markdown,
        implemented_at = excluded.implemented_at,
        implementation_workspace_id = excluded.implementation_workspace_id,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `,
  });

  const listProjectionWorkspaceProposedPlanRows = SqlSchema.findAll({
    Request: ListProjectionWorkspaceProposedPlansInput,
    Result: ProjectionWorkspaceProposedPlan,
    execute: ({ workspaceId }) => sql`
      SELECT
        plan_id AS "planId",
        workspace_id AS "workspaceId",
        turn_id AS "turnId",
        plan_markdown AS "planMarkdown",
        implemented_at AS "implementedAt",
        implementation_workspace_id AS "implementationWorkspaceId",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM projection_workspace_proposed_plans
      WHERE workspace_id = ${workspaceId}
      ORDER BY created_at ASC, plan_id ASC
    `,
  });

  const deleteProjectionWorkspaceProposedPlanRows = SqlSchema.void({
    Request: DeleteProjectionWorkspaceProposedPlansInput,
    execute: ({ workspaceId }) => sql`
      DELETE FROM projection_workspace_proposed_plans
      WHERE workspace_id = ${workspaceId}
    `,
  });

  const upsert: ProjectionWorkspaceProposedPlanRepositoryShape["upsert"] = (row) =>
    upsertProjectionWorkspaceProposedPlanRow(row).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionWorkspaceProposedPlanRepository.upsert:query"),
      ),
    );

  const listByWorkspaceId: ProjectionWorkspaceProposedPlanRepositoryShape["listByWorkspaceId"] = (
    input,
  ) =>
    listProjectionWorkspaceProposedPlanRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionWorkspaceProposedPlanRepository.listByWorkspaceId:query"),
      ),
    );

  const deleteByWorkspaceId: ProjectionWorkspaceProposedPlanRepositoryShape["deleteByWorkspaceId"] =
    (input) =>
      deleteProjectionWorkspaceProposedPlanRows(input).pipe(
        Effect.mapError(
          toPersistenceSqlError(
            "ProjectionWorkspaceProposedPlanRepository.deleteByWorkspaceId:query",
          ),
        ),
      );

  return {
    upsert,
    listByWorkspaceId,
    deleteByWorkspaceId,
  } satisfies ProjectionWorkspaceProposedPlanRepositoryShape;
});

export const ProjectionWorkspaceProposedPlanRepositoryLive = Layer.effect(
  ProjectionWorkspaceProposedPlanRepository,
  makeProjectionWorkspaceProposedPlanRepository,
);
