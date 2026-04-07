/**
 * ProjectionWorkspaceRepository - Projection repository interface for workspaces.
 *
 * Owns persistence operations for projected workspace records in the
 * orchestration read model.
 *
 * @module ProjectionWorkspaceRepository
 */
import {
  IsoDateTime,
  ModelSelection,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  WorkspaceId,
  TurnId,
} from "@matcha/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionWorkspace = Schema.Struct({
  workspaceId: WorkspaceId,
  projectId: ProjectId,
  title: Schema.String,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  latestTurnId: Schema.NullOr(TurnId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectionWorkspace = typeof ProjectionWorkspace.Type;

export const GetProjectionWorkspaceInput = Schema.Struct({
  workspaceId: WorkspaceId,
});
export type GetProjectionWorkspaceInput = typeof GetProjectionWorkspaceInput.Type;

export const DeleteProjectionWorkspaceInput = Schema.Struct({
  workspaceId: WorkspaceId,
});
export type DeleteProjectionWorkspaceInput = typeof DeleteProjectionWorkspaceInput.Type;

export const ListProjectionWorkspacesByProjectInput = Schema.Struct({
  projectId: ProjectId,
});
export type ListProjectionWorkspacesByProjectInput =
  typeof ListProjectionWorkspacesByProjectInput.Type;

/**
 * ProjectionWorkspaceRepositoryShape - Service API for projected workspace records.
 */
export interface ProjectionWorkspaceRepositoryShape {
  /**
   * Insert or replace a projected workspace row.
   *
   * Upserts by `workspaceId`.
   */
  readonly upsert: (
    workspace: ProjectionWorkspace,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Read a projected workspace row by id.
   */
  readonly getById: (
    input: GetProjectionWorkspaceInput,
  ) => Effect.Effect<Option.Option<ProjectionWorkspace>, ProjectionRepositoryError>;

  /**
   * List projected workspaces for a project.
   *
   * Returned in deterministic creation order.
   */
  readonly listByProjectId: (
    input: ListProjectionWorkspacesByProjectInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionWorkspace>, ProjectionRepositoryError>;

  /**
   * Soft-delete a projected workspace row by id.
   */
  readonly deleteById: (
    input: DeleteProjectionWorkspaceInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

/**
 * ProjectionWorkspaceRepository - Service tag for workspace projection persistence.
 */
export class ProjectionWorkspaceRepository extends ServiceMap.Service<
  ProjectionWorkspaceRepository,
  ProjectionWorkspaceRepositoryShape
>()("t3/persistence/Services/ProjectionWorkspaces/ProjectionWorkspaceRepository") {}
