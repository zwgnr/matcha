import type { GitStatusResult } from "@matcha/contracts";
import type { TurnDiffFileChange } from "../types";

export function resolveWorkingChanges(
  gitStatus: GitStatusResult | null | undefined,
): TurnDiffFileChange[] {
  if (gitStatus?.hasWorkingTreeChanges !== true) {
    return [];
  }

  return gitStatus.workingTree.files.map((file) => ({
    path: file.path,
    additions: file.insertions,
    deletions: file.deletions,
  }));
}
