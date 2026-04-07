/**
 * Single Zustand store for terminal UI state keyed by workspaceId.
 *
 * Terminal transition helpers are intentionally private to keep the public
 * API constrained to store actions/selectors.
 */

import { WorkspaceId, type TerminalEvent } from "@matcha/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { resolveStorage } from "./lib/storage";
import { terminalRunningSubprocessFromEvent } from "./terminalActivity";
import {
  DEFAULT_WORKSPACE_TERMINAL_HEIGHT,
  DEFAULT_WORKSPACE_TERMINAL_ID,
  MAX_TERMINALS_PER_GROUP,
  type WorkspaceTerminalGroup,
} from "./types";

interface WorkspaceTerminalState {
  terminalOpen: boolean;
  terminalHeight: number;
  terminalIds: string[];
  runningTerminalIds: string[];
  activeTerminalId: string;
  terminalGroups: WorkspaceTerminalGroup[];
  activeTerminalGroupId: string;
}

export interface WorkspaceTerminalLaunchContext {
  cwd: string;
  worktreePath: string | null;
}

export interface TerminalEventEntry {
  id: number;
  event: TerminalEvent;
}

const TERMINAL_STATE_STORAGE_KEY = "matcha:terminal-state:v1";
const EMPTY_TERMINAL_EVENT_ENTRIES: ReadonlyArray<TerminalEventEntry> = [];
const MAX_TERMINAL_EVENT_BUFFER = 200;

function createTerminalStateStorage() {
  return resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined);
}

function normalizeTerminalIds(terminalIds: string[]): string[] {
  const ids = [...new Set(terminalIds.map((id) => id.trim()).filter((id) => id.length > 0))];
  return ids.length > 0 ? ids : [DEFAULT_WORKSPACE_TERMINAL_ID];
}

function normalizeRunningTerminalIds(
  runningTerminalIds: string[],
  terminalIds: string[],
): string[] {
  if (runningTerminalIds.length === 0) return [];
  const validTerminalIdSet = new Set(terminalIds);
  return [...new Set(runningTerminalIds)]
    .map((id) => id.trim())
    .filter((id) => id.length > 0 && validTerminalIdSet.has(id));
}

function fallbackGroupId(terminalId: string): string {
  return `group-${terminalId}`;
}

function assignUniqueGroupId(baseId: string, usedGroupIds: Set<string>): string {
  let candidate = baseId;
  let index = 2;
  while (usedGroupIds.has(candidate)) {
    candidate = `${baseId}-${index}`;
    index += 1;
  }
  usedGroupIds.add(candidate);
  return candidate;
}

function findGroupIndexByTerminalId(
  terminalGroups: WorkspaceTerminalGroup[],
  terminalId: string,
): number {
  return terminalGroups.findIndex((group) => group.terminalIds.includes(terminalId));
}

function normalizeTerminalGroupIds(terminalIds: string[]): string[] {
  return [...new Set(terminalIds.map((id) => id.trim()).filter((id) => id.length > 0))];
}

function normalizeTerminalGroups(
  terminalGroups: WorkspaceTerminalGroup[],
  terminalIds: string[],
): WorkspaceTerminalGroup[] {
  const validTerminalIdSet = new Set(terminalIds);
  const assignedTerminalIds = new Set<string>();
  const nextGroups: WorkspaceTerminalGroup[] = [];
  const usedGroupIds = new Set<string>();

  for (const group of terminalGroups) {
    const groupTerminalIds = normalizeTerminalGroupIds(group.terminalIds).filter((terminalId) => {
      if (!validTerminalIdSet.has(terminalId)) return false;
      if (assignedTerminalIds.has(terminalId)) return false;
      return true;
    });
    if (groupTerminalIds.length === 0) continue;
    for (const terminalId of groupTerminalIds) {
      assignedTerminalIds.add(terminalId);
    }
    const baseGroupId =
      group.id.trim().length > 0
        ? group.id.trim()
        : fallbackGroupId(groupTerminalIds[0] ?? DEFAULT_WORKSPACE_TERMINAL_ID);
    nextGroups.push({
      id: assignUniqueGroupId(baseGroupId, usedGroupIds),
      terminalIds: groupTerminalIds,
    });
  }

  for (const terminalId of terminalIds) {
    if (assignedTerminalIds.has(terminalId)) continue;
    nextGroups.push({
      id: assignUniqueGroupId(fallbackGroupId(terminalId), usedGroupIds),
      terminalIds: [terminalId],
    });
  }

  if (nextGroups.length === 0) {
    return [
      {
        id: fallbackGroupId(DEFAULT_WORKSPACE_TERMINAL_ID),
        terminalIds: [DEFAULT_WORKSPACE_TERMINAL_ID],
      },
    ];
  }

  return nextGroups;
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function terminalGroupsEqual(
  left: WorkspaceTerminalGroup[],
  right: WorkspaceTerminalGroup[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const leftGroup = left[index];
    const rightGroup = right[index];
    if (!leftGroup || !rightGroup) return false;
    if (leftGroup.id !== rightGroup.id) return false;
    if (!arraysEqual(leftGroup.terminalIds, rightGroup.terminalIds)) return false;
  }
  return true;
}

function workspaceTerminalStateEqual(
  left: WorkspaceTerminalState,
  right: WorkspaceTerminalState,
): boolean {
  return (
    left.terminalOpen === right.terminalOpen &&
    left.terminalHeight === right.terminalHeight &&
    left.activeTerminalId === right.activeTerminalId &&
    left.activeTerminalGroupId === right.activeTerminalGroupId &&
    arraysEqual(left.terminalIds, right.terminalIds) &&
    arraysEqual(left.runningTerminalIds, right.runningTerminalIds) &&
    terminalGroupsEqual(left.terminalGroups, right.terminalGroups)
  );
}

const DEFAULT_WORKSPACE_TERMINAL_STATE: WorkspaceTerminalState = Object.freeze({
  terminalOpen: false,
  terminalHeight: DEFAULT_WORKSPACE_TERMINAL_HEIGHT,
  terminalIds: [DEFAULT_WORKSPACE_TERMINAL_ID],
  runningTerminalIds: [],
  activeTerminalId: DEFAULT_WORKSPACE_TERMINAL_ID,
  terminalGroups: [
    {
      id: fallbackGroupId(DEFAULT_WORKSPACE_TERMINAL_ID),
      terminalIds: [DEFAULT_WORKSPACE_TERMINAL_ID],
    },
  ],
  activeTerminalGroupId: fallbackGroupId(DEFAULT_WORKSPACE_TERMINAL_ID),
});

function createDefaultWorkspaceTerminalState(): WorkspaceTerminalState {
  return {
    ...DEFAULT_WORKSPACE_TERMINAL_STATE,
    terminalIds: [...DEFAULT_WORKSPACE_TERMINAL_STATE.terminalIds],
    runningTerminalIds: [...DEFAULT_WORKSPACE_TERMINAL_STATE.runningTerminalIds],
    terminalGroups: copyTerminalGroups(DEFAULT_WORKSPACE_TERMINAL_STATE.terminalGroups),
  };
}

function getDefaultWorkspaceTerminalState(): WorkspaceTerminalState {
  return DEFAULT_WORKSPACE_TERMINAL_STATE;
}

function normalizeWorkspaceTerminalState(state: WorkspaceTerminalState): WorkspaceTerminalState {
  const terminalIds = normalizeTerminalIds(state.terminalIds);
  const nextTerminalIds = terminalIds.length > 0 ? terminalIds : [DEFAULT_WORKSPACE_TERMINAL_ID];
  const runningTerminalIds = normalizeRunningTerminalIds(state.runningTerminalIds, nextTerminalIds);
  const activeTerminalId = nextTerminalIds.includes(state.activeTerminalId)
    ? state.activeTerminalId
    : (nextTerminalIds[0] ?? DEFAULT_WORKSPACE_TERMINAL_ID);
  const terminalGroups = normalizeTerminalGroups(state.terminalGroups, nextTerminalIds);
  const activeGroupIdFromState = terminalGroups.some(
    (group) => group.id === state.activeTerminalGroupId,
  )
    ? state.activeTerminalGroupId
    : null;
  const activeGroupIdFromTerminal =
    terminalGroups.find((group) => group.terminalIds.includes(activeTerminalId))?.id ?? null;

  const normalized: WorkspaceTerminalState = {
    terminalOpen: state.terminalOpen,
    terminalHeight:
      Number.isFinite(state.terminalHeight) && state.terminalHeight > 0
        ? state.terminalHeight
        : DEFAULT_WORKSPACE_TERMINAL_HEIGHT,
    terminalIds: nextTerminalIds,
    runningTerminalIds,
    activeTerminalId,
    terminalGroups,
    activeTerminalGroupId:
      activeGroupIdFromState ??
      activeGroupIdFromTerminal ??
      terminalGroups[0]?.id ??
      fallbackGroupId(DEFAULT_WORKSPACE_TERMINAL_ID),
  };
  return workspaceTerminalStateEqual(state, normalized) ? state : normalized;
}

function isDefaultWorkspaceTerminalState(state: WorkspaceTerminalState): boolean {
  const normalized = normalizeWorkspaceTerminalState(state);
  return workspaceTerminalStateEqual(normalized, DEFAULT_WORKSPACE_TERMINAL_STATE);
}

function isValidTerminalId(terminalId: string): boolean {
  return terminalId.trim().length > 0;
}

function terminalEventBufferKey(workspaceId: WorkspaceId, terminalId: string): string {
  return `${workspaceId}\u0000${terminalId}`;
}

function copyTerminalGroups(groups: WorkspaceTerminalGroup[]): WorkspaceTerminalGroup[] {
  return groups.map((group) => ({
    id: group.id,
    terminalIds: [...group.terminalIds],
  }));
}

function appendTerminalEventEntry(
  terminalEventEntriesByKey: Record<string, ReadonlyArray<TerminalEventEntry>>,
  nextTerminalEventId: number,
  event: TerminalEvent,
) {
  const key = terminalEventBufferKey(WorkspaceId.makeUnsafe(event.workspaceId), event.terminalId);
  const currentEntries = terminalEventEntriesByKey[key] ?? EMPTY_TERMINAL_EVENT_ENTRIES;
  const nextEntry: TerminalEventEntry = {
    id: nextTerminalEventId,
    event,
  };
  const nextEntries =
    currentEntries.length >= MAX_TERMINAL_EVENT_BUFFER
      ? [...currentEntries.slice(1), nextEntry]
      : [...currentEntries, nextEntry];

  return {
    terminalEventEntriesByKey: {
      ...terminalEventEntriesByKey,
      [key]: nextEntries,
    },
    nextTerminalEventId: nextTerminalEventId + 1,
  };
}

function launchContextFromStartEvent(
  event: Extract<TerminalEvent, { type: "started" | "restarted" }>,
): WorkspaceTerminalLaunchContext {
  return {
    cwd: event.snapshot.cwd,
    worktreePath: event.snapshot.worktreePath,
  };
}

function upsertTerminalIntoGroups(
  state: WorkspaceTerminalState,
  terminalId: string,
  mode: "split" | "new",
): WorkspaceTerminalState {
  const normalized = normalizeWorkspaceTerminalState(state);
  if (!isValidTerminalId(terminalId)) {
    return normalized;
  }

  const isNewTerminal = !normalized.terminalIds.includes(terminalId);
  const terminalIds = isNewTerminal
    ? [...normalized.terminalIds, terminalId]
    : normalized.terminalIds;
  const terminalGroups = copyTerminalGroups(normalized.terminalGroups);

  const existingGroupIndex = findGroupIndexByTerminalId(terminalGroups, terminalId);
  if (existingGroupIndex >= 0) {
    terminalGroups[existingGroupIndex]!.terminalIds = terminalGroups[
      existingGroupIndex
    ]!.terminalIds.filter((id) => id !== terminalId);
    if (terminalGroups[existingGroupIndex]!.terminalIds.length === 0) {
      terminalGroups.splice(existingGroupIndex, 1);
    }
  }

  if (mode === "new") {
    const usedGroupIds = new Set(terminalGroups.map((group) => group.id));
    const nextGroupId = assignUniqueGroupId(fallbackGroupId(terminalId), usedGroupIds);
    terminalGroups.push({ id: nextGroupId, terminalIds: [terminalId] });
    return normalizeWorkspaceTerminalState({
      ...normalized,
      terminalOpen: true,
      terminalIds,
      activeTerminalId: terminalId,
      terminalGroups,
      activeTerminalGroupId: nextGroupId,
    });
  }

  let activeGroupIndex = terminalGroups.findIndex(
    (group) => group.id === normalized.activeTerminalGroupId,
  );
  if (activeGroupIndex < 0) {
    activeGroupIndex = findGroupIndexByTerminalId(terminalGroups, normalized.activeTerminalId);
  }
  if (activeGroupIndex < 0) {
    const usedGroupIds = new Set(terminalGroups.map((group) => group.id));
    const nextGroupId = assignUniqueGroupId(
      fallbackGroupId(normalized.activeTerminalId),
      usedGroupIds,
    );
    terminalGroups.push({ id: nextGroupId, terminalIds: [normalized.activeTerminalId] });
    activeGroupIndex = terminalGroups.length - 1;
  }

  const destinationGroup = terminalGroups[activeGroupIndex];
  if (!destinationGroup) {
    return normalized;
  }

  if (
    isNewTerminal &&
    !destinationGroup.terminalIds.includes(terminalId) &&
    destinationGroup.terminalIds.length >= MAX_TERMINALS_PER_GROUP
  ) {
    return normalized;
  }

  if (!destinationGroup.terminalIds.includes(terminalId)) {
    const anchorIndex = destinationGroup.terminalIds.indexOf(normalized.activeTerminalId);
    if (anchorIndex >= 0) {
      destinationGroup.terminalIds.splice(anchorIndex + 1, 0, terminalId);
    } else {
      destinationGroup.terminalIds.push(terminalId);
    }
  }

  return normalizeWorkspaceTerminalState({
    ...normalized,
    terminalOpen: true,
    terminalIds,
    activeTerminalId: terminalId,
    terminalGroups,
    activeTerminalGroupId: destinationGroup.id,
  });
}

function setWorkspaceTerminalOpen(
  state: WorkspaceTerminalState,
  open: boolean,
): WorkspaceTerminalState {
  const normalized = normalizeWorkspaceTerminalState(state);
  if (normalized.terminalOpen === open) return normalized;
  return { ...normalized, terminalOpen: open };
}

function setWorkspaceTerminalHeight(
  state: WorkspaceTerminalState,
  height: number,
): WorkspaceTerminalState {
  const normalized = normalizeWorkspaceTerminalState(state);
  if (!Number.isFinite(height) || height <= 0 || normalized.terminalHeight === height) {
    return normalized;
  }
  return { ...normalized, terminalHeight: height };
}

function splitWorkspaceTerminal(
  state: WorkspaceTerminalState,
  terminalId: string,
): WorkspaceTerminalState {
  return upsertTerminalIntoGroups(state, terminalId, "split");
}

function newWorkspaceTerminal(
  state: WorkspaceTerminalState,
  terminalId: string,
): WorkspaceTerminalState {
  return upsertTerminalIntoGroups(state, terminalId, "new");
}

function setWorkspaceActiveTerminal(
  state: WorkspaceTerminalState,
  terminalId: string,
): WorkspaceTerminalState {
  const normalized = normalizeWorkspaceTerminalState(state);
  if (!normalized.terminalIds.includes(terminalId)) {
    return normalized;
  }
  const activeTerminalGroupId =
    normalized.terminalGroups.find((group) => group.terminalIds.includes(terminalId))?.id ??
    normalized.activeTerminalGroupId;
  if (
    normalized.activeTerminalId === terminalId &&
    normalized.activeTerminalGroupId === activeTerminalGroupId
  ) {
    return normalized;
  }
  return {
    ...normalized,
    activeTerminalId: terminalId,
    activeTerminalGroupId,
  };
}

function closeWorkspaceTerminal(
  state: WorkspaceTerminalState,
  terminalId: string,
): WorkspaceTerminalState {
  const normalized = normalizeWorkspaceTerminalState(state);
  if (!normalized.terminalIds.includes(terminalId)) {
    return normalized;
  }

  const remainingTerminalIds = normalized.terminalIds.filter((id) => id !== terminalId);
  if (remainingTerminalIds.length === 0) {
    return createDefaultWorkspaceTerminalState();
  }

  const closedTerminalIndex = normalized.terminalIds.indexOf(terminalId);
  const nextActiveTerminalId =
    normalized.activeTerminalId === terminalId
      ? (remainingTerminalIds[Math.min(closedTerminalIndex, remainingTerminalIds.length - 1)] ??
        remainingTerminalIds[0] ??
        DEFAULT_WORKSPACE_TERMINAL_ID)
      : normalized.activeTerminalId;

  const terminalGroups = normalized.terminalGroups
    .map((group) => ({
      ...group,
      terminalIds: group.terminalIds.filter((id) => id !== terminalId),
    }))
    .filter((group) => group.terminalIds.length > 0);

  const nextActiveTerminalGroupId =
    terminalGroups.find((group) => group.terminalIds.includes(nextActiveTerminalId))?.id ??
    terminalGroups[0]?.id ??
    fallbackGroupId(nextActiveTerminalId);

  return normalizeWorkspaceTerminalState({
    terminalOpen: normalized.terminalOpen,
    terminalHeight: normalized.terminalHeight,
    terminalIds: remainingTerminalIds,
    runningTerminalIds: normalized.runningTerminalIds.filter((id) => id !== terminalId),
    activeTerminalId: nextActiveTerminalId,
    terminalGroups,
    activeTerminalGroupId: nextActiveTerminalGroupId,
  });
}

function setWorkspaceTerminalActivity(
  state: WorkspaceTerminalState,
  terminalId: string,
  hasRunningSubprocess: boolean,
): WorkspaceTerminalState {
  const normalized = normalizeWorkspaceTerminalState(state);
  if (!normalized.terminalIds.includes(terminalId)) {
    return normalized;
  }
  const alreadyRunning = normalized.runningTerminalIds.includes(terminalId);
  if (hasRunningSubprocess === alreadyRunning) {
    return normalized;
  }
  const runningTerminalIds = new Set(normalized.runningTerminalIds);
  if (hasRunningSubprocess) {
    runningTerminalIds.add(terminalId);
  } else {
    runningTerminalIds.delete(terminalId);
  }
  return { ...normalized, runningTerminalIds: [...runningTerminalIds] };
}

export function selectWorkspaceTerminalState(
  terminalStateByWorkspaceId: Record<WorkspaceId, WorkspaceTerminalState>,
  workspaceId: WorkspaceId,
): WorkspaceTerminalState {
  if (workspaceId.length === 0) {
    return getDefaultWorkspaceTerminalState();
  }
  return terminalStateByWorkspaceId[workspaceId] ?? getDefaultWorkspaceTerminalState();
}

function updateTerminalStateByWorkspaceId(
  terminalStateByWorkspaceId: Record<WorkspaceId, WorkspaceTerminalState>,
  workspaceId: WorkspaceId,
  updater: (state: WorkspaceTerminalState) => WorkspaceTerminalState,
): Record<WorkspaceId, WorkspaceTerminalState> {
  if (workspaceId.length === 0) {
    return terminalStateByWorkspaceId;
  }

  const current = selectWorkspaceTerminalState(terminalStateByWorkspaceId, workspaceId);
  const next = updater(current);
  if (next === current) {
    return terminalStateByWorkspaceId;
  }

  if (isDefaultWorkspaceTerminalState(next)) {
    if (terminalStateByWorkspaceId[workspaceId] === undefined) {
      return terminalStateByWorkspaceId;
    }
    const { [workspaceId]: _removed, ...rest } = terminalStateByWorkspaceId;
    return rest as Record<WorkspaceId, WorkspaceTerminalState>;
  }

  return {
    ...terminalStateByWorkspaceId,
    [workspaceId]: next,
  };
}

export function selectTerminalEventEntries(
  terminalEventEntriesByKey: Record<string, ReadonlyArray<TerminalEventEntry>>,
  workspaceId: WorkspaceId,
  terminalId: string,
): ReadonlyArray<TerminalEventEntry> {
  if (workspaceId.length === 0 || terminalId.trim().length === 0) {
    return EMPTY_TERMINAL_EVENT_ENTRIES;
  }
  return (
    terminalEventEntriesByKey[terminalEventBufferKey(workspaceId, terminalId)] ??
    EMPTY_TERMINAL_EVENT_ENTRIES
  );
}

interface TerminalStateStoreState {
  terminalStateByWorkspaceId: Record<WorkspaceId, WorkspaceTerminalState>;
  terminalLaunchContextByWorkspaceId: Record<WorkspaceId, WorkspaceTerminalLaunchContext>;
  terminalEventEntriesByKey: Record<string, ReadonlyArray<TerminalEventEntry>>;
  nextTerminalEventId: number;
  setTerminalOpen: (workspaceId: WorkspaceId, open: boolean) => void;
  setTerminalHeight: (workspaceId: WorkspaceId, height: number) => void;
  splitTerminal: (workspaceId: WorkspaceId, terminalId: string) => void;
  newTerminal: (workspaceId: WorkspaceId, terminalId: string) => void;
  ensureTerminal: (
    workspaceId: WorkspaceId,
    terminalId: string,
    options?: { open?: boolean; active?: boolean },
  ) => void;
  setActiveTerminal: (workspaceId: WorkspaceId, terminalId: string) => void;
  closeTerminal: (workspaceId: WorkspaceId, terminalId: string) => void;
  setTerminalLaunchContext: (
    workspaceId: WorkspaceId,
    context: WorkspaceTerminalLaunchContext,
  ) => void;
  clearTerminalLaunchContext: (workspaceId: WorkspaceId) => void;
  setTerminalActivity: (
    workspaceId: WorkspaceId,
    terminalId: string,
    hasRunningSubprocess: boolean,
  ) => void;
  recordTerminalEvent: (event: TerminalEvent) => void;
  applyTerminalEvent: (event: TerminalEvent) => void;
  clearTerminalState: (workspaceId: WorkspaceId) => void;
  removeTerminalState: (workspaceId: WorkspaceId) => void;
  removeOrphanedTerminalStates: (activeWorkspaceIds: Set<WorkspaceId>) => void;
}

export const useTerminalStateStore = create<TerminalStateStoreState>()(
  persist(
    (set) => {
      const updateTerminal = (
        workspaceId: WorkspaceId,
        updater: (state: WorkspaceTerminalState) => WorkspaceTerminalState,
      ) => {
        set((state) => {
          const nextTerminalStateByWorkspaceId = updateTerminalStateByWorkspaceId(
            state.terminalStateByWorkspaceId,
            workspaceId,
            updater,
          );
          if (nextTerminalStateByWorkspaceId === state.terminalStateByWorkspaceId) {
            return state;
          }
          return {
            terminalStateByWorkspaceId: nextTerminalStateByWorkspaceId,
          };
        });
      };

      return {
        terminalStateByWorkspaceId: {},
        terminalLaunchContextByWorkspaceId: {},
        terminalEventEntriesByKey: {},
        nextTerminalEventId: 1,
        setTerminalOpen: (workspaceId, open) =>
          updateTerminal(workspaceId, (state) => setWorkspaceTerminalOpen(state, open)),
        setTerminalHeight: (workspaceId, height) =>
          updateTerminal(workspaceId, (state) => setWorkspaceTerminalHeight(state, height)),
        splitTerminal: (workspaceId, terminalId) =>
          updateTerminal(workspaceId, (state) => splitWorkspaceTerminal(state, terminalId)),
        newTerminal: (workspaceId, terminalId) =>
          updateTerminal(workspaceId, (state) => newWorkspaceTerminal(state, terminalId)),
        ensureTerminal: (workspaceId, terminalId, options) =>
          updateTerminal(workspaceId, (state) => {
            let nextState = state;
            if (!state.terminalIds.includes(terminalId)) {
              nextState = newWorkspaceTerminal(nextState, terminalId);
            }
            if (options?.active === false) {
              nextState = {
                ...nextState,
                activeTerminalId: state.activeTerminalId,
                activeTerminalGroupId: state.activeTerminalGroupId,
              };
            }
            if (options?.active ?? true) {
              nextState = setWorkspaceActiveTerminal(nextState, terminalId);
            }
            if (options?.open) {
              nextState = setWorkspaceTerminalOpen(nextState, true);
            }
            return normalizeWorkspaceTerminalState(nextState);
          }),
        setActiveTerminal: (workspaceId, terminalId) =>
          updateTerminal(workspaceId, (state) => setWorkspaceActiveTerminal(state, terminalId)),
        closeTerminal: (workspaceId, terminalId) =>
          updateTerminal(workspaceId, (state) => closeWorkspaceTerminal(state, terminalId)),
        setTerminalLaunchContext: (workspaceId, context) =>
          set((state) => ({
            terminalLaunchContextByWorkspaceId: {
              ...state.terminalLaunchContextByWorkspaceId,
              [workspaceId]: context,
            },
          })),
        clearTerminalLaunchContext: (workspaceId) =>
          set((state) => {
            if (!state.terminalLaunchContextByWorkspaceId[workspaceId]) {
              return state;
            }
            const { [workspaceId]: _removed, ...rest } = state.terminalLaunchContextByWorkspaceId;
            return { terminalLaunchContextByWorkspaceId: rest };
          }),
        setTerminalActivity: (workspaceId, terminalId, hasRunningSubprocess) =>
          updateTerminal(workspaceId, (state) =>
            setWorkspaceTerminalActivity(state, terminalId, hasRunningSubprocess),
          ),
        recordTerminalEvent: (event) =>
          set((state) =>
            appendTerminalEventEntry(
              state.terminalEventEntriesByKey,
              state.nextTerminalEventId,
              event,
            ),
          ),
        applyTerminalEvent: (event) =>
          set((state) => {
            const workspaceId = WorkspaceId.makeUnsafe(event.workspaceId);
            let nextTerminalStateByWorkspaceId = state.terminalStateByWorkspaceId;
            let nextTerminalLaunchContextByWorkspaceId = state.terminalLaunchContextByWorkspaceId;

            if (event.type === "started" || event.type === "restarted") {
              nextTerminalStateByWorkspaceId = updateTerminalStateByWorkspaceId(
                nextTerminalStateByWorkspaceId,
                workspaceId,
                (current) => {
                  let nextState = current;
                  if (!current.terminalIds.includes(event.terminalId)) {
                    nextState = newWorkspaceTerminal(nextState, event.terminalId);
                  }
                  nextState = setWorkspaceActiveTerminal(nextState, event.terminalId);
                  nextState = setWorkspaceTerminalOpen(nextState, true);
                  return normalizeWorkspaceTerminalState(nextState);
                },
              );
              nextTerminalLaunchContextByWorkspaceId = {
                ...nextTerminalLaunchContextByWorkspaceId,
                [workspaceId]: launchContextFromStartEvent(event),
              };
            }

            const hasRunningSubprocess = terminalRunningSubprocessFromEvent(event);
            if (hasRunningSubprocess !== null) {
              nextTerminalStateByWorkspaceId = updateTerminalStateByWorkspaceId(
                nextTerminalStateByWorkspaceId,
                workspaceId,
                (current) =>
                  setWorkspaceTerminalActivity(current, event.terminalId, hasRunningSubprocess),
              );
            }

            const nextEventState = appendTerminalEventEntry(
              state.terminalEventEntriesByKey,
              state.nextTerminalEventId,
              event,
            );

            return {
              terminalStateByWorkspaceId: nextTerminalStateByWorkspaceId,
              terminalLaunchContextByWorkspaceId: nextTerminalLaunchContextByWorkspaceId,
              ...nextEventState,
            };
          }),
        clearTerminalState: (workspaceId) =>
          set((state) => {
            const nextTerminalStateByWorkspaceId = updateTerminalStateByWorkspaceId(
              state.terminalStateByWorkspaceId,
              workspaceId,
              () => createDefaultWorkspaceTerminalState(),
            );
            const hadLaunchContext =
              state.terminalLaunchContextByWorkspaceId[workspaceId] !== undefined;
            const { [workspaceId]: _removed, ...remainingLaunchContexts } =
              state.terminalLaunchContextByWorkspaceId;
            const nextTerminalEventEntriesByKey = { ...state.terminalEventEntriesByKey };
            let removedEventEntries = false;
            for (const key of Object.keys(nextTerminalEventEntriesByKey)) {
              if (key.startsWith(`${workspaceId}\u0000`)) {
                delete nextTerminalEventEntriesByKey[key];
                removedEventEntries = true;
              }
            }
            if (
              nextTerminalStateByWorkspaceId === state.terminalStateByWorkspaceId &&
              !hadLaunchContext &&
              !removedEventEntries
            ) {
              return state;
            }
            return {
              terminalStateByWorkspaceId: nextTerminalStateByWorkspaceId,
              terminalLaunchContextByWorkspaceId: remainingLaunchContexts,
              terminalEventEntriesByKey: nextTerminalEventEntriesByKey,
            };
          }),
        removeTerminalState: (workspaceId) =>
          set((state) => {
            const hadTerminalState = state.terminalStateByWorkspaceId[workspaceId] !== undefined;
            const hadLaunchContext =
              state.terminalLaunchContextByWorkspaceId[workspaceId] !== undefined;
            const nextTerminalEventEntriesByKey = { ...state.terminalEventEntriesByKey };
            let removedEventEntries = false;
            for (const key of Object.keys(nextTerminalEventEntriesByKey)) {
              if (key.startsWith(`${workspaceId}\u0000`)) {
                delete nextTerminalEventEntriesByKey[key];
                removedEventEntries = true;
              }
            }
            if (!hadTerminalState && !hadLaunchContext && !removedEventEntries) {
              return state;
            }
            const nextTerminalStateByWorkspaceId = { ...state.terminalStateByWorkspaceId };
            delete nextTerminalStateByWorkspaceId[workspaceId];
            const nextLaunchContexts = { ...state.terminalLaunchContextByWorkspaceId };
            delete nextLaunchContexts[workspaceId];
            return {
              terminalStateByWorkspaceId: nextTerminalStateByWorkspaceId,
              terminalLaunchContextByWorkspaceId: nextLaunchContexts,
              terminalEventEntriesByKey: nextTerminalEventEntriesByKey,
            };
          }),
        removeOrphanedTerminalStates: (activeWorkspaceIds) =>
          set((state) => {
            const orphanedIds = Object.keys(state.terminalStateByWorkspaceId).filter(
              (id) => !activeWorkspaceIds.has(id as WorkspaceId),
            );
            const orphanedLaunchContextIds = Object.keys(
              state.terminalLaunchContextByWorkspaceId,
            ).filter((id) => !activeWorkspaceIds.has(id as WorkspaceId));
            const nextTerminalEventEntriesByKey = { ...state.terminalEventEntriesByKey };
            let removedEventEntries = false;
            for (const key of Object.keys(nextTerminalEventEntriesByKey)) {
              const [workspaceId] = key.split("\u0000");
              if (workspaceId && !activeWorkspaceIds.has(workspaceId as WorkspaceId)) {
                delete nextTerminalEventEntriesByKey[key];
                removedEventEntries = true;
              }
            }
            if (
              orphanedIds.length === 0 &&
              orphanedLaunchContextIds.length === 0 &&
              !removedEventEntries
            ) {
              return state;
            }
            const next = { ...state.terminalStateByWorkspaceId };
            for (const id of orphanedIds) {
              delete next[id as WorkspaceId];
            }
            const nextLaunchContexts = { ...state.terminalLaunchContextByWorkspaceId };
            for (const id of orphanedLaunchContextIds) {
              delete nextLaunchContexts[id as WorkspaceId];
            }
            return {
              terminalStateByWorkspaceId: next,
              terminalLaunchContextByWorkspaceId: nextLaunchContexts,
              terminalEventEntriesByKey: nextTerminalEventEntriesByKey,
            };
          }),
      };
    },
    {
      name: TERMINAL_STATE_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(createTerminalStateStorage),
      partialize: (state) => ({
        terminalStateByWorkspaceId: state.terminalStateByWorkspaceId,
      }),
    },
  ),
);
