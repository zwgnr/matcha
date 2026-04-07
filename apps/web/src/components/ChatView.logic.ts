import { ProjectId, type ModelSelection, type WorkspaceId, type TurnId } from "@matcha/contracts";
import {
  type ChatMessage,
  type SessionPhase,
  type Workspace,
  type WorkspaceSession,
} from "../types";
import { type ComposerImageAttachment, type DraftWorkspaceState } from "../composerDraftStore";
import { Schema } from "effect";
import { useStore } from "../store";
import {
  filterTerminalContextsWithText,
  stripInlineTerminalContextPlaceholders,
  type TerminalContextDraft,
} from "../lib/terminalContext";

export const LAST_INVOKED_SCRIPT_BY_PROJECT_KEY = "matcha:last-invoked-script-by-project";
export const MAX_HIDDEN_MOUNTED_TERMINAL_WORKSPACES = 10;

export const LastInvokedScriptByProjectSchema = Schema.Record(ProjectId, Schema.String);

export function buildLocalDraftWorkspace(
  workspaceId: WorkspaceId,
  draftWorkspace: DraftWorkspaceState,
  fallbackModelSelection: ModelSelection,
  error: string | null,
): Workspace {
  return {
    id: workspaceId,
    codexWorkspaceId: null,
    projectId: draftWorkspace.projectId,
    title: "New workspace",
    modelSelection: fallbackModelSelection,
    runtimeMode: draftWorkspace.runtimeMode,
    interactionMode: draftWorkspace.interactionMode,
    session: null,
    messages: [],
    error,
    createdAt: draftWorkspace.createdAt,
    archivedAt: null,
    latestTurn: null,
    branch: draftWorkspace.branch,
    worktreePath: draftWorkspace.worktreePath,
    turnDiffSummaries: [],
    activities: [],
    proposedPlans: [],
  };
}

export function reconcileMountedTerminalWorkspaceIds(input: {
  currentWorkspaceIds: ReadonlyArray<WorkspaceId>;
  openWorkspaceIds: ReadonlyArray<WorkspaceId>;
  activeWorkspaceId: WorkspaceId | null;
  activeWorkspaceTerminalOpen: boolean;
  maxHiddenWorkspaceCount?: number;
}): WorkspaceId[] {
  const openWorkspaceIdSet = new Set(input.openWorkspaceIds);
  const hiddenWorkspaceIds = input.currentWorkspaceIds.filter(
    (workspaceId) => workspaceId !== input.activeWorkspaceId && openWorkspaceIdSet.has(workspaceId),
  );
  const maxHiddenWorkspaceCount = Math.max(
    0,
    input.maxHiddenWorkspaceCount ?? MAX_HIDDEN_MOUNTED_TERMINAL_WORKSPACES,
  );
  const nextWorkspaceIds =
    hiddenWorkspaceIds.length > maxHiddenWorkspaceCount
      ? hiddenWorkspaceIds.slice(-maxHiddenWorkspaceCount)
      : hiddenWorkspaceIds;

  if (
    input.activeWorkspaceId &&
    input.activeWorkspaceTerminalOpen &&
    !nextWorkspaceIds.includes(input.activeWorkspaceId)
  ) {
    nextWorkspaceIds.push(input.activeWorkspaceId);
  }

  return nextWorkspaceIds;
}

export function revokeBlobPreviewUrl(previewUrl: string | undefined): void {
  if (!previewUrl || typeof URL === "undefined" || !previewUrl.startsWith("blob:")) {
    return;
  }
  URL.revokeObjectURL(previewUrl);
}

export function revokeUserMessagePreviewUrls(message: ChatMessage): void {
  if (message.role !== "user" || !message.attachments) {
    return;
  }
  for (const attachment of message.attachments) {
    if (attachment.type !== "image") {
      continue;
    }
    revokeBlobPreviewUrl(attachment.previewUrl);
  }
}

export function collectUserMessageBlobPreviewUrls(message: ChatMessage): string[] {
  if (message.role !== "user" || !message.attachments) {
    return [];
  }
  const previewUrls: string[] = [];
  for (const attachment of message.attachments) {
    if (attachment.type !== "image") continue;
    if (!attachment.previewUrl || !attachment.previewUrl.startsWith("blob:")) continue;
    previewUrls.push(attachment.previewUrl);
  }
  return previewUrls;
}

export interface PullRequestDialogState {
  initialReference: string | null;
  key: number;
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("Could not read image data."));
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("Failed to read image."));
    });
    reader.readAsDataURL(file);
  });
}

export function cloneComposerImageForRetry(
  image: ComposerImageAttachment,
): ComposerImageAttachment {
  if (typeof URL === "undefined" || !image.previewUrl.startsWith("blob:")) {
    return image;
  }
  try {
    return {
      ...image,
      previewUrl: URL.createObjectURL(image.file),
    };
  } catch {
    return image;
  }
}

export function deriveComposerSendState(options: {
  prompt: string;
  imageCount: number;
  terminalContexts: ReadonlyArray<TerminalContextDraft>;
}): {
  trimmedPrompt: string;
  sendableTerminalContexts: TerminalContextDraft[];
  expiredTerminalContextCount: number;
  hasSendableContent: boolean;
} {
  const trimmedPrompt = stripInlineTerminalContextPlaceholders(options.prompt).trim();
  const sendableTerminalContexts = filterTerminalContextsWithText(options.terminalContexts);
  const expiredTerminalContextCount =
    options.terminalContexts.length - sendableTerminalContexts.length;
  return {
    trimmedPrompt,
    sendableTerminalContexts,
    expiredTerminalContextCount,
    hasSendableContent:
      trimmedPrompt.length > 0 || options.imageCount > 0 || sendableTerminalContexts.length > 0,
  };
}

export function buildExpiredTerminalContextToastCopy(
  expiredTerminalContextCount: number,
  variant: "omitted" | "empty",
): { title: string; description: string } {
  const count = Math.max(1, Math.floor(expiredTerminalContextCount));
  const noun = count === 1 ? "Expired terminal context" : "Expired terminal contexts";
  if (variant === "empty") {
    return {
      title: `${noun} won't be sent`,
      description: "Remove it or re-add it to include terminal output.",
    };
  }
  return {
    title: `${noun} omitted from message`,
    description: "Re-add it if you want that terminal output included.",
  };
}

export function workspaceHasStarted(workspace: Workspace | null | undefined): boolean {
  return Boolean(
    workspace &&
    (workspace.latestTurn !== null || workspace.messages.length > 0 || workspace.session !== null),
  );
}

export async function waitForStartedServerWorkspace(
  workspaceId: WorkspaceId,
  timeoutMs = 1_000,
): Promise<boolean> {
  const getWorkspace = () =>
    useStore.getState().workspaces.find((workspace) => workspace.id === workspaceId);
  const workspace = getWorkspace();

  if (workspaceHasStarted(workspace)) {
    return true;
  }

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
    const finish = (result: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId !== null) {
        globalThis.clearTimeout(timeoutId);
      }
      unsubscribe();
      resolve(result);
    };

    const unsubscribe = useStore.subscribe((state) => {
      if (
        !workspaceHasStarted(state.workspaces.find((workspace) => workspace.id === workspaceId))
      ) {
        return;
      }
      finish(true);
    });

    if (workspaceHasStarted(getWorkspace())) {
      finish(true);
      return;
    }

    timeoutId = globalThis.setTimeout(() => {
      finish(false);
    }, timeoutMs);
  });
}

export interface LocalDispatchSnapshot {
  startedAt: string;
  preparingWorktree: boolean;
  latestTurnTurnId: TurnId | null;
  latestTurnRequestedAt: string | null;
  latestTurnStartedAt: string | null;
  latestTurnCompletedAt: string | null;
  sessionOrchestrationStatus: WorkspaceSession["orchestrationStatus"] | null;
  sessionUpdatedAt: string | null;
}

export function createLocalDispatchSnapshot(
  activeWorkspace: Workspace | undefined,
  options?: { preparingWorktree?: boolean },
): LocalDispatchSnapshot {
  const latestTurn = activeWorkspace?.latestTurn ?? null;
  const session = activeWorkspace?.session ?? null;
  return {
    startedAt: new Date().toISOString(),
    preparingWorktree: Boolean(options?.preparingWorktree),
    latestTurnTurnId: latestTurn?.turnId ?? null,
    latestTurnRequestedAt: latestTurn?.requestedAt ?? null,
    latestTurnStartedAt: latestTurn?.startedAt ?? null,
    latestTurnCompletedAt: latestTurn?.completedAt ?? null,
    sessionOrchestrationStatus: session?.orchestrationStatus ?? null,
    sessionUpdatedAt: session?.updatedAt ?? null,
  };
}

export function hasServerAcknowledgedLocalDispatch(input: {
  localDispatch: LocalDispatchSnapshot | null;
  phase: SessionPhase;
  latestTurn: Workspace["latestTurn"] | null;
  session: Workspace["session"] | null;
  hasPendingApproval: boolean;
  hasPendingUserInput: boolean;
  workspaceError: string | null | undefined;
}): boolean {
  if (!input.localDispatch) {
    return false;
  }
  if (
    input.phase === "running" ||
    input.hasPendingApproval ||
    input.hasPendingUserInput ||
    Boolean(input.workspaceError)
  ) {
    return true;
  }

  const latestTurn = input.latestTurn ?? null;
  const session = input.session ?? null;

  return (
    input.localDispatch.latestTurnTurnId !== (latestTurn?.turnId ?? null) ||
    input.localDispatch.latestTurnRequestedAt !== (latestTurn?.requestedAt ?? null) ||
    input.localDispatch.latestTurnStartedAt !== (latestTurn?.startedAt ?? null) ||
    input.localDispatch.latestTurnCompletedAt !== (latestTurn?.completedAt ?? null) ||
    input.localDispatch.sessionOrchestrationStatus !== (session?.orchestrationStatus ?? null) ||
    input.localDispatch.sessionUpdatedAt !== (session?.updatedAt ?? null)
  );
}
