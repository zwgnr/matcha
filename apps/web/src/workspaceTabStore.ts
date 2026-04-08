/**
 * Zustand store for workspace tab state.
 *
 * Root workspaces own tab bars. Provider workspaces may be grouped under a
 * different root workspace, but that ownership is explicit state rather than
 * something inferred from currently-open tabs.
 */

import { type ProviderKind, type TurnId, type WorkspaceId } from "@matcha/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { resolveStorage } from "./lib/storage";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TabKind = "provider" | "terminal" | "diff";

export interface WorkspaceTab {
  id: string;
  kind: TabKind;
  /** The workspace this tab owns — only for provider tabs. */
  workspaceId?: WorkspaceId;
  /** Provider type — only set when `kind === "provider"`. */
  provider?: ProviderKind;
  /** Terminal session ID — only set when `kind === "terminal"`. */
  terminalId?: string;
  label: string;
  // -- Diff tab fields --
  /** Source workspace for diff data — only set when `kind === "diff"`. */
  diffSourceWorkspaceId?: WorkspaceId;
  /** Turn ID whose diff to display. Undefined means full conversation ("against main"). */
  diffTurnId?: TurnId;
  /** Checkpoint turn count range start — only for diff tabs. */
  diffFromTurnCount?: number;
  /** Checkpoint turn count range end — only for diff tabs. */
  diffToTurnCount?: number;
  /** File path within the diff to render — only for diff tabs. */
  diffFilePath?: string;
}

export interface WorkspaceTabState {
  tabs: WorkspaceTab[];
  activeTabId: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STORAGE_KEY = "matcha:workspace-tabs:v3";
const STORAGE_VERSION = 1;

let nextId = 1;
function generateTabId(): string {
  return `tab-${Date.now()}-${nextId++}`;
}

const PROVIDER_LABELS: Record<ProviderKind, string> = {
  codex: "Codex",
  claudeAgent: "Claude Code",
};

export function makeProviderTab(provider: ProviderKind, workspaceId: WorkspaceId): WorkspaceTab {
  return {
    id: generateTabId(),
    kind: "provider",
    provider,
    workspaceId,
    label: PROVIDER_LABELS[provider] ?? provider,
  };
}

export function makeTerminalTab(terminalId: string, label?: string): WorkspaceTab {
  return {
    id: generateTabId(),
    kind: "terminal",
    terminalId,
    label: label ?? "Terminal",
  };
}

export function nextTerminalTabLabel(tabs: WorkspaceTab[]): string {
  const terminalTabs = tabs.filter((t) => t.kind === "terminal");
  return `Terminal ${terminalTabs.length + 1}`;
}

export function makeDiffTab(input: {
  diffSourceWorkspaceId: WorkspaceId;
  diffTurnId: TurnId | null;
  diffFromTurnCount: number;
  diffToTurnCount: number;
  diffFilePath: string;
  label: string;
}): WorkspaceTab {
  const tab: WorkspaceTab = {
    id: generateTabId(),
    kind: "diff",
    label: input.label,
    diffSourceWorkspaceId: input.diffSourceWorkspaceId,
    diffFromTurnCount: input.diffFromTurnCount,
    diffToTurnCount: input.diffToTurnCount,
    diffFilePath: input.diffFilePath,
  };
  if (input.diffTurnId !== null) {
    tab.diffTurnId = input.diffTurnId;
  }
  return tab;
}

function normalizeActiveTabId(tabs: WorkspaceTab[], activeTabId: string): string {
  if (tabs.some((tab) => tab.id === activeTabId)) {
    return activeTabId;
  }
  return tabs[0]?.id ?? "";
}

function deriveRootWorkspaceIdByWorkspaceId(
  tabStateByRootWorkspaceId: Record<string, WorkspaceTabState>,
): Record<string, WorkspaceId> {
  const nextRootWorkspaceIdByWorkspaceId: Record<string, WorkspaceId> = {};
  for (const rootWorkspaceId of Object.keys(tabStateByRootWorkspaceId)) {
    nextRootWorkspaceIdByWorkspaceId[rootWorkspaceId] = rootWorkspaceId as WorkspaceId;
    const tabState = tabStateByRootWorkspaceId[rootWorkspaceId];
    for (const tab of tabState?.tabs ?? []) {
      if (tab.kind !== "provider" || !tab.workspaceId) {
        continue;
      }
      nextRootWorkspaceIdByWorkspaceId[tab.workspaceId] = rootWorkspaceId as WorkspaceId;
    }
  }
  return nextRootWorkspaceIdByWorkspaceId;
}

function getEffectiveRootWorkspaceIdByWorkspaceId(input: {
  tabStateByRootWorkspaceId: Record<string, WorkspaceTabState>;
  rootWorkspaceIdByWorkspaceId: Record<string, WorkspaceId>;
}): Record<string, WorkspaceId> {
  return {
    ...deriveRootWorkspaceIdByWorkspaceId(input.tabStateByRootWorkspaceId),
    ...input.rootWorkspaceIdByWorkspaceId,
  };
}

export function sanitizeWorkspaceTabPersistenceState(input: {
  tabStateByRootWorkspaceId: Record<string, WorkspaceTabState>;
  rootWorkspaceIdByWorkspaceId?: Record<string, WorkspaceId>;
}): {
  tabStateByRootWorkspaceId: Record<string, WorkspaceTabState>;
  rootWorkspaceIdByWorkspaceId: Record<string, WorkspaceId>;
} {
  const explicitRootWorkspaceIdByWorkspaceId = input.rootWorkspaceIdByWorkspaceId ?? {};
  const effectiveRootWorkspaceIdByWorkspaceId = getEffectiveRootWorkspaceIdByWorkspaceId({
    tabStateByRootWorkspaceId: input.tabStateByRootWorkspaceId,
    rootWorkspaceIdByWorkspaceId: explicitRootWorkspaceIdByWorkspaceId,
  });
  const nextTabStateByRootWorkspaceId: Record<string, WorkspaceTabState> = {};
  const claimedProviderWorkspaceIds = new Set<WorkspaceId>();

  for (const [rootWorkspaceId, tabState] of Object.entries(input.tabStateByRootWorkspaceId)) {
    const normalizedRootWorkspaceId = rootWorkspaceId as WorkspaceId;
    const nextTabs: WorkspaceTab[] = [];

    for (const tab of tabState.tabs) {
      if (tab.kind !== "provider" || !tab.workspaceId) {
        nextTabs.push(tab);
        continue;
      }

      const claimedRootWorkspaceId =
        effectiveRootWorkspaceIdByWorkspaceId[tab.workspaceId] ?? normalizedRootWorkspaceId;
      if (claimedRootWorkspaceId !== normalizedRootWorkspaceId) {
        continue;
      }
      if (claimedProviderWorkspaceIds.has(tab.workspaceId)) {
        continue;
      }

      claimedProviderWorkspaceIds.add(tab.workspaceId);
      nextTabs.push(tab);
    }

    nextTabStateByRootWorkspaceId[normalizedRootWorkspaceId] = {
      tabs: nextTabs,
      activeTabId: normalizeActiveTabId(nextTabs, tabState.activeTabId),
    };
  }

  const nextRootWorkspaceIdByWorkspaceId = getEffectiveRootWorkspaceIdByWorkspaceId({
    tabStateByRootWorkspaceId: nextTabStateByRootWorkspaceId,
    rootWorkspaceIdByWorkspaceId: explicitRootWorkspaceIdByWorkspaceId,
  });

  for (const rootWorkspaceId of Object.keys(nextTabStateByRootWorkspaceId)) {
    nextRootWorkspaceIdByWorkspaceId[rootWorkspaceId] = rootWorkspaceId as WorkspaceId;
  }

  return {
    tabStateByRootWorkspaceId: nextTabStateByRootWorkspaceId,
    rootWorkspaceIdByWorkspaceId: nextRootWorkspaceIdByWorkspaceId,
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface WorkspaceTabStoreState {
  tabStateByRootWorkspaceId: Record<string, WorkspaceTabState>;
  rootWorkspaceIdByWorkspaceId: Record<string, WorkspaceId>;

  getOrInitTabs: (rootWorkspaceId: WorkspaceId) => WorkspaceTabState;
  addTab: (rootWorkspaceId: WorkspaceId, tab: WorkspaceTab) => void;
  removeTab: (rootWorkspaceId: WorkspaceId, tabId: string) => void;
  setActiveTab: (rootWorkspaceId: WorkspaceId, tabId: string) => void;
  reorderTabs: (rootWorkspaceId: WorkspaceId, activeTabId: string, overTabId: string) => void;
  /** Find the tab that owns a given workspaceId. */
  findTabByWorkspaceId: (
    rootWorkspaceId: WorkspaceId,
    workspaceId: WorkspaceId,
  ) => WorkspaceTab | undefined;
  findTerminalTabByTerminalId: (
    rootWorkspaceId: WorkspaceId,
    terminalId: string,
  ) => WorkspaceTab | undefined;
  findRootWorkspaceId: (workspaceId: WorkspaceId) => WorkspaceId | null;
  findGroupedWorkspaceIds: (rootWorkspaceId: WorkspaceId) => WorkspaceId[];
  /** Find a diff tab matching the given source workspace, turn, and file path. */
  findDiffTab: (
    rootWorkspaceId: WorkspaceId,
    diffSourceWorkspaceId: WorkspaceId,
    diffTurnId: TurnId | undefined,
    diffFilePath: string,
  ) => WorkspaceTab | undefined;
}

function createTabStateStorage() {
  return resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined);
}

export const useWorkspaceTabStore = create<WorkspaceTabStoreState>()(
  persist(
    (set, get) => ({
      tabStateByRootWorkspaceId: {},
      rootWorkspaceIdByWorkspaceId: {},

      getOrInitTabs: (rootWorkspaceId) => {
        const existing = get().tabStateByRootWorkspaceId[rootWorkspaceId];
        if (existing) return existing;
        // Start with an empty tab bar — user adds instances via "+".
        const initial: WorkspaceTabState = { tabs: [], activeTabId: "" };
        set((state) => ({
          tabStateByRootWorkspaceId: {
            ...state.tabStateByRootWorkspaceId,
            [rootWorkspaceId]: initial,
          },
          rootWorkspaceIdByWorkspaceId: {
            ...state.rootWorkspaceIdByWorkspaceId,
            [rootWorkspaceId]: rootWorkspaceId,
          },
        }));
        return initial;
      },

      addTab: (rootWorkspaceId, tab) =>
        set((state) => {
          const current = state.tabStateByRootWorkspaceId[rootWorkspaceId];
          if (!current) return state;
          const nextTabStateByRootWorkspaceId = { ...state.tabStateByRootWorkspaceId };
          const nextRootWorkspaceIdByWorkspaceId = {
            ...state.rootWorkspaceIdByWorkspaceId,
            [rootWorkspaceId]: rootWorkspaceId,
          };

          if (tab.kind === "provider" && tab.workspaceId) {
            nextRootWorkspaceIdByWorkspaceId[tab.workspaceId] = rootWorkspaceId;
            for (const [existingRootWorkspaceId, existingTabState] of Object.entries(
              nextTabStateByRootWorkspaceId,
            )) {
              const dedupedTabs = existingTabState.tabs.filter(
                (existingTab) =>
                  !(existingTab.kind === "provider" && existingTab.workspaceId === tab.workspaceId),
              );
              if (dedupedTabs.length === existingTabState.tabs.length) {
                continue;
              }
              nextTabStateByRootWorkspaceId[existingRootWorkspaceId] = {
                tabs: dedupedTabs,
                activeTabId: normalizeActiveTabId(dedupedTabs, existingTabState.activeTabId),
              };
            }
          }

          return {
            tabStateByRootWorkspaceId: {
              ...nextTabStateByRootWorkspaceId,
              [rootWorkspaceId]: {
                tabs: [...current.tabs, tab],
                activeTabId: tab.id,
              },
            },
            rootWorkspaceIdByWorkspaceId: nextRootWorkspaceIdByWorkspaceId,
          };
        }),

      removeTab: (rootWorkspaceId, tabId) =>
        set((state) => {
          const current = state.tabStateByRootWorkspaceId[rootWorkspaceId];
          if (!current) return state;

          const nextTabs = current.tabs.filter((t) => t.id !== tabId);
          const needsNewActive = current.activeTabId === tabId;
          const nextActiveTabId = needsNewActive
            ? (nextTabs[Math.max(0, current.tabs.findIndex((t) => t.id === tabId) - 1)]?.id ??
              nextTabs[0]?.id ??
              "")
            : current.activeTabId;

          return {
            tabStateByRootWorkspaceId: {
              ...state.tabStateByRootWorkspaceId,
              [rootWorkspaceId]: { tabs: nextTabs, activeTabId: nextActiveTabId },
            },
          };
        }),

      setActiveTab: (rootWorkspaceId, tabId) =>
        set((state) => {
          const current = state.tabStateByRootWorkspaceId[rootWorkspaceId];
          if (!current || current.activeTabId === tabId) return state;
          if (!current.tabs.some((t) => t.id === tabId)) return state;
          return {
            tabStateByRootWorkspaceId: {
              ...state.tabStateByRootWorkspaceId,
              [rootWorkspaceId]: { ...current, activeTabId: tabId },
            },
          };
        }),

      reorderTabs: (rootWorkspaceId, activeTabId, overTabId) =>
        set((state) => {
          if (activeTabId === overTabId) return state;
          const current = state.tabStateByRootWorkspaceId[rootWorkspaceId];
          if (!current) return state;
          const fromIndex = current.tabs.findIndex((t) => t.id === activeTabId);
          const toIndex = current.tabs.findIndex((t) => t.id === overTabId);
          if (fromIndex < 0 || toIndex < 0) return state;
          const nextTabs = [...current.tabs];
          const [moved] = nextTabs.splice(fromIndex, 1);
          if (!moved) return state;
          nextTabs.splice(toIndex, 0, moved);
          return {
            tabStateByRootWorkspaceId: {
              ...state.tabStateByRootWorkspaceId,
              [rootWorkspaceId]: { ...current, tabs: nextTabs },
            },
          };
        }),

      findTabByWorkspaceId: (rootWorkspaceId, workspaceId) => {
        const current = get().tabStateByRootWorkspaceId[rootWorkspaceId];
        return current?.tabs.find((t) => t.kind === "provider" && t.workspaceId === workspaceId);
      },

      findTerminalTabByTerminalId: (rootWorkspaceId, terminalId) => {
        const current = get().tabStateByRootWorkspaceId[rootWorkspaceId];
        return current?.tabs.find((t) => t.kind === "terminal" && t.terminalId === terminalId);
      },

      findRootWorkspaceId: (workspaceId) => {
        const state = get();
        const rootWorkspaceId =
          state.rootWorkspaceIdByWorkspaceId[workspaceId] ??
          deriveRootWorkspaceIdByWorkspaceId(state.tabStateByRootWorkspaceId)[workspaceId];
        return rootWorkspaceId ?? null;
      },

      findGroupedWorkspaceIds: (rootWorkspaceId) => {
        const state = get();
        const effectiveRootWorkspaceIdByWorkspaceId = getEffectiveRootWorkspaceIdByWorkspaceId({
          tabStateByRootWorkspaceId: state.tabStateByRootWorkspaceId,
          rootWorkspaceIdByWorkspaceId: state.rootWorkspaceIdByWorkspaceId,
        });
        return Object.entries(effectiveRootWorkspaceIdByWorkspaceId)
          .filter(
            ([workspaceId, groupedRootWorkspaceId]) =>
              workspaceId !== rootWorkspaceId && groupedRootWorkspaceId === rootWorkspaceId,
          )
          .map(([workspaceId]) => workspaceId as WorkspaceId);
      },

      findDiffTab: (rootWorkspaceId, diffSourceWorkspaceId, diffTurnId, diffFilePath) => {
        const current = get().tabStateByRootWorkspaceId[rootWorkspaceId];
        return current?.tabs.find(
          (t) =>
            t.kind === "diff" &&
            t.diffSourceWorkspaceId === diffSourceWorkspaceId &&
            t.diffTurnId === diffTurnId &&
            t.diffFilePath === diffFilePath,
        );
      },
    }),
    {
      name: STORAGE_KEY,
      version: STORAGE_VERSION,
      storage: createJSONStorage(createTabStateStorage),
      migrate: (persistedState) => {
        const rawState =
          typeof persistedState === "object" && persistedState !== null
            ? (persistedState as {
                tabStateByRootWorkspaceId?: Record<string, WorkspaceTabState>;
                tabStateByWorkspaceWorkspaceId?: Record<string, WorkspaceTabState>;
                rootWorkspaceIdByWorkspaceId?: Record<string, WorkspaceId>;
              })
            : {};
        const tabStateByRootWorkspaceId =
          rawState.tabStateByRootWorkspaceId ?? rawState.tabStateByWorkspaceWorkspaceId ?? {};
        const sanitized = sanitizeWorkspaceTabPersistenceState({
          tabStateByRootWorkspaceId,
          ...(rawState.rootWorkspaceIdByWorkspaceId
            ? { rootWorkspaceIdByWorkspaceId: rawState.rootWorkspaceIdByWorkspaceId }
            : {}),
        });
        return {
          tabStateByRootWorkspaceId: sanitized.tabStateByRootWorkspaceId,
          rootWorkspaceIdByWorkspaceId: sanitized.rootWorkspaceIdByWorkspaceId,
        };
      },
      partialize: (state) => ({
        tabStateByRootWorkspaceId: state.tabStateByRootWorkspaceId,
        rootWorkspaceIdByWorkspaceId: state.rootWorkspaceIdByWorkspaceId,
      }),
    },
  ),
);
