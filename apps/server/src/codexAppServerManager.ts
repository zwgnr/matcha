import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import readline from "node:readline";

import {
  ApprovalRequestId,
  EventId,
  ProviderItemId,
  ProviderRequestKind,
  type ProviderUserInputAnswers,
  WorkspaceId,
  TurnId,
  type ProviderApprovalDecision,
  type ProviderEvent,
  type ProviderSession,
  type ProviderTurnStartResult,
  RuntimeMode,
  ProviderInteractionMode,
} from "@matcha/contracts";
import { normalizeModelSlug } from "@matcha/shared/model";
import { Effect, ServiceMap } from "effect";

import {
  formatCodexCliUpgradeMessage,
  isCodexCliVersionSupported,
  parseCodexCliVersion,
} from "./provider/codexCliVersion";
import {
  readCodexAccountSnapshot,
  resolveCodexModelForAccount,
  type CodexAccountSnapshot,
} from "./provider/codexAccount";
import { buildCodexInitializeParams, killCodexChildProcess } from "./provider/codexAppServer";

export { buildCodexInitializeParams } from "./provider/codexAppServer";
export { readCodexAccountSnapshot, resolveCodexModelForAccount } from "./provider/codexAccount";

type PendingRequestKey = string;

interface PendingRequest {
  method: string;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface PendingApprovalRequest {
  requestId: ApprovalRequestId;
  jsonRpcId: string | number;
  method:
    | "item/commandExecution/requestApproval"
    | "item/fileChange/requestApproval"
    | "item/fileRead/requestApproval";
  requestKind: ProviderRequestKind;
  workspaceId: WorkspaceId;
  turnId?: TurnId;
  itemId?: ProviderItemId;
}

interface PendingUserInputRequest {
  requestId: ApprovalRequestId;
  jsonRpcId: string | number;
  workspaceId: WorkspaceId;
  turnId?: TurnId;
  itemId?: ProviderItemId;
}

interface CodexUserInputAnswer {
  answers: string[];
}

interface CodexSessionContext {
  session: ProviderSession;
  account: CodexAccountSnapshot;
  child: ChildProcessWithoutNullStreams;
  output: readline.Interface;
  pending: Map<PendingRequestKey, PendingRequest>;
  pendingApprovals: Map<ApprovalRequestId, PendingApprovalRequest>;
  pendingUserInputs: Map<ApprovalRequestId, PendingUserInputRequest>;
  collabReceiverTurns: Map<string, TurnId>;
  nextRequestId: number;
  stopping: boolean;
}

interface JsonRpcError {
  code?: number;
  message?: string;
}

interface JsonRpcRequest {
  id: string | number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  id: string | number;
  result?: unknown;
  error?: JsonRpcError;
}

interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

export interface CodexAppServerSendTurnInput {
  readonly workspaceId: WorkspaceId;
  readonly input?: string;
  readonly attachments?: ReadonlyArray<{ type: "image"; url: string }>;
  readonly model?: string;
  readonly serviceTier?: string | null;
  readonly effort?: string;
  readonly interactionMode?: ProviderInteractionMode;
}

export interface CodexAppServerStartSessionInput {
  readonly workspaceId: WorkspaceId;
  readonly provider?: "codex";
  readonly cwd?: string;
  readonly model?: string;
  readonly serviceTier?: string;
  readonly resumeCursor?: unknown;
  readonly binaryPath: string;
  readonly homePath?: string;
  readonly runtimeMode: RuntimeMode;
}

export interface CodexWorkspaceTurnSnapshot {
  id: TurnId;
  items: unknown[];
}

export interface CodexWorkspaceSnapshot {
  workspaceId: string;
  turns: CodexWorkspaceTurnSnapshot[];
}

const CODEX_VERSION_CHECK_TIMEOUT_MS = 4_000;

const ANSI_ESCAPE_CHAR = String.fromCharCode(27);
const ANSI_ESCAPE_REGEX = new RegExp(`${ANSI_ESCAPE_CHAR}\\[[0-9;]*m`, "g");
const CODEX_STDERR_LOG_REGEX =
  /^\d{4}-\d{2}-\d{2}T\S+\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s+\S+:\s+(.*)$/;
const BENIGN_ERROR_LOG_SNIPPETS = [
  "state db missing rollout path for workspace",
  "state db record_discrepancy: find_workspace_path_by_id_str_in_subdir, falling_back",
];
const RECOVERABLE_WORKSPACE_RESUME_ERROR_SNIPPETS = [
  "not found",
  "missing workspace",
  "no such workspace",
  "unknown workspace",
  "does not exist",
];
export const CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS = `<collaboration_mode># Plan Mode (Conversational)

You work in 3 phases, and you should *chat your way* to a great plan before finalizing it. A great plan is very detailed-intent- and implementation-wise-so that it can be handed to another engineer or agent to be implemented right away. It must be **decision complete**, where the implementer does not need to make any decisions.

## Mode rules (strict)

You are in **Plan Mode** until a developer message explicitly ends it.

Plan Mode is not changed by user intent, tone, or imperative language. If a user asks for execution while still in Plan Mode, treat it as a request to **plan the execution**, not perform it.

## Plan Mode vs update_plan tool

Plan Mode is a collaboration mode that can involve requesting user input and eventually issuing a \`<proposed_plan>\` block.

Separately, \`update_plan\` is a checklist/progress/TODOs tool; it does not enter or exit Plan Mode. Do not confuse it with Plan mode or try to use it while in Plan mode. If you try to use \`update_plan\` in Plan mode, it will return an error.

## Execution vs. mutation in Plan Mode

You may explore and execute **non-mutating** actions that improve the plan. You must not perform **mutating** actions.

### Allowed (non-mutating, plan-improving)

Actions that gather truth, reduce ambiguity, or validate feasibility without changing repo-tracked state. Examples:

* Reading or searching files, configs, schemas, types, manifests, and docs
* Static analysis, inspection, and repo exploration
* Dry-run style commands when they do not edit repo-tracked files
* Tests, builds, or checks that may write to caches or build artifacts (for example, \`target/\`, \`.cache/\`, or snapshots) so long as they do not edit repo-tracked files

### Not allowed (mutating, plan-executing)

Actions that implement the plan or change repo-tracked state. Examples:

* Editing or writing files
* Running formatters or linters that rewrite files
* Applying patches, migrations, or codegen that updates repo-tracked files
* Side-effectful commands whose purpose is to carry out the plan rather than refine it

When in doubt: if the action would reasonably be described as "doing the work" rather than "planning the work," do not do it.

## PHASE 1 - Ground in the environment (explore first, ask second)

Begin by grounding yourself in the actual environment. Eliminate unknowns in the prompt by discovering facts, not by asking the user. Resolve all questions that can be answered through exploration or inspection. Identify missing or ambiguous details only if they cannot be derived from the environment. Silent exploration between turns is allowed and encouraged.

Before asking the user any question, perform at least one targeted non-mutating exploration pass (for example: search relevant files, inspect likely entrypoints/configs, confirm current implementation shape), unless no local environment/repo is available.

Exception: you may ask clarifying questions about the user's prompt before exploring, ONLY if there are obvious ambiguities or contradictions in the prompt itself. However, if ambiguity might be resolved by exploring, always prefer exploring first.

Do not ask questions that can be answered from the repo or system (for example, "where is this struct?" or "which UI component should we use?" when exploration can make it clear). Only ask once you have exhausted reasonable non-mutating exploration.

## PHASE 2 - Intent chat (what they actually want)

* Keep asking until you can clearly state: goal + success criteria, audience, in/out of scope, constraints, current state, and the key preferences/tradeoffs.
* Bias toward questions over guessing: if any high-impact ambiguity remains, do NOT plan yet-ask.

## PHASE 3 - Implementation chat (what/how we'll build)

* Once intent is stable, keep asking until the spec is decision complete: approach, interfaces (APIs/schemas/I/O), data flow, edge cases/failure modes, testing + acceptance criteria, rollout/monitoring, and any migrations/compat constraints.

## Asking questions

Critical rules:

* Strongly prefer using the \`request_user_input\` tool to ask any questions.
* Offer only meaningful multiple-choice options; don't include filler choices that are obviously wrong or irrelevant.
* In rare cases where an unavoidable, important question can't be expressed with reasonable multiple-choice options (due to extreme ambiguity), you may ask it directly without the tool.

You SHOULD ask many questions, but each question must:

* materially change the spec/plan, OR
* confirm/lock an assumption, OR
* choose between meaningful tradeoffs.
* not be answerable by non-mutating commands.

Use the \`request_user_input\` tool only for decisions that materially change the plan, for confirming important assumptions, or for information that cannot be discovered via non-mutating exploration.

## Two kinds of unknowns (treat differently)

1. **Discoverable facts** (repo/system truth): explore first.

   * Before asking, run targeted searches and check likely sources of truth (configs/manifests/entrypoints/schemas/types/constants).
   * Ask only if: multiple plausible candidates; nothing found but you need a missing identifier/context; or ambiguity is actually product intent.
   * If asking, present concrete candidates (paths/service names) + recommend one.
   * Never ask questions you can answer from your environment (e.g., "where is this struct").

2. **Preferences/tradeoffs** (not discoverable): ask early.

   * These are intent or implementation preferences that cannot be derived from exploration.
   * Provide 2-4 mutually exclusive options + a recommended default.
   * If unanswered, proceed with the recommended option and record it as an assumption in the final plan.

## Finalization rule

Only output the final plan when it is decision complete and leaves no decisions to the implementer.

When you present the official plan, wrap it in a \`<proposed_plan>\` block so the client can render it specially:

1) The opening tag must be on its own line.
2) Start the plan content on the next line (no text on the same line as the tag).
3) The closing tag must be on its own line.
4) Use Markdown inside the block.
5) Keep the tags exactly as \`<proposed_plan>\` and \`</proposed_plan>\` (do not translate or rename them), even if the plan content is in another language.

Example:

<proposed_plan>
plan content
</proposed_plan>

plan content should be human and agent digestible. The final plan must be plan-only and include:

* A clear title
* A brief summary section
* Important changes or additions to public APIs/interfaces/types
* Test cases and scenarios
* Explicit assumptions and defaults chosen where needed

Do not ask "should I proceed?" in the final output. The user can easily switch out of Plan mode and request implementation if you have included a \`<proposed_plan>\` block in your response. Alternatively, they can decide to stay in Plan mode and continue refining the plan.

Only produce at most one \`<proposed_plan>\` block per turn, and only when you are presenting a complete spec.
</collaboration_mode>`;

export const CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS = `<collaboration_mode># Collaboration Mode: Default

You are now in Default mode. Any previous instructions for other modes (e.g. Plan mode) are no longer active.

Your active mode changes only when new developer instructions with a different \`<collaboration_mode>...</collaboration_mode>\` change it; user requests or tool descriptions do not change mode by themselves. Known mode names are Default and Plan.

## request_user_input availability

The \`request_user_input\` tool is unavailable in Default mode. If you call it while in Default mode, it will return an error.

In Default mode, strongly prefer making reasonable assumptions and executing the user's request rather than stopping to ask questions. If you absolutely must ask a question because the answer cannot be discovered from local context and a reasonable assumption would be risky, ask the user directly with a concise plain-text question. Never write a multiple choice question as a textual assistant message.
</collaboration_mode>`;

function mapCodexRuntimeMode(runtimeMode: RuntimeMode): {
  readonly approvalPolicy: "on-request" | "never";
  readonly sandbox: "workspace-write" | "danger-full-access";
} {
  if (runtimeMode === "approval-required") {
    return {
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    };
  }

  return {
    approvalPolicy: "never",
    sandbox: "danger-full-access",
  };
}

/**
 * On Windows with `shell: true`, `child.kill()` only terminates the `cmd.exe`
 * wrapper, leaving the actual command running. Use `taskkill /T` to kill the
 * entire process tree instead.
 */
function killChildTree(child: ChildProcessWithoutNullStreams): void {
  killCodexChildProcess(child);
}

export function normalizeCodexModelSlug(
  model: string | undefined | null,
  preferredId?: string,
): string | undefined {
  const normalized = normalizeModelSlug(model);
  if (!normalized) {
    return undefined;
  }

  if (preferredId?.endsWith("-codex") && preferredId !== normalized) {
    return preferredId;
  }

  return normalized;
}

function readExternalThreadId(record: Record<string, unknown> | undefined): string | undefined {
  if (!record) {
    return undefined;
  }

  const threadRecord =
    typeof record.thread === "object" && record.thread !== null
      ? (record.thread as Record<string, unknown>)
      : undefined;
  const workspaceRecord =
    typeof record.workspace === "object" && record.workspace !== null
      ? (record.workspace as Record<string, unknown>)
      : undefined;

  return (
    (typeof threadRecord?.id === "string" ? threadRecord.id : undefined) ??
    (typeof workspaceRecord?.id === "string" ? workspaceRecord.id : undefined) ??
    (typeof record.threadId === "string" ? record.threadId : undefined) ??
    (typeof record.workspaceId === "string" ? record.workspaceId : undefined)
  );
}

function buildCodexCollaborationMode(input: {
  readonly interactionMode?: "default" | "plan";
  readonly model?: string;
  readonly effort?: string;
}):
  | {
      mode: "default" | "plan";
      settings: {
        model: string;
        reasoning_effort: string;
        developer_instructions: string;
      };
    }
  | undefined {
  if (input.interactionMode === undefined) {
    return undefined;
  }
  const model = normalizeCodexModelSlug(input.model) ?? "gpt-5.3-codex";
  return {
    mode: input.interactionMode,
    settings: {
      model,
      reasoning_effort: input.effort ?? "medium",
      developer_instructions:
        input.interactionMode === "plan"
          ? CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS
          : CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
    },
  };
}

function toCodexUserInputAnswer(value: unknown): CodexUserInputAnswer {
  if (typeof value === "string") {
    return { answers: [value] };
  }

  if (Array.isArray(value)) {
    const answers = value.filter((entry): entry is string => typeof entry === "string");
    return { answers };
  }

  if (value && typeof value === "object") {
    const maybeAnswers = (value as { answers?: unknown }).answers;
    if (Array.isArray(maybeAnswers)) {
      const answers = maybeAnswers.filter((entry): entry is string => typeof entry === "string");
      return { answers };
    }
  }

  throw new Error("User input answers must be strings or arrays of strings.");
}

function toCodexUserInputAnswers(
  answers: ProviderUserInputAnswers,
): Record<string, CodexUserInputAnswer> {
  return Object.fromEntries(
    Object.entries(answers).map(([questionId, value]) => [
      questionId,
      toCodexUserInputAnswer(value),
    ]),
  );
}

export function classifyCodexStderrLine(rawLine: string): { message: string } | null {
  const line = rawLine.replaceAll(ANSI_ESCAPE_REGEX, "").trim();
  if (!line) {
    return null;
  }

  const match = line.match(CODEX_STDERR_LOG_REGEX);
  if (match) {
    const level = match[1];
    if (level && level !== "ERROR") {
      return null;
    }

    const isBenignError = BENIGN_ERROR_LOG_SNIPPETS.some((snippet) => line.includes(snippet));
    if (isBenignError) {
      return null;
    }
  }

  return { message: line };
}

export function isRecoverableWorkspaceResumeError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (!message.includes("thread/resume")) {
    return false;
  }

  return RECOVERABLE_WORKSPACE_RESUME_ERROR_SNIPPETS.some((snippet) => message.includes(snippet));
}

export interface CodexAppServerManagerEvents {
  event: [event: ProviderEvent];
}

export class CodexAppServerManager extends EventEmitter<CodexAppServerManagerEvents> {
  private readonly sessions = new Map<WorkspaceId, CodexSessionContext>();

  private runPromise: (effect: Effect.Effect<unknown, never>) => Promise<unknown>;
  constructor(services?: ServiceMap.ServiceMap<never>) {
    super();
    this.runPromise = services ? Effect.runPromiseWith(services) : Effect.runPromise;
  }

  async startSession(input: CodexAppServerStartSessionInput): Promise<ProviderSession> {
    const workspaceId = input.workspaceId;
    const now = new Date().toISOString();
    let context: CodexSessionContext | undefined;

    try {
      const resolvedCwd = input.cwd ?? process.cwd();

      const session: ProviderSession = {
        provider: "codex",
        status: "connecting",
        runtimeMode: input.runtimeMode,
        model: normalizeCodexModelSlug(input.model),
        cwd: resolvedCwd,
        workspaceId,
        createdAt: now,
        updatedAt: now,
      };

      const codexBinaryPath = input.binaryPath;
      const codexHomePath = input.homePath;
      this.assertSupportedCodexCliVersion({
        binaryPath: codexBinaryPath,
        cwd: resolvedCwd,
        ...(codexHomePath ? { homePath: codexHomePath } : {}),
      });
      const child = spawn(codexBinaryPath, ["app-server"], {
        cwd: resolvedCwd,
        env: {
          ...process.env,
          ...(codexHomePath ? { CODEX_HOME: codexHomePath } : {}),
        },
        stdio: ["pipe", "pipe", "pipe"],
        shell: process.platform === "win32",
      });
      const output = readline.createInterface({ input: child.stdout });

      context = {
        session,
        account: {
          type: "unknown",
          planType: null,
          sparkEnabled: true,
        },
        child,
        output,
        pending: new Map(),
        pendingApprovals: new Map(),
        pendingUserInputs: new Map(),
        collabReceiverTurns: new Map(),
        nextRequestId: 1,
        stopping: false,
      };

      this.sessions.set(workspaceId, context);
      this.attachProcessListeners(context);

      this.emitLifecycleEvent(context, "session/connecting", "Starting codex app-server");

      await this.sendRequest(context, "initialize", buildCodexInitializeParams());

      this.writeMessage(context, { method: "initialized" });
      try {
        const modelListResponse = await this.sendRequest(context, "model/list", {});
        console.log("codex model/list response", modelListResponse);
      } catch (error) {
        console.log("codex model/list failed", error);
      }
      try {
        const accountReadResponse = await this.sendRequest(context, "account/read", {});
        console.log("codex account/read response", accountReadResponse);
        context.account = readCodexAccountSnapshot(accountReadResponse);
        console.log("codex subscription status", {
          type: context.account.type,
          planType: context.account.planType,
          sparkEnabled: context.account.sparkEnabled,
        });
      } catch (error) {
        console.log("codex account/read failed", error);
      }

      const normalizedModel = resolveCodexModelForAccount(
        normalizeCodexModelSlug(input.model),
        context.account,
      );
      const sessionOverrides = {
        model: normalizedModel ?? null,
        ...(input.serviceTier !== undefined ? { serviceTier: input.serviceTier } : {}),
        cwd: input.cwd ?? null,
        ...mapCodexRuntimeMode(input.runtimeMode ?? "full-access"),
      };

      const workspaceStartParams = {
        ...sessionOverrides,
        experimentalRawEvents: false,
      };
      const resumeWorkspaceId = readResumeWorkspaceId(input);
      this.emitLifecycleEvent(
        context,
        "session/workspaceOpenRequested",
        resumeWorkspaceId
          ? `Attempting to resume workspace ${resumeWorkspaceId}.`
          : "Starting a new Codex workspace.",
      );
      await Effect.logInfo("codex app-server opening workspace", {
        workspaceId,
        requestedRuntimeMode: input.runtimeMode,
        requestedModel: normalizedModel ?? null,
        requestedCwd: resolvedCwd,
        resumeWorkspaceId: resumeWorkspaceId ?? null,
      }).pipe(this.runPromise);

      let workspaceOpenMethod: "thread/start" | "thread/resume" = "thread/start";
      let workspaceOpenResponse: unknown;
      if (resumeWorkspaceId) {
        try {
          workspaceOpenMethod = "thread/resume";
          workspaceOpenResponse = await this.sendRequest(context, "thread/resume", {
            ...sessionOverrides,
            threadId: resumeWorkspaceId,
          });
        } catch (error) {
          if (!isRecoverableWorkspaceResumeError(error)) {
            this.emitErrorEvent(
              context,
              "session/workspaceResumeFailed",
              error instanceof Error ? error.message : "Codex workspace resume failed.",
            );
            await Effect.logWarning("codex app-server workspace resume failed", {
              workspaceId,
              requestedRuntimeMode: input.runtimeMode,
              resumeWorkspaceId,
              recoverable: false,
              cause: error instanceof Error ? error.message : String(error),
            }).pipe(this.runPromise);
            throw error;
          }

          workspaceOpenMethod = "thread/start";
          this.emitLifecycleEvent(
            context,
            "session/workspaceResumeFallback",
            `Could not resume workspace ${resumeWorkspaceId}; started a new workspace instead.`,
          );
          await Effect.logWarning("codex app-server workspace resume fell back to fresh start", {
            workspaceId,
            requestedRuntimeMode: input.runtimeMode,
            resumeWorkspaceId,
            recoverable: true,
            cause: error instanceof Error ? error.message : String(error),
          }).pipe(this.runPromise);
          workspaceOpenResponse = await this.sendRequest(
            context,
            "thread/start",
            workspaceStartParams,
          );
        }
      } else {
        workspaceOpenMethod = "thread/start";
        workspaceOpenResponse = await this.sendRequest(
          context,
          "thread/start",
          workspaceStartParams,
        );
      }

      const workspaceOpenRecord = this.readObject(workspaceOpenResponse);
      const workspaceIdRaw = readExternalThreadId(workspaceOpenRecord);
      if (!workspaceIdRaw) {
        throw new Error(`${workspaceOpenMethod} response did not include a workspace id.`);
      }
      const providerWorkspaceId = workspaceIdRaw;

      this.updateSession(context, {
        status: "ready",
        resumeCursor: { workspaceId: providerWorkspaceId },
      });
      this.emitLifecycleEvent(
        context,
        "session/workspaceOpenResolved",
        `Codex ${workspaceOpenMethod} resolved.`,
      );
      await Effect.logInfo("codex app-server workspace open resolved", {
        workspaceId,
        workspaceOpenMethod,
        requestedResumeWorkspaceId: resumeWorkspaceId ?? null,
        resolvedWorkspaceId: providerWorkspaceId,
        requestedRuntimeMode: input.runtimeMode,
      }).pipe(this.runPromise);
      this.emitLifecycleEvent(
        context,
        "session/ready",
        `Connected to workspace ${providerWorkspaceId}`,
      );
      return { ...context.session };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start Codex session.";
      if (context) {
        this.updateSession(context, {
          status: "error",
          lastError: message,
        });
        this.emitErrorEvent(context, "session/startFailed", message);
        this.stopSession(workspaceId);
      } else {
        this.emitEvent({
          id: EventId.makeUnsafe(randomUUID()),
          kind: "error",
          provider: "codex",
          workspaceId,
          createdAt: new Date().toISOString(),
          method: "session/startFailed",
          message,
        });
      }
      throw new Error(message, { cause: error });
    }
  }

  async sendTurn(input: CodexAppServerSendTurnInput): Promise<ProviderTurnStartResult> {
    const context = this.requireSession(input.workspaceId);
    context.collabReceiverTurns.clear();

    const turnInput: Array<
      { type: "text"; text: string; text_elements: [] } | { type: "image"; url: string }
    > = [];
    if (input.input) {
      turnInput.push({
        type: "text",
        text: input.input,
        text_elements: [],
      });
    }
    for (const attachment of input.attachments ?? []) {
      if (attachment.type === "image") {
        turnInput.push({
          type: "image",
          url: attachment.url,
        });
      }
    }
    if (turnInput.length === 0) {
      throw new Error("Turn input must include text or attachments.");
    }

    const providerWorkspaceId = readResumeWorkspaceId({
      workspaceId: context.session.workspaceId,
      runtimeMode: context.session.runtimeMode,
      resumeCursor: context.session.resumeCursor,
    });
    if (!providerWorkspaceId) {
      throw new Error("Session is missing provider resume workspace id.");
    }
    const turnStartParams: {
      threadId: string;
      input: Array<
        { type: "text"; text: string; text_elements: [] } | { type: "image"; url: string }
      >;
      model?: string;
      serviceTier?: string | null;
      effort?: string;
      collaborationMode?: {
        mode: "default" | "plan";
        settings: {
          model: string;
          reasoning_effort: string;
          developer_instructions: string;
        };
      };
    } = {
      threadId: providerWorkspaceId,
      input: turnInput,
    };
    const normalizedModel = resolveCodexModelForAccount(
      normalizeCodexModelSlug(input.model ?? context.session.model),
      context.account,
    );
    if (normalizedModel) {
      turnStartParams.model = normalizedModel;
    }
    if (input.serviceTier !== undefined) {
      turnStartParams.serviceTier = input.serviceTier;
    }
    if (input.effort) {
      turnStartParams.effort = input.effort;
    }
    const collaborationMode = buildCodexCollaborationMode({
      ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
      ...(normalizedModel !== undefined ? { model: normalizedModel } : {}),
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
    });
    if (collaborationMode) {
      if (!turnStartParams.model) {
        turnStartParams.model = collaborationMode.settings.model;
      }
      turnStartParams.collaborationMode = collaborationMode;
    }

    const response = await this.sendRequest(context, "turn/start", turnStartParams);

    const turn = this.readObject(this.readObject(response), "turn");
    const turnIdRaw = this.readString(turn, "id");
    if (!turnIdRaw) {
      throw new Error("turn/start response did not include a turn id.");
    }
    const turnId = TurnId.makeUnsafe(turnIdRaw);

    this.updateSession(context, {
      status: "running",
      activeTurnId: turnId,
      ...(context.session.resumeCursor !== undefined
        ? { resumeCursor: context.session.resumeCursor }
        : {}),
    });

    return {
      workspaceId: context.session.workspaceId,
      turnId,
      ...(context.session.resumeCursor !== undefined
        ? { resumeCursor: context.session.resumeCursor }
        : {}),
    };
  }

  async interruptTurn(workspaceId: WorkspaceId, turnId?: TurnId): Promise<void> {
    const context = this.requireSession(workspaceId);
    const effectiveTurnId = turnId ?? context.session.activeTurnId;

    const providerWorkspaceId = readResumeWorkspaceId({
      workspaceId: context.session.workspaceId,
      runtimeMode: context.session.runtimeMode,
      resumeCursor: context.session.resumeCursor,
    });
    if (!effectiveTurnId || !providerWorkspaceId) {
      return;
    }

    await this.sendRequest(context, "turn/interrupt", {
      threadId: providerWorkspaceId,
      turnId: effectiveTurnId,
    });
  }

  async readWorkspace(workspaceId: WorkspaceId): Promise<CodexWorkspaceSnapshot> {
    const context = this.requireSession(workspaceId);
    const providerWorkspaceId = readResumeWorkspaceId({
      workspaceId: context.session.workspaceId,
      runtimeMode: context.session.runtimeMode,
      resumeCursor: context.session.resumeCursor,
    });
    if (!providerWorkspaceId) {
      throw new Error("Session is missing a provider resume workspace id.");
    }

    const response = await this.sendRequest(context, "thread/read", {
      threadId: providerWorkspaceId,
      includeTurns: true,
    });
    return this.parseWorkspaceSnapshot("thread/read", response);
  }

  async rollbackWorkspace(
    workspaceId: WorkspaceId,
    numTurns: number,
  ): Promise<CodexWorkspaceSnapshot> {
    const context = this.requireSession(workspaceId);
    const providerWorkspaceId = readResumeWorkspaceId({
      workspaceId: context.session.workspaceId,
      runtimeMode: context.session.runtimeMode,
      resumeCursor: context.session.resumeCursor,
    });
    if (!providerWorkspaceId) {
      throw new Error("Session is missing a provider resume workspace id.");
    }
    if (!Number.isInteger(numTurns) || numTurns < 1) {
      throw new Error("numTurns must be an integer >= 1.");
    }

    const response = await this.sendRequest(context, "thread/rollback", {
      threadId: providerWorkspaceId,
      numTurns,
    });
    this.updateSession(context, {
      status: "ready",
      activeTurnId: undefined,
    });
    return this.parseWorkspaceSnapshot("thread/rollback", response);
  }

  async respondToRequest(
    workspaceId: WorkspaceId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ): Promise<void> {
    const context = this.requireSession(workspaceId);
    const pendingRequest = context.pendingApprovals.get(requestId);
    if (!pendingRequest) {
      throw new Error(`Unknown pending approval request: ${requestId}`);
    }

    context.pendingApprovals.delete(requestId);
    this.writeMessage(context, {
      id: pendingRequest.jsonRpcId,
      result: {
        decision,
      },
    });

    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "notification",
      provider: "codex",
      workspaceId: context.session.workspaceId,
      createdAt: new Date().toISOString(),
      method: "item/requestApproval/decision",
      turnId: pendingRequest.turnId,
      itemId: pendingRequest.itemId,
      requestId: pendingRequest.requestId,
      requestKind: pendingRequest.requestKind,
      payload: {
        requestId: pendingRequest.requestId,
        requestKind: pendingRequest.requestKind,
        decision,
      },
    });
  }

  async respondToUserInput(
    workspaceId: WorkspaceId,
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ): Promise<void> {
    const context = this.requireSession(workspaceId);
    const pendingRequest = context.pendingUserInputs.get(requestId);
    if (!pendingRequest) {
      throw new Error(`Unknown pending user input request: ${requestId}`);
    }

    context.pendingUserInputs.delete(requestId);
    const codexAnswers = toCodexUserInputAnswers(answers);
    this.writeMessage(context, {
      id: pendingRequest.jsonRpcId,
      result: {
        answers: codexAnswers,
      },
    });

    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "notification",
      provider: "codex",
      workspaceId: context.session.workspaceId,
      createdAt: new Date().toISOString(),
      method: "item/tool/requestUserInput/answered",
      turnId: pendingRequest.turnId,
      itemId: pendingRequest.itemId,
      requestId: pendingRequest.requestId,
      payload: {
        requestId: pendingRequest.requestId,
        answers: codexAnswers,
      },
    });
  }

  stopSession(workspaceId: WorkspaceId): void {
    const context = this.sessions.get(workspaceId);
    if (!context) {
      return;
    }

    context.stopping = true;

    for (const pending of context.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Session stopped before request completed."));
    }
    context.pending.clear();
    context.pendingApprovals.clear();
    context.pendingUserInputs.clear();

    context.output.close();

    if (!context.child.killed) {
      killChildTree(context.child);
    }

    this.updateSession(context, {
      status: "closed",
      activeTurnId: undefined,
    });
    this.emitLifecycleEvent(context, "session/closed", "Session stopped");
    this.sessions.delete(workspaceId);
  }

  listSessions(): ProviderSession[] {
    return Array.from(this.sessions.values(), ({ session }) => ({
      ...session,
    }));
  }

  hasSession(workspaceId: WorkspaceId): boolean {
    return this.sessions.has(workspaceId);
  }

  stopAll(): void {
    for (const workspaceId of this.sessions.keys()) {
      this.stopSession(workspaceId);
    }
  }

  private requireSession(workspaceId: WorkspaceId): CodexSessionContext {
    const context = this.sessions.get(workspaceId);
    if (!context) {
      throw new Error(`Unknown session for workspace: ${workspaceId}`);
    }

    if (context.session.status === "closed") {
      throw new Error(`Session is closed for workspace: ${workspaceId}`);
    }

    return context;
  }

  private attachProcessListeners(context: CodexSessionContext): void {
    context.output.on("line", (line) => {
      this.handleStdoutLine(context, line);
    });

    context.child.stderr.on("data", (chunk: Buffer) => {
      const raw = chunk.toString();
      const lines = raw.split(/\r?\n/g);
      for (const rawLine of lines) {
        const classified = classifyCodexStderrLine(rawLine);
        if (!classified) {
          continue;
        }

        this.emitNotificationEvent(context, "process/stderr", classified.message);
      }
    });

    context.child.on("error", (error) => {
      const message = error.message || "codex app-server process errored.";
      this.updateSession(context, {
        status: "error",
        lastError: message,
      });
      this.emitErrorEvent(context, "process/error", message);
    });

    context.child.on("exit", (code, signal) => {
      if (context.stopping) {
        return;
      }

      const message = `codex app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"}).`;
      this.updateSession(context, {
        status: "closed",
        activeTurnId: undefined,
        lastError: code === 0 ? context.session.lastError : message,
      });
      this.emitLifecycleEvent(context, "session/exited", message);
      this.sessions.delete(context.session.workspaceId);
    });
  }

  private handleStdoutLine(context: CodexSessionContext, line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.emitErrorEvent(
        context,
        "protocol/parseError",
        "Received invalid JSON from codex app-server.",
      );
      return;
    }

    if (!parsed || typeof parsed !== "object") {
      this.emitErrorEvent(
        context,
        "protocol/invalidMessage",
        "Received non-object protocol message.",
      );
      return;
    }

    if (this.isServerRequest(parsed)) {
      this.handleServerRequest(context, parsed);
      return;
    }

    if (this.isServerNotification(parsed)) {
      this.handleServerNotification(context, parsed);
      return;
    }

    if (this.isResponse(parsed)) {
      this.handleResponse(context, parsed);
      return;
    }

    this.emitErrorEvent(
      context,
      "protocol/unrecognizedMessage",
      "Received protocol message in an unknown shape.",
    );
  }

  private handleServerNotification(
    context: CodexSessionContext,
    notification: JsonRpcNotification,
  ): void {
    const rawRoute = this.readRouteFields(notification.params);
    this.rememberCollabReceiverTurns(context, notification.params, rawRoute.turnId);
    const childParentTurnId = this.readChildParentTurnId(context, notification.params);
    const isChildConversation = childParentTurnId !== undefined;
    if (
      isChildConversation &&
      this.shouldSuppressChildConversationNotification(notification.method)
    ) {
      return;
    }
    const textDelta =
      notification.method === "item/agentMessage/delta"
        ? this.readString(notification.params, "delta")
        : undefined;

    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "notification",
      provider: "codex",
      workspaceId: context.session.workspaceId,
      createdAt: new Date().toISOString(),
      method: notification.method,
      ...((childParentTurnId ?? rawRoute.turnId)
        ? { turnId: childParentTurnId ?? rawRoute.turnId }
        : {}),
      ...(rawRoute.itemId ? { itemId: rawRoute.itemId } : {}),
      textDelta,
      payload: notification.params,
    });

    if (notification.method === "thread/started") {
      const providerWorkspaceId = normalizeProviderWorkspaceId(
        readExternalThreadId(this.readObject(notification.params)),
      );
      if (providerWorkspaceId) {
        this.updateSession(context, { resumeCursor: { workspaceId: providerWorkspaceId } });
      }
      return;
    }

    if (notification.method === "turn/started") {
      if (isChildConversation) {
        return;
      }
      const turnId = toTurnId(this.readString(this.readObject(notification.params)?.turn, "id"));
      this.updateSession(context, {
        status: "running",
        activeTurnId: turnId,
      });
      return;
    }

    if (notification.method === "turn/completed") {
      if (isChildConversation) {
        return;
      }
      context.collabReceiverTurns.clear();
      const turn = this.readObject(notification.params, "turn");
      const status = this.readString(turn, "status");
      const errorMessage = this.readString(this.readObject(turn, "error"), "message");
      this.updateSession(context, {
        status: status === "failed" ? "error" : "ready",
        activeTurnId: undefined,
        lastError: errorMessage ?? context.session.lastError,
      });
      return;
    }

    if (notification.method === "error") {
      if (isChildConversation) {
        return;
      }
      const message = this.readString(this.readObject(notification.params)?.error, "message");
      const willRetry = this.readBoolean(notification.params, "willRetry");

      this.updateSession(context, {
        status: willRetry ? "running" : "error",
        lastError: message ?? context.session.lastError,
      });
    }
  }

  private handleServerRequest(context: CodexSessionContext, request: JsonRpcRequest): void {
    const rawRoute = this.readRouteFields(request.params);
    const childParentTurnId = this.readChildParentTurnId(context, request.params);
    const effectiveTurnId = childParentTurnId ?? rawRoute.turnId;
    const requestKind = this.requestKindForMethod(request.method);
    let requestId: ApprovalRequestId | undefined;
    if (requestKind) {
      requestId = ApprovalRequestId.makeUnsafe(randomUUID());
      const pendingRequest: PendingApprovalRequest = {
        requestId,
        jsonRpcId: request.id,
        method:
          requestKind === "command"
            ? "item/commandExecution/requestApproval"
            : requestKind === "file-read"
              ? "item/fileRead/requestApproval"
              : "item/fileChange/requestApproval",
        requestKind,
        workspaceId: context.session.workspaceId,
        ...(effectiveTurnId ? { turnId: effectiveTurnId } : {}),
        ...(rawRoute.itemId ? { itemId: rawRoute.itemId } : {}),
      };
      context.pendingApprovals.set(requestId, pendingRequest);
    }

    if (request.method === "item/tool/requestUserInput") {
      requestId = ApprovalRequestId.makeUnsafe(randomUUID());
      context.pendingUserInputs.set(requestId, {
        requestId,
        jsonRpcId: request.id,
        workspaceId: context.session.workspaceId,
        ...(effectiveTurnId ? { turnId: effectiveTurnId } : {}),
        ...(rawRoute.itemId ? { itemId: rawRoute.itemId } : {}),
      });
    }

    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "request",
      provider: "codex",
      workspaceId: context.session.workspaceId,
      createdAt: new Date().toISOString(),
      method: request.method,
      ...(effectiveTurnId ? { turnId: effectiveTurnId } : {}),
      ...(rawRoute.itemId ? { itemId: rawRoute.itemId } : {}),
      requestId,
      requestKind,
      payload: request.params,
    });

    if (requestKind) {
      return;
    }

    if (request.method === "item/tool/requestUserInput") {
      return;
    }

    this.writeMessage(context, {
      id: request.id,
      error: {
        code: -32601,
        message: `Unsupported server request: ${request.method}`,
      },
    });
  }

  private handleResponse(context: CodexSessionContext, response: JsonRpcResponse): void {
    const key = String(response.id);
    const pending = context.pending.get(key);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    context.pending.delete(key);

    if (response.error?.message) {
      pending.reject(new Error(`${pending.method} failed: ${String(response.error.message)}`));
      return;
    }

    pending.resolve(response.result);
  }

  private async sendRequest<TResponse>(
    context: CodexSessionContext,
    method: string,
    params: unknown,
    timeoutMs = 20_000,
  ): Promise<TResponse> {
    const id = context.nextRequestId;
    context.nextRequestId += 1;

    const result = await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        context.pending.delete(String(id));
        reject(new Error(`Timed out waiting for ${method}.`));
      }, timeoutMs);

      context.pending.set(String(id), {
        method,
        timeout,
        resolve,
        reject,
      });
      this.writeMessage(context, {
        method,
        id,
        params,
      });
    });

    return result as TResponse;
  }

  private writeMessage(context: CodexSessionContext, message: unknown): void {
    const encoded = JSON.stringify(message);
    if (!context.child.stdin.writable) {
      throw new Error("Cannot write to codex app-server stdin.");
    }

    context.child.stdin.write(`${encoded}\n`);
  }

  private emitLifecycleEvent(context: CodexSessionContext, method: string, message: string): void {
    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "session",
      provider: "codex",
      workspaceId: context.session.workspaceId,
      createdAt: new Date().toISOString(),
      method,
      message,
    });
  }

  private emitErrorEvent(context: CodexSessionContext, method: string, message: string): void {
    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "error",
      provider: "codex",
      workspaceId: context.session.workspaceId,
      createdAt: new Date().toISOString(),
      method,
      message,
    });
  }

  private emitNotificationEvent(
    context: CodexSessionContext,
    method: string,
    message: string,
  ): void {
    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "notification",
      provider: "codex",
      workspaceId: context.session.workspaceId,
      createdAt: new Date().toISOString(),
      method,
      message,
    });
  }

  private emitEvent(event: ProviderEvent): void {
    this.emit("event", event);
  }

  private assertSupportedCodexCliVersion(input: {
    readonly binaryPath: string;
    readonly cwd: string;
    readonly homePath?: string;
  }): void {
    assertSupportedCodexCliVersion(input);
  }

  private updateSession(context: CodexSessionContext, updates: Partial<ProviderSession>): void {
    context.session = {
      ...context.session,
      ...updates,
      updatedAt: new Date().toISOString(),
    };
  }

  private requestKindForMethod(method: string): ProviderRequestKind | undefined {
    if (method === "item/commandExecution/requestApproval") {
      return "command";
    }

    if (method === "item/fileRead/requestApproval") {
      return "file-read";
    }

    if (method === "item/fileChange/requestApproval") {
      return "file-change";
    }

    return undefined;
  }

  private parseWorkspaceSnapshot(method: string, response: unknown): CodexWorkspaceSnapshot {
    const responseRecord = this.readObject(response);
    const workspace =
      this.readObject(responseRecord, "thread") ?? this.readObject(responseRecord, "workspace");
    const workspaceIdRaw = readExternalThreadId(responseRecord);
    if (!workspaceIdRaw) {
      throw new Error(`${method} response did not include a workspace id.`);
    }
    const turnsRaw =
      this.readArray(workspace, "turns") ?? this.readArray(responseRecord, "turns") ?? [];
    const turns = turnsRaw.map((turnValue, index) => {
      const turn = this.readObject(turnValue);
      const turnIdRaw = this.readString(turn, "id") ?? `${workspaceIdRaw}:turn:${index + 1}`;
      const turnId = TurnId.makeUnsafe(turnIdRaw);
      const items = this.readArray(turn, "items") ?? [];
      return {
        id: turnId,
        items,
      };
    });

    return {
      workspaceId: workspaceIdRaw,
      turns,
    };
  }

  private isServerRequest(value: unknown): value is JsonRpcRequest {
    if (!value || typeof value !== "object") {
      return false;
    }

    const candidate = value as Record<string, unknown>;
    return (
      typeof candidate.method === "string" &&
      (typeof candidate.id === "string" || typeof candidate.id === "number")
    );
  }

  private isServerNotification(value: unknown): value is JsonRpcNotification {
    if (!value || typeof value !== "object") {
      return false;
    }

    const candidate = value as Record<string, unknown>;
    return typeof candidate.method === "string" && !("id" in candidate);
  }

  private isResponse(value: unknown): value is JsonRpcResponse {
    if (!value || typeof value !== "object") {
      return false;
    }

    const candidate = value as Record<string, unknown>;
    const hasId = typeof candidate.id === "string" || typeof candidate.id === "number";
    const hasMethod = typeof candidate.method === "string";
    return hasId && !hasMethod;
  }

  private readRouteFields(params: unknown): {
    turnId?: TurnId;
    itemId?: ProviderItemId;
  } {
    const route: {
      turnId?: TurnId;
      itemId?: ProviderItemId;
    } = {};

    const turnId = toTurnId(
      this.readString(params, "turnId") ?? this.readString(this.readObject(params, "turn"), "id"),
    );
    const itemId = toProviderItemId(
      this.readString(params, "itemId") ?? this.readString(this.readObject(params, "item"), "id"),
    );

    if (turnId) {
      route.turnId = turnId;
    }

    if (itemId) {
      route.itemId = itemId;
    }

    return route;
  }

  private readProviderConversationId(params: unknown): string | undefined {
    return (
      this.readString(params, "threadId") ??
      this.readString(this.readObject(params, "thread"), "id") ??
      this.readString(params, "workspaceId") ??
      this.readString(this.readObject(params, "workspace"), "id") ??
      this.readString(params, "conversationId")
    );
  }

  private readChildParentTurnId(context: CodexSessionContext, params: unknown): TurnId | undefined {
    const providerConversationId = this.readProviderConversationId(params);
    if (!providerConversationId) {
      return undefined;
    }
    return context.collabReceiverTurns.get(providerConversationId);
  }

  private rememberCollabReceiverTurns(
    context: CodexSessionContext,
    params: unknown,
    parentTurnId: TurnId | undefined,
  ): void {
    if (!parentTurnId) {
      return;
    }
    const payload = this.readObject(params);
    const item = this.readObject(payload, "item") ?? payload;
    const itemType = this.readString(item, "type") ?? this.readString(item, "kind");
    if (itemType !== "collabAgentToolCall") {
      return;
    }

    const receiverWorkspaceIds =
      this.readArray(item, "receiverWorkspaceIds")
        ?.map((value) => (typeof value === "string" ? value : null))
        .filter((value): value is string => value !== null) ?? [];
    for (const receiverWorkspaceId of receiverWorkspaceIds) {
      context.collabReceiverTurns.set(receiverWorkspaceId, parentTurnId);
    }
  }

  private shouldSuppressChildConversationNotification(method: string): boolean {
    return (
      method === "thread/started" ||
      method === "thread/status/changed" ||
      method === "thread/archived" ||
      method === "thread/unarchived" ||
      method === "thread/closed" ||
      method === "thread/compacted" ||
      method === "thread/name/updated" ||
      method === "thread/tokenUsage/updated" ||
      method === "turn/started" ||
      method === "turn/completed" ||
      method === "turn/aborted" ||
      method === "turn/plan/updated" ||
      method === "item/plan/delta"
    );
  }

  private readObject(value: unknown, key?: string): Record<string, unknown> | undefined {
    const target =
      key === undefined
        ? value
        : value && typeof value === "object"
          ? (value as Record<string, unknown>)[key]
          : undefined;

    if (!target || typeof target !== "object") {
      return undefined;
    }

    return target as Record<string, unknown>;
  }

  private readArray(value: unknown, key?: string): unknown[] | undefined {
    const target =
      key === undefined
        ? value
        : value && typeof value === "object"
          ? (value as Record<string, unknown>)[key]
          : undefined;
    return Array.isArray(target) ? target : undefined;
  }

  private readString(value: unknown, key: string): string | undefined {
    if (!value || typeof value !== "object") {
      return undefined;
    }

    const candidate = (value as Record<string, unknown>)[key];
    return typeof candidate === "string" ? candidate : undefined;
  }

  private readBoolean(value: unknown, key: string): boolean | undefined {
    if (!value || typeof value !== "object") {
      return undefined;
    }

    const candidate = (value as Record<string, unknown>)[key];
    return typeof candidate === "boolean" ? candidate : undefined;
  }
}

function brandIfNonEmpty<T extends string>(
  value: string | undefined,
  maker: (value: string) => T,
): T | undefined {
  const normalized = value?.trim();
  return normalized?.length ? maker(normalized) : undefined;
}

function normalizeProviderWorkspaceId(value: string | undefined): string | undefined {
  return brandIfNonEmpty(value, (normalized) => normalized);
}

function assertSupportedCodexCliVersion(input: {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly homePath?: string;
}): void {
  const result = spawnSync(input.binaryPath, ["--version"], {
    cwd: input.cwd,
    env: {
      ...process.env,
      ...(input.homePath ? { CODEX_HOME: input.homePath } : {}),
    },
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: CODEX_VERSION_CHECK_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });

  if (result.error) {
    const lower = result.error.message.toLowerCase();
    if (
      lower.includes("enoent") ||
      lower.includes("command not found") ||
      lower.includes("not found")
    ) {
      throw new Error(`Codex CLI (${input.binaryPath}) is not installed or not executable.`);
    }
    throw new Error(
      `Failed to execute Codex CLI version check: ${result.error.message || String(result.error)}`,
    );
  }

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (result.status !== 0) {
    const detail = stderr.trim() || stdout.trim() || `Command exited with code ${result.status}.`;
    throw new Error(`Codex CLI version check failed. ${detail}`);
  }

  const parsedVersion = parseCodexCliVersion(`${stdout}\n${stderr}`);
  if (parsedVersion && !isCodexCliVersionSupported(parsedVersion)) {
    throw new Error(formatCodexCliUpgradeMessage(parsedVersion));
  }
}

function readResumeCursorWorkspaceId(resumeCursor: unknown): string | undefined {
  if (!resumeCursor || typeof resumeCursor !== "object" || Array.isArray(resumeCursor)) {
    return undefined;
  }
  const rawWorkspaceId = (resumeCursor as Record<string, unknown>).workspaceId;
  return typeof rawWorkspaceId === "string"
    ? normalizeProviderWorkspaceId(rawWorkspaceId)
    : undefined;
}

function readResumeWorkspaceId(input: {
  readonly resumeCursor?: unknown;
  readonly workspaceId?: WorkspaceId;
  readonly runtimeMode?: RuntimeMode;
}): string | undefined {
  return readResumeCursorWorkspaceId(input.resumeCursor);
}

function toTurnId(value: string | undefined): TurnId | undefined {
  return brandIfNonEmpty(value, TurnId.makeUnsafe);
}

function toProviderItemId(value: string | undefined): ProviderItemId | undefined {
  return brandIfNonEmpty(value, ProviderItemId.makeUnsafe);
}
