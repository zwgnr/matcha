/**
 * ProjectionCheckpointRepository - Projection repository interface for checkpoints.
 *
 * Owns persistence operations for projected checkpoint summaries in workspace
 * timelines.
 *
 * @module ProjectionCheckpointRepository
 */
import {
  CheckpointRef,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  OrchestrationCheckpointFile,
  OrchestrationCheckpointStatus,
  WorkspaceId,
  TurnId,
} from "@matcha/contracts";
import { Option, ServiceMap, Schema } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionCheckpoint = Schema.Struct({
  workspaceId: WorkspaceId,
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
});
export type ProjectionCheckpoint = typeof ProjectionCheckpoint.Type;

export const ListByWorkspaceIdInput = Schema.Struct({
  workspaceId: WorkspaceId,
});
export type ListByWorkspaceIdInput = typeof ListByWorkspaceIdInput.Type;

export const GetByWorkspaceAndTurnCountInput = Schema.Struct({
  workspaceId: WorkspaceId,
  checkpointTurnCount: NonNegativeInt,
});
export type GetByWorkspaceAndTurnCountInput = typeof GetByWorkspaceAndTurnCountInput.Type;

export const DeleteByWorkspaceIdInput = Schema.Struct({
  workspaceId: WorkspaceId,
});
export type DeleteByWorkspaceIdInput = typeof DeleteByWorkspaceIdInput.Type;

/**
 * ProjectionCheckpointRepositoryShape - Service API for projected checkpoints.
 */
export interface ProjectionCheckpointRepositoryShape {
  /**
   * Insert or replace a projected checkpoint row.
   *
   * Upserts by composite key `(workspaceId, checkpointTurnCount)`.
   */
  readonly upsert: (row: ProjectionCheckpoint) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * List projected checkpoints for a workspace.
   *
   * Returned in ascending checkpoint turn-count order.
   */
  readonly listByWorkspaceId: (
    input: ListByWorkspaceIdInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionCheckpoint>, ProjectionRepositoryError>;

  /**
   * Read a projected checkpoint by workspace and turn-count key.
   */
  readonly getByWorkspaceAndTurnCount: (
    input: GetByWorkspaceAndTurnCountInput,
  ) => Effect.Effect<Option.Option<ProjectionCheckpoint>, ProjectionRepositoryError>;

  /**
   * Delete projected checkpoint rows by workspace.
   */
  readonly deleteByWorkspaceId: (
    input: DeleteByWorkspaceIdInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

/**
 * ProjectionCheckpointRepository - Service tag for checkpoint projection persistence.
 */
export class ProjectionCheckpointRepository extends ServiceMap.Service<
  ProjectionCheckpointRepository,
  ProjectionCheckpointRepositoryShape
>()("t3/persistence/Services/ProjectionCheckpoints/ProjectionCheckpointRepository") {}
