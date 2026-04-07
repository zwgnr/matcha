/**
 * Zustand store for sidebar workspace multi-selection state.
 *
 * Supports Cmd/Ctrl+Click (toggle individual), Shift+Click (range select),
 * and bulk actions on the selected set.
 */

import type { WorkspaceId } from "@matcha/contracts";
import { create } from "zustand";

export interface WorkspaceSelectionState {
  /** Currently selected workspace IDs. */
  selectedWorkspaceIds: ReadonlySet<WorkspaceId>;
  /** The workspace ID that anchors shift-click range selection. */
  anchorWorkspaceId: WorkspaceId | null;
}

interface WorkspaceSelectionStore extends WorkspaceSelectionState {
  /** Toggle a single workspace in the selection (Cmd/Ctrl+Click). */
  toggleWorkspace: (workspaceId: WorkspaceId) => void;
  /**
   * Select a range of workspaces (Shift+Click).
   * Requires the ordered list of workspace IDs within the same project
   * so the store can compute which workspaces fall between anchor and target.
   */
  rangeSelectTo: (workspaceId: WorkspaceId, orderedWorkspaceIds: readonly WorkspaceId[]) => void;
  /** Clear all selection state. */
  clearSelection: () => void;
  /** Remove specific workspace IDs from the selection (e.g. after deletion). */
  removeFromSelection: (workspaceIds: readonly WorkspaceId[]) => void;
  /** Set the anchor workspace without adding it to the selection (e.g. on plain-click navigate). */
  setAnchor: (workspaceId: WorkspaceId) => void;
  /** Check if any workspaces are selected. */
  hasSelection: () => boolean;
}

const EMPTY_SET = new Set<WorkspaceId>();

export const useWorkspaceSelectionStore = create<WorkspaceSelectionStore>((set, get) => ({
  selectedWorkspaceIds: EMPTY_SET,
  anchorWorkspaceId: null,

  toggleWorkspace: (workspaceId) => {
    set((state) => {
      const next = new Set(state.selectedWorkspaceIds);
      if (next.has(workspaceId)) {
        next.delete(workspaceId);
      } else {
        next.add(workspaceId);
      }
      return {
        selectedWorkspaceIds: next,
        anchorWorkspaceId: next.has(workspaceId) ? workspaceId : state.anchorWorkspaceId,
      };
    });
  },

  rangeSelectTo: (workspaceId, orderedWorkspaceIds) => {
    set((state) => {
      const anchor = state.anchorWorkspaceId;
      if (anchor === null) {
        // No anchor yet — treat as a single toggle
        const next = new Set(state.selectedWorkspaceIds);
        next.add(workspaceId);
        return { selectedWorkspaceIds: next, anchorWorkspaceId: workspaceId };
      }

      const anchorIndex = orderedWorkspaceIds.indexOf(anchor);
      const targetIndex = orderedWorkspaceIds.indexOf(workspaceId);
      if (anchorIndex === -1 || targetIndex === -1) {
        // Anchor or target not in this list (different project?) — fallback to toggle
        const next = new Set(state.selectedWorkspaceIds);
        next.add(workspaceId);
        return { selectedWorkspaceIds: next, anchorWorkspaceId: workspaceId };
      }

      const start = Math.min(anchorIndex, targetIndex);
      const end = Math.max(anchorIndex, targetIndex);
      const next = new Set(state.selectedWorkspaceIds);
      for (let i = start; i <= end; i++) {
        const id = orderedWorkspaceIds[i];
        if (id !== undefined) {
          next.add(id);
        }
      }
      // Keep anchor stable so subsequent shift-clicks extend from the same point
      return { selectedWorkspaceIds: next, anchorWorkspaceId: anchor };
    });
  },

  clearSelection: () => {
    const state = get();
    if (state.selectedWorkspaceIds.size === 0 && state.anchorWorkspaceId === null) return;
    set({ selectedWorkspaceIds: EMPTY_SET, anchorWorkspaceId: null });
  },

  setAnchor: (workspaceId) => {
    if (get().anchorWorkspaceId === workspaceId) return;
    set({ anchorWorkspaceId: workspaceId });
  },

  removeFromSelection: (workspaceIds) => {
    set((state) => {
      const toRemove = new Set(workspaceIds);
      let changed = false;
      const next = new Set<WorkspaceId>();
      for (const id of state.selectedWorkspaceIds) {
        if (toRemove.has(id)) {
          changed = true;
        } else {
          next.add(id);
        }
      }
      if (!changed) return state;
      const newAnchor =
        state.anchorWorkspaceId !== null && toRemove.has(state.anchorWorkspaceId)
          ? null
          : state.anchorWorkspaceId;
      return { selectedWorkspaceIds: next, anchorWorkspaceId: newAnchor };
    });
  },

  hasSelection: () => get().selectedWorkspaceIds.size > 0,
}));
