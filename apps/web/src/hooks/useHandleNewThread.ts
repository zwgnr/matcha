import { DEFAULT_RUNTIME_MODE, type ProjectId, ThreadId } from "@matcha/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { type DraftThreadEnvMode, useComposerDraftStore } from "../composerDraftStore";
import { newThreadId } from "../lib/utils";
import { orderItemsByPreferredIds } from "../components/Sidebar.logic";
import { useStore } from "../store";
import { useThreadById } from "../storeSelectors";
import { useUiStateStore } from "../uiStateStore";

export function useHandleNewThread() {
  const projectIds = useStore(useShallow((store) => store.projects.map((project) => project.id)));
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const navigate = useNavigate();
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const activeThread = useThreadById(routeThreadId);
  const activeDraftThread = useComposerDraftStore((store) =>
    routeThreadId ? (store.draftThreadsByThreadId[routeThreadId] ?? null) : null,
  );
  const orderedProjects = useMemo(() => {
    return orderItemsByPreferredIds({
      items: projectIds,
      preferredIds: projectOrder,
      getId: (projectId) => projectId,
    });
  }, [projectIds, projectOrder]);

  const handleNewThread = useCallback(
    (
      projectId: ProjectId,
      options?: {
        branch?: string | null;
        worktreePath?: string | null;
        envMode?: DraftThreadEnvMode;
      },
    ): Promise<void> => {
      const { applyStickyState, upsertDraftThread } = useComposerDraftStore.getState();
      const threadId = newThreadId();
      const createdAt = new Date().toISOString();
      return (async () => {
        upsertDraftThread(threadId, {
          projectId,
          createdAt,
          branch: options?.branch ?? null,
          worktreePath: options?.worktreePath ?? null,
          envMode: options?.envMode ?? "local",
          runtimeMode: DEFAULT_RUNTIME_MODE,
        });
        applyStickyState(threadId);

        await navigate({
          to: "/$threadId",
          params: { threadId },
        });
      })();
    },
    [navigate],
  );

  return {
    activeDraftThread,
    activeThread,
    defaultProjectId: orderedProjects[0] ?? null,
    handleNewThread,
    routeThreadId,
  };
}
