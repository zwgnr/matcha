import {
  type ChatAttachment,
  CommandId,
  EventId,
  type ModelSelection,
  type OrchestrationEvent,
  ProviderKind,
  type OrchestrationSession,
  WorkspaceId,
  type ProviderSession,
  type RuntimeMode,
  type TurnId,
} from "@matcha/contracts";
import { Cache, Cause, Duration, Effect, Equal, Layer, Option, Schema, Stream } from "effect";
import { makeDrainableWorker } from "@matcha/shared/DrainableWorker";

import { resolveWorkspaceWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import { increment, orchestrationEventsProcessedTotal } from "../../observability/Metrics.ts";
import { resolveCodexSlashCommandInput } from "../../provider/codexCustomPrompts.ts";
import { ProviderAdapterRequestError, ProviderServiceError } from "../../provider/Errors.ts";
import { TextGeneration } from "../../git/Services/TextGeneration.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ProviderCommandReactor,
  type ProviderCommandReactorShape,
} from "../Services/ProviderCommandReactor.ts";
import { ServerSettingsService } from "../../serverSettings.ts";

type ProviderIntentEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "workspace.runtime-mode-set"
      | "workspace.turn-start-requested"
      | "workspace.turn-interrupt-requested"
      | "workspace.approval-response-requested"
      | "workspace.user-input-response-requested"
      | "workspace.session-stop-requested";
  }
>;

function toNonEmptyProviderInput(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function mapProviderSessionStatusToOrchestrationStatus(
  status: "connecting" | "ready" | "running" | "error" | "closed",
): OrchestrationSession["status"] {
  switch (status) {
    case "connecting":
      return "starting";
    case "running":
      return "running";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    default:
      return "ready";
  }
}

const turnStartKeyForEvent = (event: ProviderIntentEvent): string =>
  event.commandId !== null ? `command:${event.commandId}` : `event:${event.eventId}`;

const serverCommandId = (tag: string): CommandId =>
  CommandId.makeUnsafe(`server:${tag}:${crypto.randomUUID()}`);

const HANDLED_TURN_START_KEY_MAX = 10_000;
const HANDLED_TURN_START_KEY_TTL = Duration.minutes(30);
const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";
const WORKTREE_BRANCH_PREFIX = "matcha";
const TEMP_WORKTREE_BRANCH_PATTERN = new RegExp(`^${WORKTREE_BRANCH_PREFIX}\\/[0-9a-f]{8}$`);
const DEFAULT_WORKSPACE_TITLE = "New workspace";

function canReplaceWorkspaceTitle(currentTitle: string, titleSeed?: string): boolean {
  const trimmedCurrentTitle = currentTitle.trim();
  if (trimmedCurrentTitle === DEFAULT_WORKSPACE_TITLE) {
    return true;
  }

  const trimmedTitleSeed = titleSeed?.trim();
  return trimmedTitleSeed !== undefined && trimmedTitleSeed.length > 0
    ? trimmedCurrentTitle === trimmedTitleSeed
    : false;
}

function isUnknownPendingApprovalRequestError(cause: Cause.Cause<ProviderServiceError>): boolean {
  const error = Cause.squash(cause);
  if (Schema.is(ProviderAdapterRequestError)(error)) {
    const detail = error.detail.toLowerCase();
    return (
      detail.includes("unknown pending approval request") ||
      detail.includes("unknown pending permission request")
    );
  }
  const message = Cause.pretty(cause);
  return (
    message.includes("unknown pending approval request") ||
    message.includes("unknown pending permission request")
  );
}

function isUnknownPendingUserInputRequestError(cause: Cause.Cause<ProviderServiceError>): boolean {
  const error = Cause.squash(cause);
  if (Schema.is(ProviderAdapterRequestError)(error)) {
    return error.detail.toLowerCase().includes("unknown pending user-input request");
  }
  return Cause.pretty(cause).toLowerCase().includes("unknown pending user-input request");
}

function stalePendingRequestDetail(
  requestKind: "approval" | "user-input",
  requestId: string,
): string {
  return `Stale pending ${requestKind} request: ${requestId}. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.`;
}

function isTemporaryWorktreeBranch(branch: string): boolean {
  return TEMP_WORKTREE_BRANCH_PATTERN.test(branch.trim().toLowerCase());
}

function buildGeneratedWorktreeBranchName(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/^refs\/heads\//, "")
    .replace(/['"`]/g, "");

  const withoutPrefix = normalized.startsWith(`${WORKTREE_BRANCH_PREFIX}/`)
    ? normalized.slice(`${WORKTREE_BRANCH_PREFIX}/`.length)
    : normalized;

  const branchFragment = withoutPrefix
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^[./_-]+|[./_-]+$/g, "")
    .slice(0, 64)
    .replace(/[./_-]+$/g, "");

  const safeFragment = branchFragment.length > 0 ? branchFragment : "update";
  return `${WORKTREE_BRANCH_PREFIX}/${safeFragment}`;
}

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const git = yield* GitCore;
  const textGeneration = yield* TextGeneration;
  const serverSettingsService = yield* ServerSettingsService;
  const handledTurnStartKeys = yield* Cache.make<string, true>({
    capacity: HANDLED_TURN_START_KEY_MAX,
    timeToLive: HANDLED_TURN_START_KEY_TTL,
    lookup: () => Effect.succeed(true),
  });

  const hasHandledTurnStartRecently = (key: string) =>
    Cache.getOption(handledTurnStartKeys, key).pipe(
      Effect.flatMap((cached) =>
        Cache.set(handledTurnStartKeys, key, true).pipe(Effect.as(Option.isSome(cached))),
      ),
    );

  const workspaceModelSelections = new Map<string, ModelSelection>();

  const appendProviderFailureActivity = (input: {
    readonly workspaceId: WorkspaceId;
    readonly kind:
      | "provider.turn.start.failed"
      | "provider.turn.interrupt.failed"
      | "provider.approval.respond.failed"
      | "provider.user-input.respond.failed"
      | "provider.session.stop.failed";
    readonly summary: string;
    readonly detail: string;
    readonly turnId: TurnId | null;
    readonly createdAt: string;
    readonly requestId?: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "workspace.activity.append",
      commandId: serverCommandId("provider-failure-activity"),
      workspaceId: input.workspaceId,
      activity: {
        id: EventId.makeUnsafe(crypto.randomUUID()),
        tone: "error",
        kind: input.kind,
        summary: input.summary,
        payload: {
          detail: input.detail,
          ...(input.requestId ? { requestId: input.requestId } : {}),
        },
        turnId: input.turnId,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });

  const setWorkspaceSession = (input: {
    readonly workspaceId: WorkspaceId;
    readonly session: OrchestrationSession;
    readonly createdAt: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "workspace.session.set",
      commandId: serverCommandId("provider-session-set"),
      workspaceId: input.workspaceId,
      session: input.session,
      createdAt: input.createdAt,
    });

  const resolveWorkspace = Effect.fn("resolveWorkspace")(function* (workspaceId: WorkspaceId) {
    const readModel = yield* orchestrationEngine.getReadModel();
    return readModel.workspaces.find((entry) => entry.id === workspaceId);
  });

  const ensureSessionForWorkspace = Effect.fn("ensureSessionForWorkspace")(function* (
    workspaceId: WorkspaceId,
    createdAt: string,
    options?: {
      readonly modelSelection?: ModelSelection;
    },
  ) {
    const readModel = yield* orchestrationEngine.getReadModel();
    const workspace = readModel.workspaces.find((entry) => entry.id === workspaceId);
    if (!workspace) {
      return yield* Effect.die(
        new Error(`Workspace '${workspaceId}' was not found in read model.`),
      );
    }

    const desiredRuntimeMode = workspace.runtimeMode;
    const currentProvider: ProviderKind | undefined = Schema.is(ProviderKind)(
      workspace.session?.providerName,
    )
      ? workspace.session.providerName
      : undefined;
    const requestedModelSelection = options?.modelSelection;
    const workspaceProvider: ProviderKind = currentProvider ?? workspace.modelSelection.provider;
    if (
      requestedModelSelection !== undefined &&
      requestedModelSelection.provider !== workspaceProvider
    ) {
      return yield* new ProviderAdapterRequestError({
        provider: workspaceProvider,
        method: "workspace.turn.start",
        detail: `Workspace '${workspaceId}' is bound to provider '${workspaceProvider}' and cannot switch to '${requestedModelSelection.provider}'.`,
      });
    }
    const preferredProvider: ProviderKind = currentProvider ?? workspaceProvider;
    const desiredModelSelection = requestedModelSelection ?? workspace.modelSelection;
    const effectiveCwd = resolveWorkspaceWorkspaceCwd({
      workspace,
      projects: readModel.projects,
    });

    const resolveActiveSession = (workspaceId: WorkspaceId) =>
      providerService
        .listSessions()
        .pipe(
          Effect.map((sessions) => sessions.find((session) => session.workspaceId === workspaceId)),
        );

    const startProviderSession = (input?: {
      readonly resumeCursor?: unknown;
      readonly provider?: ProviderKind;
    }) =>
      providerService.startSession(workspaceId, {
        workspaceId,
        ...(preferredProvider ? { provider: preferredProvider } : {}),
        ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
        modelSelection: desiredModelSelection,
        ...(input?.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
        runtimeMode: desiredRuntimeMode,
      });

    const bindSessionToWorkspace = (session: ProviderSession) =>
      setWorkspaceSession({
        workspaceId,
        session: {
          workspaceId,
          status: mapProviderSessionStatusToOrchestrationStatus(session.status),
          providerName: session.provider,
          runtimeMode: desiredRuntimeMode,
          // Provider turn ids are not orchestration turn ids.
          activeTurnId: null,
          lastError: session.lastError ?? null,
          updatedAt: session.updatedAt,
        },
        createdAt,
      });

    const existingSessionWorkspaceId =
      workspace.session && workspace.session.status !== "stopped" ? workspace.id : null;
    if (existingSessionWorkspaceId) {
      const runtimeModeChanged = workspace.runtimeMode !== workspace.session?.runtimeMode;
      const providerChanged =
        requestedModelSelection !== undefined &&
        requestedModelSelection.provider !== currentProvider;
      const activeSession = yield* resolveActiveSession(existingSessionWorkspaceId);
      const sessionModelSwitch =
        currentProvider === undefined
          ? "in-session"
          : (yield* providerService.getCapabilities(currentProvider)).sessionModelSwitch;
      const modelChanged =
        requestedModelSelection !== undefined &&
        requestedModelSelection.model !== activeSession?.model;
      const shouldRestartForModelChange = modelChanged && sessionModelSwitch === "restart-session";
      const previousModelSelection = workspaceModelSelections.get(workspaceId);
      const shouldRestartForModelSelectionChange =
        currentProvider === "claudeAgent" &&
        requestedModelSelection !== undefined &&
        !Equal.equals(previousModelSelection, requestedModelSelection);

      if (
        !runtimeModeChanged &&
        !providerChanged &&
        !shouldRestartForModelChange &&
        !shouldRestartForModelSelectionChange
      ) {
        return existingSessionWorkspaceId;
      }

      const resumeCursor =
        providerChanged || shouldRestartForModelChange
          ? undefined
          : (activeSession?.resumeCursor ?? undefined);
      yield* Effect.logInfo("provider command reactor restarting provider session", {
        workspaceId,
        existingSessionWorkspaceId,
        currentProvider,
        desiredProvider: desiredModelSelection.provider,
        currentRuntimeMode: workspace.session?.runtimeMode,
        desiredRuntimeMode: workspace.runtimeMode,
        runtimeModeChanged,
        providerChanged,
        modelChanged,
        shouldRestartForModelChange,
        shouldRestartForModelSelectionChange,
        hasResumeCursor: resumeCursor !== undefined,
      });
      const restartedSession = yield* startProviderSession(
        resumeCursor !== undefined ? { resumeCursor } : undefined,
      );
      yield* Effect.logInfo("provider command reactor restarted provider session", {
        workspaceId,
        previousSessionId: existingSessionWorkspaceId,
        restartedSessionWorkspaceId: restartedSession.workspaceId,
        provider: restartedSession.provider,
        runtimeMode: restartedSession.runtimeMode,
      });
      yield* bindSessionToWorkspace(restartedSession);
      return restartedSession.workspaceId;
    }

    const startedSession = yield* startProviderSession(undefined);
    yield* bindSessionToWorkspace(startedSession);
    return startedSession.workspaceId;
  });

  const sendTurnForWorkspace = Effect.fn("sendTurnForWorkspace")(function* (input: {
    readonly workspaceId: WorkspaceId;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
    readonly modelSelection?: ModelSelection;
    readonly interactionMode?: "default" | "plan";
    readonly createdAt: string;
  }) {
    const workspace = yield* resolveWorkspace(input.workspaceId);
    if (!workspace) {
      return;
    }
    const readModel = yield* orchestrationEngine.getReadModel();
    const effectiveCwd = resolveWorkspaceWorkspaceCwd({
      workspace,
      projects: readModel.projects,
    });
    yield* ensureSessionForWorkspace(
      input.workspaceId,
      input.createdAt,
      input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {},
    );
    if (input.modelSelection !== undefined) {
      workspaceModelSelections.set(input.workspaceId, input.modelSelection);
    }
    const normalizedAttachments = input.attachments ?? [];
    const activeSession = yield* providerService
      .listSessions()
      .pipe(
        Effect.map((sessions) =>
          sessions.find((session) => session.workspaceId === input.workspaceId),
        ),
      );
    const sessionModelSwitch =
      activeSession === undefined
        ? "in-session"
        : (yield* providerService.getCapabilities(activeSession.provider)).sessionModelSwitch;
    const requestedModelSelection =
      input.modelSelection ??
      workspaceModelSelections.get(input.workspaceId) ??
      workspace.modelSelection;
    const modelForTurn =
      sessionModelSwitch === "unsupported"
        ? activeSession?.model !== undefined
          ? {
              ...requestedModelSelection,
              model: activeSession.model,
            }
          : requestedModelSelection
        : input.modelSelection;
    const providerForInput =
      modelForTurn?.provider ??
      requestedModelSelection?.provider ??
      workspace.modelSelection.provider;
    const providerHomeDir = process.env.HOME ?? process.env.USERPROFILE;
    const providerInputText =
      (yield* Effect.tryPromise({
        try: () =>
          providerForInput === "codex"
            ? resolveCodexSlashCommandInput({
                text: input.messageText,
                ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
                ...(providerHomeDir ? { homeDir: providerHomeDir } : {}),
              })
            : Promise.resolve(input.messageText),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: providerForInput,
            method: "workspace.turn.start",
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      })) ?? input.messageText;
    const normalizedInput = toNonEmptyProviderInput(providerInputText);

    yield* providerService.sendTurn({
      workspaceId: input.workspaceId,
      ...(normalizedInput ? { input: normalizedInput } : {}),
      ...(normalizedAttachments.length > 0 ? { attachments: normalizedAttachments } : {}),
      ...(modelForTurn !== undefined ? { modelSelection: modelForTurn } : {}),
      ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
    });
  });

  const maybeGenerateAndRenameWorktreeBranchForFirstTurn = Effect.fn(
    "maybeGenerateAndRenameWorktreeBranchForFirstTurn",
  )(function* (input: {
    readonly workspaceId: WorkspaceId;
    readonly branch: string | null;
    readonly worktreePath: string | null;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
  }) {
    if (!input.branch || !input.worktreePath) {
      return;
    }
    if (!isTemporaryWorktreeBranch(input.branch)) {
      return;
    }

    const oldBranch = input.branch;
    const cwd = input.worktreePath;
    const attachments = input.attachments ?? [];
    yield* Effect.gen(function* () {
      const { textGenerationModelSelection: modelSelection } =
        yield* serverSettingsService.getSettings;

      const generated = yield* textGeneration.generateBranchName({
        cwd,
        message: input.messageText,
        ...(attachments.length > 0 ? { attachments } : {}),
        modelSelection,
      });
      if (!generated) return;

      const targetBranch = buildGeneratedWorktreeBranchName(generated.branch);
      if (targetBranch === oldBranch) return;

      const renamed = yield* git.renameBranch({ cwd, oldBranch, newBranch: targetBranch });
      yield* orchestrationEngine.dispatch({
        type: "workspace.meta.update",
        commandId: serverCommandId("worktree-branch-rename"),
        workspaceId: input.workspaceId,
        branch: renamed.branch,
        worktreePath: cwd,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider command reactor failed to generate or rename worktree branch", {
          workspaceId: input.workspaceId,
          cwd,
          oldBranch,
          cause: Cause.pretty(cause),
        }),
      ),
    );
  });

  const maybeGenerateWorkspaceTitleForFirstTurn = Effect.fn(
    "maybeGenerateWorkspaceTitleForFirstTurn",
  )(function* (input: {
    readonly workspaceId: WorkspaceId;
    readonly cwd: string;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
    readonly titleSeed?: string;
  }) {
    const attachments = input.attachments ?? [];
    yield* Effect.gen(function* () {
      const { textGenerationModelSelection: modelSelection } =
        yield* serverSettingsService.getSettings;

      const generated = yield* textGeneration.generateWorkspaceTitle({
        cwd: input.cwd,
        message: input.messageText,
        ...(attachments.length > 0 ? { attachments } : {}),
        modelSelection,
      });
      if (!generated) return;

      const workspace = yield* resolveWorkspace(input.workspaceId);
      if (!workspace) return;
      if (!canReplaceWorkspaceTitle(workspace.title, input.titleSeed)) {
        return;
      }

      yield* orchestrationEngine.dispatch({
        type: "workspace.meta.update",
        commandId: serverCommandId("workspace-title-rename"),
        workspaceId: input.workspaceId,
        title: generated.title,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider command reactor failed to generate or rename workspace title", {
          workspaceId: input.workspaceId,
          cwd: input.cwd,
          cause: Cause.pretty(cause),
        }),
      ),
    );
  });

  const processTurnStartRequested = Effect.fn("processTurnStartRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "workspace.turn-start-requested" }>,
  ) {
    const key = turnStartKeyForEvent(event);
    if (yield* hasHandledTurnStartRecently(key)) {
      return;
    }

    const workspace = yield* resolveWorkspace(event.payload.workspaceId);
    if (!workspace) {
      return;
    }

    const message = workspace.messages.find((entry) => entry.id === event.payload.messageId);
    if (!message || message.role !== "user") {
      yield* appendProviderFailureActivity({
        workspaceId: event.payload.workspaceId,
        kind: "provider.turn.start.failed",
        summary: "Provider turn start failed",
        detail: `User message '${event.payload.messageId}' was not found for turn start request.`,
        turnId: null,
        createdAt: event.payload.createdAt,
      });
      return;
    }

    const isFirstUserMessageTurn =
      workspace.messages.filter((entry) => entry.role === "user").length === 1;
    if (isFirstUserMessageTurn) {
      const generationCwd =
        resolveWorkspaceWorkspaceCwd({
          workspace,
          projects: (yield* orchestrationEngine.getReadModel()).projects,
        }) ?? process.cwd();
      const generationInput = {
        messageText: message.text,
        ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
        ...(event.payload.titleSeed !== undefined ? { titleSeed: event.payload.titleSeed } : {}),
      };

      yield* maybeGenerateAndRenameWorktreeBranchForFirstTurn({
        workspaceId: event.payload.workspaceId,
        branch: workspace.branch,
        worktreePath: workspace.worktreePath,
        ...generationInput,
      }).pipe(Effect.forkScoped);

      if (canReplaceWorkspaceTitle(workspace.title, event.payload.titleSeed)) {
        yield* maybeGenerateWorkspaceTitleForFirstTurn({
          workspaceId: event.payload.workspaceId,
          cwd: generationCwd,
          ...generationInput,
        }).pipe(Effect.forkScoped);
      }
    }

    yield* sendTurnForWorkspace({
      workspaceId: event.payload.workspaceId,
      messageText: message.text,
      ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
      ...(event.payload.modelSelection !== undefined
        ? { modelSelection: event.payload.modelSelection }
        : {}),
      interactionMode: event.payload.interactionMode,
      createdAt: event.payload.createdAt,
    }).pipe(
      Effect.catchCause((cause) =>
        appendProviderFailureActivity({
          workspaceId: event.payload.workspaceId,
          kind: "provider.turn.start.failed",
          summary: "Provider turn start failed",
          detail: Cause.pretty(cause),
          turnId: null,
          createdAt: event.payload.createdAt,
        }),
      ),
    );
  });

  const processTurnInterruptRequested = Effect.fn("processTurnInterruptRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "workspace.turn-interrupt-requested" }>,
  ) {
    const workspace = yield* resolveWorkspace(event.payload.workspaceId);
    if (!workspace) {
      return;
    }
    const hasSession = workspace.session && workspace.session.status !== "stopped";
    if (!hasSession) {
      return yield* appendProviderFailureActivity({
        workspaceId: event.payload.workspaceId,
        kind: "provider.turn.interrupt.failed",
        summary: "Provider turn interrupt failed",
        detail: "No active provider session is bound to this workspace.",
        turnId: event.payload.turnId ?? null,
        createdAt: event.payload.createdAt,
      });
    }

    // Orchestration turn ids are not provider turn ids, so interrupt by session.
    yield* providerService.interruptTurn({ workspaceId: event.payload.workspaceId });
  });

  const processApprovalResponseRequested = Effect.fn("processApprovalResponseRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "workspace.approval-response-requested" }>,
  ) {
    const workspace = yield* resolveWorkspace(event.payload.workspaceId);
    if (!workspace) {
      return;
    }
    const hasSession = workspace.session && workspace.session.status !== "stopped";
    if (!hasSession) {
      return yield* appendProviderFailureActivity({
        workspaceId: event.payload.workspaceId,
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        detail: "No active provider session is bound to this workspace.",
        turnId: null,
        createdAt: event.payload.createdAt,
        requestId: event.payload.requestId,
      });
    }

    yield* providerService
      .respondToRequest({
        workspaceId: event.payload.workspaceId,
        requestId: event.payload.requestId,
        decision: event.payload.decision,
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            yield* appendProviderFailureActivity({
              workspaceId: event.payload.workspaceId,
              kind: "provider.approval.respond.failed",
              summary: "Provider approval response failed",
              detail: isUnknownPendingApprovalRequestError(cause)
                ? stalePendingRequestDetail("approval", event.payload.requestId)
                : Cause.pretty(cause),
              turnId: null,
              createdAt: event.payload.createdAt,
              requestId: event.payload.requestId,
            });

            if (!isUnknownPendingApprovalRequestError(cause)) return;
          }),
        ),
      );
  });

  const processUserInputResponseRequested = Effect.fn("processUserInputResponseRequested")(
    function* (
      event: Extract<ProviderIntentEvent, { type: "workspace.user-input-response-requested" }>,
    ) {
      const workspace = yield* resolveWorkspace(event.payload.workspaceId);
      if (!workspace) {
        return;
      }
      const hasSession = workspace.session && workspace.session.status !== "stopped";
      if (!hasSession) {
        return yield* appendProviderFailureActivity({
          workspaceId: event.payload.workspaceId,
          kind: "provider.user-input.respond.failed",
          summary: "Provider user input response failed",
          detail: "No active provider session is bound to this workspace.",
          turnId: null,
          createdAt: event.payload.createdAt,
          requestId: event.payload.requestId,
        });
      }

      yield* providerService
        .respondToUserInput({
          workspaceId: event.payload.workspaceId,
          requestId: event.payload.requestId,
          answers: event.payload.answers,
        })
        .pipe(
          Effect.catchCause((cause) =>
            appendProviderFailureActivity({
              workspaceId: event.payload.workspaceId,
              kind: "provider.user-input.respond.failed",
              summary: "Provider user input response failed",
              detail: isUnknownPendingUserInputRequestError(cause)
                ? stalePendingRequestDetail("user-input", event.payload.requestId)
                : Cause.pretty(cause),
              turnId: null,
              createdAt: event.payload.createdAt,
              requestId: event.payload.requestId,
            }),
          ),
        );
    },
  );

  const processSessionStopRequested = Effect.fn("processSessionStopRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "workspace.session-stop-requested" }>,
  ) {
    const workspace = yield* resolveWorkspace(event.payload.workspaceId);
    if (!workspace) {
      return;
    }

    const now = event.payload.createdAt;
    if (workspace.session && workspace.session.status !== "stopped") {
      yield* providerService.stopSession({ workspaceId: workspace.id });
    }

    yield* setWorkspaceSession({
      workspaceId: workspace.id,
      session: {
        workspaceId: workspace.id,
        status: "stopped",
        providerName: workspace.session?.providerName ?? null,
        runtimeMode: workspace.session?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
        activeTurnId: null,
        lastError: workspace.session?.lastError ?? null,
        updatedAt: now,
      },
      createdAt: now,
    });
  });

  const processDomainEvent = Effect.fn("processDomainEvent")(function* (
    event: ProviderIntentEvent,
  ) {
    yield* Effect.annotateCurrentSpan({
      "orchestration.event_type": event.type,
      "orchestration.workspace_id": event.payload.workspaceId,
      ...(event.commandId ? { "orchestration.command_id": event.commandId } : {}),
    });
    yield* increment(orchestrationEventsProcessedTotal, {
      eventType: event.type,
    });
    switch (event.type) {
      case "workspace.runtime-mode-set": {
        const workspace = yield* resolveWorkspace(event.payload.workspaceId);
        if (!workspace?.session || workspace.session.status === "stopped") {
          return;
        }
        const cachedModelSelection = workspaceModelSelections.get(event.payload.workspaceId);
        yield* ensureSessionForWorkspace(
          event.payload.workspaceId,
          event.occurredAt,
          cachedModelSelection !== undefined ? { modelSelection: cachedModelSelection } : {},
        );
        return;
      }
      case "workspace.turn-start-requested":
        yield* processTurnStartRequested(event);
        return;
      case "workspace.turn-interrupt-requested":
        yield* processTurnInterruptRequested(event);
        return;
      case "workspace.approval-response-requested":
        yield* processApprovalResponseRequested(event);
        return;
      case "workspace.user-input-response-requested":
        yield* processUserInputResponseRequested(event);
        return;
      case "workspace.session-stop-requested":
        yield* processSessionStopRequested(event);
        return;
    }
  });

  const processDomainEventSafely = (event: ProviderIntentEvent) =>
    processDomainEvent(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("provider command reactor failed to process event", {
          eventType: event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processDomainEventSafely);

  const start: ProviderCommandReactorShape["start"] = Effect.fn("start")(function* () {
    const processEvent = Effect.fn("processEvent")(function* (event: OrchestrationEvent) {
      if (
        event.type === "workspace.runtime-mode-set" ||
        event.type === "workspace.turn-start-requested" ||
        event.type === "workspace.turn-interrupt-requested" ||
        event.type === "workspace.approval-response-requested" ||
        event.type === "workspace.user-input-response-requested" ||
        event.type === "workspace.session-stop-requested"
      ) {
        return yield* worker.enqueue(event);
      }
    });

    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, processEvent),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies ProviderCommandReactorShape;
});

export const ProviderCommandReactorLive = Layer.effect(ProviderCommandReactor, make);
