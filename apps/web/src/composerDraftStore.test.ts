import * as Schema from "effect/Schema";
import {
  ProjectId,
  WorkspaceId,
  type ModelSelection,
  type ProviderModelOptions,
} from "@matcha/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  COMPOSER_DRAFT_STORAGE_KEY,
  clearPromotedDraftWorkspace,
  clearPromotedDraftWorkspaces,
  type ComposerImageAttachment,
  useComposerDraftStore,
} from "./composerDraftStore";
import { removeLocalStorageItem, setLocalStorageItem } from "./hooks/useLocalStorage";
import {
  INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
  insertInlineTerminalContextPlaceholder,
  type TerminalContextDraft,
} from "./lib/terminalContext";
import { createDebouncedStorage } from "./lib/storage";

function makeImage(input: {
  id: string;
  previewUrl: string;
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
  lastModified?: number;
}): ComposerImageAttachment {
  const name = input.name ?? "image.png";
  const mimeType = input.mimeType ?? "image/png";
  const sizeBytes = input.sizeBytes ?? 4;
  const lastModified = input.lastModified ?? 1_700_000_000_000;
  const file = new File([new Uint8Array(sizeBytes).fill(1)], name, {
    type: mimeType,
    lastModified,
  });
  return {
    type: "image",
    id: input.id,
    name,
    mimeType,
    sizeBytes: file.size,
    previewUrl: input.previewUrl,
    file,
  };
}

function makeTerminalContext(input: {
  id: string;
  text?: string;
  terminalId?: string;
  terminalLabel?: string;
  lineStart?: number;
  lineEnd?: number;
}): TerminalContextDraft {
  return {
    id: input.id,
    workspaceId: WorkspaceId.makeUnsafe("workspace-dedupe"),
    terminalId: input.terminalId ?? "default",
    terminalLabel: input.terminalLabel ?? "Terminal 1",
    lineStart: input.lineStart ?? 4,
    lineEnd: input.lineEnd ?? 5,
    text: input.text ?? "git status\nOn branch main",
    createdAt: "2026-03-13T12:00:00.000Z",
  };
}

function resetComposerDraftStore() {
  useComposerDraftStore.setState({
    draftsByWorkspaceId: {},
    draftWorkspacesByWorkspaceId: {},
    projectDraftWorkspaceIdByProjectId: {},
    stickyModelSelectionByProvider: {},
    stickyActiveProvider: null,
  });
}

function modelSelection(
  provider: "codex" | "claudeAgent",
  model: string,
  options?: ModelSelection["options"],
): ModelSelection {
  return {
    provider,
    model,
    ...(options ? { options } : {}),
  } as ModelSelection;
}

function providerModelOptions(options: ProviderModelOptions): ProviderModelOptions {
  return options;
}

describe("composerDraftStore addImages", () => {
  const workspaceId = WorkspaceId.makeUnsafe("workspace-dedupe");
  let originalRevokeObjectUrl: typeof URL.revokeObjectURL;
  let revokeSpy: ReturnType<typeof vi.fn<(url: string) => void>>;

  beforeEach(() => {
    resetComposerDraftStore();
    originalRevokeObjectUrl = URL.revokeObjectURL;
    revokeSpy = vi.fn();
    URL.revokeObjectURL = revokeSpy;
  });

  afterEach(() => {
    URL.revokeObjectURL = originalRevokeObjectUrl;
  });

  it("deduplicates identical images in one batch by file signature", () => {
    const first = makeImage({
      id: "img-1",
      previewUrl: "blob:first",
      name: "same.png",
      mimeType: "image/png",
      sizeBytes: 12,
      lastModified: 12345,
    });
    const duplicate = makeImage({
      id: "img-2",
      previewUrl: "blob:duplicate",
      name: "same.png",
      mimeType: "image/png",
      sizeBytes: 12,
      lastModified: 12345,
    });

    useComposerDraftStore.getState().addImages(workspaceId, [first, duplicate]);

    const draft = useComposerDraftStore.getState().draftsByWorkspaceId[workspaceId];
    expect(draft?.images.map((image) => image.id)).toEqual(["img-1"]);
    expect(revokeSpy).toHaveBeenCalledWith("blob:duplicate");
  });

  it("deduplicates against existing images across calls by file signature", () => {
    const first = makeImage({
      id: "img-a",
      previewUrl: "blob:a",
      name: "same.png",
      mimeType: "image/png",
      sizeBytes: 9,
      lastModified: 777,
    });
    const duplicateLater = makeImage({
      id: "img-b",
      previewUrl: "blob:b",
      name: "same.png",
      mimeType: "image/png",
      sizeBytes: 9,
      lastModified: 999,
    });

    useComposerDraftStore.getState().addImage(workspaceId, first);
    useComposerDraftStore.getState().addImage(workspaceId, duplicateLater);

    const draft = useComposerDraftStore.getState().draftsByWorkspaceId[workspaceId];
    expect(draft?.images.map((image) => image.id)).toEqual(["img-a"]);
    expect(revokeSpy).toHaveBeenCalledWith("blob:b");
  });

  it("does not revoke blob URLs that are still used by an accepted duplicate image", () => {
    const first = makeImage({
      id: "img-shared",
      previewUrl: "blob:shared",
    });
    const duplicateSameUrl = makeImage({
      id: "img-shared",
      previewUrl: "blob:shared",
    });

    useComposerDraftStore.getState().addImages(workspaceId, [first, duplicateSameUrl]);

    const draft = useComposerDraftStore.getState().draftsByWorkspaceId[workspaceId];
    expect(draft?.images.map((image) => image.id)).toEqual(["img-shared"]);
    expect(revokeSpy).not.toHaveBeenCalledWith("blob:shared");
  });
});

describe("composerDraftStore clearComposerContent", () => {
  const workspaceId = WorkspaceId.makeUnsafe("workspace-clear");
  let originalRevokeObjectUrl: typeof URL.revokeObjectURL;
  let revokeSpy: ReturnType<typeof vi.fn<(url: string) => void>>;

  beforeEach(() => {
    resetComposerDraftStore();
    originalRevokeObjectUrl = URL.revokeObjectURL;
    revokeSpy = vi.fn();
    URL.revokeObjectURL = revokeSpy;
  });

  afterEach(() => {
    URL.revokeObjectURL = originalRevokeObjectUrl;
  });

  it("does not revoke blob preview URLs when clearing composer content", () => {
    const first = makeImage({
      id: "img-optimistic",
      previewUrl: "blob:optimistic",
    });
    useComposerDraftStore.getState().addImage(workspaceId, first);

    useComposerDraftStore.getState().clearComposerContent(workspaceId);

    const draft = useComposerDraftStore.getState().draftsByWorkspaceId[workspaceId];
    expect(draft).toBeUndefined();
    expect(revokeSpy).not.toHaveBeenCalledWith("blob:optimistic");
  });
});

describe("composerDraftStore syncPersistedAttachments", () => {
  const workspaceId = WorkspaceId.makeUnsafe("workspace-sync-persisted");

  beforeEach(() => {
    removeLocalStorageItem(COMPOSER_DRAFT_STORAGE_KEY);
    useComposerDraftStore.setState({
      draftsByWorkspaceId: {},
      draftWorkspacesByWorkspaceId: {},
      projectDraftWorkspaceIdByProjectId: {},
      stickyModelSelectionByProvider: {},
      stickyActiveProvider: null,
    });
  });

  afterEach(() => {
    removeLocalStorageItem(COMPOSER_DRAFT_STORAGE_KEY);
  });

  it("treats malformed persisted draft storage as empty", async () => {
    const image = makeImage({
      id: "img-persisted",
      previewUrl: "blob:persisted",
    });
    useComposerDraftStore.getState().addImage(workspaceId, image);
    setLocalStorageItem(
      COMPOSER_DRAFT_STORAGE_KEY,
      {
        version: 2,
        state: {
          draftsByWorkspaceId: {
            [workspaceId]: {
              attachments: "not-an-array",
            },
          },
        },
      },
      Schema.Unknown,
    );

    useComposerDraftStore.getState().syncPersistedAttachments(workspaceId, [
      {
        id: image.id,
        name: image.name,
        mimeType: image.mimeType,
        sizeBytes: image.sizeBytes,
        dataUrl: image.previewUrl,
      },
    ]);
    await Promise.resolve();

    expect(
      useComposerDraftStore.getState().draftsByWorkspaceId[workspaceId]?.persistedAttachments,
    ).toEqual([]);
    expect(
      useComposerDraftStore.getState().draftsByWorkspaceId[workspaceId]?.nonPersistedImageIds,
    ).toEqual([image.id]);
  });
});

describe("composerDraftStore terminal contexts", () => {
  const workspaceId = WorkspaceId.makeUnsafe("workspace-dedupe");

  beforeEach(() => {
    useComposerDraftStore.setState({
      draftsByWorkspaceId: {},
      draftWorkspacesByWorkspaceId: {},
      projectDraftWorkspaceIdByProjectId: {},
      stickyModelSelectionByProvider: {},
      stickyActiveProvider: null,
    });
  });

  it("deduplicates identical terminal contexts by selection signature", () => {
    const first = makeTerminalContext({ id: "ctx-1" });
    const duplicate = makeTerminalContext({ id: "ctx-2" });

    useComposerDraftStore.getState().addTerminalContexts(workspaceId, [first, duplicate]);

    const draft = useComposerDraftStore.getState().draftsByWorkspaceId[workspaceId];
    expect(draft?.terminalContexts.map((context) => context.id)).toEqual(["ctx-1"]);
  });

  it("clears terminal contexts when clearing composer content", () => {
    useComposerDraftStore
      .getState()
      .addTerminalContext(workspaceId, makeTerminalContext({ id: "ctx-1" }));

    useComposerDraftStore.getState().clearComposerContent(workspaceId);

    expect(useComposerDraftStore.getState().draftsByWorkspaceId[workspaceId]).toBeUndefined();
  });

  it("inserts terminal contexts at the requested inline prompt position", () => {
    const firstInsertion = insertInlineTerminalContextPlaceholder("alpha beta", 6);
    const secondInsertion = insertInlineTerminalContextPlaceholder(firstInsertion.prompt, 0);

    expect(
      useComposerDraftStore
        .getState()
        .insertTerminalContext(
          workspaceId,
          firstInsertion.prompt,
          makeTerminalContext({ id: "ctx-1" }),
          firstInsertion.contextIndex,
        ),
    ).toBe(true);
    expect(
      useComposerDraftStore.getState().insertTerminalContext(
        workspaceId,
        secondInsertion.prompt,
        makeTerminalContext({
          id: "ctx-2",
          terminalLabel: "Terminal 2",
          lineStart: 9,
          lineEnd: 10,
        }),
        secondInsertion.contextIndex,
      ),
    ).toBe(true);

    const draft = useComposerDraftStore.getState().draftsByWorkspaceId[workspaceId];
    expect(draft?.prompt).toBe(
      `${INLINE_TERMINAL_CONTEXT_PLACEHOLDER} alpha ${INLINE_TERMINAL_CONTEXT_PLACEHOLDER} beta`,
    );
    expect(draft?.terminalContexts.map((context) => context.id)).toEqual(["ctx-2", "ctx-1"]);
  });

  it("omits terminal context text from persisted drafts", () => {
    useComposerDraftStore
      .getState()
      .addTerminalContext(workspaceId, makeTerminalContext({ id: "ctx-persist" }));

    const persistApi = useComposerDraftStore.persist as unknown as {
      getOptions: () => {
        partialize: (state: ReturnType<typeof useComposerDraftStore.getState>) => unknown;
      };
    };
    const persistedState = persistApi.getOptions().partialize(useComposerDraftStore.getState()) as {
      draftsByWorkspaceId?: Record<string, { terminalContexts?: Array<Record<string, unknown>> }>;
    };

    expect(
      persistedState.draftsByWorkspaceId?.[workspaceId]?.terminalContexts?.[0],
      "Expected terminal context metadata to be persisted.",
    ).toMatchObject({
      id: "ctx-persist",
      terminalId: "default",
      terminalLabel: "Terminal 1",
      lineStart: 4,
      lineEnd: 5,
    });
    expect(
      persistedState.draftsByWorkspaceId?.[workspaceId]?.terminalContexts?.[0]?.text,
    ).toBeUndefined();
  });

  it("hydrates persisted terminal contexts without in-memory snapshot text", () => {
    const persistApi = useComposerDraftStore.persist as unknown as {
      getOptions: () => {
        merge: (
          persistedState: unknown,
          currentState: ReturnType<typeof useComposerDraftStore.getState>,
        ) => ReturnType<typeof useComposerDraftStore.getState>;
      };
    };
    const mergedState = persistApi.getOptions().merge(
      {
        draftsByWorkspaceId: {
          [workspaceId]: {
            prompt: INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
            attachments: [],
            terminalContexts: [
              {
                id: "ctx-rehydrated",
                workspaceId,
                createdAt: "2026-03-13T12:00:00.000Z",
                terminalId: "default",
                terminalLabel: "Terminal 1",
                lineStart: 4,
                lineEnd: 5,
              },
            ],
          },
        },
        draftWorkspacesByWorkspaceId: {},
        projectDraftWorkspaceIdByProjectId: {},
      },
      useComposerDraftStore.getInitialState(),
    );

    expect(mergedState.draftsByWorkspaceId[workspaceId]?.terminalContexts).toMatchObject([
      {
        id: "ctx-rehydrated",
        terminalId: "default",
        terminalLabel: "Terminal 1",
        lineStart: 4,
        lineEnd: 5,
        text: "",
      },
    ]);
  });

  it("sanitizes malformed persisted drafts during merge", () => {
    const persistApi = useComposerDraftStore.persist as unknown as {
      getOptions: () => {
        merge: (
          persistedState: unknown,
          currentState: ReturnType<typeof useComposerDraftStore.getState>,
        ) => ReturnType<typeof useComposerDraftStore.getState>;
      };
    };
    const mergedState = persistApi.getOptions().merge(
      {
        draftsByWorkspaceId: {
          [workspaceId]: {
            prompt: "",
            attachments: "not-an-array",
            terminalContexts: "not-an-array",
            provider: "bogus-provider",
            modelOptions: "not-an-object",
          },
        },
        draftWorkspacesByWorkspaceId: "not-an-object",
        projectDraftWorkspaceIdByProjectId: "not-an-object",
      },
      useComposerDraftStore.getInitialState(),
    );

    expect(mergedState.draftsByWorkspaceId[workspaceId]).toBeUndefined();
    expect(mergedState.draftWorkspacesByWorkspaceId).toEqual({});
    expect(mergedState.projectDraftWorkspaceIdByProjectId).toEqual({});
  });
});

describe("composerDraftStore project draft workspace mapping", () => {
  const projectId = ProjectId.makeUnsafe("project-a");
  const otherProjectId = ProjectId.makeUnsafe("project-b");
  const workspaceId = WorkspaceId.makeUnsafe("workspace-a");
  const otherWorkspaceId = WorkspaceId.makeUnsafe("workspace-b");

  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("stores and reads project draft workspace ids via actions", () => {
    const store = useComposerDraftStore.getState();
    expect(store.getDraftWorkspaceByProjectId(projectId)).toBeNull();
    expect(store.getDraftWorkspace(workspaceId)).toBeNull();

    store.setProjectDraftWorkspaceId(projectId, workspaceId, {
      branch: "feature/test",
      worktreePath: "/tmp/worktree-test",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(useComposerDraftStore.getState().getDraftWorkspaceByProjectId(projectId)).toEqual({
      workspaceId,
      projectId,
      branch: "feature/test",
      worktreePath: "/tmp/worktree-test",
      envMode: "worktree",
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(useComposerDraftStore.getState().getDraftWorkspace(workspaceId)).toEqual({
      projectId,
      branch: "feature/test",
      worktreePath: "/tmp/worktree-test",
      envMode: "worktree",
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("can register a standalone draft workspace without replacing the project draft mapping", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftWorkspaceId(projectId, workspaceId, {
      branch: "feature/original",
    });

    store.upsertDraftWorkspace(otherWorkspaceId, {
      projectId,
      branch: "feature/secondary",
      createdAt: "2026-01-02T00:00:00.000Z",
    });

    expect(
      useComposerDraftStore.getState().getDraftWorkspaceByProjectId(projectId)?.workspaceId,
    ).toBe(workspaceId);
    expect(useComposerDraftStore.getState().getDraftWorkspace(workspaceId)).toMatchObject({
      projectId,
      branch: "feature/original",
    });
    expect(useComposerDraftStore.getState().getDraftWorkspace(otherWorkspaceId)).toMatchObject({
      projectId,
      branch: "feature/secondary",
      createdAt: "2026-01-02T00:00:00.000Z",
    });
  });

  it("clears only matching project draft mapping entries", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftWorkspaceId(projectId, workspaceId);
    store.setPrompt(workspaceId, "hello");

    store.clearProjectDraftWorkspaceById(projectId, otherWorkspaceId);
    expect(
      useComposerDraftStore.getState().getDraftWorkspaceByProjectId(projectId)?.workspaceId,
    ).toBe(workspaceId);

    store.clearProjectDraftWorkspaceById(projectId, workspaceId);
    expect(useComposerDraftStore.getState().getDraftWorkspaceByProjectId(projectId)).toBeNull();
    expect(useComposerDraftStore.getState().getDraftWorkspace(workspaceId)).toBeNull();
    expect(useComposerDraftStore.getState().draftsByWorkspaceId[workspaceId]).toBeUndefined();
  });

  it("clears project draft mapping by project id", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftWorkspaceId(projectId, workspaceId);
    store.setPrompt(workspaceId, "hello");
    store.clearProjectDraftWorkspaceId(projectId);
    expect(useComposerDraftStore.getState().getDraftWorkspaceByProjectId(projectId)).toBeNull();
    expect(useComposerDraftStore.getState().getDraftWorkspace(workspaceId)).toBeNull();
    expect(useComposerDraftStore.getState().draftsByWorkspaceId[workspaceId]).toBeUndefined();
  });

  it("clears orphaned composer drafts when remapping a project to a new draft workspace", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftWorkspaceId(projectId, workspaceId);
    store.setPrompt(workspaceId, "orphan me");

    store.setProjectDraftWorkspaceId(projectId, otherWorkspaceId);

    expect(
      useComposerDraftStore.getState().getDraftWorkspaceByProjectId(projectId)?.workspaceId,
    ).toBe(otherWorkspaceId);
    expect(useComposerDraftStore.getState().getDraftWorkspace(workspaceId)).toBeNull();
    expect(useComposerDraftStore.getState().draftsByWorkspaceId[workspaceId]).toBeUndefined();
  });

  it("keeps composer drafts when the workspace is still mapped by another project", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftWorkspaceId(projectId, workspaceId);
    store.setProjectDraftWorkspaceId(otherProjectId, workspaceId);
    store.setPrompt(workspaceId, "keep me");

    store.clearProjectDraftWorkspaceId(projectId);

    expect(useComposerDraftStore.getState().getDraftWorkspaceByProjectId(projectId)).toBeNull();
    expect(
      useComposerDraftStore.getState().getDraftWorkspaceByProjectId(otherProjectId)?.workspaceId,
    ).toBe(workspaceId);
    expect(useComposerDraftStore.getState().draftsByWorkspaceId[workspaceId]?.prompt).toBe(
      "keep me",
    );
  });

  it("clears draft registration independently", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftWorkspaceId(projectId, workspaceId);
    store.setPrompt(workspaceId, "remove me");
    store.clearDraftWorkspace(workspaceId);
    expect(useComposerDraftStore.getState().getDraftWorkspaceByProjectId(projectId)).toBeNull();
    expect(useComposerDraftStore.getState().getDraftWorkspace(workspaceId)).toBeNull();
    expect(useComposerDraftStore.getState().draftsByWorkspaceId[workspaceId]).toBeUndefined();
  });

  it("clears a promoted draft by workspace id", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftWorkspaceId(projectId, workspaceId);
    store.setPrompt(workspaceId, "promote me");

    clearPromotedDraftWorkspace(workspaceId);

    expect(useComposerDraftStore.getState().getDraftWorkspaceByProjectId(projectId)).toBeNull();
    expect(useComposerDraftStore.getState().getDraftWorkspace(workspaceId)).toBeNull();
    expect(useComposerDraftStore.getState().draftsByWorkspaceId[workspaceId]).toBeUndefined();
  });

  it("does not clear composer drafts for existing server workspaces during promotion cleanup", () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(workspaceId, "keep me");

    clearPromotedDraftWorkspace(workspaceId);

    expect(useComposerDraftStore.getState().getDraftWorkspace(workspaceId)).toBeNull();
    expect(useComposerDraftStore.getState().draftsByWorkspaceId[workspaceId]?.prompt).toBe(
      "keep me",
    );
  });

  it("clears promoted drafts from an iterable of server workspace ids", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftWorkspaceId(projectId, workspaceId);
    store.setPrompt(workspaceId, "promote me");
    store.setProjectDraftWorkspaceId(otherProjectId, otherWorkspaceId);
    store.setPrompt(otherWorkspaceId, "keep me");

    clearPromotedDraftWorkspaces([workspaceId]);

    expect(useComposerDraftStore.getState().getDraftWorkspace(workspaceId)).toBeNull();
    expect(useComposerDraftStore.getState().draftsByWorkspaceId[workspaceId]).toBeUndefined();
    expect(
      useComposerDraftStore.getState().getDraftWorkspaceByProjectId(otherProjectId)?.workspaceId,
    ).toBe(otherWorkspaceId);
    expect(useComposerDraftStore.getState().draftsByWorkspaceId[otherWorkspaceId]?.prompt).toBe(
      "keep me",
    );
  });

  it("keeps existing server-workspace composer drafts during iterable promotion cleanup", () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(workspaceId, "keep me");

    clearPromotedDraftWorkspaces([workspaceId]);

    expect(useComposerDraftStore.getState().getDraftWorkspace(workspaceId)).toBeNull();
    expect(useComposerDraftStore.getState().draftsByWorkspaceId[workspaceId]?.prompt).toBe(
      "keep me",
    );
  });

  it("updates branch context on an existing draft workspace", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftWorkspaceId(projectId, workspaceId, {
      branch: "main",
      worktreePath: null,
    });
    store.setDraftWorkspaceContext(workspaceId, {
      branch: "feature/next",
      worktreePath: "/tmp/feature-next",
    });
    expect(
      useComposerDraftStore.getState().getDraftWorkspaceByProjectId(projectId)?.workspaceId,
    ).toBe(workspaceId);
    expect(useComposerDraftStore.getState().getDraftWorkspace(workspaceId)).toMatchObject({
      projectId,
      branch: "feature/next",
      worktreePath: "/tmp/feature-next",
      envMode: "worktree",
    });
  });

  it("preserves existing branch and worktree when setProjectDraftWorkspaceId receives undefined", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftWorkspaceId(projectId, workspaceId, {
      branch: "main",
      worktreePath: "/tmp/main-worktree",
    });
    const runtimeUndefinedOptions = {
      branch: undefined,
      worktreePath: undefined,
    } as unknown as {
      branch?: string | null;
      worktreePath?: string | null;
    };
    store.setProjectDraftWorkspaceId(projectId, workspaceId, runtimeUndefinedOptions);

    expect(useComposerDraftStore.getState().getDraftWorkspace(workspaceId)).toMatchObject({
      projectId,
      branch: "main",
      worktreePath: "/tmp/main-worktree",
      envMode: "worktree",
    });
  });

  it("preserves worktree env mode without a worktree path", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftWorkspaceId(projectId, workspaceId, {
      branch: "feature/base",
      worktreePath: null,
      envMode: "worktree",
    });
    const runtimeUndefinedOptions = {
      branch: undefined,
      worktreePath: undefined,
      envMode: undefined,
    } as unknown as {
      branch?: string | null;
      worktreePath?: string | null;
      envMode?: "local" | "worktree";
    };
    store.setProjectDraftWorkspaceId(projectId, workspaceId, runtimeUndefinedOptions);

    expect(useComposerDraftStore.getState().getDraftWorkspace(workspaceId)).toMatchObject({
      projectId,
      branch: "feature/base",
      worktreePath: null,
      envMode: "worktree",
    });
  });
});

describe("composerDraftStore modelSelection", () => {
  const workspaceId = WorkspaceId.makeUnsafe("workspace-model-options");

  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("stores a model selection in the draft", () => {
    const store = useComposerDraftStore.getState();
    store.setModelSelection(
      workspaceId,
      modelSelection("codex", "gpt-5.3-codex", {
        reasoningEffort: "xhigh",
        fastMode: true,
      }),
    );

    expect(
      useComposerDraftStore.getState().draftsByWorkspaceId[workspaceId]?.modelSelectionByProvider
        .codex,
    ).toEqual(
      modelSelection("codex", "gpt-5.3-codex", {
        reasoningEffort: "xhigh",
        fastMode: true,
      }),
    );
  });

  it("keeps default-only model selections on the draft", () => {
    const store = useComposerDraftStore.getState();
    store.setModelSelection(workspaceId, modelSelection("codex", "gpt-5.4"));

    expect(
      useComposerDraftStore.getState().draftsByWorkspaceId[workspaceId]?.modelSelectionByProvider
        .codex,
    ).toEqual(modelSelection("codex", "gpt-5.4"));
  });

  it("replaces only the targeted provider options on the current model selection", () => {
    const store = useComposerDraftStore.getState();

    store.setModelSelection(
      workspaceId,
      modelSelection("claudeAgent", "claude-opus-4-6", {
        effort: "max",
        fastMode: true,
      }),
    );
    store.setStickyModelSelection(
      modelSelection("claudeAgent", "claude-opus-4-6", {
        effort: "max",
        fastMode: true,
      }),
    );

    store.setProviderModelOptions(
      workspaceId,
      "claudeAgent",
      {
        thinking: false,
      },
      { persistSticky: true },
    );

    expect(
      useComposerDraftStore.getState().draftsByWorkspaceId[workspaceId]?.modelSelectionByProvider
        .claudeAgent,
    ).toEqual(
      modelSelection("claudeAgent", "claude-opus-4-6", {
        thinking: false,
      }),
    );
    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider.claudeAgent).toEqual(
      modelSelection("claudeAgent", "claude-opus-4-6", {
        thinking: false,
      }),
    );
  });

  it("keeps explicit default-state overrides on the selection", () => {
    const store = useComposerDraftStore.getState();

    store.setModelSelection(
      workspaceId,
      modelSelection("claudeAgent", "claude-opus-4-6", {
        effort: "max",
      }),
    );

    store.setProviderModelOptions(workspaceId, "claudeAgent", {
      thinking: true,
    });

    expect(
      useComposerDraftStore.getState().draftsByWorkspaceId[workspaceId]?.modelSelectionByProvider
        .claudeAgent,
    ).toEqual(
      modelSelection("claudeAgent", "claude-opus-4-6", {
        thinking: true,
      }),
    );
    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider).toEqual({});
  });

  it("keeps explicit off/default codex overrides on the selection", () => {
    const store = useComposerDraftStore.getState();

    store.setModelSelection(workspaceId, modelSelection("codex", "gpt-5.4", { fastMode: true }));

    store.setProviderModelOptions(workspaceId, "codex", {
      reasoningEffort: "high",
      fastMode: false,
    });

    expect(
      useComposerDraftStore.getState().draftsByWorkspaceId[workspaceId]?.modelSelectionByProvider
        .codex,
    ).toEqual(
      modelSelection("codex", "gpt-5.4", {
        reasoningEffort: "high",
        fastMode: false,
      }),
    );
  });

  it("updates only the draft when sticky persistence is omitted", () => {
    const store = useComposerDraftStore.getState();

    store.setStickyModelSelection(
      modelSelection("claudeAgent", "claude-opus-4-6", { effort: "max" }),
    );
    store.setModelSelection(
      workspaceId,
      modelSelection("claudeAgent", "claude-opus-4-6", { effort: "max" }),
    );

    store.setProviderModelOptions(workspaceId, "claudeAgent", {
      thinking: false,
    });

    expect(
      useComposerDraftStore.getState().draftsByWorkspaceId[workspaceId]?.modelSelectionByProvider
        .claudeAgent,
    ).toEqual(
      modelSelection("claudeAgent", "claude-opus-4-6", {
        thinking: false,
      }),
    );
    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider.claudeAgent).toEqual(
      modelSelection("claudeAgent", "claude-opus-4-6", { effort: "max" }),
    );
  });

  it("does not clear other provider options when setting options for a single provider", () => {
    const store = useComposerDraftStore.getState();

    // Set options for both providers
    store.setModelOptions(
      workspaceId,
      providerModelOptions({
        codex: { fastMode: true },
        claudeAgent: { effort: "max" },
      }),
    );

    // Now set options for only codex — claudeAgent should be untouched
    store.setModelOptions(
      workspaceId,
      providerModelOptions({ codex: { reasoningEffort: "xhigh" } }),
    );

    const draft = useComposerDraftStore.getState().draftsByWorkspaceId[workspaceId];
    expect(draft?.modelSelectionByProvider.codex?.options).toEqual({ reasoningEffort: "xhigh" });
    expect(draft?.modelSelectionByProvider.claudeAgent?.options).toEqual({ effort: "max" });
  });

  it("preserves other provider options when switching the active model selection", () => {
    const store = useComposerDraftStore.getState();

    store.setModelOptions(
      workspaceId,
      providerModelOptions({
        codex: { fastMode: true },
        claudeAgent: { effort: "max" },
      }),
    );

    store.setModelSelection(workspaceId, modelSelection("claudeAgent", "claude-opus-4-6"));

    const draft = useComposerDraftStore.getState().draftsByWorkspaceId[workspaceId];
    expect(draft?.modelSelectionByProvider.claudeAgent).toEqual(
      modelSelection("claudeAgent", "claude-opus-4-6", { effort: "max" }),
    );
    expect(draft?.modelSelectionByProvider.codex?.options).toEqual({ fastMode: true });
    expect(draft?.activeProvider).toBe("claudeAgent");
  });

  it("creates the first sticky snapshot from provider option changes", () => {
    const store = useComposerDraftStore.getState();

    store.setModelSelection(workspaceId, modelSelection("codex", "gpt-5.4"));

    store.setProviderModelOptions(
      workspaceId,
      "codex",
      {
        fastMode: true,
      },
      { persistSticky: true },
    );

    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider.codex).toEqual(
      modelSelection("codex", "gpt-5.4", {
        fastMode: true,
      }),
    );
  });

  it("updates only the draft when sticky persistence is disabled", () => {
    const store = useComposerDraftStore.getState();

    store.setStickyModelSelection(
      modelSelection("claudeAgent", "claude-opus-4-6", { effort: "max" }),
    );
    store.setModelSelection(
      workspaceId,
      modelSelection("claudeAgent", "claude-opus-4-6", { effort: "max" }),
    );

    store.setProviderModelOptions(
      workspaceId,
      "claudeAgent",
      {
        thinking: false,
      },
      { persistSticky: false },
    );

    expect(
      useComposerDraftStore.getState().draftsByWorkspaceId[workspaceId]?.modelSelectionByProvider
        .claudeAgent,
    ).toEqual(
      modelSelection("claudeAgent", "claude-opus-4-6", {
        thinking: false,
      }),
    );
    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider.claudeAgent).toEqual(
      modelSelection("claudeAgent", "claude-opus-4-6", { effort: "max" }),
    );
  });
});

describe("composerDraftStore setModelSelection", () => {
  const workspaceId = WorkspaceId.makeUnsafe("workspace-model");

  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("keeps explicit model overrides instead of coercing to null", () => {
    const store = useComposerDraftStore.getState();

    store.setModelSelection(workspaceId, modelSelection("codex", "gpt-5.3-codex"));

    expect(
      useComposerDraftStore.getState().draftsByWorkspaceId[workspaceId]?.modelSelectionByProvider
        .codex,
    ).toEqual(modelSelection("codex", "gpt-5.3-codex"));
  });
});

describe("composerDraftStore sticky composer settings", () => {
  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("stores a sticky model selection", () => {
    const store = useComposerDraftStore.getState();

    store.setStickyModelSelection(
      modelSelection("codex", "gpt-5.3-codex", {
        reasoningEffort: "medium",
        fastMode: true,
      }),
    );

    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider.codex).toEqual(
      modelSelection("codex", "gpt-5.3-codex", {
        reasoningEffort: "medium",
        fastMode: true,
      }),
    );
    expect(useComposerDraftStore.getState().stickyActiveProvider).toBe("codex");
  });

  it("normalizes empty sticky model options by dropping selection options", () => {
    const store = useComposerDraftStore.getState();

    store.setStickyModelSelection(modelSelection("codex", "gpt-5.4"));

    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider.codex).toEqual(
      modelSelection("codex", "gpt-5.4"),
    );
    expect(useComposerDraftStore.getState().stickyActiveProvider).toBe("codex");
  });

  it("applies sticky activeProvider to new drafts", () => {
    const store = useComposerDraftStore.getState();
    const workspaceId = WorkspaceId.makeUnsafe("workspace-sticky-active-provider");

    store.setStickyModelSelection(modelSelection("claudeAgent", "claude-opus-4-6"));
    store.applyStickyState(workspaceId);

    expect(useComposerDraftStore.getState().draftsByWorkspaceId[workspaceId]).toMatchObject({
      modelSelectionByProvider: {
        claudeAgent: modelSelection("claudeAgent", "claude-opus-4-6"),
      },
      activeProvider: "claudeAgent",
    });
  });
});

describe("composerDraftStore provider-scoped option updates", () => {
  const workspaceId = WorkspaceId.makeUnsafe("workspace-provider");

  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("retains off-provider option memory without changing the active selection", () => {
    const store = useComposerDraftStore.getState();
    store.setModelSelection(
      workspaceId,
      modelSelection("codex", "gpt-5.3-codex", {
        reasoningEffort: "medium",
      }),
    );
    store.setProviderModelOptions(workspaceId, "claudeAgent", { effort: "max" });
    const draft = useComposerDraftStore.getState().draftsByWorkspaceId[workspaceId];
    expect(draft?.modelSelectionByProvider.codex).toEqual(
      modelSelection("codex", "gpt-5.3-codex", { reasoningEffort: "medium" }),
    );
    expect(draft?.modelSelectionByProvider.claudeAgent?.options).toEqual({ effort: "max" });
    expect(draft?.activeProvider).toBe("codex");
  });
});

describe("composerDraftStore runtime and interaction settings", () => {
  const workspaceId = WorkspaceId.makeUnsafe("workspace-settings");

  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("stores runtime mode overrides in the composer draft", () => {
    const store = useComposerDraftStore.getState();

    store.setRuntimeMode(workspaceId, "approval-required");

    expect(useComposerDraftStore.getState().draftsByWorkspaceId[workspaceId]?.runtimeMode).toBe(
      "approval-required",
    );
  });

  it("stores interaction mode overrides in the composer draft", () => {
    const store = useComposerDraftStore.getState();

    store.setInteractionMode(workspaceId, "plan");

    expect(useComposerDraftStore.getState().draftsByWorkspaceId[workspaceId]?.interactionMode).toBe(
      "plan",
    );
  });

  it("removes empty settings-only drafts when overrides are cleared", () => {
    const store = useComposerDraftStore.getState();

    store.setRuntimeMode(workspaceId, "approval-required");
    store.setInteractionMode(workspaceId, "plan");
    store.setRuntimeMode(workspaceId, null);
    store.setInteractionMode(workspaceId, null);

    expect(useComposerDraftStore.getState().draftsByWorkspaceId[workspaceId]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createDebouncedStorage
// ---------------------------------------------------------------------------

function createMockStorage() {
  const store = new Map<string, string>();
  return {
    getItem: vi.fn((name: string) => store.get(name) ?? null),
    setItem: vi.fn((name: string, value: string) => {
      store.set(name, value);
    }),
    removeItem: vi.fn((name: string) => {
      store.delete(name);
    }),
  };
}

describe("createDebouncedStorage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("delegates getItem immediately", () => {
    const base = createMockStorage();
    base.getItem.mockReturnValueOnce("value");
    const storage = createDebouncedStorage(base);

    expect(storage.getItem("key")).toBe("value");
    expect(base.getItem).toHaveBeenCalledWith("key");
  });

  it("does not write to base storage until the debounce fires", () => {
    const base = createMockStorage();
    const storage = createDebouncedStorage(base);

    storage.setItem("key", "v1");
    expect(base.setItem).not.toHaveBeenCalled();

    vi.advanceTimersByTime(299);
    expect(base.setItem).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(base.setItem).toHaveBeenCalledWith("key", "v1");
  });

  it("only writes the last value when setItem is called rapidly", () => {
    const base = createMockStorage();
    const storage = createDebouncedStorage(base);

    storage.setItem("key", "v1");
    storage.setItem("key", "v2");
    storage.setItem("key", "v3");

    vi.advanceTimersByTime(300);
    expect(base.setItem).toHaveBeenCalledTimes(1);
    expect(base.setItem).toHaveBeenCalledWith("key", "v3");
  });

  it("removeItem cancels a pending setItem write", () => {
    const base = createMockStorage();
    const storage = createDebouncedStorage(base);

    storage.setItem("key", "v1");
    storage.removeItem("key");

    vi.advanceTimersByTime(300);
    expect(base.setItem).not.toHaveBeenCalled();
    expect(base.removeItem).toHaveBeenCalledWith("key");
  });

  it("flush writes the pending value immediately", () => {
    const base = createMockStorage();
    const storage = createDebouncedStorage(base);

    storage.setItem("key", "v1");
    expect(base.setItem).not.toHaveBeenCalled();

    storage.flush();
    expect(base.setItem).toHaveBeenCalledWith("key", "v1");

    // Timer should be cancelled; no duplicate write.
    vi.advanceTimersByTime(300);
    expect(base.setItem).toHaveBeenCalledTimes(1);
  });

  it("flush is a no-op when nothing is pending", () => {
    const base = createMockStorage();
    const storage = createDebouncedStorage(base);

    storage.flush();
    expect(base.setItem).not.toHaveBeenCalled();
  });

  it("flush after removeItem is a no-op", () => {
    const base = createMockStorage();
    const storage = createDebouncedStorage(base);

    storage.setItem("key", "v1");
    storage.removeItem("key");
    storage.flush();

    expect(base.setItem).not.toHaveBeenCalled();
  });

  it("setItem works normally after removeItem cancels a pending write", () => {
    const base = createMockStorage();
    const storage = createDebouncedStorage(base);

    storage.setItem("key", "v1");
    storage.removeItem("key");
    storage.setItem("key", "v2");

    vi.advanceTimersByTime(300);
    expect(base.setItem).toHaveBeenCalledTimes(1);
    expect(base.setItem).toHaveBeenCalledWith("key", "v2");
  });
});
