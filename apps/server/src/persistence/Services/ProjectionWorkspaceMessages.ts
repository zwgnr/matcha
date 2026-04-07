/**
 * ProjectionWorkspaceMessageRepository - Projection repository interface for messages.
 *
 * Owns persistence operations for projected workspace messages rendered in the
 * orchestration read model.
 *
 * @module ProjectionWorkspaceMessageRepository
 */
import {
  ChatAttachment,
  MessageId,
  OrchestrationMessageRole,
  WorkspaceId,
  TurnId,
  IsoDateTime,
} from "@matcha/contracts";
import { Schema, ServiceMap } from "effect";
import type { Option } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionWorkspaceMessage = Schema.Struct({
  messageId: MessageId,
  workspaceId: WorkspaceId,
  turnId: Schema.NullOr(TurnId),
  role: OrchestrationMessageRole,
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  isStreaming: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectionWorkspaceMessage = typeof ProjectionWorkspaceMessage.Type;

export const ListProjectionWorkspaceMessagesInput = Schema.Struct({
  workspaceId: WorkspaceId,
});
export type ListProjectionWorkspaceMessagesInput = typeof ListProjectionWorkspaceMessagesInput.Type;

export const GetProjectionWorkspaceMessageInput = Schema.Struct({
  messageId: MessageId,
});
export type GetProjectionWorkspaceMessageInput = typeof GetProjectionWorkspaceMessageInput.Type;

export const DeleteProjectionWorkspaceMessagesInput = Schema.Struct({
  workspaceId: WorkspaceId,
});
export type DeleteProjectionWorkspaceMessagesInput =
  typeof DeleteProjectionWorkspaceMessagesInput.Type;

/**
 * ProjectionWorkspaceMessageRepositoryShape - Service API for projected workspace messages.
 */
export interface ProjectionWorkspaceMessageRepositoryShape {
  /**
   * Insert or replace a projected workspace message row.
   *
   * Upserts by `messageId`.
   */
  readonly upsert: (
    message: ProjectionWorkspaceMessage,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Read a projected workspace message by id.
   */
  readonly getByMessageId: (
    input: GetProjectionWorkspaceMessageInput,
  ) => Effect.Effect<Option.Option<ProjectionWorkspaceMessage>, ProjectionRepositoryError>;

  /**
   * List projected workspace messages for a workspace.
   *
   * Returned in ascending creation order.
   */
  readonly listByWorkspaceId: (
    input: ListProjectionWorkspaceMessagesInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionWorkspaceMessage>, ProjectionRepositoryError>;

  /**
   * Delete projected workspace messages by workspace.
   */
  readonly deleteByWorkspaceId: (
    input: DeleteProjectionWorkspaceMessagesInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

/**
 * ProjectionWorkspaceMessageRepository - Service tag for message projection persistence.
 */
export class ProjectionWorkspaceMessageRepository extends ServiceMap.Service<
  ProjectionWorkspaceMessageRepository,
  ProjectionWorkspaceMessageRepositoryShape
>()("t3/persistence/Services/ProjectionWorkspaceMessages/ProjectionWorkspaceMessageRepository") {}
