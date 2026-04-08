import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createWorkspaceJumpHintVisibilityController,
  getVisibleSidebarWorkspaceIds,
  resolveAdjacentWorkspaceId,
  getFallbackWorkspaceIdAfterDelete,
  getVisibleWorkspacesForProject,
  hasUnseenCompletion,
  isContextMenuPointerDown,
  orderItemsByPreferredIds,
  resolveProjectStatusIndicator,
  resolveSidebarNewWorkspaceSeedContext,
  resolveSidebarNewWorkspaceEnvMode,
  resolveWorkspaceRowClassName,
  resolveWorkspaceStatusPill,
  shouldClearWorkspaceSelectionOnMouseDown,
  sortWorkspacesByCreatedAt,
  WORKSPACE_JUMP_HINT_SHOW_DELAY_MS,
} from "./Sidebar.logic";
import { OrchestrationLatestTurn, ProjectId, WorkspaceId } from "@matcha/contracts";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type Workspace } from "../types";

function makeLatestTurn(overrides?: {
  completedAt?: string | null;
  startedAt?: string | null;
}): OrchestrationLatestTurn {
  return {
    turnId: "turn-1" as never,
    state: "completed",
    assistantMessageId: null,
    requestedAt: "2026-03-09T10:00:00.000Z",
    startedAt: overrides?.startedAt ?? "2026-03-09T10:00:00.000Z",
    completedAt: overrides?.completedAt ?? "2026-03-09T10:05:00.000Z",
  };
}

describe("hasUnseenCompletion", () => {
  it("returns true when a workspace completed after its last visit", () => {
    expect(
      hasUnseenCompletion({
        hasActionableProposedPlan: false,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        interactionMode: "default",
        latestTurn: makeLatestTurn(),
        lastVisitedAt: "2026-03-09T10:04:00.000Z",
        session: null,
      }),
    ).toBe(true);
  });
});

describe("createWorkspaceJumpHintVisibilityController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("delays showing jump hints until the configured delay elapses", () => {
    const visibilityChanges: boolean[] = [];
    const controller = createWorkspaceJumpHintVisibilityController({
      delayMs: WORKSPACE_JUMP_HINT_SHOW_DELAY_MS,
      onVisibilityChange: (visible) => {
        visibilityChanges.push(visible);
      },
    });

    controller.sync(true);
    vi.advanceTimersByTime(WORKSPACE_JUMP_HINT_SHOW_DELAY_MS - 1);

    expect(visibilityChanges).toEqual([]);

    vi.advanceTimersByTime(1);

    expect(visibilityChanges).toEqual([true]);
  });

  it("hides immediately when the modifiers are released", () => {
    const visibilityChanges: boolean[] = [];
    const controller = createWorkspaceJumpHintVisibilityController({
      delayMs: WORKSPACE_JUMP_HINT_SHOW_DELAY_MS,
      onVisibilityChange: (visible) => {
        visibilityChanges.push(visible);
      },
    });

    controller.sync(true);
    vi.advanceTimersByTime(WORKSPACE_JUMP_HINT_SHOW_DELAY_MS);
    controller.sync(false);

    expect(visibilityChanges).toEqual([true, false]);
  });

  it("cancels a pending reveal when the modifier is released early", () => {
    const visibilityChanges: boolean[] = [];
    const controller = createWorkspaceJumpHintVisibilityController({
      delayMs: WORKSPACE_JUMP_HINT_SHOW_DELAY_MS,
      onVisibilityChange: (visible) => {
        visibilityChanges.push(visible);
      },
    });

    controller.sync(true);
    vi.advanceTimersByTime(Math.floor(WORKSPACE_JUMP_HINT_SHOW_DELAY_MS / 2));
    controller.sync(false);
    vi.advanceTimersByTime(WORKSPACE_JUMP_HINT_SHOW_DELAY_MS);

    expect(visibilityChanges).toEqual([]);
  });
});

describe("shouldClearWorkspaceSelectionOnMouseDown", () => {
  it("preserves selection for workspace items", () => {
    const child = {
      closest: (selector: string) =>
        selector.includes("[data-workspace-item]") ? ({} as Element) : null,
    } as unknown as HTMLElement;

    expect(shouldClearWorkspaceSelectionOnMouseDown(child)).toBe(false);
  });

  it("preserves selection for workspace list toggle controls", () => {
    const selectionSafe = {
      closest: (selector: string) =>
        selector.includes("[data-workspace-selection-safe]") ? ({} as Element) : null,
    } as unknown as HTMLElement;

    expect(shouldClearWorkspaceSelectionOnMouseDown(selectionSafe)).toBe(false);
  });

  it("clears selection for unrelated sidebar clicks", () => {
    const unrelated = {
      closest: () => null,
    } as unknown as HTMLElement;

    expect(shouldClearWorkspaceSelectionOnMouseDown(unrelated)).toBe(true);
  });
});

describe("resolveSidebarNewWorkspaceEnvMode", () => {
  it("uses the app default when the caller does not request a specific mode", () => {
    expect(
      resolveSidebarNewWorkspaceEnvMode({
        defaultEnvMode: "worktree",
      }),
    ).toBe("worktree");
  });

  it("preserves an explicit requested mode over the app default", () => {
    expect(
      resolveSidebarNewWorkspaceEnvMode({
        requestedEnvMode: "local",
        defaultEnvMode: "worktree",
      }),
    ).toBe("local");
  });
});

describe("resolveSidebarNewWorkspaceSeedContext", () => {
  it("inherits the active server workspace context when creating a new workspace in the same project", () => {
    expect(
      resolveSidebarNewWorkspaceSeedContext({
        projectId: "project-1",
        defaultEnvMode: "local",
        activeWorkspace: {
          projectId: "project-1",
          branch: "effect-atom",
          worktreePath: null,
        },
        activeDraftWorkspace: null,
      }),
    ).toEqual({
      branch: "effect-atom",
      worktreePath: null,
      envMode: "local",
    });
  });

  it("prefers the active draft workspace context when it matches the target project", () => {
    expect(
      resolveSidebarNewWorkspaceSeedContext({
        projectId: "project-1",
        defaultEnvMode: "local",
        activeWorkspace: {
          projectId: "project-1",
          branch: "effect-atom",
          worktreePath: null,
        },
        activeDraftWorkspace: {
          projectId: "project-1",
          branch: "feature/new-draft",
          worktreePath: "/repo/worktree",
          envMode: "worktree",
        },
      }),
    ).toEqual({
      branch: "feature/new-draft",
      worktreePath: "/repo/worktree",
      envMode: "worktree",
    });
  });

  it("falls back to the default env mode when there is no matching active workspace context", () => {
    expect(
      resolveSidebarNewWorkspaceSeedContext({
        projectId: "project-2",
        defaultEnvMode: "worktree",
        activeWorkspace: {
          projectId: "project-1",
          branch: "effect-atom",
          worktreePath: null,
        },
        activeDraftWorkspace: null,
      }),
    ).toEqual({
      envMode: "worktree",
    });
  });
});

describe("orderItemsByPreferredIds", () => {
  it("keeps preferred ids first, skips stale ids, and preserves the relative order of remaining items", () => {
    const ordered = orderItemsByPreferredIds({
      items: [
        { id: ProjectId.makeUnsafe("project-1"), name: "One" },
        { id: ProjectId.makeUnsafe("project-2"), name: "Two" },
        { id: ProjectId.makeUnsafe("project-3"), name: "Three" },
      ],
      preferredIds: [
        ProjectId.makeUnsafe("project-3"),
        ProjectId.makeUnsafe("project-missing"),
        ProjectId.makeUnsafe("project-1"),
      ],
      getId: (project) => project.id,
    });

    expect(ordered.map((project) => project.id)).toEqual([
      ProjectId.makeUnsafe("project-3"),
      ProjectId.makeUnsafe("project-1"),
      ProjectId.makeUnsafe("project-2"),
    ]);
  });

  it("does not duplicate items when preferred ids repeat", () => {
    const ordered = orderItemsByPreferredIds({
      items: [
        { id: ProjectId.makeUnsafe("project-1"), name: "One" },
        { id: ProjectId.makeUnsafe("project-2"), name: "Two" },
      ],
      preferredIds: [
        ProjectId.makeUnsafe("project-2"),
        ProjectId.makeUnsafe("project-1"),
        ProjectId.makeUnsafe("project-2"),
      ],
      getId: (project) => project.id,
    });

    expect(ordered.map((project) => project.id)).toEqual([
      ProjectId.makeUnsafe("project-2"),
      ProjectId.makeUnsafe("project-1"),
    ]);
  });
});

describe("resolveAdjacentWorkspaceId", () => {
  it("resolves adjacent workspace ids in ordered sidebar traversal", () => {
    const workspaces = [
      WorkspaceId.makeUnsafe("workspace-1"),
      WorkspaceId.makeUnsafe("workspace-2"),
      WorkspaceId.makeUnsafe("workspace-3"),
    ];

    expect(
      resolveAdjacentWorkspaceId({
        workspaceIds: workspaces,
        currentWorkspaceId: workspaces[1] ?? null,
        direction: "previous",
      }),
    ).toBe(workspaces[0]);
    expect(
      resolveAdjacentWorkspaceId({
        workspaceIds: workspaces,
        currentWorkspaceId: workspaces[1] ?? null,
        direction: "next",
      }),
    ).toBe(workspaces[2]);
    expect(
      resolveAdjacentWorkspaceId({
        workspaceIds: workspaces,
        currentWorkspaceId: null,
        direction: "next",
      }),
    ).toBe(workspaces[0]);
    expect(
      resolveAdjacentWorkspaceId({
        workspaceIds: workspaces,
        currentWorkspaceId: null,
        direction: "previous",
      }),
    ).toBe(workspaces[2]);
    expect(
      resolveAdjacentWorkspaceId({
        workspaceIds: workspaces,
        currentWorkspaceId: workspaces[0] ?? null,
        direction: "previous",
      }),
    ).toBeNull();
  });
});

describe("getVisibleSidebarWorkspaceIds", () => {
  it("returns only the rendered visible workspace order across projects", () => {
    expect(
      getVisibleSidebarWorkspaceIds([
        {
          renderedWorkspaceIds: [
            WorkspaceId.makeUnsafe("workspace-12"),
            WorkspaceId.makeUnsafe("workspace-11"),
            WorkspaceId.makeUnsafe("workspace-10"),
          ],
        },
        {
          renderedWorkspaceIds: [
            WorkspaceId.makeUnsafe("workspace-8"),
            WorkspaceId.makeUnsafe("workspace-6"),
          ],
        },
      ]),
    ).toEqual([
      WorkspaceId.makeUnsafe("workspace-12"),
      WorkspaceId.makeUnsafe("workspace-11"),
      WorkspaceId.makeUnsafe("workspace-10"),
      WorkspaceId.makeUnsafe("workspace-8"),
      WorkspaceId.makeUnsafe("workspace-6"),
    ]);
  });

  it("skips workspaces from collapsed projects whose workspace panels are not shown", () => {
    expect(
      getVisibleSidebarWorkspaceIds([
        {
          shouldShowWorkspacePanel: false,
          renderedWorkspaceIds: [
            WorkspaceId.makeUnsafe("workspace-hidden-2"),
            WorkspaceId.makeUnsafe("workspace-hidden-1"),
          ],
        },
        {
          shouldShowWorkspacePanel: true,
          renderedWorkspaceIds: [
            WorkspaceId.makeUnsafe("workspace-12"),
            WorkspaceId.makeUnsafe("workspace-11"),
          ],
        },
      ]),
    ).toEqual([WorkspaceId.makeUnsafe("workspace-12"), WorkspaceId.makeUnsafe("workspace-11")]);
  });
});

describe("isContextMenuPointerDown", () => {
  it("treats secondary-button presses as context menu gestures on all platforms", () => {
    expect(
      isContextMenuPointerDown({
        button: 2,
        ctrlKey: false,
        isMac: false,
      }),
    ).toBe(true);
  });

  it("treats ctrl+primary-click as a context menu gesture on macOS", () => {
    expect(
      isContextMenuPointerDown({
        button: 0,
        ctrlKey: true,
        isMac: true,
      }),
    ).toBe(true);
  });

  it("does not treat ctrl+primary-click as a context menu gesture off macOS", () => {
    expect(
      isContextMenuPointerDown({
        button: 0,
        ctrlKey: true,
        isMac: false,
      }),
    ).toBe(false);
  });
});

describe("resolveWorkspaceStatusPill", () => {
  const baseWorkspace = {
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "plan" as const,
    latestTurn: null,
    lastVisitedAt: undefined,
    session: {
      provider: "codex" as const,
      status: "running" as const,
      createdAt: "2026-03-09T10:00:00.000Z",
      updatedAt: "2026-03-09T10:00:00.000Z",
      orchestrationStatus: "running" as const,
    },
  };

  it("shows pending approval before all other statuses", () => {
    expect(
      resolveWorkspaceStatusPill({
        workspace: {
          ...baseWorkspace,
          hasPendingApprovals: true,
          hasPendingUserInput: true,
        },
      }),
    ).toMatchObject({ label: "Pending Approval", pulse: false });
  });

  it("shows awaiting input when plan mode is blocked on user answers", () => {
    expect(
      resolveWorkspaceStatusPill({
        workspace: {
          ...baseWorkspace,
          hasPendingUserInput: true,
        },
      }),
    ).toMatchObject({ label: "Awaiting Input", pulse: false });
  });

  it("falls back to working when the workspace is actively running without blockers", () => {
    expect(
      resolveWorkspaceStatusPill({
        workspace: baseWorkspace,
      }),
    ).toMatchObject({ label: "Working", pulse: true });
  });

  it("shows plan ready when a settled plan turn has a proposed plan ready for follow-up", () => {
    expect(
      resolveWorkspaceStatusPill({
        workspace: {
          ...baseWorkspace,
          hasActionableProposedPlan: true,
          latestTurn: makeLatestTurn(),
          session: {
            ...baseWorkspace.session,
            status: "ready",
            orchestrationStatus: "ready",
          },
        },
      }),
    ).toMatchObject({ label: "Plan Ready", pulse: false });
  });

  it("does not show plan ready after the proposed plan was implemented elsewhere", () => {
    expect(
      resolveWorkspaceStatusPill({
        workspace: {
          ...baseWorkspace,
          latestTurn: makeLatestTurn(),
          session: {
            ...baseWorkspace.session,
            status: "ready",
            orchestrationStatus: "ready",
          },
        },
      }),
    ).toMatchObject({ label: "Completed", pulse: false });
  });

  it("shows completed when there is an unseen completion and no active blocker", () => {
    expect(
      resolveWorkspaceStatusPill({
        workspace: {
          ...baseWorkspace,
          interactionMode: "default",
          latestTurn: makeLatestTurn(),
          lastVisitedAt: "2026-03-09T10:04:00.000Z",
          session: {
            ...baseWorkspace.session,
            status: "ready",
            orchestrationStatus: "ready",
          },
        },
      }),
    ).toMatchObject({ label: "Completed", pulse: false });
  });
});

describe("resolveWorkspaceRowClassName", () => {
  it("uses the darker selected palette when a workspace is both selected and active", () => {
    const className = resolveWorkspaceRowClassName({ isActive: true, isSelected: true });
    expect(className).toContain("bg-primary/22");
    expect(className).toContain("hover:bg-primary/26");
    expect(className).toContain("dark:bg-primary/30");
    expect(className).not.toContain("bg-accent/85");
  });

  it("uses selected hover colors for selected workspaces", () => {
    const className = resolveWorkspaceRowClassName({ isActive: false, isSelected: true });
    expect(className).toContain("bg-primary/15");
    expect(className).toContain("hover:bg-primary/19");
    expect(className).toContain("dark:bg-primary/22");
    expect(className).not.toContain("hover:bg-accent");
  });

  it("keeps the accent palette for active-only workspaces", () => {
    const className = resolveWorkspaceRowClassName({ isActive: true, isSelected: false });
    expect(className).toContain("bg-accent/85");
    expect(className).toContain("hover:bg-accent");
  });
});

describe("resolveProjectStatusIndicator", () => {
  it("returns null when no workspaces have a notable status", () => {
    expect(resolveProjectStatusIndicator([null, null])).toBeNull();
  });

  it("surfaces the highest-priority actionable state across project workspaces", () => {
    expect(
      resolveProjectStatusIndicator([
        {
          label: "Completed",
          colorClass: "text-emerald-600",
          dotClass: "bg-emerald-500",
          pulse: false,
        },
        {
          label: "Pending Approval",
          colorClass: "text-amber-600",
          dotClass: "bg-amber-500",
          pulse: false,
        },
        {
          label: "Working",
          colorClass: "text-sky-600",
          dotClass: "bg-sky-500",
          pulse: true,
        },
      ]),
    ).toMatchObject({ label: "Pending Approval", dotClass: "bg-amber-500" });
  });

  it("prefers plan-ready over completed when no stronger action is needed", () => {
    expect(
      resolveProjectStatusIndicator([
        {
          label: "Completed",
          colorClass: "text-emerald-600",
          dotClass: "bg-emerald-500",
          pulse: false,
        },
        {
          label: "Plan Ready",
          colorClass: "text-violet-600",
          dotClass: "bg-violet-500",
          pulse: false,
        },
      ]),
    ).toMatchObject({ label: "Plan Ready", dotClass: "bg-violet-500" });
  });
});

describe("getVisibleWorkspacesForProject", () => {
  it("includes the active workspace even when it falls below the folded preview", () => {
    const workspaces = Array.from({ length: 8 }, (_, index) =>
      makeWorkspace({
        id: WorkspaceId.makeUnsafe(`workspace-${index + 1}`),
        title: `Workspace ${index + 1}`,
      }),
    );

    const result = getVisibleWorkspacesForProject({
      workspaces,
      activeWorkspaceId: WorkspaceId.makeUnsafe("workspace-8"),
      isWorkspaceListExpanded: false,
      previewLimit: 6,
    });

    expect(result.hasHiddenWorkspaces).toBe(true);
    expect(result.visibleWorkspaces.map((workspace) => workspace.id)).toEqual([
      WorkspaceId.makeUnsafe("workspace-1"),
      WorkspaceId.makeUnsafe("workspace-2"),
      WorkspaceId.makeUnsafe("workspace-3"),
      WorkspaceId.makeUnsafe("workspace-4"),
      WorkspaceId.makeUnsafe("workspace-5"),
      WorkspaceId.makeUnsafe("workspace-6"),
      WorkspaceId.makeUnsafe("workspace-8"),
    ]);
    expect(result.hiddenWorkspaces.map((workspace) => workspace.id)).toEqual([
      WorkspaceId.makeUnsafe("workspace-7"),
    ]);
  });

  it("returns all workspaces when the list is expanded", () => {
    const workspaces = Array.from({ length: 8 }, (_, index) =>
      makeWorkspace({
        id: WorkspaceId.makeUnsafe(`workspace-${index + 1}`),
      }),
    );

    const result = getVisibleWorkspacesForProject({
      workspaces,
      activeWorkspaceId: WorkspaceId.makeUnsafe("workspace-8"),
      isWorkspaceListExpanded: true,
      previewLimit: 6,
    });

    expect(result.hasHiddenWorkspaces).toBe(true);
    expect(result.visibleWorkspaces.map((workspace) => workspace.id)).toEqual(
      workspaces.map((workspace) => workspace.id),
    );
    expect(result.hiddenWorkspaces).toEqual([]);
  });
});

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: WorkspaceId.makeUnsafe("workspace-1"),
    codexWorkspaceId: null,
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Workspace",
    modelSelection: {
      provider: "codex",
      model: "gpt-5.4",
      ...overrides?.modelSelection,
    },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    messages: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-03-09T10:00:00.000Z",
    archivedAt: null,
    updatedAt: "2026-03-09T10:00:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    turnDiffSummaries: [],
    activities: [],
    ...overrides,
  };
}

describe("sortWorkspacesByCreatedAt", () => {
  it("sorts workspaces by createdAt ascending (oldest first)", () => {
    const sorted = sortWorkspacesByCreatedAt([
      makeWorkspace({
        id: WorkspaceId.makeUnsafe("workspace-1"),
        createdAt: "2026-03-09T10:05:00.000Z",
      }),
      makeWorkspace({
        id: WorkspaceId.makeUnsafe("workspace-2"),
        createdAt: "2026-03-09T10:00:00.000Z",
      }),
    ]);

    expect(sorted.map((workspace) => workspace.id)).toEqual([
      WorkspaceId.makeUnsafe("workspace-2"),
      WorkspaceId.makeUnsafe("workspace-1"),
    ]);
  });

  it("falls back to id ordering when workspaces have no sortable timestamps", () => {
    const sorted = sortWorkspacesByCreatedAt([
      makeWorkspace({
        id: WorkspaceId.makeUnsafe("workspace-2"),
        createdAt: "" as never,
      }),
      makeWorkspace({
        id: WorkspaceId.makeUnsafe("workspace-1"),
        createdAt: "" as never,
      }),
    ]);

    expect(sorted.map((workspace) => workspace.id)).toEqual([
      WorkspaceId.makeUnsafe("workspace-1"),
      WorkspaceId.makeUnsafe("workspace-2"),
    ]);
  });
});

describe("getFallbackWorkspaceIdAfterDelete", () => {
  it("returns the first remaining workspace in the deleted workspace's project by createdAt", () => {
    const fallbackWorkspaceId = getFallbackWorkspaceIdAfterDelete({
      workspaces: [
        makeWorkspace({
          id: WorkspaceId.makeUnsafe("workspace-oldest"),
          projectId: ProjectId.makeUnsafe("project-1"),
          createdAt: "2026-03-09T10:00:00.000Z",
        }),
        makeWorkspace({
          id: WorkspaceId.makeUnsafe("workspace-active"),
          projectId: ProjectId.makeUnsafe("project-1"),
          createdAt: "2026-03-09T10:05:00.000Z",
        }),
        makeWorkspace({
          id: WorkspaceId.makeUnsafe("workspace-newest"),
          projectId: ProjectId.makeUnsafe("project-1"),
          createdAt: "2026-03-09T10:10:00.000Z",
        }),
        makeWorkspace({
          id: WorkspaceId.makeUnsafe("workspace-other-project"),
          projectId: ProjectId.makeUnsafe("project-2"),
          createdAt: "2026-03-09T10:20:00.000Z",
        }),
      ],
      deletedWorkspaceId: WorkspaceId.makeUnsafe("workspace-active"),
    });

    expect(fallbackWorkspaceId).toBe(WorkspaceId.makeUnsafe("workspace-oldest"));
  });

  it("skips other workspaces being deleted in the same action", () => {
    const fallbackWorkspaceId = getFallbackWorkspaceIdAfterDelete({
      workspaces: [
        makeWorkspace({
          id: WorkspaceId.makeUnsafe("workspace-active"),
          projectId: ProjectId.makeUnsafe("project-1"),
          createdAt: "2026-03-09T10:05:00.000Z",
        }),
        makeWorkspace({
          id: WorkspaceId.makeUnsafe("workspace-newest"),
          projectId: ProjectId.makeUnsafe("project-1"),
          createdAt: "2026-03-09T10:10:00.000Z",
        }),
        makeWorkspace({
          id: WorkspaceId.makeUnsafe("workspace-next"),
          projectId: ProjectId.makeUnsafe("project-1"),
          createdAt: "2026-03-09T10:07:00.000Z",
        }),
      ],
      deletedWorkspaceId: WorkspaceId.makeUnsafe("workspace-active"),
      deletedWorkspaceIds: new Set([
        WorkspaceId.makeUnsafe("workspace-active"),
        WorkspaceId.makeUnsafe("workspace-newest"),
      ]),
    });

    expect(fallbackWorkspaceId).toBe(WorkspaceId.makeUnsafe("workspace-next"));
  });
});
