import {
  CODEX_REASONING_EFFORT_OPTIONS,
  type ClaudeCodeEffort,
  type CodexReasoningEffort,
  DEFAULT_MODEL_BY_PROVIDER,
  ModelSelection,
  ProjectId,
  ProviderInteractionMode,
  ProviderKind,
  ProviderModelOptions,
  RuntimeMode,
  type ServerProvider,
  WorkspaceId,
} from "@matcha/contracts";
import * as Schema from "effect/Schema";
import * as Equal from "effect/Equal";
import { DeepMutable } from "effect/Types";
import { normalizeModelSlug } from "@matcha/shared/model";
import { useMemo } from "react";
import { getLocalStorageItem } from "./hooks/useLocalStorage";
import { resolveAppModelSelection } from "./modelSelection";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type ChatImageAttachment } from "./types";
import {
  type TerminalContextDraft,
  ensureInlineTerminalContextPlaceholders,
  normalizeTerminalContextText,
} from "./lib/terminalContext";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { createDebouncedStorage, createMemoryStorage } from "./lib/storage";
import { getDefaultServerModel } from "./providerModels";
import { UnifiedSettings } from "@matcha/contracts/settings";

export const COMPOSER_DRAFT_STORAGE_KEY = "matcha:composer-drafts:v1";
const COMPOSER_DRAFT_STORAGE_VERSION = 3;
const DraftWorkspaceEnvModeSchema = Schema.Literals(["local", "worktree"]);
export type DraftWorkspaceEnvMode = typeof DraftWorkspaceEnvModeSchema.Type;

const COMPOSER_PERSIST_DEBOUNCE_MS = 300;

const composerDebouncedStorage = createDebouncedStorage(
  typeof localStorage !== "undefined" ? localStorage : createMemoryStorage(),
  COMPOSER_PERSIST_DEBOUNCE_MS,
);

// Flush pending composer draft writes before page unload to prevent data loss.
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    composerDebouncedStorage.flush();
  });
}

export const PersistedComposerImageAttachment = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  dataUrl: Schema.String,
});
export type PersistedComposerImageAttachment = typeof PersistedComposerImageAttachment.Type;

export interface ComposerImageAttachment extends Omit<ChatImageAttachment, "previewUrl"> {
  previewUrl: string;
  file: File;
}

const PersistedTerminalContextDraft = Schema.Struct({
  id: Schema.String,
  workspaceId: WorkspaceId,
  createdAt: Schema.String,
  terminalId: Schema.String,
  terminalLabel: Schema.String,
  lineStart: Schema.Number,
  lineEnd: Schema.Number,
});
type PersistedTerminalContextDraft = typeof PersistedTerminalContextDraft.Type;

const PersistedComposerWorkspaceDraftState = Schema.Struct({
  prompt: Schema.String,
  attachments: Schema.Array(PersistedComposerImageAttachment),
  terminalContexts: Schema.optionalKey(Schema.Array(PersistedTerminalContextDraft)),
  modelSelectionByProvider: Schema.optionalKey(
    Schema.Record(ProviderKind, Schema.optionalKey(ModelSelection)),
  ),
  activeProvider: Schema.optionalKey(Schema.NullOr(ProviderKind)),
  runtimeMode: Schema.optionalKey(RuntimeMode),
  interactionMode: Schema.optionalKey(ProviderInteractionMode),
});
type PersistedComposerWorkspaceDraftState = typeof PersistedComposerWorkspaceDraftState.Type;

const LegacyCodexFields = Schema.Struct({
  effort: Schema.optionalKey(Schema.Literals(CODEX_REASONING_EFFORT_OPTIONS)),
  codexFastMode: Schema.optionalKey(Schema.Boolean),
  serviceTier: Schema.optionalKey(Schema.String),
});
type LegacyCodexFields = typeof LegacyCodexFields.Type;

const LegacyWorkspaceModelFields = Schema.Struct({
  provider: Schema.optionalKey(ProviderKind),
  model: Schema.optionalKey(Schema.String),
  modelOptions: Schema.optionalKey(Schema.NullOr(ProviderModelOptions)),
});
type LegacyWorkspaceModelFields = typeof LegacyWorkspaceModelFields.Type;

type LegacyV2WorkspaceDraftFields = {
  modelSelection?: ModelSelection | null;
  modelOptions?: ProviderModelOptions | null;
};

type LegacyPersistedComposerWorkspaceDraftState = PersistedComposerWorkspaceDraftState &
  LegacyCodexFields &
  LegacyWorkspaceModelFields &
  LegacyV2WorkspaceDraftFields;

const LegacyStickyModelFields = Schema.Struct({
  stickyProvider: Schema.optionalKey(ProviderKind),
  stickyModel: Schema.optionalKey(Schema.String),
  stickyModelOptions: Schema.optionalKey(Schema.NullOr(ProviderModelOptions)),
});
type LegacyStickyModelFields = typeof LegacyStickyModelFields.Type;

type LegacyV2StoreFields = {
  stickyModelSelection?: ModelSelection | null;
  stickyModelOptions?: ProviderModelOptions | null;
};

type LegacyPersistedComposerDraftStoreState = PersistedComposerDraftStoreState &
  LegacyStickyModelFields &
  LegacyV2StoreFields;

const PersistedDraftWorkspaceState = Schema.Struct({
  projectId: ProjectId,
  createdAt: Schema.String,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  envMode: DraftWorkspaceEnvModeSchema,
});
type PersistedDraftWorkspaceState = typeof PersistedDraftWorkspaceState.Type;

const PersistedComposerDraftStoreState = Schema.Struct({
  draftsByWorkspaceId: Schema.Record(WorkspaceId, PersistedComposerWorkspaceDraftState),
  draftWorkspacesByWorkspaceId: Schema.Record(WorkspaceId, PersistedDraftWorkspaceState),
  projectDraftWorkspaceIdByProjectId: Schema.Record(ProjectId, WorkspaceId),
  stickyModelSelectionByProvider: Schema.optionalKey(
    Schema.Record(ProviderKind, Schema.optionalKey(ModelSelection)),
  ),
  stickyActiveProvider: Schema.optionalKey(Schema.NullOr(ProviderKind)),
});
type PersistedComposerDraftStoreState = typeof PersistedComposerDraftStoreState.Type;

const PersistedComposerDraftStoreStorage = Schema.Struct({
  version: Schema.Number,
  state: PersistedComposerDraftStoreState,
});

export interface ComposerWorkspaceDraftState {
  prompt: string;
  images: ComposerImageAttachment[];
  nonPersistedImageIds: string[];
  persistedAttachments: PersistedComposerImageAttachment[];
  terminalContexts: TerminalContextDraft[];
  modelSelectionByProvider: Partial<Record<ProviderKind, ModelSelection>>;
  activeProvider: ProviderKind | null;
  runtimeMode: RuntimeMode | null;
  interactionMode: ProviderInteractionMode | null;
}

export interface DraftWorkspaceState {
  projectId: ProjectId;
  createdAt: string;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  branch: string | null;
  worktreePath: string | null;
  envMode: DraftWorkspaceEnvMode;
}

interface ProjectDraftWorkspace extends DraftWorkspaceState {
  workspaceId: WorkspaceId;
}

interface ComposerDraftStoreState {
  draftsByWorkspaceId: Record<WorkspaceId, ComposerWorkspaceDraftState>;
  draftWorkspacesByWorkspaceId: Record<WorkspaceId, DraftWorkspaceState>;
  projectDraftWorkspaceIdByProjectId: Record<ProjectId, WorkspaceId>;
  stickyModelSelectionByProvider: Partial<Record<ProviderKind, ModelSelection>>;
  stickyActiveProvider: ProviderKind | null;
  getDraftWorkspaceByProjectId: (projectId: ProjectId) => ProjectDraftWorkspace | null;
  getDraftWorkspace: (workspaceId: WorkspaceId) => DraftWorkspaceState | null;
  upsertDraftWorkspace: (
    workspaceId: WorkspaceId,
    input: {
      projectId: ProjectId;
      branch?: string | null;
      worktreePath?: string | null;
      createdAt?: string;
      envMode?: DraftWorkspaceEnvMode;
      runtimeMode?: RuntimeMode;
      interactionMode?: ProviderInteractionMode;
    },
  ) => void;
  setProjectDraftWorkspaceId: (
    projectId: ProjectId,
    workspaceId: WorkspaceId,
    options?: {
      branch?: string | null;
      worktreePath?: string | null;
      createdAt?: string;
      envMode?: DraftWorkspaceEnvMode;
      runtimeMode?: RuntimeMode;
      interactionMode?: ProviderInteractionMode;
    },
  ) => void;
  setDraftWorkspaceContext: (
    workspaceId: WorkspaceId,
    options: {
      branch?: string | null;
      worktreePath?: string | null;
      projectId?: ProjectId;
      createdAt?: string;
      envMode?: DraftWorkspaceEnvMode;
      runtimeMode?: RuntimeMode;
      interactionMode?: ProviderInteractionMode;
    },
  ) => void;
  clearProjectDraftWorkspaceId: (projectId: ProjectId) => void;
  clearProjectDraftWorkspaceById: (projectId: ProjectId, workspaceId: WorkspaceId) => void;
  clearDraftWorkspace: (workspaceId: WorkspaceId) => void;
  setStickyModelSelection: (modelSelection: ModelSelection | null | undefined) => void;
  setPrompt: (workspaceId: WorkspaceId, prompt: string) => void;
  setTerminalContexts: (workspaceId: WorkspaceId, contexts: TerminalContextDraft[]) => void;
  setModelSelection: (
    workspaceId: WorkspaceId,
    modelSelection: ModelSelection | null | undefined,
  ) => void;
  setModelOptions: (
    workspaceId: WorkspaceId,
    modelOptions: ProviderModelOptions | null | undefined,
  ) => void;
  applyStickyState: (workspaceId: WorkspaceId) => void;
  setProviderModelOptions: (
    workspaceId: WorkspaceId,
    provider: ProviderKind,
    nextProviderOptions: ProviderModelOptions[ProviderKind] | null | undefined,
    options?: {
      persistSticky?: boolean;
    },
  ) => void;
  setRuntimeMode: (workspaceId: WorkspaceId, runtimeMode: RuntimeMode | null | undefined) => void;
  setInteractionMode: (
    workspaceId: WorkspaceId,
    interactionMode: ProviderInteractionMode | null | undefined,
  ) => void;
  addImage: (workspaceId: WorkspaceId, image: ComposerImageAttachment) => void;
  addImages: (workspaceId: WorkspaceId, images: ComposerImageAttachment[]) => void;
  removeImage: (workspaceId: WorkspaceId, imageId: string) => void;
  insertTerminalContext: (
    workspaceId: WorkspaceId,
    prompt: string,
    context: TerminalContextDraft,
    index: number,
  ) => boolean;
  addTerminalContext: (workspaceId: WorkspaceId, context: TerminalContextDraft) => void;
  addTerminalContexts: (workspaceId: WorkspaceId, contexts: TerminalContextDraft[]) => void;
  removeTerminalContext: (workspaceId: WorkspaceId, contextId: string) => void;
  clearTerminalContexts: (workspaceId: WorkspaceId) => void;
  clearPersistedAttachments: (workspaceId: WorkspaceId) => void;
  syncPersistedAttachments: (
    workspaceId: WorkspaceId,
    attachments: PersistedComposerImageAttachment[],
  ) => void;
  clearComposerContent: (workspaceId: WorkspaceId) => void;
}

export interface EffectiveComposerModelState {
  selectedModel: string;
  modelOptions: ProviderModelOptions | null;
}

function buildNextDraftWorkspaceState(input: {
  projectId: ProjectId;
  existingWorkspace: DraftWorkspaceState | null | undefined;
  options:
    | {
        branch?: string | null;
        worktreePath?: string | null;
        createdAt?: string;
        envMode?: DraftWorkspaceEnvMode;
        runtimeMode?: RuntimeMode;
        interactionMode?: ProviderInteractionMode;
      }
    | undefined;
}): DraftWorkspaceState {
  const { existingWorkspace, options, projectId } = input;
  const nextWorktreePath =
    options?.worktreePath === undefined
      ? (existingWorkspace?.worktreePath ?? null)
      : (options.worktreePath ?? null);
  return {
    projectId,
    createdAt: options?.createdAt ?? existingWorkspace?.createdAt ?? new Date().toISOString(),
    runtimeMode: options?.runtimeMode ?? existingWorkspace?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
    interactionMode:
      options?.interactionMode ?? existingWorkspace?.interactionMode ?? DEFAULT_INTERACTION_MODE,
    branch:
      options?.branch === undefined
        ? (existingWorkspace?.branch ?? null)
        : (options.branch ?? null),
    worktreePath: nextWorktreePath,
    envMode:
      options?.envMode ?? (nextWorktreePath ? "worktree" : (existingWorkspace?.envMode ?? "local")),
  };
}

function draftWorkspaceStatesEqual(
  left: DraftWorkspaceState | null | undefined,
  right: DraftWorkspaceState,
): boolean {
  return Boolean(
    left &&
    left.projectId === right.projectId &&
    left.createdAt === right.createdAt &&
    left.runtimeMode === right.runtimeMode &&
    left.interactionMode === right.interactionMode &&
    left.branch === right.branch &&
    left.worktreePath === right.worktreePath &&
    left.envMode === right.envMode,
  );
}

function providerModelOptionsFromSelection(
  modelSelection: ModelSelection | null | undefined,
): ProviderModelOptions | null {
  if (!modelSelection?.options) {
    return null;
  }

  return {
    [modelSelection.provider]: modelSelection.options,
  };
}

function modelSelectionByProviderToOptions(
  map: Partial<Record<ProviderKind, ModelSelection>> | null | undefined,
): ProviderModelOptions | null {
  if (!map) return null;
  const result: Record<string, unknown> = {};
  for (const [provider, selection] of Object.entries(map)) {
    if (selection?.options) {
      result[provider] = selection.options;
    }
  }
  return Object.keys(result).length > 0 ? (result as ProviderModelOptions) : null;
}

const EMPTY_PERSISTED_DRAFT_STORE_STATE = Object.freeze<PersistedComposerDraftStoreState>({
  draftsByWorkspaceId: {},
  draftWorkspacesByWorkspaceId: {},
  projectDraftWorkspaceIdByProjectId: {},
  stickyModelSelectionByProvider: {},
  stickyActiveProvider: null,
});

const EMPTY_IMAGES: ComposerImageAttachment[] = [];
const EMPTY_IDS: string[] = [];
const EMPTY_PERSISTED_ATTACHMENTS: PersistedComposerImageAttachment[] = [];
const EMPTY_TERMINAL_CONTEXTS: TerminalContextDraft[] = [];
Object.freeze(EMPTY_IMAGES);
Object.freeze(EMPTY_IDS);
Object.freeze(EMPTY_PERSISTED_ATTACHMENTS);
const EMPTY_MODEL_SELECTION_BY_PROVIDER: Partial<Record<ProviderKind, ModelSelection>> =
  Object.freeze({});

const EMPTY_WORKSPACE_DRAFT = Object.freeze<ComposerWorkspaceDraftState>({
  prompt: "",
  images: EMPTY_IMAGES,
  nonPersistedImageIds: EMPTY_IDS,
  persistedAttachments: EMPTY_PERSISTED_ATTACHMENTS,
  terminalContexts: EMPTY_TERMINAL_CONTEXTS,
  modelSelectionByProvider: EMPTY_MODEL_SELECTION_BY_PROVIDER,
  activeProvider: null,
  runtimeMode: null,
  interactionMode: null,
});

function createEmptyWorkspaceDraft(): ComposerWorkspaceDraftState {
  return {
    prompt: "",
    images: [],
    nonPersistedImageIds: [],
    persistedAttachments: [],
    terminalContexts: [],
    modelSelectionByProvider: {},
    activeProvider: null,
    runtimeMode: null,
    interactionMode: null,
  };
}

function composerImageDedupKey(image: ComposerImageAttachment): string {
  // Keep this independent from File.lastModified so dedupe is stable for hydrated
  // images reconstructed from localStorage (which get a fresh lastModified value).
  return `${image.mimeType}\u0000${image.sizeBytes}\u0000${image.name}`;
}

function terminalContextDedupKey(context: TerminalContextDraft): string {
  return `${context.terminalId}\u0000${context.lineStart}\u0000${context.lineEnd}`;
}

function normalizeTerminalContextForWorkspace(
  workspaceId: WorkspaceId,
  context: TerminalContextDraft,
): TerminalContextDraft | null {
  const terminalId = context.terminalId.trim();
  const terminalLabel = context.terminalLabel.trim();
  if (terminalId.length === 0 || terminalLabel.length === 0) {
    return null;
  }
  const lineStart = Math.max(1, Math.floor(context.lineStart));
  const lineEnd = Math.max(lineStart, Math.floor(context.lineEnd));
  return {
    ...context,
    workspaceId,
    terminalId,
    terminalLabel,
    lineStart,
    lineEnd,
    text: normalizeTerminalContextText(context.text),
  };
}

function normalizeTerminalContextsForWorkspace(
  workspaceId: WorkspaceId,
  contexts: ReadonlyArray<TerminalContextDraft>,
): TerminalContextDraft[] {
  const existingIds = new Set<string>();
  const existingDedupKeys = new Set<string>();
  const normalizedContexts: TerminalContextDraft[] = [];

  for (const context of contexts) {
    const normalizedContext = normalizeTerminalContextForWorkspace(workspaceId, context);
    if (!normalizedContext) {
      continue;
    }
    const dedupKey = terminalContextDedupKey(normalizedContext);
    if (existingIds.has(normalizedContext.id) || existingDedupKeys.has(dedupKey)) {
      continue;
    }
    normalizedContexts.push(normalizedContext);
    existingIds.add(normalizedContext.id);
    existingDedupKeys.add(dedupKey);
  }

  return normalizedContexts;
}

function shouldRemoveDraft(draft: ComposerWorkspaceDraftState): boolean {
  return (
    draft.prompt.length === 0 &&
    draft.images.length === 0 &&
    draft.persistedAttachments.length === 0 &&
    draft.terminalContexts.length === 0 &&
    Object.keys(draft.modelSelectionByProvider).length === 0 &&
    draft.activeProvider === null &&
    draft.runtimeMode === null &&
    draft.interactionMode === null
  );
}

function normalizeProviderKind(value: unknown): ProviderKind | null {
  return value === "codex" || value === "claudeAgent" ? value : null;
}

function normalizeProviderModelOptions(
  value: unknown,
  provider?: ProviderKind | null,
  legacy?: LegacyCodexFields,
): ProviderModelOptions | null {
  const candidate = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  const codexCandidate =
    candidate?.codex && typeof candidate.codex === "object"
      ? (candidate.codex as Record<string, unknown>)
      : null;
  const claudeCandidate =
    candidate?.claudeAgent && typeof candidate.claudeAgent === "object"
      ? (candidate.claudeAgent as Record<string, unknown>)
      : null;

  const codexReasoningEffort: CodexReasoningEffort | undefined =
    codexCandidate?.reasoningEffort === "low" ||
    codexCandidate?.reasoningEffort === "medium" ||
    codexCandidate?.reasoningEffort === "high" ||
    codexCandidate?.reasoningEffort === "xhigh"
      ? codexCandidate.reasoningEffort
      : provider === "codex" &&
          (legacy?.effort === "low" ||
            legacy?.effort === "medium" ||
            legacy?.effort === "high" ||
            legacy?.effort === "xhigh")
        ? legacy.effort
        : undefined;
  const codexFastMode =
    codexCandidate?.fastMode === true
      ? true
      : codexCandidate?.fastMode === false
        ? false
        : (provider === "codex" && legacy?.codexFastMode === true) ||
            (typeof legacy?.serviceTier === "string" && legacy.serviceTier === "fast")
          ? true
          : undefined;
  const codex =
    codexReasoningEffort !== undefined || codexFastMode !== undefined
      ? {
          ...(codexReasoningEffort !== undefined ? { reasoningEffort: codexReasoningEffort } : {}),
          ...(codexFastMode !== undefined ? { fastMode: codexFastMode } : {}),
        }
      : undefined;

  const claudeThinking =
    claudeCandidate?.thinking === true
      ? true
      : claudeCandidate?.thinking === false
        ? false
        : undefined;
  const claudeEffort: ClaudeCodeEffort | undefined =
    claudeCandidate?.effort === "low" ||
    claudeCandidate?.effort === "medium" ||
    claudeCandidate?.effort === "high" ||
    claudeCandidate?.effort === "max" ||
    claudeCandidate?.effort === "ultrathink"
      ? claudeCandidate.effort
      : undefined;
  const claudeFastMode =
    claudeCandidate?.fastMode === true
      ? true
      : claudeCandidate?.fastMode === false
        ? false
        : undefined;
  const claudeContextWindow =
    typeof claudeCandidate?.contextWindow === "string" && claudeCandidate.contextWindow.length > 0
      ? claudeCandidate.contextWindow
      : undefined;
  const claude =
    claudeThinking !== undefined ||
    claudeEffort !== undefined ||
    claudeFastMode !== undefined ||
    claudeContextWindow !== undefined
      ? {
          ...(claudeThinking !== undefined ? { thinking: claudeThinking } : {}),
          ...(claudeEffort !== undefined ? { effort: claudeEffort } : {}),
          ...(claudeFastMode !== undefined ? { fastMode: claudeFastMode } : {}),
          ...(claudeContextWindow !== undefined ? { contextWindow: claudeContextWindow } : {}),
        }
      : undefined;

  if (!codex && !claude) {
    return null;
  }
  return {
    ...(codex ? { codex } : {}),
    ...(claude ? { claudeAgent: claude } : {}),
  };
}

function normalizeModelSelection(
  value: unknown,
  legacy?: {
    provider?: unknown;
    model?: unknown;
    modelOptions?: unknown;
    legacyCodex?: LegacyCodexFields;
  },
): ModelSelection | null {
  const candidate = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  const provider = normalizeProviderKind(candidate?.provider ?? legacy?.provider);
  if (provider === null) {
    return null;
  }
  const rawModel = candidate?.model ?? legacy?.model;
  if (typeof rawModel !== "string") {
    return null;
  }
  const model = normalizeModelSlug(rawModel, provider);
  if (!model) {
    return null;
  }
  const modelOptions = normalizeProviderModelOptions(
    candidate?.options ? { [provider]: candidate.options } : legacy?.modelOptions,
    provider,
    provider === "codex" ? legacy?.legacyCodex : undefined,
  );
  const options = provider === "codex" ? modelOptions?.codex : modelOptions?.claudeAgent;
  return {
    provider,
    model,
    ...(options ? { options } : {}),
  };
}

// ── Legacy sync helpers (used only during migration from v2 storage) ──

function legacySyncModelSelectionOptions(
  modelSelection: ModelSelection | null,
  modelOptions: ProviderModelOptions | null | undefined,
): ModelSelection | null {
  if (modelSelection === null) {
    return null;
  }
  const options = modelOptions?.[modelSelection.provider];
  return {
    provider: modelSelection.provider,
    model: modelSelection.model,
    ...(options ? { options } : {}),
  };
}

function legacyMergeModelSelectionIntoProviderModelOptions(
  modelSelection: ModelSelection | null,
  currentModelOptions: ProviderModelOptions | null | undefined,
): ProviderModelOptions | null {
  if (modelSelection?.options === undefined) {
    return normalizeProviderModelOptions(currentModelOptions);
  }
  return legacyReplaceProviderModelOptions(
    normalizeProviderModelOptions(currentModelOptions),
    modelSelection.provider,
    modelSelection.options,
  );
}

function legacyReplaceProviderModelOptions(
  currentModelOptions: ProviderModelOptions | null | undefined,
  provider: ProviderKind,
  nextProviderOptions: ProviderModelOptions[ProviderKind] | null | undefined,
): ProviderModelOptions | null {
  const { [provider]: _discardedProviderModelOptions, ...otherProviderModelOptions } =
    currentModelOptions ?? {};
  const normalizedNextProviderOptions = normalizeProviderModelOptions(
    { [provider]: nextProviderOptions },
    provider,
  );

  return normalizeProviderModelOptions({
    ...otherProviderModelOptions,
    ...(normalizedNextProviderOptions ? normalizedNextProviderOptions : {}),
  });
}

// ── New helpers for the consolidated representation ────────────────────

function legacyToModelSelectionByProvider(
  modelSelection: ModelSelection | null,
  modelOptions: ProviderModelOptions | null | undefined,
): Partial<Record<ProviderKind, ModelSelection>> {
  const result: Partial<Record<ProviderKind, ModelSelection>> = {};
  // Add entries from the options bag (for non-active providers)
  if (modelOptions) {
    for (const provider of ["codex", "claudeAgent"] as const) {
      const options = modelOptions[provider];
      if (options && Object.keys(options).length > 0) {
        result[provider] = {
          provider,
          model:
            modelSelection?.provider === provider
              ? modelSelection.model
              : DEFAULT_MODEL_BY_PROVIDER[provider],
          options,
        };
      }
    }
  }
  // Add/overwrite the active selection (it's authoritative for its provider)
  if (modelSelection) {
    result[modelSelection.provider] = modelSelection;
  }
  return result;
}

export function deriveEffectiveComposerModelState(input: {
  draft:
    | Pick<ComposerWorkspaceDraftState, "modelSelectionByProvider" | "activeProvider">
    | null
    | undefined;
  providers: ReadonlyArray<ServerProvider>;
  selectedProvider: ProviderKind;
  workspaceModelSelection: ModelSelection | null | undefined;
  projectModelSelection: ModelSelection | null | undefined;
  settings: UnifiedSettings;
}): EffectiveComposerModelState {
  const baseModel =
    normalizeModelSlug(
      input.workspaceModelSelection?.model ?? input.projectModelSelection?.model,
      input.selectedProvider,
    ) ?? getDefaultServerModel(input.providers, input.selectedProvider);
  const activeSelection = input.draft?.modelSelectionByProvider?.[input.selectedProvider];
  const selectedModel = activeSelection?.model
    ? resolveAppModelSelection(
        input.selectedProvider,
        input.settings,
        input.providers,
        activeSelection.model,
      )
    : baseModel;
  const modelOptions =
    modelSelectionByProviderToOptions(input.draft?.modelSelectionByProvider) ??
    providerModelOptionsFromSelection(input.workspaceModelSelection) ??
    providerModelOptionsFromSelection(input.projectModelSelection) ??
    null;

  return {
    selectedModel,
    modelOptions,
  };
}

function revokeObjectPreviewUrl(previewUrl: string): void {
  if (typeof URL === "undefined") {
    return;
  }
  if (!previewUrl.startsWith("blob:")) {
    return;
  }
  URL.revokeObjectURL(previewUrl);
}

function normalizePersistedAttachment(value: unknown): PersistedComposerImageAttachment | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const id = candidate.id;
  const name = candidate.name;
  const mimeType = candidate.mimeType;
  const sizeBytes = candidate.sizeBytes;
  const dataUrl = candidate.dataUrl;
  if (
    typeof id !== "string" ||
    typeof name !== "string" ||
    typeof mimeType !== "string" ||
    typeof sizeBytes !== "number" ||
    !Number.isFinite(sizeBytes) ||
    typeof dataUrl !== "string" ||
    id.length === 0 ||
    dataUrl.length === 0
  ) {
    return null;
  }
  return {
    id,
    name,
    mimeType,
    sizeBytes,
    dataUrl,
  };
}

function normalizePersistedTerminalContextDraft(
  value: unknown,
): PersistedTerminalContextDraft | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const id = candidate.id;
  const workspaceId = candidate.workspaceId;
  const createdAt = candidate.createdAt;
  const lineStart = candidate.lineStart;
  const lineEnd = candidate.lineEnd;
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    typeof workspaceId !== "string" ||
    workspaceId.length === 0 ||
    typeof createdAt !== "string" ||
    createdAt.length === 0 ||
    typeof lineStart !== "number" ||
    !Number.isFinite(lineStart) ||
    typeof lineEnd !== "number" ||
    !Number.isFinite(lineEnd)
  ) {
    return null;
  }
  const terminalId = typeof candidate.terminalId === "string" ? candidate.terminalId.trim() : "";
  const terminalLabel =
    typeof candidate.terminalLabel === "string" ? candidate.terminalLabel.trim() : "";
  if (terminalId.length === 0 || terminalLabel.length === 0) {
    return null;
  }
  const normalizedLineStart = Math.max(1, Math.floor(lineStart));
  const normalizedLineEnd = Math.max(normalizedLineStart, Math.floor(lineEnd));
  return {
    id,
    workspaceId: workspaceId as WorkspaceId,
    createdAt,
    terminalId,
    terminalLabel,
    lineStart: normalizedLineStart,
    lineEnd: normalizedLineEnd,
  };
}

function normalizeDraftWorkspaceEnvMode(
  value: unknown,
  fallbackWorktreePath: string | null,
): DraftWorkspaceEnvMode {
  if (value === "local" || value === "worktree") {
    return value;
  }
  return fallbackWorktreePath ? "worktree" : "local";
}

function normalizePersistedDraftWorkspaces(
  rawDraftWorkspacesByWorkspaceId: unknown,
  rawProjectDraftWorkspaceIdByProjectId: unknown,
): Pick<
  PersistedComposerDraftStoreState,
  "draftWorkspacesByWorkspaceId" | "projectDraftWorkspaceIdByProjectId"
> {
  const draftWorkspacesByWorkspaceId: Record<WorkspaceId, PersistedDraftWorkspaceState> = {};
  if (rawDraftWorkspacesByWorkspaceId && typeof rawDraftWorkspacesByWorkspaceId === "object") {
    for (const [workspaceId, rawDraftWorkspace] of Object.entries(
      rawDraftWorkspacesByWorkspaceId as Record<string, unknown>,
    )) {
      if (typeof workspaceId !== "string" || workspaceId.length === 0) {
        continue;
      }
      if (!rawDraftWorkspace || typeof rawDraftWorkspace !== "object") {
        continue;
      }
      const candidateDraftWorkspace = rawDraftWorkspace as Record<string, unknown>;
      const projectId = candidateDraftWorkspace.projectId;
      const createdAt = candidateDraftWorkspace.createdAt;
      const branch = candidateDraftWorkspace.branch;
      const worktreePath = candidateDraftWorkspace.worktreePath;
      const normalizedWorktreePath = typeof worktreePath === "string" ? worktreePath : null;
      if (typeof projectId !== "string" || projectId.length === 0) {
        continue;
      }
      draftWorkspacesByWorkspaceId[workspaceId as WorkspaceId] = {
        projectId: projectId as ProjectId,
        createdAt:
          typeof createdAt === "string" && createdAt.length > 0
            ? createdAt
            : new Date().toISOString(),
        runtimeMode:
          candidateDraftWorkspace.runtimeMode === "approval-required" ||
          candidateDraftWorkspace.runtimeMode === "full-access"
            ? candidateDraftWorkspace.runtimeMode
            : DEFAULT_RUNTIME_MODE,
        interactionMode:
          candidateDraftWorkspace.interactionMode === "plan" ||
          candidateDraftWorkspace.interactionMode === "default"
            ? candidateDraftWorkspace.interactionMode
            : DEFAULT_INTERACTION_MODE,
        branch: typeof branch === "string" ? branch : null,
        worktreePath: normalizedWorktreePath,
        envMode: normalizeDraftWorkspaceEnvMode(
          candidateDraftWorkspace.envMode,
          normalizedWorktreePath,
        ),
      };
    }
  }

  const projectDraftWorkspaceIdByProjectId: Record<ProjectId, WorkspaceId> = {};
  if (
    rawProjectDraftWorkspaceIdByProjectId &&
    typeof rawProjectDraftWorkspaceIdByProjectId === "object"
  ) {
    for (const [projectId, workspaceId] of Object.entries(
      rawProjectDraftWorkspaceIdByProjectId as Record<string, unknown>,
    )) {
      if (
        typeof projectId === "string" &&
        projectId.length > 0 &&
        typeof workspaceId === "string" &&
        workspaceId.length > 0
      ) {
        projectDraftWorkspaceIdByProjectId[projectId as ProjectId] = workspaceId as WorkspaceId;
        if (!draftWorkspacesByWorkspaceId[workspaceId as WorkspaceId]) {
          draftWorkspacesByWorkspaceId[workspaceId as WorkspaceId] = {
            projectId: projectId as ProjectId,
            createdAt: new Date().toISOString(),
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_INTERACTION_MODE,
            branch: null,
            worktreePath: null,
            envMode: "local",
          };
        } else if (
          draftWorkspacesByWorkspaceId[workspaceId as WorkspaceId]?.projectId !== projectId
        ) {
          draftWorkspacesByWorkspaceId[workspaceId as WorkspaceId] = {
            ...draftWorkspacesByWorkspaceId[workspaceId as WorkspaceId]!,
            projectId: projectId as ProjectId,
          };
        }
      }
    }
  }

  return { draftWorkspacesByWorkspaceId, projectDraftWorkspaceIdByProjectId };
}

function normalizePersistedDraftsByWorkspaceId(
  rawDraftMap: unknown,
): PersistedComposerDraftStoreState["draftsByWorkspaceId"] {
  if (!rawDraftMap || typeof rawDraftMap !== "object") {
    return {};
  }

  const nextDraftsByWorkspaceId: DeepMutable<
    PersistedComposerDraftStoreState["draftsByWorkspaceId"]
  > = {};
  for (const [workspaceId, draftValue] of Object.entries(rawDraftMap as Record<string, unknown>)) {
    if (typeof workspaceId !== "string" || workspaceId.length === 0) {
      continue;
    }
    if (!draftValue || typeof draftValue !== "object") {
      continue;
    }
    const draftCandidate = draftValue as PersistedComposerWorkspaceDraftState;
    const promptCandidate = typeof draftCandidate.prompt === "string" ? draftCandidate.prompt : "";
    const attachments = Array.isArray(draftCandidate.attachments)
      ? draftCandidate.attachments.flatMap((entry) => {
          const normalized = normalizePersistedAttachment(entry);
          return normalized ? [normalized] : [];
        })
      : [];
    const terminalContexts = Array.isArray(draftCandidate.terminalContexts)
      ? draftCandidate.terminalContexts.flatMap((entry) => {
          const normalized = normalizePersistedTerminalContextDraft(entry);
          return normalized ? [normalized] : [];
        })
      : [];
    const runtimeMode =
      draftCandidate.runtimeMode === "approval-required" ||
      draftCandidate.runtimeMode === "full-access"
        ? draftCandidate.runtimeMode
        : null;
    const interactionMode =
      draftCandidate.interactionMode === "plan" || draftCandidate.interactionMode === "default"
        ? draftCandidate.interactionMode
        : null;
    const prompt = ensureInlineTerminalContextPlaceholders(
      promptCandidate,
      terminalContexts.length,
    );
    // If the draft already has the v3 shape, use it directly
    const legacyDraftCandidate = draftValue as LegacyPersistedComposerWorkspaceDraftState;
    let modelSelectionByProvider: Partial<Record<ProviderKind, ModelSelection>> = {};
    let activeProvider: ProviderKind | null = null;

    if (
      draftCandidate.modelSelectionByProvider &&
      typeof draftCandidate.modelSelectionByProvider === "object"
    ) {
      // v3 format
      modelSelectionByProvider = draftCandidate.modelSelectionByProvider as Partial<
        Record<ProviderKind, ModelSelection>
      >;
      activeProvider = normalizeProviderKind(draftCandidate.activeProvider);
    } else {
      // v2 or legacy format: migrate
      const normalizedModelOptions =
        normalizeProviderModelOptions(
          legacyDraftCandidate.modelOptions,
          undefined,
          legacyDraftCandidate,
        ) ?? null;
      const normalizedModelSelection = normalizeModelSelection(
        legacyDraftCandidate.modelSelection,
        {
          provider: legacyDraftCandidate.provider,
          model: legacyDraftCandidate.model,
          modelOptions: normalizedModelOptions ?? legacyDraftCandidate.modelOptions,
          legacyCodex: legacyDraftCandidate,
        },
      );
      const mergedModelOptions = legacyMergeModelSelectionIntoProviderModelOptions(
        normalizedModelSelection,
        normalizedModelOptions,
      );
      const modelSelection = legacySyncModelSelectionOptions(
        normalizedModelSelection,
        mergedModelOptions,
      );
      modelSelectionByProvider = legacyToModelSelectionByProvider(
        modelSelection,
        mergedModelOptions,
      );
      activeProvider = modelSelection?.provider ?? null;
    }

    const hasModelData =
      Object.keys(modelSelectionByProvider).length > 0 || activeProvider !== null;
    if (
      promptCandidate.length === 0 &&
      attachments.length === 0 &&
      terminalContexts.length === 0 &&
      !hasModelData &&
      !runtimeMode &&
      !interactionMode
    ) {
      continue;
    }
    nextDraftsByWorkspaceId[workspaceId as WorkspaceId] = {
      prompt,
      attachments,
      ...(terminalContexts.length > 0 ? { terminalContexts } : {}),
      ...(hasModelData ? { modelSelectionByProvider, activeProvider } : {}),
      ...(runtimeMode ? { runtimeMode } : {}),
      ...(interactionMode ? { interactionMode } : {}),
    };
  }

  return nextDraftsByWorkspaceId;
}

function migratePersistedComposerDraftStoreState(
  persistedState: unknown,
): PersistedComposerDraftStoreState {
  if (!persistedState || typeof persistedState !== "object") {
    return EMPTY_PERSISTED_DRAFT_STORE_STATE;
  }
  const candidate = persistedState as LegacyPersistedComposerDraftStoreState;
  const rawDraftMap = candidate.draftsByWorkspaceId;
  const rawDraftWorkspacesByWorkspaceId = candidate.draftWorkspacesByWorkspaceId;
  const rawProjectDraftWorkspaceIdByProjectId = candidate.projectDraftWorkspaceIdByProjectId;

  // Migrate sticky state from v2 (dual) to v3 (consolidated)
  const stickyModelOptions = normalizeProviderModelOptions(candidate.stickyModelOptions) ?? {};
  const normalizedStickyModelSelection = normalizeModelSelection(candidate.stickyModelSelection, {
    provider: candidate.stickyProvider ?? "codex",
    model: candidate.stickyModel,
    modelOptions: stickyModelOptions,
  });
  const nextStickyModelOptions = legacyMergeModelSelectionIntoProviderModelOptions(
    normalizedStickyModelSelection,
    stickyModelOptions,
  );
  const stickyModelSelection = legacySyncModelSelectionOptions(
    normalizedStickyModelSelection,
    nextStickyModelOptions,
  );
  const stickyModelSelectionByProvider = legacyToModelSelectionByProvider(
    stickyModelSelection,
    nextStickyModelOptions,
  );
  const stickyActiveProvider = normalizeProviderKind(candidate.stickyProvider) ?? null;

  const { draftWorkspacesByWorkspaceId, projectDraftWorkspaceIdByProjectId } =
    normalizePersistedDraftWorkspaces(
      rawDraftWorkspacesByWorkspaceId,
      rawProjectDraftWorkspaceIdByProjectId,
    );
  const draftsByWorkspaceId = normalizePersistedDraftsByWorkspaceId(rawDraftMap);
  return {
    draftsByWorkspaceId,
    draftWorkspacesByWorkspaceId,
    projectDraftWorkspaceIdByProjectId,
    stickyModelSelectionByProvider,
    stickyActiveProvider,
  };
}

function partializeComposerDraftStoreState(
  state: ComposerDraftStoreState,
): PersistedComposerDraftStoreState {
  const persistedDraftsByWorkspaceId: DeepMutable<
    PersistedComposerDraftStoreState["draftsByWorkspaceId"]
  > = {};
  for (const [workspaceId, draft] of Object.entries(state.draftsByWorkspaceId)) {
    if (typeof workspaceId !== "string" || workspaceId.length === 0) {
      continue;
    }
    const hasModelData =
      Object.keys(draft.modelSelectionByProvider).length > 0 || draft.activeProvider !== null;
    if (
      draft.prompt.length === 0 &&
      draft.persistedAttachments.length === 0 &&
      draft.terminalContexts.length === 0 &&
      !hasModelData &&
      draft.runtimeMode === null &&
      draft.interactionMode === null
    ) {
      continue;
    }
    const persistedDraft: DeepMutable<PersistedComposerWorkspaceDraftState> = {
      prompt: draft.prompt,
      attachments: draft.persistedAttachments,
      ...(draft.terminalContexts.length > 0
        ? {
            terminalContexts: draft.terminalContexts.map((context) => ({
              id: context.id,
              workspaceId: context.workspaceId,
              createdAt: context.createdAt,
              terminalId: context.terminalId,
              terminalLabel: context.terminalLabel,
              lineStart: context.lineStart,
              lineEnd: context.lineEnd,
            })),
          }
        : {}),
      ...(hasModelData
        ? {
            modelSelectionByProvider: draft.modelSelectionByProvider,
            activeProvider: draft.activeProvider,
          }
        : {}),
      ...(draft.runtimeMode ? { runtimeMode: draft.runtimeMode } : {}),
      ...(draft.interactionMode ? { interactionMode: draft.interactionMode } : {}),
    };
    persistedDraftsByWorkspaceId[workspaceId as WorkspaceId] = persistedDraft;
  }
  return {
    draftsByWorkspaceId: persistedDraftsByWorkspaceId,
    draftWorkspacesByWorkspaceId: state.draftWorkspacesByWorkspaceId,
    projectDraftWorkspaceIdByProjectId: state.projectDraftWorkspaceIdByProjectId,
    stickyModelSelectionByProvider: state.stickyModelSelectionByProvider,
    stickyActiveProvider: state.stickyActiveProvider,
  };
}

function normalizeCurrentPersistedComposerDraftStoreState(
  persistedState: unknown,
): PersistedComposerDraftStoreState {
  if (!persistedState || typeof persistedState !== "object") {
    return EMPTY_PERSISTED_DRAFT_STORE_STATE;
  }
  const normalizedPersistedState = persistedState as LegacyPersistedComposerDraftStoreState;
  const { draftWorkspacesByWorkspaceId, projectDraftWorkspaceIdByProjectId } =
    normalizePersistedDraftWorkspaces(
      normalizedPersistedState.draftWorkspacesByWorkspaceId,
      normalizedPersistedState.projectDraftWorkspaceIdByProjectId,
    );

  // Handle both v3 (modelSelectionByProvider) and v2/legacy formats
  let stickyModelSelectionByProvider: Partial<Record<ProviderKind, ModelSelection>> = {};
  let stickyActiveProvider: ProviderKind | null = null;
  if (
    normalizedPersistedState.stickyModelSelectionByProvider &&
    typeof normalizedPersistedState.stickyModelSelectionByProvider === "object"
  ) {
    stickyModelSelectionByProvider =
      normalizedPersistedState.stickyModelSelectionByProvider as Partial<
        Record<ProviderKind, ModelSelection>
      >;
    stickyActiveProvider = normalizeProviderKind(normalizedPersistedState.stickyActiveProvider);
  } else {
    // Legacy migration path
    const stickyModelOptions =
      normalizeProviderModelOptions(normalizedPersistedState.stickyModelOptions) ?? {};
    const normalizedStickyModelSelection = normalizeModelSelection(
      normalizedPersistedState.stickyModelSelection,
      {
        provider: normalizedPersistedState.stickyProvider,
        model: normalizedPersistedState.stickyModel,
        modelOptions: stickyModelOptions,
      },
    );
    const nextStickyModelOptions = legacyMergeModelSelectionIntoProviderModelOptions(
      normalizedStickyModelSelection,
      stickyModelOptions,
    );
    const stickyModelSelection = legacySyncModelSelectionOptions(
      normalizedStickyModelSelection,
      nextStickyModelOptions,
    );
    stickyModelSelectionByProvider = legacyToModelSelectionByProvider(
      stickyModelSelection,
      nextStickyModelOptions,
    );
    stickyActiveProvider = normalizeProviderKind(normalizedPersistedState.stickyProvider);
  }

  return {
    draftsByWorkspaceId: normalizePersistedDraftsByWorkspaceId(
      normalizedPersistedState.draftsByWorkspaceId,
    ),
    draftWorkspacesByWorkspaceId,
    projectDraftWorkspaceIdByProjectId,
    stickyModelSelectionByProvider,
    stickyActiveProvider,
  };
}

function readPersistedAttachmentIdsFromStorage(workspaceId: WorkspaceId): string[] {
  if (workspaceId.length === 0) {
    return [];
  }
  try {
    const persisted = getLocalStorageItem(
      COMPOSER_DRAFT_STORAGE_KEY,
      PersistedComposerDraftStoreStorage,
    );
    if (!persisted || persisted.version !== COMPOSER_DRAFT_STORAGE_VERSION) {
      return [];
    }
    return (persisted.state.draftsByWorkspaceId[workspaceId]?.attachments ?? []).map(
      (attachment) => attachment.id,
    );
  } catch {
    return [];
  }
}

function verifyPersistedAttachments(
  workspaceId: WorkspaceId,
  attachments: PersistedComposerImageAttachment[],
  set: (
    partial:
      | ComposerDraftStoreState
      | Partial<ComposerDraftStoreState>
      | ((
          state: ComposerDraftStoreState,
        ) => ComposerDraftStoreState | Partial<ComposerDraftStoreState>),
    replace?: false,
  ) => void,
): void {
  let persistedIdSet = new Set<string>();
  try {
    composerDebouncedStorage.flush();
    persistedIdSet = new Set(readPersistedAttachmentIdsFromStorage(workspaceId));
  } catch {
    persistedIdSet = new Set();
  }
  set((state) => {
    const current = state.draftsByWorkspaceId[workspaceId];
    if (!current) {
      return state;
    }
    const imageIdSet = new Set(current.images.map((image) => image.id));
    const persistedAttachments = attachments.filter(
      (attachment) => imageIdSet.has(attachment.id) && persistedIdSet.has(attachment.id),
    );
    const nonPersistedImageIds = current.images
      .map((image) => image.id)
      .filter((imageId) => !persistedIdSet.has(imageId));
    const nextDraft: ComposerWorkspaceDraftState = {
      ...current,
      persistedAttachments,
      nonPersistedImageIds,
    };
    const nextDraftsByWorkspaceId = { ...state.draftsByWorkspaceId };
    if (shouldRemoveDraft(nextDraft)) {
      delete nextDraftsByWorkspaceId[workspaceId];
    } else {
      nextDraftsByWorkspaceId[workspaceId] = nextDraft;
    }
    return { draftsByWorkspaceId: nextDraftsByWorkspaceId };
  });
}

function hydreatePersistedComposerImageAttachment(
  attachment: PersistedComposerImageAttachment,
): File | null {
  const commaIndex = attachment.dataUrl.indexOf(",");
  const header = commaIndex === -1 ? attachment.dataUrl : attachment.dataUrl.slice(0, commaIndex);
  const payload = commaIndex === -1 ? "" : attachment.dataUrl.slice(commaIndex + 1);
  if (payload.length === 0) {
    return null;
  }
  try {
    const isBase64 = header.includes(";base64");
    if (!isBase64) {
      const decodedText = decodeURIComponent(payload);
      const inferredMimeType =
        header.startsWith("data:") && header.includes(";")
          ? header.slice("data:".length, header.indexOf(";"))
          : attachment.mimeType;
      return new File([decodedText], attachment.name, {
        type: inferredMimeType || attachment.mimeType,
      });
    }
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new File([bytes], attachment.name, { type: attachment.mimeType });
  } catch {
    return null;
  }
}

function hydrateImagesFromPersisted(
  attachments: ReadonlyArray<PersistedComposerImageAttachment>,
): ComposerImageAttachment[] {
  return attachments.flatMap((attachment) => {
    const file = hydreatePersistedComposerImageAttachment(attachment);
    if (!file) return [];

    return [
      {
        type: "image" as const,
        id: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        previewUrl: attachment.dataUrl,
        file,
      } satisfies ComposerImageAttachment,
    ];
  });
}

function toHydratedWorkspaceDraft(
  persistedDraft: PersistedComposerWorkspaceDraftState,
): ComposerWorkspaceDraftState {
  // The persisted draft is already in v3 shape (migration handles older formats)
  const modelSelectionByProvider: Partial<Record<ProviderKind, ModelSelection>> =
    persistedDraft.modelSelectionByProvider ?? {};
  const activeProvider = normalizeProviderKind(persistedDraft.activeProvider) ?? null;

  return {
    prompt: persistedDraft.prompt,
    images: hydrateImagesFromPersisted(persistedDraft.attachments),
    nonPersistedImageIds: [],
    persistedAttachments: [...persistedDraft.attachments],
    terminalContexts:
      persistedDraft.terminalContexts?.map((context) => ({
        ...context,
        text: "",
      })) ?? [],
    modelSelectionByProvider,
    activeProvider,
    runtimeMode: persistedDraft.runtimeMode ?? null,
    interactionMode: persistedDraft.interactionMode ?? null,
  };
}

export const useComposerDraftStore = create<ComposerDraftStoreState>()(
  persist(
    (set, get) => ({
      draftsByWorkspaceId: {},
      draftWorkspacesByWorkspaceId: {},
      projectDraftWorkspaceIdByProjectId: {},
      stickyModelSelectionByProvider: {},
      stickyActiveProvider: null,
      getDraftWorkspaceByProjectId: (projectId) => {
        if (projectId.length === 0) {
          return null;
        }
        const workspaceId = get().projectDraftWorkspaceIdByProjectId[projectId];
        if (!workspaceId) {
          return null;
        }
        const draftWorkspace = get().draftWorkspacesByWorkspaceId[workspaceId];
        if (!draftWorkspace || draftWorkspace.projectId !== projectId) {
          return null;
        }
        return {
          workspaceId,
          ...draftWorkspace,
        };
      },
      getDraftWorkspace: (workspaceId) => {
        if (workspaceId.length === 0) {
          return null;
        }
        return get().draftWorkspacesByWorkspaceId[workspaceId] ?? null;
      },
      upsertDraftWorkspace: (workspaceId, input) => {
        if (workspaceId.length === 0 || input.projectId.length === 0) {
          return;
        }
        set((state) => {
          const existingWorkspace = state.draftWorkspacesByWorkspaceId[workspaceId];
          const nextDraftWorkspace = buildNextDraftWorkspaceState({
            projectId: input.projectId,
            existingWorkspace,
            options: input,
          });
          if (draftWorkspaceStatesEqual(existingWorkspace, nextDraftWorkspace)) {
            return state;
          }
          return {
            draftWorkspacesByWorkspaceId: {
              ...state.draftWorkspacesByWorkspaceId,
              [workspaceId]: nextDraftWorkspace,
            },
          };
        });
      },
      setProjectDraftWorkspaceId: (projectId, workspaceId, options) => {
        if (projectId.length === 0 || workspaceId.length === 0) {
          return;
        }
        set((state) => {
          const existingWorkspace = state.draftWorkspacesByWorkspaceId[workspaceId];
          const previousWorkspaceIdForProject = state.projectDraftWorkspaceIdByProjectId[projectId];
          const nextDraftWorkspace = buildNextDraftWorkspaceState({
            projectId,
            existingWorkspace,
            options,
          });
          const hasSameProjectMapping = previousWorkspaceIdForProject === workspaceId;
          const hasSameDraftWorkspace = draftWorkspaceStatesEqual(
            existingWorkspace,
            nextDraftWorkspace,
          );
          if (hasSameProjectMapping && hasSameDraftWorkspace) {
            return state;
          }
          const nextProjectDraftWorkspaceIdByProjectId: Record<ProjectId, WorkspaceId> = {
            ...state.projectDraftWorkspaceIdByProjectId,
            [projectId]: workspaceId,
          };
          const nextDraftWorkspacesByWorkspaceId: Record<WorkspaceId, DraftWorkspaceState> = {
            ...state.draftWorkspacesByWorkspaceId,
            [workspaceId]: nextDraftWorkspace,
          };
          let nextDraftsByWorkspaceId = state.draftsByWorkspaceId;
          if (
            previousWorkspaceIdForProject &&
            previousWorkspaceIdForProject !== workspaceId &&
            !Object.values(nextProjectDraftWorkspaceIdByProjectId).includes(
              previousWorkspaceIdForProject,
            )
          ) {
            delete nextDraftWorkspacesByWorkspaceId[previousWorkspaceIdForProject];
            if (state.draftsByWorkspaceId[previousWorkspaceIdForProject] !== undefined) {
              nextDraftsByWorkspaceId = { ...state.draftsByWorkspaceId };
              delete nextDraftsByWorkspaceId[previousWorkspaceIdForProject];
            }
          }
          return {
            draftsByWorkspaceId: nextDraftsByWorkspaceId,
            draftWorkspacesByWorkspaceId: nextDraftWorkspacesByWorkspaceId,
            projectDraftWorkspaceIdByProjectId: nextProjectDraftWorkspaceIdByProjectId,
          };
        });
      },
      setDraftWorkspaceContext: (workspaceId, options) => {
        if (workspaceId.length === 0) {
          return;
        }
        set((state) => {
          const existing = state.draftWorkspacesByWorkspaceId[workspaceId];
          if (!existing) {
            return state;
          }
          const nextProjectId = options.projectId ?? existing.projectId;
          if (nextProjectId.length === 0) {
            return state;
          }
          const nextDraftWorkspace = buildNextDraftWorkspaceState({
            projectId: nextProjectId,
            existingWorkspace: existing,
            options,
          });
          if (draftWorkspaceStatesEqual(existing, nextDraftWorkspace)) {
            return state;
          }
          const nextProjectDraftWorkspaceIdByProjectId: Record<ProjectId, WorkspaceId> = {
            ...state.projectDraftWorkspaceIdByProjectId,
            [nextProjectId]: workspaceId,
          };
          if (existing.projectId !== nextProjectId) {
            if (nextProjectDraftWorkspaceIdByProjectId[existing.projectId] === workspaceId) {
              delete nextProjectDraftWorkspaceIdByProjectId[existing.projectId];
            }
          }
          return {
            draftWorkspacesByWorkspaceId: {
              ...state.draftWorkspacesByWorkspaceId,
              [workspaceId]: nextDraftWorkspace,
            },
            projectDraftWorkspaceIdByProjectId: nextProjectDraftWorkspaceIdByProjectId,
          };
        });
      },
      clearProjectDraftWorkspaceId: (projectId) => {
        if (projectId.length === 0) {
          return;
        }
        set((state) => {
          const workspaceId = state.projectDraftWorkspaceIdByProjectId[projectId];
          if (workspaceId === undefined) {
            return state;
          }
          const { [projectId]: _removed, ...restProjectMappingsRaw } =
            state.projectDraftWorkspaceIdByProjectId;
          const restProjectMappings = restProjectMappingsRaw as Record<ProjectId, WorkspaceId>;
          const nextDraftWorkspacesByWorkspaceId: Record<WorkspaceId, DraftWorkspaceState> = {
            ...state.draftWorkspacesByWorkspaceId,
          };
          let nextDraftsByWorkspaceId = state.draftsByWorkspaceId;
          if (!Object.values(restProjectMappings).includes(workspaceId)) {
            delete nextDraftWorkspacesByWorkspaceId[workspaceId];
            if (state.draftsByWorkspaceId[workspaceId] !== undefined) {
              nextDraftsByWorkspaceId = { ...state.draftsByWorkspaceId };
              delete nextDraftsByWorkspaceId[workspaceId];
            }
          }
          return {
            draftsByWorkspaceId: nextDraftsByWorkspaceId,
            draftWorkspacesByWorkspaceId: nextDraftWorkspacesByWorkspaceId,
            projectDraftWorkspaceIdByProjectId: restProjectMappings,
          };
        });
      },
      clearProjectDraftWorkspaceById: (projectId, workspaceId) => {
        if (projectId.length === 0 || workspaceId.length === 0) {
          return;
        }
        set((state) => {
          if (state.projectDraftWorkspaceIdByProjectId[projectId] !== workspaceId) {
            return state;
          }
          const { [projectId]: _removed, ...restProjectMappingsRaw } =
            state.projectDraftWorkspaceIdByProjectId;
          const restProjectMappings = restProjectMappingsRaw as Record<ProjectId, WorkspaceId>;
          const nextDraftWorkspacesByWorkspaceId: Record<WorkspaceId, DraftWorkspaceState> = {
            ...state.draftWorkspacesByWorkspaceId,
          };
          let nextDraftsByWorkspaceId = state.draftsByWorkspaceId;
          if (!Object.values(restProjectMappings).includes(workspaceId)) {
            delete nextDraftWorkspacesByWorkspaceId[workspaceId];
            if (state.draftsByWorkspaceId[workspaceId] !== undefined) {
              nextDraftsByWorkspaceId = { ...state.draftsByWorkspaceId };
              delete nextDraftsByWorkspaceId[workspaceId];
            }
          }
          return {
            draftsByWorkspaceId: nextDraftsByWorkspaceId,
            draftWorkspacesByWorkspaceId: nextDraftWorkspacesByWorkspaceId,
            projectDraftWorkspaceIdByProjectId: restProjectMappings,
          };
        });
      },
      clearDraftWorkspace: (workspaceId) => {
        if (workspaceId.length === 0) {
          return;
        }
        const existing = get().draftsByWorkspaceId[workspaceId];
        if (existing) {
          for (const image of existing.images) {
            revokeObjectPreviewUrl(image.previewUrl);
          }
        }
        set((state) => {
          const hasDraftWorkspace = state.draftWorkspacesByWorkspaceId[workspaceId] !== undefined;
          const hasProjectMapping = Object.values(
            state.projectDraftWorkspaceIdByProjectId,
          ).includes(workspaceId);
          const hasComposerDraft = state.draftsByWorkspaceId[workspaceId] !== undefined;
          if (!hasDraftWorkspace && !hasProjectMapping && !hasComposerDraft) {
            return state;
          }
          const nextProjectDraftWorkspaceIdByProjectId = Object.fromEntries(
            Object.entries(state.projectDraftWorkspaceIdByProjectId).filter(
              ([, draftWorkspaceId]) => draftWorkspaceId !== workspaceId,
            ),
          ) as Record<ProjectId, WorkspaceId>;
          const { [workspaceId]: _removedDraftWorkspace, ...restDraftWorkspacesByWorkspaceId } =
            state.draftWorkspacesByWorkspaceId;
          const { [workspaceId]: _removedComposerDraft, ...restDraftsByWorkspaceId } =
            state.draftsByWorkspaceId;
          return {
            draftsByWorkspaceId: restDraftsByWorkspaceId,
            draftWorkspacesByWorkspaceId: restDraftWorkspacesByWorkspaceId,
            projectDraftWorkspaceIdByProjectId: nextProjectDraftWorkspaceIdByProjectId,
          };
        });
      },
      setStickyModelSelection: (modelSelection) => {
        const normalized = normalizeModelSelection(modelSelection);
        set((state) => {
          if (!normalized) {
            return state;
          }
          const nextMap: Partial<Record<ProviderKind, ModelSelection>> = {
            ...state.stickyModelSelectionByProvider,
            [normalized.provider]: normalized,
          };
          if (Equal.equals(state.stickyModelSelectionByProvider, nextMap)) {
            return state.stickyActiveProvider === normalized.provider
              ? state
              : { stickyActiveProvider: normalized.provider };
          }
          return {
            stickyModelSelectionByProvider: nextMap,
            stickyActiveProvider: normalized.provider,
          };
        });
      },
      applyStickyState: (workspaceId) => {
        if (workspaceId.length === 0) {
          return;
        }
        set((state) => {
          const stickyMap = state.stickyModelSelectionByProvider;
          const stickyActiveProvider = state.stickyActiveProvider;
          if (Object.keys(stickyMap).length === 0 && stickyActiveProvider === null) {
            return state;
          }
          const existing = state.draftsByWorkspaceId[workspaceId];
          const base = existing ?? createEmptyWorkspaceDraft();
          const nextMap = { ...base.modelSelectionByProvider };
          for (const [provider, selection] of Object.entries(stickyMap)) {
            if (selection) {
              const current = nextMap[provider as ProviderKind];
              nextMap[provider as ProviderKind] = {
                ...selection,
                model: current?.model ?? selection.model,
              };
            }
          }
          if (
            Equal.equals(base.modelSelectionByProvider, nextMap) &&
            base.activeProvider === stickyActiveProvider
          ) {
            return state;
          }
          const nextDraft: ComposerWorkspaceDraftState = {
            ...base,
            modelSelectionByProvider: nextMap,
            activeProvider: stickyActiveProvider,
          };
          const nextDraftsByWorkspaceId = { ...state.draftsByWorkspaceId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByWorkspaceId[workspaceId];
          } else {
            nextDraftsByWorkspaceId[workspaceId] = nextDraft;
          }
          return { draftsByWorkspaceId: nextDraftsByWorkspaceId };
        });
      },
      setPrompt: (workspaceId, prompt) => {
        if (workspaceId.length === 0) {
          return;
        }
        set((state) => {
          const existing = state.draftsByWorkspaceId[workspaceId] ?? createEmptyWorkspaceDraft();
          const nextDraft: ComposerWorkspaceDraftState = {
            ...existing,
            prompt,
          };
          const nextDraftsByWorkspaceId = { ...state.draftsByWorkspaceId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByWorkspaceId[workspaceId];
          } else {
            nextDraftsByWorkspaceId[workspaceId] = nextDraft;
          }
          return { draftsByWorkspaceId: nextDraftsByWorkspaceId };
        });
      },
      setTerminalContexts: (workspaceId, contexts) => {
        if (workspaceId.length === 0) {
          return;
        }
        const normalizedContexts = normalizeTerminalContextsForWorkspace(workspaceId, contexts);
        set((state) => {
          const existing = state.draftsByWorkspaceId[workspaceId] ?? createEmptyWorkspaceDraft();
          const nextDraft: ComposerWorkspaceDraftState = {
            ...existing,
            prompt: ensureInlineTerminalContextPlaceholders(
              existing.prompt,
              normalizedContexts.length,
            ),
            terminalContexts: normalizedContexts,
          };
          const nextDraftsByWorkspaceId = { ...state.draftsByWorkspaceId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByWorkspaceId[workspaceId];
          } else {
            nextDraftsByWorkspaceId[workspaceId] = nextDraft;
          }
          return { draftsByWorkspaceId: nextDraftsByWorkspaceId };
        });
      },
      setModelSelection: (workspaceId, modelSelection) => {
        if (workspaceId.length === 0) {
          return;
        }
        const normalized = normalizeModelSelection(modelSelection);
        set((state) => {
          const existing = state.draftsByWorkspaceId[workspaceId];
          if (!existing && normalized === null) {
            return state;
          }
          const base = existing ?? createEmptyWorkspaceDraft();
          const nextMap = { ...base.modelSelectionByProvider };
          if (normalized) {
            const current = nextMap[normalized.provider];
            if (normalized.options !== undefined) {
              // Explicit options provided → use them
              nextMap[normalized.provider] = normalized;
            } else {
              // No options in selection → preserve existing options, update provider+model
              nextMap[normalized.provider] = {
                provider: normalized.provider,
                model: normalized.model,
                ...(current?.options ? { options: current.options } : {}),
              };
            }
          }
          const nextActiveProvider = normalized?.provider ?? base.activeProvider;
          if (
            Equal.equals(base.modelSelectionByProvider, nextMap) &&
            base.activeProvider === nextActiveProvider
          ) {
            return state;
          }
          const nextDraft: ComposerWorkspaceDraftState = {
            ...base,
            modelSelectionByProvider: nextMap,
            activeProvider: nextActiveProvider,
          };
          const nextDraftsByWorkspaceId = { ...state.draftsByWorkspaceId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByWorkspaceId[workspaceId];
          } else {
            nextDraftsByWorkspaceId[workspaceId] = nextDraft;
          }
          return { draftsByWorkspaceId: nextDraftsByWorkspaceId };
        });
      },
      setModelOptions: (workspaceId, modelOptions) => {
        if (workspaceId.length === 0) {
          return;
        }
        const normalizedOpts = normalizeProviderModelOptions(modelOptions);
        set((state) => {
          const existing = state.draftsByWorkspaceId[workspaceId];
          if (!existing && normalizedOpts === null) {
            return state;
          }
          const base = existing ?? createEmptyWorkspaceDraft();
          const nextMap = { ...base.modelSelectionByProvider };
          for (const provider of ["codex", "claudeAgent"] as const) {
            // Only touch providers explicitly present in the input
            if (!normalizedOpts || !(provider in normalizedOpts)) continue;
            const opts = normalizedOpts[provider];
            const current = nextMap[provider];
            if (opts) {
              nextMap[provider] = {
                provider,
                model: current?.model ?? DEFAULT_MODEL_BY_PROVIDER[provider],
                options: opts,
              };
            } else if (current?.options) {
              // Remove options but keep the selection
              const { options: _, ...rest } = current;
              nextMap[provider] = rest as ModelSelection;
            }
          }
          if (Equal.equals(base.modelSelectionByProvider, nextMap)) {
            return state;
          }
          const nextDraft: ComposerWorkspaceDraftState = {
            ...base,
            modelSelectionByProvider: nextMap,
          };
          const nextDraftsByWorkspaceId = { ...state.draftsByWorkspaceId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByWorkspaceId[workspaceId];
          } else {
            nextDraftsByWorkspaceId[workspaceId] = nextDraft;
          }
          return { draftsByWorkspaceId: nextDraftsByWorkspaceId };
        });
      },
      setProviderModelOptions: (workspaceId, provider, nextProviderOptions, options) => {
        if (workspaceId.length === 0) {
          return;
        }
        const normalizedProvider = normalizeProviderKind(provider);
        if (normalizedProvider === null) {
          return;
        }
        // Normalize just this provider's options
        const normalizedOpts = normalizeProviderModelOptions(
          { [normalizedProvider]: nextProviderOptions },
          normalizedProvider,
        );
        const providerOpts = normalizedOpts?.[normalizedProvider];

        set((state) => {
          const existing = state.draftsByWorkspaceId[workspaceId];
          const base = existing ?? createEmptyWorkspaceDraft();

          // Update the map entry for this provider
          const nextMap = { ...base.modelSelectionByProvider };
          const currentForProvider = nextMap[normalizedProvider];
          if (providerOpts) {
            nextMap[normalizedProvider] = {
              provider: normalizedProvider,
              model: currentForProvider?.model ?? DEFAULT_MODEL_BY_PROVIDER[normalizedProvider],
              options: providerOpts,
            };
          } else if (currentForProvider?.options) {
            const { options: _, ...rest } = currentForProvider;
            nextMap[normalizedProvider] = rest as ModelSelection;
          }

          // Handle sticky persistence
          let nextStickyMap = state.stickyModelSelectionByProvider;
          let nextStickyActiveProvider = state.stickyActiveProvider;
          if (options?.persistSticky === true) {
            nextStickyMap = { ...state.stickyModelSelectionByProvider };
            const stickyBase =
              nextStickyMap[normalizedProvider] ??
              base.modelSelectionByProvider[normalizedProvider] ??
              ({
                provider: normalizedProvider,
                model: DEFAULT_MODEL_BY_PROVIDER[normalizedProvider],
              } as ModelSelection);
            if (providerOpts) {
              nextStickyMap[normalizedProvider] = {
                ...stickyBase,
                provider: normalizedProvider,
                options: providerOpts,
              };
            } else if (stickyBase.options) {
              const { options: _, ...rest } = stickyBase;
              nextStickyMap[normalizedProvider] = rest as ModelSelection;
            }
            nextStickyActiveProvider = base.activeProvider ?? normalizedProvider;
          }

          if (
            Equal.equals(base.modelSelectionByProvider, nextMap) &&
            Equal.equals(state.stickyModelSelectionByProvider, nextStickyMap) &&
            state.stickyActiveProvider === nextStickyActiveProvider
          ) {
            return state;
          }

          const nextDraft: ComposerWorkspaceDraftState = {
            ...base,
            modelSelectionByProvider: nextMap,
          };
          const nextDraftsByWorkspaceId = { ...state.draftsByWorkspaceId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByWorkspaceId[workspaceId];
          } else {
            nextDraftsByWorkspaceId[workspaceId] = nextDraft;
          }

          return {
            draftsByWorkspaceId: nextDraftsByWorkspaceId,
            ...(options?.persistSticky === true
              ? {
                  stickyModelSelectionByProvider: nextStickyMap,
                  stickyActiveProvider: nextStickyActiveProvider,
                }
              : {}),
          };
        });
      },
      setRuntimeMode: (workspaceId, runtimeMode) => {
        if (workspaceId.length === 0) {
          return;
        }
        const nextRuntimeMode =
          runtimeMode === "approval-required" || runtimeMode === "full-access" ? runtimeMode : null;
        set((state) => {
          const existing = state.draftsByWorkspaceId[workspaceId];
          if (!existing && nextRuntimeMode === null) {
            return state;
          }
          const base = existing ?? createEmptyWorkspaceDraft();
          if (base.runtimeMode === nextRuntimeMode) {
            return state;
          }
          const nextDraft: ComposerWorkspaceDraftState = {
            ...base,
            runtimeMode: nextRuntimeMode,
          };
          const nextDraftsByWorkspaceId = { ...state.draftsByWorkspaceId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByWorkspaceId[workspaceId];
          } else {
            nextDraftsByWorkspaceId[workspaceId] = nextDraft;
          }
          return { draftsByWorkspaceId: nextDraftsByWorkspaceId };
        });
      },
      setInteractionMode: (workspaceId, interactionMode) => {
        if (workspaceId.length === 0) {
          return;
        }
        const nextInteractionMode =
          interactionMode === "plan" || interactionMode === "default" ? interactionMode : null;
        set((state) => {
          const existing = state.draftsByWorkspaceId[workspaceId];
          if (!existing && nextInteractionMode === null) {
            return state;
          }
          const base = existing ?? createEmptyWorkspaceDraft();
          if (base.interactionMode === nextInteractionMode) {
            return state;
          }
          const nextDraft: ComposerWorkspaceDraftState = {
            ...base,
            interactionMode: nextInteractionMode,
          };
          const nextDraftsByWorkspaceId = { ...state.draftsByWorkspaceId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByWorkspaceId[workspaceId];
          } else {
            nextDraftsByWorkspaceId[workspaceId] = nextDraft;
          }
          return { draftsByWorkspaceId: nextDraftsByWorkspaceId };
        });
      },
      addImage: (workspaceId, image) => {
        if (workspaceId.length === 0) {
          return;
        }
        get().addImages(workspaceId, [image]);
      },
      addImages: (workspaceId, images) => {
        if (workspaceId.length === 0 || images.length === 0) {
          return;
        }
        set((state) => {
          const existing = state.draftsByWorkspaceId[workspaceId] ?? createEmptyWorkspaceDraft();
          const existingIds = new Set(existing.images.map((image) => image.id));
          const existingDedupKeys = new Set(
            existing.images.map((image) => composerImageDedupKey(image)),
          );
          const acceptedPreviewUrls = new Set(existing.images.map((image) => image.previewUrl));
          const dedupedIncoming: ComposerImageAttachment[] = [];
          for (const image of images) {
            const dedupKey = composerImageDedupKey(image);
            if (existingIds.has(image.id) || existingDedupKeys.has(dedupKey)) {
              // Avoid revoking a blob URL that's still referenced by an accepted image.
              if (!acceptedPreviewUrls.has(image.previewUrl)) {
                revokeObjectPreviewUrl(image.previewUrl);
              }
              continue;
            }
            dedupedIncoming.push(image);
            existingIds.add(image.id);
            existingDedupKeys.add(dedupKey);
            acceptedPreviewUrls.add(image.previewUrl);
          }
          if (dedupedIncoming.length === 0) {
            return state;
          }
          return {
            draftsByWorkspaceId: {
              ...state.draftsByWorkspaceId,
              [workspaceId]: {
                ...existing,
                images: [...existing.images, ...dedupedIncoming],
              },
            },
          };
        });
      },
      removeImage: (workspaceId, imageId) => {
        if (workspaceId.length === 0) {
          return;
        }
        const existing = get().draftsByWorkspaceId[workspaceId];
        if (!existing) {
          return;
        }
        const removedImage = existing.images.find((image) => image.id === imageId);
        if (removedImage) {
          revokeObjectPreviewUrl(removedImage.previewUrl);
        }
        set((state) => {
          const current = state.draftsByWorkspaceId[workspaceId];
          if (!current) {
            return state;
          }
          const nextDraft: ComposerWorkspaceDraftState = {
            ...current,
            images: current.images.filter((image) => image.id !== imageId),
            nonPersistedImageIds: current.nonPersistedImageIds.filter((id) => id !== imageId),
            persistedAttachments: current.persistedAttachments.filter(
              (attachment) => attachment.id !== imageId,
            ),
          };
          const nextDraftsByWorkspaceId = { ...state.draftsByWorkspaceId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByWorkspaceId[workspaceId];
          } else {
            nextDraftsByWorkspaceId[workspaceId] = nextDraft;
          }
          return { draftsByWorkspaceId: nextDraftsByWorkspaceId };
        });
      },
      insertTerminalContext: (workspaceId, prompt, context, index) => {
        if (workspaceId.length === 0) {
          return false;
        }
        let inserted = false;
        set((state) => {
          const existing = state.draftsByWorkspaceId[workspaceId] ?? createEmptyWorkspaceDraft();
          const normalizedContext = normalizeTerminalContextForWorkspace(workspaceId, context);
          if (!normalizedContext) {
            return state;
          }
          const dedupKey = terminalContextDedupKey(normalizedContext);
          if (
            existing.terminalContexts.some((entry) => entry.id === normalizedContext.id) ||
            existing.terminalContexts.some((entry) => terminalContextDedupKey(entry) === dedupKey)
          ) {
            return state;
          }
          inserted = true;
          const boundedIndex = Math.max(0, Math.min(existing.terminalContexts.length, index));
          const nextDraft: ComposerWorkspaceDraftState = {
            ...existing,
            prompt,
            terminalContexts: [
              ...existing.terminalContexts.slice(0, boundedIndex),
              normalizedContext,
              ...existing.terminalContexts.slice(boundedIndex),
            ],
          };
          return {
            draftsByWorkspaceId: {
              ...state.draftsByWorkspaceId,
              [workspaceId]: nextDraft,
            },
          };
        });
        return inserted;
      },
      addTerminalContext: (workspaceId, context) => {
        if (workspaceId.length === 0) {
          return;
        }
        get().addTerminalContexts(workspaceId, [context]);
      },
      addTerminalContexts: (workspaceId, contexts) => {
        if (workspaceId.length === 0 || contexts.length === 0) {
          return;
        }
        set((state) => {
          const existing = state.draftsByWorkspaceId[workspaceId] ?? createEmptyWorkspaceDraft();
          const acceptedContexts = normalizeTerminalContextsForWorkspace(workspaceId, [
            ...existing.terminalContexts,
            ...contexts,
          ]).slice(existing.terminalContexts.length);
          if (acceptedContexts.length === 0) {
            return state;
          }
          return {
            draftsByWorkspaceId: {
              ...state.draftsByWorkspaceId,
              [workspaceId]: {
                ...existing,
                prompt: ensureInlineTerminalContextPlaceholders(
                  existing.prompt,
                  existing.terminalContexts.length + acceptedContexts.length,
                ),
                terminalContexts: [...existing.terminalContexts, ...acceptedContexts],
              },
            },
          };
        });
      },
      removeTerminalContext: (workspaceId, contextId) => {
        if (workspaceId.length === 0 || contextId.length === 0) {
          return;
        }
        set((state) => {
          const current = state.draftsByWorkspaceId[workspaceId];
          if (!current) {
            return state;
          }
          const nextDraft: ComposerWorkspaceDraftState = {
            ...current,
            terminalContexts: current.terminalContexts.filter(
              (context) => context.id !== contextId,
            ),
          };
          const nextDraftsByWorkspaceId = { ...state.draftsByWorkspaceId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByWorkspaceId[workspaceId];
          } else {
            nextDraftsByWorkspaceId[workspaceId] = nextDraft;
          }
          return { draftsByWorkspaceId: nextDraftsByWorkspaceId };
        });
      },
      clearTerminalContexts: (workspaceId) => {
        if (workspaceId.length === 0) {
          return;
        }
        set((state) => {
          const current = state.draftsByWorkspaceId[workspaceId];
          if (!current || current.terminalContexts.length === 0) {
            return state;
          }
          const nextDraft: ComposerWorkspaceDraftState = {
            ...current,
            terminalContexts: [],
          };
          const nextDraftsByWorkspaceId = { ...state.draftsByWorkspaceId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByWorkspaceId[workspaceId];
          } else {
            nextDraftsByWorkspaceId[workspaceId] = nextDraft;
          }
          return { draftsByWorkspaceId: nextDraftsByWorkspaceId };
        });
      },
      clearPersistedAttachments: (workspaceId) => {
        if (workspaceId.length === 0) {
          return;
        }
        set((state) => {
          const current = state.draftsByWorkspaceId[workspaceId];
          if (!current) {
            return state;
          }
          const nextDraft: ComposerWorkspaceDraftState = {
            ...current,
            persistedAttachments: [],
            nonPersistedImageIds: [],
          };
          const nextDraftsByWorkspaceId = { ...state.draftsByWorkspaceId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByWorkspaceId[workspaceId];
          } else {
            nextDraftsByWorkspaceId[workspaceId] = nextDraft;
          }
          return { draftsByWorkspaceId: nextDraftsByWorkspaceId };
        });
      },
      syncPersistedAttachments: (workspaceId, attachments) => {
        if (workspaceId.length === 0) {
          return;
        }
        const attachmentIdSet = new Set(attachments.map((attachment) => attachment.id));
        set((state) => {
          const current = state.draftsByWorkspaceId[workspaceId];
          if (!current) {
            return state;
          }
          const nextDraft: ComposerWorkspaceDraftState = {
            ...current,
            // Stage attempted attachments so persist middleware can try writing them.
            persistedAttachments: attachments,
            nonPersistedImageIds: current.nonPersistedImageIds.filter(
              (id) => !attachmentIdSet.has(id),
            ),
          };
          const nextDraftsByWorkspaceId = { ...state.draftsByWorkspaceId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByWorkspaceId[workspaceId];
          } else {
            nextDraftsByWorkspaceId[workspaceId] = nextDraft;
          }
          return { draftsByWorkspaceId: nextDraftsByWorkspaceId };
        });
        Promise.resolve().then(() => {
          verifyPersistedAttachments(workspaceId, attachments, set);
        });
      },
      clearComposerContent: (workspaceId) => {
        if (workspaceId.length === 0) {
          return;
        }
        set((state) => {
          const current = state.draftsByWorkspaceId[workspaceId];
          if (!current) {
            return state;
          }
          const nextDraft: ComposerWorkspaceDraftState = {
            ...current,
            prompt: "",
            images: [],
            nonPersistedImageIds: [],
            persistedAttachments: [],
            terminalContexts: [],
          };
          const nextDraftsByWorkspaceId = { ...state.draftsByWorkspaceId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByWorkspaceId[workspaceId];
          } else {
            nextDraftsByWorkspaceId[workspaceId] = nextDraft;
          }
          return { draftsByWorkspaceId: nextDraftsByWorkspaceId };
        });
      },
    }),
    {
      name: COMPOSER_DRAFT_STORAGE_KEY,
      version: COMPOSER_DRAFT_STORAGE_VERSION,
      storage: createJSONStorage(() => composerDebouncedStorage),
      migrate: migratePersistedComposerDraftStoreState,
      partialize: partializeComposerDraftStoreState,
      merge: (persistedState, currentState) => {
        const normalizedPersisted =
          normalizeCurrentPersistedComposerDraftStoreState(persistedState);
        const draftsByWorkspaceId = Object.fromEntries(
          Object.entries(normalizedPersisted.draftsByWorkspaceId).map(([workspaceId, draft]) => [
            workspaceId,
            toHydratedWorkspaceDraft(draft),
          ]),
        );
        return {
          ...currentState,
          draftsByWorkspaceId,
          draftWorkspacesByWorkspaceId: normalizedPersisted.draftWorkspacesByWorkspaceId,
          projectDraftWorkspaceIdByProjectId:
            normalizedPersisted.projectDraftWorkspaceIdByProjectId,
          stickyModelSelectionByProvider: normalizedPersisted.stickyModelSelectionByProvider ?? {},
          stickyActiveProvider: normalizedPersisted.stickyActiveProvider ?? null,
        };
      },
    },
  ),
);

export function useComposerWorkspaceDraft(workspaceId: WorkspaceId): ComposerWorkspaceDraftState {
  return useComposerDraftStore(
    (state) => state.draftsByWorkspaceId[workspaceId] ?? EMPTY_WORKSPACE_DRAFT,
  );
}

export function useEffectiveComposerModelState(input: {
  workspaceId: WorkspaceId;
  providers: ReadonlyArray<ServerProvider>;
  selectedProvider: ProviderKind;
  workspaceModelSelection: ModelSelection | null | undefined;
  projectModelSelection: ModelSelection | null | undefined;
  settings: UnifiedSettings;
}): EffectiveComposerModelState {
  const draft = useComposerWorkspaceDraft(input.workspaceId);

  return useMemo(
    () =>
      deriveEffectiveComposerModelState({
        draft,
        providers: input.providers,
        selectedProvider: input.selectedProvider,
        workspaceModelSelection: input.workspaceModelSelection,
        projectModelSelection: input.projectModelSelection,
        settings: input.settings,
      }),
    [
      draft,
      input.providers,
      input.settings,
      input.projectModelSelection,
      input.selectedProvider,
      input.workspaceModelSelection,
    ],
  );
}

/**
 * Clear a draft workspace once the server has materialized the same workspace id.
 *
 * Use the single-workspace helper for live `workspace.created` events and the
 * iterable helper for bootstrap/recovery paths that discover multiple server
 * workspaces at once.
 */
export function clearPromotedDraftWorkspace(workspaceId: WorkspaceId): void {
  if (!useComposerDraftStore.getState().getDraftWorkspace(workspaceId)) {
    return;
  }
  useComposerDraftStore.getState().clearDraftWorkspace(workspaceId);
}

export function clearPromotedDraftWorkspaces(serverWorkspaceIds: Iterable<WorkspaceId>): void {
  for (const workspaceId of serverWorkspaceIds) {
    clearPromotedDraftWorkspace(workspaceId);
  }
}
