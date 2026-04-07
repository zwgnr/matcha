import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import type { ProviderKind, ProviderRuntimeEvent, ProviderSession } from "@matcha/contracts";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  WorkspaceId,
  TurnId,
} from "@matcha/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Exit, Layer, ManagedRuntime, PubSub, Scope, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CheckpointStoreLive } from "../../checkpointing/Layers/CheckpointStore.ts";
import { CheckpointStore } from "../../checkpointing/Services/CheckpointStore.ts";
import { GitCoreLive } from "../../git/Layers/GitCore.ts";
import { CheckpointReactorLive } from "./CheckpointReactor.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { RuntimeReceiptBusLive } from "./RuntimeReceiptBus.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { checkpointRefForWorkspaceTurn } from "../../checkpointing/Utils.ts";
import { ServerConfig } from "../../config.ts";
import { WorkspaceEntriesLive } from "../../workspace/Layers/WorkspaceEntries.ts";
import { WorkspacePathsLive } from "../../workspace/Layers/WorkspacePaths.ts";

const asProjectId = (value: string): ProjectId => ProjectId.makeUnsafe(value);
const asTurnId = (value: string): TurnId => TurnId.makeUnsafe(value);

type LegacyProviderRuntimeEvent = {
  readonly type: string;
  readonly eventId: EventId;
  readonly provider: ProviderKind;
  readonly createdAt: string;
  readonly workspaceId: WorkspaceId;
  readonly turnId?: string | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly payload?: unknown | undefined;
  readonly [key: string]: unknown;
};

function createProviderServiceHarness(
  cwd: string,
  hasSession = true,
  sessionCwd = cwd,
  providerName: ProviderSession["provider"] = "codex",
) {
  const now = new Date().toISOString();
  const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
  const rollbackConversation = vi.fn(
    (_input: { readonly workspaceId: WorkspaceId; readonly numTurns: number }) => Effect.void,
  );

  const unsupported = <A>() =>
    Effect.die(new Error("Unsupported provider call in test")) as Effect.Effect<A, never>;
  const listSessions = () =>
    hasSession
      ? Effect.succeed([
          {
            provider: providerName,
            status: "ready",
            runtimeMode: "full-access",
            workspaceId: WorkspaceId.makeUnsafe("workspace-1"),
            cwd: sessionCwd,
            createdAt: now,
            updatedAt: now,
          },
        ] satisfies ReadonlyArray<ProviderSession>)
      : Effect.succeed([] as ReadonlyArray<ProviderSession>);
  const service: ProviderServiceShape = {
    startSession: () => unsupported(),
    sendTurn: () => unsupported(),
    interruptTurn: () => unsupported(),
    respondToRequest: () => unsupported(),
    respondToUserInput: () => unsupported(),
    stopSession: () => unsupported(),
    listSessions,
    getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
    rollbackConversation,
    get streamEvents() {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
  };

  const emit = (event: LegacyProviderRuntimeEvent): void => {
    Effect.runSync(PubSub.publish(runtimeEventPubSub, event as unknown as ProviderRuntimeEvent));
  };

  return {
    service,
    rollbackConversation,
    emit,
  };
}

async function waitForWorkspace(
  engine: OrchestrationEngineShape,
  predicate: (workspace: {
    latestTurn: { turnId: string } | null;
    checkpoints: ReadonlyArray<{ checkpointTurnCount: number }>;
    activities: ReadonlyArray<{ kind: string }>;
  }) => boolean,
  timeoutMs = 15_000,
) {
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<{
    latestTurn: { turnId: string } | null;
    checkpoints: ReadonlyArray<{ checkpointTurnCount: number }>;
    activities: ReadonlyArray<{ kind: string }>;
  }> => {
    const readModel = await Effect.runPromise(engine.getReadModel());
    const workspace = readModel.workspaces.find(
      (entry) => entry.id === WorkspaceId.makeUnsafe("workspace-1"),
    );
    if (workspace && predicate(workspace)) {
      return workspace;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for workspace state.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return poll();
  };
  return poll();
}

async function waitForEvent(
  engine: OrchestrationEngineShape,
  predicate: (event: { type: string }) => boolean,
  timeoutMs = 15_000,
) {
  const deadline = Date.now() + timeoutMs;
  const poll = async () => {
    const events = await Effect.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(Effect.map((chunk) => Array.from(chunk))),
    );
    if (events.some(predicate)) {
      return events;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for orchestration event.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return poll();
  };
  return poll();
}

function runGit(cwd: string, args: ReadonlyArray<string>) {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
}

function createGitRepository() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "matcha-checkpoint-handler-"));
  runGit(cwd, ["init", "--initial-branch=main"]);
  runGit(cwd, ["config", "user.email", "test@example.com"]);
  runGit(cwd, ["config", "user.name", "Test User"]);
  fs.writeFileSync(path.join(cwd, "README.md"), "v1\n", "utf8");
  runGit(cwd, ["add", "."]);
  runGit(cwd, ["commit", "-m", "Initial"]);
  return cwd;
}

function gitRefExists(cwd: string, ref: string): boolean {
  try {
    runGit(cwd, ["show-ref", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
}

function gitShowFileAtRef(cwd: string, ref: string, filePath: string): string {
  return runGit(cwd, ["show", `${ref}:${filePath}`]);
}

async function waitForGitRefExists(cwd: string, ref: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<void> => {
    if (gitRefExists(cwd, ref)) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for git ref '${ref}'.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return poll();
  };
  return poll();
}

describe("CheckpointReactor", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    OrchestrationEngineService | CheckpointReactor | CheckpointStore,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;
  const tempDirs: string[] = [];

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  async function createHarness(options?: {
    readonly hasSession?: boolean;
    readonly seedFilesystemCheckpoints?: boolean;
    readonly projectWorkspaceRoot?: string;
    readonly workspaceWorktreePath?: string | null;
    readonly providerSessionCwd?: string;
    readonly providerName?: ProviderKind;
  }) {
    const cwd = createGitRepository();
    tempDirs.push(cwd);
    const provider = createProviderServiceHarness(
      cwd,
      options?.hasSession ?? true,
      options?.providerSessionCwd ?? cwd,
      options?.providerName ?? "codex",
    );
    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(SqlitePersistenceMemory),
    );

    const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
      prefix: "matcha-checkpoint-reactor-test-",
    });

    const layer = CheckpointReactorLive.pipe(
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(RuntimeReceiptBusLive),
      Layer.provideMerge(Layer.succeed(ProviderService, provider.service)),
      Layer.provideMerge(CheckpointStoreLive),
      Layer.provideMerge(WorkspaceEntriesLive.pipe(Layer.provide(WorkspacePathsLive))),
      Layer.provideMerge(WorkspacePathsLive),
      Layer.provideMerge(GitCoreLive),
      Layer.provideMerge(ServerConfigLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    runtime = ManagedRuntime.make(layer);
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const reactor = await runtime.runPromise(Effect.service(CheckpointReactor));
    const checkpointStore = await runtime.runPromise(Effect.service(CheckpointStore));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));
    const drain = () => Effect.runPromise(reactor.drain);

    const createdAt = new Date().toISOString();
    await Effect.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-create"),
        projectId: asProjectId("project-1"),
        title: "Test Project",
        workspaceRoot: options?.projectWorkspaceRoot ?? cwd,
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await Effect.runPromise(
      engine.dispatch({
        type: "workspace.create",
        commandId: CommandId.makeUnsafe("cmd-workspace-create"),
        workspaceId: WorkspaceId.makeUnsafe("workspace-1"),
        projectId: asProjectId("project-1"),
        title: "Workspace",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: options?.workspaceWorktreePath ?? cwd,
        createdAt,
      }),
    );

    if (options?.seedFilesystemCheckpoints ?? true) {
      await runtime.runPromise(
        checkpointStore.captureCheckpoint({
          cwd,
          checkpointRef: checkpointRefForWorkspaceTurn(WorkspaceId.makeUnsafe("workspace-1"), 0),
        }),
      );
      fs.writeFileSync(path.join(cwd, "README.md"), "v2\n", "utf8");
      await runtime.runPromise(
        checkpointStore.captureCheckpoint({
          cwd,
          checkpointRef: checkpointRefForWorkspaceTurn(WorkspaceId.makeUnsafe("workspace-1"), 1),
        }),
      );
      fs.writeFileSync(path.join(cwd, "README.md"), "v3\n", "utf8");
      await runtime.runPromise(
        checkpointStore.captureCheckpoint({
          cwd,
          checkpointRef: checkpointRefForWorkspaceTurn(WorkspaceId.makeUnsafe("workspace-1"), 2),
        }),
      );
    }

    return {
      engine,
      provider,
      cwd,
      drain,
    };
  }

  it("captures pre-turn baseline on turn.started and post-turn checkpoint on turn.completed", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "workspace.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-capture"),
        workspaceId: WorkspaceId.makeUnsafe("workspace-1"),
        session: {
          workspaceId: WorkspaceId.makeUnsafe("workspace-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.makeUnsafe("evt-turn-started-1"),
      provider: "codex",

      createdAt: new Date().toISOString(),
      workspaceId: WorkspaceId.makeUnsafe("workspace-1"),
      turnId: asTurnId("turn-1"),
    });
    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForWorkspaceTurn(WorkspaceId.makeUnsafe("workspace-1"), 0),
    );

    fs.writeFileSync(path.join(harness.cwd, "README.md"), "v2\n", "utf8");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.makeUnsafe("evt-turn-completed-1"),
      provider: "codex",

      createdAt: new Date().toISOString(),
      workspaceId: WorkspaceId.makeUnsafe("workspace-1"),
      turnId: asTurnId("turn-1"),
      payload: { state: "completed" },
    });

    await waitForEvent(harness.engine, (event) => event.type === "workspace.turn-diff-completed");
    const workspace = await waitForWorkspace(
      harness.engine,
      (entry) => entry.latestTurn?.turnId === "turn-1" && entry.checkpoints.length === 1,
    );
    expect(workspace.checkpoints[0]?.checkpointTurnCount).toBe(1);
    expect(
      gitRefExists(
        harness.cwd,
        checkpointRefForWorkspaceTurn(WorkspaceId.makeUnsafe("workspace-1"), 0),
      ),
    ).toBe(true);
    expect(
      gitRefExists(
        harness.cwd,
        checkpointRefForWorkspaceTurn(WorkspaceId.makeUnsafe("workspace-1"), 1),
      ),
    ).toBe(true);
    expect(
      gitShowFileAtRef(
        harness.cwd,
        checkpointRefForWorkspaceTurn(WorkspaceId.makeUnsafe("workspace-1"), 0),
        "README.md",
      ),
    ).toBe("v1\n");
    expect(
      gitShowFileAtRef(
        harness.cwd,
        checkpointRefForWorkspaceTurn(WorkspaceId.makeUnsafe("workspace-1"), 1),
        "README.md",
      ),
    ).toBe("v2\n");
  });

  it("ignores auxiliary workspace turn completion while primary turn is active", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "workspace.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-primary-running"),
        workspaceId: WorkspaceId.makeUnsafe("workspace-1"),
        session: {
          workspaceId: WorkspaceId.makeUnsafe("workspace-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-main"),
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.makeUnsafe("evt-turn-started-main"),
      provider: "codex",

      createdAt: new Date().toISOString(),
      workspaceId: WorkspaceId.makeUnsafe("workspace-1"),
      turnId: asTurnId("turn-main"),
    });
    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForWorkspaceTurn(WorkspaceId.makeUnsafe("workspace-1"), 0),
    );

    fs.writeFileSync(path.join(harness.cwd, "README.md"), "v2\n", "utf8");

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.makeUnsafe("evt-turn-completed-aux"),
      provider: "codex",

      createdAt: new Date().toISOString(),
      workspaceId: WorkspaceId.makeUnsafe("workspace-1"),
      turnId: asTurnId("turn-aux"),
      payload: { state: "completed" },
    });

    await harness.drain();
    const midReadModel = await Effect.runPromise(harness.engine.getReadModel());
    const midWorkspace = midReadModel.workspaces.find(
      (entry) => entry.id === WorkspaceId.makeUnsafe("workspace-1"),
    );
    expect(midWorkspace?.checkpoints).toHaveLength(0);

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.makeUnsafe("evt-turn-completed-main"),
      provider: "codex",

      createdAt: new Date().toISOString(),
      workspaceId: WorkspaceId.makeUnsafe("workspace-1"),
      turnId: asTurnId("turn-main"),
      payload: { state: "completed" },
    });

    const workspace = await waitForWorkspace(
      harness.engine,
      (entry) => entry.latestTurn?.turnId === "turn-main" && entry.checkpoints.length === 1,
    );
    expect(workspace.checkpoints[0]?.checkpointTurnCount).toBe(1);
  });

  it("captures pre-turn and completion checkpoints for claude runtime events", async () => {
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      providerName: "claudeAgent",
    });
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "workspace.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-capture-claude"),
        workspaceId: WorkspaceId.makeUnsafe("workspace-1"),
        session: {
          workspaceId: WorkspaceId.makeUnsafe("workspace-1"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.makeUnsafe("evt-turn-started-claude-1"),
      provider: "claudeAgent",
      createdAt: new Date().toISOString(),
      workspaceId: WorkspaceId.makeUnsafe("workspace-1"),
      turnId: asTurnId("turn-claude-1"),
    });
    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForWorkspaceTurn(WorkspaceId.makeUnsafe("workspace-1"), 0),
    );

    fs.writeFileSync(path.join(harness.cwd, "README.md"), "v2\n", "utf8");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.makeUnsafe("evt-turn-completed-claude-1"),
      provider: "claudeAgent",
      createdAt: new Date().toISOString(),
      workspaceId: WorkspaceId.makeUnsafe("workspace-1"),
      turnId: asTurnId("turn-claude-1"),
      payload: { state: "completed" },
    });

    await waitForEvent(harness.engine, (event) => event.type === "workspace.turn-diff-completed");
    const workspace = await waitForWorkspace(
      harness.engine,
      (entry) => entry.latestTurn?.turnId === "turn-claude-1" && entry.checkpoints.length === 1,
    );

    expect(workspace.checkpoints[0]?.checkpointTurnCount).toBe(1);
    expect(
      gitRefExists(
        harness.cwd,
        checkpointRefForWorkspaceTurn(WorkspaceId.makeUnsafe("workspace-1"), 1),
      ),
    ).toBe(true);
  });

  it("appends capture failure activity when turn diff summary cannot be derived", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "workspace.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-missing-baseline-diff"),
        workspaceId: WorkspaceId.makeUnsafe("workspace-1"),
        session: {
          workspaceId: WorkspaceId.makeUnsafe("workspace-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.makeUnsafe("evt-turn-completed-missing-baseline"),
      provider: "codex",

      createdAt: new Date().toISOString(),
      workspaceId: WorkspaceId.makeUnsafe("workspace-1"),
      turnId: asTurnId("turn-missing-baseline"),
      payload: { state: "completed" },
    });

    await waitForEvent(harness.engine, (event) => event.type === "workspace.turn-diff-completed");
    const workspace = await waitForWorkspace(
      harness.engine,
      (entry) =>
        entry.checkpoints.length === 1 &&
        entry.activities.some((activity) => activity.kind === "checkpoint.capture.failed"),
    );

    expect(workspace.checkpoints[0]?.checkpointTurnCount).toBe(1);
    expect(
      workspace.activities.some((activity) => activity.kind === "checkpoint.capture.failed"),
    ).toBe(true);
  });

  it("captures pre-turn baseline from project workspace root when worktree is unset", async () => {
    const harness = await createHarness({
      hasSession: false,
      seedFilesystemCheckpoints: false,
      workspaceWorktreePath: null,
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "workspace.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-for-baseline"),
        workspaceId: WorkspaceId.makeUnsafe("workspace-1"),
        message: {
          messageId: MessageId.makeUnsafe("message-user-1"),
          role: "user",
          text: "start turn",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: new Date().toISOString(),
      }),
    );

    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForWorkspaceTurn(WorkspaceId.makeUnsafe("workspace-1"), 0),
    );
    expect(
      gitShowFileAtRef(
        harness.cwd,
        checkpointRefForWorkspaceTurn(WorkspaceId.makeUnsafe("workspace-1"), 0),
        "README.md",
      ),
    ).toBe("v1\n");
  });

  it("captures turn completion checkpoint from project workspace root when provider session cwd is unavailable", async () => {
    const harness = await createHarness({
      hasSession: false,
      seedFilesystemCheckpoints: false,
      workspaceWorktreePath: null,
    });
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "workspace.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-missing-provider-cwd"),
        workspaceId: WorkspaceId.makeUnsafe("workspace-1"),
        session: {
          workspaceId: WorkspaceId.makeUnsafe("workspace-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-missing-cwd"),
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    fs.writeFileSync(path.join(harness.cwd, "README.md"), "v2\n", "utf8");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.makeUnsafe("evt-turn-completed-missing-provider-cwd"),
      provider: "codex",

      createdAt: new Date().toISOString(),
      workspaceId: WorkspaceId.makeUnsafe("workspace-1"),
      turnId: asTurnId("turn-missing-cwd"),
      payload: { state: "completed" },
    });

    await waitForEvent(harness.engine, (event) => event.type === "workspace.turn-diff-completed");
    expect(
      gitRefExists(
        harness.cwd,
        checkpointRefForWorkspaceTurn(WorkspaceId.makeUnsafe("workspace-1"), 1),
      ),
    ).toBe(true);
    expect(
      gitShowFileAtRef(
        harness.cwd,
        checkpointRefForWorkspaceTurn(WorkspaceId.makeUnsafe("workspace-1"), 1),
        "README.md",
      ),
    ).toBe("v2\n");
  });

  it("ignores non-v2 checkpoint.captured runtime events", async () => {
    const harness = await createHarness();
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "workspace.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-checkpoint-captured"),
        workspaceId: WorkspaceId.makeUnsafe("workspace-1"),
        session: {
          workspaceId: WorkspaceId.makeUnsafe("workspace-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "checkpoint.captured",
      eventId: EventId.makeUnsafe("evt-checkpoint-captured-3"),
      provider: "codex",

      createdAt: new Date().toISOString(),
      workspaceId: WorkspaceId.makeUnsafe("workspace-1"),
      turnId: asTurnId("turn-3"),
      turnCount: 3,
      status: "completed",
    });

    await harness.drain();
    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const workspace = readModel.workspaces.find(
      (entry) => entry.id === WorkspaceId.makeUnsafe("workspace-1"),
    );
    expect(workspace?.checkpoints.some((checkpoint) => checkpoint.checkpointTurnCount === 3)).toBe(
      false,
    );
  });

  it("continues processing runtime events after a single checkpoint runtime failure", async () => {
    const nonRepositorySessionCwd = fs.mkdtempSync(
      path.join(os.tmpdir(), "matcha-checkpoint-runtime-non-repo-"),
    );
    tempDirs.push(nonRepositorySessionCwd);

    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      providerSessionCwd: nonRepositorySessionCwd,
    });
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "workspace.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-non-repo-runtime"),
        workspaceId: WorkspaceId.makeUnsafe("workspace-1"),
        session: {
          workspaceId: WorkspaceId.makeUnsafe("workspace-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.makeUnsafe("evt-runtime-capture-failure"),
      provider: "codex",

      createdAt: new Date().toISOString(),
      workspaceId: WorkspaceId.makeUnsafe("workspace-1"),
      turnId: asTurnId("turn-runtime-failure"),
      payload: { state: "completed" },
    });

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.makeUnsafe("evt-turn-started-after-runtime-failure"),
      provider: "codex",

      createdAt: new Date().toISOString(),
      workspaceId: WorkspaceId.makeUnsafe("workspace-1"),
      turnId: asTurnId("turn-after-runtime-failure"),
    });

    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForWorkspaceTurn(WorkspaceId.makeUnsafe("workspace-1"), 0),
    );
    expect(
      gitRefExists(
        harness.cwd,
        checkpointRefForWorkspaceTurn(WorkspaceId.makeUnsafe("workspace-1"), 0),
      ),
    ).toBe(true);
  });

  it("executes provider revert and emits workspace.reverted for checkpoint revert requests", async () => {
    const harness = await createHarness();
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "workspace.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set"),
        workspaceId: WorkspaceId.makeUnsafe("workspace-1"),
        session: {
          workspaceId: WorkspaceId.makeUnsafe("workspace-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "workspace.turn.diff.complete",
        commandId: CommandId.makeUnsafe("cmd-diff-1"),
        workspaceId: WorkspaceId.makeUnsafe("workspace-1"),
        turnId: asTurnId("turn-1"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForWorkspaceTurn(WorkspaceId.makeUnsafe("workspace-1"), 1),
        status: "ready",
        files: [],
        checkpointTurnCount: 1,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "workspace.turn.diff.complete",
        commandId: CommandId.makeUnsafe("cmd-diff-2"),
        workspaceId: WorkspaceId.makeUnsafe("workspace-1"),
        turnId: asTurnId("turn-2"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForWorkspaceTurn(WorkspaceId.makeUnsafe("workspace-1"), 2),
        status: "ready",
        files: [],
        checkpointTurnCount: 2,
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "workspace.checkpoint.revert",
        commandId: CommandId.makeUnsafe("cmd-revert-request"),
        workspaceId: WorkspaceId.makeUnsafe("workspace-1"),
        turnCount: 1,
        createdAt,
      }),
    );

    await waitForEvent(harness.engine, (event) => event.type === "workspace.reverted");
    const workspace = await waitForWorkspace(
      harness.engine,
      (entry) => entry.checkpoints.length === 1,
    );

    expect(workspace.latestTurn?.turnId).toBe("turn-1");
    expect(workspace.checkpoints).toHaveLength(1);
    expect(workspace.checkpoints[0]?.checkpointTurnCount).toBe(1);
    expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(1);
    expect(harness.provider.rollbackConversation).toHaveBeenCalledWith({
      workspaceId: WorkspaceId.makeUnsafe("workspace-1"),
      numTurns: 1,
    });
    expect(fs.readFileSync(path.join(harness.cwd, "README.md"), "utf8")).toBe("v2\n");
    expect(
      gitRefExists(
        harness.cwd,
        checkpointRefForWorkspaceTurn(WorkspaceId.makeUnsafe("workspace-1"), 2),
      ),
    ).toBe(false);
  });

  it("executes provider revert and emits workspace.reverted for claude sessions", async () => {
    const harness = await createHarness({ providerName: "claudeAgent" });
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "workspace.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-claude"),
        workspaceId: WorkspaceId.makeUnsafe("workspace-1"),
        session: {
          workspaceId: WorkspaceId.makeUnsafe("workspace-1"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "workspace.turn.diff.complete",
        commandId: CommandId.makeUnsafe("cmd-diff-claude-1"),
        workspaceId: WorkspaceId.makeUnsafe("workspace-1"),
        turnId: asTurnId("turn-claude-1"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForWorkspaceTurn(WorkspaceId.makeUnsafe("workspace-1"), 1),
        status: "ready",
        files: [],
        checkpointTurnCount: 1,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "workspace.turn.diff.complete",
        commandId: CommandId.makeUnsafe("cmd-diff-claude-2"),
        workspaceId: WorkspaceId.makeUnsafe("workspace-1"),
        turnId: asTurnId("turn-claude-2"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForWorkspaceTurn(WorkspaceId.makeUnsafe("workspace-1"), 2),
        status: "ready",
        files: [],
        checkpointTurnCount: 2,
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "workspace.checkpoint.revert",
        commandId: CommandId.makeUnsafe("cmd-revert-request-claude"),
        workspaceId: WorkspaceId.makeUnsafe("workspace-1"),
        turnCount: 1,
        createdAt,
      }),
    );

    await waitForEvent(harness.engine, (event) => event.type === "workspace.reverted");
    expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(1);
    expect(harness.provider.rollbackConversation).toHaveBeenCalledWith({
      workspaceId: WorkspaceId.makeUnsafe("workspace-1"),
      numTurns: 1,
    });
  });

  it("processes consecutive revert requests with deterministic rollback sequencing", async () => {
    const harness = await createHarness();
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "workspace.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-inline-revert"),
        workspaceId: WorkspaceId.makeUnsafe("workspace-1"),
        session: {
          workspaceId: WorkspaceId.makeUnsafe("workspace-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "workspace.turn.diff.complete",
        commandId: CommandId.makeUnsafe("cmd-inline-revert-diff-1"),
        workspaceId: WorkspaceId.makeUnsafe("workspace-1"),
        turnId: asTurnId("turn-1"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForWorkspaceTurn(WorkspaceId.makeUnsafe("workspace-1"), 1),
        status: "ready",
        files: [],
        checkpointTurnCount: 1,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "workspace.turn.diff.complete",
        commandId: CommandId.makeUnsafe("cmd-inline-revert-diff-2"),
        workspaceId: WorkspaceId.makeUnsafe("workspace-1"),
        turnId: asTurnId("turn-2"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForWorkspaceTurn(WorkspaceId.makeUnsafe("workspace-1"), 2),
        status: "ready",
        files: [],
        checkpointTurnCount: 2,
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "workspace.checkpoint.revert",
        commandId: CommandId.makeUnsafe("cmd-sequenced-revert-request-1"),
        workspaceId: WorkspaceId.makeUnsafe("workspace-1"),
        turnCount: 1,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "workspace.checkpoint.revert",
        commandId: CommandId.makeUnsafe("cmd-sequenced-revert-request-0"),
        workspaceId: WorkspaceId.makeUnsafe("workspace-1"),
        turnCount: 0,
        createdAt,
      }),
    );

    await harness.drain();

    expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(2);
    expect(harness.provider.rollbackConversation.mock.calls[0]?.[0]).toEqual({
      workspaceId: WorkspaceId.makeUnsafe("workspace-1"),
      numTurns: 1,
    });
    expect(harness.provider.rollbackConversation.mock.calls[1]?.[0]).toEqual({
      workspaceId: WorkspaceId.makeUnsafe("workspace-1"),
      numTurns: 1,
    });
  });

  it("appends an error activity when revert is requested without an active session", async () => {
    const harness = await createHarness({ hasSession: false });
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "workspace.checkpoint.revert",
        commandId: CommandId.makeUnsafe("cmd-revert-no-session"),
        workspaceId: WorkspaceId.makeUnsafe("workspace-1"),
        turnCount: 1,
        createdAt,
      }),
    );

    const workspace = await waitForWorkspace(harness.engine, (entry) =>
      entry.activities.some((activity) => activity.kind === "checkpoint.revert.failed"),
    );

    expect(
      workspace.activities.some((activity) => activity.kind === "checkpoint.revert.failed"),
    ).toBe(true);
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
  });
});
