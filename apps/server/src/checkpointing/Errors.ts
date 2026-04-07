import { Schema } from "effect";
import type { ProjectionRepositoryError } from "../persistence/Errors.ts";
import { GitCommandError } from "@matcha/contracts";

/**
 * CheckpointUnavailableError - Expected checkpoint does not exist.
 */
export class CheckpointUnavailableError extends Schema.TaggedErrorClass<CheckpointUnavailableError>()(
  "CheckpointUnavailableError",
  {
    workspaceId: Schema.String,
    turnCount: Schema.Number,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Checkpoint unavailable for workspace ${this.workspaceId} turn ${this.turnCount}: ${this.detail}`;
  }
}

/**
 * CheckpointInvariantError - Inconsistent provider/filesystem/catalog state.
 */
export class CheckpointInvariantError extends Schema.TaggedErrorClass<CheckpointInvariantError>()(
  "CheckpointInvariantError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Checkpoint invariant violation in ${this.operation}: ${this.detail}`;
  }
}

export type CheckpointStoreError =
  | GitCommandError
  | CheckpointInvariantError
  | CheckpointUnavailableError;

export type CheckpointServiceError = CheckpointStoreError | ProjectionRepositoryError;
