import {
  OrchestrationGetTurnDiffResult,
  type OrchestrationGetFullWorkspaceDiffInput,
  type OrchestrationGetFullWorkspaceDiffResult,
  type OrchestrationGetTurnDiffResult as OrchestrationGetTurnDiffResultType,
} from "@matcha/contracts";
import { Effect, Layer, Option, Schema } from "effect";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { CheckpointInvariantError, CheckpointUnavailableError } from "../Errors.ts";
import { checkpointRefForWorkspaceTurn } from "../Utils.ts";
import { CheckpointStore } from "../Services/CheckpointStore.ts";
import {
  CheckpointDiffQuery,
  type CheckpointDiffQueryShape,
} from "../Services/CheckpointDiffQuery.ts";

const isTurnDiffResult = Schema.is(OrchestrationGetTurnDiffResult);

const make = Effect.gen(function* () {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const checkpointStore = yield* CheckpointStore;

  const getTurnDiff: CheckpointDiffQueryShape["getTurnDiff"] = Effect.fn("getTurnDiff")(
    function* (input) {
      const operation = "CheckpointDiffQuery.getTurnDiff";

      if (input.fromTurnCount === input.toTurnCount) {
        const emptyDiff: OrchestrationGetTurnDiffResultType = {
          workspaceId: input.workspaceId,
          fromTurnCount: input.fromTurnCount,
          toTurnCount: input.toTurnCount,
          diff: "",
        };
        if (!isTurnDiffResult(emptyDiff)) {
          return yield* new CheckpointInvariantError({
            operation,
            detail: "Computed turn diff result does not satisfy contract schema.",
          });
        }
        return emptyDiff;
      }

      const workspaceContext = yield* projectionSnapshotQuery.getWorkspaceCheckpointContext(
        input.workspaceId,
      );
      if (Option.isNone(workspaceContext)) {
        return yield* new CheckpointInvariantError({
          operation,
          detail: `Workspace '${input.workspaceId}' not found.`,
        });
      }

      const maxTurnCount = workspaceContext.value.checkpoints.reduce(
        (max, checkpoint) => Math.max(max, checkpoint.checkpointTurnCount),
        0,
      );
      if (input.toTurnCount > maxTurnCount) {
        return yield* new CheckpointUnavailableError({
          workspaceId: input.workspaceId,
          turnCount: input.toTurnCount,
          detail: `Turn diff range exceeds current turn count: requested ${input.toTurnCount}, current ${maxTurnCount}.`,
        });
      }

      const workspaceCwd =
        workspaceContext.value.worktreePath ?? workspaceContext.value.workspaceRoot;
      if (!workspaceCwd) {
        return yield* new CheckpointInvariantError({
          operation,
          detail: `Workspace path missing for workspace '${input.workspaceId}' when computing turn diff.`,
        });
      }

      const fromCheckpointRef =
        input.fromTurnCount === 0
          ? checkpointRefForWorkspaceTurn(input.workspaceId, 0)
          : workspaceContext.value.checkpoints.find(
              (checkpoint) => checkpoint.checkpointTurnCount === input.fromTurnCount,
            )?.checkpointRef;
      if (!fromCheckpointRef) {
        return yield* new CheckpointUnavailableError({
          workspaceId: input.workspaceId,
          turnCount: input.fromTurnCount,
          detail: `Checkpoint ref is unavailable for turn ${input.fromTurnCount}.`,
        });
      }

      const toCheckpointRef = workspaceContext.value.checkpoints.find(
        (checkpoint) => checkpoint.checkpointTurnCount === input.toTurnCount,
      )?.checkpointRef;
      if (!toCheckpointRef) {
        return yield* new CheckpointUnavailableError({
          workspaceId: input.workspaceId,
          turnCount: input.toTurnCount,
          detail: `Checkpoint ref is unavailable for turn ${input.toTurnCount}.`,
        });
      }

      const [fromExists, toExists] = yield* Effect.all(
        [
          checkpointStore.hasCheckpointRef({
            cwd: workspaceCwd,
            checkpointRef: fromCheckpointRef,
          }),
          checkpointStore.hasCheckpointRef({
            cwd: workspaceCwd,
            checkpointRef: toCheckpointRef,
          }),
        ],
        { concurrency: "unbounded" },
      );

      if (!fromExists) {
        return yield* new CheckpointUnavailableError({
          workspaceId: input.workspaceId,
          turnCount: input.fromTurnCount,
          detail: `Filesystem checkpoint is unavailable for turn ${input.fromTurnCount}.`,
        });
      }

      if (!toExists) {
        return yield* new CheckpointUnavailableError({
          workspaceId: input.workspaceId,
          turnCount: input.toTurnCount,
          detail: `Filesystem checkpoint is unavailable for turn ${input.toTurnCount}.`,
        });
      }

      const diff = yield* checkpointStore.diffCheckpoints({
        cwd: workspaceCwd,
        fromCheckpointRef,
        toCheckpointRef,
        fallbackFromToHead: false,
      });

      const turnDiff: OrchestrationGetTurnDiffResultType = {
        workspaceId: input.workspaceId,
        fromTurnCount: input.fromTurnCount,
        toTurnCount: input.toTurnCount,
        diff,
      };
      if (!isTurnDiffResult(turnDiff)) {
        return yield* new CheckpointInvariantError({
          operation,
          detail: "Computed turn diff result does not satisfy contract schema.",
        });
      }

      return turnDiff;
    },
  );

  const getFullWorkspaceDiff: CheckpointDiffQueryShape["getFullWorkspaceDiff"] = (
    input: OrchestrationGetFullWorkspaceDiffInput,
  ) =>
    getTurnDiff({
      workspaceId: input.workspaceId,
      fromTurnCount: 0,
      toTurnCount: input.toTurnCount,
    }).pipe(Effect.map((result): OrchestrationGetFullWorkspaceDiffResult => result));

  return {
    getTurnDiff,
    getFullWorkspaceDiff,
  } satisfies CheckpointDiffQueryShape;
});

export const CheckpointDiffQueryLive = Layer.effect(CheckpointDiffQuery, make);
