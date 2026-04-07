/**
 * Zustand store for workspace tab state, keyed by the workspace's root workspace id.
 *
 * Each workspace owns its own tab bar. Provider tabs point at the workspace
 * they run in; terminal tabs are workspace-scoped.
 */

import { type ProviderKind, type WorkspaceId } from "@matcha/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { resolveStorage } from "./lib/storage";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TabKind = "provider" | "terminal";

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
}

export interface WorkspaceTabState {
  tabs: WorkspaceTab[];
  activeTabId: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STORAGE_KEY = "matcha:workspace-tabs:v3";

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

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface WorkspaceTabStoreState {
  tabStateByWorkspaceWorkspaceId: Record<string, WorkspaceTabState>;

  getOrInitTabs: (workspaceWorkspaceId: WorkspaceId) => WorkspaceTabState;
  addTab: (workspaceWorkspaceId: WorkspaceId, tab: WorkspaceTab) => void;
  removeTab: (workspaceWorkspaceId: WorkspaceId, tabId: string) => void;
  setActiveTab: (workspaceWorkspaceId: WorkspaceId, tabId: string) => void;
  /** Find the tab that owns a given workspaceId. */
  findTabByWorkspaceId: (
    workspaceWorkspaceId: WorkspaceId,
    workspaceId: WorkspaceId,
  ) => WorkspaceTab | undefined;
  findTerminalTabByTerminalId: (
    workspaceWorkspaceId: WorkspaceId,
    terminalId: string,
  ) => WorkspaceTab | undefined;
  findWorkspaceWorkspaceIdByProviderWorkspaceId: (workspaceId: WorkspaceId) => WorkspaceId | null;
}

function createTabStateStorage() {
  return resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined);
}

export const useWorkspaceTabStore = create<WorkspaceTabStoreState>()(
  persist(
    (set, get) => ({
      tabStateByWorkspaceWorkspaceId: {},

      getOrInitTabs: (workspaceWorkspaceId) => {
        const existing = get().tabStateByWorkspaceWorkspaceId[workspaceWorkspaceId];
        if (existing) return existing;
        // Start with an empty tab bar — user adds instances via "+".
        const initial: WorkspaceTabState = { tabs: [], activeTabId: "" };
        set((state) => ({
          tabStateByWorkspaceWorkspaceId: {
            ...state.tabStateByWorkspaceWorkspaceId,
            [workspaceWorkspaceId]: initial,
          },
        }));
        return initial;
      },

      addTab: (workspaceWorkspaceId, tab) =>
        set((state) => {
          const current = state.tabStateByWorkspaceWorkspaceId[workspaceWorkspaceId];
          if (!current) return state;
          return {
            tabStateByWorkspaceWorkspaceId: {
              ...state.tabStateByWorkspaceWorkspaceId,
              [workspaceWorkspaceId]: {
                tabs: [...current.tabs, tab],
                activeTabId: tab.id,
              },
            },
          };
        }),

      removeTab: (workspaceWorkspaceId, tabId) =>
        set((state) => {
          const current = state.tabStateByWorkspaceWorkspaceId[workspaceWorkspaceId];
          if (!current) return state;

          const nextTabs = current.tabs.filter((t) => t.id !== tabId);
          const needsNewActive = current.activeTabId === tabId;
          const nextActiveTabId = needsNewActive
            ? (nextTabs[Math.max(0, current.tabs.findIndex((t) => t.id === tabId) - 1)]?.id ??
              nextTabs[0]?.id ??
              "")
            : current.activeTabId;

          return {
            tabStateByWorkspaceWorkspaceId: {
              ...state.tabStateByWorkspaceWorkspaceId,
              [workspaceWorkspaceId]: { tabs: nextTabs, activeTabId: nextActiveTabId },
            },
          };
        }),

      setActiveTab: (workspaceWorkspaceId, tabId) =>
        set((state) => {
          const current = state.tabStateByWorkspaceWorkspaceId[workspaceWorkspaceId];
          if (!current || current.activeTabId === tabId) return state;
          if (!current.tabs.some((t) => t.id === tabId)) return state;
          return {
            tabStateByWorkspaceWorkspaceId: {
              ...state.tabStateByWorkspaceWorkspaceId,
              [workspaceWorkspaceId]: { ...current, activeTabId: tabId },
            },
          };
        }),

      findTabByWorkspaceId: (workspaceWorkspaceId, workspaceId) => {
        const current = get().tabStateByWorkspaceWorkspaceId[workspaceWorkspaceId];
        return current?.tabs.find((t) => t.kind === "provider" && t.workspaceId === workspaceId);
      },

      findTerminalTabByTerminalId: (workspaceWorkspaceId, terminalId) => {
        const current = get().tabStateByWorkspaceWorkspaceId[workspaceWorkspaceId];
        return current?.tabs.find((t) => t.kind === "terminal" && t.terminalId === terminalId);
      },

      findWorkspaceWorkspaceIdByProviderWorkspaceId: (workspaceId) => {
        for (const [workspaceWorkspaceId, current] of Object.entries(
          get().tabStateByWorkspaceWorkspaceId,
        )) {
          if (
            current.tabs.some((tab) => tab.kind === "provider" && tab.workspaceId === workspaceId)
          ) {
            return workspaceWorkspaceId as WorkspaceId;
          }
        }
        return null;
      },
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(createTabStateStorage),
      partialize: (state) => ({
        tabStateByWorkspaceWorkspaceId: state.tabStateByWorkspaceWorkspaceId,
      }),
    },
  ),
);
