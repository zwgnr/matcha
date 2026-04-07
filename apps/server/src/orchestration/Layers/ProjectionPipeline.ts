import { ApprovalRequestId, type ChatAttachment, type OrchestrationEvent } from "@matcha/contracts";
import { Effect, FileSystem, Layer, Option, Path, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError, type ProjectionRepositoryError } from "../../persistence/Errors.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { ProjectionPendingApprovalRepository } from "../../persistence/Services/ProjectionPendingApprovals.ts";
import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectionStateRepository } from "../../persistence/Services/ProjectionState.ts";
import { ProjectionWorkspaceActivityRepository } from "../../persistence/Services/ProjectionWorkspaceActivities.ts";
import { type ProjectionWorkspaceActivity } from "../../persistence/Services/ProjectionWorkspaceActivities.ts";
import {
  type ProjectionWorkspaceMessage,
  ProjectionWorkspaceMessageRepository,
} from "../../persistence/Services/ProjectionWorkspaceMessages.ts";
import {
  type ProjectionWorkspaceProposedPlan,
  ProjectionWorkspaceProposedPlanRepository,
} from "../../persistence/Services/ProjectionWorkspaceProposedPlans.ts";
import { ProjectionWorkspaceSessionRepository } from "../../persistence/Services/ProjectionWorkspaceSessions.ts";
import {
  type ProjectionTurn,
  ProjectionTurnRepository,
} from "../../persistence/Services/ProjectionTurns.ts";
import { ProjectionWorkspaceRepository } from "../../persistence/Services/ProjectionWorkspaces.ts";
import { ProjectionPendingApprovalRepositoryLive } from "../../persistence/Layers/ProjectionPendingApprovals.ts";
import { ProjectionProjectRepositoryLive } from "../../persistence/Layers/ProjectionProjects.ts";
import { ProjectionStateRepositoryLive } from "../../persistence/Layers/ProjectionState.ts";
import { ProjectionWorkspaceActivityRepositoryLive } from "../../persistence/Layers/ProjectionWorkspaceActivities.ts";
import { ProjectionWorkspaceMessageRepositoryLive } from "../../persistence/Layers/ProjectionWorkspaceMessages.ts";
import { ProjectionWorkspaceProposedPlanRepositoryLive } from "../../persistence/Layers/ProjectionWorkspaceProposedPlans.ts";
import { ProjectionWorkspaceSessionRepositoryLive } from "../../persistence/Layers/ProjectionWorkspaceSessions.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { ProjectionWorkspaceRepositoryLive } from "../../persistence/Layers/ProjectionWorkspaces.ts";
import { ServerConfig } from "../../config.ts";
import {
  OrchestrationProjectionPipeline,
  type OrchestrationProjectionPipelineShape,
} from "../Services/ProjectionPipeline.ts";
import {
  attachmentRelativePath,
  parseAttachmentIdFromRelativePath,
  parseWorkspaceSegmentFromAttachmentId,
  toSafeWorkspaceAttachmentSegment,
} from "../../attachmentStore.ts";

export const ORCHESTRATION_PROJECTOR_NAMES = {
  projects: "projection.projects",
  workspaces: "projection.workspaces",
  workspaceMessages: "projection.workspace-messages",
  workspaceProposedPlans: "projection.workspace-proposed-plans",
  workspaceActivities: "projection.workspace-activities",
  workspaceSessions: "projection.workspace-sessions",
  workspaceTurns: "projection.workspace-turns",
  checkpoints: "projection.checkpoints",
  pendingApprovals: "projection.pending-approvals",
} as const;

type ProjectorName =
  (typeof ORCHESTRATION_PROJECTOR_NAMES)[keyof typeof ORCHESTRATION_PROJECTOR_NAMES];

interface ProjectorDefinition {
  readonly name: ProjectorName;
  readonly apply: (
    event: OrchestrationEvent,
    attachmentSideEffects: AttachmentSideEffects,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

interface AttachmentSideEffects {
  readonly deletedWorkspaceIds: Set<string>;
  readonly prunedWorkspaceRelativePaths: Map<string, Set<string>>;
}

const materializeAttachmentsForProjection = Effect.fn("materializeAttachmentsForProjection")(
  (input: { readonly attachments: ReadonlyArray<ChatAttachment> }) =>
    Effect.succeed(input.attachments.length === 0 ? [] : input.attachments),
);

function extractActivityRequestId(payload: unknown): ApprovalRequestId | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const requestId = (payload as Record<string, unknown>).requestId;
  return typeof requestId === "string" ? ApprovalRequestId.makeUnsafe(requestId) : null;
}

function retainProjectionMessagesAfterRevert(
  messages: ReadonlyArray<ProjectionWorkspaceMessage>,
  turns: ReadonlyArray<ProjectionTurn>,
  turnCount: number,
): ReadonlyArray<ProjectionWorkspaceMessage> {
  const retainedMessageIds = new Set<string>();
  const retainedTurnIds = new Set<string>();
  const keptTurns = turns.filter(
    (turn) =>
      turn.turnId !== null &&
      turn.checkpointTurnCount !== null &&
      turn.checkpointTurnCount <= turnCount,
  );
  for (const turn of keptTurns) {
    if (turn.turnId !== null) {
      retainedTurnIds.add(turn.turnId);
    }
    if (turn.pendingMessageId !== null) {
      retainedMessageIds.add(turn.pendingMessageId);
    }
    if (turn.assistantMessageId !== null) {
      retainedMessageIds.add(turn.assistantMessageId);
    }
  }

  for (const message of messages) {
    if (message.role === "system") {
      retainedMessageIds.add(message.messageId);
      continue;
    }
    if (message.turnId !== null && retainedTurnIds.has(message.turnId)) {
      retainedMessageIds.add(message.messageId);
    }
  }

  const retainedUserCount = messages.filter(
    (message) => message.role === "user" && retainedMessageIds.has(message.messageId),
  ).length;
  const missingUserCount = Math.max(0, turnCount - retainedUserCount);
  if (missingUserCount > 0) {
    const fallbackUserMessages = messages
      .filter(
        (message) =>
          message.role === "user" &&
          !retainedMessageIds.has(message.messageId) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.messageId.localeCompare(right.messageId),
      )
      .slice(0, missingUserCount);
    for (const message of fallbackUserMessages) {
      retainedMessageIds.add(message.messageId);
    }
  }

  const retainedAssistantCount = messages.filter(
    (message) => message.role === "assistant" && retainedMessageIds.has(message.messageId),
  ).length;
  const missingAssistantCount = Math.max(0, turnCount - retainedAssistantCount);
  if (missingAssistantCount > 0) {
    const fallbackAssistantMessages = messages
      .filter(
        (message) =>
          message.role === "assistant" &&
          !retainedMessageIds.has(message.messageId) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.messageId.localeCompare(right.messageId),
      )
      .slice(0, missingAssistantCount);
    for (const message of fallbackAssistantMessages) {
      retainedMessageIds.add(message.messageId);
    }
  }

  return messages.filter((message) => retainedMessageIds.has(message.messageId));
}

function retainProjectionActivitiesAfterRevert(
  activities: ReadonlyArray<ProjectionWorkspaceActivity>,
  turns: ReadonlyArray<ProjectionTurn>,
  turnCount: number,
): ReadonlyArray<ProjectionWorkspaceActivity> {
  const retainedTurnIds = new Set<string>(
    turns
      .filter(
        (turn) =>
          turn.turnId !== null &&
          turn.checkpointTurnCount !== null &&
          turn.checkpointTurnCount <= turnCount,
      )
      .flatMap((turn) => (turn.turnId === null ? [] : [turn.turnId])),
  );
  return activities.filter(
    (activity) => activity.turnId === null || retainedTurnIds.has(activity.turnId),
  );
}

function retainProjectionProposedPlansAfterRevert(
  proposedPlans: ReadonlyArray<ProjectionWorkspaceProposedPlan>,
  turns: ReadonlyArray<ProjectionTurn>,
  turnCount: number,
): ReadonlyArray<ProjectionWorkspaceProposedPlan> {
  const retainedTurnIds = new Set<string>(
    turns
      .filter(
        (turn) =>
          turn.turnId !== null &&
          turn.checkpointTurnCount !== null &&
          turn.checkpointTurnCount <= turnCount,
      )
      .flatMap((turn) => (turn.turnId === null ? [] : [turn.turnId])),
  );
  return proposedPlans.filter(
    (proposedPlan) => proposedPlan.turnId === null || retainedTurnIds.has(proposedPlan.turnId),
  );
}

function collectWorkspaceAttachmentRelativePaths(
  workspaceId: string,
  messages: ReadonlyArray<ProjectionWorkspaceMessage>,
): Set<string> {
  const workspaceSegment = toSafeWorkspaceAttachmentSegment(workspaceId);
  if (!workspaceSegment) {
    return new Set();
  }
  const relativePaths = new Set<string>();
  for (const message of messages) {
    for (const attachment of message.attachments ?? []) {
      if (attachment.type !== "image") {
        continue;
      }
      const attachmentWorkspaceSegment = parseWorkspaceSegmentFromAttachmentId(attachment.id);
      if (!attachmentWorkspaceSegment || attachmentWorkspaceSegment !== workspaceSegment) {
        continue;
      }
      relativePaths.add(attachmentRelativePath(attachment));
    }
  }
  return relativePaths;
}

const runAttachmentSideEffects = Effect.fn("runAttachmentSideEffects")(function* (
  sideEffects: AttachmentSideEffects,
) {
  const serverConfig = yield* Effect.service(ServerConfig);
  const fileSystem = yield* Effect.service(FileSystem.FileSystem);
  const path = yield* Effect.service(Path.Path);

  const attachmentsRootDir = serverConfig.attachmentsDir;
  const readAttachmentRootEntries = fileSystem
    .readDirectory(attachmentsRootDir, { recursive: false })
    .pipe(Effect.catch(() => Effect.succeed([] as Array<string>)));

  const removeDeletedWorkspaceAttachmentEntry = Effect.fn("removeDeletedWorkspaceAttachmentEntry")(
    function* (workspaceSegment: string, entry: string) {
      const normalizedEntry = entry.replace(/^[/\\]+/, "").replace(/\\/g, "/");
      if (normalizedEntry.length === 0 || normalizedEntry.includes("/")) {
        return;
      }
      const attachmentId = parseAttachmentIdFromRelativePath(normalizedEntry);
      if (!attachmentId) {
        return;
      }
      const attachmentWorkspaceSegment = parseWorkspaceSegmentFromAttachmentId(attachmentId);
      if (!attachmentWorkspaceSegment || attachmentWorkspaceSegment !== workspaceSegment) {
        return;
      }
      yield* fileSystem.remove(path.join(attachmentsRootDir, normalizedEntry), {
        force: true,
      });
    },
  );

  const deleteWorkspaceAttachments = Effect.fn("deleteWorkspaceAttachments")(function* (
    workspaceId: string,
  ) {
    const workspaceSegment = toSafeWorkspaceAttachmentSegment(workspaceId);
    if (!workspaceSegment) {
      yield* Effect.logWarning("skipping attachment cleanup for unsafe workspace id", {
        workspaceId,
      });
      return;
    }

    const entries = yield* readAttachmentRootEntries;
    yield* Effect.forEach(
      entries,
      (entry) => removeDeletedWorkspaceAttachmentEntry(workspaceSegment, entry),
      {
        concurrency: 1,
      },
    );
  });

  const pruneWorkspaceAttachmentEntry = Effect.fn("pruneWorkspaceAttachmentEntry")(function* (
    workspaceSegment: string,
    keptWorkspaceRelativePaths: Set<string>,
    entry: string,
  ) {
    const relativePath = entry.replace(/^[/\\]+/, "").replace(/\\/g, "/");
    if (relativePath.length === 0 || relativePath.includes("/")) {
      return;
    }
    const attachmentId = parseAttachmentIdFromRelativePath(relativePath);
    if (!attachmentId) {
      return;
    }
    const attachmentWorkspaceSegment = parseWorkspaceSegmentFromAttachmentId(attachmentId);
    if (!attachmentWorkspaceSegment || attachmentWorkspaceSegment !== workspaceSegment) {
      return;
    }

    const absolutePath = path.join(attachmentsRootDir, relativePath);
    const fileInfo = yield* fileSystem
      .stat(absolutePath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!fileInfo || fileInfo.type !== "File") {
      return;
    }

    if (!keptWorkspaceRelativePaths.has(relativePath)) {
      yield* fileSystem.remove(absolutePath, { force: true });
    }
  });

  const pruneWorkspaceAttachments = Effect.fn("pruneWorkspaceAttachments")(function* (
    workspaceId: string,
    keptWorkspaceRelativePaths: Set<string>,
  ) {
    if (sideEffects.deletedWorkspaceIds.has(workspaceId)) {
      return;
    }

    const workspaceSegment = toSafeWorkspaceAttachmentSegment(workspaceId);
    if (!workspaceSegment) {
      yield* Effect.logWarning("skipping attachment prune for unsafe workspace id", {
        workspaceId,
      });
      return;
    }

    const entries = yield* readAttachmentRootEntries;
    yield* Effect.forEach(
      entries,
      (entry) => pruneWorkspaceAttachmentEntry(workspaceSegment, keptWorkspaceRelativePaths, entry),
      { concurrency: 1 },
    );
  });

  yield* Effect.forEach(sideEffects.deletedWorkspaceIds, deleteWorkspaceAttachments, {
    concurrency: 1,
  });

  yield* Effect.forEach(
    sideEffects.prunedWorkspaceRelativePaths.entries(),
    ([workspaceId, keptWorkspaceRelativePaths]) =>
      pruneWorkspaceAttachments(workspaceId, keptWorkspaceRelativePaths),
    { concurrency: 1 },
  );
});

const makeOrchestrationProjectionPipeline = Effect.fn("makeOrchestrationProjectionPipeline")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const eventStore = yield* OrchestrationEventStore;
    const projectionStateRepository = yield* ProjectionStateRepository;
    const projectionProjectRepository = yield* ProjectionProjectRepository;
    const projectionWorkspaceRepository = yield* ProjectionWorkspaceRepository;
    const projectionWorkspaceMessageRepository = yield* ProjectionWorkspaceMessageRepository;
    const projectionWorkspaceProposedPlanRepository =
      yield* ProjectionWorkspaceProposedPlanRepository;
    const projectionWorkspaceActivityRepository = yield* ProjectionWorkspaceActivityRepository;
    const projectionWorkspaceSessionRepository = yield* ProjectionWorkspaceSessionRepository;
    const projectionTurnRepository = yield* ProjectionTurnRepository;
    const projectionPendingApprovalRepository = yield* ProjectionPendingApprovalRepository;

    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfig;

    const applyProjectsProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyProjectsProjection",
    )(function* (event, _attachmentSideEffects) {
      switch (event.type) {
        case "project.created":
          yield* projectionProjectRepository.upsert({
            projectId: event.payload.projectId,
            title: event.payload.title,
            workspaceRoot: event.payload.workspaceRoot,
            defaultModelSelection: event.payload.defaultModelSelection,
            scripts: event.payload.scripts,
            createdAt: event.payload.createdAt,
            updatedAt: event.payload.updatedAt,
            deletedAt: null,
          });
          return;

        case "project.meta-updated": {
          const existingRow = yield* projectionProjectRepository.getById({
            projectId: event.payload.projectId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionProjectRepository.upsert({
            ...existingRow.value,
            ...(event.payload.title !== undefined ? { title: event.payload.title } : {}),
            ...(event.payload.workspaceRoot !== undefined
              ? { workspaceRoot: event.payload.workspaceRoot }
              : {}),
            ...(event.payload.defaultModelSelection !== undefined
              ? { defaultModelSelection: event.payload.defaultModelSelection }
              : {}),
            ...(event.payload.scripts !== undefined ? { scripts: event.payload.scripts } : {}),
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "project.deleted": {
          const existingRow = yield* projectionProjectRepository.getById({
            projectId: event.payload.projectId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionProjectRepository.upsert({
            ...existingRow.value,
            deletedAt: event.payload.deletedAt,
            updatedAt: event.payload.deletedAt,
          });
          return;
        }

        default:
          return;
      }
    });

    const applyWorkspacesProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyWorkspacesProjection",
    )(function* (event, attachmentSideEffects) {
      switch (event.type) {
        case "workspace.created":
          yield* projectionWorkspaceRepository.upsert({
            workspaceId: event.payload.workspaceId,
            projectId: event.payload.projectId,
            title: event.payload.title,
            modelSelection: event.payload.modelSelection,
            runtimeMode: event.payload.runtimeMode,
            interactionMode: event.payload.interactionMode,
            branch: event.payload.branch,
            worktreePath: event.payload.worktreePath,
            latestTurnId: null,
            createdAt: event.payload.createdAt,
            updatedAt: event.payload.updatedAt,
            archivedAt: null,
            deletedAt: null,
          });
          return;

        case "workspace.archived": {
          const existingRow = yield* projectionWorkspaceRepository.getById({
            workspaceId: event.payload.workspaceId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionWorkspaceRepository.upsert({
            ...existingRow.value,
            archivedAt: event.payload.archivedAt,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "workspace.unarchived": {
          const existingRow = yield* projectionWorkspaceRepository.getById({
            workspaceId: event.payload.workspaceId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionWorkspaceRepository.upsert({
            ...existingRow.value,
            archivedAt: null,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "workspace.meta-updated": {
          const existingRow = yield* projectionWorkspaceRepository.getById({
            workspaceId: event.payload.workspaceId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionWorkspaceRepository.upsert({
            ...existingRow.value,
            ...(event.payload.title !== undefined ? { title: event.payload.title } : {}),
            ...(event.payload.modelSelection !== undefined
              ? { modelSelection: event.payload.modelSelection }
              : {}),
            ...(event.payload.branch !== undefined ? { branch: event.payload.branch } : {}),
            ...(event.payload.worktreePath !== undefined
              ? { worktreePath: event.payload.worktreePath }
              : {}),
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "workspace.runtime-mode-set": {
          const existingRow = yield* projectionWorkspaceRepository.getById({
            workspaceId: event.payload.workspaceId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionWorkspaceRepository.upsert({
            ...existingRow.value,
            runtimeMode: event.payload.runtimeMode,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "workspace.interaction-mode-set": {
          const existingRow = yield* projectionWorkspaceRepository.getById({
            workspaceId: event.payload.workspaceId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionWorkspaceRepository.upsert({
            ...existingRow.value,
            interactionMode: event.payload.interactionMode,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "workspace.deleted": {
          attachmentSideEffects.deletedWorkspaceIds.add(event.payload.workspaceId);
          const existingRow = yield* projectionWorkspaceRepository.getById({
            workspaceId: event.payload.workspaceId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionWorkspaceRepository.upsert({
            ...existingRow.value,
            deletedAt: event.payload.deletedAt,
            updatedAt: event.payload.deletedAt,
          });
          return;
        }

        case "workspace.message-sent":
        case "workspace.proposed-plan-upserted":
        case "workspace.activity-appended": {
          const existingRow = yield* projectionWorkspaceRepository.getById({
            workspaceId: event.payload.workspaceId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionWorkspaceRepository.upsert({
            ...existingRow.value,
            updatedAt: event.occurredAt,
          });
          return;
        }

        case "workspace.session-set": {
          const existingRow = yield* projectionWorkspaceRepository.getById({
            workspaceId: event.payload.workspaceId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionWorkspaceRepository.upsert({
            ...existingRow.value,
            latestTurnId: event.payload.session.activeTurnId,
            updatedAt: event.occurredAt,
          });
          return;
        }

        case "workspace.turn-diff-completed": {
          const existingRow = yield* projectionWorkspaceRepository.getById({
            workspaceId: event.payload.workspaceId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionWorkspaceRepository.upsert({
            ...existingRow.value,
            latestTurnId: event.payload.turnId,
            updatedAt: event.occurredAt,
          });
          return;
        }

        case "workspace.reverted": {
          const existingRow = yield* projectionWorkspaceRepository.getById({
            workspaceId: event.payload.workspaceId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionWorkspaceRepository.upsert({
            ...existingRow.value,
            latestTurnId: null,
            updatedAt: event.occurredAt,
          });
          return;
        }

        default:
          return;
      }
    });

    const applyWorkspaceMessagesProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyWorkspaceMessagesProjection",
    )(function* (event, attachmentSideEffects) {
      switch (event.type) {
        case "workspace.message-sent": {
          const existingMessage = yield* projectionWorkspaceMessageRepository.getByMessageId({
            messageId: event.payload.messageId,
          });
          const previousMessage = Option.getOrUndefined(existingMessage);
          const nextText = Option.match(existingMessage, {
            onNone: () => event.payload.text,
            onSome: (message) => {
              if (event.payload.streaming) {
                return `${message.text}${event.payload.text}`;
              }
              if (event.payload.text.length === 0) {
                return message.text;
              }
              return event.payload.text;
            },
          });
          const nextAttachments =
            event.payload.attachments !== undefined
              ? yield* materializeAttachmentsForProjection({
                  attachments: event.payload.attachments,
                })
              : previousMessage?.attachments;
          yield* projectionWorkspaceMessageRepository.upsert({
            messageId: event.payload.messageId,
            workspaceId: event.payload.workspaceId,
            turnId: event.payload.turnId,
            role: event.payload.role,
            text: nextText,
            ...(nextAttachments !== undefined ? { attachments: [...nextAttachments] } : {}),
            isStreaming: event.payload.streaming,
            createdAt: previousMessage?.createdAt ?? event.payload.createdAt,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "workspace.reverted": {
          const existingRows = yield* projectionWorkspaceMessageRepository.listByWorkspaceId({
            workspaceId: event.payload.workspaceId,
          });
          if (existingRows.length === 0) {
            return;
          }

          const existingTurns = yield* projectionTurnRepository.listByWorkspaceId({
            workspaceId: event.payload.workspaceId,
          });
          const keptRows = retainProjectionMessagesAfterRevert(
            existingRows,
            existingTurns,
            event.payload.turnCount,
          );
          if (keptRows.length === existingRows.length) {
            return;
          }

          yield* projectionWorkspaceMessageRepository.deleteByWorkspaceId({
            workspaceId: event.payload.workspaceId,
          });
          yield* Effect.forEach(keptRows, projectionWorkspaceMessageRepository.upsert, {
            concurrency: 1,
          }).pipe(Effect.asVoid);
          attachmentSideEffects.prunedWorkspaceRelativePaths.set(
            event.payload.workspaceId,
            collectWorkspaceAttachmentRelativePaths(event.payload.workspaceId, keptRows),
          );
          return;
        }

        default:
          return;
      }
    });

    const applyWorkspaceProposedPlansProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyWorkspaceProposedPlansProjection",
    )(function* (event, _attachmentSideEffects) {
      switch (event.type) {
        case "workspace.proposed-plan-upserted":
          yield* projectionWorkspaceProposedPlanRepository.upsert({
            planId: event.payload.proposedPlan.id,
            workspaceId: event.payload.workspaceId,
            turnId: event.payload.proposedPlan.turnId,
            planMarkdown: event.payload.proposedPlan.planMarkdown,
            implementedAt: event.payload.proposedPlan.implementedAt,
            implementationWorkspaceId: event.payload.proposedPlan.implementationWorkspaceId,
            createdAt: event.payload.proposedPlan.createdAt,
            updatedAt: event.payload.proposedPlan.updatedAt,
          });
          return;

        case "workspace.reverted": {
          const existingRows = yield* projectionWorkspaceProposedPlanRepository.listByWorkspaceId({
            workspaceId: event.payload.workspaceId,
          });
          if (existingRows.length === 0) {
            return;
          }

          const existingTurns = yield* projectionTurnRepository.listByWorkspaceId({
            workspaceId: event.payload.workspaceId,
          });
          const keptRows = retainProjectionProposedPlansAfterRevert(
            existingRows,
            existingTurns,
            event.payload.turnCount,
          );
          if (keptRows.length === existingRows.length) {
            return;
          }

          yield* projectionWorkspaceProposedPlanRepository.deleteByWorkspaceId({
            workspaceId: event.payload.workspaceId,
          });
          yield* Effect.forEach(keptRows, projectionWorkspaceProposedPlanRepository.upsert, {
            concurrency: 1,
          }).pipe(Effect.asVoid);
          return;
        }

        default:
          return;
      }
    });

    const applyWorkspaceActivitiesProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyWorkspaceActivitiesProjection",
    )(function* (event, _attachmentSideEffects) {
      switch (event.type) {
        case "workspace.activity-appended":
          yield* projectionWorkspaceActivityRepository.upsert({
            activityId: event.payload.activity.id,
            workspaceId: event.payload.workspaceId,
            turnId: event.payload.activity.turnId,
            tone: event.payload.activity.tone,
            kind: event.payload.activity.kind,
            summary: event.payload.activity.summary,
            payload: event.payload.activity.payload,
            ...(event.payload.activity.sequence !== undefined
              ? { sequence: event.payload.activity.sequence }
              : {}),
            createdAt: event.payload.activity.createdAt,
          });
          return;

        case "workspace.reverted": {
          const existingRows = yield* projectionWorkspaceActivityRepository.listByWorkspaceId({
            workspaceId: event.payload.workspaceId,
          });
          if (existingRows.length === 0) {
            return;
          }
          const existingTurns = yield* projectionTurnRepository.listByWorkspaceId({
            workspaceId: event.payload.workspaceId,
          });
          const keptRows = retainProjectionActivitiesAfterRevert(
            existingRows,
            existingTurns,
            event.payload.turnCount,
          );
          if (keptRows.length === existingRows.length) {
            return;
          }
          yield* projectionWorkspaceActivityRepository.deleteByWorkspaceId({
            workspaceId: event.payload.workspaceId,
          });
          yield* Effect.forEach(keptRows, projectionWorkspaceActivityRepository.upsert, {
            concurrency: 1,
          }).pipe(Effect.asVoid);
          return;
        }

        default:
          return;
      }
    });

    const applyWorkspaceSessionsProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyWorkspaceSessionsProjection",
    )(function* (event, _attachmentSideEffects) {
      if (event.type !== "workspace.session-set") {
        return;
      }
      yield* projectionWorkspaceSessionRepository.upsert({
        workspaceId: event.payload.workspaceId,
        status: event.payload.session.status,
        providerName: event.payload.session.providerName,
        runtimeMode: event.payload.session.runtimeMode,
        activeTurnId: event.payload.session.activeTurnId,
        lastError: event.payload.session.lastError,
        updatedAt: event.payload.session.updatedAt,
      });
    });

    const applyWorkspaceTurnsProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyWorkspaceTurnsProjection",
    )(function* (event, _attachmentSideEffects) {
      switch (event.type) {
        case "workspace.turn-start-requested": {
          yield* projectionTurnRepository.replacePendingTurnStart({
            workspaceId: event.payload.workspaceId,
            messageId: event.payload.messageId,
            sourceProposedPlanWorkspaceId: event.payload.sourceProposedPlan?.workspaceId ?? null,
            sourceProposedPlanId: event.payload.sourceProposedPlan?.planId ?? null,
            requestedAt: event.payload.createdAt,
          });
          return;
        }

        case "workspace.session-set": {
          const turnId = event.payload.session.activeTurnId;
          if (turnId === null || event.payload.session.status !== "running") {
            return;
          }

          const existingTurn = yield* projectionTurnRepository.getByTurnId({
            workspaceId: event.payload.workspaceId,
            turnId,
          });
          const pendingTurnStart = yield* projectionTurnRepository.getPendingTurnStartByWorkspaceId(
            {
              workspaceId: event.payload.workspaceId,
            },
          );
          if (Option.isSome(existingTurn)) {
            const nextState =
              existingTurn.value.state === "completed" || existingTurn.value.state === "error"
                ? existingTurn.value.state
                : "running";
            yield* projectionTurnRepository.upsertByTurnId({
              ...existingTurn.value,
              state: nextState,
              pendingMessageId:
                existingTurn.value.pendingMessageId ??
                (Option.isSome(pendingTurnStart) ? pendingTurnStart.value.messageId : null),
              sourceProposedPlanWorkspaceId:
                existingTurn.value.sourceProposedPlanWorkspaceId ??
                (Option.isSome(pendingTurnStart)
                  ? pendingTurnStart.value.sourceProposedPlanWorkspaceId
                  : null),
              sourceProposedPlanId:
                existingTurn.value.sourceProposedPlanId ??
                (Option.isSome(pendingTurnStart)
                  ? pendingTurnStart.value.sourceProposedPlanId
                  : null),
              startedAt:
                existingTurn.value.startedAt ??
                (Option.isSome(pendingTurnStart)
                  ? pendingTurnStart.value.requestedAt
                  : event.occurredAt),
              requestedAt:
                existingTurn.value.requestedAt ??
                (Option.isSome(pendingTurnStart)
                  ? pendingTurnStart.value.requestedAt
                  : event.occurredAt),
            });
          } else {
            yield* projectionTurnRepository.upsertByTurnId({
              turnId,
              workspaceId: event.payload.workspaceId,
              pendingMessageId: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.messageId
                : null,
              sourceProposedPlanWorkspaceId: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.sourceProposedPlanWorkspaceId
                : null,
              sourceProposedPlanId: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.sourceProposedPlanId
                : null,
              assistantMessageId: null,
              state: "running",
              requestedAt: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.requestedAt
                : event.occurredAt,
              startedAt: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.requestedAt
                : event.occurredAt,
              completedAt: null,
              checkpointTurnCount: null,
              checkpointRef: null,
              checkpointStatus: null,
              checkpointFiles: [],
            });
          }

          yield* projectionTurnRepository.deletePendingTurnStartByWorkspaceId({
            workspaceId: event.payload.workspaceId,
          });
          return;
        }

        case "workspace.message-sent": {
          if (event.payload.turnId === null || event.payload.role !== "assistant") {
            return;
          }
          const existingTurn = yield* projectionTurnRepository.getByTurnId({
            workspaceId: event.payload.workspaceId,
            turnId: event.payload.turnId,
          });
          if (Option.isSome(existingTurn)) {
            yield* projectionTurnRepository.upsertByTurnId({
              ...existingTurn.value,
              assistantMessageId: event.payload.messageId,
              state: event.payload.streaming
                ? existingTurn.value.state
                : existingTurn.value.state === "interrupted"
                  ? "interrupted"
                  : existingTurn.value.state === "error"
                    ? "error"
                    : "completed",
              completedAt: event.payload.streaming
                ? existingTurn.value.completedAt
                : (existingTurn.value.completedAt ?? event.payload.updatedAt),
              startedAt: existingTurn.value.startedAt ?? event.payload.createdAt,
              requestedAt: existingTurn.value.requestedAt ?? event.payload.createdAt,
            });
            return;
          }
          yield* projectionTurnRepository.upsertByTurnId({
            turnId: event.payload.turnId,
            workspaceId: event.payload.workspaceId,
            pendingMessageId: null,
            sourceProposedPlanWorkspaceId: null,
            sourceProposedPlanId: null,
            assistantMessageId: event.payload.messageId,
            state: event.payload.streaming ? "running" : "completed",
            requestedAt: event.payload.createdAt,
            startedAt: event.payload.createdAt,
            completedAt: event.payload.streaming ? null : event.payload.updatedAt,
            checkpointTurnCount: null,
            checkpointRef: null,
            checkpointStatus: null,
            checkpointFiles: [],
          });
          return;
        }

        case "workspace.turn-interrupt-requested": {
          if (event.payload.turnId === undefined) {
            return;
          }
          const existingTurn = yield* projectionTurnRepository.getByTurnId({
            workspaceId: event.payload.workspaceId,
            turnId: event.payload.turnId,
          });
          if (Option.isSome(existingTurn)) {
            yield* projectionTurnRepository.upsertByTurnId({
              ...existingTurn.value,
              state: "interrupted",
              completedAt: existingTurn.value.completedAt ?? event.payload.createdAt,
              startedAt: existingTurn.value.startedAt ?? event.payload.createdAt,
              requestedAt: existingTurn.value.requestedAt ?? event.payload.createdAt,
            });
            return;
          }
          yield* projectionTurnRepository.upsertByTurnId({
            turnId: event.payload.turnId,
            workspaceId: event.payload.workspaceId,
            pendingMessageId: null,
            sourceProposedPlanWorkspaceId: null,
            sourceProposedPlanId: null,
            assistantMessageId: null,
            state: "interrupted",
            requestedAt: event.payload.createdAt,
            startedAt: event.payload.createdAt,
            completedAt: event.payload.createdAt,
            checkpointTurnCount: null,
            checkpointRef: null,
            checkpointStatus: null,
            checkpointFiles: [],
          });
          return;
        }

        case "workspace.turn-diff-completed": {
          const existingTurn = yield* projectionTurnRepository.getByTurnId({
            workspaceId: event.payload.workspaceId,
            turnId: event.payload.turnId,
          });
          const nextState = event.payload.status === "error" ? "error" : "completed";
          yield* projectionTurnRepository.clearCheckpointTurnConflict({
            workspaceId: event.payload.workspaceId,
            turnId: event.payload.turnId,
            checkpointTurnCount: event.payload.checkpointTurnCount,
          });

          if (Option.isSome(existingTurn)) {
            yield* projectionTurnRepository.upsertByTurnId({
              ...existingTurn.value,
              assistantMessageId: event.payload.assistantMessageId,
              state: nextState,
              checkpointTurnCount: event.payload.checkpointTurnCount,
              checkpointRef: event.payload.checkpointRef,
              checkpointStatus: event.payload.status,
              checkpointFiles: event.payload.files,
              startedAt: existingTurn.value.startedAt ?? event.payload.completedAt,
              requestedAt: existingTurn.value.requestedAt ?? event.payload.completedAt,
              completedAt: event.payload.completedAt,
            });
            return;
          }
          yield* projectionTurnRepository.upsertByTurnId({
            turnId: event.payload.turnId,
            workspaceId: event.payload.workspaceId,
            pendingMessageId: null,
            sourceProposedPlanWorkspaceId: null,
            sourceProposedPlanId: null,
            assistantMessageId: event.payload.assistantMessageId,
            state: nextState,
            requestedAt: event.payload.completedAt,
            startedAt: event.payload.completedAt,
            completedAt: event.payload.completedAt,
            checkpointTurnCount: event.payload.checkpointTurnCount,
            checkpointRef: event.payload.checkpointRef,
            checkpointStatus: event.payload.status,
            checkpointFiles: event.payload.files,
          });
          return;
        }

        case "workspace.reverted": {
          const existingTurns = yield* projectionTurnRepository.listByWorkspaceId({
            workspaceId: event.payload.workspaceId,
          });
          const keptTurns = existingTurns.filter(
            (turn) =>
              turn.turnId !== null &&
              turn.checkpointTurnCount !== null &&
              turn.checkpointTurnCount <= event.payload.turnCount,
          );
          yield* projectionTurnRepository.deleteByWorkspaceId({
            workspaceId: event.payload.workspaceId,
          });
          yield* Effect.forEach(
            keptTurns,
            (turn) =>
              turn.turnId === null
                ? Effect.void
                : projectionTurnRepository.upsertByTurnId({
                    ...turn,
                    turnId: turn.turnId,
                  }),
            { concurrency: 1 },
          ).pipe(Effect.asVoid);
          return;
        }

        default:
          return;
      }
    });

    const applyCheckpointsProjection: ProjectorDefinition["apply"] = () => Effect.void;

    const applyPendingApprovalsProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyPendingApprovalsProjection",
    )(function* (event, _attachmentSideEffects) {
      switch (event.type) {
        case "workspace.activity-appended": {
          const requestId =
            extractActivityRequestId(event.payload.activity.payload) ??
            event.metadata.requestId ??
            null;
          if (requestId === null) {
            return;
          }
          const existingRow = yield* projectionPendingApprovalRepository.getByRequestId({
            requestId,
          });
          if (event.payload.activity.kind === "approval.resolved") {
            const resolvedDecisionRaw =
              typeof event.payload.activity.payload === "object" &&
              event.payload.activity.payload !== null &&
              "decision" in event.payload.activity.payload
                ? (event.payload.activity.payload as { decision?: unknown }).decision
                : null;
            const resolvedDecision =
              resolvedDecisionRaw === "accept" ||
              resolvedDecisionRaw === "acceptForSession" ||
              resolvedDecisionRaw === "decline" ||
              resolvedDecisionRaw === "cancel"
                ? resolvedDecisionRaw
                : null;
            yield* projectionPendingApprovalRepository.upsert({
              requestId,
              workspaceId: Option.isSome(existingRow)
                ? existingRow.value.workspaceId
                : event.payload.workspaceId,
              turnId: Option.isSome(existingRow)
                ? existingRow.value.turnId
                : event.payload.activity.turnId,
              status: "resolved",
              decision: resolvedDecision,
              createdAt: Option.isSome(existingRow)
                ? existingRow.value.createdAt
                : event.payload.activity.createdAt,
              resolvedAt: event.payload.activity.createdAt,
            });
            return;
          }
          if (Option.isSome(existingRow) && existingRow.value.status === "resolved") {
            return;
          }
          yield* projectionPendingApprovalRepository.upsert({
            requestId,
            workspaceId: event.payload.workspaceId,
            turnId: event.payload.activity.turnId,
            status: "pending",
            decision: null,
            createdAt: Option.isSome(existingRow)
              ? existingRow.value.createdAt
              : event.payload.activity.createdAt,
            resolvedAt: null,
          });
          return;
        }

        case "workspace.approval-response-requested": {
          const existingRow = yield* projectionPendingApprovalRepository.getByRequestId({
            requestId: event.payload.requestId,
          });
          yield* projectionPendingApprovalRepository.upsert({
            requestId: event.payload.requestId,
            workspaceId: Option.isSome(existingRow)
              ? existingRow.value.workspaceId
              : event.payload.workspaceId,
            turnId: Option.isSome(existingRow) ? existingRow.value.turnId : null,
            status: "resolved",
            decision: event.payload.decision,
            createdAt: Option.isSome(existingRow)
              ? existingRow.value.createdAt
              : event.payload.createdAt,
            resolvedAt: event.payload.createdAt,
          });
          return;
        }

        default:
          return;
      }
    });

    const projectors: ReadonlyArray<ProjectorDefinition> = [
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.projects,
        apply: applyProjectsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.workspaceMessages,
        apply: applyWorkspaceMessagesProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.workspaceProposedPlans,
        apply: applyWorkspaceProposedPlansProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.workspaceActivities,
        apply: applyWorkspaceActivitiesProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.workspaceSessions,
        apply: applyWorkspaceSessionsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.workspaceTurns,
        apply: applyWorkspaceTurnsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.checkpoints,
        apply: applyCheckpointsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.pendingApprovals,
        apply: applyPendingApprovalsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.workspaces,
        apply: applyWorkspacesProjection,
      },
    ];

    const runProjectorForEvent = Effect.fn("runProjectorForEvent")(function* (
      projector: ProjectorDefinition,
      event: OrchestrationEvent,
    ) {
      const attachmentSideEffects: AttachmentSideEffects = {
        deletedWorkspaceIds: new Set<string>(),
        prunedWorkspaceRelativePaths: new Map<string, Set<string>>(),
      };

      yield* sql.withTransaction(
        projector.apply(event, attachmentSideEffects).pipe(
          Effect.flatMap(() =>
            projectionStateRepository.upsert({
              projector: projector.name,
              lastAppliedSequence: event.sequence,
              updatedAt: event.occurredAt,
            }),
          ),
        ),
      );

      yield* runAttachmentSideEffects(attachmentSideEffects).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("failed to apply projected attachment side-effects", {
            projector: projector.name,
            sequence: event.sequence,
            eventType: event.type,
            cause,
          }),
        ),
      );
    });

    const bootstrapProjector = (projector: ProjectorDefinition) =>
      projectionStateRepository
        .getByProjector({
          projector: projector.name,
        })
        .pipe(
          Effect.flatMap((stateRow) =>
            Stream.runForEach(
              eventStore.readFromSequence(
                Option.isSome(stateRow) ? stateRow.value.lastAppliedSequence : 0,
              ),
              (event) => runProjectorForEvent(projector, event),
            ),
          ),
        );

    const projectEvent: OrchestrationProjectionPipelineShape["projectEvent"] = (event) =>
      Effect.forEach(projectors, (projector) => runProjectorForEvent(projector, event), {
        concurrency: 1,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.provideService(ServerConfig, serverConfig),
        Effect.asVoid,
        Effect.catchTag("SqlError", (sqlError) =>
          Effect.fail(toPersistenceSqlError("ProjectionPipeline.projectEvent:query")(sqlError)),
        ),
      );

    const bootstrap: OrchestrationProjectionPipelineShape["bootstrap"] = Effect.forEach(
      projectors,
      bootstrapProjector,
      { concurrency: 1 },
    ).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ServerConfig, serverConfig),
      Effect.asVoid,
      Effect.tap(() =>
        Effect.logDebug("orchestration projection pipeline bootstrapped").pipe(
          Effect.annotateLogs({ projectors: projectors.length }),
        ),
      ),
      Effect.catchTag("SqlError", (sqlError) =>
        Effect.fail(toPersistenceSqlError("ProjectionPipeline.bootstrap:query")(sqlError)),
      ),
    );

    return {
      bootstrap,
      projectEvent,
    } satisfies OrchestrationProjectionPipelineShape;
  },
);

export const OrchestrationProjectionPipelineLive = Layer.effect(
  OrchestrationProjectionPipeline,
  makeOrchestrationProjectionPipeline(),
).pipe(
  Layer.provideMerge(ProjectionProjectRepositoryLive),
  Layer.provideMerge(ProjectionWorkspaceRepositoryLive),
  Layer.provideMerge(ProjectionWorkspaceMessageRepositoryLive),
  Layer.provideMerge(ProjectionWorkspaceProposedPlanRepositoryLive),
  Layer.provideMerge(ProjectionWorkspaceActivityRepositoryLive),
  Layer.provideMerge(ProjectionWorkspaceSessionRepositoryLive),
  Layer.provideMerge(ProjectionTurnRepositoryLive),
  Layer.provideMerge(ProjectionPendingApprovalRepositoryLive),
  Layer.provideMerge(ProjectionStateRepositoryLive),
);
