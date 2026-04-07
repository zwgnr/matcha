import {
  CheckpointRef,
  EventId,
  MessageId,
  ProjectId,
  WorkspaceId,
  TurnId,
  type OrchestrationEvent,
} from "@matcha/contracts";
import { describe, expect, it } from "vitest";

import { deriveOrchestrationBatchEffects } from "./orchestrationEventEffects";

function makeEvent<T extends OrchestrationEvent["type"]>(
  type: T,
  payload: Extract<OrchestrationEvent, { type: T }>["payload"],
  overrides: Partial<Extract<OrchestrationEvent, { type: T }>> = {},
): Extract<OrchestrationEvent, { type: T }> {
  const sequence = overrides.sequence ?? 1;
  return {
    sequence,
    eventId: EventId.makeUnsafe(`event-${sequence}`),
    aggregateKind: "workspace",
    aggregateId:
      "workspaceId" in payload
        ? payload.workspaceId
        : "projectId" in payload
          ? payload.projectId
          : ProjectId.makeUnsafe("project-1"),
    occurredAt: "2026-02-27T00:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type,
    payload,
    ...overrides,
  } as Extract<OrchestrationEvent, { type: T }>;
}

describe("deriveOrchestrationBatchEffects", () => {
  it("targets draft promotion and terminal cleanup from workspace lifecycle events", () => {
    const createdWorkspaceId = WorkspaceId.makeUnsafe("workspace-created");
    const deletedWorkspaceId = WorkspaceId.makeUnsafe("workspace-deleted");
    const archivedWorkspaceId = WorkspaceId.makeUnsafe("workspace-archived");

    const effects = deriveOrchestrationBatchEffects([
      makeEvent("workspace.created", {
        workspaceId: createdWorkspaceId,
        projectId: ProjectId.makeUnsafe("project-1"),
        title: "Created workspace",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: "2026-02-27T00:00:00.000Z",
        updatedAt: "2026-02-27T00:00:00.000Z",
      }),
      makeEvent("workspace.deleted", {
        workspaceId: deletedWorkspaceId,
        deletedAt: "2026-02-27T00:00:01.000Z",
      }),
      makeEvent("workspace.archived", {
        workspaceId: archivedWorkspaceId,
        archivedAt: "2026-02-27T00:00:02.000Z",
        updatedAt: "2026-02-27T00:00:02.000Z",
      }),
    ]);

    expect(effects.clearPromotedDraftWorkspaceIds).toEqual([createdWorkspaceId]);
    expect(effects.clearDeletedWorkspaceIds).toEqual([deletedWorkspaceId]);
    expect(effects.removeTerminalStateWorkspaceIds).toEqual([
      deletedWorkspaceId,
      archivedWorkspaceId,
    ]);
    expect(effects.needsProviderInvalidation).toBe(false);
  });

  it("keeps only the final lifecycle outcome for a workspace within one batch", () => {
    const workspaceId = WorkspaceId.makeUnsafe("workspace-1");

    const effects = deriveOrchestrationBatchEffects([
      makeEvent("workspace.deleted", {
        workspaceId,
        deletedAt: "2026-02-27T00:00:01.000Z",
      }),
      makeEvent("workspace.created", {
        workspaceId,
        projectId: ProjectId.makeUnsafe("project-1"),
        title: "Recreated workspace",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: "2026-02-27T00:00:02.000Z",
        updatedAt: "2026-02-27T00:00:02.000Z",
      }),
      makeEvent("workspace.turn-diff-completed", {
        workspaceId,
        turnId: TurnId.makeUnsafe("turn-1"),
        checkpointTurnCount: 1,
        checkpointRef: CheckpointRef.makeUnsafe("checkpoint-1"),
        status: "ready",
        files: [],
        assistantMessageId: MessageId.makeUnsafe("assistant-1"),
        completedAt: "2026-02-27T00:00:03.000Z",
      }),
    ]);

    expect(effects.clearPromotedDraftWorkspaceIds).toEqual([workspaceId]);
    expect(effects.clearDeletedWorkspaceIds).toEqual([]);
    expect(effects.removeTerminalStateWorkspaceIds).toEqual([]);
    expect(effects.needsProviderInvalidation).toBe(true);
  });

  it("does not retain archive cleanup when a workspace is unarchived later in the same batch", () => {
    const workspaceId = WorkspaceId.makeUnsafe("workspace-1");

    const effects = deriveOrchestrationBatchEffects([
      makeEvent("workspace.archived", {
        workspaceId,
        archivedAt: "2026-02-27T00:00:01.000Z",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
      makeEvent("workspace.unarchived", {
        workspaceId,
        updatedAt: "2026-02-27T00:00:02.000Z",
      }),
    ]);

    expect(effects.clearPromotedDraftWorkspaceIds).toEqual([]);
    expect(effects.clearDeletedWorkspaceIds).toEqual([]);
    expect(effects.removeTerminalStateWorkspaceIds).toEqual([]);
  });
});
