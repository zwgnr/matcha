import { WorkspaceId } from "@matcha/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { useWorkspaceSelectionStore } from "./workspaceSelectionStore";

const WORKSPACE_A = WorkspaceId.makeUnsafe("workspace-a");
const WORKSPACE_B = WorkspaceId.makeUnsafe("workspace-b");
const WORKSPACE_C = WorkspaceId.makeUnsafe("workspace-c");
const WORKSPACE_D = WorkspaceId.makeUnsafe("workspace-d");
const WORKSPACE_E = WorkspaceId.makeUnsafe("workspace-e");

const ORDERED = [WORKSPACE_A, WORKSPACE_B, WORKSPACE_C, WORKSPACE_D, WORKSPACE_E] as const;

describe("workspaceSelectionStore", () => {
  beforeEach(() => {
    useWorkspaceSelectionStore.getState().clearSelection();
  });

  describe("toggleWorkspace", () => {
    it("adds a workspace to empty selection", () => {
      useWorkspaceSelectionStore.getState().toggleWorkspace(WORKSPACE_A);

      const state = useWorkspaceSelectionStore.getState();
      expect(state.selectedWorkspaceIds.has(WORKSPACE_A)).toBe(true);
      expect(state.selectedWorkspaceIds.size).toBe(1);
      expect(state.anchorWorkspaceId).toBe(WORKSPACE_A);
    });

    it("removes a workspace that is already selected", () => {
      const store = useWorkspaceSelectionStore.getState();
      store.toggleWorkspace(WORKSPACE_A);
      store.toggleWorkspace(WORKSPACE_A);

      const state = useWorkspaceSelectionStore.getState();
      expect(state.selectedWorkspaceIds.has(WORKSPACE_A)).toBe(false);
      expect(state.selectedWorkspaceIds.size).toBe(0);
    });

    it("preserves existing selections when toggling a new workspace", () => {
      const store = useWorkspaceSelectionStore.getState();
      store.toggleWorkspace(WORKSPACE_A);
      store.toggleWorkspace(WORKSPACE_B);

      const state = useWorkspaceSelectionStore.getState();
      expect(state.selectedWorkspaceIds.has(WORKSPACE_A)).toBe(true);
      expect(state.selectedWorkspaceIds.has(WORKSPACE_B)).toBe(true);
      expect(state.selectedWorkspaceIds.size).toBe(2);
    });

    it("sets anchor to the newly added workspace", () => {
      const store = useWorkspaceSelectionStore.getState();
      store.toggleWorkspace(WORKSPACE_A);
      store.toggleWorkspace(WORKSPACE_B);

      expect(useWorkspaceSelectionStore.getState().anchorWorkspaceId).toBe(WORKSPACE_B);
    });

    it("preserves anchor when deselecting a non-anchor workspace", () => {
      const store = useWorkspaceSelectionStore.getState();
      store.toggleWorkspace(WORKSPACE_A);
      store.toggleWorkspace(WORKSPACE_B);
      store.toggleWorkspace(WORKSPACE_A); // deselect A, anchor should stay B

      expect(useWorkspaceSelectionStore.getState().anchorWorkspaceId).toBe(WORKSPACE_B);
    });
  });

  describe("setAnchor", () => {
    it("sets anchor without adding to selection", () => {
      useWorkspaceSelectionStore.getState().setAnchor(WORKSPACE_B);

      const state = useWorkspaceSelectionStore.getState();
      expect(state.anchorWorkspaceId).toBe(WORKSPACE_B);
      expect(state.selectedWorkspaceIds.size).toBe(0);
    });

    it("enables range select from a plain-click anchor", () => {
      const store = useWorkspaceSelectionStore.getState();
      store.setAnchor(WORKSPACE_B); // simulate plain-click navigate to B
      store.rangeSelectTo(WORKSPACE_D, ORDERED); // shift-click D

      const state = useWorkspaceSelectionStore.getState();
      expect(state.selectedWorkspaceIds.has(WORKSPACE_B)).toBe(true);
      expect(state.selectedWorkspaceIds.has(WORKSPACE_C)).toBe(true);
      expect(state.selectedWorkspaceIds.has(WORKSPACE_D)).toBe(true);
      expect(state.selectedWorkspaceIds.size).toBe(3);
    });

    it("is a no-op when anchor is already set to the same workspace", () => {
      const store = useWorkspaceSelectionStore.getState();
      store.setAnchor(WORKSPACE_B);
      const stateBefore = useWorkspaceSelectionStore.getState();
      store.setAnchor(WORKSPACE_B);
      const stateAfter = useWorkspaceSelectionStore.getState();

      // Should be referentially the same (no unnecessary re-render)
      expect(stateAfter).toBe(stateBefore);
    });

    it("survives clearSelection followed by setAnchor", () => {
      const store = useWorkspaceSelectionStore.getState();
      store.toggleWorkspace(WORKSPACE_A);
      store.toggleWorkspace(WORKSPACE_B);
      store.clearSelection();
      store.setAnchor(WORKSPACE_C);

      const state = useWorkspaceSelectionStore.getState();
      expect(state.anchorWorkspaceId).toBe(WORKSPACE_C);
      expect(state.selectedWorkspaceIds.size).toBe(0);
    });
  });

  describe("rangeSelectTo", () => {
    it("selects a single workspace when no anchor exists", () => {
      useWorkspaceSelectionStore.getState().rangeSelectTo(WORKSPACE_C, ORDERED);

      const state = useWorkspaceSelectionStore.getState();
      expect(state.selectedWorkspaceIds.has(WORKSPACE_C)).toBe(true);
      expect(state.selectedWorkspaceIds.size).toBe(1);
      expect(state.anchorWorkspaceId).toBe(WORKSPACE_C);
    });

    it("selects range from anchor to target (forward)", () => {
      const store = useWorkspaceSelectionStore.getState();
      store.toggleWorkspace(WORKSPACE_B); // sets anchor to B
      store.rangeSelectTo(WORKSPACE_D, ORDERED);

      const state = useWorkspaceSelectionStore.getState();
      expect(state.selectedWorkspaceIds.has(WORKSPACE_B)).toBe(true);
      expect(state.selectedWorkspaceIds.has(WORKSPACE_C)).toBe(true);
      expect(state.selectedWorkspaceIds.has(WORKSPACE_D)).toBe(true);
      expect(state.selectedWorkspaceIds.size).toBe(3);
    });

    it("selects range from anchor to target (backward)", () => {
      const store = useWorkspaceSelectionStore.getState();
      store.toggleWorkspace(WORKSPACE_D); // sets anchor to D
      store.rangeSelectTo(WORKSPACE_B, ORDERED);

      const state = useWorkspaceSelectionStore.getState();
      expect(state.selectedWorkspaceIds.has(WORKSPACE_B)).toBe(true);
      expect(state.selectedWorkspaceIds.has(WORKSPACE_C)).toBe(true);
      expect(state.selectedWorkspaceIds.has(WORKSPACE_D)).toBe(true);
      expect(state.selectedWorkspaceIds.size).toBe(3);
    });

    it("keeps anchor stable across multiple range selects", () => {
      const store = useWorkspaceSelectionStore.getState();
      store.toggleWorkspace(WORKSPACE_B); // anchor = B
      store.rangeSelectTo(WORKSPACE_D, ORDERED); // selects B-D
      store.rangeSelectTo(WORKSPACE_E, ORDERED); // extends B-E (anchor stays B)

      const state = useWorkspaceSelectionStore.getState();
      expect(state.anchorWorkspaceId).toBe(WORKSPACE_B);
      expect(state.selectedWorkspaceIds.has(WORKSPACE_B)).toBe(true);
      expect(state.selectedWorkspaceIds.has(WORKSPACE_C)).toBe(true);
      expect(state.selectedWorkspaceIds.has(WORKSPACE_D)).toBe(true);
      expect(state.selectedWorkspaceIds.has(WORKSPACE_E)).toBe(true);
    });

    it("falls back to toggle when anchor is not in the ordered list", () => {
      const store = useWorkspaceSelectionStore.getState();
      store.toggleWorkspace(WORKSPACE_A); // anchor = A
      // Range-select with a list that does NOT contain the anchor
      store.rangeSelectTo(WORKSPACE_C, [WORKSPACE_B, WORKSPACE_C, WORKSPACE_D]);

      const state = useWorkspaceSelectionStore.getState();
      // Should have added C and reset anchor to C
      expect(state.selectedWorkspaceIds.has(WORKSPACE_C)).toBe(true);
      expect(state.anchorWorkspaceId).toBe(WORKSPACE_C);
    });

    it("falls back to toggle when target is not in the ordered list", () => {
      const store = useWorkspaceSelectionStore.getState();
      store.toggleWorkspace(WORKSPACE_B); // anchor = B
      const unknownWorkspace = WorkspaceId.makeUnsafe("workspace-unknown");
      store.rangeSelectTo(unknownWorkspace, ORDERED);

      const state = useWorkspaceSelectionStore.getState();
      expect(state.selectedWorkspaceIds.has(unknownWorkspace)).toBe(true);
      expect(state.anchorWorkspaceId).toBe(unknownWorkspace);
    });

    it("selects the single workspace when anchor equals target", () => {
      const store = useWorkspaceSelectionStore.getState();
      store.toggleWorkspace(WORKSPACE_C); // anchor = C
      store.rangeSelectTo(WORKSPACE_C, ORDERED); // range from C to C

      const state = useWorkspaceSelectionStore.getState();
      expect(state.selectedWorkspaceIds.has(WORKSPACE_C)).toBe(true);
      expect(state.selectedWorkspaceIds.size).toBe(1);
    });

    it("preserves previously selected workspaces outside the range", () => {
      const store = useWorkspaceSelectionStore.getState();
      store.toggleWorkspace(WORKSPACE_A); // select A, anchor = A
      store.toggleWorkspace(WORKSPACE_B); // select B, anchor = B

      // Now shift-select from B (anchor) to D — should add B, C, D but keep A
      store.rangeSelectTo(WORKSPACE_D, ORDERED);

      const state = useWorkspaceSelectionStore.getState();
      expect(state.selectedWorkspaceIds.has(WORKSPACE_A)).toBe(true);
      expect(state.selectedWorkspaceIds.has(WORKSPACE_B)).toBe(true);
      expect(state.selectedWorkspaceIds.has(WORKSPACE_C)).toBe(true);
      expect(state.selectedWorkspaceIds.has(WORKSPACE_D)).toBe(true);
      expect(state.selectedWorkspaceIds.size).toBe(4);
    });
  });

  describe("clearSelection", () => {
    it("clears all selected workspaces and anchor", () => {
      const store = useWorkspaceSelectionStore.getState();
      store.toggleWorkspace(WORKSPACE_A);
      store.toggleWorkspace(WORKSPACE_B);
      store.clearSelection();

      const state = useWorkspaceSelectionStore.getState();
      expect(state.selectedWorkspaceIds.size).toBe(0);
      expect(state.anchorWorkspaceId).toBeNull();
    });

    it("is a no-op when already empty", () => {
      const stateBefore = useWorkspaceSelectionStore.getState();
      stateBefore.clearSelection();
      const stateAfter = useWorkspaceSelectionStore.getState();

      // Should be referentially the same (no unnecessary re-render)
      expect(stateAfter.selectedWorkspaceIds).toBe(stateBefore.selectedWorkspaceIds);
    });
  });

  describe("removeFromSelection", () => {
    it("removes specified workspaces from selection", () => {
      const store = useWorkspaceSelectionStore.getState();
      store.toggleWorkspace(WORKSPACE_A);
      store.toggleWorkspace(WORKSPACE_B);
      store.toggleWorkspace(WORKSPACE_C);
      store.removeFromSelection([WORKSPACE_A, WORKSPACE_C]);

      const state = useWorkspaceSelectionStore.getState();
      expect(state.selectedWorkspaceIds.has(WORKSPACE_B)).toBe(true);
      expect(state.selectedWorkspaceIds.size).toBe(1);
    });

    it("clears anchor when the anchor workspace is removed", () => {
      const store = useWorkspaceSelectionStore.getState();
      store.toggleWorkspace(WORKSPACE_A);
      store.toggleWorkspace(WORKSPACE_B); // anchor = B
      store.removeFromSelection([WORKSPACE_B]);

      expect(useWorkspaceSelectionStore.getState().anchorWorkspaceId).toBeNull();
    });

    it("preserves anchor when the anchor workspace is not removed", () => {
      const store = useWorkspaceSelectionStore.getState();
      store.toggleWorkspace(WORKSPACE_A);
      store.toggleWorkspace(WORKSPACE_B); // anchor = B
      store.removeFromSelection([WORKSPACE_A]);

      expect(useWorkspaceSelectionStore.getState().anchorWorkspaceId).toBe(WORKSPACE_B);
    });

    it("is a no-op when none of the specified workspaces are selected", () => {
      const store = useWorkspaceSelectionStore.getState();
      store.toggleWorkspace(WORKSPACE_A);
      const stateBefore = useWorkspaceSelectionStore.getState();
      store.removeFromSelection([WORKSPACE_B, WORKSPACE_C]);
      const stateAfter = useWorkspaceSelectionStore.getState();

      expect(stateAfter.selectedWorkspaceIds).toBe(stateBefore.selectedWorkspaceIds);
    });
  });

  describe("hasSelection", () => {
    it("returns false when nothing is selected", () => {
      expect(useWorkspaceSelectionStore.getState().hasSelection()).toBe(false);
    });

    it("returns true when workspaces are selected", () => {
      useWorkspaceSelectionStore.getState().toggleWorkspace(WORKSPACE_A);
      expect(useWorkspaceSelectionStore.getState().hasSelection()).toBe(true);
    });

    it("returns false after clearing selection", () => {
      const store = useWorkspaceSelectionStore.getState();
      store.toggleWorkspace(WORKSPACE_A);
      store.clearSelection();
      expect(useWorkspaceSelectionStore.getState().hasSelection()).toBe(false);
    });
  });
});
