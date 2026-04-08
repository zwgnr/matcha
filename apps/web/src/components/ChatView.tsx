import {
  type ApprovalRequestId,
  DEFAULT_MODEL_BY_PROVIDER,
  type ClaudeCodeEffort,
  type MessageId,
  type ModelSelection,
  type ProjectScript,
  type ProviderKind,
  type ProjectEntry,
  type ProjectId,
  type ProviderApprovalDecision,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ServerProvider,
  type WorkspaceId,
  type TurnId,
  type KeybindingCommand,
  OrchestrationWorkspaceActivity,
  ProviderInteractionMode,
  RuntimeMode,
  TerminalOpenInput,
} from "@matcha/contracts";
import { applyClaudePromptEffortPrefix } from "@matcha/shared/model";
import { projectScriptCwd, projectScriptRuntimeEnv } from "@matcha/shared/projectScripts";
import { isLeadingSlashCommandInput } from "@matcha/shared/slashCommands";
import { truncate } from "@matcha/shared/String";
import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { gitStatusQueryOptions } from "~/lib/gitReactQuery";
import { projectSearchEntriesQueryOptions } from "~/lib/projectReactQuery";
import { isElectron } from "../env";
import { ELECTRON_TRAFFIC_LIGHTS_LEFT_INSET_STYLE } from "../lib/titleBar";
import {
  parseSourceControlRouteSearch,
  stripSourceControlSearchParams,
} from "../sourceControlRouteSearch";
import {
  clampCollapsedComposerCursor,
  type ComposerTrigger,
  collapseExpandedComposerCursor,
  detectComposerTrigger,
  expandCollapsedComposerCursor,
  parseStandaloneComposerSlashCommand,
  replaceTextRange,
} from "../composer-logic";
import {
  deriveCompletionDividerBeforeEntryId,
  derivePendingApprovals,
  derivePendingUserInputs,
  derivePhase,
  deriveTimelineEntries,
  deriveActiveWorkStartedAt,
  deriveActivePlanState,
  findSidebarProposedPlan,
  findLatestProposedPlan,
  deriveWorkLogEntries,
  hasActionableProposedPlan,
  hasToolActivityForTurn,
  isLatestTurnSettled,
  formatElapsed,
} from "../session-logic";
import { getScrollContainerBottomScrollTop, isScrollContainerNearBottom } from "../chat-scroll";
import {
  buildPendingUserInputAnswers,
  derivePendingUserInputProgress,
  setPendingUserInputCustomAnswer,
  type PendingUserInputDraftAnswer,
} from "../pendingUserInput";
import { useStore } from "../store";
import { useProjectById, useWorkspaceById } from "../storeSelectors";
import { useUiStateStore } from "../uiStateStore";
import {
  buildPlanImplementationWorkspaceTitle,
  buildPlanImplementationPrompt,
  proposedPlanTitle,
  resolvePlanFollowUpSubmission,
} from "../proposedPlan";
import {
  DEFAULT_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MAX_TERMINALS_PER_GROUP,
  type ChatMessage,
  type SessionPhase,
  type Workspace,
  type TurnDiffSummary,
} from "../types";
import { LRUCache } from "../lib/lruCache";

import { basenameOfPath } from "../vscode-icons";
import { useTheme } from "../hooks/useTheme";
import { useTurnDiffSummaries } from "../hooks/useTurnDiffSummaries";
import BranchToolbar from "./BranchToolbar";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../keybindings";
import PlanSidebar from "./PlanSidebar";
import WorkspaceTerminalDrawer from "./WorkspaceTerminalDrawer";
import {
  BotIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  ListTodoIcon,
  LockIcon,
  LockOpenIcon,
  XIcon,
} from "lucide-react";
import { Button } from "./ui/button";
import { Separator } from "./ui/separator";
import { cn, randomUUID } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { toastManager } from "./ui/toast";
import { decodeProjectScriptKeybindingRule } from "~/lib/projectScriptKeybindings";
import { type NewProjectScriptInput } from "./ProjectScriptsControl";
import {
  commandForProjectScript,
  nextProjectScriptId,
  projectScriptIdFromCommand,
} from "~/projectScripts";
import { SidebarTrigger, useSidebar } from "./ui/sidebar";
import { newCommandId, newMessageId, newWorkspaceId } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import {
  getProviderModelCapabilities,
  getProviderModels,
  resolveSelectableProvider,
} from "../providerModels";
import { useSettings } from "../hooks/useSettings";
import { getCustomModelOptionsByProvider, resolveAppModelSelection } from "../modelSelection";
import { isTerminalFocused } from "../lib/terminalFocus";
import {
  type ComposerImageAttachment,
  type DraftWorkspaceEnvMode,
  type PersistedComposerImageAttachment,
  useComposerDraftStore,
  useEffectiveComposerModelState,
  useComposerWorkspaceDraft,
} from "../composerDraftStore";
import {
  appendTerminalContextsToPrompt,
  formatTerminalContextLabel,
  insertInlineTerminalContextPlaceholder,
  removeInlineTerminalContextPlaceholder,
  type TerminalContextDraft,
  type TerminalContextSelection,
} from "../lib/terminalContext";
import { deriveLatestContextWindowSnapshot } from "../lib/contextWindow";
import {
  resolveComposerFooterContentWidth,
  shouldForceCompactComposerFooterForFit,
  shouldUseCompactComposerPrimaryActions,
  shouldUseCompactComposerFooter,
} from "./composerFooterLayout";
import { selectWorkspaceTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./ComposerPromptEditor";
import { PullRequestWorkspaceDialog } from "./PullRequestWorkspaceDialog";
import { MessagesTimeline } from "./chat/MessagesTimeline";
import { ChatHeader } from "./chat/ChatHeader";
import { ContextWindowMeter } from "./chat/ContextWindowMeter";
import { buildExpandedImagePreview, ExpandedImagePreview } from "./chat/ExpandedImagePreview";
import { AVAILABLE_PROVIDER_OPTIONS, ProviderModelPicker } from "./chat/ProviderModelPicker";
import { WorkspaceTabBar } from "./chat/WorkspaceTabBar";
import {
  makeDiffTab,
  makeProviderTab,
  makeTerminalTab,
  nextTerminalTabLabel,
  useWorkspaceTabStore,
  type TabKind,
} from "../workspaceTabStore";
import { ComposerCommandItem, ComposerCommandMenu } from "./chat/ComposerCommandMenu";
import { ComposerPendingApprovalActions } from "./chat/ComposerPendingApprovalActions";
import { CompactComposerControlsMenu } from "./chat/CompactComposerControlsMenu";
import { ComposerPrimaryActions } from "./chat/ComposerPrimaryActions";
import { ComposerPendingApprovalPanel } from "./chat/ComposerPendingApprovalPanel";
import { ComposerPendingUserInputPanel } from "./chat/ComposerPendingUserInputPanel";
import { ComposerPlanFollowUpBanner } from "./chat/ComposerPlanFollowUpBanner";
import {
  getComposerProviderState,
  renderProviderTraitsMenuContent,
  renderProviderTraitsPicker,
} from "./chat/composerProviderRegistry";
import { ProviderStatusBanner } from "./chat/ProviderStatusBanner";
import { WorkspaceErrorBanner } from "./chat/WorkspaceErrorBanner";
import { DiffWorkerPoolProvider } from "./DiffWorkerPoolProvider";

const LazyDiffFileTab = lazy(() => import("./DiffFileTab"));

function DiffFileTabLazy(props: React.ComponentProps<typeof LazyDiffFileTab>) {
  return (
    <DiffWorkerPoolProvider>
      <Suspense
        fallback={
          <div className="flex h-full min-w-0 flex-1 items-center justify-center text-xs text-muted-foreground/70">
            Loading diff...
          </div>
        }
      >
        <LazyDiffFileTab {...props} />
      </Suspense>
    </DiffWorkerPoolProvider>
  );
}
import {
  buildExpiredTerminalContextToastCopy,
  buildLocalDraftWorkspace,
  cloneComposerImageForRetry,
  collectUserMessageBlobPreviewUrls,
  createLocalDispatchSnapshot,
  deriveComposerSendState,
  hasServerAcknowledgedLocalDispatch,
  LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
  LastInvokedScriptByProjectSchema,
  type LocalDispatchSnapshot,
  PullRequestDialogState,
  readFileAsDataUrl,
  revokeBlobPreviewUrl,
  revokeUserMessagePreviewUrls,
  waitForStartedServerWorkspace,
} from "./ChatView.logic";
import { buildTemporaryWorktreeBranchName } from "../worktree";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import {
  useServerAvailableEditors,
  useServerConfig,
  useServerKeybindings,
} from "~/rpc/serverState";
import { sanitizeWorkspaceErrorMessage } from "~/rpc/transportError";

const ATTACHMENT_PREVIEW_HANDOFF_TTL_MS = 5000;
const IMAGE_SIZE_LIMIT_LABEL = `${Math.round(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES / (1024 * 1024))}MB`;
const IMAGE_ONLY_BOOTSTRAP_PROMPT =
  "[User attached one or more images without additional text. Respond using the conversation context and the attached image(s).]";
const EMPTY_ACTIVITIES: OrchestrationWorkspaceActivity[] = [];
const EMPTY_PROJECT_ENTRIES: ProjectEntry[] = [];
const EMPTY_PROVIDERS: ServerProvider[] = [];
const EMPTY_PENDING_USER_INPUT_ANSWERS: Record<string, PendingUserInputDraftAnswer> = {};
const CLAUDE_BUILT_IN_SLASH_COMMANDS = [
  { command: "/add-dir", description: "Add an additional working directory." },
  { command: "/agents", description: "Manage Claude subagents." },
  {
    command: "/btw",
    description: "Ask a quick side question without interrupting the main conversation.",
  },
  { command: "/bug", description: "Report a bug to Anthropic." },
  { command: "/clear", description: "Clear the current conversation." },
  { command: "/compact", description: "Compact the current conversation context." },
  { command: "/config", description: "Open Claude Code configuration." },
  { command: "/cost", description: "Show token and cost usage." },
  { command: "/doctor", description: "Run Claude Code diagnostics." },
  { command: "/help", description: "Show Claude Code help." },
  { command: "/init", description: "Initialize Claude Code project files." },
  { command: "/login", description: "Authenticate Claude Code." },
  { command: "/logout", description: "Log out of Claude Code." },
  { command: "/mcp", description: "Inspect MCP server status." },
  { command: "/memory", description: "Inspect or edit Claude memory files." },
  { command: "/model", description: "Switch the active Claude model." },
  { command: "/permissions", description: "Review tool permissions." },
  { command: "/pr_comments", description: "Load pull request comments into context." },
  { command: "/review", description: "Review the current changes." },
  { command: "/status", description: "Show current Claude session status." },
  { command: "/terminal-setup", description: "Configure terminal integration." },
  { command: "/vim", description: "Toggle Vim mode." },
] satisfies ReadonlyArray<{ command: string; description: string }>;

type WorkspacePlanCatalogEntry = Pick<Workspace, "id" | "proposedPlans">;

const MAX_WORKSPACE_PLAN_CATALOG_CACHE_ENTRIES = 500;
const MAX_WORKSPACE_PLAN_CATALOG_CACHE_MEMORY_BYTES = 512 * 1024;
const workspacePlanCatalogCache = new LRUCache<{
  proposedPlans: Workspace["proposedPlans"];
  entry: WorkspacePlanCatalogEntry;
}>(MAX_WORKSPACE_PLAN_CATALOG_CACHE_ENTRIES, MAX_WORKSPACE_PLAN_CATALOG_CACHE_MEMORY_BYTES);

function estimateWorkspacePlanCatalogEntrySize(workspace: Workspace): number {
  return Math.max(
    64,
    workspace.id.length +
      workspace.proposedPlans.reduce(
        (total, plan) =>
          total +
          plan.id.length +
          plan.planMarkdown.length +
          plan.updatedAt.length +
          (plan.turnId?.length ?? 0),
        0,
      ),
  );
}

function toWorkspacePlanCatalogEntry(workspace: Workspace): WorkspacePlanCatalogEntry {
  const cached = workspacePlanCatalogCache.get(workspace.id);
  if (cached && cached.proposedPlans === workspace.proposedPlans) {
    return cached.entry;
  }

  const entry: WorkspacePlanCatalogEntry = {
    id: workspace.id,
    proposedPlans: workspace.proposedPlans,
  };
  workspacePlanCatalogCache.set(
    workspace.id,
    {
      proposedPlans: workspace.proposedPlans,
      entry,
    },
    estimateWorkspacePlanCatalogEntrySize(workspace),
  );
  return entry;
}

function useWorkspacePlanCatalog(
  workspaceIds: readonly WorkspaceId[],
): WorkspacePlanCatalogEntry[] {
  const selector = useMemo(() => {
    let previousWorkspaces: Array<Workspace | undefined> | null = null;
    let previousEntries: WorkspacePlanCatalogEntry[] = [];

    return (state: { workspaces: Workspace[] }): WorkspacePlanCatalogEntry[] => {
      const nextWorkspaces = workspaceIds.map((workspaceId) =>
        state.workspaces.find((workspace) => workspace.id === workspaceId),
      );
      const cachedWorkspaces = previousWorkspaces;
      if (
        cachedWorkspaces &&
        nextWorkspaces.length === cachedWorkspaces.length &&
        nextWorkspaces.every((workspace, index) => workspace === cachedWorkspaces[index])
      ) {
        return previousEntries;
      }

      previousWorkspaces = nextWorkspaces;
      previousEntries = nextWorkspaces.flatMap((workspace) =>
        workspace ? [toWorkspacePlanCatalogEntry(workspace)] : [],
      );
      return previousEntries;
    };
  }, [workspaceIds]);

  return useStore(selector);
}

function formatOutgoingPrompt(params: {
  provider: ProviderKind;
  model: string | null;
  models: ReadonlyArray<ServerProvider["models"][number]>;
  effort: string | null;
  text: string;
}): string {
  const caps = getProviderModelCapabilities(params.models, params.model, params.provider);
  if (
    params.effort &&
    caps.promptInjectedEffortLevels.includes(params.effort) &&
    !isLeadingSlashCommandInput(params.text)
  ) {
    return applyClaudePromptEffortPrefix(params.text, params.effort as ClaudeCodeEffort | null);
  }
  return params.text;
}
const COMPOSER_PATH_QUERY_DEBOUNCE_MS = 120;
const SCRIPT_TERMINAL_COLS = 120;
const SCRIPT_TERMINAL_ROWS = 30;

const extendReplacementRangeForTrailingSpace = (
  text: string,
  rangeEnd: number,
  replacement: string,
): number => {
  if (!replacement.endsWith(" ")) {
    return rangeEnd;
  }
  return text[rangeEnd] === " " ? rangeEnd + 1 : rangeEnd;
};

const syncTerminalContextsByIds = (
  contexts: ReadonlyArray<TerminalContextDraft>,
  ids: ReadonlyArray<string>,
): TerminalContextDraft[] => {
  const contextsById = new Map(contexts.map((context) => [context.id, context]));
  return ids.flatMap((id) => {
    const context = contextsById.get(id);
    return context ? [context] : [];
  });
};

const terminalContextIdListsEqual = (
  contexts: ReadonlyArray<TerminalContextDraft>,
  ids: ReadonlyArray<string>,
): boolean =>
  contexts.length === ids.length && contexts.every((context, index) => context.id === ids[index]);

interface ChatViewProps {
  workspaceId: WorkspaceId;
}

interface TerminalLaunchContext {
  workspaceId: WorkspaceId;
  cwd: string;
  worktreePath: string | null;
}

type PersistentTerminalLaunchContext = Pick<TerminalLaunchContext, "cwd" | "worktreePath">;

function useLocalDispatchState(input: {
  activeWorkspace: Workspace | undefined;
  activeLatestTurn: Workspace["latestTurn"] | null;
  phase: SessionPhase;
  activePendingApproval: ApprovalRequestId | null;
  activePendingUserInput: ApprovalRequestId | null;
  workspaceError: string | null | undefined;
}) {
  const [localDispatch, setLocalDispatch] = useState<LocalDispatchSnapshot | null>(null);

  const beginLocalDispatch = useCallback(
    (options?: { preparingWorktree?: boolean }) => {
      const preparingWorktree = Boolean(options?.preparingWorktree);
      setLocalDispatch((current) => {
        if (current) {
          return current.preparingWorktree === preparingWorktree
            ? current
            : { ...current, preparingWorktree };
        }
        return createLocalDispatchSnapshot(input.activeWorkspace, options);
      });
    },
    [input.activeWorkspace],
  );

  const resetLocalDispatch = useCallback(() => {
    setLocalDispatch(null);
  }, []);

  const serverAcknowledgedLocalDispatch = useMemo(
    () =>
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: input.phase,
        latestTurn: input.activeLatestTurn,
        session: input.activeWorkspace?.session ?? null,
        hasPendingApproval: input.activePendingApproval !== null,
        hasPendingUserInput: input.activePendingUserInput !== null,
        workspaceError: input.workspaceError,
      }),
    [
      input.activeLatestTurn,
      input.activePendingApproval,
      input.activePendingUserInput,
      input.activeWorkspace?.session,
      input.phase,
      input.workspaceError,
      localDispatch,
    ],
  );

  useEffect(() => {
    if (!serverAcknowledgedLocalDispatch) {
      return;
    }
    resetLocalDispatch();
  }, [resetLocalDispatch, serverAcknowledgedLocalDispatch]);

  return {
    beginLocalDispatch,
    resetLocalDispatch,
    localDispatchStartedAt: localDispatch?.startedAt ?? null,
    isPreparingWorktree: localDispatch?.preparingWorktree ?? false,
    isSendBusy: localDispatch !== null && !serverAcknowledgedLocalDispatch,
  };
}

interface PersistentWorkspaceTerminalDrawerProps {
  workspaceId: WorkspaceId;
  /** When provided, the drawer renders only this terminal (tab-per-terminal mode). */
  terminalId?: string;
  visible: boolean;
  mode?: "drawer" | "inline";
  launchContext: PersistentTerminalLaunchContext | null;
  focusRequestId: number;
  splitShortcutLabel: string | undefined;
  newShortcutLabel: string | undefined;
  closeShortcutLabel: string | undefined;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
  /** Called when the user requests a new terminal (creates a new tab in inline/tab mode). */
  onNewTerminalTab?: (() => void) | undefined;
  /** Called when the user closes the terminal (closes the tab in inline/tab mode). */
  onCloseTerminalTab?: (() => void) | undefined;
}

function PersistentWorkspaceTerminalDrawer({
  workspaceId,
  terminalId: terminalIdProp,
  visible,
  mode = "drawer",
  launchContext,
  focusRequestId,
  splitShortcutLabel,
  newShortcutLabel,
  closeShortcutLabel,
  onAddTerminalContext,
  onNewTerminalTab,
  onCloseTerminalTab,
}: PersistentWorkspaceTerminalDrawerProps) {
  const serverWorkspace = useWorkspaceById(workspaceId);
  const draftWorkspace = useComposerDraftStore(
    (store) => store.draftWorkspacesByWorkspaceId[workspaceId] ?? null,
  );
  const project = useProjectById(serverWorkspace?.projectId ?? draftWorkspace?.projectId);
  const terminalState = useTerminalStateStore((state) =>
    selectWorkspaceTerminalState(state.terminalStateByWorkspaceId, workspaceId),
  );
  const storeSetTerminalHeight = useTerminalStateStore((state) => state.setTerminalHeight);
  const storeSplitTerminal = useTerminalStateStore((state) => state.splitTerminal);
  const storeNewTerminal = useTerminalStateStore((state) => state.newTerminal);
  const storeSetActiveTerminal = useTerminalStateStore((state) => state.setActiveTerminal);
  const storeCloseTerminal = useTerminalStateStore((state) => state.closeTerminal);
  const [localFocusRequestId, setLocalFocusRequestId] = useState(0);
  const worktreePath = serverWorkspace?.worktreePath ?? draftWorkspace?.worktreePath ?? null;
  const effectiveWorktreePath = useMemo(() => {
    if (launchContext !== null) {
      return launchContext.worktreePath;
    }
    return worktreePath;
  }, [launchContext, worktreePath]);
  const cwd = useMemo(
    () =>
      launchContext?.cwd ??
      (project
        ? projectScriptCwd({
            project: { cwd: project.cwd },
            worktreePath: effectiveWorktreePath,
          })
        : null),
    [effectiveWorktreePath, launchContext?.cwd, project],
  );
  const runtimeEnv = useMemo(
    () =>
      project
        ? projectScriptRuntimeEnv({
            project: { cwd: project.cwd },
            worktreePath: effectiveWorktreePath,
          })
        : {},
    [effectiveWorktreePath, project],
  );

  // When a terminalId prop is provided (tab-per-terminal mode), scope to just that terminal.
  const isScopedToSingleTerminal = terminalIdProp !== undefined;
  const scopedTerminalIds = useMemo(
    () => (isScopedToSingleTerminal ? [terminalIdProp] : terminalState.terminalIds),
    [isScopedToSingleTerminal, terminalIdProp, terminalState.terminalIds],
  );
  const scopedActiveTerminalId = isScopedToSingleTerminal
    ? terminalIdProp
    : terminalState.activeTerminalId;
  const scopedTerminalGroups = useMemo(
    () =>
      isScopedToSingleTerminal
        ? [{ id: `group-${terminalIdProp}`, terminalIds: [terminalIdProp] }]
        : terminalState.terminalGroups,
    [isScopedToSingleTerminal, terminalIdProp, terminalState.terminalGroups],
  );
  const scopedActiveTerminalGroupId = isScopedToSingleTerminal
    ? `group-${terminalIdProp}`
    : terminalState.activeTerminalGroupId;

  const bumpFocusRequestId = useCallback(() => {
    if (!visible) {
      return;
    }
    setLocalFocusRequestId((value) => value + 1);
  }, [visible]);

  const setTerminalHeight = useCallback(
    (height: number) => {
      storeSetTerminalHeight(workspaceId, height);
    },
    [storeSetTerminalHeight, workspaceId],
  );

  const splitTerminal = useCallback(() => {
    storeSplitTerminal(workspaceId, `terminal-${randomUUID()}`);
    bumpFocusRequestId();
  }, [bumpFocusRequestId, storeSplitTerminal, workspaceId]);

  const handleNewTerminal = useCallback(() => {
    if (onNewTerminalTab) {
      // Tab-per-terminal mode: create a new tab via the parent.
      onNewTerminalTab();
    } else {
      // Legacy drawer mode: create a new terminal in the store.
      storeNewTerminal(workspaceId, `terminal-${randomUUID()}`);
      bumpFocusRequestId();
    }
  }, [bumpFocusRequestId, onNewTerminalTab, storeNewTerminal, workspaceId]);

  const activateTerminal = useCallback(
    (terminalId: string) => {
      storeSetActiveTerminal(workspaceId, terminalId);
      bumpFocusRequestId();
    },
    [bumpFocusRequestId, storeSetActiveTerminal, workspaceId],
  );

  const closeTerminal = useCallback(
    (terminalId: string) => {
      const api = readNativeApi();
      if (!api) return;

      if ("close" in api.terminal && typeof api.terminal.close === "function") {
        void api.terminal
          .close({ workspaceId, terminalId, deleteHistory: true })
          .catch(() =>
            api.terminal.write({ workspaceId, terminalId, data: "exit\n" }).catch(() => undefined),
          );
      } else {
        void api.terminal.write({ workspaceId, terminalId, data: "exit\n" }).catch(() => undefined);
      }

      storeCloseTerminal(workspaceId, terminalId);

      if (isScopedToSingleTerminal && onCloseTerminalTab) {
        // Tab-per-terminal mode: close the tab.
        onCloseTerminalTab();
      } else {
        bumpFocusRequestId();
      }
    },
    [
      bumpFocusRequestId,
      isScopedToSingleTerminal,
      onCloseTerminalTab,
      storeCloseTerminal,
      workspaceId,
    ],
  );

  const handleAddTerminalContext = useCallback(
    (selection: TerminalContextSelection) => {
      if (!visible) {
        return;
      }
      onAddTerminalContext(selection);
    },
    [onAddTerminalContext, visible],
  );

  if (!project || (!terminalState.terminalOpen && mode !== "inline") || !cwd) {
    return null;
  }

  return (
    <div
      className={cn(
        visible ? undefined : "hidden",
        mode === "inline" && "flex min-h-0 flex-1 flex-col",
      )}
    >
      <WorkspaceTerminalDrawer
        workspaceId={workspaceId}
        cwd={cwd}
        worktreePath={effectiveWorktreePath}
        runtimeEnv={runtimeEnv}
        visible={visible}
        mode={mode}
        height={terminalState.terminalHeight}
        terminalIds={scopedTerminalIds}
        activeTerminalId={scopedActiveTerminalId}
        terminalGroups={scopedTerminalGroups}
        activeTerminalGroupId={scopedActiveTerminalGroupId}
        focusRequestId={focusRequestId + localFocusRequestId + (visible ? 1 : 0)}
        onSplitTerminal={splitTerminal}
        onNewTerminal={handleNewTerminal}
        splitShortcutLabel={visible ? splitShortcutLabel : undefined}
        newShortcutLabel={visible ? newShortcutLabel : undefined}
        closeShortcutLabel={visible ? closeShortcutLabel : undefined}
        onActiveTerminalChange={activateTerminal}
        onCloseTerminal={closeTerminal}
        onHeightChange={setTerminalHeight}
        onAddTerminalContext={handleAddTerminalContext}
      />
    </div>
  );
}

export default function ChatView({ workspaceId: routeWorkspaceId }: ChatViewProps) {
  const { open: sidebarOpen } = useSidebar();
  const navigate = useNavigate();
  const workspaceWorkspaceId = useWorkspaceTabStore(
    (s) => s.findWorkspaceWorkspaceIdByProviderWorkspaceId(routeWorkspaceId) ?? routeWorkspaceId,
  );
  const tabState = useWorkspaceTabStore((s) => s.getOrInitTabs(workspaceWorkspaceId));
  const activeTab = useMemo(
    () => tabState.tabs.find((t) => t.id === tabState.activeTabId) ?? tabState.tabs[0],
    [tabState],
  );
  const workspaceId =
    activeTab?.kind === "provider"
      ? (activeTab.workspaceId ?? workspaceWorkspaceId)
      : workspaceWorkspaceId;
  const serverWorkspace = useWorkspaceById(workspaceId);
  const setStoreWorkspaceError = useStore((store) => store.setError);
  const markWorkspaceVisited = useUiStateStore((store) => store.markWorkspaceVisited);
  const activeWorkspaceLastVisitedAt = useUiStateStore(
    (store) => store.workspaceLastVisitedAtById[workspaceId],
  );
  const settings = useSettings();
  const setStickyComposerModelSelection = useComposerDraftStore(
    (store) => store.setStickyModelSelection,
  );
  const timestampFormat = settings.timestampFormat;
  const rawSearch = useSearch({
    strict: false,
    select: (params) => parseSourceControlRouteSearch(params),
  });
  const { resolvedTheme } = useTheme();
  const composerDraft = useComposerWorkspaceDraft(workspaceId);
  const prompt = composerDraft.prompt;
  const composerImages = composerDraft.images;
  const composerTerminalContexts = composerDraft.terminalContexts;
  const composerSendState = useMemo(
    () =>
      deriveComposerSendState({
        prompt,
        imageCount: composerImages.length,
        terminalContexts: composerTerminalContexts,
      }),
    [composerImages.length, composerTerminalContexts, prompt],
  );
  const nonPersistedComposerImageIds = composerDraft.nonPersistedImageIds;
  const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
  const setComposerDraftModelSelection = useComposerDraftStore((store) => store.setModelSelection);
  const setComposerDraftRuntimeMode = useComposerDraftStore((store) => store.setRuntimeMode);
  const setComposerDraftInteractionMode = useComposerDraftStore(
    (store) => store.setInteractionMode,
  );
  const addComposerDraftImage = useComposerDraftStore((store) => store.addImage);
  const addComposerDraftImages = useComposerDraftStore((store) => store.addImages);
  const removeComposerDraftImage = useComposerDraftStore((store) => store.removeImage);
  const insertComposerDraftTerminalContext = useComposerDraftStore(
    (store) => store.insertTerminalContext,
  );
  const addComposerDraftTerminalContexts = useComposerDraftStore(
    (store) => store.addTerminalContexts,
  );
  const removeComposerDraftTerminalContext = useComposerDraftStore(
    (store) => store.removeTerminalContext,
  );
  const setComposerDraftTerminalContexts = useComposerDraftStore(
    (store) => store.setTerminalContexts,
  );
  const clearComposerDraftPersistedAttachments = useComposerDraftStore(
    (store) => store.clearPersistedAttachments,
  );
  const syncComposerDraftPersistedAttachments = useComposerDraftStore(
    (store) => store.syncPersistedAttachments,
  );
  const clearComposerDraftContent = useComposerDraftStore((store) => store.clearComposerContent);
  const setDraftWorkspaceContext = useComposerDraftStore((store) => store.setDraftWorkspaceContext);
  const getDraftWorkspaceByProjectId = useComposerDraftStore(
    (store) => store.getDraftWorkspaceByProjectId,
  );
  const getDraftWorkspace = useComposerDraftStore((store) => store.getDraftWorkspace);
  const setProjectDraftWorkspaceId = useComposerDraftStore(
    (store) => store.setProjectDraftWorkspaceId,
  );
  const clearProjectDraftWorkspaceId = useComposerDraftStore(
    (store) => store.clearProjectDraftWorkspaceId,
  );
  const draftWorkspace = useComposerDraftStore(
    (store) => store.draftWorkspacesByWorkspaceId[workspaceId] ?? null,
  );
  const promptRef = useRef(prompt);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [isDragOverComposer, setIsDragOverComposer] = useState(false);
  const [expandedImage, setExpandedImage] = useState<ExpandedImagePreview | null>(null);
  const [optimisticUserMessages, setOptimisticUserMessages] = useState<ChatMessage[]>([]);
  const optimisticUserMessagesRef = useRef(optimisticUserMessages);
  optimisticUserMessagesRef.current = optimisticUserMessages;
  const composerTerminalContextsRef = useRef<TerminalContextDraft[]>(composerTerminalContexts);
  const [localDraftErrorsByWorkspaceId, setLocalDraftErrorsByWorkspaceId] = useState<
    Record<WorkspaceId, string | null>
  >({});
  const [isConnecting, _setIsConnecting] = useState(false);
  const [isRevertingCheckpoint, setIsRevertingCheckpoint] = useState(false);
  const [respondingRequestIds, setRespondingRequestIds] = useState<ApprovalRequestId[]>([]);
  const [respondingUserInputRequestIds, setRespondingUserInputRequestIds] = useState<
    ApprovalRequestId[]
  >([]);
  const [pendingUserInputAnswersByRequestId, setPendingUserInputAnswersByRequestId] = useState<
    Record<string, Record<string, PendingUserInputDraftAnswer>>
  >({});
  const [pendingUserInputQuestionIndexByRequestId, setPendingUserInputQuestionIndexByRequestId] =
    useState<Record<string, number>>({});
  const [expandedWorkGroups, setExpandedWorkGroups] = useState<Record<string, boolean>>({});
  const [planSidebarOpen, setPlanSidebarOpen] = useState(false);
  const [isComposerFooterCompact, setIsComposerFooterCompact] = useState(false);
  const [isComposerPrimaryActionsCompact, setIsComposerPrimaryActionsCompact] = useState(false);
  // Tracks whether the user explicitly dismissed the sidebar for the active turn.
  const planSidebarDismissedForTurnRef = useRef<string | null>(null);
  // When set, the workspace-change reset effect will open the sidebar instead of closing it.
  // Used by "Implement in a new workspace" to carry the sidebar-open intent across navigation.
  const planSidebarOpenOnNextWorkspaceRef = useRef(false);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [terminalFocusRequestId, setTerminalFocusRequestId] = useState(0);
  const [composerHighlightedItemId, setComposerHighlightedItemId] = useState<string | null>(null);
  const [pullRequestDialogState, setPullRequestDialogState] =
    useState<PullRequestDialogState | null>(null);
  const [terminalLaunchContext, setTerminalLaunchContext] = useState<TerminalLaunchContext | null>(
    null,
  );
  const [attachmentPreviewHandoffByMessageId, setAttachmentPreviewHandoffByMessageId] = useState<
    Record<string, string[]>
  >({});
  const [composerCursor, setComposerCursor] = useState(() =>
    collapseExpandedComposerCursor(prompt, prompt.length),
  );
  const [composerTrigger, setComposerTrigger] = useState<ComposerTrigger | null>(() =>
    detectComposerTrigger(prompt, prompt.length),
  );
  const [lastInvokedScriptByProjectId, setLastInvokedScriptByProjectId] = useLocalStorage(
    LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
    {},
    LastInvokedScriptByProjectSchema,
  );
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const [messagesScrollElement, setMessagesScrollElement] = useState<HTMLDivElement | null>(null);
  const shouldAutoScrollRef = useRef(true);
  const lastKnownScrollTopRef = useRef(0);
  const isPointerScrollActiveRef = useRef(false);
  const lastTouchClientYRef = useRef<number | null>(null);
  const pendingUserScrollUpIntentRef = useRef(false);
  const pendingAutoScrollFrameRef = useRef<number | null>(null);
  const pendingInteractionAnchorRef = useRef<{
    element: HTMLElement;
    top: number;
  } | null>(null);
  const pendingInteractionAnchorFrameRef = useRef<number | null>(null);
  const composerEditorRef = useRef<ComposerPromptEditorHandle>(null);
  const composerFormRef = useRef<HTMLFormElement>(null);
  const composerFormHeightRef = useRef(0);
  const composerFooterRef = useRef<HTMLDivElement>(null);
  const composerFooterLeadingRef = useRef<HTMLDivElement>(null);
  const composerFooterActionsRef = useRef<HTMLDivElement>(null);
  const composerImagesRef = useRef<ComposerImageAttachment[]>([]);
  const composerSelectLockRef = useRef(false);
  const composerMenuOpenRef = useRef(false);
  const composerMenuItemsRef = useRef<ComposerCommandItem[]>([]);
  const activeComposerMenuItemRef = useRef<ComposerCommandItem | null>(null);
  const attachmentPreviewHandoffByMessageIdRef = useRef<Record<string, string[]>>({});
  const attachmentPreviewHandoffTimeoutByMessageIdRef = useRef<Record<string, number>>({});
  const sendInFlightRef = useRef(false);
  const dragDepthRef = useRef(0);
  const setMessagesScrollContainerRef = useCallback((element: HTMLDivElement | null) => {
    messagesScrollRef.current = element;
    setMessagesScrollElement(element);
  }, []);

  const terminalStateByWorkspaceId = useTerminalStateStore(
    (state) => state.terminalStateByWorkspaceId,
  );
  const terminalState = useMemo(
    () => selectWorkspaceTerminalState(terminalStateByWorkspaceId, workspaceId),
    [terminalStateByWorkspaceId, workspaceId],
  );
  const storeSplitTerminal = useTerminalStateStore((s) => s.splitTerminal);
  const storeEnsureTerminal = useTerminalStateStore((s) => s.ensureTerminal);
  const storeCloseTerminal = useTerminalStateStore((s) => s.closeTerminal);
  const storeServerTerminalLaunchContext = useTerminalStateStore(
    (s) => s.terminalLaunchContextByWorkspaceId[workspaceId] ?? null,
  );

  const storeClearTerminalLaunchContext = useTerminalStateStore(
    (s) => s.clearTerminalLaunchContext,
  );

  const setPrompt = useCallback(
    (nextPrompt: string) => {
      setComposerDraftPrompt(workspaceId, nextPrompt);
    },
    [setComposerDraftPrompt, workspaceId],
  );
  const addComposerImage = useCallback(
    (image: ComposerImageAttachment) => {
      addComposerDraftImage(workspaceId, image);
    },
    [addComposerDraftImage, workspaceId],
  );
  const addComposerImagesToDraft = useCallback(
    (images: ComposerImageAttachment[]) => {
      addComposerDraftImages(workspaceId, images);
    },
    [addComposerDraftImages, workspaceId],
  );
  const addComposerTerminalContextsToDraft = useCallback(
    (contexts: TerminalContextDraft[]) => {
      addComposerDraftTerminalContexts(workspaceId, contexts);
    },
    [addComposerDraftTerminalContexts, workspaceId],
  );
  const removeComposerImageFromDraft = useCallback(
    (imageId: string) => {
      removeComposerDraftImage(workspaceId, imageId);
    },
    [removeComposerDraftImage, workspaceId],
  );
  const removeComposerTerminalContextFromDraft = useCallback(
    (contextId: string) => {
      const contextIndex = composerTerminalContexts.findIndex(
        (context) => context.id === contextId,
      );
      if (contextIndex < 0) {
        return;
      }
      const nextPrompt = removeInlineTerminalContextPlaceholder(promptRef.current, contextIndex);
      promptRef.current = nextPrompt.prompt;
      setPrompt(nextPrompt.prompt);
      removeComposerDraftTerminalContext(workspaceId, contextId);
      setComposerCursor(nextPrompt.cursor);
      setComposerTrigger(
        detectComposerTrigger(
          nextPrompt.prompt,
          expandCollapsedComposerCursor(nextPrompt.prompt, nextPrompt.cursor),
        ),
      );
    },
    [composerTerminalContexts, removeComposerDraftTerminalContext, setPrompt, workspaceId],
  );

  const fallbackDraftProject = useProjectById(draftWorkspace?.projectId);
  const localDraftError = serverWorkspace
    ? null
    : (localDraftErrorsByWorkspaceId[workspaceId] ?? null);
  const localDraftWorkspace = useMemo(
    () =>
      draftWorkspace
        ? buildLocalDraftWorkspace(
            workspaceId,
            draftWorkspace,
            fallbackDraftProject?.defaultModelSelection ?? {
              provider: "codex",
              model: DEFAULT_MODEL_BY_PROVIDER.codex,
            },
            localDraftError,
          )
        : undefined,
    [draftWorkspace, fallbackDraftProject?.defaultModelSelection, localDraftError, workspaceId],
  );
  const activeWorkspace = serverWorkspace ?? localDraftWorkspace;
  const runtimeMode =
    composerDraft.runtimeMode ?? activeWorkspace?.runtimeMode ?? DEFAULT_RUNTIME_MODE;
  const interactionMode =
    composerDraft.interactionMode ?? activeWorkspace?.interactionMode ?? DEFAULT_INTERACTION_MODE;
  const isServerWorkspace = serverWorkspace !== undefined;
  const isLocalDraftWorkspace = !isServerWorkspace && localDraftWorkspace !== undefined;
  const canCheckoutPullRequestIntoWorkspace = isLocalDraftWorkspace;
  const sourceControlOpen = rawSearch.diff === "1";
  const activeWorkspaceId = activeWorkspace?.id ?? null;
  const activeLatestTurn = activeWorkspace?.latestTurn ?? null;
  const workspacePlanCatalog = useWorkspacePlanCatalog(
    useMemo(() => {
      const workspaceIds: WorkspaceId[] = [];
      if (activeWorkspace?.id) {
        workspaceIds.push(activeWorkspace.id);
      }
      const sourceWorkspaceId = activeLatestTurn?.sourceProposedPlan?.workspaceId;
      if (sourceWorkspaceId && sourceWorkspaceId !== activeWorkspace?.id) {
        workspaceIds.push(sourceWorkspaceId);
      }
      return workspaceIds;
    }, [activeLatestTurn?.sourceProposedPlan?.workspaceId, activeWorkspace?.id]),
  );
  const activeContextWindow = useMemo(
    () => deriveLatestContextWindowSnapshot(activeWorkspace?.activities ?? []),
    [activeWorkspace?.activities],
  );
  const latestTurnSettled = isLatestTurnSettled(activeLatestTurn, activeWorkspace?.session ?? null);
  const activeProject = useProjectById(activeWorkspace?.projectId);

  // -- Workspace tab state (keyed by the workspace root workspace id) --
  const activeProjectId = activeWorkspace?.projectId ?? null;
  const setActiveTab = useWorkspaceTabStore((s) => s.setActiveTab);
  const addTab = useWorkspaceTabStore((s) => s.addTab);
  const removeTab = useWorkspaceTabStore((s) => s.removeTab);
  const findTabByWorkspaceId = useWorkspaceTabStore((s) => s.findTabByWorkspaceId);
  const findTerminalTabByTerminalId = useWorkspaceTabStore((s) => s.findTerminalTabByTerminalId);
  const lastSyncedProviderTabWorkspaceIdRef = useRef<WorkspaceId | null>(null);
  const dismissedProviderWorkspaceIdsByWorkspaceRef = useRef<Record<string, Set<WorkspaceId>>>({});
  const currentWorkspaceProviderTab = activeWorkspaceId
    ? findTabByWorkspaceId(workspaceWorkspaceId, activeWorkspaceId)
    : undefined;
  const isWorkspaceRootWorkspace = activeWorkspaceId === workspaceWorkspaceId;
  const isWorkspaceDraftWorkspace = isLocalDraftWorkspace && isWorkspaceRootWorkspace;
  const isProviderTabActive = activeTab?.kind === "provider";
  const isTerminalTabActive = activeTab?.kind === "terminal";
  const isDiffTabActive = activeTab?.kind === "diff";
  const showWorkspaceSelectionState = activeTab === undefined;

  useEffect(() => {
    if (routeWorkspaceId === workspaceWorkspaceId) {
      return;
    }
    void navigate({
      to: "/$workspaceId",
      params: { workspaceId: workspaceWorkspaceId },
      replace: true,
      search: (previous) => previous,
    });
  }, [navigate, routeWorkspaceId, workspaceWorkspaceId]);

  useEffect(() => {
    if (!activeWorkspaceId || !activeWorkspace) {
      lastSyncedProviderTabWorkspaceIdRef.current = null;
      return;
    }

    const existingProviderTab = findTabByWorkspaceId(workspaceWorkspaceId, activeWorkspaceId);
    if (!existingProviderTab) {
      if (isWorkspaceDraftWorkspace) {
        return;
      }
      const dismissedProviderWorkspaceIds =
        dismissedProviderWorkspaceIdsByWorkspaceRef.current[workspaceWorkspaceId];
      if (dismissedProviderWorkspaceIds?.has(activeWorkspaceId)) {
        return;
      }
      addTab(
        workspaceWorkspaceId,
        makeProviderTab(activeWorkspace.modelSelection.provider, activeWorkspaceId),
      );
      return;
    }

    dismissedProviderWorkspaceIdsByWorkspaceRef.current[workspaceWorkspaceId]?.delete(
      activeWorkspaceId,
    );
    if (lastSyncedProviderTabWorkspaceIdRef.current !== activeWorkspaceId) {
      setActiveTab(workspaceWorkspaceId, existingProviderTab.id);
    }
    lastSyncedProviderTabWorkspaceIdRef.current = activeWorkspaceId;
  }, [
    activeWorkspace,
    activeWorkspaceId,
    addTab,
    findTabByWorkspaceId,
    isWorkspaceDraftWorkspace,
    setActiveTab,
    workspaceWorkspaceId,
  ]);

  /** Create a brand-new terminal tab and switch to it. */
  const createNewTerminalTab = useCallback(
    (terminalId?: string) => {
      const tid = terminalId ?? `terminal-${randomUUID()}`;
      const label = nextTerminalTabLabel(tabState?.tabs ?? []);
      const tab = makeTerminalTab(tid, label);
      if (activeWorkspaceId) {
        storeEnsureTerminal(activeWorkspaceId, tid, { open: true, active: false });
      }
      addTab(workspaceWorkspaceId, tab);
      if (routeWorkspaceId !== workspaceWorkspaceId) {
        void navigate({ to: "/$workspaceId", params: { workspaceId: workspaceWorkspaceId } });
      }
      setTerminalFocusRequestId((value) => value + 1);
      return tab;
    },
    [
      activeWorkspaceId,
      addTab,
      navigate,
      routeWorkspaceId,
      storeEnsureTerminal,
      tabState?.tabs,
      workspaceWorkspaceId,
    ],
  );

  /** Select the first existing terminal tab, or create one if none exist. */
  const openOrCreateTerminalTab = useCallback(() => {
    const existingTerminalTab = tabState?.tabs?.find((t) => t.kind === "terminal");
    if (existingTerminalTab) {
      setActiveTab(workspaceWorkspaceId, existingTerminalTab.id);
      if (routeWorkspaceId !== workspaceWorkspaceId) {
        void navigate({ to: "/$workspaceId", params: { workspaceId: workspaceWorkspaceId } });
      }
      setTerminalFocusRequestId((value) => value + 1);
    } else {
      createNewTerminalTab();
    }
  }, [
    createNewTerminalTab,
    navigate,
    routeWorkspaceId,
    setActiveTab,
    tabState?.tabs,
    workspaceWorkspaceId,
  ]);

  const handleSelectTab = useCallback(
    (tabId: string) => {
      setActiveTab(workspaceWorkspaceId, tabId);
      if (routeWorkspaceId !== workspaceWorkspaceId) {
        void navigate({ to: "/$workspaceId", params: { workspaceId: workspaceWorkspaceId } });
      }
    },
    [navigate, routeWorkspaceId, setActiveTab, workspaceWorkspaceId],
  );

  const handleCloseTab = useCallback(
    (tabId: string) => {
      const closedTab = tabState.tabs.find((t) => t.id === tabId);
      if (closedTab?.kind === "provider" && closedTab.workspaceId) {
        const dismissedProviderWorkspaceIds =
          dismissedProviderWorkspaceIdsByWorkspaceRef.current[workspaceWorkspaceId] ??
          new Set<WorkspaceId>();
        dismissedProviderWorkspaceIds.add(closedTab.workspaceId);
        dismissedProviderWorkspaceIdsByWorkspaceRef.current[workspaceWorkspaceId] =
          dismissedProviderWorkspaceIds;
      }
      // Clean up terminal session when closing a terminal tab.
      if (closedTab?.kind === "terminal" && closedTab.terminalId && activeWorkspaceId) {
        const api = readNativeApi();
        if (api && "close" in api.terminal && typeof api.terminal.close === "function") {
          void api.terminal
            .close({
              workspaceId: activeWorkspaceId,
              terminalId: closedTab.terminalId,
              deleteHistory: true,
            })
            .catch(() => undefined);
        }
        storeCloseTerminal(activeWorkspaceId, closedTab.terminalId);
      }
      removeTab(workspaceWorkspaceId, tabId);
      // If we closed the active tab, navigate to the next active tab's workspace.
      if (closedTab && tabState.activeTabId === tabId) {
        if (routeWorkspaceId !== workspaceWorkspaceId) {
          void navigate({ to: "/$workspaceId", params: { workspaceId: workspaceWorkspaceId } });
        }
      }
    },
    [
      activeWorkspaceId,
      navigate,
      removeTab,
      routeWorkspaceId,
      storeCloseTerminal,
      tabState,
      workspaceWorkspaceId,
    ],
  );

  const handleAddTab = useCallback(
    (kind: TabKind, provider?: ProviderKind) => {
      if (!activeProjectId) return;
      if (kind === "provider" && provider) {
        const store = useComposerDraftStore.getState();
        const nextEnvMode =
          draftWorkspace?.envMode ?? (activeWorkspace?.worktreePath ? "worktree" : "local");
        if (isWorkspaceDraftWorkspace && currentWorkspaceProviderTab) {
          setActiveTab(workspaceWorkspaceId, currentWorkspaceProviderTab.id);
          return;
        }
        const shouldReuseWorkspaceDraft =
          isWorkspaceDraftWorkspace && currentWorkspaceProviderTab === undefined;
        const nextWorkspaceId = shouldReuseWorkspaceDraft ? workspaceWorkspaceId : newWorkspaceId();
        if (shouldReuseWorkspaceDraft) {
          store.setDraftWorkspaceContext(nextWorkspaceId, {
            branch: activeWorkspace?.branch ?? null,
            worktreePath: activeWorkspace?.worktreePath ?? null,
            envMode: nextEnvMode,
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_INTERACTION_MODE,
          });
        } else {
          store.upsertDraftWorkspace(nextWorkspaceId, {
            projectId: activeProjectId,
            createdAt: new Date().toISOString(),
            branch: activeWorkspace?.branch ?? null,
            worktreePath: activeWorkspace?.worktreePath ?? null,
            envMode: nextEnvMode,
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_INTERACTION_MODE,
          });
        }
        // Set the provider for the new draft workspace.
        store.setModelSelection(nextWorkspaceId, {
          provider,
          model: DEFAULT_MODEL_BY_PROVIDER[provider],
        });
        dismissedProviderWorkspaceIdsByWorkspaceRef.current[workspaceWorkspaceId]?.delete(
          nextWorkspaceId,
        );
        const tab = makeProviderTab(provider, nextWorkspaceId);
        addTab(workspaceWorkspaceId, tab);
      } else if (kind === "terminal") {
        createNewTerminalTab();
      }
    },
    [
      activeProjectId,
      draftWorkspace?.envMode,
      activeWorkspace?.branch,
      activeWorkspace?.worktreePath,
      addTab,
      createNewTerminalTab,
      currentWorkspaceProviderTab,
      isWorkspaceDraftWorkspace,
      setActiveTab,
      workspaceWorkspaceId,
    ],
  );

  const canCloseTab = useCallback(() => true, []);

  const openPullRequestDialog = useCallback(
    (reference?: string) => {
      if (!canCheckoutPullRequestIntoWorkspace) {
        return;
      }
      setPullRequestDialogState({
        initialReference: reference ?? null,
        key: Date.now(),
      });
      setComposerHighlightedItemId(null);
    },
    [canCheckoutPullRequestIntoWorkspace],
  );

  const closePullRequestDialog = useCallback(() => {
    setPullRequestDialogState(null);
  }, []);

  const openOrReuseProjectDraftWorkspace = useCallback(
    async (input: {
      branch: string;
      worktreePath: string | null;
      envMode: DraftWorkspaceEnvMode;
    }) => {
      if (!activeProject) {
        throw new Error("No active project is available for this pull request.");
      }
      const storedDraftWorkspace = getDraftWorkspaceByProjectId(activeProject.id);
      if (storedDraftWorkspace) {
        setDraftWorkspaceContext(storedDraftWorkspace.workspaceId, input);
        setProjectDraftWorkspaceId(activeProject.id, storedDraftWorkspace.workspaceId, input);
        if (storedDraftWorkspace.workspaceId !== workspaceId) {
          await navigate({
            to: "/$workspaceId",
            params: { workspaceId: storedDraftWorkspace.workspaceId },
          });
        }
        return storedDraftWorkspace.workspaceId;
      }

      const activeDraftWorkspace = getDraftWorkspace(workspaceId);
      if (!isServerWorkspace && activeDraftWorkspace?.projectId === activeProject.id) {
        setDraftWorkspaceContext(workspaceId, input);
        setProjectDraftWorkspaceId(activeProject.id, workspaceId, input);
        return workspaceId;
      }

      clearProjectDraftWorkspaceId(activeProject.id);
      const nextWorkspaceId = newWorkspaceId();
      setProjectDraftWorkspaceId(activeProject.id, nextWorkspaceId, {
        createdAt: new Date().toISOString(),
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_INTERACTION_MODE,
        ...input,
      });
      await navigate({
        to: "/$workspaceId",
        params: { workspaceId: nextWorkspaceId },
      });
      return nextWorkspaceId;
    },
    [
      activeProject,
      clearProjectDraftWorkspaceId,
      getDraftWorkspace,
      getDraftWorkspaceByProjectId,
      isServerWorkspace,
      navigate,
      setDraftWorkspaceContext,
      setProjectDraftWorkspaceId,
      workspaceId,
    ],
  );

  const handlePreparedPullRequestWorkspace = useCallback(
    async (input: { branch: string; worktreePath: string | null }) => {
      await openOrReuseProjectDraftWorkspace({
        branch: input.branch,
        worktreePath: input.worktreePath,
        envMode: input.worktreePath ? "worktree" : "local",
      });
    },
    [openOrReuseProjectDraftWorkspace],
  );

  useEffect(() => {
    if (!serverWorkspace?.id) return;
    if (!latestTurnSettled) return;
    if (!activeLatestTurn?.completedAt) return;
    const turnCompletedAt = Date.parse(activeLatestTurn.completedAt);
    if (Number.isNaN(turnCompletedAt)) return;
    const lastVisitedAt = activeWorkspaceLastVisitedAt
      ? Date.parse(activeWorkspaceLastVisitedAt)
      : NaN;
    if (!Number.isNaN(lastVisitedAt) && lastVisitedAt >= turnCompletedAt) return;

    markWorkspaceVisited(serverWorkspace.id);
  }, [
    activeLatestTurn?.completedAt,
    activeWorkspaceLastVisitedAt,
    latestTurnSettled,
    markWorkspaceVisited,
    serverWorkspace?.id,
  ]);

  const selectedProviderByWorkspaceId = composerDraft.activeProvider ?? null;
  const workspaceProvider =
    activeWorkspace?.modelSelection.provider ??
    activeProject?.defaultModelSelection?.provider ??
    null;
  // Active tab's provider takes precedence for provider selection.
  const activeTabProvider: ProviderKind | null =
    activeTab?.kind === "provider" ? (activeTab.provider ?? null) : null;
  const serverConfig = useServerConfig();
  const providerStatuses = serverConfig?.providers ?? EMPTY_PROVIDERS;
  const unlockedSelectedProvider = resolveSelectableProvider(
    providerStatuses,
    activeTabProvider ?? selectedProviderByWorkspaceId ?? workspaceProvider ?? "codex",
  );
  const selectedProvider: ProviderKind = unlockedSelectedProvider;
  const { modelOptions: composerModelOptions, selectedModel } = useEffectiveComposerModelState({
    workspaceId,
    providers: providerStatuses,
    selectedProvider,
    workspaceModelSelection: activeWorkspace?.modelSelection,
    projectModelSelection: activeProject?.defaultModelSelection,
    settings,
  });
  const composerModelOptionsByProvider = useMemo(
    () =>
      getCustomModelOptionsByProvider(settings, providerStatuses, selectedProvider, selectedModel),
    [providerStatuses, selectedModel, selectedProvider, settings],
  );
  const selectedProviderModels = getProviderModels(providerStatuses, selectedProvider);
  const composerProviderState = useMemo(
    () =>
      getComposerProviderState({
        provider: selectedProvider,
        model: selectedModel,
        models: selectedProviderModels,
        prompt,
        modelOptions: composerModelOptions,
      }),
    [composerModelOptions, prompt, selectedModel, selectedProvider, selectedProviderModels],
  );
  const selectedPromptEffort = composerProviderState.promptEffort;
  const selectedModelOptionsForDispatch = composerProviderState.modelOptionsForDispatch;
  const selectedModelSelection = useMemo<ModelSelection>(
    () => ({
      provider: selectedProvider,
      model: selectedModel,
      ...(selectedModelOptionsForDispatch ? { options: selectedModelOptionsForDispatch } : {}),
    }),
    [selectedModel, selectedModelOptionsForDispatch, selectedProvider],
  );
  const phase = derivePhase(activeWorkspace?.session ?? null);
  const workspaceActivities = activeWorkspace?.activities ?? EMPTY_ACTIVITIES;
  const workLogEntries = useMemo(
    () => deriveWorkLogEntries(workspaceActivities, activeLatestTurn?.turnId ?? undefined),
    [activeLatestTurn?.turnId, workspaceActivities],
  );
  const latestTurnHasToolActivity = useMemo(
    () => hasToolActivityForTurn(workspaceActivities, activeLatestTurn?.turnId),
    [activeLatestTurn?.turnId, workspaceActivities],
  );
  const pendingApprovals = useMemo(
    () => derivePendingApprovals(workspaceActivities),
    [workspaceActivities],
  );
  const pendingUserInputs = useMemo(
    () => derivePendingUserInputs(workspaceActivities),
    [workspaceActivities],
  );
  const activePendingUserInput = pendingUserInputs[0] ?? null;
  const activePendingDraftAnswers = useMemo(
    () =>
      activePendingUserInput
        ? (pendingUserInputAnswersByRequestId[activePendingUserInput.requestId] ??
          EMPTY_PENDING_USER_INPUT_ANSWERS)
        : EMPTY_PENDING_USER_INPUT_ANSWERS,
    [activePendingUserInput, pendingUserInputAnswersByRequestId],
  );
  const activePendingQuestionIndex = activePendingUserInput
    ? (pendingUserInputQuestionIndexByRequestId[activePendingUserInput.requestId] ?? 0)
    : 0;
  const activePendingProgress = useMemo(
    () =>
      activePendingUserInput
        ? derivePendingUserInputProgress(
            activePendingUserInput.questions,
            activePendingDraftAnswers,
            activePendingQuestionIndex,
          )
        : null,
    [activePendingDraftAnswers, activePendingQuestionIndex, activePendingUserInput],
  );
  const activePendingResolvedAnswers = useMemo(
    () =>
      activePendingUserInput
        ? buildPendingUserInputAnswers(activePendingUserInput.questions, activePendingDraftAnswers)
        : null,
    [activePendingDraftAnswers, activePendingUserInput],
  );
  const activePendingIsResponding = activePendingUserInput
    ? respondingUserInputRequestIds.includes(activePendingUserInput.requestId)
    : false;
  const activeProposedPlan = useMemo(() => {
    if (!latestTurnSettled) {
      return null;
    }
    return findLatestProposedPlan(
      activeWorkspace?.proposedPlans ?? [],
      activeLatestTurn?.turnId ?? null,
    );
  }, [activeLatestTurn?.turnId, activeWorkspace?.proposedPlans, latestTurnSettled]);
  const sidebarProposedPlan = useMemo(
    () =>
      findSidebarProposedPlan({
        workspaces: workspacePlanCatalog,
        latestTurn: activeLatestTurn,
        latestTurnSettled,
        workspaceId: activeWorkspace?.id ?? null,
      }),
    [activeLatestTurn, activeWorkspace?.id, latestTurnSettled, workspacePlanCatalog],
  );
  const activePlan = useMemo(
    () => deriveActivePlanState(workspaceActivities, activeLatestTurn?.turnId ?? undefined),
    [activeLatestTurn?.turnId, workspaceActivities],
  );
  const showPlanFollowUpPrompt =
    pendingUserInputs.length === 0 &&
    interactionMode === "plan" &&
    latestTurnSettled &&
    hasActionableProposedPlan(activeProposedPlan);
  const activePendingApproval = pendingApprovals[0] ?? null;
  const {
    beginLocalDispatch,
    resetLocalDispatch,
    localDispatchStartedAt,
    isPreparingWorktree,
    isSendBusy,
  } = useLocalDispatchState({
    activeWorkspace,
    activeLatestTurn,
    phase,
    activePendingApproval: activePendingApproval?.requestId ?? null,
    activePendingUserInput: activePendingUserInput?.requestId ?? null,
    workspaceError: activeWorkspace?.error,
  });
  const isWorking = phase === "running" || isSendBusy || isConnecting || isRevertingCheckpoint;
  const nowIso = new Date(nowTick).toISOString();
  const activeWorkStartedAt = deriveActiveWorkStartedAt(
    activeLatestTurn,
    activeWorkspace?.session ?? null,
    localDispatchStartedAt,
  );
  const isComposerApprovalState = activePendingApproval !== null;
  const hasComposerHeader =
    isComposerApprovalState ||
    pendingUserInputs.length > 0 ||
    (showPlanFollowUpPrompt && activeProposedPlan !== null);
  const composerFooterHasWideActions = showPlanFollowUpPrompt || activePendingProgress !== null;
  const composerFooterActionLayoutKey = useMemo(() => {
    if (activePendingProgress) {
      return `pending:${activePendingProgress.questionIndex}:${activePendingProgress.isLastQuestion}:${activePendingIsResponding}`;
    }
    if (phase === "running") {
      return "running";
    }
    if (showPlanFollowUpPrompt) {
      return prompt.trim().length > 0 ? "plan:refine" : "plan:implement";
    }
    return `idle:${composerSendState.hasSendableContent}:${isSendBusy}:${isConnecting}:${isPreparingWorktree}`;
  }, [
    activePendingIsResponding,
    activePendingProgress,
    composerSendState.hasSendableContent,
    isConnecting,
    isPreparingWorktree,
    isSendBusy,
    phase,
    prompt,
    showPlanFollowUpPrompt,
  ]);
  const lastSyncedPendingInputRef = useRef<{
    requestId: string | null;
    questionId: string | null;
  } | null>(null);
  useEffect(() => {
    const nextCustomAnswer = activePendingProgress?.customAnswer;
    if (typeof nextCustomAnswer !== "string") {
      lastSyncedPendingInputRef.current = null;
      return;
    }
    const nextRequestId = activePendingUserInput?.requestId ?? null;
    const nextQuestionId = activePendingProgress?.activeQuestion?.id ?? null;
    const questionChanged =
      lastSyncedPendingInputRef.current?.requestId !== nextRequestId ||
      lastSyncedPendingInputRef.current?.questionId !== nextQuestionId;
    const textChangedExternally = promptRef.current !== nextCustomAnswer;

    lastSyncedPendingInputRef.current = {
      requestId: nextRequestId,
      questionId: nextQuestionId,
    };

    if (!questionChanged && !textChangedExternally) {
      return;
    }

    promptRef.current = nextCustomAnswer;
    const nextCursor = collapseExpandedComposerCursor(nextCustomAnswer, nextCustomAnswer.length);
    setComposerCursor(nextCursor);
    setComposerTrigger(
      detectComposerTrigger(
        nextCustomAnswer,
        expandCollapsedComposerCursor(nextCustomAnswer, nextCursor),
      ),
    );
    setComposerHighlightedItemId(null);
  }, [
    activePendingProgress?.customAnswer,
    activePendingUserInput?.requestId,
    activePendingProgress?.activeQuestion?.id,
  ]);
  useEffect(() => {
    attachmentPreviewHandoffByMessageIdRef.current = attachmentPreviewHandoffByMessageId;
  }, [attachmentPreviewHandoffByMessageId]);
  const clearAttachmentPreviewHandoffs = useCallback(() => {
    for (const timeoutId of Object.values(attachmentPreviewHandoffTimeoutByMessageIdRef.current)) {
      window.clearTimeout(timeoutId);
    }
    attachmentPreviewHandoffTimeoutByMessageIdRef.current = {};
    for (const previewUrls of Object.values(attachmentPreviewHandoffByMessageIdRef.current)) {
      for (const previewUrl of previewUrls) {
        revokeBlobPreviewUrl(previewUrl);
      }
    }
    attachmentPreviewHandoffByMessageIdRef.current = {};
    setAttachmentPreviewHandoffByMessageId({});
  }, []);
  useEffect(() => {
    return () => {
      clearAttachmentPreviewHandoffs();
      for (const message of optimisticUserMessagesRef.current) {
        revokeUserMessagePreviewUrls(message);
      }
    };
  }, [clearAttachmentPreviewHandoffs]);
  const handoffAttachmentPreviews = useCallback((messageId: MessageId, previewUrls: string[]) => {
    if (previewUrls.length === 0) return;

    const previousPreviewUrls = attachmentPreviewHandoffByMessageIdRef.current[messageId] ?? [];
    for (const previewUrl of previousPreviewUrls) {
      if (!previewUrls.includes(previewUrl)) {
        revokeBlobPreviewUrl(previewUrl);
      }
    }
    setAttachmentPreviewHandoffByMessageId((existing) => {
      const next = {
        ...existing,
        [messageId]: previewUrls,
      };
      attachmentPreviewHandoffByMessageIdRef.current = next;
      return next;
    });

    const existingTimeout = attachmentPreviewHandoffTimeoutByMessageIdRef.current[messageId];
    if (typeof existingTimeout === "number") {
      window.clearTimeout(existingTimeout);
    }
    attachmentPreviewHandoffTimeoutByMessageIdRef.current[messageId] = window.setTimeout(() => {
      const currentPreviewUrls = attachmentPreviewHandoffByMessageIdRef.current[messageId];
      if (currentPreviewUrls) {
        for (const previewUrl of currentPreviewUrls) {
          revokeBlobPreviewUrl(previewUrl);
        }
      }
      setAttachmentPreviewHandoffByMessageId((existing) => {
        if (!(messageId in existing)) return existing;
        const next = { ...existing };
        delete next[messageId];
        attachmentPreviewHandoffByMessageIdRef.current = next;
        return next;
      });
      delete attachmentPreviewHandoffTimeoutByMessageIdRef.current[messageId];
    }, ATTACHMENT_PREVIEW_HANDOFF_TTL_MS);
  }, []);
  const serverMessages = activeWorkspace?.messages;
  const timelineMessages = useMemo(() => {
    const messages = serverMessages ?? [];
    const serverMessagesWithPreviewHandoff =
      Object.keys(attachmentPreviewHandoffByMessageId).length === 0
        ? messages
        : // Spread only fires for the few messages that actually changed;
          // unchanged ones early-return their original reference.
          // In-place mutation would break React's immutable state contract.
          // oxlint-disable-next-line no-map-spread
          messages.map((message) => {
            if (
              message.role !== "user" ||
              !message.attachments ||
              message.attachments.length === 0
            ) {
              return message;
            }
            const handoffPreviewUrls = attachmentPreviewHandoffByMessageId[message.id];
            if (!handoffPreviewUrls || handoffPreviewUrls.length === 0) {
              return message;
            }

            let changed = false;
            let imageIndex = 0;
            const attachments = message.attachments.map((attachment) => {
              if (attachment.type !== "image") {
                return attachment;
              }
              const handoffPreviewUrl = handoffPreviewUrls[imageIndex];
              imageIndex += 1;
              if (!handoffPreviewUrl || attachment.previewUrl === handoffPreviewUrl) {
                return attachment;
              }
              changed = true;
              return {
                ...attachment,
                previewUrl: handoffPreviewUrl,
              };
            });

            return changed ? { ...message, attachments } : message;
          });

    if (optimisticUserMessages.length === 0) {
      return serverMessagesWithPreviewHandoff;
    }
    const serverIds = new Set(serverMessagesWithPreviewHandoff.map((message) => message.id));
    const pendingMessages = optimisticUserMessages.filter((message) => !serverIds.has(message.id));
    if (pendingMessages.length === 0) {
      return serverMessagesWithPreviewHandoff;
    }
    return [...serverMessagesWithPreviewHandoff, ...pendingMessages];
  }, [serverMessages, attachmentPreviewHandoffByMessageId, optimisticUserMessages]);
  const timelineEntries = useMemo(
    () =>
      deriveTimelineEntries(timelineMessages, activeWorkspace?.proposedPlans ?? [], workLogEntries),
    [activeWorkspace?.proposedPlans, timelineMessages, workLogEntries],
  );
  const { turnDiffSummaries, inferredCheckpointTurnCountByTurnId } =
    useTurnDiffSummaries(activeWorkspace);
  const turnDiffSummaryByAssistantMessageId = useMemo(() => {
    const byMessageId = new Map<MessageId, TurnDiffSummary>();
    for (const summary of turnDiffSummaries) {
      if (!summary.assistantMessageId) continue;
      byMessageId.set(summary.assistantMessageId, summary);
    }
    return byMessageId;
  }, [turnDiffSummaries]);
  const revertTurnCountByUserMessageId = useMemo(() => {
    const byUserMessageId = new Map<MessageId, number>();
    for (let index = 0; index < timelineEntries.length; index += 1) {
      const entry = timelineEntries[index];
      if (!entry || entry.kind !== "message" || entry.message.role !== "user") {
        continue;
      }

      for (let nextIndex = index + 1; nextIndex < timelineEntries.length; nextIndex += 1) {
        const nextEntry = timelineEntries[nextIndex];
        if (!nextEntry || nextEntry.kind !== "message") {
          continue;
        }
        if (nextEntry.message.role === "user") {
          break;
        }
        const summary = turnDiffSummaryByAssistantMessageId.get(nextEntry.message.id);
        if (!summary) {
          continue;
        }
        const turnCount =
          summary.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[summary.turnId];
        if (typeof turnCount !== "number") {
          break;
        }
        byUserMessageId.set(entry.message.id, Math.max(0, turnCount - 1));
        break;
      }
    }

    return byUserMessageId;
  }, [inferredCheckpointTurnCountByTurnId, timelineEntries, turnDiffSummaryByAssistantMessageId]);

  const completionSummary = useMemo(() => {
    if (!latestTurnSettled) return null;
    if (!activeLatestTurn?.startedAt) return null;
    if (!activeLatestTurn.completedAt) return null;
    if (!latestTurnHasToolActivity) return null;

    const elapsed = formatElapsed(activeLatestTurn.startedAt, activeLatestTurn.completedAt);
    return elapsed ? `Worked for ${elapsed}` : null;
  }, [
    activeLatestTurn?.completedAt,
    activeLatestTurn?.startedAt,
    latestTurnHasToolActivity,
    latestTurnSettled,
  ]);
  const completionDividerBeforeEntryId = useMemo(() => {
    if (!latestTurnSettled) return null;
    if (!completionSummary) return null;
    return deriveCompletionDividerBeforeEntryId(timelineEntries, activeLatestTurn);
  }, [activeLatestTurn, completionSummary, latestTurnSettled, timelineEntries]);
  const gitCwd = activeProject
    ? projectScriptCwd({
        project: { cwd: activeProject.cwd },
        worktreePath: activeWorkspace?.worktreePath ?? null,
      })
    : null;
  const composerTriggerKind = composerTrigger?.kind ?? null;
  const pathTriggerQuery = composerTrigger?.kind === "path" ? composerTrigger.query : "";
  const isPathTrigger = composerTriggerKind === "path";
  const [debouncedPathQuery, composerPathQueryDebouncer] = useDebouncedValue(
    pathTriggerQuery,
    { wait: COMPOSER_PATH_QUERY_DEBOUNCE_MS },
    (debouncerState) => ({ isPending: debouncerState.isPending }),
  );
  const effectivePathQuery = pathTriggerQuery.length > 0 ? debouncedPathQuery : "";
  const gitStatusQuery = useQuery(gitStatusQueryOptions(gitCwd));
  const keybindings = useServerKeybindings();
  const availableEditors = useServerAvailableEditors();
  const modelOptionsByProvider = useMemo(
    () => ({
      codex: providerStatuses.find((provider) => provider.provider === "codex")?.models ?? [],
      claudeAgent:
        providerStatuses.find((provider) => provider.provider === "claudeAgent")?.models ?? [],
    }),
    [providerStatuses],
  );
  const searchableModelOptions = useMemo(
    () =>
      AVAILABLE_PROVIDER_OPTIONS.flatMap((option) =>
        modelOptionsByProvider[option.value].map(({ slug, name }) => ({
          provider: option.value,
          providerLabel: option.label,
          slug,
          name,
          searchSlug: slug.toLowerCase(),
          searchName: name.toLowerCase(),
          searchProvider: option.label.toLowerCase(),
        })),
      ),
    [modelOptionsByProvider],
  );
  const workspaceEntriesQuery = useQuery(
    projectSearchEntriesQueryOptions({
      cwd: gitCwd,
      query: effectivePathQuery,
      enabled: isPathTrigger,
      limit: 80,
    }),
  );
  const workspaceEntries = workspaceEntriesQuery.data?.entries ?? EMPTY_PROJECT_ENTRIES;
  const availableNativeSlashCommands = useMemo(() => {
    const selectedProviderSlashCommands =
      providerStatuses.find((provider) => provider.provider === selectedProvider)?.slashCommands ??
      [];
    return selectedProvider === "claudeAgent"
      ? [...CLAUDE_BUILT_IN_SLASH_COMMANDS, ...selectedProviderSlashCommands]
      : selectedProviderSlashCommands;
  }, [providerStatuses, selectedProvider]);
  const composerMenuItems = useMemo<ComposerCommandItem[]>(() => {
    if (!composerTrigger) return [];
    if (composerTrigger.kind === "path") {
      return workspaceEntries.map((entry) => ({
        id: `path:${entry.kind}:${entry.path}`,
        type: "path",
        path: entry.path,
        pathKind: entry.kind,
        label: basenameOfPath(entry.path),
        description: entry.parentPath ?? "",
      }));
    }

    if (composerTrigger.kind === "slash-command") {
      const slashCommandItems = [
        {
          id: "slash:model",
          type: "slash-command",
          command: "model",
          label: "/model",
          description: "Switch response model for this workspace",
        },
        {
          id: "slash:plan",
          type: "slash-command",
          command: "plan",
          label: "/plan",
          description: "Switch this workspace into plan mode",
        },
        {
          id: "slash:default",
          type: "slash-command",
          command: "default",
          label: "/default",
          description: "Switch this workspace back to normal chat mode",
        },
      ] satisfies ReadonlyArray<Extract<ComposerCommandItem, { type: "slash-command" }>>;
      const query = composerTrigger.query.trim().toLowerCase();
      const nativeSlashCommandItems = availableNativeSlashCommands
        .filter((command) => {
          if (!query) {
            return true;
          }
          const normalizedCommand = command.command.toLowerCase();
          return (
            normalizedCommand.includes(`/${query}`) ||
            normalizedCommand.slice(1).includes(query) ||
            command.description?.toLowerCase().includes(query) === true
          );
        })
        .map(
          (command) =>
            ({
              id: `native-slash:${selectedProvider}:${command.command.toLowerCase()}`,
              type: "native-slash-command",
              provider: selectedProvider,
              label: command.command,
              description:
                command.description ??
                (selectedProvider === "claudeAgent"
                  ? "Native Claude slash command"
                  : "Native Codex slash command"),
            }) satisfies Extract<ComposerCommandItem, { type: "native-slash-command" }>,
        );
      const sendArbitraryNativeSlashCommand =
        composerTrigger.query.trim().length > 0 &&
        nativeSlashCommandItems.every(
          (item) => item.label.toLowerCase() !== `/${composerTrigger.query.trim().toLowerCase()}`,
        )
          ? ({
              id: `native-slash:${selectedProvider}:${composerTrigger.query.trim().toLowerCase()}`,
              type: "native-slash-command",
              provider: selectedProvider,
              label: `Send /${composerTrigger.query.trim()}`,
              description:
                selectedProvider === "claudeAgent"
                  ? "Send native Claude slash command"
                  : "Send native Codex slash command",
            } satisfies Extract<ComposerCommandItem, { type: "native-slash-command" }>)
          : null;
      if (!query) {
        return [...nativeSlashCommandItems, ...slashCommandItems];
      }
      const filteredInternalItems = slashCommandItems.filter(
        (item) => item.command.includes(query) || item.label.slice(1).includes(query),
      );
      return [
        ...nativeSlashCommandItems,
        ...(sendArbitraryNativeSlashCommand ? [sendArbitraryNativeSlashCommand] : []),
        ...filteredInternalItems,
      ];
    }

    return searchableModelOptions
      .filter(({ searchSlug, searchName, searchProvider }) => {
        const query = composerTrigger.query.trim().toLowerCase();
        if (!query) return true;
        return (
          searchSlug.includes(query) || searchName.includes(query) || searchProvider.includes(query)
        );
      })
      .map(({ provider, providerLabel, slug, name }) => ({
        id: `model:${provider}:${slug}`,
        type: "model",
        provider,
        model: slug,
        label: name,
        description: `${providerLabel} · ${slug}`,
      }));
  }, [
    composerTrigger,
    searchableModelOptions,
    availableNativeSlashCommands,
    selectedProvider,
    workspaceEntries,
  ]);
  const composerMenuOpen = Boolean(composerTrigger);
  const activeComposerMenuItem = useMemo(
    () =>
      composerMenuItems.find((item) => item.id === composerHighlightedItemId) ??
      composerMenuItems[0] ??
      null,
    [composerHighlightedItemId, composerMenuItems],
  );
  composerMenuOpenRef.current = composerMenuOpen;
  composerMenuItemsRef.current = composerMenuItems;
  activeComposerMenuItemRef.current = activeComposerMenuItem;
  const nonPersistedComposerImageIdSet = useMemo(
    () => new Set(nonPersistedComposerImageIds),
    [nonPersistedComposerImageIds],
  );
  const activeProviderStatus = useMemo(
    () => providerStatuses.find((status) => status.provider === selectedProvider) ?? null,
    [selectedProvider, providerStatuses],
  );
  const activeProjectCwd = activeProject?.cwd ?? null;
  const activeWorkspaceWorktreePath = activeWorkspace?.worktreePath ?? null;
  const activeWorkspaceRoot = activeWorkspaceWorktreePath ?? activeProjectCwd ?? undefined;
  const activeTerminalLaunchContext =
    terminalLaunchContext?.workspaceId === activeWorkspaceId
      ? terminalLaunchContext
      : (storeServerTerminalLaunchContext ?? null);
  // Default true while loading to avoid toolbar flicker.
  const isGitRepo = gitStatusQuery.data?.isRepo ?? true;
  const terminalShortcutLabelOptions = useMemo(
    () => ({
      context: {
        terminalFocus: true,
        terminalOpen: isTerminalTabActive,
      },
    }),
    [isTerminalTabActive],
  );
  const nonTerminalShortcutLabelOptions = useMemo(
    () => ({
      context: {
        terminalFocus: false,
        terminalOpen: isTerminalTabActive,
      },
    }),
    [isTerminalTabActive],
  );
  const splitTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.split", terminalShortcutLabelOptions),
    [keybindings, terminalShortcutLabelOptions],
  );
  const newTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.new", terminalShortcutLabelOptions),
    [keybindings, terminalShortcutLabelOptions],
  );
  const closeTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.close", terminalShortcutLabelOptions),
    [keybindings, terminalShortcutLabelOptions],
  );
  const sourceControlShortcutLabel = useMemo(
    () =>
      shortcutLabelForCommand(keybindings, "sourceControl.toggle", nonTerminalShortcutLabelOptions),
    [keybindings, nonTerminalShortcutLabelOptions],
  );
  const onToggleSourceControl = useCallback(() => {
    void navigate({
      to: "/$workspaceId",
      params: { workspaceId: routeWorkspaceId },
      replace: true,
      search: (previous) => {
        const rest = stripSourceControlSearchParams(previous);
        return sourceControlOpen ? { ...rest, diff: undefined } : { ...rest, diff: "1" };
      },
    });
  }, [sourceControlOpen, navigate, routeWorkspaceId]);

  const envLocked = Boolean(
    activeWorkspace &&
    (activeWorkspace.messages.length > 0 ||
      (activeWorkspace.session !== null && activeWorkspace.session.status !== "closed")),
  );
  const activeTerminalGroup =
    terminalState.terminalGroups.find(
      (group) => group.id === terminalState.activeTerminalGroupId,
    ) ??
    terminalState.terminalGroups.find((group) =>
      group.terminalIds.includes(terminalState.activeTerminalId),
    ) ??
    null;
  const hasReachedSplitLimit =
    (activeTerminalGroup?.terminalIds.length ?? 0) >= MAX_TERMINALS_PER_GROUP;
  const setWorkspaceError = useCallback(
    (targetWorkspaceId: WorkspaceId | null, error: string | null) => {
      if (!targetWorkspaceId) return;
      const nextError = sanitizeWorkspaceErrorMessage(error);
      if (useStore.getState().workspaces.some((workspace) => workspace.id === targetWorkspaceId)) {
        setStoreWorkspaceError(targetWorkspaceId, nextError);
        return;
      }
      setLocalDraftErrorsByWorkspaceId((existing) => {
        if ((existing[targetWorkspaceId] ?? null) === nextError) {
          return existing;
        }
        return {
          ...existing,
          [targetWorkspaceId]: nextError,
        };
      });
    },
    [setStoreWorkspaceError],
  );

  const focusComposer = useCallback(() => {
    composerEditorRef.current?.focusAtEnd();
  }, []);
  const scheduleComposerFocus = useCallback(() => {
    window.requestAnimationFrame(() => {
      focusComposer();
    });
  }, [focusComposer]);
  const addTerminalContextToDraft = useCallback(
    (selection: TerminalContextSelection) => {
      if (!activeWorkspace) {
        return;
      }
      const snapshot = composerEditorRef.current?.readSnapshot() ?? {
        value: promptRef.current,
        cursor: composerCursor,
        expandedCursor: expandCollapsedComposerCursor(promptRef.current, composerCursor),
        terminalContextIds: composerTerminalContexts.map((context) => context.id),
      };
      const insertion = insertInlineTerminalContextPlaceholder(
        snapshot.value,
        snapshot.expandedCursor,
      );
      const nextCollapsedCursor = collapseExpandedComposerCursor(
        insertion.prompt,
        insertion.cursor,
      );
      const inserted = insertComposerDraftTerminalContext(
        activeWorkspace.id,
        insertion.prompt,
        {
          id: randomUUID(),
          workspaceId: activeWorkspace.id,
          createdAt: new Date().toISOString(),
          ...selection,
        },
        insertion.contextIndex,
      );
      if (!inserted) {
        return;
      }
      promptRef.current = insertion.prompt;
      setComposerCursor(nextCollapsedCursor);
      setComposerTrigger(detectComposerTrigger(insertion.prompt, insertion.cursor));
      window.requestAnimationFrame(() => {
        composerEditorRef.current?.focusAt(nextCollapsedCursor);
      });
    },
    [activeWorkspace, composerCursor, composerTerminalContexts, insertComposerDraftTerminalContext],
  );
  const splitTerminal = useCallback(() => {
    if (!activeWorkspaceId || hasReachedSplitLimit) return;
    const terminalId = `terminal-${randomUUID()}`;
    storeSplitTerminal(activeWorkspaceId, terminalId);
    setTerminalFocusRequestId((value) => value + 1);
  }, [activeWorkspaceId, hasReachedSplitLimit, storeSplitTerminal]);
  const closeTerminal = useCallback(
    (terminalId: string) => {
      const api = readNativeApi();
      if (!activeWorkspaceId || !api) return;
      if ("close" in api.terminal && typeof api.terminal.close === "function") {
        void api.terminal
          .close({ workspaceId: activeWorkspaceId, terminalId, deleteHistory: true })
          .catch(() =>
            api.terminal
              .write({ workspaceId: activeWorkspaceId, terminalId, data: "exit\n" })
              .catch(() => undefined),
          );
      } else {
        void api.terminal
          .write({ workspaceId: activeWorkspaceId, terminalId, data: "exit\n" })
          .catch(() => undefined);
      }
      storeCloseTerminal(activeWorkspaceId, terminalId);
      // Also close the tab that owns this terminal.
      const terminalTab = findTerminalTabByTerminalId(workspaceWorkspaceId, terminalId);
      if (terminalTab) {
        removeTab(workspaceWorkspaceId, terminalTab.id);
      }
    },
    [
      activeWorkspaceId,
      findTerminalTabByTerminalId,
      removeTab,
      storeCloseTerminal,
      workspaceWorkspaceId,
    ],
  );
  const runProjectScript = useCallback(
    async (
      script: ProjectScript,
      options?: {
        cwd?: string;
        env?: Record<string, string>;
        worktreePath?: string | null;
        preferNewTerminal?: boolean;
        rememberAsLastInvoked?: boolean;
      },
    ) => {
      const api = readNativeApi();
      if (!api || !activeWorkspaceId || !activeProject || !activeWorkspace) return;
      if (options?.rememberAsLastInvoked !== false) {
        setLastInvokedScriptByProjectId((current) => {
          if (current[activeProject.id] === script.id) return current;
          return { ...current, [activeProject.id]: script.id };
        });
      }
      const targetCwd = options?.cwd ?? gitCwd ?? activeProject.cwd;
      const targetWorktreePath = options?.worktreePath ?? activeWorkspace.worktreePath ?? null;

      // Determine whether to reuse the active terminal tab or create a new one.
      const activeTerminalTab =
        activeTab?.kind === "terminal" && activeTab.terminalId ? activeTab : null;
      const isActiveTerminalBusy = activeTerminalTab
        ? terminalState.runningTerminalIds.includes(activeTerminalTab.terminalId!)
        : true;
      const wantsNewTerminal =
        Boolean(options?.preferNewTerminal) || isActiveTerminalBusy || !activeTerminalTab;

      let targetTerminalId: string;
      if (wantsNewTerminal) {
        const newTab = createNewTerminalTab();
        targetTerminalId = newTab.terminalId!;
      } else {
        targetTerminalId = activeTerminalTab!.terminalId!;
        setActiveTab(workspaceWorkspaceId, activeTerminalTab!.id);
      }

      setTerminalLaunchContext({
        workspaceId: activeWorkspaceId,
        cwd: targetCwd,
        worktreePath: targetWorktreePath,
      });
      setTerminalFocusRequestId((value) => value + 1);

      const runtimeEnv = projectScriptRuntimeEnv({
        project: {
          cwd: activeProject.cwd,
        },
        worktreePath: targetWorktreePath,
        ...(options?.env ? { extraEnv: options.env } : {}),
      });
      const openTerminalInput: TerminalOpenInput = wantsNewTerminal
        ? {
            workspaceId: activeWorkspaceId,
            terminalId: targetTerminalId,
            cwd: targetCwd,
            ...(targetWorktreePath !== null ? { worktreePath: targetWorktreePath } : {}),
            env: runtimeEnv,
            cols: SCRIPT_TERMINAL_COLS,
            rows: SCRIPT_TERMINAL_ROWS,
          }
        : {
            workspaceId: activeWorkspaceId,
            terminalId: targetTerminalId,
            cwd: targetCwd,
            ...(targetWorktreePath !== null ? { worktreePath: targetWorktreePath } : {}),
            env: runtimeEnv,
          };

      try {
        await api.terminal.open(openTerminalInput);
        await api.terminal.write({
          workspaceId: activeWorkspaceId,
          terminalId: targetTerminalId,
          data: `${script.command}\r`,
        });
      } catch (error) {
        setWorkspaceError(
          activeWorkspaceId,
          error instanceof Error ? error.message : `Failed to run script "${script.name}".`,
        );
      }
    },
    [
      activeProject,
      activeTab,
      activeWorkspace,
      activeWorkspaceId,
      createNewTerminalTab,
      gitCwd,
      setActiveTab,
      setWorkspaceError,
      setLastInvokedScriptByProjectId,
      terminalState.runningTerminalIds,
      workspaceWorkspaceId,
    ],
  );

  const persistProjectScripts = useCallback(
    async (input: {
      projectId: ProjectId;
      projectCwd: string;
      previousScripts: ProjectScript[];
      nextScripts: ProjectScript[];
      keybinding?: string | null;
      keybindingCommand: KeybindingCommand;
    }) => {
      const api = readNativeApi();
      if (!api) return;

      await api.orchestration.dispatchCommand({
        type: "project.meta.update",
        commandId: newCommandId(),
        projectId: input.projectId,
        scripts: input.nextScripts,
      });

      const keybindingRule = decodeProjectScriptKeybindingRule({
        keybinding: input.keybinding,
        command: input.keybindingCommand,
      });

      if (isElectron && keybindingRule) {
        await api.server.upsertKeybinding(keybindingRule);
      }
    },
    [],
  );
  const saveProjectScript = useCallback(
    async (input: NewProjectScriptInput) => {
      if (!activeProject) return;
      const nextId = nextProjectScriptId(
        input.name,
        activeProject.scripts.map((script) => script.id),
      );
      const nextScript: ProjectScript = {
        id: nextId,
        name: input.name,
        command: input.command,
        icon: input.icon,
        runOnWorktreeCreate: input.runOnWorktreeCreate,
      };
      const nextScripts = input.runOnWorktreeCreate
        ? [
            ...activeProject.scripts.map((script) =>
              script.runOnWorktreeCreate ? { ...script, runOnWorktreeCreate: false } : script,
            ),
            nextScript,
          ]
        : [...activeProject.scripts, nextScript];

      await persistProjectScripts({
        projectId: activeProject.id,
        projectCwd: activeProject.cwd,
        previousScripts: activeProject.scripts,
        nextScripts,
        keybinding: input.keybinding,
        keybindingCommand: commandForProjectScript(nextId),
      });
    },
    [activeProject, persistProjectScripts],
  );
  const updateProjectScript = useCallback(
    async (scriptId: string, input: NewProjectScriptInput) => {
      if (!activeProject) return;
      const existingScript = activeProject.scripts.find((script) => script.id === scriptId);
      if (!existingScript) {
        throw new Error("Script not found.");
      }

      const updatedScript: ProjectScript = {
        ...existingScript,
        name: input.name,
        command: input.command,
        icon: input.icon,
        runOnWorktreeCreate: input.runOnWorktreeCreate,
      };
      const nextScripts = activeProject.scripts.map((script) =>
        script.id === scriptId
          ? updatedScript
          : input.runOnWorktreeCreate
            ? { ...script, runOnWorktreeCreate: false }
            : script,
      );

      await persistProjectScripts({
        projectId: activeProject.id,
        projectCwd: activeProject.cwd,
        previousScripts: activeProject.scripts,
        nextScripts,
        keybinding: input.keybinding,
        keybindingCommand: commandForProjectScript(scriptId),
      });
    },
    [activeProject, persistProjectScripts],
  );
  const deleteProjectScript = useCallback(
    async (scriptId: string) => {
      if (!activeProject) return;
      const nextScripts = activeProject.scripts.filter((script) => script.id !== scriptId);

      const deletedName = activeProject.scripts.find((s) => s.id === scriptId)?.name;

      try {
        await persistProjectScripts({
          projectId: activeProject.id,
          projectCwd: activeProject.cwd,
          previousScripts: activeProject.scripts,
          nextScripts,
          keybinding: null,
          keybindingCommand: commandForProjectScript(scriptId),
        });
        toastManager.add({
          type: "success",
          title: `Deleted action "${deletedName ?? "Unknown"}"`,
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Could not delete action",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        });
      }
    },
    [activeProject, persistProjectScripts],
  );

  const handleRuntimeModeChange = useCallback(
    (mode: RuntimeMode) => {
      if (mode === runtimeMode) return;
      setComposerDraftRuntimeMode(workspaceId, mode);
      if (isLocalDraftWorkspace) {
        setDraftWorkspaceContext(workspaceId, { runtimeMode: mode });
      }
      scheduleComposerFocus();
    },
    [
      isLocalDraftWorkspace,
      runtimeMode,
      scheduleComposerFocus,
      setComposerDraftRuntimeMode,
      setDraftWorkspaceContext,
      workspaceId,
    ],
  );

  const handleInteractionModeChange = useCallback(
    (mode: ProviderInteractionMode) => {
      if (mode === interactionMode) return;
      setComposerDraftInteractionMode(workspaceId, mode);
      if (isLocalDraftWorkspace) {
        setDraftWorkspaceContext(workspaceId, { interactionMode: mode });
      }
      scheduleComposerFocus();
    },
    [
      interactionMode,
      isLocalDraftWorkspace,
      scheduleComposerFocus,
      setComposerDraftInteractionMode,
      setDraftWorkspaceContext,
      workspaceId,
    ],
  );
  const toggleInteractionMode = useCallback(() => {
    handleInteractionModeChange(interactionMode === "plan" ? "default" : "plan");
  }, [handleInteractionModeChange, interactionMode]);
  const toggleRuntimeMode = useCallback(() => {
    void handleRuntimeModeChange(
      runtimeMode === "full-access" ? "approval-required" : "full-access",
    );
  }, [handleRuntimeModeChange, runtimeMode]);
  const togglePlanSidebar = useCallback(() => {
    setPlanSidebarOpen((open) => {
      if (open) {
        const turnKey = activePlan?.turnId ?? sidebarProposedPlan?.turnId ?? null;
        if (turnKey) {
          planSidebarDismissedForTurnRef.current = turnKey;
        }
      } else {
        planSidebarDismissedForTurnRef.current = null;
      }
      return !open;
    });
  }, [activePlan?.turnId, sidebarProposedPlan?.turnId]);

  const persistWorkspaceSettingsForNextTurn = useCallback(
    async (input: {
      workspaceId: WorkspaceId;
      createdAt: string;
      modelSelection?: ModelSelection;
      runtimeMode: RuntimeMode;
      interactionMode: ProviderInteractionMode;
    }) => {
      if (!serverWorkspace) {
        return;
      }
      const api = readNativeApi();
      if (!api) {
        return;
      }

      if (
        input.modelSelection !== undefined &&
        (input.modelSelection.model !== serverWorkspace.modelSelection.model ||
          input.modelSelection.provider !== serverWorkspace.modelSelection.provider ||
          JSON.stringify(input.modelSelection.options ?? null) !==
            JSON.stringify(serverWorkspace.modelSelection.options ?? null))
      ) {
        await api.orchestration.dispatchCommand({
          type: "workspace.meta.update",
          commandId: newCommandId(),
          workspaceId: input.workspaceId,
          modelSelection: input.modelSelection,
        });
      }

      if (input.runtimeMode !== serverWorkspace.runtimeMode) {
        await api.orchestration.dispatchCommand({
          type: "workspace.runtime-mode.set",
          commandId: newCommandId(),
          workspaceId: input.workspaceId,
          runtimeMode: input.runtimeMode,
          createdAt: input.createdAt,
        });
      }

      if (input.interactionMode !== serverWorkspace.interactionMode) {
        await api.orchestration.dispatchCommand({
          type: "workspace.interaction-mode.set",
          commandId: newCommandId(),
          workspaceId: input.workspaceId,
          interactionMode: input.interactionMode,
          createdAt: input.createdAt,
        });
      }
    },
    [serverWorkspace],
  );

  // Auto-scroll on new messages
  const messageCount = timelineMessages.length;
  const scrollMessagesToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const scrollContainer = messagesScrollRef.current;
    if (!scrollContainer) return;
    const bottomScrollTop = getScrollContainerBottomScrollTop(scrollContainer);
    scrollContainer.scrollTo({ top: bottomScrollTop, behavior });
    lastKnownScrollTopRef.current = bottomScrollTop;
    shouldAutoScrollRef.current = true;
  }, []);
  const cancelPendingStickToBottom = useCallback(() => {
    const pendingFrame = pendingAutoScrollFrameRef.current;
    if (pendingFrame === null) return;
    pendingAutoScrollFrameRef.current = null;
    window.cancelAnimationFrame(pendingFrame);
  }, []);
  const cancelPendingInteractionAnchorAdjustment = useCallback(() => {
    const pendingFrame = pendingInteractionAnchorFrameRef.current;
    if (pendingFrame === null) return;
    pendingInteractionAnchorFrameRef.current = null;
    window.cancelAnimationFrame(pendingFrame);
  }, []);
  const scheduleStickToBottom = useCallback(() => {
    if (pendingAutoScrollFrameRef.current !== null) return;
    pendingAutoScrollFrameRef.current = window.requestAnimationFrame(() => {
      pendingAutoScrollFrameRef.current = null;
      scrollMessagesToBottom();
    });
  }, [scrollMessagesToBottom]);
  const onMessagesClickCapture = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const scrollContainer = messagesScrollRef.current;
      if (!scrollContainer || !(event.target instanceof Element)) return;

      const trigger = event.target.closest<HTMLElement>(
        "button, summary, [role='button'], [data-scroll-anchor-target]",
      );
      if (!trigger || !scrollContainer.contains(trigger)) return;
      if (trigger.closest("[data-scroll-anchor-ignore]")) return;

      pendingInteractionAnchorRef.current = {
        element: trigger,
        top: trigger.getBoundingClientRect().top,
      };

      cancelPendingInteractionAnchorAdjustment();
      pendingInteractionAnchorFrameRef.current = window.requestAnimationFrame(() => {
        pendingInteractionAnchorFrameRef.current = null;
        const anchor = pendingInteractionAnchorRef.current;
        pendingInteractionAnchorRef.current = null;
        const activeScrollContainer = messagesScrollRef.current;
        if (!anchor || !activeScrollContainer) return;
        if (!anchor.element.isConnected || !activeScrollContainer.contains(anchor.element)) return;

        const nextTop = anchor.element.getBoundingClientRect().top;
        const delta = nextTop - anchor.top;
        if (Math.abs(delta) < 0.5) return;

        activeScrollContainer.scrollTop += delta;
        lastKnownScrollTopRef.current = activeScrollContainer.scrollTop;
      });
    },
    [cancelPendingInteractionAnchorAdjustment],
  );
  const forceStickToBottom = useCallback(() => {
    cancelPendingStickToBottom();
    scrollMessagesToBottom();
    scheduleStickToBottom();
  }, [cancelPendingStickToBottom, scheduleStickToBottom, scrollMessagesToBottom]);
  const onTimelineContentHeightChange = useCallback(() => {
    if (document.hidden) return;
    if (!shouldAutoScrollRef.current) return;
    scheduleStickToBottom();
  }, [scheduleStickToBottom]);
  const onMessagesScroll = useCallback(() => {
    const scrollContainer = messagesScrollRef.current;
    if (!scrollContainer) return;

    // While the document is hidden (e.g. browser tab switch), virtualizer
    // remeasurements and ResizeObserver callbacks can fire with stale values,
    // causing the scroll offset to shift.  Ignore those synthetic scroll events
    // so we don't accidentally break auto-scroll state.
    if (document.hidden) return;

    const currentScrollTop = scrollContainer.scrollTop;
    const isNearBottom = isScrollContainerNearBottom(scrollContainer);

    if (!shouldAutoScrollRef.current && isNearBottom) {
      shouldAutoScrollRef.current = true;
      pendingUserScrollUpIntentRef.current = false;
    } else if (shouldAutoScrollRef.current && pendingUserScrollUpIntentRef.current) {
      const scrolledUp = currentScrollTop < lastKnownScrollTopRef.current - 1;
      if (scrolledUp && !isNearBottom) {
        shouldAutoScrollRef.current = false;
      }
      pendingUserScrollUpIntentRef.current = false;
    } else if (shouldAutoScrollRef.current && isPointerScrollActiveRef.current) {
      const scrolledUp = currentScrollTop < lastKnownScrollTopRef.current - 1;
      if (scrolledUp && !isNearBottom) {
        shouldAutoScrollRef.current = false;
      }
    } else if (shouldAutoScrollRef.current && !isNearBottom) {
      // Catch-all for keyboard/assistive scroll interactions.
      const scrolledUp = currentScrollTop < lastKnownScrollTopRef.current - 1;
      if (scrolledUp) {
        shouldAutoScrollRef.current = false;
      }
    }

    setShowScrollToBottom(!shouldAutoScrollRef.current);
    lastKnownScrollTopRef.current = currentScrollTop;
  }, []);
  const onMessagesWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    if (event.deltaY < 0) {
      pendingUserScrollUpIntentRef.current = true;
    }
  }, []);
  const onMessagesPointerDown = useCallback((_event: React.PointerEvent<HTMLDivElement>) => {
    isPointerScrollActiveRef.current = true;
  }, []);
  const onMessagesPointerUp = useCallback((_event: React.PointerEvent<HTMLDivElement>) => {
    isPointerScrollActiveRef.current = false;
  }, []);
  const onMessagesPointerCancel = useCallback((_event: React.PointerEvent<HTMLDivElement>) => {
    isPointerScrollActiveRef.current = false;
  }, []);
  const onMessagesTouchStart = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    const touch = event.touches[0];
    if (!touch) return;
    lastTouchClientYRef.current = touch.clientY;
  }, []);
  const onMessagesTouchMove = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    const touch = event.touches[0];
    if (!touch) return;
    const previousTouchY = lastTouchClientYRef.current;
    if (previousTouchY !== null && touch.clientY > previousTouchY + 1) {
      pendingUserScrollUpIntentRef.current = true;
    }
    lastTouchClientYRef.current = touch.clientY;
  }, []);
  const onMessagesTouchEnd = useCallback((_event: React.TouchEvent<HTMLDivElement>) => {
    lastTouchClientYRef.current = null;
  }, []);
  useEffect(() => {
    return () => {
      cancelPendingStickToBottom();
      cancelPendingInteractionAnchorAdjustment();
    };
  }, [cancelPendingInteractionAnchorAdjustment, cancelPendingStickToBottom]);

  // When the browser tab becomes visible again after being hidden, the
  // virtualizer may have fired remeasurements with stale dimensions, leaving
  // the scroll position somewhere in the middle.  Re-sync: if we were
  // auto-scrolling, force back to the bottom; otherwise just update the
  // lastKnownScrollTop so the scroll handler doesn't misinterpret the offset
  // delta as a user-initiated scroll-up.
  useEffect(() => {
    let visibilityResyncTimeout: number | null = null;

    const onVisibilityChange = () => {
      if (document.hidden) return;
      const scrollContainer = messagesScrollRef.current;
      if (!scrollContainer) return;

      if (shouldAutoScrollRef.current) {
        // Immediate scroll + delayed retry to let virtualizer measurements
        // settle (items re-measured after becoming visible may change the
        // total content height).
        forceStickToBottom();
        if (visibilityResyncTimeout !== null) {
          window.clearTimeout(visibilityResyncTimeout);
        }
        visibilityResyncTimeout = window.setTimeout(() => {
          forceStickToBottom();
        }, 100);
        return;
      }

      // Not auto-scrolling — just re-sync the last-known scroll position so
      // the scroll handler doesn't see a phantom scroll-up delta.
      lastKnownScrollTopRef.current = scrollContainer.scrollTop;
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      if (visibilityResyncTimeout !== null) {
        window.clearTimeout(visibilityResyncTimeout);
      }
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [forceStickToBottom]);

  useLayoutEffect(() => {
    if (!activeWorkspace?.id) return;
    shouldAutoScrollRef.current = true;
    scheduleStickToBottom();
    const timeout = window.setTimeout(() => {
      const scrollContainer = messagesScrollRef.current;
      if (!scrollContainer) return;
      if (isScrollContainerNearBottom(scrollContainer)) return;
      scheduleStickToBottom();
    }, 96);
    return () => {
      window.clearTimeout(timeout);
    };
  }, [activeWorkspace?.id, scheduleStickToBottom]);
  useLayoutEffect(() => {
    const composerForm = composerFormRef.current;
    if (!composerForm) return;
    const measureComposerFormWidth = () => composerForm.clientWidth;
    const measureFooterCompactness = () => {
      const composerFormWidth = measureComposerFormWidth();
      const heuristicFooterCompact = shouldUseCompactComposerFooter(composerFormWidth, {
        hasWideActions: composerFooterHasWideActions,
      });
      const footer = composerFooterRef.current;
      const footerStyle = footer ? window.getComputedStyle(footer) : null;
      const footerContentWidth = resolveComposerFooterContentWidth({
        footerWidth: footer?.clientWidth ?? null,
        paddingLeft: footerStyle ? Number.parseFloat(footerStyle.paddingLeft) : null,
        paddingRight: footerStyle ? Number.parseFloat(footerStyle.paddingRight) : null,
      });
      const fitInput = {
        footerContentWidth,
        leadingContentWidth: composerFooterLeadingRef.current?.scrollWidth ?? null,
        actionsWidth: composerFooterActionsRef.current?.scrollWidth ?? null,
      };
      const nextFooterCompact =
        heuristicFooterCompact || shouldForceCompactComposerFooterForFit(fitInput);
      const nextPrimaryActionsCompact =
        nextFooterCompact &&
        shouldUseCompactComposerPrimaryActions(composerFormWidth, {
          hasWideActions: composerFooterHasWideActions,
        });

      return {
        primaryActionsCompact: nextPrimaryActionsCompact,
        footerCompact: nextFooterCompact,
      };
    };

    composerFormHeightRef.current = composerForm.getBoundingClientRect().height;
    const initialCompactness = measureFooterCompactness();
    setIsComposerPrimaryActionsCompact(initialCompactness.primaryActionsCompact);
    setIsComposerFooterCompact(initialCompactness.footerCompact);
    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver((entries) => {
      const [entry] = entries;
      if (!entry) return;

      const nextCompactness = measureFooterCompactness();
      setIsComposerPrimaryActionsCompact((previous) =>
        previous === nextCompactness.primaryActionsCompact
          ? previous
          : nextCompactness.primaryActionsCompact,
      );
      setIsComposerFooterCompact((previous) =>
        previous === nextCompactness.footerCompact ? previous : nextCompactness.footerCompact,
      );

      const nextHeight = entry.contentRect.height;
      const previousHeight = composerFormHeightRef.current;
      composerFormHeightRef.current = nextHeight;

      if (previousHeight > 0 && Math.abs(nextHeight - previousHeight) < 0.5) return;
      if (!shouldAutoScrollRef.current) return;
      scheduleStickToBottom();
    });

    observer.observe(composerForm);
    return () => {
      observer.disconnect();
    };
  }, [
    activeWorkspace?.id,
    composerFooterActionLayoutKey,
    composerFooterHasWideActions,
    scheduleStickToBottom,
  ]);
  useEffect(() => {
    if (!shouldAutoScrollRef.current) return;
    scheduleStickToBottom();
  }, [messageCount, scheduleStickToBottom]);
  useEffect(() => {
    if (phase !== "running") return;
    if (!shouldAutoScrollRef.current) return;
    scheduleStickToBottom();
  }, [phase, scheduleStickToBottom, timelineEntries]);

  useEffect(() => {
    setExpandedWorkGroups({});
    setPullRequestDialogState(null);
    if (planSidebarOpenOnNextWorkspaceRef.current) {
      planSidebarOpenOnNextWorkspaceRef.current = false;
      setPlanSidebarOpen(true);
    } else {
      setPlanSidebarOpen(false);
    }
    planSidebarDismissedForTurnRef.current = null;
  }, [activeWorkspace?.id]);

  useEffect(() => {
    if (!composerMenuOpen) {
      setComposerHighlightedItemId(null);
      return;
    }
    setComposerHighlightedItemId((existing) =>
      existing && composerMenuItems.some((item) => item.id === existing)
        ? existing
        : (composerMenuItems[0]?.id ?? null),
    );
  }, [composerMenuItems, composerMenuOpen]);

  useEffect(() => {
    setIsRevertingCheckpoint(false);
  }, [activeWorkspace?.id]);

  useEffect(() => {
    if (!activeWorkspace?.id || isTerminalTabActive || activeTab?.kind !== "provider") return;
    const frame = window.requestAnimationFrame(() => {
      focusComposer();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [activeTab?.kind, activeWorkspace?.id, focusComposer, isTerminalTabActive]);

  useEffect(() => {
    composerImagesRef.current = composerImages;
  }, [composerImages]);

  useEffect(() => {
    composerTerminalContextsRef.current = composerTerminalContexts;
  }, [composerTerminalContexts]);

  useEffect(() => {
    if (!activeWorkspace?.id) return;
    if (activeWorkspace.messages.length === 0) {
      return;
    }
    const serverIds = new Set(activeWorkspace.messages.map((message) => message.id));
    const removedMessages = optimisticUserMessages.filter((message) => serverIds.has(message.id));
    if (removedMessages.length === 0) {
      return;
    }
    const timer = window.setTimeout(() => {
      setOptimisticUserMessages((existing) =>
        existing.filter((message) => !serverIds.has(message.id)),
      );
    }, 0);
    for (const removedMessage of removedMessages) {
      const previewUrls = collectUserMessageBlobPreviewUrls(removedMessage);
      if (previewUrls.length > 0) {
        handoffAttachmentPreviews(removedMessage.id, previewUrls);
        continue;
      }
      revokeUserMessagePreviewUrls(removedMessage);
    }
    return () => {
      window.clearTimeout(timer);
    };
  }, [
    activeWorkspace?.id,
    activeWorkspace?.messages,
    handoffAttachmentPreviews,
    optimisticUserMessages,
  ]);

  useEffect(() => {
    promptRef.current = prompt;
    setComposerCursor((existing) => clampCollapsedComposerCursor(prompt, existing));
  }, [prompt]);

  useEffect(() => {
    setOptimisticUserMessages((existing) => {
      for (const message of existing) {
        revokeUserMessagePreviewUrls(message);
      }
      return [];
    });
    resetLocalDispatch();
    setComposerHighlightedItemId(null);
    setComposerCursor(collapseExpandedComposerCursor(promptRef.current, promptRef.current.length));
    setComposerTrigger(detectComposerTrigger(promptRef.current, promptRef.current.length));
    dragDepthRef.current = 0;
    setIsDragOverComposer(false);
    setExpandedImage(null);
  }, [resetLocalDispatch, workspaceId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (composerImages.length === 0) {
        clearComposerDraftPersistedAttachments(workspaceId);
        return;
      }
      const getPersistedAttachmentsForWorkspace = () =>
        useComposerDraftStore.getState().draftsByWorkspaceId[workspaceId]?.persistedAttachments ??
        [];
      try {
        const currentPersistedAttachments = getPersistedAttachmentsForWorkspace();
        const existingPersistedById = new Map(
          currentPersistedAttachments.map((attachment) => [attachment.id, attachment]),
        );
        const stagedAttachmentById = new Map<string, PersistedComposerImageAttachment>();
        await Promise.all(
          composerImages.map(async (image) => {
            try {
              const dataUrl = await readFileAsDataUrl(image.file);
              stagedAttachmentById.set(image.id, {
                id: image.id,
                name: image.name,
                mimeType: image.mimeType,
                sizeBytes: image.sizeBytes,
                dataUrl,
              });
            } catch {
              const existingPersisted = existingPersistedById.get(image.id);
              if (existingPersisted) {
                stagedAttachmentById.set(image.id, existingPersisted);
              }
            }
          }),
        );
        const serialized = Array.from(stagedAttachmentById.values());
        if (cancelled) {
          return;
        }
        // Stage attachments in persisted draft state first so persist middleware can write them.
        syncComposerDraftPersistedAttachments(workspaceId, serialized);
      } catch {
        const currentImageIds = new Set(composerImages.map((image) => image.id));
        const fallbackPersistedAttachments = getPersistedAttachmentsForWorkspace();
        const fallbackPersistedIds = fallbackPersistedAttachments
          .map((attachment) => attachment.id)
          .filter((id) => currentImageIds.has(id));
        const fallbackPersistedIdSet = new Set(fallbackPersistedIds);
        const fallbackAttachments = fallbackPersistedAttachments.filter((attachment) =>
          fallbackPersistedIdSet.has(attachment.id),
        );
        if (cancelled) {
          return;
        }
        syncComposerDraftPersistedAttachments(workspaceId, fallbackAttachments);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    clearComposerDraftPersistedAttachments,
    composerImages,
    syncComposerDraftPersistedAttachments,
    workspaceId,
  ]);

  const closeExpandedImage = useCallback(() => {
    setExpandedImage(null);
  }, []);
  const navigateExpandedImage = useCallback((direction: -1 | 1) => {
    setExpandedImage((existing) => {
      if (!existing || existing.images.length <= 1) {
        return existing;
      }
      const nextIndex =
        (existing.index + direction + existing.images.length) % existing.images.length;
      if (nextIndex === existing.index) {
        return existing;
      }
      return { ...existing, index: nextIndex };
    });
  }, []);

  useEffect(() => {
    if (!expandedImage) {
      return;
    }

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeExpandedImage();
        return;
      }
      if (expandedImage.images.length <= 1) {
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        event.stopPropagation();
        navigateExpandedImage(-1);
        return;
      }
      if (event.key !== "ArrowRight") return;
      event.preventDefault();
      event.stopPropagation();
      navigateExpandedImage(1);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeExpandedImage, expandedImage, navigateExpandedImage]);

  const activeWorktreePath = activeWorkspace?.worktreePath;
  const envMode: DraftWorkspaceEnvMode = activeWorktreePath
    ? "worktree"
    : isLocalDraftWorkspace
      ? (draftWorkspace?.envMode ?? "local")
      : "local";

  useEffect(() => {
    if (!activeWorkspaceId) {
      setTerminalLaunchContext(null);
      storeClearTerminalLaunchContext(workspaceId);
      return;
    }
    setTerminalLaunchContext((current) => {
      if (!current) return current;
      if (current.workspaceId === activeWorkspaceId) return current;
      return null;
    });
  }, [activeWorkspaceId, storeClearTerminalLaunchContext, workspaceId]);

  useEffect(() => {
    if (!activeWorkspaceId || !activeProjectCwd) {
      return;
    }
    setTerminalLaunchContext((current) => {
      if (!current || current.workspaceId !== activeWorkspaceId) {
        return current;
      }
      const settledCwd = projectScriptCwd({
        project: { cwd: activeProjectCwd },
        worktreePath: activeWorkspaceWorktreePath,
      });
      if (
        settledCwd === current.cwd &&
        (activeWorkspaceWorktreePath ?? null) === current.worktreePath
      ) {
        storeClearTerminalLaunchContext(activeWorkspaceId);
        return null;
      }
      return current;
    });
  }, [
    activeProjectCwd,
    activeWorkspaceId,
    activeWorkspaceWorktreePath,
    storeClearTerminalLaunchContext,
  ]);

  useEffect(() => {
    if (!activeWorkspaceId || !activeProjectCwd || !storeServerTerminalLaunchContext) {
      return;
    }
    const settledCwd = projectScriptCwd({
      project: { cwd: activeProjectCwd },
      worktreePath: activeWorkspaceWorktreePath,
    });
    if (
      settledCwd === storeServerTerminalLaunchContext.cwd &&
      (activeWorkspaceWorktreePath ?? null) === storeServerTerminalLaunchContext.worktreePath
    ) {
      storeClearTerminalLaunchContext(activeWorkspaceId);
    }
  }, [
    activeProjectCwd,
    activeWorkspaceId,
    activeWorkspaceWorktreePath,
    storeClearTerminalLaunchContext,
    storeServerTerminalLaunchContext,
  ]);

  useEffect(() => {
    if (phase !== "running") return;
    const timer = window.setInterval(() => {
      setNowTick(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [phase]);

  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => {
      if (!activeWorkspaceId || event.defaultPrevented) return;
      const shortcutContext = {
        terminalFocus: isTerminalFocused(),
        terminalOpen: isTerminalTabActive,
      };

      const command = resolveShortcutCommand(event, keybindings, {
        context: shortcutContext,
      });
      if (!command) return;

      if (command === "terminal.toggle") {
        event.preventDefault();
        event.stopPropagation();
        openOrCreateTerminalTab();
        return;
      }

      if (command === "terminal.split") {
        event.preventDefault();
        event.stopPropagation();
        openOrCreateTerminalTab();
        splitTerminal();
        return;
      }

      if (command === "terminal.close") {
        event.preventDefault();
        event.stopPropagation();
        if (!isTerminalTabActive || !activeTab?.terminalId) return;
        closeTerminal(activeTab.terminalId);
        return;
      }

      if (command === "terminal.new") {
        event.preventDefault();
        event.stopPropagation();
        createNewTerminalTab();
        return;
      }

      if (command === "sourceControl.toggle") {
        event.preventDefault();
        event.stopPropagation();
        onToggleSourceControl();
        return;
      }

      const scriptId = projectScriptIdFromCommand(command);
      if (!scriptId || !activeProject) return;
      const script = activeProject.scripts.find((entry) => entry.id === scriptId);
      if (!script) return;
      event.preventDefault();
      event.stopPropagation();
      void runProjectScript(script);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    activeProject,
    activeTab,
    activeWorkspaceId,
    closeTerminal,
    createNewTerminalTab,
    isTerminalTabActive,
    openOrCreateTerminalTab,
    runProjectScript,
    splitTerminal,
    keybindings,
    onToggleSourceControl,
  ]);

  const addComposerImages = (files: File[]) => {
    if (!activeWorkspaceId || files.length === 0) return;

    if (pendingUserInputs.length > 0) {
      toastManager.add({
        type: "error",
        title: "Attach images after answering plan questions.",
      });
      return;
    }

    const nextImages: ComposerImageAttachment[] = [];
    let nextImageCount = composerImagesRef.current.length;
    let error: string | null = null;
    for (const file of files) {
      if (!file.type.startsWith("image/")) {
        error = `Unsupported file type for '${file.name}'. Please attach image files only.`;
        continue;
      }
      if (file.size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
        error = `'${file.name}' exceeds the ${IMAGE_SIZE_LIMIT_LABEL} attachment limit.`;
        continue;
      }
      if (nextImageCount >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
        error = `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} images per message.`;
        break;
      }

      const previewUrl = URL.createObjectURL(file);
      nextImages.push({
        type: "image",
        id: randomUUID(),
        name: file.name || "image",
        mimeType: file.type,
        sizeBytes: file.size,
        previewUrl,
        file,
      });
      nextImageCount += 1;
    }

    if (nextImages.length === 1 && nextImages[0]) {
      addComposerImage(nextImages[0]);
    } else if (nextImages.length > 1) {
      addComposerImagesToDraft(nextImages);
    }
    setWorkspaceError(activeWorkspaceId, error);
  };

  const removeComposerImage = (imageId: string) => {
    removeComposerImageFromDraft(imageId);
  };

  const onComposerPaste = (event: React.ClipboardEvent<HTMLElement>) => {
    const files = Array.from(event.clipboardData.files);
    if (files.length === 0) {
      return;
    }
    const imageFiles = files.filter((file) => file.type.startsWith("image/"));
    if (imageFiles.length === 0) {
      return;
    }
    event.preventDefault();
    addComposerImages(imageFiles);
  };

  const onComposerDragEnter = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }
    event.preventDefault();
    dragDepthRef.current += 1;
    setIsDragOverComposer(true);
  };

  const onComposerDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsDragOverComposer(true);
  };

  const onComposerDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }
    event.preventDefault();
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
      return;
    }
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsDragOverComposer(false);
    }
  };

  const onComposerDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }
    event.preventDefault();
    dragDepthRef.current = 0;
    setIsDragOverComposer(false);
    const files = Array.from(event.dataTransfer.files);
    addComposerImages(files);
    focusComposer();
  };

  const onRevertToTurnCount = useCallback(
    async (turnCount: number) => {
      const api = readNativeApi();
      if (!api || !activeWorkspace || isRevertingCheckpoint) return;

      if (phase === "running" || isSendBusy || isConnecting) {
        setWorkspaceError(
          activeWorkspace.id,
          "Interrupt the current turn before reverting checkpoints.",
        );
        return;
      }
      const confirmed = await api.dialogs.confirm(
        [
          `Revert this workspace to checkpoint ${turnCount}?`,
          "This will discard newer messages and turn diffs in this workspace.",
          "This action cannot be undone.",
        ].join("\n"),
      );
      if (!confirmed) {
        return;
      }

      setIsRevertingCheckpoint(true);
      setWorkspaceError(activeWorkspace.id, null);
      try {
        await api.orchestration.dispatchCommand({
          type: "workspace.checkpoint.revert",
          commandId: newCommandId(),
          workspaceId: activeWorkspace.id,
          turnCount,
          createdAt: new Date().toISOString(),
        });
      } catch (err) {
        setWorkspaceError(
          activeWorkspace.id,
          err instanceof Error ? err.message : "Failed to revert workspace state.",
        );
      }
      setIsRevertingCheckpoint(false);
    },
    [activeWorkspace, isConnecting, isRevertingCheckpoint, isSendBusy, phase, setWorkspaceError],
  );

  const onSend = async (e?: { preventDefault: () => void }) => {
    e?.preventDefault();
    const api = readNativeApi();
    if (!api || !activeWorkspace || isSendBusy || isConnecting || sendInFlightRef.current) return;
    if (activePendingProgress) {
      onAdvanceActivePendingUserInput();
      return;
    }
    const promptForSend = promptRef.current;
    const {
      trimmedPrompt: trimmed,
      sendableTerminalContexts: sendableComposerTerminalContexts,
      expiredTerminalContextCount,
      hasSendableContent,
    } = deriveComposerSendState({
      prompt: promptForSend,
      imageCount: composerImages.length,
      terminalContexts: composerTerminalContexts,
    });
    if (showPlanFollowUpPrompt && activeProposedPlan) {
      const followUp = resolvePlanFollowUpSubmission({
        draftText: trimmed,
        planMarkdown: activeProposedPlan.planMarkdown,
      });
      promptRef.current = "";
      clearComposerDraftContent(activeWorkspace.id);
      setComposerHighlightedItemId(null);
      setComposerCursor(0);
      setComposerTrigger(null);
      await onSubmitPlanFollowUp({
        text: followUp.text,
        interactionMode: followUp.interactionMode,
      });
      return;
    }
    const standaloneSlashCommand =
      composerImages.length === 0 && sendableComposerTerminalContexts.length === 0
        ? parseStandaloneComposerSlashCommand(trimmed)
        : null;
    if (standaloneSlashCommand) {
      handleInteractionModeChange(standaloneSlashCommand);
      promptRef.current = "";
      clearComposerDraftContent(activeWorkspace.id);
      setComposerHighlightedItemId(null);
      setComposerCursor(0);
      setComposerTrigger(null);
      return;
    }
    if (!hasSendableContent) {
      if (expiredTerminalContextCount > 0) {
        const toastCopy = buildExpiredTerminalContextToastCopy(
          expiredTerminalContextCount,
          "empty",
        );
        toastManager.add({
          type: "warning",
          title: toastCopy.title,
          description: toastCopy.description,
        });
      }
      return;
    }
    if (!activeProject) return;
    const workspaceIdForSend = activeWorkspace.id;
    const isFirstMessage = !isServerWorkspace || activeWorkspace.messages.length === 0;
    const baseBranchForWorktree =
      isFirstMessage && envMode === "worktree" && !activeWorkspace.worktreePath
        ? activeWorkspace.branch
        : null;

    // In worktree mode, require an explicit base branch so we don't silently
    // fall back to local execution when branch selection is missing.
    const shouldCreateWorktree =
      isFirstMessage && envMode === "worktree" && !activeWorkspace.worktreePath;
    if (shouldCreateWorktree && !activeWorkspace.branch) {
      setStoreWorkspaceError(
        workspaceIdForSend,
        "Select a base branch before sending in New worktree mode.",
      );
      return;
    }

    sendInFlightRef.current = true;
    beginLocalDispatch({ preparingWorktree: Boolean(baseBranchForWorktree) });

    const composerImagesSnapshot = [...composerImages];
    const composerTerminalContextsSnapshot = [...sendableComposerTerminalContexts];
    const messageTextForSend = appendTerminalContextsToPrompt(
      promptForSend,
      composerTerminalContextsSnapshot,
    );
    const messageIdForSend = newMessageId();
    const messageCreatedAt = new Date().toISOString();
    const outgoingMessageText = formatOutgoingPrompt({
      provider: selectedProvider,
      model: selectedModel,
      models: selectedProviderModels,
      effort: selectedPromptEffort,
      text: messageTextForSend || IMAGE_ONLY_BOOTSTRAP_PROMPT,
    });
    const turnAttachmentsPromise = Promise.all(
      composerImagesSnapshot.map(async (image) => ({
        type: "image" as const,
        name: image.name,
        mimeType: image.mimeType,
        sizeBytes: image.sizeBytes,
        dataUrl: await readFileAsDataUrl(image.file),
      })),
    );
    const optimisticAttachments = composerImagesSnapshot.map((image) => ({
      type: "image" as const,
      id: image.id,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      previewUrl: image.previewUrl,
    }));
    setOptimisticUserMessages((existing) => [
      ...existing,
      {
        id: messageIdForSend,
        role: "user",
        text: outgoingMessageText,
        ...(optimisticAttachments.length > 0 ? { attachments: optimisticAttachments } : {}),
        createdAt: messageCreatedAt,
        streaming: false,
      },
    ]);
    // Sending a message should always bring the latest user turn into view.
    shouldAutoScrollRef.current = true;
    forceStickToBottom();

    setWorkspaceError(workspaceIdForSend, null);
    if (expiredTerminalContextCount > 0) {
      const toastCopy = buildExpiredTerminalContextToastCopy(
        expiredTerminalContextCount,
        "omitted",
      );
      toastManager.add({
        type: "warning",
        title: toastCopy.title,
        description: toastCopy.description,
      });
    }
    promptRef.current = "";
    clearComposerDraftContent(workspaceIdForSend);
    setComposerHighlightedItemId(null);
    setComposerCursor(0);
    setComposerTrigger(null);

    let turnStartSucceeded = false;
    await (async () => {
      let firstComposerImageName: string | null = null;
      if (composerImagesSnapshot.length > 0) {
        const firstComposerImage = composerImagesSnapshot[0];
        if (firstComposerImage) {
          firstComposerImageName = firstComposerImage.name;
        }
      }
      let titleSeed = trimmed;
      if (!titleSeed) {
        if (firstComposerImageName) {
          titleSeed = `Image: ${firstComposerImageName}`;
        } else if (composerTerminalContextsSnapshot.length > 0) {
          titleSeed = formatTerminalContextLabel(composerTerminalContextsSnapshot[0]!);
        } else {
          titleSeed = "New workspace";
        }
      }
      const title = truncate(titleSeed);
      const workspaceCreateModelSelection: ModelSelection = {
        provider: selectedProvider,
        model:
          selectedModel ||
          activeProject.defaultModelSelection?.model ||
          DEFAULT_MODEL_BY_PROVIDER.codex,
        ...(selectedModelSelection.options ? { options: selectedModelSelection.options } : {}),
      };

      // Auto-title from first message
      if (isFirstMessage && isServerWorkspace) {
        await api.orchestration.dispatchCommand({
          type: "workspace.meta.update",
          commandId: newCommandId(),
          workspaceId: workspaceIdForSend,
          title,
        });
      }

      if (isServerWorkspace) {
        await persistWorkspaceSettingsForNextTurn({
          workspaceId: workspaceIdForSend,
          createdAt: messageCreatedAt,
          ...(selectedModel ? { modelSelection: selectedModelSelection } : {}),
          runtimeMode,
          interactionMode,
        });
      }

      const turnAttachments = await turnAttachmentsPromise;
      const bootstrap =
        isLocalDraftWorkspace || baseBranchForWorktree
          ? {
              ...(isLocalDraftWorkspace
                ? {
                    createWorkspace: {
                      projectId: activeProject.id,
                      title,
                      modelSelection: workspaceCreateModelSelection,
                      runtimeMode,
                      interactionMode,
                      branch: activeWorkspace.branch,
                      worktreePath: activeWorkspace.worktreePath,
                      createdAt: activeWorkspace.createdAt,
                    },
                  }
                : {}),
              ...(baseBranchForWorktree
                ? {
                    prepareWorktree: {
                      projectCwd: activeProject.cwd,
                      baseBranch: baseBranchForWorktree,
                      branch: buildTemporaryWorktreeBranchName(),
                    },
                    runSetupScript: true,
                  }
                : {}),
            }
          : undefined;
      beginLocalDispatch({ preparingWorktree: false });
      await api.orchestration.dispatchCommand({
        type: "workspace.turn.start",
        commandId: newCommandId(),
        workspaceId: workspaceIdForSend,
        message: {
          messageId: messageIdForSend,
          role: "user",
          text: outgoingMessageText,
          attachments: turnAttachments,
        },
        modelSelection: selectedModelSelection,
        titleSeed: title,
        runtimeMode,
        interactionMode,
        ...(bootstrap ? { bootstrap } : {}),
        createdAt: messageCreatedAt,
      });
      turnStartSucceeded = true;
    })().catch(async (err: unknown) => {
      if (
        !turnStartSucceeded &&
        promptRef.current.length === 0 &&
        composerImagesRef.current.length === 0 &&
        composerTerminalContextsRef.current.length === 0
      ) {
        setOptimisticUserMessages((existing) => {
          const removed = existing.filter((message) => message.id === messageIdForSend);
          for (const message of removed) {
            revokeUserMessagePreviewUrls(message);
          }
          const next = existing.filter((message) => message.id !== messageIdForSend);
          return next.length === existing.length ? existing : next;
        });
        promptRef.current = promptForSend;
        setPrompt(promptForSend);
        setComposerCursor(collapseExpandedComposerCursor(promptForSend, promptForSend.length));
        addComposerImagesToDraft(composerImagesSnapshot.map(cloneComposerImageForRetry));
        addComposerTerminalContextsToDraft(composerTerminalContextsSnapshot);
        setComposerTrigger(detectComposerTrigger(promptForSend, promptForSend.length));
      }
      setWorkspaceError(
        workspaceIdForSend,
        err instanceof Error ? err.message : "Failed to send message.",
      );
    });
    sendInFlightRef.current = false;
    if (!turnStartSucceeded) {
      resetLocalDispatch();
    }
  };
  const onSendRef = useRef(onSend);
  onSendRef.current = onSend;

  const onInterrupt = async () => {
    const api = readNativeApi();
    if (!api || !activeWorkspace) return;
    await api.orchestration.dispatchCommand({
      type: "workspace.turn.interrupt",
      commandId: newCommandId(),
      workspaceId: activeWorkspace.id,
      createdAt: new Date().toISOString(),
    });
  };

  const onRespondToApproval = useCallback(
    async (requestId: ApprovalRequestId, decision: ProviderApprovalDecision) => {
      const api = readNativeApi();
      if (!api || !activeWorkspaceId) return;

      setRespondingRequestIds((existing) =>
        existing.includes(requestId) ? existing : [...existing, requestId],
      );
      await api.orchestration
        .dispatchCommand({
          type: "workspace.approval.respond",
          commandId: newCommandId(),
          workspaceId: activeWorkspaceId,
          requestId,
          decision,
          createdAt: new Date().toISOString(),
        })
        .catch((err: unknown) => {
          setWorkspaceError(
            activeWorkspaceId,
            err instanceof Error ? err.message : "Failed to submit approval decision.",
          );
        });
      setRespondingRequestIds((existing) => existing.filter((id) => id !== requestId));
    },
    [activeWorkspaceId, setWorkspaceError],
  );

  const onRespondToUserInput = useCallback(
    async (requestId: ApprovalRequestId, answers: Record<string, unknown>) => {
      const api = readNativeApi();
      if (!api || !activeWorkspaceId) return;

      setRespondingUserInputRequestIds((existing) =>
        existing.includes(requestId) ? existing : [...existing, requestId],
      );
      await api.orchestration
        .dispatchCommand({
          type: "workspace.user-input.respond",
          commandId: newCommandId(),
          workspaceId: activeWorkspaceId,
          requestId,
          answers,
          createdAt: new Date().toISOString(),
        })
        .catch((err: unknown) => {
          setWorkspaceError(
            activeWorkspaceId,
            err instanceof Error ? err.message : "Failed to submit user input.",
          );
        });
      setRespondingUserInputRequestIds((existing) => existing.filter((id) => id !== requestId));
    },
    [activeWorkspaceId, setWorkspaceError],
  );

  const setActivePendingUserInputQuestionIndex = useCallback(
    (nextQuestionIndex: number) => {
      if (!activePendingUserInput) {
        return;
      }
      setPendingUserInputQuestionIndexByRequestId((existing) => ({
        ...existing,
        [activePendingUserInput.requestId]: nextQuestionIndex,
      }));
    },
    [activePendingUserInput],
  );

  const onSelectActivePendingUserInputOption = useCallback(
    (questionId: string, optionLabel: string) => {
      if (!activePendingUserInput) {
        return;
      }
      setPendingUserInputAnswersByRequestId((existing) => ({
        ...existing,
        [activePendingUserInput.requestId]: {
          ...existing[activePendingUserInput.requestId],
          [questionId]: {
            selectedOptionLabel: optionLabel,
            customAnswer: "",
          },
        },
      }));
      promptRef.current = "";
      setComposerCursor(0);
      setComposerTrigger(null);
    },
    [activePendingUserInput],
  );

  const onChangeActivePendingUserInputCustomAnswer = useCallback(
    (
      questionId: string,
      value: string,
      nextCursor: number,
      expandedCursor: number,
      cursorAdjacentToMention: boolean,
    ) => {
      if (!activePendingUserInput) {
        return;
      }
      promptRef.current = value;
      setPendingUserInputAnswersByRequestId((existing) => ({
        ...existing,
        [activePendingUserInput.requestId]: {
          ...existing[activePendingUserInput.requestId],
          [questionId]: setPendingUserInputCustomAnswer(
            existing[activePendingUserInput.requestId]?.[questionId],
            value,
          ),
        },
      }));
      setComposerCursor(nextCursor);
      setComposerTrigger(
        cursorAdjacentToMention ? null : detectComposerTrigger(value, expandedCursor),
      );
    },
    [activePendingUserInput],
  );

  const onAdvanceActivePendingUserInput = useCallback(() => {
    if (!activePendingUserInput || !activePendingProgress) {
      return;
    }
    if (activePendingProgress.isLastQuestion) {
      if (activePendingResolvedAnswers) {
        void onRespondToUserInput(activePendingUserInput.requestId, activePendingResolvedAnswers);
      }
      return;
    }
    setActivePendingUserInputQuestionIndex(activePendingProgress.questionIndex + 1);
  }, [
    activePendingProgress,
    activePendingResolvedAnswers,
    activePendingUserInput,
    onRespondToUserInput,
    setActivePendingUserInputQuestionIndex,
  ]);

  const onPreviousActivePendingUserInputQuestion = useCallback(() => {
    if (!activePendingProgress) {
      return;
    }
    setActivePendingUserInputQuestionIndex(Math.max(activePendingProgress.questionIndex - 1, 0));
  }, [activePendingProgress, setActivePendingUserInputQuestionIndex]);

  const onSubmitPlanFollowUp = useCallback(
    async ({
      text,
      interactionMode: nextInteractionMode,
    }: {
      text: string;
      interactionMode: "default" | "plan";
    }) => {
      const api = readNativeApi();
      if (
        !api ||
        !activeWorkspace ||
        !isServerWorkspace ||
        isSendBusy ||
        isConnecting ||
        sendInFlightRef.current
      ) {
        return;
      }

      const trimmed = text.trim();
      if (!trimmed) {
        return;
      }

      const workspaceIdForSend = activeWorkspace.id;
      const messageIdForSend = newMessageId();
      const messageCreatedAt = new Date().toISOString();
      const outgoingMessageText = formatOutgoingPrompt({
        provider: selectedProvider,
        model: selectedModel,
        models: selectedProviderModels,
        effort: selectedPromptEffort,
        text: trimmed,
      });

      sendInFlightRef.current = true;
      beginLocalDispatch({ preparingWorktree: false });
      setWorkspaceError(workspaceIdForSend, null);
      setOptimisticUserMessages((existing) => [
        ...existing,
        {
          id: messageIdForSend,
          role: "user",
          text: outgoingMessageText,
          createdAt: messageCreatedAt,
          streaming: false,
        },
      ]);
      shouldAutoScrollRef.current = true;
      forceStickToBottom();

      try {
        await persistWorkspaceSettingsForNextTurn({
          workspaceId: workspaceIdForSend,
          createdAt: messageCreatedAt,
          modelSelection: selectedModelSelection,
          runtimeMode,
          interactionMode: nextInteractionMode,
        });

        // Keep the mode toggle and plan-follow-up banner in sync immediately
        // while the same-workspace implementation turn is starting.
        setComposerDraftInteractionMode(workspaceIdForSend, nextInteractionMode);

        await api.orchestration.dispatchCommand({
          type: "workspace.turn.start",
          commandId: newCommandId(),
          workspaceId: workspaceIdForSend,
          message: {
            messageId: messageIdForSend,
            role: "user",
            text: outgoingMessageText,
            attachments: [],
          },
          modelSelection: selectedModelSelection,
          titleSeed: activeWorkspace.title,
          runtimeMode,
          interactionMode: nextInteractionMode,
          ...(nextInteractionMode === "default" && activeProposedPlan
            ? {
                sourceProposedPlan: {
                  workspaceId: activeWorkspace.id,
                  planId: activeProposedPlan.id,
                },
              }
            : {}),
          createdAt: messageCreatedAt,
        });
        // Optimistically open the plan sidebar when implementing (not refining).
        // "default" mode here means the agent is executing the plan, which produces
        // step-tracking activities that the sidebar will display.
        if (nextInteractionMode === "default") {
          planSidebarDismissedForTurnRef.current = null;
          setPlanSidebarOpen(true);
        }
        sendInFlightRef.current = false;
      } catch (err) {
        setOptimisticUserMessages((existing) =>
          existing.filter((message) => message.id !== messageIdForSend),
        );
        setWorkspaceError(
          workspaceIdForSend,
          err instanceof Error ? err.message : "Failed to send plan follow-up.",
        );
        sendInFlightRef.current = false;
        resetLocalDispatch();
      }
    },
    [
      activeWorkspace,
      activeProposedPlan,
      beginLocalDispatch,
      forceStickToBottom,
      isConnecting,
      isSendBusy,
      isServerWorkspace,
      persistWorkspaceSettingsForNextTurn,
      resetLocalDispatch,
      runtimeMode,
      selectedPromptEffort,
      selectedModelSelection,
      selectedProvider,
      selectedProviderModels,
      setComposerDraftInteractionMode,
      setWorkspaceError,
      selectedModel,
    ],
  );

  const onImplementPlanInNewWorkspace = useCallback(async () => {
    const api = readNativeApi();
    if (
      !api ||
      !activeWorkspace ||
      !activeProject ||
      !activeProposedPlan ||
      !isServerWorkspace ||
      isSendBusy ||
      isConnecting ||
      sendInFlightRef.current
    ) {
      return;
    }

    const createdAt = new Date().toISOString();
    const nextWorkspaceId = newWorkspaceId();
    const planMarkdown = activeProposedPlan.planMarkdown;
    const implementationPrompt = buildPlanImplementationPrompt(planMarkdown);
    const outgoingImplementationPrompt = formatOutgoingPrompt({
      provider: selectedProvider,
      model: selectedModel,
      models: selectedProviderModels,
      effort: selectedPromptEffort,
      text: implementationPrompt,
    });
    const nextWorkspaceTitle = truncate(buildPlanImplementationWorkspaceTitle(planMarkdown));
    const nextWorkspaceModelSelection: ModelSelection = selectedModelSelection;

    sendInFlightRef.current = true;
    beginLocalDispatch({ preparingWorktree: false });
    const finish = () => {
      sendInFlightRef.current = false;
      resetLocalDispatch();
    };

    await api.orchestration
      .dispatchCommand({
        type: "workspace.create",
        commandId: newCommandId(),
        workspaceId: nextWorkspaceId,
        projectId: activeProject.id,
        title: nextWorkspaceTitle,
        modelSelection: nextWorkspaceModelSelection,
        runtimeMode,
        interactionMode: "default",
        branch: activeWorkspace.branch,
        worktreePath: activeWorkspace.worktreePath,
        createdAt,
      })
      .then(() => {
        return api.orchestration.dispatchCommand({
          type: "workspace.turn.start",
          commandId: newCommandId(),
          workspaceId: nextWorkspaceId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: outgoingImplementationPrompt,
            attachments: [],
          },
          modelSelection: selectedModelSelection,
          titleSeed: nextWorkspaceTitle,
          runtimeMode,
          interactionMode: "default",
          sourceProposedPlan: {
            workspaceId: activeWorkspace.id,
            planId: activeProposedPlan.id,
          },
          createdAt,
        });
      })
      .then(() => {
        return waitForStartedServerWorkspace(nextWorkspaceId);
      })
      .then(() => {
        // Signal that the plan sidebar should open on the new workspace.
        planSidebarOpenOnNextWorkspaceRef.current = true;
        return navigate({
          to: "/$workspaceId",
          params: { workspaceId: nextWorkspaceId },
        });
      })
      .catch(async (err) => {
        await api.orchestration
          .dispatchCommand({
            type: "workspace.delete",
            commandId: newCommandId(),
            workspaceId: nextWorkspaceId,
          })
          .catch(() => undefined);
        toastManager.add({
          type: "error",
          title: "Could not start implementation workspace",
          description:
            err instanceof Error
              ? err.message
              : "An error occurred while creating the new workspace.",
        });
      })
      .then(finish, finish);
  }, [
    activeProject,
    activeProposedPlan,
    activeWorkspace,
    beginLocalDispatch,
    isConnecting,
    isSendBusy,
    isServerWorkspace,
    navigate,
    resetLocalDispatch,
    runtimeMode,
    selectedPromptEffort,
    selectedModelSelection,
    selectedProvider,
    selectedProviderModels,
    selectedModel,
  ]);

  const onProviderModelSelect = useCallback(
    (provider: ProviderKind, model: string) => {
      if (!activeWorkspace) return;
      const resolvedProvider = resolveSelectableProvider(providerStatuses, provider);
      const resolvedModel = resolveAppModelSelection(
        resolvedProvider,
        settings,
        providerStatuses,
        model,
      );
      const nextModelSelection: ModelSelection = {
        provider: resolvedProvider,
        model: resolvedModel,
      };
      setComposerDraftModelSelection(activeWorkspace.id, nextModelSelection);
      setStickyComposerModelSelection(nextModelSelection);
      scheduleComposerFocus();
    },
    [
      activeWorkspace,
      scheduleComposerFocus,
      setComposerDraftModelSelection,
      setStickyComposerModelSelection,
      providerStatuses,
      settings,
    ],
  );
  const setPromptFromTraits = useCallback(
    (nextPrompt: string) => {
      const currentPrompt = promptRef.current;
      if (nextPrompt === currentPrompt) {
        scheduleComposerFocus();
        return;
      }
      promptRef.current = nextPrompt;
      setPrompt(nextPrompt);
      const nextCursor = collapseExpandedComposerCursor(nextPrompt, nextPrompt.length);
      setComposerCursor(nextCursor);
      setComposerTrigger(detectComposerTrigger(nextPrompt, nextPrompt.length));
      scheduleComposerFocus();
    },
    [scheduleComposerFocus, setPrompt],
  );
  const providerTraitsMenuContent = renderProviderTraitsMenuContent({
    provider: selectedProvider,
    workspaceId,
    model: selectedModel,
    models: selectedProviderModels,
    modelOptions: composerModelOptions?.[selectedProvider],
    prompt,
    onPromptChange: setPromptFromTraits,
  });
  const providerTraitsPicker = renderProviderTraitsPicker({
    provider: selectedProvider,
    workspaceId,
    model: selectedModel,
    models: selectedProviderModels,
    modelOptions: composerModelOptions?.[selectedProvider],
    prompt,
    onPromptChange: setPromptFromTraits,
  });
  const onEnvModeChange = useCallback(
    (mode: DraftWorkspaceEnvMode) => {
      if (isLocalDraftWorkspace) {
        setDraftWorkspaceContext(workspaceId, { envMode: mode });
      }
      scheduleComposerFocus();
    },
    [isLocalDraftWorkspace, scheduleComposerFocus, setDraftWorkspaceContext, workspaceId],
  );

  const applyPromptReplacement = useCallback(
    (
      rangeStart: number,
      rangeEnd: number,
      replacement: string,
      options?: { expectedText?: string },
    ): boolean => {
      const currentText = promptRef.current;
      const safeStart = Math.max(0, Math.min(currentText.length, rangeStart));
      const safeEnd = Math.max(safeStart, Math.min(currentText.length, rangeEnd));
      if (
        options?.expectedText !== undefined &&
        currentText.slice(safeStart, safeEnd) !== options.expectedText
      ) {
        return false;
      }
      const next = replaceTextRange(promptRef.current, rangeStart, rangeEnd, replacement);
      const nextCursor = collapseExpandedComposerCursor(next.text, next.cursor);
      promptRef.current = next.text;
      const activePendingQuestion = activePendingProgress?.activeQuestion;
      if (activePendingQuestion && activePendingUserInput) {
        setPendingUserInputAnswersByRequestId((existing) => ({
          ...existing,
          [activePendingUserInput.requestId]: {
            ...existing[activePendingUserInput.requestId],
            [activePendingQuestion.id]: setPendingUserInputCustomAnswer(
              existing[activePendingUserInput.requestId]?.[activePendingQuestion.id],
              next.text,
            ),
          },
        }));
      } else {
        setPrompt(next.text);
      }
      setComposerCursor(nextCursor);
      setComposerTrigger(
        detectComposerTrigger(next.text, expandCollapsedComposerCursor(next.text, nextCursor)),
      );
      window.requestAnimationFrame(() => {
        composerEditorRef.current?.focusAt(nextCursor);
      });
      return true;
    },
    [activePendingProgress?.activeQuestion, activePendingUserInput, setPrompt],
  );

  const readComposerSnapshot = useCallback((): {
    value: string;
    cursor: number;
    expandedCursor: number;
    terminalContextIds: string[];
  } => {
    const editorSnapshot = composerEditorRef.current?.readSnapshot();
    if (editorSnapshot) {
      return editorSnapshot;
    }
    return {
      value: promptRef.current,
      cursor: composerCursor,
      expandedCursor: expandCollapsedComposerCursor(promptRef.current, composerCursor),
      terminalContextIds: composerTerminalContexts.map((context) => context.id),
    };
  }, [composerCursor, composerTerminalContexts]);

  const resolveActiveComposerTrigger = useCallback((): {
    snapshot: { value: string; cursor: number; expandedCursor: number };
    trigger: ComposerTrigger | null;
  } => {
    const snapshot = readComposerSnapshot();
    return {
      snapshot,
      trigger: detectComposerTrigger(snapshot.value, snapshot.expandedCursor),
    };
  }, [readComposerSnapshot]);

  const onSelectComposerItem = useCallback(
    (item: ComposerCommandItem) => {
      if (composerSelectLockRef.current) return;
      composerSelectLockRef.current = true;
      window.requestAnimationFrame(() => {
        composerSelectLockRef.current = false;
      });
      const { snapshot, trigger } = resolveActiveComposerTrigger();
      if (!trigger) return;
      if (item.type === "path") {
        const replacement = `@${item.path} `;
        const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
          snapshot.value,
          trigger.rangeEnd,
          replacement,
        );
        const applied = applyPromptReplacement(
          trigger.rangeStart,
          replacementRangeEnd,
          replacement,
          { expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd) },
        );
        if (applied) {
          setComposerHighlightedItemId(null);
        }
        return;
      }
      if (item.type === "slash-command") {
        if (item.command === "model") {
          const replacement = "/model ";
          const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
            snapshot.value,
            trigger.rangeEnd,
            replacement,
          );
          const applied = applyPromptReplacement(
            trigger.rangeStart,
            replacementRangeEnd,
            replacement,
            { expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd) },
          );
          if (applied) {
            setComposerHighlightedItemId(null);
          }
          return;
        }
        void handleInteractionModeChange(item.command === "plan" ? "plan" : "default");
        const applied = applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, "", {
          expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),
        });
        if (applied) {
          setComposerHighlightedItemId(null);
        }
        return;
      }
      if (item.type === "native-slash-command") {
        const replacement = `${item.label} `;
        const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
          snapshot.value,
          trigger.rangeEnd,
          replacement,
        );
        const applied = applyPromptReplacement(
          trigger.rangeStart,
          replacementRangeEnd,
          replacement,
          { expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd) },
        );
        if (applied) {
          setComposerHighlightedItemId(null);
        }
        return;
      }
      onProviderModelSelect(item.provider, item.model);
      const applied = applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, "", {
        expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),
      });
      if (applied) {
        setComposerHighlightedItemId(null);
      }
    },
    [
      applyPromptReplacement,
      handleInteractionModeChange,
      onProviderModelSelect,
      resolveActiveComposerTrigger,
    ],
  );
  const onComposerMenuItemHighlighted = useCallback((itemId: string | null) => {
    setComposerHighlightedItemId(itemId);
  }, []);
  const nudgeComposerMenuHighlight = useCallback(
    (key: "ArrowDown" | "ArrowUp") => {
      if (composerMenuItems.length === 0) {
        return;
      }
      const highlightedIndex = composerMenuItems.findIndex(
        (item) => item.id === composerHighlightedItemId,
      );
      const normalizedIndex =
        highlightedIndex >= 0 ? highlightedIndex : key === "ArrowDown" ? -1 : 0;
      const offset = key === "ArrowDown" ? 1 : -1;
      const nextIndex =
        (normalizedIndex + offset + composerMenuItems.length) % composerMenuItems.length;
      const nextItem = composerMenuItems[nextIndex];
      setComposerHighlightedItemId(nextItem?.id ?? null);
    },
    [composerHighlightedItemId, composerMenuItems],
  );
  const isComposerMenuLoading =
    composerTriggerKind === "path" &&
    ((pathTriggerQuery.length > 0 && composerPathQueryDebouncer.state.isPending) ||
      workspaceEntriesQuery.isLoading ||
      workspaceEntriesQuery.isFetching);

  const onPromptChange = useCallback(
    (
      nextPrompt: string,
      nextCursor: number,
      expandedCursor: number,
      cursorAdjacentToMention: boolean,
      terminalContextIds: string[],
    ) => {
      if (activePendingProgress?.activeQuestion && activePendingUserInput) {
        onChangeActivePendingUserInputCustomAnswer(
          activePendingProgress.activeQuestion.id,
          nextPrompt,
          nextCursor,
          expandedCursor,
          cursorAdjacentToMention,
        );
        return;
      }
      promptRef.current = nextPrompt;
      setPrompt(nextPrompt);
      if (!terminalContextIdListsEqual(composerTerminalContexts, terminalContextIds)) {
        setComposerDraftTerminalContexts(
          workspaceId,
          syncTerminalContextsByIds(composerTerminalContexts, terminalContextIds),
        );
      }
      setComposerCursor(nextCursor);
      setComposerTrigger(
        cursorAdjacentToMention ? null : detectComposerTrigger(nextPrompt, expandedCursor),
      );
    },
    [
      activePendingProgress?.activeQuestion,
      activePendingUserInput,
      composerTerminalContexts,
      onChangeActivePendingUserInputCustomAnswer,
      setPrompt,
      setComposerDraftTerminalContexts,
      workspaceId,
    ],
  );

  const onComposerCommandKey = (
    key: "ArrowDown" | "ArrowUp" | "Enter" | "Tab",
    event: KeyboardEvent,
  ) => {
    if (key === "Tab" && event.shiftKey) {
      toggleInteractionMode();
      return true;
    }

    const { trigger } = resolveActiveComposerTrigger();
    const menuIsActive = composerMenuOpenRef.current || trigger !== null;

    if (menuIsActive) {
      const currentItems = composerMenuItemsRef.current;
      if (key === "ArrowDown" && currentItems.length > 0) {
        nudgeComposerMenuHighlight("ArrowDown");
        return true;
      }
      if (key === "ArrowUp" && currentItems.length > 0) {
        nudgeComposerMenuHighlight("ArrowUp");
        return true;
      }
      if (key === "Tab" || key === "Enter") {
        const selectedItem = activeComposerMenuItemRef.current ?? currentItems[0];
        if (selectedItem) {
          onSelectComposerItem(selectedItem);
          return true;
        }
      }
    }

    if (key === "Enter" && !event.shiftKey) {
      void onSend();
      return true;
    }
    return false;
  };
  const onToggleWorkGroup = useCallback((groupId: string) => {
    setExpandedWorkGroups((existing) => ({
      ...existing,
      [groupId]: !existing[groupId],
    }));
  }, []);
  const onExpandTimelineImage = useCallback((preview: ExpandedImagePreview) => {
    setExpandedImage(preview);
  }, []);
  const expandedImageItem = expandedImage ? expandedImage.images[expandedImage.index] : null;
  const findDiffTab = useWorkspaceTabStore((s) => s.findDiffTab);
  const onOpenTurnDiff = useCallback(
    (turnId: TurnId, filePath?: string) => {
      if (!filePath || !activeWorkspaceId) return;

      // Resolve checkpoint turn count for this turn
      const summary = turnDiffSummaries.find((s) => s.turnId === turnId);
      const checkpointTurnCount =
        summary?.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[turnId];
      if (typeof checkpointTurnCount !== "number") return;

      const fromTurnCount = Math.max(0, checkpointTurnCount - 1);
      const toTurnCount = checkpointTurnCount;

      // Reuse existing tab if open
      const existing = findDiffTab(workspaceWorkspaceId, activeWorkspaceId, turnId, filePath);
      if (existing) {
        setActiveTab(workspaceWorkspaceId, existing.id);
        return;
      }

      const fileName = filePath.split("/").at(-1) ?? filePath;
      const tab = makeDiffTab({
        diffSourceWorkspaceId: activeWorkspaceId,
        diffTurnId: turnId,
        diffFromTurnCount: fromTurnCount,
        diffToTurnCount: toTurnCount,
        diffFilePath: filePath,
        label: fileName,
      });
      addTab(workspaceWorkspaceId, tab);
    },
    [
      activeWorkspaceId,
      addTab,
      findDiffTab,
      inferredCheckpointTurnCountByTurnId,
      setActiveTab,
      turnDiffSummaries,
      workspaceWorkspaceId,
    ],
  );
  const onRevertUserMessage = (messageId: MessageId) => {
    const targetTurnCount = revertTurnCountByUserMessageId.get(messageId);
    if (typeof targetTurnCount !== "number") {
      return;
    }
    void onRevertToTurnCount(targetTurnCount);
  };

  // Empty state: no active workspace
  if (!activeWorkspace) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-muted-foreground/40">
        {!isElectron && (
          <header className="border-b border-border px-3 py-2 md:hidden">
            <div className="flex items-center gap-2">
              <SidebarTrigger className="size-7 shrink-0" />
              <span className="text-sm font-medium text-foreground">Workspaces</span>
            </div>
          </header>
        )}
        {isElectron && (
          <div
            className="drag-region flex h-[52px] shrink-0 items-center border-b border-border px-5"
            style={sidebarOpen ? undefined : ELECTRON_TRAFFIC_LIGHTS_LEFT_INSET_STYLE}
          >
            <span className="text-xs text-muted-foreground/50">No active workspace</span>
          </div>
        )}
        <div className="flex flex-1 items-center justify-center">
          <div className="text-center">
            <p className="text-sm">Select a workspace or create a new one to get started.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
      {/* Top bar */}
      <header
        className={cn(
          "border-b border-border px-3 sm:px-5",
          isElectron ? "drag-region flex h-[52px] items-center" : "py-2 sm:py-3",
        )}
        style={isElectron && !sidebarOpen ? ELECTRON_TRAFFIC_LIGHTS_LEFT_INSET_STYLE : undefined}
      >
        <ChatHeader
          activeWorkspaceTitle={activeWorkspace.title}
          activeProjectName={activeProject?.name}
          isGitRepo={isGitRepo}
          openInCwd={gitCwd}
          activeProjectScripts={activeProject?.scripts}
          preferredScriptId={
            activeProject ? (lastInvokedScriptByProjectId[activeProject.id] ?? null) : null
          }
          keybindings={keybindings}
          availableEditors={availableEditors}
          sourceControlToggleShortcutLabel={sourceControlShortcutLabel}
          sourceControlOpen={sourceControlOpen}
          onRunProjectScript={(script) => {
            void runProjectScript(script);
          }}
          onAddProjectScript={saveProjectScript}
          onUpdateProjectScript={updateProjectScript}
          onDeleteProjectScript={deleteProjectScript}
          onToggleSourceControl={onToggleSourceControl}
        />
      </header>

      {/* Tab bar */}
      {tabState && (
        <WorkspaceTabBar
          tabs={tabState.tabs}
          activeTabId={tabState.activeTabId}
          canCloseTab={canCloseTab}
          onSelectTab={handleSelectTab}
          onCloseTab={handleCloseTab}
          onAddTab={handleAddTab}
        />
      )}

      {/* Error banner */}
      {isProviderTabActive && <ProviderStatusBanner status={activeProviderStatus} />}
      {isProviderTabActive && (
        <WorkspaceErrorBanner
          error={activeWorkspace.error}
          onDismiss={() => setWorkspaceError(activeWorkspace.id, null)}
        />
      )}
      {/* Main content area with optional plan sidebar */}
      <div className="flex min-h-0 min-w-0 flex-1">
        {isDiffTabActive && activeTab?.diffFilePath && activeTab?.diffSourceWorkspaceId ? (
          /* Diff tab content — single file diff fills the area */
          <DiffFileTabLazy
            workspaceId={activeTab.diffSourceWorkspaceId}
            turnId={activeTab.diffTurnId}
            fromTurnCount={activeTab.diffFromTurnCount ?? 0}
            toTurnCount={activeTab.diffToTurnCount ?? 0}
            filePath={activeTab.diffFilePath}
            resolvedTheme={resolvedTheme}
          />
        ) : isTerminalTabActive && activeTab?.terminalId ? (
          /* Terminal tab content — inline terminal fills the area */
          <PersistentWorkspaceTerminalDrawer
            workspaceId={activeWorkspace.id}
            terminalId={activeTab.terminalId}
            visible
            mode="inline"
            launchContext={activeTerminalLaunchContext ?? null}
            focusRequestId={terminalFocusRequestId}
            splitShortcutLabel={splitTerminalShortcutLabel ?? undefined}
            newShortcutLabel={newTerminalShortcutLabel ?? undefined}
            closeShortcutLabel={closeTerminalShortcutLabel ?? undefined}
            onAddTerminalContext={addTerminalContextToDraft}
            onNewTerminalTab={createNewTerminalTab}
            onCloseTerminalTab={activeTab ? () => handleCloseTab(activeTab.id) : undefined}
          />
        ) : showWorkspaceSelectionState ? (
          <div className="flex min-h-0 flex-1 items-center justify-center px-6 py-10">
            <div className="flex max-w-md flex-col items-center gap-3 text-center">
              <h3 className="text-base font-medium text-foreground">New workspace</h3>
              <p className="text-sm text-muted-foreground">
                Choose a provider tab to start chatting in this workspace.
              </p>
              <div className="flex flex-wrap items-center justify-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => handleAddTab("provider", "codex")}
                >
                  New Codex
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => handleAddTab("provider", "claudeAgent")}
                >
                  New Claude Code
                </Button>
                <Button type="button" variant="ghost" onClick={() => handleAddTab("terminal")}>
                  New Terminal
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <>
            {/* Chat column */}
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              {/* Messages Wrapper */}
              <div className="relative flex min-h-0 flex-1 flex-col">
                {/* Messages */}
                <div
                  ref={setMessagesScrollContainerRef}
                  className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-y-contain px-3 py-3 sm:px-5 sm:py-4"
                  onScroll={onMessagesScroll}
                  onClickCapture={onMessagesClickCapture}
                  onWheel={onMessagesWheel}
                  onPointerDown={onMessagesPointerDown}
                  onPointerUp={onMessagesPointerUp}
                  onPointerCancel={onMessagesPointerCancel}
                  onTouchStart={onMessagesTouchStart}
                  onTouchMove={onMessagesTouchMove}
                  onTouchEnd={onMessagesTouchEnd}
                  onTouchCancel={onMessagesTouchEnd}
                >
                  <MessagesTimeline
                    key={activeWorkspace.id}
                    hasMessages={timelineEntries.length > 0}
                    isWorking={isWorking}
                    activeTurnInProgress={isWorking || !latestTurnSettled}
                    activeTurnStartedAt={activeWorkStartedAt}
                    scrollContainer={messagesScrollElement}
                    timelineEntries={timelineEntries}
                    completionDividerBeforeEntryId={completionDividerBeforeEntryId}
                    completionSummary={completionSummary}
                    turnDiffSummaryByAssistantMessageId={turnDiffSummaryByAssistantMessageId}
                    nowIso={nowIso}
                    expandedWorkGroups={expandedWorkGroups}
                    onToggleWorkGroup={onToggleWorkGroup}
                    onOpenTurnDiff={onOpenTurnDiff}
                    revertTurnCountByUserMessageId={revertTurnCountByUserMessageId}
                    onRevertUserMessage={onRevertUserMessage}
                    isRevertingCheckpoint={isRevertingCheckpoint}
                    onImageExpand={onExpandTimelineImage}
                    markdownCwd={gitCwd ?? undefined}
                    resolvedTheme={resolvedTheme}
                    timestampFormat={timestampFormat}
                    workspaceRoot={activeWorkspaceRoot}
                    onContentHeightChange={onTimelineContentHeightChange}
                  />
                </div>

                {/* scroll to bottom pill — shown when user has scrolled away from the bottom */}
                {showScrollToBottom && (
                  <div className="pointer-events-none absolute bottom-1 left-1/2 z-30 flex -translate-x-1/2 justify-center py-1.5">
                    <button
                      type="button"
                      onClick={() => forceStickToBottom()}
                      className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-border/60 bg-card px-3 py-1 text-muted-foreground text-xs shadow-sm transition-colors hover:border-border hover:text-foreground hover:cursor-pointer"
                    >
                      <ChevronDownIcon className="size-3.5" />
                      Scroll to bottom
                    </button>
                  </div>
                )}
              </div>

              {/* Input bar */}
              <div
                className={cn("px-3 pt-1.5 sm:px-5 sm:pt-2", isGitRepo ? "pb-1" : "pb-3 sm:pb-4")}
              >
                <form
                  ref={composerFormRef}
                  onSubmit={onSend}
                  className="mx-auto w-full min-w-0 max-w-[52rem]"
                  data-chat-composer-form="true"
                >
                  <div
                    className={cn(
                      "group rounded-[22px] p-px transition-colors duration-200",
                      composerProviderState.composerFrameClassName,
                    )}
                    onDragEnter={onComposerDragEnter}
                    onDragOver={onComposerDragOver}
                    onDragLeave={onComposerDragLeave}
                    onDrop={onComposerDrop}
                  >
                    <div
                      className={cn(
                        "rounded-[20px] border bg-card transition-colors duration-200 has-focus-visible:border-ring/45",
                        isDragOverComposer ? "border-primary/70 bg-accent/30" : "border-border",
                        composerProviderState.composerSurfaceClassName,
                      )}
                    >
                      {activePendingApproval ? (
                        <div className="rounded-t-[19px] border-b border-border/65 bg-muted/20">
                          <ComposerPendingApprovalPanel
                            approval={activePendingApproval}
                            pendingCount={pendingApprovals.length}
                          />
                        </div>
                      ) : pendingUserInputs.length > 0 ? (
                        <div className="rounded-t-[19px] border-b border-border/65 bg-muted/20">
                          <ComposerPendingUserInputPanel
                            pendingUserInputs={pendingUserInputs}
                            respondingRequestIds={respondingRequestIds}
                            answers={activePendingDraftAnswers}
                            questionIndex={activePendingQuestionIndex}
                            onSelectOption={onSelectActivePendingUserInputOption}
                            onAdvance={onAdvanceActivePendingUserInput}
                          />
                        </div>
                      ) : showPlanFollowUpPrompt && activeProposedPlan ? (
                        <div className="rounded-t-[19px] border-b border-border/65 bg-muted/20">
                          <ComposerPlanFollowUpBanner
                            key={activeProposedPlan.id}
                            planTitle={proposedPlanTitle(activeProposedPlan.planMarkdown) ?? null}
                          />
                        </div>
                      ) : null}
                      <div
                        className={cn(
                          "relative px-3 pb-2 sm:px-4",
                          hasComposerHeader ? "pt-2.5 sm:pt-3" : "pt-3.5 sm:pt-4",
                        )}
                      >
                        {composerMenuOpen && !isComposerApprovalState && (
                          <div className="absolute inset-x-0 bottom-full z-20 mb-2 px-1">
                            <ComposerCommandMenu
                              items={composerMenuItems}
                              resolvedTheme={resolvedTheme}
                              isLoading={isComposerMenuLoading}
                              triggerKind={composerTriggerKind}
                              activeItemId={activeComposerMenuItem?.id ?? null}
                              onHighlightedItemChange={onComposerMenuItemHighlighted}
                              onSelect={onSelectComposerItem}
                            />
                          </div>
                        )}

                        {!isComposerApprovalState &&
                          pendingUserInputs.length === 0 &&
                          composerImages.length > 0 && (
                            <div className="mb-3 flex flex-wrap gap-2">
                              {composerImages.map((image) => (
                                <div
                                  key={image.id}
                                  className="relative h-16 w-16 overflow-hidden rounded-lg border border-border/80 bg-background"
                                >
                                  {image.previewUrl ? (
                                    <button
                                      type="button"
                                      className="h-full w-full cursor-zoom-in"
                                      aria-label={`Preview ${image.name}`}
                                      onClick={() => {
                                        const preview = buildExpandedImagePreview(
                                          composerImages,
                                          image.id,
                                        );
                                        if (!preview) return;
                                        setExpandedImage(preview);
                                      }}
                                    >
                                      <img
                                        src={image.previewUrl}
                                        alt={image.name}
                                        className="h-full w-full object-cover"
                                      />
                                    </button>
                                  ) : (
                                    <div className="flex h-full w-full items-center justify-center px-1 text-center text-[10px] text-muted-foreground/70">
                                      {image.name}
                                    </div>
                                  )}
                                  {nonPersistedComposerImageIdSet.has(image.id) && (
                                    <Tooltip>
                                      <TooltipTrigger
                                        render={
                                          <span
                                            role="img"
                                            aria-label="Draft attachment may not persist"
                                            className="absolute left-1 top-1 inline-flex items-center justify-center rounded bg-background/85 p-0.5 text-amber-600"
                                          >
                                            <CircleAlertIcon className="size-3" />
                                          </span>
                                        }
                                      />
                                      <TooltipPopup
                                        side="top"
                                        className="max-w-64 whitespace-normal leading-tight"
                                      >
                                        Draft attachment could not be saved locally and may be lost
                                        on navigation.
                                      </TooltipPopup>
                                    </Tooltip>
                                  )}
                                  <Button
                                    variant="ghost"
                                    size="icon-xs"
                                    className="absolute right-1 top-1 bg-background/80 hover:bg-background/90"
                                    onClick={() => removeComposerImage(image.id)}
                                    aria-label={`Remove ${image.name}`}
                                  >
                                    <XIcon />
                                  </Button>
                                </div>
                              ))}
                            </div>
                          )}
                        <ComposerPromptEditor
                          ref={composerEditorRef}
                          value={
                            isComposerApprovalState
                              ? ""
                              : activePendingProgress
                                ? activePendingProgress.customAnswer
                                : prompt
                          }
                          cursor={composerCursor}
                          terminalContexts={
                            !isComposerApprovalState && pendingUserInputs.length === 0
                              ? composerTerminalContexts
                              : []
                          }
                          onRemoveTerminalContext={removeComposerTerminalContextFromDraft}
                          onChange={onPromptChange}
                          onCommandKeyDown={onComposerCommandKey}
                          onPaste={onComposerPaste}
                          placeholder={
                            isComposerApprovalState
                              ? (activePendingApproval?.detail ??
                                "Resolve this approval request to continue")
                              : activePendingProgress
                                ? "Type your own answer, or leave this blank to use the selected option"
                                : showPlanFollowUpPrompt && activeProposedPlan
                                  ? "Add feedback to refine the plan, or leave this blank to implement it"
                                  : phase === "disconnected"
                                    ? "Ask for follow-up changes or attach images"
                                    : "Ask anything, @tag files/folders, or use / to show available commands"
                          }
                          disabled={isConnecting || isComposerApprovalState}
                        />
                      </div>

                      {/* Bottom toolbar */}
                      {activePendingApproval ? (
                        <div className="flex items-center justify-end gap-2 px-2.5 pb-2.5 sm:px-3 sm:pb-3">
                          <ComposerPendingApprovalActions
                            requestId={activePendingApproval.requestId}
                            isResponding={respondingRequestIds.includes(
                              activePendingApproval.requestId,
                            )}
                            onRespondToApproval={onRespondToApproval}
                          />
                        </div>
                      ) : (
                        <div
                          ref={composerFooterRef}
                          data-chat-composer-footer="true"
                          data-chat-composer-footer-compact={
                            isComposerFooterCompact ? "true" : "false"
                          }
                          className={cn(
                            "flex min-w-0 flex-nowrap items-center justify-between gap-2 overflow-hidden px-2.5 pb-2.5 sm:px-3 sm:pb-3",
                            isComposerFooterCompact ? "gap-1.5" : "gap-2 sm:gap-0",
                          )}
                        >
                          <div
                            ref={composerFooterLeadingRef}
                            className={cn(
                              "flex min-w-0 flex-1 items-center",
                              isComposerFooterCompact
                                ? "gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                                : "gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:min-w-max sm:overflow-visible",
                            )}
                          >
                            {isComposerFooterCompact ? (
                              <>
                                <ProviderModelPicker
                                  provider={selectedProvider}
                                  model={selectedModel}
                                  lockedProvider={selectedProvider}
                                  providers={providerStatuses}
                                  modelOptionsByProvider={composerModelOptionsByProvider}
                                  compact
                                  onProviderModelChange={onProviderModelSelect}
                                  {...(composerProviderState.modelPickerIconClassName
                                    ? {
                                        activeProviderIconClassName:
                                          composerProviderState.modelPickerIconClassName,
                                      }
                                    : {})}
                                />
                                <CompactComposerControlsMenu
                                  activePlan={Boolean(
                                    activePlan || sidebarProposedPlan || planSidebarOpen,
                                  )}
                                  interactionMode={interactionMode}
                                  planSidebarOpen={planSidebarOpen}
                                  runtimeMode={runtimeMode}
                                  traitsMenuContent={providerTraitsMenuContent}
                                  onToggleInteractionMode={toggleInteractionMode}
                                  onTogglePlanSidebar={togglePlanSidebar}
                                  onToggleRuntimeMode={toggleRuntimeMode}
                                />
                              </>
                            ) : (
                              <>
                                <ProviderModelPicker
                                  provider={selectedProvider}
                                  model={selectedModel}
                                  lockedProvider={selectedProvider}
                                  providers={providerStatuses}
                                  modelOptionsByProvider={composerModelOptionsByProvider}
                                  onProviderModelChange={onProviderModelSelect}
                                  {...(composerProviderState.modelPickerIconClassName
                                    ? {
                                        activeProviderIconClassName:
                                          composerProviderState.modelPickerIconClassName,
                                      }
                                    : {})}
                                />

                                <Separator
                                  orientation="vertical"
                                  className="mx-0.5 hidden h-4 sm:block"
                                />

                                {providerTraitsPicker ? (
                                  <>
                                    {providerTraitsPicker}
                                    <Separator
                                      orientation="vertical"
                                      className="mx-0.5 hidden h-4 sm:block"
                                    />
                                  </>
                                ) : null}

                                <Button
                                  variant="ghost"
                                  className="shrink-0 whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80 sm:px-3"
                                  size="sm"
                                  type="button"
                                  onClick={toggleInteractionMode}
                                  title={
                                    interactionMode === "plan"
                                      ? "Plan mode — click to return to normal chat mode"
                                      : "Default mode — click to enter plan mode"
                                  }
                                >
                                  <BotIcon />
                                  <span className="sr-only sm:not-sr-only">
                                    {interactionMode === "plan" ? "Plan" : "Chat"}
                                  </span>
                                </Button>

                                <Separator
                                  orientation="vertical"
                                  className="mx-0.5 hidden h-4 sm:block"
                                />

                                <Button
                                  variant="ghost"
                                  className="shrink-0 whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80 sm:px-3"
                                  size="sm"
                                  type="button"
                                  onClick={() =>
                                    void handleRuntimeModeChange(
                                      runtimeMode === "full-access"
                                        ? "approval-required"
                                        : "full-access",
                                    )
                                  }
                                  title={
                                    runtimeMode === "full-access"
                                      ? "Full access — click to require approvals"
                                      : "Approval required — click for full access"
                                  }
                                >
                                  {runtimeMode === "full-access" ? <LockOpenIcon /> : <LockIcon />}
                                  <span className="sr-only sm:not-sr-only">
                                    {runtimeMode === "full-access" ? "Full access" : "Supervised"}
                                  </span>
                                </Button>

                                {activePlan || sidebarProposedPlan || planSidebarOpen ? (
                                  <>
                                    <Separator
                                      orientation="vertical"
                                      className="mx-0.5 hidden h-4 sm:block"
                                    />
                                    <Button
                                      variant="ghost"
                                      className={cn(
                                        "shrink-0 whitespace-nowrap px-2 sm:px-3",
                                        planSidebarOpen
                                          ? "text-blue-400 hover:text-blue-300"
                                          : "text-muted-foreground/70 hover:text-foreground/80",
                                      )}
                                      size="sm"
                                      type="button"
                                      onClick={togglePlanSidebar}
                                      title={
                                        planSidebarOpen ? "Hide plan sidebar" : "Show plan sidebar"
                                      }
                                    >
                                      <ListTodoIcon />
                                      <span className="sr-only sm:not-sr-only">Plan</span>
                                    </Button>
                                  </>
                                ) : null}
                              </>
                            )}
                          </div>

                          {/* Right side: send / stop button */}
                          <div
                            ref={composerFooterActionsRef}
                            data-chat-composer-actions="right"
                            data-chat-composer-primary-actions-compact={
                              isComposerPrimaryActionsCompact ? "true" : "false"
                            }
                            className="flex shrink-0 flex-nowrap items-center justify-end gap-2"
                          >
                            {activeContextWindow ? (
                              <ContextWindowMeter usage={activeContextWindow} />
                            ) : null}
                            {isPreparingWorktree ? (
                              <span className="text-muted-foreground/70 text-xs">
                                Preparing worktree...
                              </span>
                            ) : null}
                            <ComposerPrimaryActions
                              compact={isComposerPrimaryActionsCompact}
                              pendingAction={
                                activePendingProgress
                                  ? {
                                      questionIndex: activePendingProgress.questionIndex,
                                      isLastQuestion: activePendingProgress.isLastQuestion,
                                      canAdvance: activePendingProgress.canAdvance,
                                      isResponding: activePendingIsResponding,
                                      isComplete: Boolean(activePendingResolvedAnswers),
                                    }
                                  : null
                              }
                              isRunning={phase === "running"}
                              showPlanFollowUpPrompt={
                                pendingUserInputs.length === 0 && showPlanFollowUpPrompt
                              }
                              promptHasText={prompt.trim().length > 0}
                              isSendBusy={isSendBusy}
                              isConnecting={isConnecting}
                              isPreparingWorktree={isPreparingWorktree}
                              hasSendableContent={composerSendState.hasSendableContent}
                              onPreviousPendingQuestion={onPreviousActivePendingUserInputQuestion}
                              onInterrupt={() => void onInterrupt()}
                              onImplementPlanInNewWorkspace={() =>
                                void onImplementPlanInNewWorkspace()
                              }
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </form>
              </div>

              {isGitRepo && (
                <BranchToolbar
                  workspaceId={activeWorkspace.id}
                  onEnvModeChange={onEnvModeChange}
                  envLocked={envLocked}
                  onComposerFocusRequest={scheduleComposerFocus}
                  {...(canCheckoutPullRequestIntoWorkspace
                    ? { onCheckoutPullRequestRequest: openPullRequestDialog }
                    : {})}
                />
              )}
              {pullRequestDialogState ? (
                <PullRequestWorkspaceDialog
                  key={pullRequestDialogState.key}
                  open
                  workspaceId={activeWorkspace.id}
                  cwd={activeProject?.cwd ?? null}
                  initialReference={pullRequestDialogState.initialReference}
                  onOpenChange={(open) => {
                    if (!open) {
                      closePullRequestDialog();
                    }
                  }}
                  onPrepared={handlePreparedPullRequestWorkspace}
                />
              ) : null}
            </div>
            {/* end chat column */}

            {/* Plan sidebar */}
            {planSidebarOpen ? (
              <PlanSidebar
                activePlan={activePlan}
                activeProposedPlan={sidebarProposedPlan}
                markdownCwd={gitCwd ?? undefined}
                workspaceRoot={activeWorkspaceRoot}
                timestampFormat={timestampFormat}
                onClose={() => {
                  setPlanSidebarOpen(false);
                  // Track that the user explicitly dismissed for this turn so auto-open won't fight them.
                  const turnKey = activePlan?.turnId ?? sidebarProposedPlan?.turnId ?? null;
                  if (turnKey) {
                    planSidebarDismissedForTurnRef.current = turnKey;
                  }
                }}
              />
            ) : null}
          </>
        )}
      </div>
      {/* end horizontal flex container */}

      {expandedImage && expandedImageItem && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 px-4 py-6 [-webkit-app-region:no-drag]"
          role="dialog"
          aria-modal="true"
          aria-label="Expanded image preview"
        >
          <button
            type="button"
            className="absolute inset-0 z-0 cursor-zoom-out"
            aria-label="Close image preview"
            onClick={closeExpandedImage}
          />
          {expandedImage.images.length > 1 && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="absolute left-2 top-1/2 z-20 -translate-y-1/2 text-white/90 hover:bg-white/10 hover:text-white sm:left-6"
              aria-label="Previous image"
              onClick={() => {
                navigateExpandedImage(-1);
              }}
            >
              <ChevronLeftIcon className="size-5" />
            </Button>
          )}
          <div className="relative isolate z-10 max-h-[92vh] max-w-[92vw]">
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              className="absolute right-2 top-2"
              onClick={closeExpandedImage}
              aria-label="Close image preview"
            >
              <XIcon />
            </Button>
            <img
              src={expandedImageItem.src}
              alt={expandedImageItem.name}
              className="max-h-[86vh] max-w-[92vw] select-none rounded-lg border border-border/70 bg-background object-contain shadow-2xl"
              draggable={false}
            />
            <p className="mt-2 max-w-[92vw] truncate text-center text-xs text-muted-foreground/80">
              {expandedImageItem.name}
              {expandedImage.images.length > 1
                ? ` (${expandedImage.index + 1}/${expandedImage.images.length})`
                : ""}
            </p>
          </div>
          {expandedImage.images.length > 1 && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="absolute right-2 top-1/2 z-20 -translate-y-1/2 text-white/90 hover:bg-white/10 hover:text-white sm:right-6"
              aria-label="Next image"
              onClick={() => {
                navigateExpandedImage(1);
              }}
            >
              <ChevronRightIcon className="size-5" />
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
