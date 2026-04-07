import { useMemo } from "react";
import { inferCheckpointTurnCountByTurnId } from "../session-logic";
import type { Workspace } from "../types";

export function useTurnDiffSummaries(activeWorkspace: Workspace | undefined) {
  const turnDiffSummaries = useMemo(() => {
    if (!activeWorkspace) {
      return [];
    }
    return activeWorkspace.turnDiffSummaries;
  }, [activeWorkspace]);

  const inferredCheckpointTurnCountByTurnId = useMemo(
    () => inferCheckpointTurnCountByTurnId(turnDiffSummaries),
    [turnDiffSummaries],
  );

  return { turnDiffSummaries, inferredCheckpointTurnCountByTurnId };
}
