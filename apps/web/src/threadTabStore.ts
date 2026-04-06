/**
 * Zustand store for workspace tab state, keyed by the workspace's root thread id.
 *
 * Each workspace thread owns its own tab bar. Provider tabs point at the thread
 * they run in; terminal tabs are workspace-scoped.
 */

import { type ProviderKind, type ThreadId } from "@matcha/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { resolveStorage } from "./lib/storage";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TabKind = "provider" | "terminal";

export interface ThreadTab {
  id: string;
  kind: TabKind;
  /** The thread this tab owns — only for provider tabs. */
  threadId?: ThreadId;
  /** Provider type — only set when `kind === "provider"`. */
  provider?: ProviderKind;
  label: string;
}

export interface WorkspaceTabState {
  tabs: ThreadTab[];
  activeTabId: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STORAGE_KEY = "matcha:workspace-tabs:v2";

let nextId = 1;
function generateTabId(): string {
  return `tab-${Date.now()}-${nextId++}`;
}

const PROVIDER_LABELS: Record<ProviderKind, string> = {
  codex: "Codex",
  claudeAgent: "Claude Code",
};

export function makeProviderTab(provider: ProviderKind, threadId: ThreadId): ThreadTab {
  return {
    id: generateTabId(),
    kind: "provider",
    provider,
    threadId,
    label: PROVIDER_LABELS[provider] ?? provider,
  };
}

export function makeTerminalTab(): ThreadTab {
  return {
    id: generateTabId(),
    kind: "terminal",
    label: "Terminal",
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface WorkspaceTabStoreState {
  tabStateByWorkspaceThreadId: Record<string, WorkspaceTabState>;

  getOrInitTabs: (workspaceThreadId: ThreadId) => WorkspaceTabState;
  addTab: (workspaceThreadId: ThreadId, tab: ThreadTab) => void;
  removeTab: (workspaceThreadId: ThreadId, tabId: string) => void;
  setActiveTab: (workspaceThreadId: ThreadId, tabId: string) => void;
  /** Find the tab that owns a given threadId. */
  findTabByThreadId: (workspaceThreadId: ThreadId, threadId: ThreadId) => ThreadTab | undefined;
  findTerminalTab: (workspaceThreadId: ThreadId) => ThreadTab | undefined;
  findWorkspaceThreadIdByProviderThreadId: (threadId: ThreadId) => ThreadId | null;
}

function createTabStateStorage() {
  return resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined);
}

export const useWorkspaceTabStore = create<WorkspaceTabStoreState>()(
  persist(
    (set, get) => ({
      tabStateByWorkspaceThreadId: {},

      getOrInitTabs: (workspaceThreadId) => {
        const existing = get().tabStateByWorkspaceThreadId[workspaceThreadId];
        if (existing) return existing;
        // Start with an empty tab bar — user adds instances via "+".
        const initial: WorkspaceTabState = { tabs: [], activeTabId: "" };
        set((state) => ({
          tabStateByWorkspaceThreadId: {
            ...state.tabStateByWorkspaceThreadId,
            [workspaceThreadId]: initial,
          },
        }));
        return initial;
      },

      addTab: (workspaceThreadId, tab) =>
        set((state) => {
          const current = state.tabStateByWorkspaceThreadId[workspaceThreadId];
          if (!current) return state;
          return {
            tabStateByWorkspaceThreadId: {
              ...state.tabStateByWorkspaceThreadId,
              [workspaceThreadId]: {
                tabs: [...current.tabs, tab],
                activeTabId: tab.id,
              },
            },
          };
        }),

      removeTab: (workspaceThreadId, tabId) =>
        set((state) => {
          const current = state.tabStateByWorkspaceThreadId[workspaceThreadId];
          if (!current) return state;

          const nextTabs = current.tabs.filter((t) => t.id !== tabId);
          const needsNewActive = current.activeTabId === tabId;
          const nextActiveTabId = needsNewActive
            ? (nextTabs[Math.max(0, current.tabs.findIndex((t) => t.id === tabId) - 1)]?.id ??
              nextTabs[0]?.id ??
              "")
            : current.activeTabId;

          return {
            tabStateByWorkspaceThreadId: {
              ...state.tabStateByWorkspaceThreadId,
              [workspaceThreadId]: { tabs: nextTabs, activeTabId: nextActiveTabId },
            },
          };
        }),

      setActiveTab: (workspaceThreadId, tabId) =>
        set((state) => {
          const current = state.tabStateByWorkspaceThreadId[workspaceThreadId];
          if (!current || current.activeTabId === tabId) return state;
          if (!current.tabs.some((t) => t.id === tabId)) return state;
          return {
            tabStateByWorkspaceThreadId: {
              ...state.tabStateByWorkspaceThreadId,
              [workspaceThreadId]: { ...current, activeTabId: tabId },
            },
          };
        }),

      findTabByThreadId: (workspaceThreadId, threadId) => {
        const current = get().tabStateByWorkspaceThreadId[workspaceThreadId];
        return current?.tabs.find((t) => t.kind === "provider" && t.threadId === threadId);
      },

      findTerminalTab: (workspaceThreadId) => {
        const current = get().tabStateByWorkspaceThreadId[workspaceThreadId];
        return current?.tabs.find((t) => t.kind === "terminal");
      },

      findWorkspaceThreadIdByProviderThreadId: (threadId) => {
        for (const [workspaceThreadId, current] of Object.entries(
          get().tabStateByWorkspaceThreadId,
        )) {
          if (current.tabs.some((tab) => tab.kind === "provider" && tab.threadId === threadId)) {
            return workspaceThreadId as ThreadId;
          }
        }
        return null;
      },
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(createTabStateStorage),
      partialize: (state) => ({
        tabStateByWorkspaceThreadId: state.tabStateByWorkspaceThreadId,
      }),
    },
  ),
);
