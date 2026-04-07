import type { OrchestrationEvent, WorkspaceId } from "@matcha/contracts";

export interface OrchestrationBatchEffects {
  clearPromotedDraftWorkspaceIds: WorkspaceId[];
  clearDeletedWorkspaceIds: WorkspaceId[];
  removeTerminalStateWorkspaceIds: WorkspaceId[];
  needsProviderInvalidation: boolean;
}

export function deriveOrchestrationBatchEffects(
  events: readonly OrchestrationEvent[],
): OrchestrationBatchEffects {
  const workspaceLifecycleEffects = new Map<
    WorkspaceId,
    {
      clearPromotedDraft: boolean;
      clearDeletedWorkspace: boolean;
      removeTerminalState: boolean;
    }
  >();
  let needsProviderInvalidation = false;

  for (const event of events) {
    switch (event.type) {
      case "workspace.turn-diff-completed":
      case "workspace.reverted": {
        needsProviderInvalidation = true;
        break;
      }

      case "workspace.created": {
        workspaceLifecycleEffects.set(event.payload.workspaceId, {
          clearPromotedDraft: true,
          clearDeletedWorkspace: false,
          removeTerminalState: false,
        });
        break;
      }

      case "workspace.deleted": {
        workspaceLifecycleEffects.set(event.payload.workspaceId, {
          clearPromotedDraft: false,
          clearDeletedWorkspace: true,
          removeTerminalState: true,
        });
        break;
      }

      case "workspace.archived": {
        workspaceLifecycleEffects.set(event.payload.workspaceId, {
          clearPromotedDraft: false,
          clearDeletedWorkspace: false,
          removeTerminalState: true,
        });
        break;
      }

      case "workspace.unarchived": {
        workspaceLifecycleEffects.set(event.payload.workspaceId, {
          clearPromotedDraft: false,
          clearDeletedWorkspace: false,
          removeTerminalState: false,
        });
        break;
      }

      default: {
        break;
      }
    }
  }

  const clearPromotedDraftWorkspaceIds: WorkspaceId[] = [];
  const clearDeletedWorkspaceIds: WorkspaceId[] = [];
  const removeTerminalStateWorkspaceIds: WorkspaceId[] = [];
  for (const [workspaceId, effect] of workspaceLifecycleEffects) {
    if (effect.clearPromotedDraft) {
      clearPromotedDraftWorkspaceIds.push(workspaceId);
    }
    if (effect.clearDeletedWorkspace) {
      clearDeletedWorkspaceIds.push(workspaceId);
    }
    if (effect.removeTerminalState) {
      removeTerminalStateWorkspaceIds.push(workspaceId);
    }
  }

  return {
    clearPromotedDraftWorkspaceIds,
    clearDeletedWorkspaceIds,
    removeTerminalStateWorkspaceIds,
    needsProviderInvalidation,
  };
}
