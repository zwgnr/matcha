import type {
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationReadModel,
} from "@matcha/contracts";
import { Effect } from "effect";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import {
  requireProject,
  requireProjectAbsent,
  requireWorkspace,
  requireWorkspaceArchived,
  requireWorkspaceAbsent,
  requireWorkspaceNotArchived,
} from "./commandInvariants.ts";

const nowIso = () => new Date().toISOString();
const defaultMetadata: Omit<OrchestrationEvent, "sequence" | "type" | "payload"> = {
  eventId: crypto.randomUUID() as OrchestrationEvent["eventId"],
  aggregateKind: "workspace",
  aggregateId: "" as OrchestrationEvent["aggregateId"],
  occurredAt: nowIso(),
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
};

function withEventBase(
  input: Pick<OrchestrationCommand, "commandId"> & {
    readonly aggregateKind: OrchestrationEvent["aggregateKind"];
    readonly aggregateId: OrchestrationEvent["aggregateId"];
    readonly occurredAt: string;
    readonly metadata?: OrchestrationEvent["metadata"];
  },
): Omit<OrchestrationEvent, "sequence" | "type" | "payload"> {
  return {
    ...defaultMetadata,
    eventId: crypto.randomUUID() as OrchestrationEvent["eventId"],
    aggregateKind: input.aggregateKind,
    aggregateId: input.aggregateId,
    occurredAt: input.occurredAt,
    commandId: input.commandId,
    correlationId: input.commandId,
    metadata: input.metadata ?? {},
  };
}

export const decideOrchestrationCommand = Effect.fn("decideOrchestrationCommand")(function* ({
  command,
  readModel,
}: {
  readonly command: OrchestrationCommand;
  readonly readModel: OrchestrationReadModel;
}): Effect.fn.Return<
  Omit<OrchestrationEvent, "sequence"> | ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
  OrchestrationCommandInvariantError
> {
  switch (command.type) {
    case "project.create": {
      yield* requireProjectAbsent({
        readModel,
        command,
        projectId: command.projectId,
      });

      return {
        ...withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "project.created",
        payload: {
          projectId: command.projectId,
          title: command.title,
          workspaceRoot: command.workspaceRoot,
          defaultModelSelection: command.defaultModelSelection ?? null,
          scripts: [],
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "project.meta.update": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "project.meta-updated",
        payload: {
          projectId: command.projectId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.workspaceRoot !== undefined ? { workspaceRoot: command.workspaceRoot } : {}),
          ...(command.defaultModelSelection !== undefined
            ? { defaultModelSelection: command.defaultModelSelection }
            : {}),
          ...(command.scripts !== undefined ? { scripts: command.scripts } : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "project.delete": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "project.deleted",
        payload: {
          projectId: command.projectId,
          deletedAt: occurredAt,
        },
      };
    }

    case "workspace.create": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      yield* requireWorkspaceAbsent({
        readModel,
        command,
        workspaceId: command.workspaceId,
      });
      return {
        ...withEventBase({
          aggregateKind: "workspace",
          aggregateId: command.workspaceId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "workspace.created",
        payload: {
          workspaceId: command.workspaceId,
          projectId: command.projectId,
          title: command.title,
          modelSelection: command.modelSelection,
          runtimeMode: command.runtimeMode,
          interactionMode: command.interactionMode,
          branch: command.branch,
          worktreePath: command.worktreePath,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "workspace.delete": {
      yield* requireWorkspace({
        readModel,
        command,
        workspaceId: command.workspaceId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "workspace",
          aggregateId: command.workspaceId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "workspace.deleted",
        payload: {
          workspaceId: command.workspaceId,
          deletedAt: occurredAt,
        },
      };
    }

    case "workspace.archive": {
      yield* requireWorkspaceNotArchived({
        readModel,
        command,
        workspaceId: command.workspaceId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "workspace",
          aggregateId: command.workspaceId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "workspace.archived",
        payload: {
          workspaceId: command.workspaceId,
          archivedAt: occurredAt,
          updatedAt: occurredAt,
        },
      };
    }

    case "workspace.unarchive": {
      yield* requireWorkspaceArchived({
        readModel,
        command,
        workspaceId: command.workspaceId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "workspace",
          aggregateId: command.workspaceId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "workspace.unarchived",
        payload: {
          workspaceId: command.workspaceId,
          updatedAt: occurredAt,
        },
      };
    }

    case "workspace.meta.update": {
      yield* requireWorkspace({
        readModel,
        command,
        workspaceId: command.workspaceId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "workspace",
          aggregateId: command.workspaceId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "workspace.meta-updated",
        payload: {
          workspaceId: command.workspaceId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...(command.branch !== undefined ? { branch: command.branch } : {}),
          ...(command.worktreePath !== undefined ? { worktreePath: command.worktreePath } : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "workspace.runtime-mode.set": {
      yield* requireWorkspace({
        readModel,
        command,
        workspaceId: command.workspaceId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "workspace",
          aggregateId: command.workspaceId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "workspace.runtime-mode-set",
        payload: {
          workspaceId: command.workspaceId,
          runtimeMode: command.runtimeMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "workspace.interaction-mode.set": {
      yield* requireWorkspace({
        readModel,
        command,
        workspaceId: command.workspaceId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "workspace",
          aggregateId: command.workspaceId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "workspace.interaction-mode-set",
        payload: {
          workspaceId: command.workspaceId,
          interactionMode: command.interactionMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "workspace.turn.start": {
      const targetWorkspace = yield* requireWorkspace({
        readModel,
        command,
        workspaceId: command.workspaceId,
      });
      const sourceProposedPlan = command.sourceProposedPlan;
      const sourceWorkspace = sourceProposedPlan
        ? yield* requireWorkspace({
            readModel,
            command,
            workspaceId: sourceProposedPlan.workspaceId,
          })
        : null;
      const sourcePlan =
        sourceProposedPlan && sourceWorkspace
          ? sourceWorkspace.proposedPlans.find((entry) => entry.id === sourceProposedPlan.planId)
          : null;
      if (sourceProposedPlan && !sourcePlan) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Proposed plan '${sourceProposedPlan.planId}' does not exist on workspace '${sourceProposedPlan.workspaceId}'.`,
        });
      }
      if (sourceWorkspace && sourceWorkspace.projectId !== targetWorkspace.projectId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Proposed plan '${sourceProposedPlan?.planId}' belongs to workspace '${sourceWorkspace.id}' in a different project.`,
        });
      }
      const userMessageEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "workspace",
          aggregateId: command.workspaceId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "workspace.message-sent",
        payload: {
          workspaceId: command.workspaceId,
          messageId: command.message.messageId,
          role: "user",
          text: command.message.text,
          attachments: command.message.attachments,
          turnId: null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      const turnStartRequestedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "workspace",
          aggregateId: command.workspaceId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        causationEventId: userMessageEvent.eventId,
        type: "workspace.turn-start-requested",
        payload: {
          workspaceId: command.workspaceId,
          messageId: command.message.messageId,
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...(command.titleSeed !== undefined ? { titleSeed: command.titleSeed } : {}),
          runtimeMode: targetWorkspace.runtimeMode,
          interactionMode: targetWorkspace.interactionMode,
          ...(sourceProposedPlan !== undefined ? { sourceProposedPlan } : {}),
          createdAt: command.createdAt,
        },
      };
      return [userMessageEvent, turnStartRequestedEvent];
    }

    case "workspace.turn.interrupt": {
      yield* requireWorkspace({
        readModel,
        command,
        workspaceId: command.workspaceId,
      });
      return {
        ...withEventBase({
          aggregateKind: "workspace",
          aggregateId: command.workspaceId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "workspace.turn-interrupt-requested",
        payload: {
          workspaceId: command.workspaceId,
          ...(command.turnId !== undefined ? { turnId: command.turnId } : {}),
          createdAt: command.createdAt,
        },
      };
    }

    case "workspace.approval.respond": {
      yield* requireWorkspace({
        readModel,
        command,
        workspaceId: command.workspaceId,
      });
      return {
        ...withEventBase({
          aggregateKind: "workspace",
          aggregateId: command.workspaceId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {
            requestId: command.requestId,
          },
        }),
        type: "workspace.approval-response-requested",
        payload: {
          workspaceId: command.workspaceId,
          requestId: command.requestId,
          decision: command.decision,
          createdAt: command.createdAt,
        },
      };
    }

    case "workspace.user-input.respond": {
      yield* requireWorkspace({
        readModel,
        command,
        workspaceId: command.workspaceId,
      });
      return {
        ...withEventBase({
          aggregateKind: "workspace",
          aggregateId: command.workspaceId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {
            requestId: command.requestId,
          },
        }),
        type: "workspace.user-input-response-requested",
        payload: {
          workspaceId: command.workspaceId,
          requestId: command.requestId,
          answers: command.answers,
          createdAt: command.createdAt,
        },
      };
    }

    case "workspace.checkpoint.revert": {
      yield* requireWorkspace({
        readModel,
        command,
        workspaceId: command.workspaceId,
      });
      return {
        ...withEventBase({
          aggregateKind: "workspace",
          aggregateId: command.workspaceId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "workspace.checkpoint-revert-requested",
        payload: {
          workspaceId: command.workspaceId,
          turnCount: command.turnCount,
          createdAt: command.createdAt,
        },
      };
    }

    case "workspace.session.stop": {
      yield* requireWorkspace({
        readModel,
        command,
        workspaceId: command.workspaceId,
      });
      return {
        ...withEventBase({
          aggregateKind: "workspace",
          aggregateId: command.workspaceId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "workspace.session-stop-requested",
        payload: {
          workspaceId: command.workspaceId,
          createdAt: command.createdAt,
        },
      };
    }

    case "workspace.session.set": {
      yield* requireWorkspace({
        readModel,
        command,
        workspaceId: command.workspaceId,
      });
      return {
        ...withEventBase({
          aggregateKind: "workspace",
          aggregateId: command.workspaceId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {},
        }),
        type: "workspace.session-set",
        payload: {
          workspaceId: command.workspaceId,
          session: command.session,
        },
      };
    }

    case "workspace.message.assistant.delta": {
      yield* requireWorkspace({
        readModel,
        command,
        workspaceId: command.workspaceId,
      });
      return {
        ...withEventBase({
          aggregateKind: "workspace",
          aggregateId: command.workspaceId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "workspace.message-sent",
        payload: {
          workspaceId: command.workspaceId,
          messageId: command.messageId,
          role: "assistant",
          text: command.delta,
          turnId: command.turnId ?? null,
          streaming: true,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "workspace.message.assistant.complete": {
      yield* requireWorkspace({
        readModel,
        command,
        workspaceId: command.workspaceId,
      });
      return {
        ...withEventBase({
          aggregateKind: "workspace",
          aggregateId: command.workspaceId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "workspace.message-sent",
        payload: {
          workspaceId: command.workspaceId,
          messageId: command.messageId,
          role: "assistant",
          text: "",
          turnId: command.turnId ?? null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "workspace.proposed-plan.upsert": {
      yield* requireWorkspace({
        readModel,
        command,
        workspaceId: command.workspaceId,
      });
      return {
        ...withEventBase({
          aggregateKind: "workspace",
          aggregateId: command.workspaceId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "workspace.proposed-plan-upserted",
        payload: {
          workspaceId: command.workspaceId,
          proposedPlan: command.proposedPlan,
        },
      };
    }

    case "workspace.turn.diff.complete": {
      yield* requireWorkspace({
        readModel,
        command,
        workspaceId: command.workspaceId,
      });
      return {
        ...withEventBase({
          aggregateKind: "workspace",
          aggregateId: command.workspaceId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "workspace.turn-diff-completed",
        payload: {
          workspaceId: command.workspaceId,
          turnId: command.turnId,
          checkpointTurnCount: command.checkpointTurnCount,
          checkpointRef: command.checkpointRef,
          status: command.status,
          files: command.files,
          assistantMessageId: command.assistantMessageId ?? null,
          completedAt: command.completedAt,
        },
      };
    }

    case "workspace.revert.complete": {
      yield* requireWorkspace({
        readModel,
        command,
        workspaceId: command.workspaceId,
      });
      return {
        ...withEventBase({
          aggregateKind: "workspace",
          aggregateId: command.workspaceId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "workspace.reverted",
        payload: {
          workspaceId: command.workspaceId,
          turnCount: command.turnCount,
        },
      };
    }

    case "workspace.activity.append": {
      yield* requireWorkspace({
        readModel,
        command,
        workspaceId: command.workspaceId,
      });
      const requestId =
        typeof command.activity.payload === "object" &&
        command.activity.payload !== null &&
        "requestId" in command.activity.payload &&
        typeof (command.activity.payload as { requestId?: unknown }).requestId === "string"
          ? ((command.activity.payload as { requestId: string })
              .requestId as OrchestrationEvent["metadata"]["requestId"])
          : undefined;
      return {
        ...withEventBase({
          aggregateKind: "workspace",
          aggregateId: command.workspaceId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          ...(requestId !== undefined ? { metadata: { requestId } } : {}),
        }),
        type: "workspace.activity-appended",
        payload: {
          workspaceId: command.workspaceId,
          activity: command.activity,
        },
      };
    }

    default: {
      command satisfies never;
      const fallback = command as never as { type: string };
      return yield* new OrchestrationCommandInvariantError({
        commandType: fallback.type,
        detail: `Unknown command type: ${fallback.type}`,
      });
    }
  }
});
