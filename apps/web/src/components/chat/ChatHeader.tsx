import {
  type EditorId,
  type ProjectId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
  type WorkspaceId,
} from "@matcha/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { DiffIcon } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import { gitRenameBranchMutationOptions } from "~/lib/gitReactQuery";
import { Badge } from "../ui/badge";
import { toastManager } from "../ui/toast";
import { Input } from "../ui/input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import ProjectScriptsControl, { type NewProjectScriptInput } from "../ProjectScriptsControl";
import { RunCommandControl } from "../RunCommandControl";
import { SidebarTrigger } from "../ui/sidebar";
import { Toggle } from "../ui/toggle";
import { OpenInPicker } from "./OpenInPicker";

interface ChatHeaderProps {
  activeWorkspaceTitle: string;
  activeProjectName: string | undefined;
  activeProjectId: ProjectId | undefined;
  activeWorkspaceId: WorkspaceId | undefined;
  currentBranch: string | null;
  activeWorkspaceWorktreePath: string | null;
  isGitRepo: boolean;
  openInCwd: string | null;
  activeProjectScripts: ProjectScript[] | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  sourceControlToggleShortcutLabel: string | null;
  sourceControlOpen: boolean;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<void>;
  onUpdateProjectScript: (scriptId: string, input: NewProjectScriptInput) => Promise<void>;
  onDeleteProjectScript: (scriptId: string) => Promise<void>;
  onStartRunCommand: () => void;
  onStopRunCommand: () => void;
  onOpenPort: (port: number) => void;
  onToggleSourceControl: () => void;
}

function BranchNameControl(props: { currentBranch: string; cwd: string }) {
  const queryClient = useQueryClient();
  const [isEditing, setIsEditing] = useState(false);
  const [draftBranch, setDraftBranch] = useState(props.currentBranch);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const renameBranchMutation = useMutation(
    gitRenameBranchMutationOptions({ cwd: props.cwd, queryClient }),
  );

  useEffect(() => {
    if (!isEditing) {
      setDraftBranch(props.currentBranch);
    }
  }, [isEditing, props.currentBranch]);

  useEffect(() => {
    if (!isEditing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [isEditing]);

  const finishEditing = () => {
    setIsEditing(false);
    setDraftBranch(props.currentBranch);
  };

  const commitRename = async () => {
    const nextBranch = draftBranch.trim();
    if (nextBranch.length === 0) {
      toastManager.add({
        type: "warning",
        title: "Branch name cannot be empty",
      });
      finishEditing();
      return;
    }

    if (nextBranch === props.currentBranch) {
      finishEditing();
      return;
    }

    try {
      await renameBranchMutation.mutateAsync({
        oldBranch: props.currentBranch,
        newBranch: nextBranch,
      });
      setIsEditing(false);
      setDraftBranch(nextBranch);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Failed to rename branch",
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
      });
      finishEditing();
    }
  };

  if (isEditing) {
    return (
      <div className="min-w-0 shrink" data-testid="chat-header-branch-editor">
        <Input
          ref={inputRef}
          value={draftBranch}
          size="sm"
          className="h-7 w-[min(32ch,42vw)] rounded-full border-border/70 bg-muted/35 font-mono text-xs"
          aria-label="Rename branch"
          data-testid="chat-header-branch-input"
          disabled={renameBranchMutation.isPending}
          onBlur={() => {
            if (renameBranchMutation.isPending) return;
            void commitRename();
          }}
          onChange={(event) => setDraftBranch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void commitRename();
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              finishEditing();
            }
          }}
        />
      </div>
    );
  }

  return (
    <button
      type="button"
      className="min-w-0 shrink rounded-full border border-border/70 bg-muted/35 px-2.5 py-1 font-mono text-[11px] text-muted-foreground transition-colors hover:border-border hover:bg-muted/55 hover:text-foreground"
      title={props.currentBranch}
      aria-label={`Rename branch ${props.currentBranch}`}
      data-testid="chat-header-branch-button"
      onClick={() => setIsEditing(true)}
    >
      <span className="block min-w-0 truncate">{props.currentBranch}</span>
    </button>
  );
}

export const ChatHeader = memo(function ChatHeader({
  activeWorkspaceTitle,
  activeProjectName,
  activeProjectId,
  activeWorkspaceId,
  currentBranch,
  activeWorkspaceWorktreePath,
  isGitRepo,
  openInCwd,
  activeProjectScripts,
  preferredScriptId,
  keybindings,
  availableEditors,
  sourceControlToggleShortcutLabel,
  sourceControlOpen,
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
  onStartRunCommand,
  onStopRunCommand,
  onOpenPort,
  onToggleSourceControl,
}: ChatHeaderProps) {
  return (
    <div className="@container/header-actions flex min-w-0 flex-1 items-center gap-2">
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden sm:gap-3">
        <SidebarTrigger className="size-7 shrink-0 md:hidden" />
        <h2
          className="min-w-0 shrink truncate text-sm font-medium text-foreground"
          title={activeWorkspaceTitle}
        >
          {activeWorkspaceTitle}
        </h2>
        {isGitRepo && currentBranch && openInCwd && (
          <BranchNameControl currentBranch={currentBranch} cwd={openInCwd} />
        )}
        {activeProjectName && (
          <Badge
            variant="outline"
            className="shrink-0 text-[10px] uppercase tracking-[0.16em] text-muted-foreground/75"
            title={
              activeWorkspaceWorktreePath
                ? `Worktree: ${activeWorkspaceWorktreePath}`
                : "Using the project root, not a linked worktree."
            }
          >
            {activeWorkspaceWorktreePath ? "Worktree" : "Local"}
          </Badge>
        )}
        {activeProjectName && !isGitRepo && (
          <Badge variant="outline" className="shrink-0 text-[10px] text-amber-700">
            No Git
          </Badge>
        )}
      </div>
      <div className="flex shrink-0 items-center justify-end gap-2 @3xl/header-actions:gap-3">
        {activeProjectId && activeWorkspaceId && (
          <RunCommandControl
            projectId={activeProjectId}
            workspaceId={activeWorkspaceId}
            onStart={onStartRunCommand}
            onStop={onStopRunCommand}
            onOpenPort={onOpenPort}
          />
        )}
        {activeProjectScripts && (
          <ProjectScriptsControl
            scripts={activeProjectScripts}
            keybindings={keybindings}
            preferredScriptId={preferredScriptId}
            onRunScript={onRunProjectScript}
            onAddScript={onAddProjectScript}
            onUpdateScript={onUpdateProjectScript}
            onDeleteScript={onDeleteProjectScript}
          />
        )}
        {activeProjectName && (
          <OpenInPicker
            keybindings={keybindings}
            availableEditors={availableEditors}
            openInCwd={openInCwd}
          />
        )}
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                className="shrink-0"
                pressed={sourceControlOpen}
                onPressedChange={onToggleSourceControl}
                aria-label="Toggle source control"
                variant="outline"
                size="xs"
                disabled={!isGitRepo}
              >
                <DiffIcon className="size-3" />
              </Toggle>
            }
          />
          <TooltipPopup side="bottom">
            {!isGitRepo
              ? "Source control is unavailable because this project is not a git repository."
              : sourceControlToggleShortcutLabel
                ? `Toggle source control (${sourceControlToggleShortcutLabel})`
                : "Toggle source control"}
          </TooltipPopup>
        </Tooltip>
      </div>
    </div>
  );
});
