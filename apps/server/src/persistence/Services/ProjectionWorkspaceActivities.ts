/**
 * ProjectionWorkspaceActivityRepository - Projection repository interface for workspace activity.
 *
 * Owns persistence operations for activity timeline entries projected from
 * orchestration events.
 *
 * @module ProjectionWorkspaceActivityRepository
 */
import {
  EventId,
  IsoDateTime,
  NonNegativeInt,
  OrchestrationWorkspaceActivityTone,
  WorkspaceId,
  TurnId,
} from "@matcha/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionWorkspaceActivity = Schema.Struct({
  activityId: EventId,
  workspaceId: WorkspaceId,
  turnId: Schema.NullOr(TurnId),
  tone: OrchestrationWorkspaceActivityTone,
  kind: Schema.String,
  summary: Schema.String,
  payload: Schema.Unknown,
  sequence: Schema.optional(NonNegativeInt),
  createdAt: IsoDateTime,
});
export type ProjectionWorkspaceActivity = typeof ProjectionWorkspaceActivity.Type;

export const ListProjectionWorkspaceActivitiesInput = Schema.Struct({
  workspaceId: WorkspaceId,
});
export type ListProjectionWorkspaceActivitiesInput =
  typeof ListProjectionWorkspaceActivitiesInput.Type;

export const DeleteProjectionWorkspaceActivitiesInput = Schema.Struct({
  workspaceId: WorkspaceId,
});
export type DeleteProjectionWorkspaceActivitiesInput =
  typeof DeleteProjectionWorkspaceActivitiesInput.Type;

/**
 * ProjectionWorkspaceActivityRepositoryShape - Service API for projected workspace activity.
 */
export interface ProjectionWorkspaceActivityRepositoryShape {
  /**
   * Insert or replace a projected workspace activity row.
   *
   * Upserts by `activityId` and JSON-encodes payload.
   */
  readonly upsert: (
    row: ProjectionWorkspaceActivity,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * List projected workspace activity rows for a workspace.
   *
   * Returned in ascending runtime sequence order (or creation order when
   * sequence is unavailable).
   */
  readonly listByWorkspaceId: (
    input: ListProjectionWorkspaceActivitiesInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionWorkspaceActivity>, ProjectionRepositoryError>;

  /**
   * Delete projected workspace activity rows by workspace.
   */
  readonly deleteByWorkspaceId: (
    input: DeleteProjectionWorkspaceActivitiesInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

/**
 * ProjectionWorkspaceActivityRepository - Service tag for workspace activity persistence.
 */
export class ProjectionWorkspaceActivityRepository extends ServiceMap.Service<
  ProjectionWorkspaceActivityRepository,
  ProjectionWorkspaceActivityRepositoryShape
>()(
  "t3/persistence/Services/ProjectionWorkspaceActivities/ProjectionWorkspaceActivityRepository",
) {}
