import { describe, expect, it } from "vitest";
import {
  MessageId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  WorkspaceId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@matcha/contracts";
import { Effect } from "effect";

import {
  findWorkspaceById,
  listWorkspacesByProjectId,
  requireNonNegativeInteger,
  requireWorkspace,
  requireWorkspaceAbsent,
} from "./commandInvariants.ts";

const now = new Date().toISOString();

const readModel: OrchestrationReadModel = {
  snapshotSequence: 2,
  updatedAt: now,
  projects: [
    {
      id: ProjectId.makeUnsafe("project-a"),
      title: "Project A",
      workspaceRoot: "/tmp/project-a",
      defaultModelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      scripts: [],
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
    {
      id: ProjectId.makeUnsafe("project-b"),
      title: "Project B",
      workspaceRoot: "/tmp/project-b",
      defaultModelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      scripts: [],
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
  ],
  workspaces: [
    {
      id: WorkspaceId.makeUnsafe("workspace-1"),
      projectId: ProjectId.makeUnsafe("project-a"),
      title: "Workspace A",
      modelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      latestTurn: null,
      messages: [],
      session: null,
      activities: [],
      proposedPlans: [],
      checkpoints: [],
      deletedAt: null,
    },
    {
      id: WorkspaceId.makeUnsafe("workspace-2"),
      projectId: ProjectId.makeUnsafe("project-b"),
      title: "Workspace B",
      modelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      latestTurn: null,
      messages: [],
      session: null,
      activities: [],
      proposedPlans: [],
      checkpoints: [],
      deletedAt: null,
    },
  ],
};

const messageSendCommand: OrchestrationCommand = {
  type: "workspace.turn.start",
  commandId: CommandId.makeUnsafe("cmd-1"),
  workspaceId: WorkspaceId.makeUnsafe("workspace-1"),
  message: {
    messageId: MessageId.makeUnsafe("msg-1"),
    role: "user",
    text: "hello",
    attachments: [],
  },
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  runtimeMode: "approval-required",
  createdAt: now,
};

describe("commandInvariants", () => {
  it("finds workspaces by id and project", () => {
    expect(findWorkspaceById(readModel, WorkspaceId.makeUnsafe("workspace-1"))?.projectId).toBe(
      "project-a",
    );
    expect(findWorkspaceById(readModel, WorkspaceId.makeUnsafe("missing"))).toBeUndefined();
    expect(
      listWorkspacesByProjectId(readModel, ProjectId.makeUnsafe("project-b")).map(
        (workspace) => workspace.id,
      ),
    ).toEqual([WorkspaceId.makeUnsafe("workspace-2")]);
  });

  it("requires existing workspace", async () => {
    const workspace = await Effect.runPromise(
      requireWorkspace({
        readModel,
        command: messageSendCommand,
        workspaceId: WorkspaceId.makeUnsafe("workspace-1"),
      }),
    );
    expect(workspace.id).toBe(WorkspaceId.makeUnsafe("workspace-1"));

    await expect(
      Effect.runPromise(
        requireWorkspace({
          readModel,
          command: messageSendCommand,
          workspaceId: WorkspaceId.makeUnsafe("missing"),
        }),
      ),
    ).rejects.toThrow("does not exist");
  });

  it("requires missing workspace for create flows", async () => {
    await Effect.runPromise(
      requireWorkspaceAbsent({
        readModel,
        command: {
          type: "workspace.create",
          commandId: CommandId.makeUnsafe("cmd-2"),
          workspaceId: WorkspaceId.makeUnsafe("workspace-3"),
          projectId: ProjectId.makeUnsafe("project-a"),
          title: "new",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
        },
        workspaceId: WorkspaceId.makeUnsafe("workspace-3"),
      }),
    );

    await expect(
      Effect.runPromise(
        requireWorkspaceAbsent({
          readModel,
          command: {
            type: "workspace.create",
            commandId: CommandId.makeUnsafe("cmd-3"),
            workspaceId: WorkspaceId.makeUnsafe("workspace-1"),
            projectId: ProjectId.makeUnsafe("project-a"),
            title: "dup",
            modelSelection: {
              provider: "codex",
              model: "gpt-5-codex",
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: now,
          },
          workspaceId: WorkspaceId.makeUnsafe("workspace-1"),
        }),
      ),
    ).rejects.toThrow("already exists");
  });

  it("requires non-negative integers", async () => {
    await Effect.runPromise(
      requireNonNegativeInteger({
        commandType: "workspace.checkpoint.revert",
        field: "turnCount",
        value: 0,
      }),
    );

    await expect(
      Effect.runPromise(
        requireNonNegativeInteger({
          commandType: "workspace.checkpoint.revert",
          field: "turnCount",
          value: -1,
        }),
      ),
    ).rejects.toThrow("greater than or equal to 0");
  });
});
