import { sanitizeBranchFragment } from "@matcha/shared/git";

import { randomUUID } from "./lib/utils";

const WORKTREE_BRANCH_PREFIX = "matcha";

export function buildTemporaryWorktreeBranchName(): string {
  // Keep the 8-hex suffix shape for backend temporary-branch detection.
  const token = randomUUID().slice(0, 8).toLowerCase();
  return `${WORKTREE_BRANCH_PREFIX}/${token}`;
}

export function buildNamedWorktreeBranchName(raw: string): string {
  const normalized = sanitizeBranchFragment(raw);
  const withoutPrefix = normalized.startsWith(`${WORKTREE_BRANCH_PREFIX}/`)
    ? normalized.slice(`${WORKTREE_BRANCH_PREFIX}/`.length)
    : normalized;
  const safeFragment = withoutPrefix.length > 0 ? withoutPrefix : "update";

  return `${WORKTREE_BRANCH_PREFIX}/${safeFragment}`;
}

export function buildNewWorkspaceWorktreeBranchName(workspaceName: string): string {
  const trimmedName = workspaceName.trim();
  return trimmedName.length > 0
    ? buildNamedWorktreeBranchName(trimmedName)
    : buildTemporaryWorktreeBranchName();
}
