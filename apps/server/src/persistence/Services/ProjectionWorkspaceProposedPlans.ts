import {
  IsoDateTime,
  OrchestrationProposedPlanId,
  WorkspaceId,
  TrimmedNonEmptyString,
  TurnId,
} from "@matcha/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionWorkspaceProposedPlan = Schema.Struct({
  planId: OrchestrationProposedPlanId,
  workspaceId: WorkspaceId,
  turnId: Schema.NullOr(TurnId),
  planMarkdown: TrimmedNonEmptyString,
  implementedAt: Schema.NullOr(IsoDateTime),
  implementationWorkspaceId: Schema.NullOr(WorkspaceId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectionWorkspaceProposedPlan = typeof ProjectionWorkspaceProposedPlan.Type;

export const ListProjectionWorkspaceProposedPlansInput = Schema.Struct({
  workspaceId: WorkspaceId,
});
export type ListProjectionWorkspaceProposedPlansInput =
  typeof ListProjectionWorkspaceProposedPlansInput.Type;

export const DeleteProjectionWorkspaceProposedPlansInput = Schema.Struct({
  workspaceId: WorkspaceId,
});
export type DeleteProjectionWorkspaceProposedPlansInput =
  typeof DeleteProjectionWorkspaceProposedPlansInput.Type;

export interface ProjectionWorkspaceProposedPlanRepositoryShape {
  readonly upsert: (
    proposedPlan: ProjectionWorkspaceProposedPlan,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly listByWorkspaceId: (
    input: ListProjectionWorkspaceProposedPlansInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionWorkspaceProposedPlan>, ProjectionRepositoryError>;
  readonly deleteByWorkspaceId: (
    input: DeleteProjectionWorkspaceProposedPlansInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionWorkspaceProposedPlanRepository extends ServiceMap.Service<
  ProjectionWorkspaceProposedPlanRepository,
  ProjectionWorkspaceProposedPlanRepositoryShape
>()(
  "t3/persistence/Services/ProjectionWorkspaceProposedPlans/ProjectionWorkspaceProposedPlanRepository",
) {}
