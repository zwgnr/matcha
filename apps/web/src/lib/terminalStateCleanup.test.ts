import { WorkspaceId } from "@matcha/contracts";
import { describe, expect, it } from "vitest";

import { collectActiveTerminalWorkspaceIds } from "./terminalStateCleanup";

const workspaceId = (id: string): WorkspaceId => WorkspaceId.makeUnsafe(id);

describe("collectActiveTerminalWorkspaceIds", () => {
  it("retains non-deleted server workspaces", () => {
    const activeWorkspaceIds = collectActiveTerminalWorkspaceIds({
      snapshotWorkspaces: [
        { id: workspaceId("server-1"), deletedAt: null, archivedAt: null },
        { id: workspaceId("server-2"), deletedAt: null, archivedAt: null },
      ],
      draftWorkspaceIds: [],
    });

    expect(activeWorkspaceIds).toEqual(new Set([workspaceId("server-1"), workspaceId("server-2")]));
  });

  it("ignores deleted and archived server workspaces and keeps local draft workspaces", () => {
    const activeWorkspaceIds = collectActiveTerminalWorkspaceIds({
      snapshotWorkspaces: [
        { id: workspaceId("server-active"), deletedAt: null, archivedAt: null },
        {
          id: workspaceId("server-deleted"),
          deletedAt: "2026-03-05T08:00:00.000Z",
          archivedAt: null,
        },
        {
          id: workspaceId("server-archived"),
          deletedAt: null,
          archivedAt: "2026-03-05T09:00:00.000Z",
        },
      ],
      draftWorkspaceIds: [workspaceId("local-draft")],
    });

    expect(activeWorkspaceIds).toEqual(
      new Set([workspaceId("server-active"), workspaceId("local-draft")]),
    );
  });

  it("does not keep draft-linked terminal state for archived server workspaces", () => {
    const archivedWorkspaceId = workspaceId("server-archived");

    const activeWorkspaceIds = collectActiveTerminalWorkspaceIds({
      snapshotWorkspaces: [
        {
          id: archivedWorkspaceId,
          deletedAt: null,
          archivedAt: "2026-03-05T09:00:00.000Z",
        },
      ],
      draftWorkspaceIds: [archivedWorkspaceId, workspaceId("local-draft")],
    });

    expect(activeWorkspaceIds).toEqual(new Set([workspaceId("local-draft")]));
  });
});
