import type { Workspace } from "./types";

function normalizeWorktreePath(path: string | null): string | null {
  const trimmed = path?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed;
}

export function getOrphanedWorktreePathForWorkspace(
  workspaces: readonly Workspace[],
  workspaceId: Workspace["id"],
): string | null {
  const targetWorkspace = workspaces.find((workspace) => workspace.id === workspaceId);
  if (!targetWorkspace) {
    return null;
  }

  const targetWorktreePath = normalizeWorktreePath(targetWorkspace.worktreePath);
  if (!targetWorktreePath) {
    return null;
  }

  const isShared = workspaces.some((workspace) => {
    if (workspace.id === workspaceId) {
      return false;
    }
    return normalizeWorktreePath(workspace.worktreePath) === targetWorktreePath;
  });

  return isShared ? null : targetWorktreePath;
}

export function formatWorktreePathForDisplay(worktreePath: string): string {
  const trimmed = worktreePath.trim();
  if (!trimmed) {
    return worktreePath;
  }

  const normalized = trimmed.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/");
  const lastPart = parts[parts.length - 1]?.trim() ?? "";
  return lastPart.length > 0 ? lastPart : trimmed;
}
