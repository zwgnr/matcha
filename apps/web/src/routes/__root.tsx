import {
  OrchestrationEvent,
  type ServerLifecycleWelcomePayload,
  type WorkspaceId,
} from "@matcha/contracts";
import { detectPorts } from "../lib/portDetection";
import { useRunCommandStore } from "../runCommandStore";
import {
  Outlet,
  createRootRouteWithContext,
  type ErrorComponentProps,
  useNavigate,
  useLocation,
} from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef } from "react";
import { QueryClient, useQueryClient } from "@tanstack/react-query";
import { Throttler } from "@tanstack/react-pacer";

import { APP_DISPLAY_NAME } from "../branding";
import { AppSidebarLayout } from "../components/AppSidebarLayout";
import {
  SlowRpcAckToastCoordinator,
  WebSocketConnectionCoordinator,
  WebSocketConnectionSurface,
} from "../components/WebSocketConnectionSurface";
import { Button } from "../components/ui/button";
import { AnchoredToastProvider, ToastProvider, toastManager } from "../components/ui/toast";
import { resolveAndPersistPreferredEditor } from "../editorPreferences";
import { readNativeApi } from "../nativeApi";
import {
  getServerConfigUpdatedNotification,
  ServerConfigUpdatedNotification,
  startServerStateSync,
  useServerConfig,
  useServerConfigUpdatedSubscription,
  useServerWelcomeSubscription,
} from "../rpc/serverState";
import {
  clearPromotedDraftWorkspace,
  clearPromotedDraftWorkspaces,
  useComposerDraftStore,
} from "../composerDraftStore";
import { useStore } from "../store";
import { useUiStateStore } from "../uiStateStore";
import { useTerminalStateStore } from "../terminalStateStore";
import { migrateLocalSettingsToServer } from "../hooks/useSettings";
import { providerQueryKeys } from "../lib/providerReactQuery";
import { projectQueryKeys } from "../lib/projectReactQuery";
import { collectActiveTerminalWorkspaceIds } from "../lib/terminalStateCleanup";
import { deriveOrchestrationBatchEffects } from "../orchestrationEventEffects";
import { createOrchestrationRecoveryCoordinator } from "../orchestrationRecovery";
import { deriveReplayRetryDecision } from "../orchestrationRecovery";
import { getWsRpcClient } from "~/wsRpcClient";

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
}>()({
  component: RootRouteView,
  errorComponent: RootRouteErrorView,
  head: () => ({
    meta: [{ name: "title", content: APP_DISPLAY_NAME }],
  }),
});

function RootRouteView() {
  if (!readNativeApi()) {
    return (
      <div className="flex h-screen flex-col bg-background text-foreground">
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-muted-foreground">
            Connecting to {APP_DISPLAY_NAME} server...
          </p>
        </div>
      </div>
    );
  }

  return (
    <ToastProvider>
      <AnchoredToastProvider>
        <ServerStateBootstrap />
        <EventRouter />
        <WebSocketConnectionCoordinator />
        <SlowRpcAckToastCoordinator />
        <WebSocketConnectionSurface>
          <AppSidebarLayout>
            <Outlet />
          </AppSidebarLayout>
        </WebSocketConnectionSurface>
      </AnchoredToastProvider>
    </ToastProvider>
  );
}

function RootRouteErrorView({ error, reset }: ErrorComponentProps) {
  const message = errorMessage(error);
  const details = errorDetails(error);

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-10 text-foreground sm:px-6">
      <div className="pointer-events-none absolute inset-0 opacity-80">
        <div className="absolute inset-x-0 top-0 h-44 bg-[radial-gradient(44rem_16rem_at_top,color-mix(in_srgb,var(--color-red-500)_16%,transparent),transparent)]" />
        <div className="absolute inset-0 bg-[linear-gradient(145deg,color-mix(in_srgb,var(--background)_90%,var(--color-black))_0%,var(--background)_55%)]" />
      </div>

      <section className="relative w-full max-w-xl rounded-2xl border border-border/80 bg-card/90 p-6 shadow-2xl shadow-black/20 backdrop-blur-md sm:p-8">
        <p className="text-[11px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
          {APP_DISPLAY_NAME}
        </p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
          Something went wrong.
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{message}</p>

        <div className="mt-5 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => reset()}>
            Try again
          </Button>
          <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
            Reload app
          </Button>
        </div>

        <details className="group mt-5 overflow-hidden rounded-lg border border-border/70 bg-background/55">
          <summary className="cursor-pointer list-none px-3 py-2 text-xs font-medium text-muted-foreground">
            <span className="group-open:hidden">Show error details</span>
            <span className="hidden group-open:inline">Hide error details</span>
          </summary>
          <pre className="max-h-56 overflow-auto border-t border-border/70 bg-background/80 px-3 py-2 text-xs text-foreground/85">
            {details}
          </pre>
        </details>
      </section>
    </div>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return "An unexpected router error occurred.";
}

function errorDetails(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return "No additional error details are available.";
  }
}

function coalesceOrchestrationUiEvents(
  events: ReadonlyArray<OrchestrationEvent>,
): OrchestrationEvent[] {
  if (events.length < 2) {
    return [...events];
  }

  const coalesced: OrchestrationEvent[] = [];
  for (const event of events) {
    const previous = coalesced.at(-1);
    if (
      previous?.type === "workspace.message-sent" &&
      event.type === "workspace.message-sent" &&
      previous.payload.workspaceId === event.payload.workspaceId &&
      previous.payload.messageId === event.payload.messageId
    ) {
      coalesced[coalesced.length - 1] = {
        ...event,
        payload: {
          ...event.payload,
          attachments: event.payload.attachments ?? previous.payload.attachments,
          createdAt: previous.payload.createdAt,
          text:
            !event.payload.streaming && event.payload.text.length > 0
              ? event.payload.text
              : previous.payload.text + event.payload.text,
        },
      };
      continue;
    }

    coalesced.push(event);
  }

  return coalesced;
}

const REPLAY_RECOVERY_RETRY_DELAY_MS = 100;
const MAX_NO_PROGRESS_REPLAY_RETRIES = 3;

function ServerStateBootstrap() {
  useEffect(() => startServerStateSync(getWsRpcClient().server), []);

  return null;
}

function EventRouter() {
  const applyOrchestrationEvents = useStore((store) => store.applyOrchestrationEvents);
  const syncServerReadModel = useStore((store) => store.syncServerReadModel);
  const setProjectExpanded = useUiStateStore((store) => store.setProjectExpanded);
  const syncProjects = useUiStateStore((store) => store.syncProjects);
  const syncWorkspaces = useUiStateStore((store) => store.syncWorkspaces);
  const clearWorkspaceUi = useUiStateStore((store) => store.clearWorkspaceUi);
  const removeTerminalState = useTerminalStateStore((store) => store.removeTerminalState);
  const removeOrphanedTerminalStates = useTerminalStateStore(
    (store) => store.removeOrphanedTerminalStates,
  );
  const applyTerminalEvent = useTerminalStateStore((store) => store.applyTerminalEvent);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const pathname = useLocation({ select: (loc) => loc.pathname });
  const readPathname = useEffectEvent(() => pathname);
  const handledBootstrapWorkspaceIdRef = useRef<string | null>(null);
  const seenServerConfigUpdateIdRef = useRef(getServerConfigUpdatedNotification()?.id ?? 0);
  const disposedRef = useRef(false);
  const bootstrapFromSnapshotRef = useRef<() => Promise<void>>(async () => undefined);
  const serverConfig = useServerConfig();

  const handleWelcome = useEffectEvent((payload: ServerLifecycleWelcomePayload | null) => {
    if (!payload) return;

    migrateLocalSettingsToServer();
    void (async () => {
      await bootstrapFromSnapshotRef.current();
      if (disposedRef.current) {
        return;
      }

      if (!payload.bootstrapProjectId || !payload.bootstrapWorkspaceId) {
        return;
      }
      setProjectExpanded(payload.bootstrapProjectId, true);

      if (readPathname() !== "/") {
        return;
      }
      if (handledBootstrapWorkspaceIdRef.current === payload.bootstrapWorkspaceId) {
        return;
      }
      await navigate({
        to: "/$workspaceId",
        params: { workspaceId: payload.bootstrapWorkspaceId },
        replace: true,
      });
      handledBootstrapWorkspaceIdRef.current = payload.bootstrapWorkspaceId;
    })().catch(() => undefined);
  });

  const handleServerConfigUpdated = useEffectEvent(
    (notification: ServerConfigUpdatedNotification | null) => {
      if (!notification) return;

      const { id, payload, source } = notification;
      if (id <= seenServerConfigUpdateIdRef.current) {
        return;
      }
      seenServerConfigUpdateIdRef.current = id;
      if (source !== "keybindingsUpdated") {
        return;
      }

      const issue = payload.issues.find((entry) => entry.kind.startsWith("keybindings."));
      if (!issue) {
        toastManager.add({
          type: "success",
          title: "Keybindings updated",
          description: "Keybindings configuration reloaded successfully.",
        });
        return;
      }

      toastManager.add({
        type: "warning",
        title: "Invalid keybindings configuration",
        description: issue.message,
        actionProps: {
          children: "Open keybindings.json",
          onClick: () => {
            const api = readNativeApi();
            if (!api) {
              return;
            }

            void Promise.resolve(serverConfig ?? api.server.getConfig())
              .then((config) => {
                const editor = resolveAndPersistPreferredEditor(config.availableEditors);
                if (!editor) {
                  throw new Error("No available editors found.");
                }
                return api.shell.openInEditor(config.keybindingsConfigPath, editor);
              })
              .catch((error) => {
                toastManager.add({
                  type: "error",
                  title: "Unable to open keybindings file",
                  description:
                    error instanceof Error ? error.message : "Unknown error opening file.",
                });
              });
          },
        },
      });
    },
  );

  useEffect(() => {
    const api = readNativeApi();
    if (!api) return;
    let disposed = false;
    disposedRef.current = false;
    const recovery = createOrchestrationRecoveryCoordinator();
    let replayRetryTracker: import("../orchestrationRecovery").ReplayRetryTracker | null = null;
    let needsProviderInvalidation = false;
    const pendingDomainEvents: OrchestrationEvent[] = [];
    let flushPendingDomainEventsScheduled = false;

    const reconcileSnapshotDerivedState = () => {
      const workspaces = useStore.getState().workspaces;
      const projects = useStore.getState().projects;
      syncProjects(projects.map((project) => ({ id: project.id, cwd: project.cwd })));
      syncWorkspaces(
        workspaces.map((workspace) => ({
          id: workspace.id,
          seedVisitedAt: workspace.updatedAt ?? workspace.createdAt,
        })),
      );
      clearPromotedDraftWorkspaces(workspaces.map((workspace) => workspace.id));
      const draftWorkspaceIds = Object.keys(
        useComposerDraftStore.getState().draftWorkspacesByWorkspaceId,
      ) as WorkspaceId[];
      const activeWorkspaceIds = collectActiveTerminalWorkspaceIds({
        snapshotWorkspaces: workspaces.map((workspace) => ({
          id: workspace.id,
          deletedAt: null,
          archivedAt: workspace.archivedAt,
        })),
        draftWorkspaceIds,
      });
      removeOrphanedTerminalStates(activeWorkspaceIds);
    };

    const queryInvalidationThrottler = new Throttler(
      () => {
        if (!needsProviderInvalidation) {
          return;
        }
        needsProviderInvalidation = false;
        void queryClient.invalidateQueries({ queryKey: providerQueryKeys.all });
        // Invalidate workspace entry queries so the @-mention file picker
        // reflects files created, deleted, or restored during this turn.
        void queryClient.invalidateQueries({ queryKey: projectQueryKeys.all });
      },
      {
        wait: 100,
        leading: false,
        trailing: true,
      },
    );

    const applyEventBatch = (events: ReadonlyArray<OrchestrationEvent>) => {
      const nextEvents = recovery.markEventBatchApplied(events);
      if (nextEvents.length === 0) {
        return;
      }

      const batchEffects = deriveOrchestrationBatchEffects(nextEvents);
      const uiEvents = coalesceOrchestrationUiEvents(nextEvents);
      const needsProjectUiSync = nextEvents.some(
        (event) =>
          event.type === "project.created" ||
          event.type === "project.meta-updated" ||
          event.type === "project.deleted",
      );

      if (batchEffects.needsProviderInvalidation) {
        needsProviderInvalidation = true;
        void queryInvalidationThrottler.maybeExecute();
      }

      applyOrchestrationEvents(uiEvents);
      if (needsProjectUiSync) {
        const projects = useStore.getState().projects;
        syncProjects(projects.map((project) => ({ id: project.id, cwd: project.cwd })));
      }
      const needsWorkspaceUiSync = nextEvents.some(
        (event) => event.type === "workspace.created" || event.type === "workspace.deleted",
      );
      if (needsWorkspaceUiSync) {
        const workspaces = useStore.getState().workspaces;
        syncWorkspaces(
          workspaces.map((workspace) => ({
            id: workspace.id,
            seedVisitedAt: workspace.updatedAt ?? workspace.createdAt,
          })),
        );
      }
      const draftStore = useComposerDraftStore.getState();
      for (const workspaceId of batchEffects.clearPromotedDraftWorkspaceIds) {
        clearPromotedDraftWorkspace(workspaceId);
      }
      for (const workspaceId of batchEffects.clearDeletedWorkspaceIds) {
        draftStore.clearDraftWorkspace(workspaceId);
        clearWorkspaceUi(workspaceId);
      }
      for (const workspaceId of batchEffects.removeTerminalStateWorkspaceIds) {
        removeTerminalState(workspaceId);
      }
    };
    const flushPendingDomainEvents = () => {
      flushPendingDomainEventsScheduled = false;
      if (disposed || pendingDomainEvents.length === 0) {
        return;
      }

      const events = pendingDomainEvents.splice(0, pendingDomainEvents.length);
      applyEventBatch(events);
    };
    const schedulePendingDomainEventFlush = () => {
      if (flushPendingDomainEventsScheduled) {
        return;
      }

      flushPendingDomainEventsScheduled = true;
      queueMicrotask(flushPendingDomainEvents);
    };

    const runReplayRecovery = async (reason: "sequence-gap" | "resubscribe"): Promise<void> => {
      if (!recovery.beginReplayRecovery(reason)) {
        return;
      }

      const fromSequenceExclusive = recovery.getState().latestSequence;
      try {
        const events = await api.orchestration.replayEvents(fromSequenceExclusive);
        if (!disposed) {
          applyEventBatch(events);
        }
      } catch {
        replayRetryTracker = null;
        recovery.failReplayRecovery();
        void fallbackToSnapshotRecovery();
        return;
      }

      if (!disposed) {
        const replayCompletion = recovery.completeReplayRecovery();
        const retryDecision = deriveReplayRetryDecision({
          previousTracker: replayRetryTracker,
          completion: replayCompletion,
          recoveryState: recovery.getState(),
          baseDelayMs: REPLAY_RECOVERY_RETRY_DELAY_MS,
          maxNoProgressRetries: MAX_NO_PROGRESS_REPLAY_RETRIES,
        });
        replayRetryTracker = retryDecision.tracker;

        if (retryDecision.shouldRetry) {
          if (retryDecision.delayMs > 0) {
            await new Promise<void>((resolve) => {
              setTimeout(resolve, retryDecision.delayMs);
            });
            if (disposed) {
              return;
            }
          }
          void runReplayRecovery(reason);
        } else if (replayCompletion.shouldReplay && import.meta.env.MODE !== "test") {
          console.warn(
            "[orchestration-recovery]",
            "Stopping replay recovery after no-progress retries.",
            {
              state: recovery.getState(),
            },
          );
        }
      }
    };

    const runSnapshotRecovery = async (reason: "bootstrap" | "replay-failed"): Promise<void> => {
      const started = recovery.beginSnapshotRecovery(reason);
      if (import.meta.env.MODE !== "test") {
        const state = recovery.getState();
        console.info("[orchestration-recovery]", "Snapshot recovery requested.", {
          reason,
          skipped: !started,
          ...(started
            ? {}
            : {
                blockedBy: state.inFlight?.kind ?? null,
                blockedByReason: state.inFlight?.reason ?? null,
              }),
          state,
        });
      }
      if (!started) {
        return;
      }

      try {
        const snapshot = await api.orchestration.getSnapshot();
        if (!disposed) {
          syncServerReadModel(snapshot);
          reconcileSnapshotDerivedState();
          if (recovery.completeSnapshotRecovery(snapshot.snapshotSequence)) {
            void runReplayRecovery("sequence-gap");
          }
        }
      } catch {
        // Keep prior state and wait for welcome or a later replay attempt.
        recovery.failSnapshotRecovery();
      }
    };

    const bootstrapFromSnapshot = async (): Promise<void> => {
      await runSnapshotRecovery("bootstrap");
    };
    bootstrapFromSnapshotRef.current = bootstrapFromSnapshot;

    const fallbackToSnapshotRecovery = async (): Promise<void> => {
      await runSnapshotRecovery("replay-failed");
    };
    const unsubDomainEvent = api.orchestration.onDomainEvent(
      (event) => {
        const action = recovery.classifyDomainEvent(event.sequence);
        if (action === "apply") {
          pendingDomainEvents.push(event);
          schedulePendingDomainEventFlush();
          return;
        }
        if (action === "recover") {
          flushPendingDomainEvents();
          void runReplayRecovery("sequence-gap");
        }
      },
      {
        onResubscribe: () => {
          if (disposed) {
            return;
          }
          flushPendingDomainEvents();
          void runReplayRecovery("resubscribe");
        },
      },
    );
    const unsubTerminalEvent = api.terminal.onEvent((event) => {
      const workspace = useStore
        .getState()
        .workspaces.find((entry) => entry.id === event.workspaceId);
      if (workspace && workspace.archivedAt !== null) {
        return;
      }
      applyTerminalEvent(event);

      // Detect ports from terminal output for the run command feature
      if (event.type === "output") {
        const runCommandState = useRunCommandStore.getState();
        const runtime = runCommandState.runtimeByWorkspaceId[event.workspaceId];
        if (runtime?.running && runtime.terminalId === event.terminalId) {
          const ports = detectPorts(event.data);
          if (ports.length > 0) {
            runCommandState.addPorts(event.workspaceId as WorkspaceId, ports);
          }
        }
      }

      // Clear run command state when the run terminal exits
      if (event.type === "exited") {
        const runCommandState = useRunCommandStore.getState();
        const runtime = runCommandState.runtimeByWorkspaceId[event.workspaceId];
        if (runtime?.running && runtime.terminalId === event.terminalId) {
          runCommandState.stop(event.workspaceId as WorkspaceId);
        }
      }
    });
    return () => {
      disposed = true;
      disposedRef.current = true;
      needsProviderInvalidation = false;
      flushPendingDomainEventsScheduled = false;
      pendingDomainEvents.length = 0;
      queryInvalidationThrottler.cancel();
      unsubDomainEvent();
      unsubTerminalEvent();
    };
  }, [
    applyOrchestrationEvents,
    navigate,
    queryClient,
    removeTerminalState,
    removeOrphanedTerminalStates,
    applyTerminalEvent,
    clearWorkspaceUi,
    setProjectExpanded,
    syncProjects,
    syncServerReadModel,
    syncWorkspaces,
  ]);

  useServerWelcomeSubscription(handleWelcome);
  useServerConfigUpdatedSubscription(handleServerConfigUpdated);

  return null;
}
