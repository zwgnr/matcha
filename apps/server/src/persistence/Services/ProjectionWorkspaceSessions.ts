/**
 * ProjectionWorkspaceSessionRepository - Repository interface for workspace sessions.
 *
 * Owns persistence operations for projected provider-session linkage and
 * runtime status for each workspace.
 *
 * @module ProjectionWorkspaceSessionRepository
 */
import {
  RuntimeMode,
  IsoDateTime,
  OrchestrationSessionStatus,
  WorkspaceId,
  TurnId,
} from "@matcha/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionWorkspaceSession = Schema.Struct({
  workspaceId: WorkspaceId,
  status: OrchestrationSessionStatus,
  providerName: Schema.NullOr(Schema.String),
  runtimeMode: RuntimeMode,
  activeTurnId: Schema.NullOr(TurnId),
  lastError: Schema.NullOr(Schema.String),
  updatedAt: IsoDateTime,
});
export type ProjectionWorkspaceSession = typeof ProjectionWorkspaceSession.Type;

export const GetProjectionWorkspaceSessionInput = Schema.Struct({
  workspaceId: WorkspaceId,
});
export type GetProjectionWorkspaceSessionInput = typeof GetProjectionWorkspaceSessionInput.Type;

export const DeleteProjectionWorkspaceSessionInput = Schema.Struct({
  workspaceId: WorkspaceId,
});
export type DeleteProjectionWorkspaceSessionInput =
  typeof DeleteProjectionWorkspaceSessionInput.Type;

/**
 * ProjectionWorkspaceSessionRepositoryShape - Service API for projected workspace sessions.
 */
export interface ProjectionWorkspaceSessionRepositoryShape {
  /**
   * Insert or replace a projected workspace-session row.
   *
   * Upserts by `workspaceId`.
   */
  readonly upsert: (
    row: ProjectionWorkspaceSession,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Read projected workspace-session state by workspace id.
   */
  readonly getByWorkspaceId: (
    input: GetProjectionWorkspaceSessionInput,
  ) => Effect.Effect<Option.Option<ProjectionWorkspaceSession>, ProjectionRepositoryError>;

  /**
   * Delete projected workspace-session state by workspace id.
   */
  readonly deleteByWorkspaceId: (
    input: DeleteProjectionWorkspaceSessionInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

/**
 * ProjectionWorkspaceSessionRepository - Service tag for workspace-session persistence.
 */
export class ProjectionWorkspaceSessionRepository extends ServiceMap.Service<
  ProjectionWorkspaceSessionRepository,
  ProjectionWorkspaceSessionRepositoryShape
>()("t3/persistence/Services/ProjectionWorkspaceSessions/ProjectionWorkspaceSessionRepository") {}
