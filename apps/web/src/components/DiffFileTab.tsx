/**
 * DiffFileTab - Renders a single file's diff in the main tab content area.
 *
 * Fetches the checkpoint diff for the given workspace / turn range,
 * parses it, extracts the target file, and renders with @pierre/diffs.
 */

import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff, type FileDiffMetadata, Virtualizer } from "@pierre/diffs/react";
import { useQuery } from "@tanstack/react-query";
import { type TurnId, type WorkspaceId } from "@matcha/contracts";
import { Columns2Icon, Rows3Icon, TextWrapIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { gitFileDiffQueryOptions } from "~/lib/gitReactQuery";
import { checkpointDiffQueryOptions } from "~/lib/providerReactQuery";
import { buildPatchCacheKey, resolveDiffThemeName } from "../lib/diffRendering";
import { openInPreferredEditor } from "../editorPreferences";
import { readNativeApi } from "../nativeApi";
import { resolvePathLinkTarget } from "../terminal-links";
import { useStore } from "../store";
import { useSettings } from "../hooks/useSettings";
import { ToggleGroup, Toggle } from "./ui/toggle-group";

// ---------------------------------------------------------------------------
// CSS override (same as DiffPanel)
// ---------------------------------------------------------------------------

const DIFF_TAB_UNSAFE_CSS = `
[data-diffs-header],
[data-diff],
[data-file],
[data-error-wrapper],
[data-virtualizer-buffer] {
  --diffs-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-light-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-dark-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-token-light-bg: transparent;
  --diffs-token-dark-bg: transparent;

  --diffs-bg-context-override: color-mix(in srgb, var(--background) 97%, var(--foreground));
  --diffs-bg-hover-override: color-mix(in srgb, var(--background) 94%, var(--foreground));
  --diffs-bg-separator-override: color-mix(in srgb, var(--background) 95%, var(--foreground));
  --diffs-bg-buffer-override: color-mix(in srgb, var(--background) 90%, var(--foreground));

  --diffs-bg-addition-override: color-mix(in srgb, var(--background) 92%, var(--success));
  --diffs-bg-addition-number-override: color-mix(in srgb, var(--background) 88%, var(--success));
  --diffs-bg-addition-hover-override: color-mix(in srgb, var(--background) 85%, var(--success));
  --diffs-bg-addition-emphasis-override: color-mix(in srgb, var(--background) 80%, var(--success));

  --diffs-bg-deletion-override: color-mix(in srgb, var(--background) 92%, var(--destructive));
  --diffs-bg-deletion-number-override: color-mix(in srgb, var(--background) 88%, var(--destructive));
  --diffs-bg-deletion-hover-override: color-mix(in srgb, var(--background) 85%, var(--destructive));
  --diffs-bg-deletion-emphasis-override: color-mix(
    in srgb,
    var(--background) 80%,
    var(--destructive)
  );

  background-color: var(--diffs-bg) !important;
}

[data-file-info] {
  background-color: color-mix(in srgb, var(--card) 94%, var(--foreground)) !important;
  border-block-color: var(--border) !important;
  color: var(--foreground) !important;
}

[data-diffs-header] {
  position: sticky !important;
  top: 0;
  z-index: 4;
  background-color: color-mix(in srgb, var(--card) 94%, var(--foreground)) !important;
  border-bottom: 1px solid var(--border) !important;
}

[data-title] {
  cursor: pointer;
  transition:
    color 120ms ease,
    text-decoration-color 120ms ease;
  text-decoration: underline;
  text-decoration-color: transparent;
  text-underline-offset: 2px;
}

[data-title]:hover {
  color: color-mix(in srgb, var(--foreground) 84%, var(--primary)) !important;
  text-decoration-color: currentColor;
}
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type DiffRenderMode = "stacked" | "split";
type DiffThemeType = "light" | "dark";

function resolveFileDiffPath(fileDiff: FileDiffMetadata): string {
  const raw = fileDiff.name ?? fileDiff.prevName ?? "";
  if (raw.startsWith("a/") || raw.startsWith("b/")) {
    return raw.slice(2);
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface DiffFileTabProps {
  workspaceId: WorkspaceId;
  turnId: TurnId | undefined;
  diffGitSource?: "workingTree" | "commit" | undefined;
  diffCommitHash?: string | undefined;
  fromTurnCount: number;
  toTurnCount: number;
  filePath: string;
  resolvedTheme: "light" | "dark";
}

export default function DiffFileTab({
  workspaceId,
  turnId,
  diffGitSource,
  diffCommitHash,
  fromTurnCount,
  toTurnCount,
  filePath,
  resolvedTheme,
}: DiffFileTabProps) {
  const settings = useSettings();
  const [diffRenderMode, setDiffRenderMode] = useState<DiffRenderMode>("stacked");
  const [diffWordWrap, setDiffWordWrap] = useState(settings.diffWordWrap);

  const activeWorkspace = useStore((store) =>
    store.workspaces.find((workspace) => workspace.id === workspaceId),
  );
  const activeProjectId = activeWorkspace?.projectId ?? null;
  const activeProject = useStore((store) =>
    activeProjectId ? store.projects.find((project) => project.id === activeProjectId) : undefined,
  );
  const activeCwd = activeWorkspace?.worktreePath ?? activeProject?.cwd;

  const cacheScope = turnId ? `turn:${turnId}` : `conversation:diff-tab`;
  const gitDiffSource =
    diffGitSource === "commit" && diffCommitHash
      ? ({ source: "commit", commitHash: diffCommitHash } as const)
      : diffGitSource === "workingTree"
        ? ({ source: "workingTree" } as const)
        : null;

  const checkpointDiffQuery = useQuery(
    checkpointDiffQueryOptions({
      workspaceId,
      fromTurnCount,
      toTurnCount,
      cacheScope,
      enabled: true,
    }),
  );
  const gitDiffQuery = useQuery(
    gitFileDiffQueryOptions({
      cwd: activeCwd ?? null,
      filePath,
      diffSource: gitDiffSource,
    }),
  );

  const patch = gitDiffSource ? gitDiffQuery.data?.diff : checkpointDiffQuery.data?.diff;
  const isLoading = gitDiffSource ? gitDiffQuery.isLoading : checkpointDiffQuery.isLoading;
  const activeError = gitDiffSource ? gitDiffQuery.error : checkpointDiffQuery.error;
  const errorMessage =
    activeError instanceof Error
      ? activeError.message
      : gitDiffSource
        ? gitDiffQuery.error
          ? "Failed to load git diff."
          : null
        : checkpointDiffQuery.error
          ? "Failed to load checkpoint diff."
          : null;

  // Parse and extract the target file
  const targetFileDiff = useMemo(() => {
    if (!patch) return null;
    const normalizedPatch = patch.trim();
    if (normalizedPatch.length === 0) return null;

    try {
      const parsedPatches = parsePatchFiles(
        normalizedPatch,
        buildPatchCacheKey(normalizedPatch, `diff-tab:${resolvedTheme}`),
      );
      const allFiles = parsedPatches.flatMap((p) => p.files);
      return allFiles.find((f) => resolveFileDiffPath(f) === filePath) ?? allFiles[0] ?? null;
    } catch {
      return null;
    }
  }, [patch, filePath, resolvedTheme]);

  const openDiffFileInEditor = useCallback(
    (path: string) => {
      const api = readNativeApi();
      if (!api) return;
      const targetPath = activeCwd ? resolvePathLinkTarget(path, activeCwd) : path;
      void openInPreferredEditor(api, targetPath).catch((error) => {
        console.warn("Failed to open diff file in editor.", error);
      });
    },
    [activeCwd],
  );

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2">
        <span className="truncate font-mono text-xs text-muted-foreground">{filePath}</span>
        <div className="flex shrink-0 items-center gap-1">
          <ToggleGroup
            className="shrink-0"
            variant="outline"
            size="xs"
            value={[diffRenderMode]}
            onValueChange={(value) => {
              const next = value[0];
              if (next === "stacked" || next === "split") {
                setDiffRenderMode(next);
              }
            }}
          >
            <Toggle aria-label="Stacked diff view" value="stacked">
              <Rows3Icon className="size-3" />
            </Toggle>
            <Toggle aria-label="Split diff view" value="split">
              <Columns2Icon className="size-3" />
            </Toggle>
          </ToggleGroup>
          <Toggle
            aria-label={diffWordWrap ? "Disable diff line wrapping" : "Enable diff line wrapping"}
            title={diffWordWrap ? "Disable line wrapping" : "Enable line wrapping"}
            variant="outline"
            size="xs"
            pressed={diffWordWrap}
            onPressedChange={(pressed) => {
              setDiffWordWrap(Boolean(pressed));
            }}
          >
            <TextWrapIcon className="size-3" />
          </Toggle>
        </div>
      </div>

      {/* Diff content */}
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        {errorMessage && !targetFileDiff && (
          <div className="px-4 py-3">
            <p className="text-[11px] text-red-500/80">{errorMessage}</p>
          </div>
        )}
        {isLoading ? (
          <div className="flex h-full items-center justify-center px-4 py-3 text-xs text-muted-foreground/70">
            Loading diff...
          </div>
        ) : !targetFileDiff ? (
          <div className="flex h-full items-center justify-center px-4 py-3 text-xs text-muted-foreground/70">
            {patch !== undefined ? "No changes found for this file." : "No patch available."}
          </div>
        ) : (
          <Virtualizer
            className="diff-render-surface h-full min-h-0 overflow-auto px-2 pb-2"
            config={{
              overscrollSize: 600,
              intersectionObserverMargin: 1200,
            }}
          >
            <div
              className="diff-render-file mb-2 rounded-md first:mt-2 last:mb-0"
              onClickCapture={(event) => {
                const nativeEvent = event.nativeEvent as MouseEvent;
                const composedPath = nativeEvent.composedPath?.() ?? [];
                const clickedHeader = composedPath.some((node) => {
                  if (!(node instanceof Element)) return false;
                  return node.hasAttribute("data-title");
                });
                if (!clickedHeader) return;
                openDiffFileInEditor(filePath);
              }}
            >
              <FileDiff
                fileDiff={targetFileDiff}
                options={{
                  diffStyle: diffRenderMode === "split" ? "split" : "unified",
                  lineDiffType: "none",
                  overflow: diffWordWrap ? "wrap" : "scroll",
                  theme: resolveDiffThemeName(resolvedTheme),
                  themeType: resolvedTheme as DiffThemeType,
                  unsafeCSS: DIFF_TAB_UNSAFE_CSS,
                }}
              />
            </div>
          </Virtualizer>
        )}
      </div>
    </div>
  );
}
