import {
  type GitActionProgressEvent,
  type GitStackedAction,
  type WorkspaceId,
} from "@matcha/contracts";
import {
  infiniteQueryOptions,
  mutationOptions,
  queryOptions,
  type QueryClient,
} from "@tanstack/react-query";
import { ensureNativeApi } from "../nativeApi";
import { getWsRpcClient } from "../wsRpcClient";

const GIT_STATUS_STALE_TIME_MS = 5_000;
const GIT_STATUS_REFETCH_INTERVAL_MS = 15_000;
const GIT_BRANCHES_STALE_TIME_MS = 15_000;
const GIT_BRANCHES_REFETCH_INTERVAL_MS = 60_000;
const GIT_BRANCHES_PAGE_SIZE = 100;

export const gitQueryKeys = {
  all: ["git"] as const,
  status: (cwd: string | null) => ["git", "status", cwd] as const,
  branches: (cwd: string | null) => ["git", "branches", cwd] as const,
  branchSearch: (cwd: string | null, query: string) =>
    ["git", "branches", cwd, "search", query] as const,
  log: (cwd: string | null) => ["git", "log", cwd] as const,
};

export const gitMutationKeys = {
  init: (cwd: string | null) => ["git", "mutation", "init", cwd] as const,
  checkout: (cwd: string | null) => ["git", "mutation", "checkout", cwd] as const,
  runStackedAction: (cwd: string | null) => ["git", "mutation", "run-stacked-action", cwd] as const,
  pull: (cwd: string | null) => ["git", "mutation", "pull", cwd] as const,
  preparePullRequestWorkspace: (cwd: string | null) =>
    ["git", "mutation", "prepare-pull-request-workspace", cwd] as const,
};

export function invalidateGitQueries(queryClient: QueryClient, input?: { cwd?: string | null }) {
  const cwd = input?.cwd ?? null;
  if (cwd !== null) {
    return Promise.all([
      queryClient.invalidateQueries({ queryKey: gitQueryKeys.status(cwd) }),
      queryClient.invalidateQueries({ queryKey: gitQueryKeys.branches(cwd) }),
    ]);
  }

  return queryClient.invalidateQueries({ queryKey: gitQueryKeys.all });
}

export function invalidateGitStatusQuery(queryClient: QueryClient, cwd: string | null) {
  if (cwd === null) {
    return Promise.resolve();
  }

  return queryClient.invalidateQueries({ queryKey: gitQueryKeys.status(cwd) });
}

export function gitStatusQueryOptions(cwd: string | null) {
  return queryOptions({
    queryKey: gitQueryKeys.status(cwd),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!cwd) throw new Error("Git status is unavailable.");
      return api.git.status({ cwd });
    },
    enabled: cwd !== null,
    staleTime: GIT_STATUS_STALE_TIME_MS,
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
    refetchInterval: GIT_STATUS_REFETCH_INTERVAL_MS,
  });
}

export function gitBranchSearchInfiniteQueryOptions(input: {
  cwd: string | null;
  query: string;
  enabled?: boolean;
}) {
  const normalizedQuery = input.query.trim();

  return infiniteQueryOptions({
    queryKey: gitQueryKeys.branchSearch(input.cwd, normalizedQuery),
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("Git branches are unavailable.");
      return api.git.listBranches({
        cwd: input.cwd,
        ...(normalizedQuery.length > 0 ? { query: normalizedQuery } : {}),
        cursor: pageParam,
        limit: GIT_BRANCHES_PAGE_SIZE,
      });
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: input.cwd !== null && (input.enabled ?? true),
    staleTime: GIT_BRANCHES_STALE_TIME_MS,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchInterval: GIT_BRANCHES_REFETCH_INTERVAL_MS,
  });
}

const GIT_LOG_STALE_TIME_MS = 10_000;
const GIT_LOG_REFETCH_INTERVAL_MS = 30_000;

export type GitFileDiffSource =
  | { source: "workingTree" }
  | { source: "commit"; commitHash: string };

export function gitLogQueryOptions(cwd: string | null) {
  return queryOptions({
    queryKey: gitQueryKeys.log(cwd),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!cwd) throw new Error("Git log is unavailable.");
      return api.git.log({ cwd });
    },
    enabled: cwd !== null,
    staleTime: GIT_LOG_STALE_TIME_MS,
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
    refetchInterval: GIT_LOG_REFETCH_INTERVAL_MS,
  });
}

export function gitFileDiffQueryOptions(input: {
  cwd: string | null;
  filePath: string | null;
  diffSource: GitFileDiffSource | null;
}) {
  return queryOptions({
    queryKey: [
      "git",
      "file-diff",
      input.cwd,
      input.filePath,
      input.diffSource?.source ?? null,
      input.diffSource?.source === "commit" ? input.diffSource.commitHash : null,
    ] as const,
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd || !input.filePath || !input.diffSource) {
        throw new Error("Git diff is unavailable.");
      }
      if (input.diffSource.source === "commit") {
        return api.git.readFileDiff({
          cwd: input.cwd,
          filePath: input.filePath,
          source: "commit",
          commitHash: input.diffSource.commitHash,
        });
      }
      return api.git.readFileDiff({
        cwd: input.cwd,
        filePath: input.filePath,
        source: "workingTree",
      });
    },
    enabled: input.cwd !== null && input.filePath !== null && input.diffSource !== null,
    staleTime: 1_000,
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
  });
}

export function gitStageFilesMutationOptions(input: {
  cwd: string | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: ["git", "mutation", "stageFiles", input.cwd] as const,
    mutationFn: async (paths?: string[]) => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("Git stage is unavailable.");
      await api.git.stageFiles({ cwd: input.cwd, ...(paths ? { paths } : {}) });
    },
    onSettled: async () => {
      await invalidateGitQueries(input.queryClient, { cwd: input.cwd });
    },
  });
}

export function gitUnstageFilesMutationOptions(input: {
  cwd: string | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: ["git", "mutation", "unstageFiles", input.cwd] as const,
    mutationFn: async (paths?: string[]) => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("Git unstage is unavailable.");
      await api.git.unstageFiles({ cwd: input.cwd, ...(paths ? { paths } : {}) });
    },
    onSettled: async () => {
      await invalidateGitQueries(input.queryClient, { cwd: input.cwd });
    },
  });
}

export function gitDiscardFilesMutationOptions(input: {
  cwd: string | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: ["git", "mutation", "discardFiles", input.cwd] as const,
    mutationFn: async (paths?: string[]) => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("Git discard is unavailable.");
      await api.git.discardFiles({ cwd: input.cwd, ...(paths ? { paths } : {}) });
    },
    onSettled: async () => {
      await invalidateGitQueries(input.queryClient, { cwd: input.cwd });
    },
  });
}

export function gitResolvePullRequestQueryOptions(input: {
  cwd: string | null;
  reference: string | null;
}) {
  return queryOptions({
    queryKey: ["git", "pull-request", input.cwd, input.reference] as const,
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd || !input.reference) {
        throw new Error("Pull request lookup is unavailable.");
      }
      return api.git.resolvePullRequest({ cwd: input.cwd, reference: input.reference });
    },
    enabled: input.cwd !== null && input.reference !== null,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

export function gitInitMutationOptions(input: { cwd: string | null; queryClient: QueryClient }) {
  return mutationOptions({
    mutationKey: gitMutationKeys.init(input.cwd),
    mutationFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("Git init is unavailable.");
      return api.git.init({ cwd: input.cwd });
    },
    onSuccess: async () => {
      await invalidateGitQueries(input.queryClient);
    },
  });
}

export function gitCheckoutMutationOptions(input: {
  cwd: string | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: gitMutationKeys.checkout(input.cwd),
    mutationFn: async (branch: string) => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("Git checkout is unavailable.");
      return api.git.checkout({ cwd: input.cwd, branch });
    },
    onSuccess: async () => {
      await invalidateGitQueries(input.queryClient);
    },
  });
}

export function gitRunStackedActionMutationOptions(input: {
  cwd: string | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: gitMutationKeys.runStackedAction(input.cwd),
    mutationFn: async ({
      actionId,
      action,
      commitMessage,
      featureBranch,
      filePaths,
      onProgress,
    }: {
      actionId: string;
      action: GitStackedAction;
      commitMessage?: string;
      featureBranch?: boolean;
      filePaths?: string[];
      onProgress?: (event: GitActionProgressEvent) => void;
    }) => {
      if (!input.cwd) throw new Error("Git action is unavailable.");
      return getWsRpcClient().git.runStackedAction(
        {
          actionId,
          cwd: input.cwd,
          action,
          ...(commitMessage ? { commitMessage } : {}),
          ...(featureBranch ? { featureBranch } : {}),
          ...(filePaths ? { filePaths } : {}),
        },
        ...(onProgress ? [{ onProgress }] : []),
      );
    },
    onSettled: async () => {
      await invalidateGitQueries(input.queryClient);
    },
  });
}

export function gitPullMutationOptions(input: { cwd: string | null; queryClient: QueryClient }) {
  return mutationOptions({
    mutationKey: gitMutationKeys.pull(input.cwd),
    mutationFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("Git pull is unavailable.");
      return api.git.pull({ cwd: input.cwd });
    },
    onSettled: async () => {
      await invalidateGitQueries(input.queryClient);
    },
  });
}

export function gitCreateWorktreeMutationOptions(input: { queryClient: QueryClient }) {
  return mutationOptions({
    mutationFn: async ({
      cwd,
      branch,
      newBranch,
      path,
    }: {
      cwd: string;
      branch: string;
      newBranch: string;
      path?: string | null;
    }) => {
      const api = ensureNativeApi();
      if (!cwd) throw new Error("Git worktree creation is unavailable.");
      return api.git.createWorktree({ cwd, branch, newBranch, path: path ?? null });
    },
    mutationKey: ["git", "mutation", "create-worktree"] as const,
    onSettled: async () => {
      await invalidateGitQueries(input.queryClient);
    },
  });
}

export function gitRemoveWorktreeMutationOptions(input: { queryClient: QueryClient }) {
  return mutationOptions({
    mutationFn: async ({ cwd, path, force }: { cwd: string; path: string; force?: boolean }) => {
      const api = ensureNativeApi();
      if (!cwd) throw new Error("Git worktree removal is unavailable.");
      return api.git.removeWorktree({ cwd, path, force });
    },
    mutationKey: ["git", "mutation", "remove-worktree"] as const,
    onSettled: async () => {
      await invalidateGitQueries(input.queryClient);
    },
  });
}

export function gitPreparePullRequestWorkspaceMutationOptions(input: {
  cwd: string | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationFn: async ({
      reference,
      mode,
      workspaceId,
    }: {
      reference: string;
      mode: "local" | "worktree";
      workspaceId?: WorkspaceId;
    }) => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("Pull request workspace preparation is unavailable.");
      return api.git.preparePullRequestWorkspace({
        cwd: input.cwd,
        reference,
        mode,
        ...(workspaceId ? { workspaceId } : {}),
      });
    },
    mutationKey: gitMutationKeys.preparePullRequestWorkspace(input.cwd),
    onSettled: async () => {
      await invalidateGitQueries(input.queryClient);
    },
  });
}
