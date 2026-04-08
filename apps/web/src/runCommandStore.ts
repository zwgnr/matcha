/**
 * Zustand store for the "Run Command" feature.
 *
 * - **Config** (per-project): the command string, persisted to localStorage.
 * - **Runtime state** (per-workspace): running status, terminal id, detected ports.
 */

import type { ProjectId, WorkspaceId } from "@matcha/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { resolveStorage } from "./lib/storage";

const RUN_COMMAND_STORAGE_KEY = "matcha:run-command:v1";

// ── Per-workspace runtime state (not persisted) ────────────────────

export interface RunCommandRuntimeState {
  running: boolean;
  terminalId: string | null;
  detectedPorts: number[];
}

const DEFAULT_RUNTIME: RunCommandRuntimeState = {
  running: false,
  terminalId: null,
  detectedPorts: [],
};

// ── Store shape ────────────────────────────────────────────────────

interface RunCommandStoreState {
  /** Persisted: run-command string keyed by project id. */
  commandByProjectId: Record<string, string>;

  /** Transient: runtime state keyed by workspace id. */
  runtimeByWorkspaceId: Record<string, RunCommandRuntimeState>;

  // ── Config actions ──
  setCommand: (projectId: ProjectId, command: string) => void;
  clearCommand: (projectId: ProjectId) => void;

  // ── Runtime actions ──
  start: (workspaceId: WorkspaceId, terminalId: string) => void;
  stop: (workspaceId: WorkspaceId) => void;
  addPorts: (workspaceId: WorkspaceId, ports: number[]) => void;
  clearRuntime: (workspaceId: WorkspaceId) => void;
}

function createRunCommandStorage() {
  return resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined);
}

export const useRunCommandStore = create<RunCommandStoreState>()(
  persist(
    (set) => ({
      commandByProjectId: {},
      runtimeByWorkspaceId: {},

      setCommand: (projectId, command) =>
        set((state) => ({
          commandByProjectId: {
            ...state.commandByProjectId,
            [projectId]: command,
          },
        })),

      clearCommand: (projectId) =>
        set((state) => {
          const { [projectId]: _removed, ...rest } = state.commandByProjectId;
          return { commandByProjectId: rest };
        }),

      start: (workspaceId, terminalId) =>
        set((state) => ({
          runtimeByWorkspaceId: {
            ...state.runtimeByWorkspaceId,
            [workspaceId]: {
              running: true,
              terminalId,
              detectedPorts: [],
            },
          },
        })),

      stop: (workspaceId) =>
        set((state) => {
          const current = state.runtimeByWorkspaceId[workspaceId];
          if (!current) return state;
          return {
            runtimeByWorkspaceId: {
              ...state.runtimeByWorkspaceId,
              [workspaceId]: {
                ...current,
                running: false,
                // Keep terminalId so we can reuse it on next start
                detectedPorts: [],
              },
            },
          };
        }),

      addPorts: (workspaceId, ports) =>
        set((state) => {
          const current = state.runtimeByWorkspaceId[workspaceId];
          if (!current?.running || ports.length === 0) return state;
          const existingPorts = new Set(current.detectedPorts);
          const newPorts = ports.filter((p) => !existingPorts.has(p));
          if (newPorts.length === 0) return state;
          return {
            runtimeByWorkspaceId: {
              ...state.runtimeByWorkspaceId,
              [workspaceId]: {
                ...current,
                detectedPorts: [...current.detectedPorts, ...newPorts].toSorted((a, b) => a - b),
              },
            },
          };
        }),

      clearRuntime: (workspaceId) =>
        set((state) => {
          if (!state.runtimeByWorkspaceId[workspaceId]) return state;
          const { [workspaceId]: _removed, ...rest } = state.runtimeByWorkspaceId;
          return { runtimeByWorkspaceId: rest };
        }),
    }),
    {
      name: RUN_COMMAND_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(createRunCommandStorage),
      partialize: (state) => ({
        commandByProjectId: state.commandByProjectId,
      }),
    },
  ),
);

// ── Selectors ──────────────────────────────────────────────────────

export function selectRunCommand(
  commandByProjectId: Record<string, string>,
  projectId: ProjectId | undefined,
): string | null {
  if (!projectId) return null;
  return commandByProjectId[projectId] ?? null;
}

export function selectRunCommandRuntime(
  runtimeByWorkspaceId: Record<string, RunCommandRuntimeState>,
  workspaceId: WorkspaceId | undefined,
): RunCommandRuntimeState {
  if (!workspaceId) return DEFAULT_RUNTIME;
  return runtimeByWorkspaceId[workspaceId] ?? DEFAULT_RUNTIME;
}
