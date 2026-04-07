import { Encoding } from "effect";
import { CheckpointRef, ProjectId, type WorkspaceId } from "@matcha/contracts";

export const CHECKPOINT_REFS_PREFIX = "refs/t3/checkpoints";

export function checkpointRefForWorkspaceTurn(
  workspaceId: WorkspaceId,
  turnCount: number,
): CheckpointRef {
  return CheckpointRef.makeUnsafe(
    `${CHECKPOINT_REFS_PREFIX}/${Encoding.encodeBase64Url(workspaceId)}/turn/${turnCount}`,
  );
}

export function resolveWorkspaceWorkspaceCwd(input: {
  readonly workspace: {
    readonly projectId: ProjectId;
    readonly worktreePath: string | null;
  };
  readonly projects: ReadonlyArray<{
    readonly id: ProjectId;
    readonly workspaceRoot: string;
  }>;
}): string | undefined {
  const worktreeCwd = input.workspace.worktreePath ?? undefined;
  if (worktreeCwd) {
    return worktreeCwd;
  }

  return input.projects.find((project) => project.id === input.workspace.projectId)?.workspaceRoot;
}
