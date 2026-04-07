import { DEFAULT_RUNTIME_MODE, type ProjectId, WorkspaceId } from "@matcha/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { type DraftWorkspaceEnvMode, useComposerDraftStore } from "../composerDraftStore";
import { newWorkspaceId } from "../lib/utils";
import { orderItemsByPreferredIds } from "../components/Sidebar.logic";
import { useStore } from "../store";
import { useWorkspaceById } from "../storeSelectors";
import { useUiStateStore } from "../uiStateStore";

export function useHandleNewWorkspace() {
  const projectIds = useStore(useShallow((store) => store.projects.map((project) => project.id)));
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const navigate = useNavigate();
  const routeWorkspaceId = useParams({
    strict: false,
    select: (params) => (params.workspaceId ? WorkspaceId.makeUnsafe(params.workspaceId) : null),
  });
  const activeWorkspace = useWorkspaceById(routeWorkspaceId);
  const activeDraftWorkspace = useComposerDraftStore((store) =>
    routeWorkspaceId ? (store.draftWorkspacesByWorkspaceId[routeWorkspaceId] ?? null) : null,
  );
  const orderedProjects = useMemo(() => {
    return orderItemsByPreferredIds({
      items: projectIds,
      preferredIds: projectOrder,
      getId: (projectId) => projectId,
    });
  }, [projectIds, projectOrder]);

  const handleNewWorkspace = useCallback(
    (
      projectId: ProjectId,
      options?: {
        branch?: string | null;
        worktreePath?: string | null;
        envMode?: DraftWorkspaceEnvMode;
      },
    ): Promise<void> => {
      const { applyStickyState, upsertDraftWorkspace } = useComposerDraftStore.getState();
      const workspaceId = newWorkspaceId();
      const createdAt = new Date().toISOString();
      return (async () => {
        upsertDraftWorkspace(workspaceId, {
          projectId,
          createdAt,
          branch: options?.branch ?? null,
          worktreePath: options?.worktreePath ?? null,
          envMode: options?.envMode ?? "local",
          runtimeMode: DEFAULT_RUNTIME_MODE,
        });
        applyStickyState(workspaceId);

        await navigate({
          to: "/$workspaceId",
          params: { workspaceId },
        });
      })();
    },
    [navigate],
  );

  return {
    activeDraftWorkspace,
    activeWorkspace,
    defaultProjectId: orderedProjects[0] ?? null,
    handleNewWorkspace,
    routeWorkspaceId,
  };
}
