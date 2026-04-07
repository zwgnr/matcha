import * as React from "react";
import type {
  SidebarProjectSortOrder,
  SidebarWorkspaceSortOrder,
} from "@matcha/contracts/settings";
import type { SidebarWorkspaceSummary, Workspace } from "../types";
import { cn } from "../lib/utils";
import { isLatestTurnSettled } from "../session-logic";

export const WORKSPACE_SELECTION_SAFE_SELECTOR =
  "[data-workspace-item], [data-workspace-selection-safe]";
export const WORKSPACE_JUMP_HINT_SHOW_DELAY_MS = 100;
export type SidebarNewWorkspaceEnvMode = "local" | "worktree";
type SidebarProject = {
  id: string;
  name: string;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
};
type SidebarWorkspaceSortInput = Pick<Workspace, "createdAt" | "updatedAt"> & {
  latestUserMessageAt?: string | null;
  messages?: Pick<Workspace["messages"][number], "createdAt" | "role">[];
};

export type WorkspaceTraversalDirection = "previous" | "next";

export interface WorkspaceStatusPill {
  label:
    | "Working"
    | "Connecting"
    | "Completed"
    | "Pending Approval"
    | "Awaiting Input"
    | "Plan Ready";
  colorClass: string;
  dotClass: string;
  pulse: boolean;
}

const WORKSPACE_STATUS_PRIORITY: Record<WorkspaceStatusPill["label"], number> = {
  "Pending Approval": 5,
  "Awaiting Input": 4,
  Working: 3,
  Connecting: 3,
  "Plan Ready": 2,
  Completed: 1,
};

type WorkspaceStatusInput = Pick<
  SidebarWorkspaceSummary,
  | "hasActionableProposedPlan"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "interactionMode"
  | "latestTurn"
  | "session"
> & {
  lastVisitedAt?: string | undefined;
};

export interface WorkspaceJumpHintVisibilityController {
  sync: (shouldShow: boolean) => void;
  dispose: () => void;
}

export function createWorkspaceJumpHintVisibilityController(input: {
  delayMs: number;
  onVisibilityChange: (visible: boolean) => void;
  setTimeoutFn?: typeof globalThis.setTimeout;
  clearTimeoutFn?: typeof globalThis.clearTimeout;
}): WorkspaceJumpHintVisibilityController {
  const setTimeoutFn = input.setTimeoutFn ?? globalThis.setTimeout;
  const clearTimeoutFn = input.clearTimeoutFn ?? globalThis.clearTimeout;
  let isVisible = false;
  let timeoutId: NodeJS.Timeout | null = null;

  const clearPendingShow = () => {
    if (timeoutId === null) {
      return;
    }
    clearTimeoutFn(timeoutId);
    timeoutId = null;
  };

  return {
    sync: (shouldShow) => {
      if (!shouldShow) {
        clearPendingShow();
        if (isVisible) {
          isVisible = false;
          input.onVisibilityChange(false);
        }
        return;
      }

      if (isVisible || timeoutId !== null) {
        return;
      }

      timeoutId = setTimeoutFn(() => {
        timeoutId = null;
        isVisible = true;
        input.onVisibilityChange(true);
      }, input.delayMs);
    },
    dispose: () => {
      clearPendingShow();
    },
  };
}

export function useWorkspaceJumpHintVisibility(): {
  showWorkspaceJumpHints: boolean;
  updateWorkspaceJumpHintsVisibility: (shouldShow: boolean) => void;
} {
  const [showWorkspaceJumpHints, setShowWorkspaceJumpHints] = React.useState(false);
  const controllerRef = React.useRef<WorkspaceJumpHintVisibilityController | null>(null);

  React.useEffect(() => {
    const controller = createWorkspaceJumpHintVisibilityController({
      delayMs: WORKSPACE_JUMP_HINT_SHOW_DELAY_MS,
      onVisibilityChange: (visible) => {
        setShowWorkspaceJumpHints(visible);
      },
      setTimeoutFn: window.setTimeout.bind(window),
      clearTimeoutFn: window.clearTimeout.bind(window),
    });
    controllerRef.current = controller;

    return () => {
      controller.dispose();
      controllerRef.current = null;
    };
  }, []);

  const updateWorkspaceJumpHintsVisibility = React.useCallback((shouldShow: boolean) => {
    controllerRef.current?.sync(shouldShow);
  }, []);

  return {
    showWorkspaceJumpHints,
    updateWorkspaceJumpHintsVisibility,
  };
}

export function hasUnseenCompletion(workspace: WorkspaceStatusInput): boolean {
  if (!workspace.latestTurn?.completedAt) return false;
  const completedAt = Date.parse(workspace.latestTurn.completedAt);
  if (Number.isNaN(completedAt)) return false;
  if (!workspace.lastVisitedAt) return true;

  const lastVisitedAt = Date.parse(workspace.lastVisitedAt);
  if (Number.isNaN(lastVisitedAt)) return true;
  return completedAt > lastVisitedAt;
}

export function shouldClearWorkspaceSelectionOnMouseDown(target: HTMLElement | null): boolean {
  if (target === null) return true;
  return !target.closest(WORKSPACE_SELECTION_SAFE_SELECTOR);
}

export function resolveSidebarNewWorkspaceEnvMode(input: {
  requestedEnvMode?: SidebarNewWorkspaceEnvMode;
  defaultEnvMode: SidebarNewWorkspaceEnvMode;
}): SidebarNewWorkspaceEnvMode {
  return input.requestedEnvMode ?? input.defaultEnvMode;
}

export function resolveSidebarNewWorkspaceSeedContext(input: {
  projectId: string;
  defaultEnvMode: SidebarNewWorkspaceEnvMode;
  activeWorkspace?: {
    projectId: string;
    branch: string | null;
    worktreePath: string | null;
  } | null;
  activeDraftWorkspace?: {
    projectId: string;
    branch: string | null;
    worktreePath: string | null;
    envMode: SidebarNewWorkspaceEnvMode;
  } | null;
}): {
  branch?: string | null;
  worktreePath?: string | null;
  envMode: SidebarNewWorkspaceEnvMode;
} {
  if (input.activeDraftWorkspace?.projectId === input.projectId) {
    return {
      branch: input.activeDraftWorkspace.branch,
      worktreePath: input.activeDraftWorkspace.worktreePath,
      envMode: input.activeDraftWorkspace.envMode,
    };
  }

  if (input.activeWorkspace?.projectId === input.projectId) {
    return {
      branch: input.activeWorkspace.branch,
      worktreePath: input.activeWorkspace.worktreePath,
      envMode: input.activeWorkspace.worktreePath ? "worktree" : "local",
    };
  }

  return {
    envMode: input.defaultEnvMode,
  };
}

export function orderItemsByPreferredIds<TItem, TId>(input: {
  items: readonly TItem[];
  preferredIds: readonly TId[];
  getId: (item: TItem) => TId;
}): TItem[] {
  const { getId, items, preferredIds } = input;
  if (preferredIds.length === 0) {
    return [...items];
  }

  const itemsById = new Map(items.map((item) => [getId(item), item] as const));
  const preferredIdSet = new Set(preferredIds);
  const emittedPreferredIds = new Set<TId>();
  const ordered = preferredIds.flatMap((id) => {
    if (emittedPreferredIds.has(id)) {
      return [];
    }
    const item = itemsById.get(id);
    if (!item) {
      return [];
    }
    emittedPreferredIds.add(id);
    return [item];
  });
  const remaining = items.filter((item) => !preferredIdSet.has(getId(item)));
  return [...ordered, ...remaining];
}

export function getVisibleSidebarWorkspaceIds<TWorkspaceId>(
  renderedProjects: readonly {
    shouldShowWorkspacePanel?: boolean;
    renderedWorkspaceIds: readonly TWorkspaceId[];
  }[],
): TWorkspaceId[] {
  return renderedProjects.flatMap((renderedProject) =>
    renderedProject.shouldShowWorkspacePanel === false ? [] : renderedProject.renderedWorkspaceIds,
  );
}

export function resolveAdjacentWorkspaceId<T>(input: {
  workspaceIds: readonly T[];
  currentWorkspaceId: T | null;
  direction: WorkspaceTraversalDirection;
}): T | null {
  const { currentWorkspaceId, direction, workspaceIds } = input;

  if (workspaceIds.length === 0) {
    return null;
  }

  if (currentWorkspaceId === null) {
    return direction === "previous" ? (workspaceIds.at(-1) ?? null) : (workspaceIds[0] ?? null);
  }

  const currentIndex = workspaceIds.indexOf(currentWorkspaceId);
  if (currentIndex === -1) {
    return null;
  }

  if (direction === "previous") {
    return currentIndex > 0 ? (workspaceIds[currentIndex - 1] ?? null) : null;
  }

  return currentIndex < workspaceIds.length - 1 ? (workspaceIds[currentIndex + 1] ?? null) : null;
}

export function isContextMenuPointerDown(input: {
  button: number;
  ctrlKey: boolean;
  isMac: boolean;
}): boolean {
  if (input.button === 2) return true;
  return input.isMac && input.button === 0 && input.ctrlKey;
}

export function resolveWorkspaceRowClassName(input: {
  isActive: boolean;
  isSelected: boolean;
}): string {
  const baseClassName =
    "h-7 w-full translate-x-0 cursor-pointer justify-start px-2 text-left select-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring";

  if (input.isSelected && input.isActive) {
    return cn(
      baseClassName,
      "bg-primary/22 text-foreground font-medium hover:bg-primary/26 hover:text-foreground dark:bg-primary/30 dark:hover:bg-primary/36",
    );
  }

  if (input.isSelected) {
    return cn(
      baseClassName,
      "bg-primary/15 text-foreground hover:bg-primary/19 hover:text-foreground dark:bg-primary/22 dark:hover:bg-primary/28",
    );
  }

  if (input.isActive) {
    return cn(
      baseClassName,
      "bg-accent/85 text-foreground font-medium hover:bg-accent hover:text-foreground dark:bg-accent/55 dark:hover:bg-accent/70",
    );
  }

  return cn(baseClassName, "text-muted-foreground hover:bg-accent hover:text-foreground");
}

export function resolveWorkspaceStatusPill(input: {
  workspace: WorkspaceStatusInput;
}): WorkspaceStatusPill | null {
  const { workspace } = input;

  if (workspace.hasPendingApprovals) {
    return {
      label: "Pending Approval",
      colorClass: "text-amber-600 dark:text-amber-300/90",
      dotClass: "bg-amber-500 dark:bg-amber-300/90",
      pulse: false,
    };
  }

  if (workspace.hasPendingUserInput) {
    return {
      label: "Awaiting Input",
      colorClass: "text-indigo-600 dark:text-indigo-300/90",
      dotClass: "bg-indigo-500 dark:bg-indigo-300/90",
      pulse: false,
    };
  }

  if (workspace.session?.status === "running") {
    return {
      label: "Working",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: true,
    };
  }

  if (workspace.session?.status === "connecting") {
    return {
      label: "Connecting",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: true,
    };
  }

  const hasPlanReadyPrompt =
    !workspace.hasPendingUserInput &&
    workspace.interactionMode === "plan" &&
    isLatestTurnSettled(workspace.latestTurn, workspace.session) &&
    workspace.hasActionableProposedPlan;
  if (hasPlanReadyPrompt) {
    return {
      label: "Plan Ready",
      colorClass: "text-violet-600 dark:text-violet-300/90",
      dotClass: "bg-violet-500 dark:bg-violet-300/90",
      pulse: false,
    };
  }

  if (hasUnseenCompletion(workspace)) {
    return {
      label: "Completed",
      colorClass: "text-emerald-600 dark:text-emerald-300/90",
      dotClass: "bg-emerald-500 dark:bg-emerald-300/90",
      pulse: false,
    };
  }

  return null;
}

export function resolveProjectStatusIndicator(
  statuses: ReadonlyArray<WorkspaceStatusPill | null>,
): WorkspaceStatusPill | null {
  let highestPriorityStatus: WorkspaceStatusPill | null = null;

  for (const status of statuses) {
    if (status === null) continue;
    if (
      highestPriorityStatus === null ||
      WORKSPACE_STATUS_PRIORITY[status.label] >
        WORKSPACE_STATUS_PRIORITY[highestPriorityStatus.label]
    ) {
      highestPriorityStatus = status;
    }
  }

  return highestPriorityStatus;
}

export function getVisibleWorkspacesForProject<T extends Pick<Workspace, "id">>(input: {
  workspaces: readonly T[];
  activeWorkspaceId: T["id"] | undefined;
  isWorkspaceListExpanded: boolean;
  previewLimit: number;
}): {
  hasHiddenWorkspaces: boolean;
  visibleWorkspaces: T[];
  hiddenWorkspaces: T[];
} {
  const { activeWorkspaceId, isWorkspaceListExpanded, previewLimit, workspaces } = input;
  const hasHiddenWorkspaces = workspaces.length > previewLimit;

  if (!hasHiddenWorkspaces || isWorkspaceListExpanded) {
    return {
      hasHiddenWorkspaces,
      hiddenWorkspaces: [],
      visibleWorkspaces: [...workspaces],
    };
  }

  const previewWorkspaces = workspaces.slice(0, previewLimit);
  if (
    !activeWorkspaceId ||
    previewWorkspaces.some((workspace) => workspace.id === activeWorkspaceId)
  ) {
    return {
      hasHiddenWorkspaces: true,
      hiddenWorkspaces: workspaces.slice(previewLimit),
      visibleWorkspaces: previewWorkspaces,
    };
  }

  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId);
  if (!activeWorkspace) {
    return {
      hasHiddenWorkspaces: true,
      hiddenWorkspaces: workspaces.slice(previewLimit),
      visibleWorkspaces: previewWorkspaces,
    };
  }

  const visibleWorkspaceIds = new Set(
    [...previewWorkspaces, activeWorkspace].map((workspace) => workspace.id),
  );

  return {
    hasHiddenWorkspaces: true,
    hiddenWorkspaces: workspaces.filter((workspace) => !visibleWorkspaceIds.has(workspace.id)),
    visibleWorkspaces: workspaces.filter((workspace) => visibleWorkspaceIds.has(workspace.id)),
  };
}

function toSortableTimestamp(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function getLatestUserMessageTimestamp(workspace: SidebarWorkspaceSortInput): number {
  if (workspace.latestUserMessageAt) {
    return toSortableTimestamp(workspace.latestUserMessageAt) ?? Number.NEGATIVE_INFINITY;
  }

  let latestUserMessageTimestamp: number | null = null;

  for (const message of workspace.messages ?? []) {
    if (message.role !== "user") continue;
    const messageTimestamp = toSortableTimestamp(message.createdAt);
    if (messageTimestamp === null) continue;
    latestUserMessageTimestamp =
      latestUserMessageTimestamp === null
        ? messageTimestamp
        : Math.max(latestUserMessageTimestamp, messageTimestamp);
  }

  if (latestUserMessageTimestamp !== null) {
    return latestUserMessageTimestamp;
  }

  return (
    toSortableTimestamp(workspace.updatedAt ?? workspace.createdAt) ?? Number.NEGATIVE_INFINITY
  );
}

function getWorkspaceSortTimestamp(
  workspace: SidebarWorkspaceSortInput,
  sortOrder: SidebarWorkspaceSortOrder | Exclude<SidebarProjectSortOrder, "manual">,
): number {
  if (sortOrder === "created_at") {
    return toSortableTimestamp(workspace.createdAt) ?? Number.NEGATIVE_INFINITY;
  }
  return getLatestUserMessageTimestamp(workspace);
}

export function sortWorkspacesForSidebar<
  T extends Pick<Workspace, "id" | "createdAt" | "updatedAt"> & SidebarWorkspaceSortInput,
>(workspaces: readonly T[], sortOrder: SidebarWorkspaceSortOrder): T[] {
  return workspaces.toSorted((left, right) => {
    const rightTimestamp = getWorkspaceSortTimestamp(right, sortOrder);
    const leftTimestamp = getWorkspaceSortTimestamp(left, sortOrder);
    const byTimestamp =
      rightTimestamp === leftTimestamp ? 0 : rightTimestamp > leftTimestamp ? 1 : -1;
    if (byTimestamp !== 0) return byTimestamp;
    return right.id.localeCompare(left.id);
  });
}

export function getFallbackWorkspaceIdAfterDelete<
  T extends Pick<Workspace, "id" | "projectId" | "createdAt" | "updatedAt"> &
    SidebarWorkspaceSortInput,
>(input: {
  workspaces: readonly T[];
  deletedWorkspaceId: T["id"];
  sortOrder: SidebarWorkspaceSortOrder;
  deletedWorkspaceIds?: ReadonlySet<T["id"]>;
}): T["id"] | null {
  const { deletedWorkspaceId, deletedWorkspaceIds, sortOrder, workspaces } = input;
  const deletedWorkspace = workspaces.find((workspace) => workspace.id === deletedWorkspaceId);
  if (!deletedWorkspace) {
    return null;
  }

  return (
    sortWorkspacesForSidebar(
      workspaces.filter(
        (workspace) =>
          workspace.projectId === deletedWorkspace.projectId &&
          workspace.id !== deletedWorkspaceId &&
          !deletedWorkspaceIds?.has(workspace.id),
      ),
      sortOrder,
    )[0]?.id ?? null
  );
}

export function getProjectSortTimestamp(
  project: SidebarProject,
  projectWorkspaces: readonly SidebarWorkspaceSortInput[],
  sortOrder: Exclude<SidebarProjectSortOrder, "manual">,
): number {
  if (projectWorkspaces.length > 0) {
    return projectWorkspaces.reduce(
      (latest, workspace) => Math.max(latest, getWorkspaceSortTimestamp(workspace, sortOrder)),
      Number.NEGATIVE_INFINITY,
    );
  }

  if (sortOrder === "created_at") {
    return toSortableTimestamp(project.createdAt) ?? Number.NEGATIVE_INFINITY;
  }
  return toSortableTimestamp(project.updatedAt ?? project.createdAt) ?? Number.NEGATIVE_INFINITY;
}

export function sortProjectsForSidebar<
  TProject extends SidebarProject,
  TWorkspace extends Pick<Workspace, "projectId" | "createdAt" | "updatedAt"> &
    SidebarWorkspaceSortInput,
>(
  projects: readonly TProject[],
  workspaces: readonly TWorkspace[],
  sortOrder: SidebarProjectSortOrder,
): TProject[] {
  if (sortOrder === "manual") {
    return [...projects];
  }

  const workspacesByProjectId = new Map<string, TWorkspace[]>();
  for (const workspace of workspaces) {
    const existing = workspacesByProjectId.get(workspace.projectId) ?? [];
    existing.push(workspace);
    workspacesByProjectId.set(workspace.projectId, existing);
  }

  return [...projects].toSorted((left, right) => {
    const rightTimestamp = getProjectSortTimestamp(
      right,
      workspacesByProjectId.get(right.id) ?? [],
      sortOrder,
    );
    const leftTimestamp = getProjectSortTimestamp(
      left,
      workspacesByProjectId.get(left.id) ?? [],
      sortOrder,
    );
    const byTimestamp =
      rightTimestamp === leftTimestamp ? 0 : rightTimestamp > leftTimestamp ? 1 : -1;
    if (byTimestamp !== 0) return byTimestamp;
    return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
  });
}
