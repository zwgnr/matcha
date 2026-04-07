import { ProjectId, WorkspaceId, TurnId } from "@matcha/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store";

import {
  MAX_HIDDEN_MOUNTED_TERMINAL_WORKSPACES,
  buildExpiredTerminalContextToastCopy,
  createLocalDispatchSnapshot,
  deriveComposerSendState,
  hasServerAcknowledgedLocalDispatch,
  reconcileMountedTerminalWorkspaceIds,
  waitForStartedServerWorkspace,
} from "./ChatView.logic";

describe("deriveComposerSendState", () => {
  it("treats expired terminal pills as non-sendable content", () => {
    const state = deriveComposerSendState({
      prompt: "\uFFFC",
      imageCount: 0,
      terminalContexts: [
        {
          id: "ctx-expired",
          workspaceId: WorkspaceId.makeUnsafe("workspace-1"),
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 4,
          lineEnd: 4,
          text: "",
          createdAt: "2026-03-17T12:52:29.000Z",
        },
      ],
    });

    expect(state.trimmedPrompt).toBe("");
    expect(state.sendableTerminalContexts).toEqual([]);
    expect(state.expiredTerminalContextCount).toBe(1);
    expect(state.hasSendableContent).toBe(false);
  });

  it("keeps text sendable while excluding expired terminal pills", () => {
    const state = deriveComposerSendState({
      prompt: `yoo \uFFFC waddup`,
      imageCount: 0,
      terminalContexts: [
        {
          id: "ctx-expired",
          workspaceId: WorkspaceId.makeUnsafe("workspace-1"),
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 4,
          lineEnd: 4,
          text: "",
          createdAt: "2026-03-17T12:52:29.000Z",
        },
      ],
    });

    expect(state.trimmedPrompt).toBe("yoo  waddup");
    expect(state.expiredTerminalContextCount).toBe(1);
    expect(state.hasSendableContent).toBe(true);
  });
});

describe("buildExpiredTerminalContextToastCopy", () => {
  it("formats clear empty-state guidance", () => {
    expect(buildExpiredTerminalContextToastCopy(1, "empty")).toEqual({
      title: "Expired terminal context won't be sent",
      description: "Remove it or re-add it to include terminal output.",
    });
  });

  it("formats omission guidance for sent messages", () => {
    expect(buildExpiredTerminalContextToastCopy(2, "omitted")).toEqual({
      title: "Expired terminal contexts omitted from message",
      description: "Re-add it if you want that terminal output included.",
    });
  });
});

describe("reconcileMountedTerminalWorkspaceIds", () => {
  it("keeps previously mounted open workspaces and adds the active open workspace", () => {
    expect(
      reconcileMountedTerminalWorkspaceIds({
        currentWorkspaceIds: [
          WorkspaceId.makeUnsafe("workspace-hidden"),
          WorkspaceId.makeUnsafe("workspace-stale"),
        ],
        openWorkspaceIds: [
          WorkspaceId.makeUnsafe("workspace-hidden"),
          WorkspaceId.makeUnsafe("workspace-active"),
        ],
        activeWorkspaceId: WorkspaceId.makeUnsafe("workspace-active"),
        activeWorkspaceTerminalOpen: true,
      }),
    ).toEqual([
      WorkspaceId.makeUnsafe("workspace-hidden"),
      WorkspaceId.makeUnsafe("workspace-active"),
    ]);
  });

  it("drops mounted workspaces once their terminal drawer is no longer open", () => {
    expect(
      reconcileMountedTerminalWorkspaceIds({
        currentWorkspaceIds: [WorkspaceId.makeUnsafe("workspace-closed")],
        openWorkspaceIds: [],
        activeWorkspaceId: WorkspaceId.makeUnsafe("workspace-closed"),
        activeWorkspaceTerminalOpen: false,
      }),
    ).toEqual([]);
  });

  it("keeps only the most recently active hidden terminal workspaces", () => {
    expect(
      reconcileMountedTerminalWorkspaceIds({
        currentWorkspaceIds: [
          WorkspaceId.makeUnsafe("workspace-1"),
          WorkspaceId.makeUnsafe("workspace-2"),
          WorkspaceId.makeUnsafe("workspace-3"),
        ],
        openWorkspaceIds: [
          WorkspaceId.makeUnsafe("workspace-1"),
          WorkspaceId.makeUnsafe("workspace-2"),
          WorkspaceId.makeUnsafe("workspace-3"),
          WorkspaceId.makeUnsafe("workspace-4"),
        ],
        activeWorkspaceId: WorkspaceId.makeUnsafe("workspace-4"),
        activeWorkspaceTerminalOpen: true,
        maxHiddenWorkspaceCount: 2,
      }),
    ).toEqual([
      WorkspaceId.makeUnsafe("workspace-2"),
      WorkspaceId.makeUnsafe("workspace-3"),
      WorkspaceId.makeUnsafe("workspace-4"),
    ]);
  });

  it("moves the active workspace to the end so it is treated as most recently used", () => {
    expect(
      reconcileMountedTerminalWorkspaceIds({
        currentWorkspaceIds: [
          WorkspaceId.makeUnsafe("workspace-a"),
          WorkspaceId.makeUnsafe("workspace-b"),
          WorkspaceId.makeUnsafe("workspace-c"),
        ],
        openWorkspaceIds: [
          WorkspaceId.makeUnsafe("workspace-a"),
          WorkspaceId.makeUnsafe("workspace-b"),
          WorkspaceId.makeUnsafe("workspace-c"),
        ],
        activeWorkspaceId: WorkspaceId.makeUnsafe("workspace-a"),
        activeWorkspaceTerminalOpen: true,
        maxHiddenWorkspaceCount: 2,
      }),
    ).toEqual([
      WorkspaceId.makeUnsafe("workspace-b"),
      WorkspaceId.makeUnsafe("workspace-c"),
      WorkspaceId.makeUnsafe("workspace-a"),
    ]);
  });

  it("defaults to the hidden mounted terminal cap", () => {
    const currentWorkspaceIds = Array.from(
      { length: MAX_HIDDEN_MOUNTED_TERMINAL_WORKSPACES + 2 },
      (_, index) => WorkspaceId.makeUnsafe(`workspace-${index + 1}`),
    );

    expect(
      reconcileMountedTerminalWorkspaceIds({
        currentWorkspaceIds,
        openWorkspaceIds: currentWorkspaceIds,
        activeWorkspaceId: null,
        activeWorkspaceTerminalOpen: false,
      }),
    ).toEqual(currentWorkspaceIds.slice(-MAX_HIDDEN_MOUNTED_TERMINAL_WORKSPACES));
  });
});

const makeWorkspace = (input?: {
  id?: WorkspaceId;
  latestTurn?: {
    turnId: TurnId;
    state: "running" | "completed";
    requestedAt: string;
    startedAt: string | null;
    completedAt: string | null;
  } | null;
}) => ({
  id: input?.id ?? WorkspaceId.makeUnsafe("workspace-1"),
  codexWorkspaceId: null,
  projectId: ProjectId.makeUnsafe("project-1"),
  title: "Workspace",
  modelSelection: { provider: "codex" as const, model: "gpt-5.4" },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  session: null,
  messages: [],
  proposedPlans: [],
  error: null,
  createdAt: "2026-03-29T00:00:00.000Z",
  archivedAt: null,
  updatedAt: "2026-03-29T00:00:00.000Z",
  latestTurn: input?.latestTurn
    ? {
        ...input.latestTurn,
        assistantMessageId: null,
      }
    : null,
  branch: null,
  worktreePath: null,
  turnDiffSummaries: [],
  activities: [],
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  useStore.setState((state) => ({
    ...state,
    projects: [],
    workspaces: [],
    bootstrapComplete: true,
  }));
});

describe("waitForStartedServerWorkspace", () => {
  it("resolves immediately when the workspace is already started", async () => {
    const workspaceId = WorkspaceId.makeUnsafe("workspace-started");
    useStore.setState((state) => ({
      ...state,
      workspaces: [
        makeWorkspace({
          id: workspaceId,
          latestTurn: {
            turnId: TurnId.makeUnsafe("turn-started"),
            state: "running",
            requestedAt: "2026-03-29T00:00:01.000Z",
            startedAt: "2026-03-29T00:00:01.000Z",
            completedAt: null,
          },
        }),
      ],
    }));

    await expect(waitForStartedServerWorkspace(workspaceId)).resolves.toBe(true);
  });

  it("waits for the workspace to start via subscription updates", async () => {
    const workspaceId = WorkspaceId.makeUnsafe("workspace-wait");
    useStore.setState((state) => ({
      ...state,
      workspaces: [makeWorkspace({ id: workspaceId })],
    }));

    const promise = waitForStartedServerWorkspace(workspaceId, 500);

    useStore.setState((state) => ({
      ...state,
      workspaces: [
        makeWorkspace({
          id: workspaceId,
          latestTurn: {
            turnId: TurnId.makeUnsafe("turn-started"),
            state: "running",
            requestedAt: "2026-03-29T00:00:01.000Z",
            startedAt: "2026-03-29T00:00:01.000Z",
            completedAt: null,
          },
        }),
      ],
    }));

    await expect(promise).resolves.toBe(true);
  });

  it("handles the workspace starting between the initial read and subscription setup", async () => {
    const workspaceId = WorkspaceId.makeUnsafe("workspace-race");
    useStore.setState((state) => ({
      ...state,
      workspaces: [makeWorkspace({ id: workspaceId })],
    }));

    const originalSubscribe = useStore.subscribe.bind(useStore);
    let raced = false;
    vi.spyOn(useStore, "subscribe").mockImplementation((listener) => {
      if (!raced) {
        raced = true;
        useStore.setState((state) => ({
          ...state,
          workspaces: [
            makeWorkspace({
              id: workspaceId,
              latestTurn: {
                turnId: TurnId.makeUnsafe("turn-race"),
                state: "running",
                requestedAt: "2026-03-29T00:00:01.000Z",
                startedAt: "2026-03-29T00:00:01.000Z",
                completedAt: null,
              },
            }),
          ],
        }));
      }
      return originalSubscribe(listener);
    });

    await expect(waitForStartedServerWorkspace(workspaceId, 500)).resolves.toBe(true);
  });

  it("returns false after the timeout when the workspace never starts", async () => {
    vi.useFakeTimers();

    const workspaceId = WorkspaceId.makeUnsafe("workspace-timeout");
    useStore.setState((state) => ({
      ...state,
      workspaces: [makeWorkspace({ id: workspaceId })],
    }));
    const promise = waitForStartedServerWorkspace(workspaceId, 500);

    await vi.advanceTimersByTimeAsync(500);

    await expect(promise).resolves.toBe(false);
  });
});

describe("hasServerAcknowledgedLocalDispatch", () => {
  const projectId = ProjectId.makeUnsafe("project-1");
  const previousLatestTurn = {
    turnId: TurnId.makeUnsafe("turn-1"),
    state: "completed" as const,
    requestedAt: "2026-03-29T00:00:00.000Z",
    startedAt: "2026-03-29T00:00:01.000Z",
    completedAt: "2026-03-29T00:00:10.000Z",
    assistantMessageId: null,
  };

  const previousSession = {
    provider: "codex" as const,
    status: "ready" as const,
    createdAt: "2026-03-29T00:00:00.000Z",
    updatedAt: "2026-03-29T00:00:10.000Z",
    orchestrationStatus: "idle" as const,
  };

  it("does not clear local dispatch before server state changes", () => {
    const localDispatch = createLocalDispatchSnapshot({
      id: WorkspaceId.makeUnsafe("workspace-1"),
      codexWorkspaceId: null,
      projectId,
      title: "Workspace",
      modelSelection: { provider: "codex", model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      session: previousSession,
      messages: [],
      proposedPlans: [],
      error: null,
      createdAt: "2026-03-29T00:00:00.000Z",
      archivedAt: null,
      updatedAt: "2026-03-29T00:00:10.000Z",
      latestTurn: previousLatestTurn,
      branch: null,
      worktreePath: null,
      turnDiffSummaries: [],
      activities: [],
    });

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestTurn: previousLatestTurn,
        session: previousSession,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        workspaceError: null,
      }),
    ).toBe(false);
  });

  it("clears local dispatch when a new turn is already settled", () => {
    const localDispatch = createLocalDispatchSnapshot({
      id: WorkspaceId.makeUnsafe("workspace-1"),
      codexWorkspaceId: null,
      projectId,
      title: "Workspace",
      modelSelection: { provider: "codex", model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      session: previousSession,
      messages: [],
      proposedPlans: [],
      error: null,
      createdAt: "2026-03-29T00:00:00.000Z",
      archivedAt: null,
      updatedAt: "2026-03-29T00:00:10.000Z",
      latestTurn: previousLatestTurn,
      branch: null,
      worktreePath: null,
      turnDiffSummaries: [],
      activities: [],
    });

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestTurn: {
          ...previousLatestTurn,
          turnId: TurnId.makeUnsafe("turn-2"),
          requestedAt: "2026-03-29T00:01:00.000Z",
          startedAt: "2026-03-29T00:01:01.000Z",
          completedAt: "2026-03-29T00:01:30.000Z",
        },
        session: {
          ...previousSession,
          updatedAt: "2026-03-29T00:01:30.000Z",
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        workspaceError: null,
      }),
    ).toBe(true);
  });

  it("clears local dispatch when the session changes without an observed running phase", () => {
    const localDispatch = createLocalDispatchSnapshot({
      id: WorkspaceId.makeUnsafe("workspace-1"),
      codexWorkspaceId: null,
      projectId,
      title: "Workspace",
      modelSelection: { provider: "codex", model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      session: previousSession,
      messages: [],
      proposedPlans: [],
      error: null,
      createdAt: "2026-03-29T00:00:00.000Z",
      archivedAt: null,
      updatedAt: "2026-03-29T00:00:10.000Z",
      latestTurn: previousLatestTurn,
      branch: null,
      worktreePath: null,
      turnDiffSummaries: [],
      activities: [],
    });

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestTurn: previousLatestTurn,
        session: {
          ...previousSession,
          updatedAt: "2026-03-29T00:00:11.000Z",
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        workspaceError: null,
      }),
    ).toBe(true);
  });
});
