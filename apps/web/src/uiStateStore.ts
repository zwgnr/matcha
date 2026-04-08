import { Debouncer } from "@tanstack/react-pacer";
import { type ProjectId, type WorkspaceId } from "@matcha/contracts";
import { create } from "zustand";

const PERSISTED_STATE_KEY = "matcha:ui-state:v1";
const LEGACY_PERSISTED_STATE_KEYS = [
  "matcha:renderer-state:v8",
  "matcha:renderer-state:v7",
  "matcha:renderer-state:v6",
  "matcha:renderer-state:v5",
  "matcha:renderer-state:v4",
  "matcha:renderer-state:v3",
  "codething:renderer-state:v4",
  "codething:renderer-state:v3",
  "codething:renderer-state:v2",
  "codething:renderer-state:v1",
] as const;

interface PersistedUiState {
  expandedProjectCwds?: string[];
  projectOrderCwds?: string[];
  workspaceOrderByProjectCwd?: Record<string, string[]>;
}

export interface UiProjectState {
  projectExpandedById: Record<string, boolean>;
  projectOrder: ProjectId[];
}

export interface UiWorkspaceState {
  workspaceLastVisitedAtById: Record<string, string>;
  workspaceOrderByProjectId: Record<string, WorkspaceId[]>;
}

export interface UiState extends UiProjectState, UiWorkspaceState {}

export interface SyncProjectInput {
  id: ProjectId;
  cwd: string;
}

export interface SyncWorkspaceInput {
  id: WorkspaceId;
  seedVisitedAt?: string | undefined;
}

const initialState: UiState = {
  projectExpandedById: {},
  projectOrder: [],
  workspaceLastVisitedAtById: {},
  workspaceOrderByProjectId: {},
};

const persistedExpandedProjectCwds = new Set<string>();
const persistedProjectOrderCwds: string[] = [];
const persistedWorkspaceOrderByProjectCwd = new Map<string, string[]>();
const currentProjectCwdById = new Map<ProjectId, string>();
let legacyKeysCleanedUp = false;

function readPersistedState(): UiState {
  if (typeof window === "undefined") {
    return initialState;
  }
  try {
    const raw = window.localStorage.getItem(PERSISTED_STATE_KEY);
    if (!raw) {
      for (const legacyKey of LEGACY_PERSISTED_STATE_KEYS) {
        const legacyRaw = window.localStorage.getItem(legacyKey);
        if (!legacyRaw) {
          continue;
        }
        hydratePersistedProjectState(JSON.parse(legacyRaw) as PersistedUiState);
        return initialState;
      }
      return initialState;
    }
    hydratePersistedProjectState(JSON.parse(raw) as PersistedUiState);
    return initialState;
  } catch {
    return initialState;
  }
}

function hydratePersistedProjectState(parsed: PersistedUiState): void {
  persistedExpandedProjectCwds.clear();
  persistedProjectOrderCwds.length = 0;
  persistedWorkspaceOrderByProjectCwd.clear();
  for (const cwd of parsed.expandedProjectCwds ?? []) {
    if (typeof cwd === "string" && cwd.length > 0) {
      persistedExpandedProjectCwds.add(cwd);
    }
  }
  for (const cwd of parsed.projectOrderCwds ?? []) {
    if (typeof cwd === "string" && cwd.length > 0 && !persistedProjectOrderCwds.includes(cwd)) {
      persistedProjectOrderCwds.push(cwd);
    }
  }
  for (const [cwd, ids] of Object.entries(parsed.workspaceOrderByProjectCwd ?? {})) {
    if (typeof cwd === "string" && cwd.length > 0 && Array.isArray(ids)) {
      persistedWorkspaceOrderByProjectCwd.set(
        cwd,
        ids.filter((id): id is string => typeof id === "string" && id.length > 0),
      );
    }
  }
}

function persistState(state: UiState): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    const expandedProjectCwds = Object.entries(state.projectExpandedById)
      .filter(([, expanded]) => expanded)
      .flatMap(([projectId]) => {
        const cwd = currentProjectCwdById.get(projectId as ProjectId);
        return cwd ? [cwd] : [];
      });
    const projectOrderCwds = state.projectOrder.flatMap((projectId) => {
      const cwd = currentProjectCwdById.get(projectId);
      return cwd ? [cwd] : [];
    });
    const workspaceOrderByProjectCwd: Record<string, string[]> = {};
    for (const [projectId, workspaceIds] of Object.entries(state.workspaceOrderByProjectId)) {
      const cwd = currentProjectCwdById.get(projectId as ProjectId);
      if (cwd && workspaceIds.length > 0) {
        workspaceOrderByProjectCwd[cwd] = workspaceIds;
      }
    }
    window.localStorage.setItem(
      PERSISTED_STATE_KEY,
      JSON.stringify({
        expandedProjectCwds,
        projectOrderCwds,
        workspaceOrderByProjectCwd,
      } satisfies PersistedUiState),
    );
    if (!legacyKeysCleanedUp) {
      legacyKeysCleanedUp = true;
      for (const legacyKey of LEGACY_PERSISTED_STATE_KEYS) {
        window.localStorage.removeItem(legacyKey);
      }
    }
  } catch {
    // Ignore quota/storage errors to avoid breaking chat UX.
  }
}

const debouncedPersistState = new Debouncer(persistState, { wait: 500 });

function recordsEqual<T>(left: Record<string, T>, right: Record<string, T>): boolean {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  if (leftEntries.length !== rightEntries.length) {
    return false;
  }
  for (const [key, value] of leftEntries) {
    if (right[key] !== value) {
      return false;
    }
  }
  return true;
}

function projectOrdersEqual(left: readonly ProjectId[], right: readonly ProjectId[]): boolean {
  return (
    left.length === right.length && left.every((projectId, index) => projectId === right[index])
  );
}

export function syncProjects(state: UiState, projects: readonly SyncProjectInput[]): UiState {
  const previousProjectCwdById = new Map(currentProjectCwdById);
  const previousProjectIdByCwd = new Map(
    [...previousProjectCwdById.entries()].map(([projectId, cwd]) => [cwd, projectId] as const),
  );
  currentProjectCwdById.clear();
  for (const project of projects) {
    currentProjectCwdById.set(project.id, project.cwd);
  }
  const cwdMappingChanged =
    previousProjectCwdById.size !== currentProjectCwdById.size ||
    projects.some((project) => previousProjectCwdById.get(project.id) !== project.cwd);

  const nextExpandedById: Record<string, boolean> = {};
  const previousExpandedById = state.projectExpandedById;
  const persistedOrderByCwd = new Map(
    persistedProjectOrderCwds.map((cwd, index) => [cwd, index] as const),
  );
  const mappedProjects = projects.map((project, index) => {
    const previousProjectIdForCwd = previousProjectIdByCwd.get(project.cwd);
    const expanded =
      previousExpandedById[project.id] ??
      (previousProjectIdForCwd ? previousExpandedById[previousProjectIdForCwd] : undefined) ??
      (persistedExpandedProjectCwds.size > 0
        ? persistedExpandedProjectCwds.has(project.cwd)
        : true);
    nextExpandedById[project.id] = expanded;
    return {
      id: project.id,
      cwd: project.cwd,
      incomingIndex: index,
    };
  });

  const nextProjectOrder =
    state.projectOrder.length > 0
      ? (() => {
          const nextProjectIdByCwd = new Map(
            mappedProjects.map((project) => [project.cwd, project.id] as const),
          );
          const usedProjectIds = new Set<ProjectId>();
          const orderedProjectIds: ProjectId[] = [];

          for (const projectId of state.projectOrder) {
            const matchedProjectId =
              (projectId in nextExpandedById ? projectId : undefined) ??
              (() => {
                const previousCwd = previousProjectCwdById.get(projectId);
                return previousCwd ? nextProjectIdByCwd.get(previousCwd) : undefined;
              })();
            if (!matchedProjectId || usedProjectIds.has(matchedProjectId)) {
              continue;
            }
            usedProjectIds.add(matchedProjectId);
            orderedProjectIds.push(matchedProjectId);
          }

          for (const project of mappedProjects) {
            if (usedProjectIds.has(project.id)) {
              continue;
            }
            orderedProjectIds.push(project.id);
          }

          return orderedProjectIds;
        })()
      : mappedProjects
          .map((project) => ({
            id: project.id,
            incomingIndex: project.incomingIndex,
            orderIndex:
              persistedOrderByCwd.get(project.cwd) ??
              persistedProjectOrderCwds.length + project.incomingIndex,
          }))
          .toSorted((left, right) => {
            const byOrder = left.orderIndex - right.orderIndex;
            if (byOrder !== 0) {
              return byOrder;
            }
            return left.incomingIndex - right.incomingIndex;
          })
          .map((project) => project.id);

  // Hydrate workspace order from persisted cwd-keyed data when not yet loaded
  let nextWorkspaceOrderByProjectId = state.workspaceOrderByProjectId;
  if (
    Object.keys(state.workspaceOrderByProjectId).length === 0 &&
    persistedWorkspaceOrderByProjectCwd.size > 0
  ) {
    const cwdToProjectId = new Map(
      mappedProjects.map((project) => [project.cwd, project.id] as const),
    );
    const hydrated: Record<string, WorkspaceId[]> = {};
    for (const [cwd, ids] of persistedWorkspaceOrderByProjectCwd) {
      const projectId = cwdToProjectId.get(cwd);
      if (projectId) {
        hydrated[projectId] = ids as WorkspaceId[];
      }
    }
    if (Object.keys(hydrated).length > 0) {
      nextWorkspaceOrderByProjectId = hydrated;
    }
  }

  if (
    recordsEqual(state.projectExpandedById, nextExpandedById) &&
    projectOrdersEqual(state.projectOrder, nextProjectOrder) &&
    nextWorkspaceOrderByProjectId === state.workspaceOrderByProjectId &&
    !cwdMappingChanged
  ) {
    return state;
  }

  return {
    ...state,
    projectExpandedById: nextExpandedById,
    projectOrder: nextProjectOrder,
    workspaceOrderByProjectId: nextWorkspaceOrderByProjectId,
  };
}

export function syncWorkspaces(state: UiState, workspaces: readonly SyncWorkspaceInput[]): UiState {
  const retainedWorkspaceIds = new Set(workspaces.map((workspace) => workspace.id));
  const nextWorkspaceLastVisitedAtById = Object.fromEntries(
    Object.entries(state.workspaceLastVisitedAtById).filter(([workspaceId]) =>
      retainedWorkspaceIds.has(workspaceId as WorkspaceId),
    ),
  );
  for (const workspace of workspaces) {
    if (
      nextWorkspaceLastVisitedAtById[workspace.id] === undefined &&
      workspace.seedVisitedAt !== undefined &&
      workspace.seedVisitedAt.length > 0
    ) {
      nextWorkspaceLastVisitedAtById[workspace.id] = workspace.seedVisitedAt;
    }
  }

  // Clean stale workspace IDs from workspace order
  let workspaceOrderChanged = false;
  const nextWorkspaceOrderByProjectId = { ...state.workspaceOrderByProjectId };
  for (const [projectId, order] of Object.entries(nextWorkspaceOrderByProjectId)) {
    const filtered = order.filter((id) => retainedWorkspaceIds.has(id));
    if (filtered.length !== order.length) {
      workspaceOrderChanged = true;
      if (filtered.length === 0) {
        delete nextWorkspaceOrderByProjectId[projectId];
      } else {
        nextWorkspaceOrderByProjectId[projectId] = filtered;
      }
    }
  }

  if (
    !workspaceOrderChanged &&
    recordsEqual(state.workspaceLastVisitedAtById, nextWorkspaceLastVisitedAtById)
  ) {
    return state;
  }
  return {
    ...state,
    workspaceLastVisitedAtById: nextWorkspaceLastVisitedAtById,
    workspaceOrderByProjectId: workspaceOrderChanged
      ? nextWorkspaceOrderByProjectId
      : state.workspaceOrderByProjectId,
  };
}

export function markWorkspaceVisited(
  state: UiState,
  workspaceId: WorkspaceId,
  visitedAt?: string,
): UiState {
  const at = visitedAt ?? new Date().toISOString();
  const visitedAtMs = Date.parse(at);
  const previousVisitedAt = state.workspaceLastVisitedAtById[workspaceId];
  const previousVisitedAtMs = previousVisitedAt ? Date.parse(previousVisitedAt) : NaN;
  if (
    Number.isFinite(previousVisitedAtMs) &&
    Number.isFinite(visitedAtMs) &&
    previousVisitedAtMs >= visitedAtMs
  ) {
    return state;
  }
  return {
    ...state,
    workspaceLastVisitedAtById: {
      ...state.workspaceLastVisitedAtById,
      [workspaceId]: at,
    },
  };
}

export function markWorkspaceUnread(
  state: UiState,
  workspaceId: WorkspaceId,
  latestTurnCompletedAt: string | null | undefined,
): UiState {
  if (!latestTurnCompletedAt) {
    return state;
  }
  const latestTurnCompletedAtMs = Date.parse(latestTurnCompletedAt);
  if (Number.isNaN(latestTurnCompletedAtMs)) {
    return state;
  }
  const unreadVisitedAt = new Date(latestTurnCompletedAtMs - 1).toISOString();
  if (state.workspaceLastVisitedAtById[workspaceId] === unreadVisitedAt) {
    return state;
  }
  return {
    ...state,
    workspaceLastVisitedAtById: {
      ...state.workspaceLastVisitedAtById,
      [workspaceId]: unreadVisitedAt,
    },
  };
}

export function clearWorkspaceUi(state: UiState, workspaceId: WorkspaceId): UiState {
  if (!(workspaceId in state.workspaceLastVisitedAtById)) {
    return state;
  }
  const nextWorkspaceLastVisitedAtById = { ...state.workspaceLastVisitedAtById };
  delete nextWorkspaceLastVisitedAtById[workspaceId];
  return {
    ...state,
    workspaceLastVisitedAtById: nextWorkspaceLastVisitedAtById,
  };
}

export function toggleProject(state: UiState, projectId: ProjectId): UiState {
  const expanded = state.projectExpandedById[projectId] ?? true;
  return {
    ...state,
    projectExpandedById: {
      ...state.projectExpandedById,
      [projectId]: !expanded,
    },
  };
}

export function setProjectExpanded(
  state: UiState,
  projectId: ProjectId,
  expanded: boolean,
): UiState {
  if ((state.projectExpandedById[projectId] ?? true) === expanded) {
    return state;
  }
  return {
    ...state,
    projectExpandedById: {
      ...state.projectExpandedById,
      [projectId]: expanded,
    },
  };
}

export function reorderProjects(
  state: UiState,
  draggedProjectId: ProjectId,
  targetProjectId: ProjectId,
): UiState {
  if (draggedProjectId === targetProjectId) {
    return state;
  }
  const draggedIndex = state.projectOrder.findIndex((projectId) => projectId === draggedProjectId);
  const targetIndex = state.projectOrder.findIndex((projectId) => projectId === targetProjectId);
  if (draggedIndex < 0 || targetIndex < 0) {
    return state;
  }
  const projectOrder = [...state.projectOrder];
  const [draggedProject] = projectOrder.splice(draggedIndex, 1);
  if (!draggedProject) {
    return state;
  }
  projectOrder.splice(targetIndex, 0, draggedProject);
  return {
    ...state,
    projectOrder,
  };
}

export function reorderWorkspaces(
  state: UiState,
  projectId: ProjectId,
  draggedWorkspaceId: WorkspaceId,
  targetWorkspaceId: WorkspaceId,
): UiState {
  if (draggedWorkspaceId === targetWorkspaceId) {
    return state;
  }
  const currentOrder = state.workspaceOrderByProjectId[projectId];
  if (!currentOrder) {
    return state;
  }
  const draggedIndex = currentOrder.indexOf(draggedWorkspaceId);
  const targetIndex = currentOrder.indexOf(targetWorkspaceId);
  if (draggedIndex < 0 || targetIndex < 0) {
    return state;
  }
  const newOrder = [...currentOrder];
  const [dragged] = newOrder.splice(draggedIndex, 1);
  if (!dragged) {
    return state;
  }
  newOrder.splice(targetIndex, 0, dragged);
  return {
    ...state,
    workspaceOrderByProjectId: {
      ...state.workspaceOrderByProjectId,
      [projectId]: newOrder,
    },
  };
}

export function setWorkspaceOrder(
  state: UiState,
  projectId: ProjectId,
  order: WorkspaceId[],
): UiState {
  return {
    ...state,
    workspaceOrderByProjectId: {
      ...state.workspaceOrderByProjectId,
      [projectId]: order,
    },
  };
}

interface UiStateStore extends UiState {
  syncProjects: (projects: readonly SyncProjectInput[]) => void;
  syncWorkspaces: (workspaces: readonly SyncWorkspaceInput[]) => void;
  markWorkspaceVisited: (workspaceId: WorkspaceId, visitedAt?: string) => void;
  markWorkspaceUnread: (
    workspaceId: WorkspaceId,
    latestTurnCompletedAt: string | null | undefined,
  ) => void;
  clearWorkspaceUi: (workspaceId: WorkspaceId) => void;
  toggleProject: (projectId: ProjectId) => void;
  setProjectExpanded: (projectId: ProjectId, expanded: boolean) => void;
  reorderProjects: (draggedProjectId: ProjectId, targetProjectId: ProjectId) => void;
  reorderWorkspaces: (
    projectId: ProjectId,
    draggedWorkspaceId: WorkspaceId,
    targetWorkspaceId: WorkspaceId,
  ) => void;
  setWorkspaceOrder: (projectId: ProjectId, order: WorkspaceId[]) => void;
}

export const useUiStateStore = create<UiStateStore>((set) => ({
  ...readPersistedState(),
  syncProjects: (projects) => set((state) => syncProjects(state, projects)),
  syncWorkspaces: (workspaces) => set((state) => syncWorkspaces(state, workspaces)),
  markWorkspaceVisited: (workspaceId, visitedAt) =>
    set((state) => markWorkspaceVisited(state, workspaceId, visitedAt)),
  markWorkspaceUnread: (workspaceId, latestTurnCompletedAt) =>
    set((state) => markWorkspaceUnread(state, workspaceId, latestTurnCompletedAt)),
  clearWorkspaceUi: (workspaceId) => set((state) => clearWorkspaceUi(state, workspaceId)),
  toggleProject: (projectId) => set((state) => toggleProject(state, projectId)),
  setProjectExpanded: (projectId, expanded) =>
    set((state) => setProjectExpanded(state, projectId, expanded)),
  reorderProjects: (draggedProjectId, targetProjectId) =>
    set((state) => reorderProjects(state, draggedProjectId, targetProjectId)),
  reorderWorkspaces: (projectId, draggedWorkspaceId, targetWorkspaceId) =>
    set((state) => reorderWorkspaces(state, projectId, draggedWorkspaceId, targetWorkspaceId)),
  setWorkspaceOrder: (projectId, order) =>
    set((state) => setWorkspaceOrder(state, projectId, order)),
}));

useUiStateStore.subscribe((state) => debouncedPersistState.maybeExecute(state));

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    debouncedPersistState.flush();
  });
}
