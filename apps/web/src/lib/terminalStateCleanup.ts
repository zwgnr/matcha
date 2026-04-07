import type { WorkspaceId } from "@matcha/contracts";

interface TerminalRetentionWorkspace {
  id: WorkspaceId;
  deletedAt: string | null;
  archivedAt: string | null;
}

interface CollectActiveTerminalWorkspaceIdsInput {
  snapshotWorkspaces: readonly TerminalRetentionWorkspace[];
  draftWorkspaceIds: Iterable<WorkspaceId>;
}

export function collectActiveTerminalWorkspaceIds(
  input: CollectActiveTerminalWorkspaceIdsInput,
): Set<WorkspaceId> {
  const activeWorkspaceIds = new Set<WorkspaceId>();
  const snapshotWorkspaceById = new Map(
    input.snapshotWorkspaces.map((workspace) => [workspace.id, workspace]),
  );
  for (const workspace of input.snapshotWorkspaces) {
    if (workspace.deletedAt !== null) continue;
    if (workspace.archivedAt !== null) continue;
    activeWorkspaceIds.add(workspace.id);
  }
  for (const draftWorkspaceId of input.draftWorkspaceIds) {
    const snapshotWorkspace = snapshotWorkspaceById.get(draftWorkspaceId);
    if (
      snapshotWorkspace &&
      (snapshotWorkspace.deletedAt !== null || snapshotWorkspace.archivedAt !== null)
    ) {
      continue;
    }
    activeWorkspaceIds.add(draftWorkspaceId);
  }
  return activeWorkspaceIds;
}
