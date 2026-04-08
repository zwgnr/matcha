import { WorkspaceId } from "@matcha/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useCallback } from "react";

import { getFallbackWorkspaceIdAfterDelete } from "../components/Sidebar.logic";
import { useComposerDraftStore } from "../composerDraftStore";
import { useHandleNewWorkspace } from "./useHandleNewWorkspace";
import { gitRemoveWorktreeMutationOptions } from "../lib/gitReactQuery";
import { newCommandId } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import { useTerminalStateStore } from "../terminalStateStore";
import {
  formatWorktreePathForDisplay,
  getOrphanedWorktreePathForWorkspace,
} from "../worktreeCleanup";
import { toastManager } from "../components/ui/toast";
import { useSettings } from "./useSettings";

export function useWorkspaceActions() {
  const appSettings = useSettings();
  const clearComposerDraftForWorkspace = useComposerDraftStore(
    (store) => store.clearDraftWorkspace,
  );
  const clearProjectDraftWorkspaceById = useComposerDraftStore(
    (store) => store.clearProjectDraftWorkspaceById,
  );
  const clearTerminalState = useTerminalStateStore((state) => state.clearTerminalState);
  const routeWorkspaceId = useParams({
    strict: false,
    select: (params) => (params.workspaceId ? WorkspaceId.makeUnsafe(params.workspaceId) : null),
  });
  const navigate = useNavigate();
  const { handleNewWorkspace } = useHandleNewWorkspace();
  const queryClient = useQueryClient();
  const removeWorktreeMutation = useMutation(gitRemoveWorktreeMutationOptions({ queryClient }));

  const archiveWorkspace = useCallback(
    async (workspaceId: WorkspaceId) => {
      const api = readNativeApi();
      if (!api) return;
      const workspace = useStore.getState().workspaces.find((entry) => entry.id === workspaceId);
      if (!workspace) return;
      if (workspace.session?.status === "running" && workspace.session.activeTurnId != null) {
        throw new Error("Cannot archive a running workspace.");
      }

      await api.orchestration.dispatchCommand({
        type: "workspace.archive",
        commandId: newCommandId(),
        workspaceId,
      });

      if (routeWorkspaceId === workspaceId) {
        await handleNewWorkspace(workspace.projectId);
      }
    },
    [handleNewWorkspace, routeWorkspaceId],
  );

  const unarchiveWorkspace = useCallback(async (workspaceId: WorkspaceId) => {
    const api = readNativeApi();
    if (!api) return;
    await api.orchestration.dispatchCommand({
      type: "workspace.unarchive",
      commandId: newCommandId(),
      workspaceId,
    });
  }, []);

  const deleteWorkspace = useCallback(
    async (
      workspaceId: WorkspaceId,
      opts: { deletedWorkspaceIds?: ReadonlySet<WorkspaceId> } = {},
    ) => {
      const api = readNativeApi();
      if (!api) return;
      const { projects, workspaces } = useStore.getState();
      const workspace = workspaces.find((entry) => entry.id === workspaceId);
      if (!workspace) return;
      const workspaceProject = projects.find((project) => project.id === workspace.projectId);
      const deletedIds = opts.deletedWorkspaceIds;
      const survivingWorkspaces =
        deletedIds && deletedIds.size > 0
          ? workspaces.filter((entry) => entry.id === workspaceId || !deletedIds.has(entry.id))
          : workspaces;
      const orphanedWorktreePath = getOrphanedWorktreePathForWorkspace(
        survivingWorkspaces,
        workspaceId,
      );
      const displayWorktreePath = orphanedWorktreePath
        ? formatWorktreePathForDisplay(orphanedWorktreePath)
        : null;
      const canDeleteWorktree = orphanedWorktreePath !== null && workspaceProject !== undefined;
      const shouldDeleteWorktree =
        canDeleteWorktree &&
        (await api.dialogs.confirm(
          [
            "This workspace is the only one linked to this worktree:",
            displayWorktreePath ?? orphanedWorktreePath,
            "",
            "Delete the worktree too?",
          ].join("\n"),
        ));

      if (workspace.session && workspace.session.status !== "closed") {
        await api.orchestration
          .dispatchCommand({
            type: "workspace.session.stop",
            commandId: newCommandId(),
            workspaceId,
            createdAt: new Date().toISOString(),
          })
          .catch(() => undefined);
      }

      try {
        await api.terminal.close({ workspaceId, deleteHistory: true });
      } catch {
        // Terminal may already be closed.
      }

      const deletedWorkspaceIds = opts.deletedWorkspaceIds ?? new Set<WorkspaceId>();
      const shouldNavigateToFallback = routeWorkspaceId === workspaceId;
      const fallbackWorkspaceId = getFallbackWorkspaceIdAfterDelete({
        workspaces,
        deletedWorkspaceId: workspaceId,
        deletedWorkspaceIds,
      });
      await api.orchestration.dispatchCommand({
        type: "workspace.delete",
        commandId: newCommandId(),
        workspaceId,
      });
      clearComposerDraftForWorkspace(workspaceId);
      clearProjectDraftWorkspaceById(workspace.projectId, workspace.id);
      clearTerminalState(workspaceId);

      if (shouldNavigateToFallback) {
        if (fallbackWorkspaceId) {
          await navigate({
            to: "/$workspaceId",
            params: { workspaceId: fallbackWorkspaceId },
            replace: true,
          });
        } else {
          await navigate({ to: "/", replace: true });
        }
      }

      if (!shouldDeleteWorktree || !orphanedWorktreePath || !workspaceProject) {
        return;
      }

      try {
        await removeWorktreeMutation.mutateAsync({
          cwd: workspaceProject.cwd,
          path: orphanedWorktreePath,
          force: true,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error removing worktree.";
        console.error("Failed to remove orphaned worktree after workspace deletion", {
          workspaceId,
          projectCwd: workspaceProject.cwd,
          worktreePath: orphanedWorktreePath,
          error,
        });
        toastManager.add({
          type: "error",
          title: "Workspace deleted, but worktree removal failed",
          description: `Could not remove ${displayWorktreePath ?? orphanedWorktreePath}. ${message}`,
        });
      }
    },
    [
      clearComposerDraftForWorkspace,
      clearProjectDraftWorkspaceById,
      clearTerminalState,
      navigate,
      removeWorktreeMutation,
      routeWorkspaceId,
    ],
  );

  const confirmAndDeleteWorkspace = useCallback(
    async (workspaceId: WorkspaceId) => {
      const api = readNativeApi();
      if (!api) return;
      const workspace = useStore.getState().workspaces.find((entry) => entry.id === workspaceId);
      if (!workspace) return;

      if (appSettings.confirmWorkspaceDelete) {
        const confirmed = await api.dialogs.confirm(
          [
            `Delete workspace "${workspace.title}"?`,
            "This permanently clears conversation history for this workspace.",
          ].join("\n"),
        );
        if (!confirmed) {
          return;
        }
      }

      await deleteWorkspace(workspaceId);
    },
    [appSettings.confirmWorkspaceDelete, deleteWorkspace],
  );

  return {
    archiveWorkspace,
    unarchiveWorkspace,
    deleteWorkspace,
    confirmAndDeleteWorkspace,
  };
}
