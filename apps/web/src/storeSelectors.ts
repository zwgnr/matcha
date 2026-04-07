import { type WorkspaceId } from "@matcha/contracts";
import { useMemo } from "react";
import {
  selectProjectById,
  selectSidebarWorkspaceSummaryById,
  selectWorkspaceById,
  useStore,
} from "./store";
import { type Project, type SidebarWorkspaceSummary, type Workspace } from "./types";

export function useProjectById(projectId: Project["id"] | null | undefined): Project | undefined {
  const selector = useMemo(() => selectProjectById(projectId), [projectId]);
  return useStore(selector);
}

export function useWorkspaceById(
  workspaceId: WorkspaceId | null | undefined,
): Workspace | undefined {
  const selector = useMemo(() => selectWorkspaceById(workspaceId), [workspaceId]);
  return useStore(selector);
}

export function useSidebarWorkspaceSummaryById(
  workspaceId: WorkspaceId | null | undefined,
): SidebarWorkspaceSummary | undefined {
  const selector = useMemo(() => selectSidebarWorkspaceSummaryById(workspaceId), [workspaceId]);
  return useStore(selector);
}
