/**
 * SourceControlSidebar — Git changes panel with inline commit workflow.
 *
 * Layout:
 * 1. Commit message input + action buttons (Commit, Push, Create PR)
 * 2. Working changes — file list with checkboxes and discard buttons
 * 3. Against {base} — aggregate diff tree accordion
 * 4. Commits — per-commit accordion
 */

import { type TurnId, WorkspaceId } from "@matcha/contracts";
import type { GitLogCommit } from "@matcha/contracts";
import {
  ArchiveRestoreIcon,
  ChevronRightIcon,
  CloudUploadIcon,
  DownloadCloudIcon,
  GitCommitVerticalIcon,
  PackageIcon,
  RefreshCwIcon,
  Undo2Icon,
} from "lucide-react";
import { memo, useCallback, useMemo, useState } from "react";
import { useParams } from "@tanstack/react-router";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { cn } from "~/lib/utils";
import { isElectron } from "~/env";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { type TurnDiffFileChange } from "../types";
import { useStore } from "../store";
import { useTheme } from "../hooks/useTheme";
import {
  gitDiscardFilesMutationOptions,
  gitLogQueryOptions,
  gitMutationKeys,
  gitPullMutationOptions,
  gitRunStackedActionMutationOptions,
  gitStatusQueryOptions,
  invalidateGitQueries,
} from "~/lib/gitReactQuery";
import { DiffStatLabel, hasNonZeroStat } from "./chat/DiffStatLabel";
import { ChangedFilesTree } from "./chat/ChangedFilesTree";
import { summarizeTurnDiffStats } from "../lib/turnDiffTree";
import { makeDiffTab, useWorkspaceTabStore } from "../workspaceTabStore";
import { Skeleton } from "./ui/skeleton";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Textarea } from "./ui/textarea";
import { GitHubIcon } from "./Icons";
import { VscodeEntryIcon } from "./chat/VscodeEntryIcon";
import { toastManager, type WorkspaceToastData } from "./ui/toast";
import { randomUUID } from "~/lib/utils";
import { ensureNativeApi } from "~/nativeApi";
import { resolveWorkingChanges } from "./SourceControlSidebar.logic";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function commitFilesToDiffFiles(files: GitLogCommit["files"]): TurnDiffFileChange[] {
  return files.map((f) => ({
    path: f.path,
    additions: f.insertions,
    deletions: f.deletions,
  }));
}

function fileNameFromPath(filePath: string): string {
  const segments = filePath.replaceAll("\\", "/").split("/");
  return segments.at(-1) ?? filePath;
}

function formatRelativeTime(isoDate: string): string {
  const diffMs = Date.now() - new Date(isoDate).getTime();
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ---------------------------------------------------------------------------
// Small reusable bits
// ---------------------------------------------------------------------------

function ActionIconButton(props: {
  icon: React.ReactNode;
  title: string;
  onClick: (e: React.MouseEvent) => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className="inline-flex size-5 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation();
              props.onClick(e);
            }}
          >
            {props.icon}
          </button>
        }
      />
      <TooltipPopup side="bottom" sideOffset={4}>
        {props.title}
      </TooltipPopup>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

function SourceControlSidebarInner() {
  const { resolvedTheme } = useTheme();
  const queryClient = useQueryClient();

  const routeWorkspaceId = useParams({
    strict: false,
    select: (params) => (params.workspaceId ? WorkspaceId.makeUnsafe(params.workspaceId) : null),
  });

  const activeWorkspaceId = routeWorkspaceId;
  const activeWorkspace = useStore((store) =>
    activeWorkspaceId
      ? store.workspaces.find((workspace) => workspace.id === activeWorkspaceId)
      : undefined,
  );
  const activeProjectId = activeWorkspace?.projectId ?? null;
  const activeProject = useStore((store) =>
    activeProjectId ? store.projects.find((project) => project.id === activeProjectId) : undefined,
  );
  const activeCwd = activeWorkspace?.worktreePath ?? activeProject?.cwd;

  // -----------------------------------------------------------------------
  // Git queries
  // -----------------------------------------------------------------------
  const gitStatusQuery = useQuery(gitStatusQueryOptions(activeCwd ?? null));
  const gitStatus = gitStatusQuery.data;
  const isGitRepo = gitStatus?.isRepo ?? true;
  const gitLogQuery = useQuery(gitLogQueryOptions(isGitRepo ? (activeCwd ?? null) : null));
  const gitLog = gitLogQuery.data;
  const commits = useMemo(() => gitLog?.commits ?? [], [gitLog]);

  // -----------------------------------------------------------------------
  // Git mutations
  // -----------------------------------------------------------------------
  const runActionMutation = useMutation(
    gitRunStackedActionMutationOptions({ cwd: activeCwd ?? null, queryClient }),
  );
  const discardMutation = useMutation(
    gitDiscardFilesMutationOptions({ cwd: activeCwd ?? null, queryClient }),
  );
  const pullMutation = useMutation(gitPullMutationOptions({ cwd: activeCwd ?? null, queryClient }));
  const isGitActionRunning =
    useIsMutating({ mutationKey: gitMutationKeys.runStackedAction(activeCwd ?? null) }) > 0;

  // -----------------------------------------------------------------------
  // Commit workflow state
  // -----------------------------------------------------------------------
  const [commitMessage, setCommitMessage] = useState("");
  const [excludedFiles, setExcludedFiles] = useState<ReadonlySet<string>>(new Set());
  const workspaceToastData = useMemo<WorkspaceToastData | undefined>(
    () => (activeWorkspaceId ? { workspaceId: activeWorkspaceId } : undefined),
    [activeWorkspaceId],
  );

  const hasChanges = gitStatus?.hasWorkingTreeChanges ?? false;
  const isAhead = (gitStatus?.aheadCount ?? 0) > 0;
  const hasOriginRemote = gitStatus?.hasOriginRemote ?? false;
  const canPush = !hasChanges && isAhead && (gitStatus?.hasUpstream || hasOriginRemote);
  const hasOpenPr = gitStatus?.pr?.state === "open";
  const canCreatePr = canPush && !hasOpenPr;

  // -----------------------------------------------------------------------
  // Turn diff / file data
  // -----------------------------------------------------------------------
  const workingTreeFiles: TurnDiffFileChange[] = useMemo(
    () => resolveWorkingChanges(gitStatus),
    [gitStatus],
  );

  const workingChanges: TurnDiffFileChange[] = useMemo(() => workingTreeFiles, [workingTreeFiles]);
  const workingChangesStat = useMemo(
    () => summarizeTurnDiffStats(workingChanges),
    [workingChanges],
  );

  const selectedFiles = workingChanges.filter((f) => !excludedFiles.has(f.path));
  const allSelected = excludedFiles.size === 0;

  // Per-commit files
  const commitFilesByHash = useMemo(() => {
    const map = new Map<string, TurnDiffFileChange[]>();
    for (const commit of commits) {
      map.set(commit.hash, commitFilesToDiffFiles(commit.files));
    }
    return map;
  }, [commits]);

  // -----------------------------------------------------------------------
  // Section expand/collapse
  // -----------------------------------------------------------------------
  const [workingExpanded, setWorkingExpanded] = useState(true);
  const [commitsExpanded, setCommitsExpanded] = useState(true);
  const [expandedCommitHashes, setExpandedCommitHashes] = useState<Record<string, boolean>>({});

  const toggleCommit = useCallback((hash: string) => {
    setExpandedCommitHashes((prev) => ({ ...prev, [hash]: !prev[hash] }));
  }, []);

  // -----------------------------------------------------------------------
  // Tab store (for opening diffs)
  // -----------------------------------------------------------------------
  const rootWorkspaceId = useWorkspaceTabStore((s) =>
    activeWorkspaceId ? (s.findRootWorkspaceId(activeWorkspaceId) ?? activeWorkspaceId) : null,
  );
  const addTab = useWorkspaceTabStore((s) => s.addTab);
  const setActiveTab = useWorkspaceTabStore((s) => s.setActiveTab);
  const findDiffTab = useWorkspaceTabStore((s) => s.findDiffTab);

  const openDiffFileTab = useCallback(
    (input: {
      filePath: string;
      diffTurnId?: TurnId | null;
      diffGitSource?: "workingTree" | "commit";
      diffCommitHash?: string;
    }) => {
      if (!activeWorkspaceId || !rootWorkspaceId) return;
      const existing = findDiffTab({
        rootWorkspaceId,
        diffSourceWorkspaceId: activeWorkspaceId,
        diffTurnId: input.diffTurnId ?? undefined,
        diffGitSource: input.diffGitSource,
        diffCommitHash: input.diffCommitHash,
        diffFilePath: input.filePath,
      });
      if (existing) {
        setActiveTab(rootWorkspaceId, existing.id);
        return;
      }
      addTab(
        rootWorkspaceId,
        makeDiffTab({
          diffSourceWorkspaceId: activeWorkspaceId,
          ...(input.diffTurnId !== undefined ? { diffTurnId: input.diffTurnId } : {}),
          ...(input.diffGitSource ? { diffGitSource: input.diffGitSource } : {}),
          ...(input.diffCommitHash ? { diffCommitHash: input.diffCommitHash } : {}),
          diffFilePath: input.filePath,
          label: fileNameFromPath(input.filePath),
        }),
      );
    },
    [activeWorkspaceId, rootWorkspaceId, addTab, setActiveTab, findDiffTab],
  );

  const onOpenFile = useCallback(
    (turnId: TurnId, filePath?: string) => {
      if (!filePath) return;
      if (turnId === ("__working__" as TurnId)) {
        openDiffFileTab({
          filePath,
          diffGitSource: "workingTree",
        });
        return;
      }
      openDiffFileTab({
        filePath,
        diffGitSource: "commit",
        diffCommitHash: turnId,
      });
    },
    [openDiffFileTab],
  );

  // -----------------------------------------------------------------------
  // Actions
  // -----------------------------------------------------------------------
  const discardFile = useCallback(
    (path: string) => discardMutation.mutate([path]),
    [discardMutation],
  );

  const onFetch = useCallback(async () => {
    if (!activeCwd) return;
    const toastId = toastManager.add({
      type: "loading",
      title: "Fetching...",
      timeout: 0,
      data: workspaceToastData,
    });
    try {
      const api = ensureNativeApi();
      await api.git.fetch({ cwd: activeCwd });
      await invalidateGitQueries(queryClient, { cwd: activeCwd });
      toastManager.update(toastId, {
        type: "success",
        title: "Fetched",
        data: { ...workspaceToastData, dismissAfterVisibleMs: 3_000 },
      });
    } catch (err) {
      toastManager.update(toastId, {
        type: "error",
        title: "Fetch failed",
        description: err instanceof Error ? err.message : "An error occurred.",
        data: workspaceToastData,
      });
    }
  }, [activeCwd, queryClient, workspaceToastData]);

  const onPull = useCallback(() => {
    const promise = pullMutation.mutateAsync();
    toastManager.promise(promise, {
      loading: { title: "Pulling...", data: workspaceToastData },
      success: (result) => ({
        title: result.status === "pulled" ? "Pulled" : "Already up to date",
        data: { ...workspaceToastData, dismissAfterVisibleMs: 3_000 },
      }),
      error: (err) => ({
        title: "Pull failed",
        description: err instanceof Error ? err.message : "An error occurred.",
        data: workspaceToastData,
      }),
    });
    void promise.catch(() => undefined);
  }, [pullMutation, workspaceToastData]);

  const onStashPush = useCallback(async () => {
    if (!activeCwd) return;
    const toastId = toastManager.add({
      type: "loading",
      title: "Stashing...",
      timeout: 0,
      data: workspaceToastData,
    });
    try {
      const api = ensureNativeApi();
      await api.git.stashPush({ cwd: activeCwd });
      await invalidateGitQueries(queryClient, { cwd: activeCwd });
      toastManager.update(toastId, {
        type: "success",
        title: "Changes stashed",
        data: { ...workspaceToastData, dismissAfterVisibleMs: 3_000 },
      });
    } catch (err) {
      toastManager.update(toastId, {
        type: "error",
        title: "Stash failed",
        description: err instanceof Error ? err.message : "An error occurred.",
        data: workspaceToastData,
      });
    }
  }, [activeCwd, queryClient, workspaceToastData]);

  const onStashPop = useCallback(async () => {
    if (!activeCwd) return;
    const toastId = toastManager.add({
      type: "loading",
      title: "Popping stash...",
      timeout: 0,
      data: workspaceToastData,
    });
    try {
      const api = ensureNativeApi();
      await api.git.stashPop({ cwd: activeCwd });
      await invalidateGitQueries(queryClient, { cwd: activeCwd });
      toastManager.update(toastId, {
        type: "success",
        title: "Stash applied",
        data: { ...workspaceToastData, dismissAfterVisibleMs: 3_000 },
      });
    } catch (err) {
      toastManager.update(toastId, {
        type: "error",
        title: "Stash pop failed",
        description: err instanceof Error ? err.message : "An error occurred.",
        data: workspaceToastData,
      });
    }
  }, [activeCwd, queryClient, workspaceToastData]);

  const runGitAction = useCallback(
    async (action: "commit" | "push" | "create_pr" | "commit_push" | "commit_push_pr") => {
      const msg = commitMessage.trim();
      const filePaths = !allSelected ? selectedFiles.map((f) => f.path) : undefined;
      const actionId = randomUUID();

      const toastId = toastManager.add({
        type: "loading",
        title:
          action === "commit"
            ? "Committing..."
            : action === "push"
              ? "Pushing..."
              : "Creating PR...",
        timeout: 0,
        data: workspaceToastData,
      });

      try {
        const result = await runActionMutation.mutateAsync({
          actionId,
          action,
          ...(msg ? { commitMessage: msg } : {}),
          ...(filePaths ? { filePaths } : {}),
        });

        setCommitMessage("");
        setExcludedFiles(new Set());

        const toastCta = result.toast.cta;
        if (toastCta.kind === "open_pr") {
          toastManager.update(toastId, {
            type: "success",
            title: result.toast.title,
            description: result.toast.description,
            timeout: 0,
            data: { ...workspaceToastData, dismissAfterVisibleMs: 10_000 },
            actionProps: {
              children: toastCta.label,
              onClick: () => {
                toastManager.close(toastId);
                window.open(toastCta.url, "_blank", "noopener,noreferrer");
              },
            },
          });
        } else {
          toastManager.update(toastId, {
            type: "success",
            title: result.toast.title,
            description: result.toast.description,
            timeout: 0,
            data: { ...workspaceToastData, dismissAfterVisibleMs: 10_000 },
          });
        }
      } catch (err) {
        toastManager.update(toastId, {
          type: "error",
          title: "Action failed",
          description: err instanceof Error ? err.message : "An error occurred.",
          data: workspaceToastData,
        });
      }
    },
    [allSelected, commitMessage, runActionMutation, selectedFiles, workspaceToastData],
  );

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  const isLoading = gitLogQuery.isLoading && gitStatusQuery.isLoading;
  const hasAnyChanges = workingChanges.length > 0 || commits.length > 0;

  if (!activeWorkspace) {
    return (
      <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
        Select a workspace to view changes.
      </div>
    );
  }

  if (!isGitRepo) {
    return (
      <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
        Not a git repository.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col text-sm">
      {/* Toolbar — matches chat header height so borders align */}
      <div
        className={cn(
          "flex shrink-0 items-center justify-between gap-2 border-b border-border px-3",
          isElectron ? "h-[52px]" : "h-[41px] sm:h-[49px]",
        )}
      >
        <span className="text-xs font-medium text-foreground">Source Control</span>
        <div className="flex items-center gap-0.5">
          <ActionIconButton
            icon={<RefreshCwIcon className="size-3.5" />}
            title="Fetch"
            onClick={() => void onFetch()}
          />
          <ActionIconButton
            icon={<DownloadCloudIcon className="size-3.5" />}
            title="Pull"
            onClick={() => onPull()}
          />
          <ActionIconButton
            icon={<PackageIcon className="size-3.5" />}
            title="Stash"
            onClick={() => void onStashPush()}
          />
          <ActionIconButton
            icon={<ArchiveRestoreIcon className="size-3.5" />}
            title="Pop Stash"
            onClick={() => void onStashPop()}
          />
        </div>
      </div>

      {/* Commit workflow */}
      <div className="shrink-0 space-y-2 border-b border-border px-3 py-2.5">
        <Textarea
          value={commitMessage}
          onChange={(e) => setCommitMessage(e.target.value)}
          placeholder="Commit message (leave empty to auto-generate)"
          size="sm"
          className="min-h-[60px] text-xs"
        />
        <div className="flex items-center gap-1.5">
          <Button
            size="xs"
            disabled={!hasChanges || isGitActionRunning}
            onClick={() => void runGitAction("commit")}
            className="flex-1"
          >
            <GitCommitVerticalIcon className="size-3.5" />
            Commit
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={!canPush || isGitActionRunning}
            onClick={() => void runGitAction("push")}
          >
            <CloudUploadIcon className="size-3.5" />
            Push
          </Button>
          {canCreatePr && (
            <Button
              size="xs"
              variant="outline"
              disabled={isGitActionRunning}
              onClick={() => void runGitAction("create_pr")}
            >
              <GitHubIcon className="size-3.5" />
              PR
            </Button>
          )}
          {hasOpenPr && gitStatus?.pr?.url && (
            <Button
              size="xs"
              variant="outline"
              onClick={() => window.open(gitStatus.pr!.url, "_blank", "noopener,noreferrer")}
            >
              <GitHubIcon className="size-3.5" />
              View PR
            </Button>
          )}
        </div>
      </div>

      {/* Scrollable content */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="flex h-full flex-col gap-3 p-3">
            <Skeleton className="h-6 w-32 rounded" />
            <Skeleton className="h-4 w-48 rounded" />
            <Skeleton className="h-4 w-40 rounded" />
          </div>
        ) : !hasAnyChanges ? (
          <div className="flex flex-1 items-center justify-center px-5 py-8 text-center text-xs text-muted-foreground/70">
            No changes.
          </div>
        ) : (
          <>
            {/* Working changes — files with checkboxes */}
            {workingChanges.length > 0 && (
              <div className="border-b border-border/50">
                <button
                  type="button"
                  className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-xs font-medium text-foreground"
                  onClick={() => setWorkingExpanded((v) => !v)}
                >
                  <ChevronRightIcon
                    className={cn(
                      "size-3.5 shrink-0 text-muted-foreground/70 transition-transform",
                      workingExpanded && "rotate-90",
                    )}
                  />
                  <span>Working Changes</span>
                  <span className="ml-1 text-muted-foreground/70">{workingChanges.length}</span>
                  {hasNonZeroStat(workingChangesStat) && (
                    <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums">
                      <DiffStatLabel
                        additions={workingChangesStat.additions}
                        deletions={workingChangesStat.deletions}
                      />
                    </span>
                  )}
                </button>
                {workingExpanded && (
                  <div className="space-y-0.5 pb-2">
                    {workingChanges.map((file) => {
                      const isExcluded = excludedFiles.has(file.path);
                      return (
                        <div
                          key={file.path}
                          className="group/file flex items-center gap-1.5 px-3 py-0.5 hover:bg-accent/30"
                        >
                          <Checkbox
                            checked={!isExcluded}
                            onCheckedChange={() => {
                              setExcludedFiles((prev) => {
                                const next = new Set(prev);
                                if (next.has(file.path)) {
                                  next.delete(file.path);
                                } else {
                                  next.add(file.path);
                                }
                                return next;
                              });
                            }}
                            className="size-3.5"
                          />
                          <button
                            type="button"
                            className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                            onClick={() => onOpenFile("__working__" as TurnId, file.path)}
                          >
                            <VscodeEntryIcon
                              pathValue={file.path}
                              kind="file"
                              theme={resolvedTheme}
                              className="size-3.5 shrink-0 text-muted-foreground/70"
                            />
                            <span
                              className={cn(
                                "truncate font-mono text-[11px]",
                                isExcluded
                                  ? "text-muted-foreground/50 line-through"
                                  : "text-muted-foreground/80 group-hover/file:text-foreground/90",
                              )}
                            >
                              {file.path}
                            </span>
                            {file.additions !== undefined &&
                              file.deletions !== undefined &&
                              (file.additions > 0 || file.deletions > 0) && (
                                <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums">
                                  <DiffStatLabel
                                    additions={file.additions}
                                    deletions={file.deletions}
                                  />
                                </span>
                              )}
                          </button>
                          <span className="flex shrink-0 items-center opacity-0 transition-opacity group-hover/file:opacity-100">
                            <ActionIconButton
                              icon={<Undo2Icon className="size-3" />}
                              title="Discard changes"
                              onClick={() => discardFile(file.path)}
                            />
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* Commits */}
            {commits.length > 0 && (
              <div className="border-b border-border/50">
                <button
                  type="button"
                  className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-xs font-medium text-foreground"
                  onClick={() => setCommitsExpanded((v) => !v)}
                >
                  <ChevronRightIcon
                    className={cn(
                      "size-3.5 shrink-0 text-muted-foreground/70 transition-transform",
                      commitsExpanded && "rotate-90",
                    )}
                  />
                  <GitCommitVerticalIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
                  <span>Commits</span>
                  <span className="ml-1 text-muted-foreground/70">{commits.length}</span>
                </button>
                {commitsExpanded && (
                  <div className="pb-1">
                    {commits.map((commit) => {
                      const isExpanded = expandedCommitHashes[commit.hash] ?? true;
                      const commitFiles = commitFilesByHash.get(commit.hash) ?? [];
                      const commitTurnId = commit.hash as TurnId;
                      return (
                        <div key={commit.hash} className="border-t border-border/30">
                          <button
                            type="button"
                            className="flex w-full items-center gap-1.5 px-3 py-1.5 pl-6 text-left text-[11px] hover:bg-accent/50"
                            onClick={() => toggleCommit(commit.hash)}
                          >
                            <ChevronRightIcon
                              className={cn(
                                "size-3 shrink-0 text-muted-foreground/60 transition-transform",
                                isExpanded && "rotate-90",
                              )}
                            />
                            <span className="font-mono text-muted-foreground/60">
                              {commit.shortHash}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-foreground/90">
                              {commit.subject}
                            </span>
                            <span className="shrink-0 text-muted-foreground/50">
                              {formatRelativeTime(commit.authorDate)}
                            </span>
                          </button>
                          {isExpanded && (
                            <div className="pb-1 pl-5">
                              <ChangedFilesTree
                                turnId={commitTurnId}
                                files={commitFiles}
                                allDirectoriesExpanded
                                resolvedTheme={resolvedTheme}
                                onOpenTurnDiff={onOpenFile}
                              />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export const SourceControlSidebar = memo(SourceControlSidebarInner);
