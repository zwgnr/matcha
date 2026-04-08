import { ProjectId, WorkspaceId } from "@matcha/contracts";
import { describe, expect, it } from "vitest";

import {
  clearWorkspaceUi,
  markWorkspaceUnread,
  reorderProjects,
  setProjectExpanded,
  syncProjects,
  syncWorkspaces,
  type UiState,
} from "./uiStateStore";

function makeUiState(overrides: Partial<UiState> = {}): UiState {
  return {
    projectExpandedById: {},
    projectOrder: [],
    workspaceLastVisitedAtById: {},
    workspaceOrderByProjectId: {},
    ...overrides,
  };
}

describe("uiStateStore pure functions", () => {
  it("markWorkspaceUnread moves lastVisitedAt before completion for a completed workspace", () => {
    const workspaceId = WorkspaceId.makeUnsafe("workspace-1");
    const latestTurnCompletedAt = "2026-02-25T12:30:00.000Z";
    const initialState = makeUiState({
      workspaceLastVisitedAtById: {
        [workspaceId]: "2026-02-25T12:35:00.000Z",
      },
    });

    const next = markWorkspaceUnread(initialState, workspaceId, latestTurnCompletedAt);

    expect(next.workspaceLastVisitedAtById[workspaceId]).toBe("2026-02-25T12:29:59.999Z");
  });

  it("markWorkspaceUnread does not change a workspace without a completed turn", () => {
    const workspaceId = WorkspaceId.makeUnsafe("workspace-1");
    const initialState = makeUiState({
      workspaceLastVisitedAtById: {
        [workspaceId]: "2026-02-25T12:35:00.000Z",
      },
    });

    const next = markWorkspaceUnread(initialState, workspaceId, null);

    expect(next).toBe(initialState);
  });

  it("reorderProjects moves a project to a target index", () => {
    const project1 = ProjectId.makeUnsafe("project-1");
    const project2 = ProjectId.makeUnsafe("project-2");
    const project3 = ProjectId.makeUnsafe("project-3");
    const initialState = makeUiState({
      projectOrder: [project1, project2, project3],
    });

    const next = reorderProjects(initialState, project1, project3);

    expect(next.projectOrder).toEqual([project2, project3, project1]);
  });

  it("syncProjects preserves current project order during snapshot recovery", () => {
    const project1 = ProjectId.makeUnsafe("project-1");
    const project2 = ProjectId.makeUnsafe("project-2");
    const project3 = ProjectId.makeUnsafe("project-3");
    const initialState = makeUiState({
      projectExpandedById: {
        [project1]: true,
        [project2]: false,
      },
      projectOrder: [project2, project1],
    });

    const next = syncProjects(initialState, [
      { id: project1, cwd: "/tmp/project-1" },
      { id: project2, cwd: "/tmp/project-2" },
      { id: project3, cwd: "/tmp/project-3" },
    ]);

    expect(next.projectOrder).toEqual([project2, project1, project3]);
    expect(next.projectExpandedById[project2]).toBe(false);
  });

  it("syncProjects preserves manual order when a project is recreated with the same cwd", () => {
    const oldProject1 = ProjectId.makeUnsafe("project-1");
    const oldProject2 = ProjectId.makeUnsafe("project-2");
    const recreatedProject2 = ProjectId.makeUnsafe("project-2b");
    const initialState = syncProjects(
      makeUiState({
        projectExpandedById: {
          [oldProject1]: true,
          [oldProject2]: false,
        },
        projectOrder: [oldProject2, oldProject1],
      }),
      [
        { id: oldProject1, cwd: "/tmp/project-1" },
        { id: oldProject2, cwd: "/tmp/project-2" },
      ],
    );

    const next = syncProjects(initialState, [
      { id: oldProject1, cwd: "/tmp/project-1" },
      { id: recreatedProject2, cwd: "/tmp/project-2" },
    ]);

    expect(next.projectOrder).toEqual([recreatedProject2, oldProject1]);
    expect(next.projectExpandedById[recreatedProject2]).toBe(false);
  });

  it("syncProjects returns a new state when only project cwd changes", () => {
    const project1 = ProjectId.makeUnsafe("project-1");
    const initialState = syncProjects(
      makeUiState({
        projectExpandedById: {
          [project1]: false,
        },
        projectOrder: [project1],
      }),
      [{ id: project1, cwd: "/tmp/project-1" }],
    );

    const next = syncProjects(initialState, [{ id: project1, cwd: "/tmp/project-1-renamed" }]);

    expect(next).not.toBe(initialState);
    expect(next.projectOrder).toEqual([project1]);
    expect(next.projectExpandedById[project1]).toBe(false);
  });

  it("syncWorkspaces prunes missing workspace UI state", () => {
    const workspace1 = WorkspaceId.makeUnsafe("workspace-1");
    const workspace2 = WorkspaceId.makeUnsafe("workspace-2");
    const initialState = makeUiState({
      workspaceLastVisitedAtById: {
        [workspace1]: "2026-02-25T12:35:00.000Z",
        [workspace2]: "2026-02-25T12:36:00.000Z",
      },
    });

    const next = syncWorkspaces(initialState, [{ id: workspace1 }]);

    expect(next.workspaceLastVisitedAtById).toEqual({
      [workspace1]: "2026-02-25T12:35:00.000Z",
    });
  });

  it("syncWorkspaces seeds visit state for unseen snapshot workspaces", () => {
    const workspace1 = WorkspaceId.makeUnsafe("workspace-1");
    const initialState = makeUiState();

    const next = syncWorkspaces(initialState, [
      {
        id: workspace1,
        seedVisitedAt: "2026-02-25T12:35:00.000Z",
      },
    ]);

    expect(next.workspaceLastVisitedAtById).toEqual({
      [workspace1]: "2026-02-25T12:35:00.000Z",
    });
  });

  it("setProjectExpanded updates expansion without touching order", () => {
    const project1 = ProjectId.makeUnsafe("project-1");
    const initialState = makeUiState({
      projectExpandedById: {
        [project1]: true,
      },
      projectOrder: [project1],
    });

    const next = setProjectExpanded(initialState, project1, false);

    expect(next.projectExpandedById[project1]).toBe(false);
    expect(next.projectOrder).toEqual([project1]);
  });

  it("clearWorkspaceUi removes visit state for deleted workspaces", () => {
    const workspace1 = WorkspaceId.makeUnsafe("workspace-1");
    const initialState = makeUiState({
      workspaceLastVisitedAtById: {
        [workspace1]: "2026-02-25T12:35:00.000Z",
      },
    });

    const next = clearWorkspaceUi(initialState, workspace1);

    expect(next.workspaceLastVisitedAtById).toEqual({});
  });
});
