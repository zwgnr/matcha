import type { WorkspaceId } from "@matcha/contracts";
import { FolderIcon, GitForkIcon } from "lucide-react";
import { useCallback } from "react";

import { newCommandId } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { useComposerDraftStore } from "../composerDraftStore";
import { useStore } from "../store";
import {
  EnvMode,
  resolveDraftEnvModeAfterBranchChange,
  resolveEffectiveEnvMode,
} from "./BranchToolbar.logic";
import { BranchToolbarBranchSelector } from "./BranchToolbarBranchSelector";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";

const envModeItems = [
  { value: "local", label: "Local" },
  { value: "worktree", label: "New worktree" },
] as const;

interface BranchToolbarProps {
  workspaceId: WorkspaceId;
  onEnvModeChange: (mode: EnvMode) => void;
  envLocked: boolean;
  onCheckoutPullRequestRequest?: (reference: string) => void;
  onComposerFocusRequest?: () => void;
}

export default function BranchToolbar({
  workspaceId,
  onEnvModeChange,
  envLocked,
  onCheckoutPullRequestRequest,
  onComposerFocusRequest,
}: BranchToolbarProps) {
  const workspaces = useStore((store) => store.workspaces);
  const projects = useStore((store) => store.projects);
  const setWorkspaceBranchAction = useStore((store) => store.setWorkspaceBranch);
  const draftWorkspace = useComposerDraftStore((store) => store.getDraftWorkspace(workspaceId));
  const setDraftWorkspaceContext = useComposerDraftStore((store) => store.setDraftWorkspaceContext);

  const serverWorkspace = workspaces.find((workspace) => workspace.id === workspaceId);
  const activeProjectId = serverWorkspace?.projectId ?? draftWorkspace?.projectId ?? null;
  const activeProject = projects.find((project) => project.id === activeProjectId);
  const activeWorkspaceId = serverWorkspace?.id ?? (draftWorkspace ? workspaceId : undefined);
  const activeWorkspaceBranch = serverWorkspace?.branch ?? draftWorkspace?.branch ?? null;
  const activeWorktreePath = serverWorkspace?.worktreePath ?? draftWorkspace?.worktreePath ?? null;
  const branchCwd = activeWorktreePath ?? activeProject?.cwd ?? null;
  const hasServerWorkspace = serverWorkspace !== undefined;
  const effectiveEnvMode = resolveEffectiveEnvMode({
    activeWorktreePath,
    hasServerWorkspace,
    draftWorkspaceEnvMode: draftWorkspace?.envMode,
  });

  const setWorkspaceBranch = useCallback(
    (branch: string | null, worktreePath: string | null) => {
      if (!activeWorkspaceId) return;
      const api = readNativeApi();
      // If the effective cwd is about to change, stop the running session so the
      // next message creates a new one with the correct cwd.
      if (serverWorkspace?.session && worktreePath !== activeWorktreePath && api) {
        void api.orchestration
          .dispatchCommand({
            type: "workspace.session.stop",
            commandId: newCommandId(),
            workspaceId: activeWorkspaceId,
            createdAt: new Date().toISOString(),
          })
          .catch(() => undefined);
      }
      if (api && hasServerWorkspace) {
        void api.orchestration.dispatchCommand({
          type: "workspace.meta.update",
          commandId: newCommandId(),
          workspaceId: activeWorkspaceId,
          branch,
          worktreePath,
        });
      }
      if (hasServerWorkspace) {
        setWorkspaceBranchAction(activeWorkspaceId, branch, worktreePath);
        return;
      }
      const nextDraftEnvMode = resolveDraftEnvModeAfterBranchChange({
        nextWorktreePath: worktreePath,
        currentWorktreePath: activeWorktreePath,
        effectiveEnvMode,
      });
      setDraftWorkspaceContext(workspaceId, {
        branch,
        worktreePath,
        envMode: nextDraftEnvMode,
      });
    },
    [
      activeWorkspaceId,
      serverWorkspace?.session,
      activeWorktreePath,
      hasServerWorkspace,
      setWorkspaceBranchAction,
      setDraftWorkspaceContext,
      workspaceId,
      effectiveEnvMode,
    ],
  );

  if (!activeWorkspaceId || !activeProject) return null;

  return (
    <div className="mx-auto flex w-full max-w-3xl items-center justify-between px-5 pb-3 pt-1">
      {envLocked || activeWorktreePath ? (
        <span className="inline-flex items-center gap-1 border border-transparent px-[calc(--spacing(3)-1px)] text-sm font-medium text-muted-foreground/70 sm:text-xs">
          {activeWorktreePath ? (
            <>
              <GitForkIcon className="size-3" />
              Worktree
            </>
          ) : (
            <>
              <FolderIcon className="size-3" />
              Local
            </>
          )}
        </span>
      ) : (
        <Select
          value={effectiveEnvMode}
          onValueChange={(value) => onEnvModeChange(value as EnvMode)}
          items={envModeItems}
        >
          <SelectTrigger variant="ghost" size="xs" className="font-medium">
            {effectiveEnvMode === "worktree" ? (
              <GitForkIcon className="size-3" />
            ) : (
              <FolderIcon className="size-3" />
            )}
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="local">
              <span className="inline-flex items-center gap-1.5">
                <FolderIcon className="size-3" />
                Local
              </span>
            </SelectItem>
            <SelectItem value="worktree">
              <span className="inline-flex items-center gap-1.5">
                <GitForkIcon className="size-3" />
                New worktree
              </span>
            </SelectItem>
          </SelectPopup>
        </Select>
      )}

      <BranchToolbarBranchSelector
        activeProjectCwd={activeProject.cwd}
        activeWorkspaceBranch={activeWorkspaceBranch}
        activeWorktreePath={activeWorktreePath}
        branchCwd={branchCwd}
        effectiveEnvMode={effectiveEnvMode}
        envLocked={envLocked}
        onSetWorkspaceBranch={setWorkspaceBranch}
        {...(onCheckoutPullRequestRequest ? { onCheckoutPullRequestRequest } : {})}
        {...(onComposerFocusRequest ? { onComposerFocusRequest } : {})}
      />
    </div>
  );
}
