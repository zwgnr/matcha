import type { OrchestrationEvent, OrchestrationReadModel, WorkspaceId } from "@matcha/contracts";
import {
  OrchestrationCheckpointSummary,
  OrchestrationMessage,
  OrchestrationSession,
  OrchestrationWorkspace,
} from "@matcha/contracts";
import { Effect, Schema } from "effect";

import { toProjectorDecodeError, type OrchestrationProjectorDecodeError } from "./Errors.ts";
import {
  MessageSentPayloadSchema,
  ProjectCreatedPayload,
  ProjectDeletedPayload,
  ProjectMetaUpdatedPayload,
  WorkspaceActivityAppendedPayload,
  WorkspaceArchivedPayload,
  WorkspaceCreatedPayload,
  WorkspaceDeletedPayload,
  WorkspaceInteractionModeSetPayload,
  WorkspaceMetaUpdatedPayload,
  WorkspaceProposedPlanUpsertedPayload,
  WorkspaceRuntimeModeSetPayload,
  WorkspaceUnarchivedPayload,
  WorkspaceRevertedPayload,
  WorkspaceSessionSetPayload,
  WorkspaceTurnDiffCompletedPayload,
} from "./Schemas.ts";

type WorkspacePatch = Partial<Omit<OrchestrationWorkspace, "id" | "projectId">>;
const MAX_WORKSPACE_MESSAGES = 2_000;
const MAX_WORKSPACE_CHECKPOINTS = 500;

function checkpointStatusToLatestTurnState(status: "ready" | "missing" | "error") {
  if (status === "error") return "error" as const;
  if (status === "missing") return "interrupted" as const;
  return "completed" as const;
}

function updateWorkspace(
  workspaces: ReadonlyArray<OrchestrationWorkspace>,
  workspaceId: WorkspaceId,
  patch: WorkspacePatch,
): OrchestrationWorkspace[] {
  return workspaces.map((workspace) =>
    workspace.id === workspaceId ? { ...workspace, ...patch } : workspace,
  );
}

function decodeForEvent<A>(
  schema: Schema.Schema<A>,
  value: unknown,
  eventType: OrchestrationEvent["type"],
  field: string,
): Effect.Effect<A, OrchestrationProjectorDecodeError> {
  return Effect.try({
    try: () => Schema.decodeUnknownSync(schema as any)(value),
    catch: (error) => toProjectorDecodeError(`${eventType}:${field}`)(error as Schema.SchemaError),
  });
}

function retainWorkspaceMessagesAfterRevert(
  messages: ReadonlyArray<OrchestrationMessage>,
  retainedTurnIds: ReadonlySet<string>,
  turnCount: number,
): ReadonlyArray<OrchestrationMessage> {
  const retainedMessageIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "system") {
      retainedMessageIds.add(message.id);
      continue;
    }
    if (message.turnId !== null && retainedTurnIds.has(message.turnId)) {
      retainedMessageIds.add(message.id);
    }
  }

  const retainedUserCount = messages.filter(
    (message) => message.role === "user" && retainedMessageIds.has(message.id),
  ).length;
  const missingUserCount = Math.max(0, turnCount - retainedUserCount);
  if (missingUserCount > 0) {
    const fallbackUserMessages = messages
      .filter(
        (message) =>
          message.role === "user" &&
          !retainedMessageIds.has(message.id) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      )
      .slice(0, missingUserCount);
    for (const message of fallbackUserMessages) {
      retainedMessageIds.add(message.id);
    }
  }

  const retainedAssistantCount = messages.filter(
    (message) => message.role === "assistant" && retainedMessageIds.has(message.id),
  ).length;
  const missingAssistantCount = Math.max(0, turnCount - retainedAssistantCount);
  if (missingAssistantCount > 0) {
    const fallbackAssistantMessages = messages
      .filter(
        (message) =>
          message.role === "assistant" &&
          !retainedMessageIds.has(message.id) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      )
      .slice(0, missingAssistantCount);
    for (const message of fallbackAssistantMessages) {
      retainedMessageIds.add(message.id);
    }
  }

  return messages.filter((message) => retainedMessageIds.has(message.id));
}

function retainWorkspaceActivitiesAfterRevert(
  activities: ReadonlyArray<OrchestrationWorkspace["activities"][number]>,
  retainedTurnIds: ReadonlySet<string>,
): ReadonlyArray<OrchestrationWorkspace["activities"][number]> {
  return activities.filter(
    (activity) => activity.turnId === null || retainedTurnIds.has(activity.turnId),
  );
}

function retainWorkspaceProposedPlansAfterRevert(
  proposedPlans: ReadonlyArray<OrchestrationWorkspace["proposedPlans"][number]>,
  retainedTurnIds: ReadonlySet<string>,
): ReadonlyArray<OrchestrationWorkspace["proposedPlans"][number]> {
  return proposedPlans.filter(
    (proposedPlan) => proposedPlan.turnId === null || retainedTurnIds.has(proposedPlan.turnId),
  );
}

function compareWorkspaceActivities(
  left: OrchestrationWorkspace["activities"][number],
  right: OrchestrationWorkspace["activities"][number],
): number {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
  } else if (left.sequence !== undefined) {
    return 1;
  } else if (right.sequence !== undefined) {
    return -1;
  }

  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

export function createEmptyReadModel(nowIso: string): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    workspaces: [],
    updatedAt: nowIso,
  };
}

export function projectEvent(
  model: OrchestrationReadModel,
  event: OrchestrationEvent,
): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError> {
  const nextBase: OrchestrationReadModel = {
    ...model,
    snapshotSequence: event.sequence,
    updatedAt: event.occurredAt,
  };

  switch (event.type) {
    case "project.created":
      return decodeForEvent(ProjectCreatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const existing = nextBase.projects.find((entry) => entry.id === payload.projectId);
          const nextProject = {
            id: payload.projectId,
            title: payload.title,
            workspaceRoot: payload.workspaceRoot,
            defaultModelSelection: payload.defaultModelSelection,
            scripts: payload.scripts,
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
            deletedAt: null,
          };

          return {
            ...nextBase,
            projects: existing
              ? nextBase.projects.map((entry) =>
                  entry.id === payload.projectId ? nextProject : entry,
                )
              : [...nextBase.projects, nextProject],
          };
        }),
      );

    case "project.meta-updated":
      return decodeForEvent(ProjectMetaUpdatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          projects: nextBase.projects.map((project) =>
            project.id === payload.projectId
              ? {
                  ...project,
                  ...(payload.title !== undefined ? { title: payload.title } : {}),
                  ...(payload.workspaceRoot !== undefined
                    ? { workspaceRoot: payload.workspaceRoot }
                    : {}),
                  ...(payload.defaultModelSelection !== undefined
                    ? { defaultModelSelection: payload.defaultModelSelection }
                    : {}),
                  ...(payload.scripts !== undefined ? { scripts: payload.scripts } : {}),
                  updatedAt: payload.updatedAt,
                }
              : project,
          ),
        })),
      );

    case "project.deleted":
      return decodeForEvent(ProjectDeletedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          projects: nextBase.projects.map((project) =>
            project.id === payload.projectId
              ? {
                  ...project,
                  deletedAt: payload.deletedAt,
                  updatedAt: payload.deletedAt,
                }
              : project,
          ),
        })),
      );

    case "workspace.created":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          WorkspaceCreatedPayload,
          event.payload,
          event.type,
          "payload",
        );
        const workspace: OrchestrationWorkspace = yield* decodeForEvent(
          OrchestrationWorkspace,
          {
            id: payload.workspaceId,
            projectId: payload.projectId,
            title: payload.title,
            modelSelection: payload.modelSelection,
            runtimeMode: payload.runtimeMode,
            interactionMode: payload.interactionMode,
            branch: payload.branch,
            worktreePath: payload.worktreePath,
            latestTurn: null,
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
            archivedAt: null,
            deletedAt: null,
            messages: [],
            activities: [],
            checkpoints: [],
            session: null,
          },
          event.type,
          "workspace",
        );
        const existing = nextBase.workspaces.find((entry) => entry.id === workspace.id);
        return {
          ...nextBase,
          workspaces: existing
            ? nextBase.workspaces.map((entry) => (entry.id === workspace.id ? workspace : entry))
            : [...nextBase.workspaces, workspace],
        };
      });

    case "workspace.deleted":
      return decodeForEvent(WorkspaceDeletedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          workspaces: updateWorkspace(nextBase.workspaces, payload.workspaceId, {
            deletedAt: payload.deletedAt,
            updatedAt: payload.deletedAt,
          }),
        })),
      );

    case "workspace.archived":
      return decodeForEvent(WorkspaceArchivedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          workspaces: updateWorkspace(nextBase.workspaces, payload.workspaceId, {
            archivedAt: payload.archivedAt,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "workspace.unarchived":
      return decodeForEvent(WorkspaceUnarchivedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          workspaces: updateWorkspace(nextBase.workspaces, payload.workspaceId, {
            archivedAt: null,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "workspace.meta-updated":
      return decodeForEvent(WorkspaceMetaUpdatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          workspaces: updateWorkspace(nextBase.workspaces, payload.workspaceId, {
            ...(payload.title !== undefined ? { title: payload.title } : {}),
            ...(payload.modelSelection !== undefined
              ? { modelSelection: payload.modelSelection }
              : {}),
            ...(payload.branch !== undefined ? { branch: payload.branch } : {}),
            ...(payload.worktreePath !== undefined ? { worktreePath: payload.worktreePath } : {}),
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "workspace.runtime-mode-set":
      return decodeForEvent(
        WorkspaceRuntimeModeSetPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          workspaces: updateWorkspace(nextBase.workspaces, payload.workspaceId, {
            runtimeMode: payload.runtimeMode,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "workspace.interaction-mode-set":
      return decodeForEvent(
        WorkspaceInteractionModeSetPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          workspaces: updateWorkspace(nextBase.workspaces, payload.workspaceId, {
            interactionMode: payload.interactionMode,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "workspace.message-sent":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          MessageSentPayloadSchema,
          event.payload,
          event.type,
          "payload",
        );
        const workspace = nextBase.workspaces.find((entry) => entry.id === payload.workspaceId);
        if (!workspace) {
          return nextBase;
        }

        const message: OrchestrationMessage = yield* decodeForEvent(
          OrchestrationMessage,
          {
            id: payload.messageId,
            role: payload.role,
            text: payload.text,
            ...(payload.attachments !== undefined ? { attachments: payload.attachments } : {}),
            turnId: payload.turnId,
            streaming: payload.streaming,
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
          },
          event.type,
          "message",
        );

        const existingMessage = workspace.messages.find((entry) => entry.id === message.id);
        const messages = existingMessage
          ? workspace.messages.map((entry) =>
              entry.id === message.id
                ? {
                    ...entry,
                    text: message.streaming
                      ? `${entry.text}${message.text}`
                      : message.text.length > 0
                        ? message.text
                        : entry.text,
                    streaming: message.streaming,
                    updatedAt: message.updatedAt,
                    turnId: message.turnId,
                    ...(message.attachments !== undefined
                      ? { attachments: message.attachments }
                      : {}),
                  }
                : entry,
            )
          : [...workspace.messages, message];
        const cappedMessages = messages.slice(-MAX_WORKSPACE_MESSAGES);

        return {
          ...nextBase,
          workspaces: updateWorkspace(nextBase.workspaces, payload.workspaceId, {
            messages: cappedMessages,
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "workspace.session-set":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          WorkspaceSessionSetPayload,
          event.payload,
          event.type,
          "payload",
        );
        const workspace = nextBase.workspaces.find((entry) => entry.id === payload.workspaceId);
        if (!workspace) {
          return nextBase;
        }

        const session: OrchestrationSession = yield* decodeForEvent(
          OrchestrationSession,
          payload.session,
          event.type,
          "session",
        );

        return {
          ...nextBase,
          workspaces: updateWorkspace(nextBase.workspaces, payload.workspaceId, {
            session,
            latestTurn:
              session.status === "running" && session.activeTurnId !== null
                ? {
                    turnId: session.activeTurnId,
                    state: "running",
                    requestedAt:
                      workspace.latestTurn?.turnId === session.activeTurnId
                        ? workspace.latestTurn.requestedAt
                        : session.updatedAt,
                    startedAt:
                      workspace.latestTurn?.turnId === session.activeTurnId
                        ? (workspace.latestTurn.startedAt ?? session.updatedAt)
                        : session.updatedAt,
                    completedAt: null,
                    assistantMessageId:
                      workspace.latestTurn?.turnId === session.activeTurnId
                        ? workspace.latestTurn.assistantMessageId
                        : null,
                  }
                : workspace.latestTurn,
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "workspace.proposed-plan-upserted":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          WorkspaceProposedPlanUpsertedPayload,
          event.payload,
          event.type,
          "payload",
        );
        const workspace = nextBase.workspaces.find((entry) => entry.id === payload.workspaceId);
        if (!workspace) {
          return nextBase;
        }

        const proposedPlans = [
          ...workspace.proposedPlans.filter((entry) => entry.id !== payload.proposedPlan.id),
          payload.proposedPlan,
        ]
          .toSorted(
            (left, right) =>
              left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
          )
          .slice(-200);

        return {
          ...nextBase,
          workspaces: updateWorkspace(nextBase.workspaces, payload.workspaceId, {
            proposedPlans,
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "workspace.turn-diff-completed":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          WorkspaceTurnDiffCompletedPayload,
          event.payload,
          event.type,
          "payload",
        );
        const workspace = nextBase.workspaces.find((entry) => entry.id === payload.workspaceId);
        if (!workspace) {
          return nextBase;
        }

        const checkpoint = yield* decodeForEvent(
          OrchestrationCheckpointSummary,
          {
            turnId: payload.turnId,
            checkpointTurnCount: payload.checkpointTurnCount,
            checkpointRef: payload.checkpointRef,
            status: payload.status,
            files: payload.files,
            assistantMessageId: payload.assistantMessageId,
            completedAt: payload.completedAt,
          },
          event.type,
          "checkpoint",
        );

        // Do not let a placeholder (status "missing") overwrite a checkpoint
        // that has already been captured with a real git ref (status "ready").
        // ProviderRuntimeIngestion may fire multiple turn.diff.updated events
        // per turn; without this guard later placeholders would clobber the
        // real capture dispatched by CheckpointReactor.
        const existing = workspace.checkpoints.find((entry) => entry.turnId === checkpoint.turnId);
        if (existing && existing.status !== "missing" && checkpoint.status === "missing") {
          return nextBase;
        }

        const checkpoints = [
          ...workspace.checkpoints.filter((entry) => entry.turnId !== checkpoint.turnId),
          checkpoint,
        ]
          .toSorted((left, right) => left.checkpointTurnCount - right.checkpointTurnCount)
          .slice(-MAX_WORKSPACE_CHECKPOINTS);

        return {
          ...nextBase,
          workspaces: updateWorkspace(nextBase.workspaces, payload.workspaceId, {
            checkpoints,
            latestTurn: {
              turnId: payload.turnId,
              state: checkpointStatusToLatestTurnState(payload.status),
              requestedAt:
                workspace.latestTurn?.turnId === payload.turnId
                  ? workspace.latestTurn.requestedAt
                  : payload.completedAt,
              startedAt:
                workspace.latestTurn?.turnId === payload.turnId
                  ? (workspace.latestTurn.startedAt ?? payload.completedAt)
                  : payload.completedAt,
              completedAt: payload.completedAt,
              assistantMessageId: payload.assistantMessageId,
            },
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "workspace.reverted":
      return decodeForEvent(WorkspaceRevertedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const workspace = nextBase.workspaces.find((entry) => entry.id === payload.workspaceId);
          if (!workspace) {
            return nextBase;
          }

          const checkpoints = workspace.checkpoints
            .filter((entry) => entry.checkpointTurnCount <= payload.turnCount)
            .toSorted((left, right) => left.checkpointTurnCount - right.checkpointTurnCount)
            .slice(-MAX_WORKSPACE_CHECKPOINTS);
          const retainedTurnIds = new Set(checkpoints.map((checkpoint) => checkpoint.turnId));
          const messages = retainWorkspaceMessagesAfterRevert(
            workspace.messages,
            retainedTurnIds,
            payload.turnCount,
          ).slice(-MAX_WORKSPACE_MESSAGES);
          const proposedPlans = retainWorkspaceProposedPlansAfterRevert(
            workspace.proposedPlans,
            retainedTurnIds,
          ).slice(-200);
          const activities = retainWorkspaceActivitiesAfterRevert(
            workspace.activities,
            retainedTurnIds,
          );

          const latestCheckpoint = checkpoints.at(-1) ?? null;
          const latestTurn =
            latestCheckpoint === null
              ? null
              : {
                  turnId: latestCheckpoint.turnId,
                  state: checkpointStatusToLatestTurnState(latestCheckpoint.status),
                  requestedAt: latestCheckpoint.completedAt,
                  startedAt: latestCheckpoint.completedAt,
                  completedAt: latestCheckpoint.completedAt,
                  assistantMessageId: latestCheckpoint.assistantMessageId,
                };

          return {
            ...nextBase,
            workspaces: updateWorkspace(nextBase.workspaces, payload.workspaceId, {
              checkpoints,
              messages,
              proposedPlans,
              activities,
              latestTurn,
              updatedAt: event.occurredAt,
            }),
          };
        }),
      );

    case "workspace.activity-appended":
      return decodeForEvent(
        WorkspaceActivityAppendedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const workspace = nextBase.workspaces.find((entry) => entry.id === payload.workspaceId);
          if (!workspace) {
            return nextBase;
          }

          const activities = [
            ...workspace.activities.filter((entry) => entry.id !== payload.activity.id),
            payload.activity,
          ]
            .toSorted(compareWorkspaceActivities)
            .slice(-500);

          return {
            ...nextBase,
            workspaces: updateWorkspace(nextBase.workspaces, payload.workspaceId, {
              activities,
              updatedAt: event.occurredAt,
            }),
          };
        }),
      );

    default:
      return Effect.succeed(nextBase);
  }
}
