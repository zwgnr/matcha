import {
  ArchiveIcon,
  ChevronRightIcon,
  FolderIcon,
  GitPullRequestIcon,
  PanelLeftCloseIcon,
  PlusIcon,
  SettingsIcon,
  TerminalIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { ProjectFavicon } from "./ProjectFavicon";
import { autoAnimate } from "@formkit/auto-animate";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent,
  type MouseEvent,
  type MutableRefObject,
  type PointerEvent,
  type ReactNode,
  type SetStateAction,
} from "react";
import { useShallow } from "zustand/react/shallow";
import {
  DndContext,
  type DragCancelEvent,
  type CollisionDetection,
  PointerSensor,
  type DragStartEvent,
  closestCorners,
  pointerWithin,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import {
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_RUNTIME_MODE,
  type DesktopUpdateState,
  ProjectId,
  WorkspaceId,
  type GitStatusResult,
} from "@matcha/contracts";
import { useQueries } from "@tanstack/react-query";
import { Link, useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { isElectron } from "../env";
import { ELECTRON_TRAFFIC_LIGHTS_LEFT_INSET_STYLE } from "../lib/titleBar";
import { APP_STAGE_LABEL, APP_VERSION } from "../branding";
import { isTerminalFocused } from "../lib/terminalFocus";
import {
  isLinuxPlatform,
  isMacPlatform,
  newCommandId,
  newProjectId,
  newWorkspaceId,
} from "../lib/utils";
import { useStore } from "../store";
import { selectWorkspaceTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { useUiStateStore } from "../uiStateStore";
import {
  isSidebarToggleShortcut,
  resolveShortcutCommand,
  shortcutLabelForCommand,
  shouldShowWorkspaceJumpHints,
  workspaceJumpCommandForIndex,
  workspaceJumpIndexFromCommand,
  workspaceTraversalDirectionFromCommand,
} from "../keybindings";
import { gitStatusQueryOptions } from "../lib/gitReactQuery";
import { readNativeApi } from "../nativeApi";
import { useComposerDraftStore } from "../composerDraftStore";
import { useHandleNewWorkspace } from "../hooks/useHandleNewWorkspace";
import { NewWorkspaceDialog, type NewWorkspaceResult } from "./NewWorkspaceDialog";
import { ProjectSettingsDialog } from "./ProjectSettingsDialog";
import { buildNewWorkspaceWorktreeBranchName } from "../worktree";

import { useWorkspaceActions } from "../hooks/useWorkspaceActions";
import { toastManager } from "./ui/toast";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { SettingsSidebarNav } from "./settings/SettingsSidebarNav";
import {
  getArm64IntelBuildWarningDescription,
  getDesktopUpdateActionError,
  getDesktopUpdateInstallConfirmationMessage,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
  shouldShowArm64IntelBuildWarning,
  shouldToastDesktopUpdateActionResult,
} from "./desktopUpdate.logic";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarTrigger,
  useSidebar,
} from "./ui/sidebar";
import { useWorkspaceSelectionStore } from "../workspaceSelectionStore";
import { makeProviderTab, useWorkspaceTabStore } from "../workspaceTabStore";
import { isNonEmpty as isNonEmptyString } from "effect/String";
import {
  getVisibleSidebarWorkspaceIds,
  getVisibleWorkspacesForProject,
  resolveAdjacentWorkspaceId,
  isContextMenuPointerDown,
  resolveProjectStatusIndicator,
  resolveWorkspaceRowClassName,
  resolveWorkspaceStatusPill,
  orderItemsByPreferredIds,
  shouldClearWorkspaceSelectionOnMouseDown,
  sortProjectsForSidebar,
  sortWorkspacesForSidebar,
  useWorkspaceJumpHintVisibility,
} from "./Sidebar.logic";
import { SidebarUpdatePill } from "./sidebar/SidebarUpdatePill";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useSettings } from "~/hooks/useSettings";
import { useServerKeybindings } from "../rpc/serverState";
import { useSidebarWorkspaceSummaryById } from "../storeSelectors";
import type { Project, ProjectScript, SidebarWorkspaceSummary } from "../types";
import type { WorkspaceStatusPill } from "./Sidebar.logic";
const WORKSPACE_PREVIEW_LIMIT = 6;

/**
 * Collect status pills for a root workspace and its child provider workspaces.
 * Used by both per-workspace row status and project-level status aggregation.
 */
function collectWorkspaceStatusPills(
  rootStatus: WorkspaceStatusPill | null,
  childWorkspaceIds: readonly WorkspaceId[] | undefined,
  sidebarWorkspacesById: Record<string, SidebarWorkspaceSummary>,
): (WorkspaceStatusPill | null)[] {
  if (!childWorkspaceIds || childWorkspaceIds.length === 0) return [rootStatus];
  const statuses: (WorkspaceStatusPill | null)[] = [rootStatus];
  for (const childId of childWorkspaceIds) {
    const childWs = sidebarWorkspacesById[childId];
    statuses.push(
      childWs
        ? resolveWorkspaceStatusPill({ workspace: { ...childWs, lastVisitedAt: undefined } })
        : null,
    );
  }
  return statuses;
}
const SIDEBAR_LIST_ANIMATION_OPTIONS = {
  duration: 180,
  easing: "ease-out",
} as const;

type SidebarProjectSnapshot = Project & {
  expanded: boolean;
};
interface TerminalStatusIndicator {
  label: "Terminal process running";
  colorClass: string;
  pulse: boolean;
}

interface PrStatusIndicator {
  label: "PR open" | "PR closed" | "PR merged";
  colorClass: string;
  tooltip: string;
  url: string;
}

type WorkspacePr = GitStatusResult["pr"];

function WorkspaceStatusLabel({
  status,
  compact = false,
}: {
  status: NonNullable<ReturnType<typeof resolveWorkspaceStatusPill>>;
  compact?: boolean;
}) {
  if (compact) {
    return (
      <span
        title={status.label}
        className={`inline-flex size-3.5 shrink-0 items-center justify-center ${status.colorClass}`}
      >
        <span
          className={`size-[9px] rounded-full ${status.dotClass} ${
            status.pulse ? "animate-pulse" : ""
          }`}
        />
        <span className="sr-only">{status.label}</span>
      </span>
    );
  }

  return (
    <span
      title={status.label}
      className={`inline-flex items-center gap-1 text-[10px] ${status.colorClass}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${status.dotClass} ${
          status.pulse ? "animate-pulse" : ""
        }`}
      />
      <span className="hidden md:inline">{status.label}</span>
    </span>
  );
}

function terminalStatusFromRunningIds(
  runningTerminalIds: string[],
): TerminalStatusIndicator | null {
  if (runningTerminalIds.length === 0) {
    return null;
  }
  return {
    label: "Terminal process running",
    colorClass: "text-teal-600 dark:text-teal-300/90",
    pulse: true,
  };
}

function prStatusIndicator(pr: WorkspacePr): PrStatusIndicator | null {
  if (!pr) return null;

  if (pr.state === "open") {
    return {
      label: "PR open",
      colorClass: "text-emerald-600 dark:text-emerald-300/90",
      tooltip: `#${pr.number} PR open: ${pr.title}`,
      url: pr.url,
    };
  }
  if (pr.state === "closed") {
    return {
      label: "PR closed",
      colorClass: "text-zinc-500 dark:text-zinc-400/80",
      tooltip: `#${pr.number} PR closed: ${pr.title}`,
      url: pr.url,
    };
  }
  if (pr.state === "merged") {
    return {
      label: "PR merged",
      colorClass: "text-violet-600 dark:text-violet-300/90",
      tooltip: `#${pr.number} PR merged: ${pr.title}`,
      url: pr.url,
    };
  }
  return null;
}

interface SidebarWorkspaceRowProps {
  workspaceId: WorkspaceId;
  orderedProjectWorkspaceIds: readonly WorkspaceId[];
  routeWorkspaceId: WorkspaceId | null;
  selectedWorkspaceIds: ReadonlySet<WorkspaceId>;
  showWorkspaceJumpHints: boolean;
  jumpLabel: string | null;
  appSettingsConfirmWorkspaceArchive: boolean;
  renamingWorkspaceId: WorkspaceId | null;
  renamingTitle: string;
  setRenamingTitle: (title: string) => void;
  renamingInputRef: MutableRefObject<HTMLInputElement | null>;
  renamingCommittedRef: MutableRefObject<boolean>;
  confirmingArchiveWorkspaceId: WorkspaceId | null;
  setConfirmingArchiveWorkspaceId: Dispatch<SetStateAction<WorkspaceId | null>>;
  confirmArchiveButtonRefs: MutableRefObject<Map<WorkspaceId, HTMLButtonElement>>;
  handleWorkspaceClick: (
    event: MouseEvent,
    workspaceId: WorkspaceId,
    orderedProjectWorkspaceIds: readonly WorkspaceId[],
  ) => void;
  navigateToWorkspace: (workspaceId: WorkspaceId) => void;
  handleMultiSelectContextMenu: (position: { x: number; y: number }) => Promise<void>;
  handleWorkspaceContextMenu: (
    workspaceId: WorkspaceId,
    position: { x: number; y: number },
  ) => Promise<void>;
  clearSelection: () => void;
  commitRename: (
    workspaceId: WorkspaceId,
    newTitle: string,
    originalTitle: string,
  ) => Promise<void>;
  cancelRename: () => void;
  attemptArchiveWorkspace: (workspaceId: WorkspaceId) => Promise<void>;
  openPrLink: (event: MouseEvent<HTMLElement>, prUrl: string) => void;
  pr: WorkspacePr | null;
  childWorkspaceIds: readonly WorkspaceId[];
}

const EMPTY_CHILD_WORKSPACE_IDS: readonly WorkspaceId[] = [];

function SidebarWorkspaceRow(props: SidebarWorkspaceRowProps) {
  const workspace = useSidebarWorkspaceSummaryById(props.workspaceId);
  const lastVisitedAt = useUiStateStore(
    (state) => state.workspaceLastVisitedAtById[props.workspaceId],
  );
  const runningTerminalIds = useTerminalStateStore(
    (state) =>
      selectWorkspaceTerminalState(state.terminalStateByWorkspaceId, props.workspaceId)
        .runningTerminalIds,
  );
  const childWorkspaceSummaries = useStore(
    useShallow((state) =>
      props.childWorkspaceIds.length === 0
        ? []
        : props.childWorkspaceIds
            .map((id) => state.sidebarWorkspacesById[id])
            .filter((ws): ws is NonNullable<typeof ws> => ws !== undefined),
    ),
  );

  if (!workspace) {
    return null;
  }

  const isActive = props.routeWorkspaceId === workspace.id;
  const isSelected = props.selectedWorkspaceIds.has(workspace.id);
  const isHighlighted = isActive || isSelected;
  const rootRunning =
    workspace.session?.status === "running" && workspace.session.activeTurnId != null;
  const isWorkspaceRunning =
    rootRunning ||
    childWorkspaceSummaries.some(
      (child) => child.session?.status === "running" && child.session.activeTurnId != null,
    );
  const rootStatus = resolveWorkspaceStatusPill({
    workspace: {
      ...workspace,
      lastVisitedAt,
    },
  });
  const workspaceStatus =
    childWorkspaceSummaries.length === 0
      ? rootStatus
      : resolveProjectStatusIndicator([
          rootStatus,
          ...childWorkspaceSummaries.map((child) =>
            resolveWorkspaceStatusPill({ workspace: { ...child, lastVisitedAt: undefined } }),
          ),
        ]);
  const prStatus = prStatusIndicator(props.pr);
  const terminalStatus = terminalStatusFromRunningIds(runningTerminalIds);
  const isConfirmingArchive =
    props.confirmingArchiveWorkspaceId === workspace.id && !isWorkspaceRunning;
  const workspaceMetaClassName = isConfirmingArchive
    ? "pointer-events-none opacity-0"
    : !isWorkspaceRunning
      ? "pointer-events-none transition-opacity duration-150 group-hover/menu-sub-item:opacity-0 group-focus-within/menu-sub-item:opacity-0"
      : "pointer-events-none";

  return (
    <SidebarMenuSubItem
      className="w-full"
      data-workspace-item
      onMouseLeave={() => {
        props.setConfirmingArchiveWorkspaceId((current) =>
          current === workspace.id ? null : current,
        );
      }}
      onBlurCapture={(event) => {
        const currentTarget = event.currentTarget;
        requestAnimationFrame(() => {
          if (currentTarget.contains(document.activeElement)) {
            return;
          }
          props.setConfirmingArchiveWorkspaceId((current) =>
            current === workspace.id ? null : current,
          );
        });
      }}
    >
      <SidebarMenuSubButton
        render={<div role="button" tabIndex={0} />}
        size="sm"
        isActive={isActive}
        data-testid={`workspace-row-${workspace.id}`}
        className={`${resolveWorkspaceRowClassName({
          isActive,
          isSelected,
        })} relative isolate`}
        onClick={(event) => {
          props.handleWorkspaceClick(event, workspace.id, props.orderedProjectWorkspaceIds);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          props.navigateToWorkspace(workspace.id);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          if (props.selectedWorkspaceIds.size > 0 && props.selectedWorkspaceIds.has(workspace.id)) {
            void props.handleMultiSelectContextMenu({
              x: event.clientX,
              y: event.clientY,
            });
          } else {
            if (props.selectedWorkspaceIds.size > 0) {
              props.clearSelection();
            }
            void props.handleWorkspaceContextMenu(workspace.id, {
              x: event.clientX,
              y: event.clientY,
            });
          }
        }}
      >
        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
          {prStatus && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label={prStatus.tooltip}
                    className={`inline-flex items-center justify-center ${prStatus.colorClass} cursor-pointer rounded-sm outline-hidden focus-visible:ring-1 focus-visible:ring-ring`}
                    onClick={(event) => {
                      props.openPrLink(event, prStatus.url);
                    }}
                  >
                    <GitPullRequestIcon className="size-3" />
                  </button>
                }
              />
              <TooltipPopup side="top">{prStatus.tooltip}</TooltipPopup>
            </Tooltip>
          )}
          {workspaceStatus && <WorkspaceStatusLabel status={workspaceStatus} />}
          {props.renamingWorkspaceId === workspace.id ? (
            <input
              ref={(element) => {
                if (element && props.renamingInputRef.current !== element) {
                  props.renamingInputRef.current = element;
                  element.focus();
                  element.select();
                }
              }}
              className="min-w-0 flex-1 truncate text-xs bg-transparent outline-none border border-ring rounded px-0.5"
              value={props.renamingTitle}
              onChange={(event) => props.setRenamingTitle(event.target.value)}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Enter") {
                  event.preventDefault();
                  props.renamingCommittedRef.current = true;
                  void props.commitRename(workspace.id, props.renamingTitle, workspace.title);
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  props.renamingCommittedRef.current = true;
                  props.cancelRename();
                }
              }}
              onBlur={() => {
                if (!props.renamingCommittedRef.current) {
                  void props.commitRename(workspace.id, props.renamingTitle, workspace.title);
                }
              }}
              onClick={(event) => event.stopPropagation()}
            />
          ) : (
            <span className="min-w-0 flex-1 truncate text-xs">{workspace.title}</span>
          )}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {terminalStatus && (
            <span
              role="img"
              aria-label={terminalStatus.label}
              title={terminalStatus.label}
              className={`inline-flex items-center justify-center ${terminalStatus.colorClass}`}
            >
              <TerminalIcon className={`size-3 ${terminalStatus.pulse ? "animate-pulse" : ""}`} />
            </span>
          )}
          <div className="flex min-w-12 justify-end">
            {isConfirmingArchive ? (
              <button
                ref={(element) => {
                  if (element) {
                    props.confirmArchiveButtonRefs.current.set(workspace.id, element);
                  } else {
                    props.confirmArchiveButtonRefs.current.delete(workspace.id);
                  }
                }}
                type="button"
                data-workspace-selection-safe
                data-testid={`workspace-archive-confirm-${workspace.id}`}
                aria-label={`Confirm archive ${workspace.title}`}
                className="absolute top-1/2 right-1 inline-flex h-5 -translate-y-1/2 cursor-pointer items-center rounded-full bg-destructive/12 px-2 text-[10px] font-medium text-destructive transition-colors hover:bg-destructive/18 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-destructive/40"
                onPointerDown={(event) => {
                  event.stopPropagation();
                }}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  props.setConfirmingArchiveWorkspaceId((current) =>
                    current === workspace.id ? null : current,
                  );
                  void props.attemptArchiveWorkspace(workspace.id);
                }}
              >
                Confirm
              </button>
            ) : !isWorkspaceRunning ? (
              props.appSettingsConfirmWorkspaceArchive ? (
                <div className="pointer-events-none absolute top-1/2 right-1 -translate-y-1/2 opacity-0 transition-opacity duration-150 group-hover/menu-sub-item:pointer-events-auto group-hover/menu-sub-item:opacity-100 group-focus-within/menu-sub-item:pointer-events-auto group-focus-within/menu-sub-item:opacity-100">
                  <button
                    type="button"
                    data-workspace-selection-safe
                    data-testid={`workspace-archive-${workspace.id}`}
                    aria-label={`Archive ${workspace.title}`}
                    className="inline-flex size-5 cursor-pointer items-center justify-center text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
                    onPointerDown={(event) => {
                      event.stopPropagation();
                    }}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      props.setConfirmingArchiveWorkspaceId(workspace.id);
                      requestAnimationFrame(() => {
                        props.confirmArchiveButtonRefs.current.get(workspace.id)?.focus();
                      });
                    }}
                  >
                    <ArchiveIcon className="size-3.5" />
                  </button>
                </div>
              ) : (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <div className="pointer-events-none absolute top-1/2 right-1 -translate-y-1/2 opacity-0 transition-opacity duration-150 group-hover/menu-sub-item:pointer-events-auto group-hover/menu-sub-item:opacity-100 group-focus-within/menu-sub-item:pointer-events-auto group-focus-within/menu-sub-item:opacity-100">
                        <button
                          type="button"
                          data-workspace-selection-safe
                          data-testid={`workspace-archive-${workspace.id}`}
                          aria-label={`Archive ${workspace.title}`}
                          className="inline-flex size-5 cursor-pointer items-center justify-center text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
                          onPointerDown={(event) => {
                            event.stopPropagation();
                          }}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            void props.attemptArchiveWorkspace(workspace.id);
                          }}
                        >
                          <ArchiveIcon className="size-3.5" />
                        </button>
                      </div>
                    }
                  />
                  <TooltipPopup side="top">Archive</TooltipPopup>
                </Tooltip>
              )
            ) : null}
            <span className={workspaceMetaClassName}>
              {props.showWorkspaceJumpHints && props.jumpLabel ? (
                <span
                  className="inline-flex h-5 items-center rounded-full border border-border/80 bg-background/90 px-1.5 font-mono text-[10px] font-medium tracking-tight text-foreground shadow-sm"
                  title={props.jumpLabel}
                >
                  {props.jumpLabel}
                </span>
              ) : (
                <span
                  className={`text-[10px] ${
                    isHighlighted
                      ? "text-foreground/72 dark:text-foreground/82"
                      : "text-muted-foreground/40"
                  }`}
                >
                  {formatRelativeTimeLabel(workspace.updatedAt ?? workspace.createdAt)}
                </span>
              )}
            </span>
          </div>
        </div>
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  );
}

function MatchaWordmark() {
  return (
    <span
      aria-label="Matcha"
      className="shrink-0 text-sm font-semibold tracking-tight text-foreground"
    >
      Matcha
    </span>
  );
}

type SortableProjectHandleProps = Pick<
  ReturnType<typeof useSortable>,
  "attributes" | "listeners" | "setActivatorNodeRef"
>;

function SortableProjectItem({
  projectId,
  disabled = false,
  children,
}: {
  projectId: ProjectId;
  disabled?: boolean;
  children: (handleProps: SortableProjectHandleProps) => ReactNode;
}) {
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
    isOver,
  } = useSortable({ id: projectId, disabled });
  return (
    <li
      ref={setNodeRef}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
      }}
      className={`group/menu-item relative rounded-md ${
        isDragging ? "z-20 opacity-80" : ""
      } ${isOver && !isDragging ? "ring-1 ring-primary/40" : ""}`}
      data-sidebar="menu-item"
      data-slot="sidebar-menu-item"
    >
      {children({ attributes, listeners, setActivatorNodeRef })}
    </li>
  );
}

export default function Sidebar() {
  const projects = useStore((store) => store.projects);
  const sidebarWorkspacesById = useStore((store) => store.sidebarWorkspacesById);
  const workspaceIdsByProjectId = useStore((store) => store.workspaceIdsByProjectId);
  const { projectExpandedById, projectOrder, workspaceLastVisitedAtById } = useUiStateStore(
    useShallow((store) => ({
      projectExpandedById: store.projectExpandedById,
      projectOrder: store.projectOrder,
      workspaceLastVisitedAtById: store.workspaceLastVisitedAtById,
    })),
  );
  const markWorkspaceUnread = useUiStateStore((store) => store.markWorkspaceUnread);
  const toggleProject = useUiStateStore((store) => store.toggleProject);
  const reorderProjects = useUiStateStore((store) => store.reorderProjects);
  const clearComposerDraftForWorkspace = useComposerDraftStore(
    (store) => store.clearDraftWorkspace,
  );
  const getDraftWorkspaceByProjectId = useComposerDraftStore(
    (store) => store.getDraftWorkspaceByProjectId,
  );
  const tabStateByWorkspaceWorkspaceId = useWorkspaceTabStore(
    (store) => store.tabStateByWorkspaceWorkspaceId,
  );
  const findWorkspaceWorkspaceIdByProviderWorkspaceId = useWorkspaceTabStore(
    (store) => store.findWorkspaceWorkspaceIdByProviderWorkspaceId,
  );
  const clearProjectDraftWorkspaceId = useComposerDraftStore(
    (store) => store.clearProjectDraftWorkspaceId,
  );
  const navigate = useNavigate();
  const pathname = useLocation({ select: (loc) => loc.pathname });
  const isOnSettings = pathname.startsWith("/settings");
  const appSettings = useSettings();
  const { handleNewWorkspace } = useHandleNewWorkspace();
  const { archiveWorkspace, deleteWorkspace } = useWorkspaceActions();
  const routeWorkspaceId = useParams({
    strict: false,
    select: (params) => (params.workspaceId ? WorkspaceId.makeUnsafe(params.workspaceId) : null),
  });
  const effectiveRouteWorkspaceId = routeWorkspaceId
    ? (findWorkspaceWorkspaceIdByProviderWorkspaceId(routeWorkspaceId) ?? routeWorkspaceId)
    : null;
  const keybindings = useServerKeybindings();
  const { toggleSidebar } = useSidebar();
  const [addingProject, setAddingProject] = useState(false);
  const [newCwd, setNewCwd] = useState("");
  const [isPickingFolder, setIsPickingFolder] = useState(false);
  const [isAddingProject, setIsAddingProject] = useState(false);
  const [addProjectError, setAddProjectError] = useState<string | null>(null);
  const addProjectInputRef = useRef<HTMLInputElement | null>(null);
  const [newWorkspaceDialogProjectId, setNewWorkspaceDialogProjectId] = useState<ProjectId | null>(
    null,
  );
  const [settingsDialogProjectId, setSettingsDialogProjectId] = useState<ProjectId | null>(null);
  const [renamingWorkspaceId, setRenamingWorkspaceId] = useState<WorkspaceId | null>(null);
  const [renamingTitle, setRenamingTitle] = useState("");
  const [confirmingArchiveWorkspaceId, setConfirmingArchiveWorkspaceId] =
    useState<WorkspaceId | null>(null);
  const [expandedWorkspaceListsByProject, setExpandedWorkspaceListsByProject] = useState<
    ReadonlySet<ProjectId>
  >(() => new Set());
  const { showWorkspaceJumpHints, updateWorkspaceJumpHintsVisibility } =
    useWorkspaceJumpHintVisibility();
  const renamingCommittedRef = useRef(false);
  const renamingInputRef = useRef<HTMLInputElement | null>(null);
  const confirmArchiveButtonRefs = useRef(new Map<WorkspaceId, HTMLButtonElement>());
  const dragInProgressRef = useRef(false);
  const suppressProjectClickAfterDragRef = useRef(false);
  const suppressProjectClickForContextMenuRef = useRef(false);
  const [desktopUpdateState, setDesktopUpdateState] = useState<DesktopUpdateState | null>(null);
  const selectedWorkspaceIds = useWorkspaceSelectionStore((s) => s.selectedWorkspaceIds);
  const toggleWorkspaceSelection = useWorkspaceSelectionStore((s) => s.toggleWorkspace);
  const rangeSelectTo = useWorkspaceSelectionStore((s) => s.rangeSelectTo);
  const clearSelection = useWorkspaceSelectionStore((s) => s.clearSelection);
  const removeFromSelection = useWorkspaceSelectionStore((s) => s.removeFromSelection);
  const setSelectionAnchor = useWorkspaceSelectionStore((s) => s.setAnchor);
  const isLinuxDesktop = isElectron && isLinuxPlatform(navigator.platform);
  const platform = navigator.platform;
  const shouldBrowseForProjectImmediately = isElectron && !isLinuxDesktop;
  const shouldShowProjectPathEntry = addingProject && !shouldBrowseForProjectImmediately;
  const orderedProjects = useMemo(() => {
    return orderItemsByPreferredIds({
      items: projects,
      preferredIds: projectOrder,
      getId: (project) => project.id,
    });
  }, [projectOrder, projects]);
  const sidebarProjects = useMemo<SidebarProjectSnapshot[]>(
    () =>
      orderedProjects.map((project) => ({
        ...project,
        expanded: projectExpandedById[project.id] ?? true,
      })),
    [orderedProjects, projectExpandedById],
  );
  const { hiddenChildProviderWorkspaceIds, childWorkspaceIdsByRootId } = useMemo(() => {
    const hiddenIds = new Set<WorkspaceId>();
    const childMap = new Map<WorkspaceId, WorkspaceId[]>();
    for (const [workspaceWorkspaceId, tabState] of Object.entries(tabStateByWorkspaceWorkspaceId)) {
      const childIds: WorkspaceId[] = [];
      for (const tab of tabState.tabs) {
        if (
          tab.kind === "provider" &&
          tab.workspaceId &&
          tab.workspaceId !== workspaceWorkspaceId
        ) {
          hiddenIds.add(tab.workspaceId);
          childIds.push(tab.workspaceId);
        }
      }
      if (childIds.length > 0) {
        childMap.set(workspaceWorkspaceId as WorkspaceId, childIds);
      }
    }
    return { hiddenChildProviderWorkspaceIds: hiddenIds, childWorkspaceIdsByRootId: childMap };
  }, [tabStateByWorkspaceWorkspaceId]);
  const visibleWorkspaceIdsByProjectId = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(workspaceIdsByProjectId).map(([projectId, workspaceIds]) => [
          projectId,
          workspaceIds.filter((workspaceId) => !hiddenChildProviderWorkspaceIds.has(workspaceId)),
        ]),
      ) as Record<ProjectId, WorkspaceId[]>,
    [hiddenChildProviderWorkspaceIds, workspaceIdsByProjectId],
  );
  const sidebarWorkspaces = useMemo(
    () =>
      Object.values(sidebarWorkspacesById).filter(
        (workspace) => !hiddenChildProviderWorkspaceIds.has(workspace.id),
      ),
    [hiddenChildProviderWorkspaceIds, sidebarWorkspacesById],
  );
  const projectCwdById = useMemo(
    () => new Map(projects.map((project) => [project.id, project.cwd] as const)),
    [projects],
  );
  const routeTerminalOpen = useMemo(() => {
    if (!routeWorkspaceId) return false;
    const tabState = tabStateByWorkspaceWorkspaceId[routeWorkspaceId];
    if (!tabState) return false;
    const activeTab = tabState.tabs.find((t) => t.id === tabState.activeTabId);
    return activeTab?.kind === "terminal";
  }, [routeWorkspaceId, tabStateByWorkspaceWorkspaceId]);
  const sidebarShortcutLabelOptions = useMemo(
    () => ({
      platform,
      context: {
        terminalFocus: false,
        terminalOpen: routeTerminalOpen,
      },
    }),
    [platform, routeTerminalOpen],
  );
  const workspaceGitTargets = useMemo(
    () =>
      sidebarWorkspaces.map((workspace) => ({
        workspaceId: workspace.id,
        branch: workspace.branch,
        cwd: workspace.worktreePath ?? projectCwdById.get(workspace.projectId) ?? null,
      })),
    [projectCwdById, sidebarWorkspaces],
  );
  const workspaceGitStatusCwds = useMemo(
    () => [
      ...new Set(
        workspaceGitTargets
          .filter((target) => target.branch !== null)
          .map((target) => target.cwd)
          .filter((cwd): cwd is string => cwd !== null),
      ),
    ],
    [workspaceGitTargets],
  );
  const workspaceGitStatusQueries = useQueries({
    queries: workspaceGitStatusCwds.map((cwd) => ({
      ...gitStatusQueryOptions(cwd),
      staleTime: 30_000,
      refetchInterval: 60_000,
    })),
  });
  const prByWorkspaceId = useMemo(() => {
    const statusByCwd = new Map<string, GitStatusResult>();
    for (let index = 0; index < workspaceGitStatusCwds.length; index += 1) {
      const cwd = workspaceGitStatusCwds[index];
      if (!cwd) continue;
      const status = workspaceGitStatusQueries[index]?.data;
      if (status) {
        statusByCwd.set(cwd, status);
      }
    }

    const map = new Map<WorkspaceId, WorkspacePr>();
    for (const target of workspaceGitTargets) {
      const status = target.cwd ? statusByCwd.get(target.cwd) : undefined;
      const branchMatches =
        target.branch !== null && status?.branch !== null && status?.branch === target.branch;
      map.set(target.workspaceId, branchMatches ? (status?.pr ?? null) : null);
    }
    return map;
  }, [workspaceGitStatusCwds, workspaceGitStatusQueries, workspaceGitTargets]);

  const openPrLink = useCallback((event: MouseEvent<HTMLElement>, prUrl: string) => {
    event.preventDefault();
    event.stopPropagation();

    const api = readNativeApi();
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Link opening is unavailable.",
      });
      return;
    }

    void api.shell.openExternal(prUrl).catch((error) => {
      toastManager.add({
        type: "error",
        title: "Unable to open PR link",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    });
  }, []);

  const attemptArchiveWorkspace = useCallback(
    async (workspaceId: WorkspaceId) => {
      try {
        await archiveWorkspace(workspaceId);
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to archive workspace",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
    },
    [archiveWorkspace],
  );

  const focusMostRecentWorkspaceForProject = useCallback(
    (projectId: ProjectId) => {
      const latestWorkspace = sortWorkspacesForSidebar(
        (visibleWorkspaceIdsByProjectId[projectId] ?? [])
          .map((workspaceId) => sidebarWorkspacesById[workspaceId])
          .filter(
            (workspace): workspace is NonNullable<typeof workspace> => workspace !== undefined,
          )
          .filter((workspace) => workspace.archivedAt === null),
        appSettings.sidebarWorkspaceSortOrder,
      )[0];
      if (!latestWorkspace) return;

      void navigate({
        to: "/$workspaceId",
        params: { workspaceId: latestWorkspace.id },
      });
    },
    [
      appSettings.sidebarWorkspaceSortOrder,
      navigate,
      sidebarWorkspacesById,
      visibleWorkspaceIdsByProjectId,
    ],
  );

  const addProjectFromPath = useCallback(
    async (rawCwd: string) => {
      const cwd = rawCwd.trim();
      if (!cwd || isAddingProject) return;
      const api = readNativeApi();
      if (!api) return;

      setIsAddingProject(true);
      const finishAddingProject = () => {
        setIsAddingProject(false);
        setNewCwd("");
        setAddProjectError(null);
        setAddingProject(false);
      };

      const existing = projects.find((project) => project.cwd === cwd);
      if (existing) {
        focusMostRecentWorkspaceForProject(existing.id);
        finishAddingProject();
        return;
      }

      const projectId = newProjectId();
      const createdAt = new Date().toISOString();
      const title = cwd.split(/[/\\]/).findLast(isNonEmptyString) ?? cwd;
      try {
        await api.orchestration.dispatchCommand({
          type: "project.create",
          commandId: newCommandId(),
          projectId,
          title,
          workspaceRoot: cwd,
          defaultModelSelection: {
            provider: "codex",
            model: DEFAULT_MODEL_BY_PROVIDER.codex,
          },
          createdAt,
        });
        await handleNewWorkspace(projectId, {
          envMode: appSettings.defaultWorkspaceEnvMode,
        }).catch(() => undefined);
      } catch (error) {
        const description =
          error instanceof Error ? error.message : "An error occurred while adding the project.";
        setIsAddingProject(false);
        if (shouldBrowseForProjectImmediately) {
          toastManager.add({
            type: "error",
            title: "Failed to add project",
            description,
          });
        } else {
          setAddProjectError(description);
        }
        return;
      }
      finishAddingProject();
    },
    [
      focusMostRecentWorkspaceForProject,
      handleNewWorkspace,
      isAddingProject,
      projects,
      shouldBrowseForProjectImmediately,
      appSettings.defaultWorkspaceEnvMode,
    ],
  );

  const handleAddProject = () => {
    void addProjectFromPath(newCwd);
  };

  const canAddProject = newCwd.trim().length > 0 && !isAddingProject;

  const handlePickFolder = async () => {
    const api = readNativeApi();
    if (!api || isPickingFolder) return;
    setIsPickingFolder(true);
    let pickedPath: string | null = null;
    try {
      pickedPath = await api.dialogs.pickFolder();
    } catch {
      // Ignore picker failures and leave the current workspace selection unchanged.
    }
    if (pickedPath) {
      await addProjectFromPath(pickedPath);
    } else if (!shouldBrowseForProjectImmediately) {
      addProjectInputRef.current?.focus();
    }
    setIsPickingFolder(false);
  };

  const handleNewWorkspaceDialogConfirm = useCallback(
    async (result: NewWorkspaceResult) => {
      const api = readNativeApi();
      if (!api) return;
      const project = projects.find((entry) => entry.id === result.projectId);
      if (!project) {
        throw new Error("Project not found.");
      }

      const store = useComposerDraftStore.getState();
      const workspaceId = newWorkspaceId();
      const createdAt = new Date().toISOString();
      const title = result.name || "New workspace";
      const modelSelection = { provider: result.provider, model: result.model };
      let worktreePath: string | null = null;
      let branch = result.branch;

      if (result.createWorktree) {
        const worktree = await api.git.createWorktree({
          cwd: project.cwd,
          branch: result.branch ?? "HEAD",
          newBranch: buildNewWorkspaceWorktreeBranchName(result.name),
          path: null,
        });
        branch = worktree.worktree.branch;
        worktreePath = worktree.worktree.path;
      }

      // Create the workspace server-side so it appears in the sidebar immediately.
      await api.orchestration.dispatchCommand({
        type: "workspace.create",
        commandId: newCommandId(),
        workspaceId,
        projectId: result.projectId,
        title,
        modelSelection,
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: "default",
        branch,
        worktreePath,
        createdAt,
      });

      // Set up the client-side draft so the composer is ready.
      store.upsertDraftWorkspace(workspaceId, {
        projectId: result.projectId,
        createdAt,
        branch,
        worktreePath,
        envMode: worktreePath ? "worktree" : "local",
        runtimeMode: DEFAULT_RUNTIME_MODE,
      });
      store.setModelSelection(workspaceId, modelSelection);
      store.applyStickyState(workspaceId);

      // Initialize workspace tabs with the selected provider tab.
      const { getOrInitTabs, addTab } = useWorkspaceTabStore.getState();
      getOrInitTabs(workspaceId);
      addTab(workspaceId, makeProviderTab(result.provider, workspaceId));

      await navigate({
        to: "/$workspaceId",
        params: { workspaceId },
      });
    },
    [navigate, projects],
  );

  const newWorkspaceDialogProject = newWorkspaceDialogProjectId
    ? projects.find((p) => p.id === newWorkspaceDialogProjectId)
    : null;

  const settingsDialogProject = settingsDialogProjectId
    ? projects.find((p) => p.id === settingsDialogProjectId)
    : null;

  const handleProjectSettingsSave = useCallback(
    async (projectId: ProjectId, scripts: ProjectScript[]) => {
      const api = readNativeApi();
      if (!api) return;
      await api.orchestration.dispatchCommand({
        type: "project.meta.update",
        commandId: newCommandId(),
        projectId,
        scripts,
      });
    },
    [],
  );

  const handleStartAddProject = () => {
    setAddProjectError(null);
    if (shouldBrowseForProjectImmediately) {
      void handlePickFolder();
      return;
    }
    setAddingProject((prev) => !prev);
  };

  const cancelRename = useCallback(() => {
    setRenamingWorkspaceId(null);
    renamingInputRef.current = null;
  }, []);

  const commitRename = useCallback(
    async (workspaceId: WorkspaceId, newTitle: string, originalTitle: string) => {
      const finishRename = () => {
        setRenamingWorkspaceId((current) => {
          if (current !== workspaceId) return current;
          renamingInputRef.current = null;
          return null;
        });
      };

      const trimmed = newTitle.trim();
      if (trimmed.length === 0) {
        toastManager.add({
          type: "warning",
          title: "Workspace title cannot be empty",
        });
        finishRename();
        return;
      }
      if (trimmed === originalTitle) {
        finishRename();
        return;
      }
      const api = readNativeApi();
      if (!api) {
        finishRename();
        return;
      }
      try {
        await api.orchestration.dispatchCommand({
          type: "workspace.meta.update",
          commandId: newCommandId(),
          workspaceId,
          title: trimmed,
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to rename workspace",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
      finishRename();
    },
    [],
  );

  const { copyToClipboard: copyWorkspaceIdToClipboard } = useCopyToClipboard<{
    workspaceId: WorkspaceId;
  }>({
    onCopy: (ctx) => {
      toastManager.add({
        type: "success",
        title: "Workspace ID copied",
        description: ctx.workspaceId,
      });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Failed to copy workspace ID",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    },
  });
  const { copyToClipboard: copyPathToClipboard } = useCopyToClipboard<{
    path: string;
  }>({
    onCopy: (ctx) => {
      toastManager.add({
        type: "success",
        title: "Path copied",
        description: ctx.path,
      });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Failed to copy path",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    },
  });
  const handleWorkspaceContextMenu = useCallback(
    async (workspaceId: WorkspaceId, position: { x: number; y: number }) => {
      const api = readNativeApi();
      if (!api) return;
      const workspace = sidebarWorkspacesById[workspaceId];
      if (!workspace) return;
      const workspaceWorkspacePath =
        workspace.worktreePath ?? projectCwdById.get(workspace.projectId) ?? null;
      const clicked = await api.contextMenu.show(
        [
          { id: "rename", label: "Rename workspace" },
          { id: "mark-unread", label: "Mark unread" },
          { id: "copy-path", label: "Copy Path" },
          { id: "copy-workspace-id", label: "Copy Workspace ID" },
          { id: "delete", label: "Delete", destructive: true },
        ],
        position,
      );

      if (clicked === "rename") {
        setRenamingWorkspaceId(workspaceId);
        setRenamingTitle(workspace.title);
        renamingCommittedRef.current = false;
        return;
      }

      if (clicked === "mark-unread") {
        markWorkspaceUnread(workspaceId, workspace.latestTurn?.completedAt);
        return;
      }
      if (clicked === "copy-path") {
        if (!workspaceWorkspacePath) {
          toastManager.add({
            type: "error",
            title: "Path unavailable",
            description: "This workspace does not have a workspace path to copy.",
          });
          return;
        }
        copyPathToClipboard(workspaceWorkspacePath, { path: workspaceWorkspacePath });
        return;
      }
      if (clicked === "copy-workspace-id") {
        copyWorkspaceIdToClipboard(workspaceId, { workspaceId });
        return;
      }
      if (clicked !== "delete") return;
      if (appSettings.confirmWorkspaceDelete) {
        const confirmed = await api.dialogs.confirm(
          [
            `Delete workspace "${workspace.title}"?`,
            "This permanently clears conversation history for this workspace.",
          ].join("\n"),
        );
        if (!confirmed) {
          return;
        }
      }
      await deleteWorkspace(workspaceId);
    },
    [
      appSettings.confirmWorkspaceDelete,
      copyPathToClipboard,
      copyWorkspaceIdToClipboard,
      deleteWorkspace,
      markWorkspaceUnread,
      projectCwdById,
      sidebarWorkspacesById,
    ],
  );

  const handleMultiSelectContextMenu = useCallback(
    async (position: { x: number; y: number }) => {
      const api = readNativeApi();
      if (!api) return;
      const ids = [...selectedWorkspaceIds];
      if (ids.length === 0) return;
      const count = ids.length;

      const clicked = await api.contextMenu.show(
        [
          { id: "mark-unread", label: `Mark unread (${count})` },
          { id: "delete", label: `Delete (${count})`, destructive: true },
        ],
        position,
      );

      if (clicked === "mark-unread") {
        for (const id of ids) {
          const workspace = sidebarWorkspacesById[id];
          markWorkspaceUnread(id, workspace?.latestTurn?.completedAt);
        }
        clearSelection();
        return;
      }

      if (clicked !== "delete") return;

      if (appSettings.confirmWorkspaceDelete) {
        const confirmed = await api.dialogs.confirm(
          [
            `Delete ${count} workspace${count === 1 ? "" : "s"}?`,
            "This permanently clears conversation history for these workspaces.",
          ].join("\n"),
        );
        if (!confirmed) return;
      }

      const deletedIds = new Set<WorkspaceId>(ids);
      for (const id of ids) {
        await deleteWorkspace(id, { deletedWorkspaceIds: deletedIds });
      }
      removeFromSelection(ids);
    },
    [
      appSettings.confirmWorkspaceDelete,
      clearSelection,
      deleteWorkspace,
      markWorkspaceUnread,
      removeFromSelection,
      selectedWorkspaceIds,
      sidebarWorkspacesById,
    ],
  );

  const handleWorkspaceClick = useCallback(
    (
      event: MouseEvent,
      workspaceId: WorkspaceId,
      orderedProjectWorkspaceIds: readonly WorkspaceId[],
    ) => {
      const isMac = isMacPlatform(navigator.platform);
      const isModClick = isMac ? event.metaKey : event.ctrlKey;
      const isShiftClick = event.shiftKey;

      if (isModClick) {
        event.preventDefault();
        toggleWorkspaceSelection(workspaceId);
        return;
      }

      if (isShiftClick) {
        event.preventDefault();
        rangeSelectTo(workspaceId, orderedProjectWorkspaceIds);
        return;
      }

      // Plain click — clear selection, set anchor for future shift-clicks, and navigate
      if (selectedWorkspaceIds.size > 0) {
        clearSelection();
      }
      setSelectionAnchor(workspaceId);
      void navigate({
        to: "/$workspaceId",
        params: {
          workspaceId: findWorkspaceWorkspaceIdByProviderWorkspaceId(workspaceId) ?? workspaceId,
        },
      });
    },
    [
      clearSelection,
      findWorkspaceWorkspaceIdByProviderWorkspaceId,
      navigate,
      rangeSelectTo,
      selectedWorkspaceIds.size,
      setSelectionAnchor,
      toggleWorkspaceSelection,
    ],
  );

  const navigateToWorkspace = useCallback(
    (workspaceId: WorkspaceId) => {
      if (selectedWorkspaceIds.size > 0) {
        clearSelection();
      }
      setSelectionAnchor(workspaceId);
      void navigate({
        to: "/$workspaceId",
        params: {
          workspaceId: findWorkspaceWorkspaceIdByProviderWorkspaceId(workspaceId) ?? workspaceId,
        },
      });
    },
    [
      clearSelection,
      findWorkspaceWorkspaceIdByProviderWorkspaceId,
      navigate,
      selectedWorkspaceIds.size,
      setSelectionAnchor,
    ],
  );

  const handleProjectContextMenu = useCallback(
    async (projectId: ProjectId, position: { x: number; y: number }) => {
      const api = readNativeApi();
      if (!api) return;
      const project = projects.find((entry) => entry.id === projectId);
      if (!project) return;

      const clicked = await api.contextMenu.show(
        [
          { id: "new-workspace", label: "New Workspace" },
          { id: "separator", label: "-" },
          { id: "copy-path", label: "Copy Project Path" },
          { id: "delete", label: "Remove project", destructive: true },
        ],
        position,
      );
      if (clicked === "new-workspace") {
        setNewWorkspaceDialogProjectId(projectId);
        return;
      }
      if (clicked === "copy-path") {
        copyPathToClipboard(project.cwd, { path: project.cwd });
        return;
      }
      if (clicked !== "delete") return;

      const projectWorkspaceIds = workspaceIdsByProjectId[projectId] ?? [];
      if (projectWorkspaceIds.length > 0) {
        toastManager.add({
          type: "warning",
          title: "Project is not empty",
          description: "Delete all workspaces in this project before removing it.",
        });
        return;
      }

      const confirmed = await api.dialogs.confirm(`Remove project "${project.name}"?`);
      if (!confirmed) return;

      try {
        const projectDraftWorkspace = getDraftWorkspaceByProjectId(projectId);
        if (projectDraftWorkspace) {
          clearComposerDraftForWorkspace(projectDraftWorkspace.workspaceId);
        }
        clearProjectDraftWorkspaceId(projectId);
        await api.orchestration.dispatchCommand({
          type: "project.delete",
          commandId: newCommandId(),
          projectId,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error removing project.";
        console.error("Failed to remove project", { projectId, error });
        toastManager.add({
          type: "error",
          title: `Failed to remove "${project.name}"`,
          description: message,
        });
      }
    },
    [
      clearComposerDraftForWorkspace,
      clearProjectDraftWorkspaceId,
      copyPathToClipboard,
      getDraftWorkspaceByProjectId,
      projects,
      workspaceIdsByProjectId,
    ],
  );

  const projectDnDSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  );
  const projectCollisionDetection = useCallback<CollisionDetection>((args) => {
    const pointerCollisions = pointerWithin(args);
    if (pointerCollisions.length > 0) {
      return pointerCollisions;
    }

    return closestCorners(args);
  }, []);

  const handleProjectDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (appSettings.sidebarProjectSortOrder !== "manual") {
        dragInProgressRef.current = false;
        return;
      }
      dragInProgressRef.current = false;
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const activeProject = sidebarProjects.find((project) => project.id === active.id);
      const overProject = sidebarProjects.find((project) => project.id === over.id);
      if (!activeProject || !overProject) return;
      reorderProjects(activeProject.id, overProject.id);
    },
    [appSettings.sidebarProjectSortOrder, reorderProjects, sidebarProjects],
  );

  const handleProjectDragStart = useCallback(
    (_event: DragStartEvent) => {
      if (appSettings.sidebarProjectSortOrder !== "manual") {
        return;
      }
      dragInProgressRef.current = true;
      suppressProjectClickAfterDragRef.current = true;
    },
    [appSettings.sidebarProjectSortOrder],
  );

  const handleProjectDragCancel = useCallback((_event: DragCancelEvent) => {
    dragInProgressRef.current = false;
  }, []);

  const animatedProjectListsRef = useRef(new WeakSet<HTMLElement>());
  const attachProjectListAutoAnimateRef = useCallback((node: HTMLElement | null) => {
    if (!node || animatedProjectListsRef.current.has(node)) {
      return;
    }
    autoAnimate(node, SIDEBAR_LIST_ANIMATION_OPTIONS);
    animatedProjectListsRef.current.add(node);
  }, []);

  const animatedWorkspaceListsRef = useRef(new WeakSet<HTMLElement>());
  const attachWorkspaceListAutoAnimateRef = useCallback((node: HTMLElement | null) => {
    if (!node || animatedWorkspaceListsRef.current.has(node)) {
      return;
    }
    autoAnimate(node, SIDEBAR_LIST_ANIMATION_OPTIONS);
    animatedWorkspaceListsRef.current.add(node);
  }, []);

  const handleProjectTitlePointerDownCapture = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      suppressProjectClickForContextMenuRef.current = false;
      if (
        isContextMenuPointerDown({
          button: event.button,
          ctrlKey: event.ctrlKey,
          isMac: isMacPlatform(navigator.platform),
        })
      ) {
        // Keep context-menu gestures from arming the sortable drag sensor.
        event.stopPropagation();
      }

      suppressProjectClickAfterDragRef.current = false;
    },
    [],
  );

  const visibleWorkspaces = useMemo(
    () => sidebarWorkspaces.filter((workspace) => workspace.archivedAt === null),
    [sidebarWorkspaces],
  );
  const sortedProjects = useMemo(
    () =>
      sortProjectsForSidebar(
        sidebarProjects,
        visibleWorkspaces,
        appSettings.sidebarProjectSortOrder,
      ),
    [appSettings.sidebarProjectSortOrder, sidebarProjects, visibleWorkspaces],
  );
  const isManualProjectSorting = appSettings.sidebarProjectSortOrder === "manual";
  const renderedProjects = useMemo(
    () =>
      sortedProjects.map((project) => {
        const resolveProjectWorkspaceStatus = (workspace: (typeof visibleWorkspaces)[number]) =>
          resolveWorkspaceStatusPill({
            workspace: {
              ...workspace,
              lastVisitedAt: workspaceLastVisitedAtById[workspace.id],
            },
          });
        const projectWorkspaces = sortWorkspacesForSidebar(
          (visibleWorkspaceIdsByProjectId[project.id] ?? [])
            .map((workspaceId) => sidebarWorkspacesById[workspaceId])
            .filter(
              (workspace): workspace is NonNullable<typeof workspace> => workspace !== undefined,
            )
            .filter((workspace) => workspace.archivedAt === null),
          appSettings.sidebarWorkspaceSortOrder,
        );
        const projectStatus = resolveProjectStatusIndicator(
          projectWorkspaces.flatMap((workspace) =>
            collectWorkspaceStatusPills(
              resolveProjectWorkspaceStatus(workspace),
              childWorkspaceIdsByRootId.get(workspace.id),
              sidebarWorkspacesById,
            ),
          ),
        );
        const activeWorkspaceId = effectiveRouteWorkspaceId ?? undefined;
        const isWorkspaceListExpanded = expandedWorkspaceListsByProject.has(project.id);
        const pinnedCollapsedWorkspace =
          !project.expanded && activeWorkspaceId
            ? (projectWorkspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null)
            : null;
        const shouldShowWorkspacePanel = project.expanded || pinnedCollapsedWorkspace !== null;
        const {
          hasHiddenWorkspaces,
          hiddenWorkspaces,
          visibleWorkspaces: visibleProjectWorkspaces,
        } = getVisibleWorkspacesForProject({
          workspaces: projectWorkspaces,
          activeWorkspaceId,
          isWorkspaceListExpanded,
          previewLimit: WORKSPACE_PREVIEW_LIMIT,
        });
        const hiddenWorkspaceStatus = resolveProjectStatusIndicator(
          hiddenWorkspaces.flatMap((workspace) =>
            collectWorkspaceStatusPills(
              resolveProjectWorkspaceStatus(workspace),
              childWorkspaceIdsByRootId.get(workspace.id),
              sidebarWorkspacesById,
            ),
          ),
        );
        const orderedProjectWorkspaceIds = projectWorkspaces.map((workspace) => workspace.id);
        const renderedWorkspaceIds = pinnedCollapsedWorkspace
          ? [pinnedCollapsedWorkspace.id]
          : visibleProjectWorkspaces.map((workspace) => workspace.id);
        const showEmptyWorkspaceState = project.expanded && projectWorkspaces.length === 0;

        return {
          hasHiddenWorkspaces,
          hiddenWorkspaceStatus,
          orderedProjectWorkspaceIds,
          project,
          projectStatus,
          renderedWorkspaceIds,
          showEmptyWorkspaceState,
          shouldShowWorkspacePanel,
          isWorkspaceListExpanded,
        };
      }),
    [
      appSettings.sidebarWorkspaceSortOrder,
      childWorkspaceIdsByRootId,
      effectiveRouteWorkspaceId,
      expandedWorkspaceListsByProject,
      sortedProjects,
      sidebarWorkspacesById,
      visibleWorkspaceIdsByProjectId,
      workspaceLastVisitedAtById,
    ],
  );
  const visibleSidebarWorkspaceIds = useMemo(
    () => getVisibleSidebarWorkspaceIds(renderedProjects),
    [renderedProjects],
  );
  const workspaceJumpCommandById = useMemo(() => {
    const mapping = new Map<
      WorkspaceId,
      NonNullable<ReturnType<typeof workspaceJumpCommandForIndex>>
    >();
    for (const [visibleWorkspaceIndex, workspaceId] of visibleSidebarWorkspaceIds.entries()) {
      const jumpCommand = workspaceJumpCommandForIndex(visibleWorkspaceIndex);
      if (!jumpCommand) {
        return mapping;
      }
      mapping.set(workspaceId, jumpCommand);
    }

    return mapping;
  }, [visibleSidebarWorkspaceIds]);
  const workspaceJumpWorkspaceIds = useMemo(
    () => [...workspaceJumpCommandById.keys()],
    [workspaceJumpCommandById],
  );
  const workspaceJumpLabelById = useMemo(() => {
    const mapping = new Map<WorkspaceId, string>();
    for (const [workspaceId, command] of workspaceJumpCommandById) {
      const label = shortcutLabelForCommand(keybindings, command, sidebarShortcutLabelOptions);
      if (label) {
        mapping.set(workspaceId, label);
      }
    }
    return mapping;
  }, [keybindings, sidebarShortcutLabelOptions, workspaceJumpCommandById]);
  const orderedSidebarWorkspaceIds = visibleSidebarWorkspaceIds;

  useEffect(() => {
    const getShortcutContext = () => ({
      terminalFocus: isTerminalFocused(),
      terminalOpen: routeTerminalOpen,
    });

    const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
      updateWorkspaceJumpHintsVisibility(
        shouldShowWorkspaceJumpHints(event, keybindings, {
          platform,
          context: getShortcutContext(),
        }),
      );

      if (isSidebarToggleShortcut(event, keybindings, { platform })) {
        event.preventDefault();
        event.stopPropagation();
        toggleSidebar();
        return;
      }

      if (event.defaultPrevented || event.repeat) {
        return;
      }

      const command = resolveShortcutCommand(event, keybindings, {
        platform,
        context: getShortcutContext(),
      });
      const traversalDirection = workspaceTraversalDirectionFromCommand(command);
      if (traversalDirection !== null) {
        const targetWorkspaceId = resolveAdjacentWorkspaceId({
          workspaceIds: orderedSidebarWorkspaceIds,
          currentWorkspaceId: effectiveRouteWorkspaceId,
          direction: traversalDirection,
        });
        if (!targetWorkspaceId) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        navigateToWorkspace(targetWorkspaceId);
        return;
      }

      const jumpIndex = workspaceJumpIndexFromCommand(command ?? "");
      if (jumpIndex === null) {
        return;
      }

      const targetWorkspaceId = workspaceJumpWorkspaceIds[jumpIndex];
      if (!targetWorkspaceId) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      navigateToWorkspace(targetWorkspaceId);
    };

    const onWindowKeyUp = (event: globalThis.KeyboardEvent) => {
      updateWorkspaceJumpHintsVisibility(
        shouldShowWorkspaceJumpHints(event, keybindings, {
          platform,
          context: getShortcutContext(),
        }),
      );
    };

    const onWindowBlur = () => {
      updateWorkspaceJumpHintsVisibility(false);
    };

    window.addEventListener("keydown", onWindowKeyDown, { capture: true });
    window.addEventListener("keyup", onWindowKeyUp);
    window.addEventListener("blur", onWindowBlur);

    return () => {
      window.removeEventListener("keydown", onWindowKeyDown, { capture: true });
      window.removeEventListener("keyup", onWindowKeyUp);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [
    keybindings,
    navigateToWorkspace,
    orderedSidebarWorkspaceIds,
    platform,
    effectiveRouteWorkspaceId,
    routeTerminalOpen,
    workspaceJumpWorkspaceIds,
    toggleSidebar,
    updateWorkspaceJumpHintsVisibility,
  ]);

  function renderProjectItem(
    renderedProject: (typeof renderedProjects)[number],
    dragHandleProps: SortableProjectHandleProps | null,
  ) {
    const {
      hasHiddenWorkspaces,
      hiddenWorkspaceStatus,
      orderedProjectWorkspaceIds,
      project,
      projectStatus,
      renderedWorkspaceIds,
      showEmptyWorkspaceState,
      shouldShowWorkspacePanel,
      isWorkspaceListExpanded,
    } = renderedProject;
    return (
      <>
        <div className="group/project-header relative">
          <SidebarMenuButton
            ref={isManualProjectSorting ? dragHandleProps?.setActivatorNodeRef : undefined}
            size="sm"
            className={`gap-2 px-2 py-1.5 text-left hover:bg-accent group-hover/project-header:bg-accent group-hover/project-header:text-sidebar-accent-foreground ${
              isManualProjectSorting ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"
            }`}
            {...(isManualProjectSorting && dragHandleProps ? dragHandleProps.attributes : {})}
            {...(isManualProjectSorting && dragHandleProps ? dragHandleProps.listeners : {})}
            onPointerDownCapture={handleProjectTitlePointerDownCapture}
            onClick={(event) => handleProjectTitleClick(event, project.id)}
            onKeyDown={(event) => handleProjectTitleKeyDown(event, project.id)}
            onContextMenu={(event) => {
              event.preventDefault();
              suppressProjectClickForContextMenuRef.current = true;
              void handleProjectContextMenu(project.id, {
                x: event.clientX,
                y: event.clientY,
              });
            }}
          >
            {!project.expanded && projectStatus ? (
              <span
                aria-hidden="true"
                title={projectStatus.label}
                className={`-ml-0.5 relative inline-flex size-3.5 shrink-0 items-center justify-center ${projectStatus.colorClass}`}
              >
                <span className="absolute inset-0 flex items-center justify-center transition-opacity duration-150 group-hover/project-header:opacity-0">
                  <span
                    className={`size-[9px] rounded-full ${projectStatus.dotClass} ${
                      projectStatus.pulse ? "animate-pulse" : ""
                    }`}
                  />
                </span>
                <ChevronRightIcon className="absolute inset-0 m-auto size-3.5 text-muted-foreground/70 opacity-0 transition-opacity duration-150 group-hover/project-header:opacity-100" />
              </span>
            ) : (
              <ChevronRightIcon
                className={`-ml-0.5 size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-150 ${
                  project.expanded ? "rotate-90" : ""
                }`}
              />
            )}
            <ProjectFavicon cwd={project.cwd} />
            <span className="flex-1 truncate text-xs font-medium text-foreground/90">
              {project.name}
            </span>
          </SidebarMenuButton>
          <div className="absolute top-1 right-1.5 flex items-center gap-0.5 opacity-0 transition-opacity group-focus-within/project-header:opacity-100 group-hover/project-header:opacity-100">
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label={`Settings for ${project.name}`}
                    data-testid="project-settings-button"
                    className="flex size-5 items-center justify-center rounded-md p-0 text-muted-foreground/40 transition-colors hover:bg-secondary hover:text-foreground"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setSettingsDialogProjectId(project.id);
                    }}
                  />
                }
              >
                <SettingsIcon className="size-3" />
              </TooltipTrigger>
              <TooltipPopup side="top">Project settings</TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label={`Create new workspace in ${project.name}`}
                    data-testid="new-workspace-button"
                    className="flex size-5 items-center justify-center rounded-md p-0 text-muted-foreground/40 transition-colors hover:bg-secondary hover:text-foreground"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setNewWorkspaceDialogProjectId(project.id);
                    }}
                  />
                }
              >
                <PlusIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="top">
                {newWorkspaceShortcutLabel
                  ? `New workspace (${newWorkspaceShortcutLabel})`
                  : "New workspace"}
              </TooltipPopup>
            </Tooltip>
          </div>
        </div>

        <SidebarMenuSub
          ref={attachWorkspaceListAutoAnimateRef}
          className="mx-1 my-0 w-full translate-x-0 gap-0.5 overflow-hidden px-1.5 py-0"
        >
          {shouldShowWorkspacePanel && showEmptyWorkspaceState ? (
            <SidebarMenuSubItem className="w-full" data-workspace-selection-safe>
              <button
                type="button"
                data-workspace-selection-safe
                className="flex h-6 w-full translate-x-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-left text-[10px] text-muted-foreground/60 transition-colors hover:bg-accent hover:text-muted-foreground"
                onClick={() => setNewWorkspaceDialogProjectId(project.id)}
                aria-label={`Create first workspace in ${project.name}`}
              >
                <PlusIcon className="size-3 shrink-0" />
                <span>New workspace</span>
              </button>
            </SidebarMenuSubItem>
          ) : null}
          {shouldShowWorkspacePanel &&
            renderedWorkspaceIds.map((workspaceId) => (
              <SidebarWorkspaceRow
                key={workspaceId}
                workspaceId={workspaceId}
                orderedProjectWorkspaceIds={orderedProjectWorkspaceIds}
                routeWorkspaceId={effectiveRouteWorkspaceId}
                selectedWorkspaceIds={selectedWorkspaceIds}
                showWorkspaceJumpHints={showWorkspaceJumpHints}
                jumpLabel={workspaceJumpLabelById.get(workspaceId) ?? null}
                appSettingsConfirmWorkspaceArchive={appSettings.confirmWorkspaceArchive}
                renamingWorkspaceId={renamingWorkspaceId}
                renamingTitle={renamingTitle}
                setRenamingTitle={setRenamingTitle}
                renamingInputRef={renamingInputRef}
                renamingCommittedRef={renamingCommittedRef}
                confirmingArchiveWorkspaceId={confirmingArchiveWorkspaceId}
                setConfirmingArchiveWorkspaceId={setConfirmingArchiveWorkspaceId}
                confirmArchiveButtonRefs={confirmArchiveButtonRefs}
                handleWorkspaceClick={handleWorkspaceClick}
                navigateToWorkspace={navigateToWorkspace}
                handleMultiSelectContextMenu={handleMultiSelectContextMenu}
                handleWorkspaceContextMenu={handleWorkspaceContextMenu}
                clearSelection={clearSelection}
                commitRename={commitRename}
                cancelRename={cancelRename}
                attemptArchiveWorkspace={attemptArchiveWorkspace}
                openPrLink={openPrLink}
                pr={prByWorkspaceId.get(workspaceId) ?? null}
                childWorkspaceIds={
                  childWorkspaceIdsByRootId.get(workspaceId) ?? EMPTY_CHILD_WORKSPACE_IDS
                }
              />
            ))}

          {project.expanded && hasHiddenWorkspaces && !isWorkspaceListExpanded && (
            <SidebarMenuSubItem className="w-full">
              <SidebarMenuSubButton
                render={<button type="button" />}
                data-workspace-selection-safe
                size="sm"
                className="h-6 w-full translate-x-0 justify-start px-2 text-left text-[10px] text-muted-foreground/60 hover:bg-accent hover:text-muted-foreground/80"
                onClick={() => {
                  expandWorkspaceListForProject(project.id);
                }}
              >
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  {hiddenWorkspaceStatus && (
                    <WorkspaceStatusLabel status={hiddenWorkspaceStatus} compact />
                  )}
                  <span>Show more</span>
                </span>
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
          )}
          {project.expanded && hasHiddenWorkspaces && isWorkspaceListExpanded && (
            <SidebarMenuSubItem className="w-full">
              <SidebarMenuSubButton
                render={<button type="button" />}
                data-workspace-selection-safe
                size="sm"
                className="h-6 w-full translate-x-0 justify-start px-2 text-left text-[10px] text-muted-foreground/60 hover:bg-accent hover:text-muted-foreground/80"
                onClick={() => {
                  collapseWorkspaceListForProject(project.id);
                }}
              >
                <span>Show less</span>
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
          )}
        </SidebarMenuSub>
      </>
    );
  }

  const handleProjectTitleClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>, projectId: ProjectId) => {
      if (suppressProjectClickForContextMenuRef.current) {
        suppressProjectClickForContextMenuRef.current = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (dragInProgressRef.current) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (suppressProjectClickAfterDragRef.current) {
        // Consume the synthetic click emitted after a drag release.
        suppressProjectClickAfterDragRef.current = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (selectedWorkspaceIds.size > 0) {
        clearSelection();
      }
      toggleProject(projectId);
    },
    [clearSelection, selectedWorkspaceIds.size, toggleProject],
  );

  const handleProjectTitleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, projectId: ProjectId) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      if (dragInProgressRef.current) {
        return;
      }
      toggleProject(projectId);
    },
    [toggleProject],
  );

  useEffect(() => {
    const onMouseDown = (event: globalThis.MouseEvent) => {
      if (selectedWorkspaceIds.size === 0) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!shouldClearWorkspaceSelectionOnMouseDown(target)) return;
      clearSelection();
    };

    window.addEventListener("mousedown", onMouseDown);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
    };
  }, [clearSelection, selectedWorkspaceIds.size]);

  useEffect(() => {
    if (!isElectron) return;
    const bridge = window.desktopBridge;
    if (
      !bridge ||
      typeof bridge.getUpdateState !== "function" ||
      typeof bridge.onUpdateState !== "function"
    ) {
      return;
    }

    let disposed = false;
    let receivedSubscriptionUpdate = false;
    const unsubscribe = bridge.onUpdateState((nextState) => {
      if (disposed) return;
      receivedSubscriptionUpdate = true;
      setDesktopUpdateState(nextState);
    });

    void bridge
      .getUpdateState()
      .then((nextState) => {
        if (disposed || receivedSubscriptionUpdate) return;
        setDesktopUpdateState(nextState);
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  const desktopUpdateButtonDisabled = isDesktopUpdateButtonDisabled(desktopUpdateState);
  const desktopUpdateButtonAction = desktopUpdateState
    ? resolveDesktopUpdateButtonAction(desktopUpdateState)
    : "none";
  const showArm64IntelBuildWarning =
    isElectron && shouldShowArm64IntelBuildWarning(desktopUpdateState);
  const arm64IntelBuildWarningDescription =
    desktopUpdateState && showArm64IntelBuildWarning
      ? getArm64IntelBuildWarningDescription(desktopUpdateState)
      : null;
  const newWorkspaceShortcutLabel =
    shortcutLabelForCommand(keybindings, "chat.newLocal", sidebarShortcutLabelOptions) ??
    shortcutLabelForCommand(keybindings, "chat.new", sidebarShortcutLabelOptions);

  const handleDesktopUpdateButtonClick = useCallback(() => {
    const bridge = window.desktopBridge;
    if (!bridge || !desktopUpdateState) return;
    if (desktopUpdateButtonDisabled || desktopUpdateButtonAction === "none") return;

    if (desktopUpdateButtonAction === "download") {
      void bridge
        .downloadUpdate()
        .then((result) => {
          if (result.completed) {
            toastManager.add({
              type: "success",
              title: "Update downloaded",
              description: "Restart the app from the update button to install it.",
            });
          }
          if (!shouldToastDesktopUpdateActionResult(result)) return;
          const actionError = getDesktopUpdateActionError(result);
          if (!actionError) return;
          toastManager.add({
            type: "error",
            title: "Could not download update",
            description: actionError,
          });
        })
        .catch((error) => {
          toastManager.add({
            type: "error",
            title: "Could not start update download",
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
          });
        });
      return;
    }

    if (desktopUpdateButtonAction === "install") {
      const confirmed = window.confirm(
        getDesktopUpdateInstallConfirmationMessage(desktopUpdateState),
      );
      if (!confirmed) return;
      void bridge
        .installUpdate()
        .then((result) => {
          if (!shouldToastDesktopUpdateActionResult(result)) return;
          const actionError = getDesktopUpdateActionError(result);
          if (!actionError) return;
          toastManager.add({
            type: "error",
            title: "Could not install update",
            description: actionError,
          });
        })
        .catch((error) => {
          toastManager.add({
            type: "error",
            title: "Could not install update",
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
          });
        });
    }
  }, [desktopUpdateButtonAction, desktopUpdateButtonDisabled, desktopUpdateState]);

  const expandWorkspaceListForProject = useCallback((projectId: ProjectId) => {
    setExpandedWorkspaceListsByProject((current) => {
      if (current.has(projectId)) return current;
      const next = new Set(current);
      next.add(projectId);
      return next;
    });
  }, []);

  const collapseWorkspaceListForProject = useCallback((projectId: ProjectId) => {
    setExpandedWorkspaceListsByProject((current) => {
      if (!current.has(projectId)) return current;
      const next = new Set(current);
      next.delete(projectId);
      return next;
    });
  }, []);

  const wordmark = (
    <div className="flex w-full items-center gap-2">
      <SidebarTrigger className="shrink-0 md:hidden" />
      <Tooltip>
        <TooltipTrigger
          render={
            <Link
              aria-label="Go to workspaces"
              className="ml-1 flex min-w-0 flex-1 cursor-pointer items-center gap-1 rounded-md outline-hidden ring-ring transition-colors hover:text-foreground focus-visible:ring-2"
              to="/"
            >
              <MatchaWordmark />
              {APP_STAGE_LABEL && (
                <span className="rounded-full bg-muted/50 px-1.5 py-0.5 text-[8px] font-medium uppercase tracking-[0.18em] text-muted-foreground/60">
                  {APP_STAGE_LABEL}
                </span>
              )}
            </Link>
          }
        />
        <TooltipPopup side="bottom" sideOffset={2}>
          Version {APP_VERSION}
        </TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label="Collapse sidebar"
              className="ml-auto hidden shrink-0 cursor-pointer items-center justify-center rounded-md p-1 text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground md:flex"
              onClick={toggleSidebar}
            />
          }
        >
          <PanelLeftCloseIcon className="size-4" />
        </TooltipTrigger>
        <TooltipPopup side="bottom" sideOffset={2}>
          Collapse sidebar
        </TooltipPopup>
      </Tooltip>
    </div>
  );

  return (
    <>
      {isElectron ? (
        <SidebarHeader
          className="drag-region h-[52px] flex-row items-center gap-2 px-4 py-0"
          style={ELECTRON_TRAFFIC_LIGHTS_LEFT_INSET_STYLE}
        >
          {wordmark}
        </SidebarHeader>
      ) : (
        <SidebarHeader className="gap-3 px-3 py-2 sm:gap-2.5 sm:px-4 sm:py-3">
          {wordmark}
        </SidebarHeader>
      )}

      {isOnSettings ? (
        <SettingsSidebarNav pathname={pathname} />
      ) : (
        <>
          <SidebarContent className="gap-0">
            {showArm64IntelBuildWarning && arm64IntelBuildWarningDescription ? (
              <SidebarGroup className="px-2 pt-2 pb-0">
                <Alert variant="warning" className="rounded-2xl border-warning/40 bg-warning/8">
                  <TriangleAlertIcon />
                  <AlertTitle>Intel build on Apple Silicon</AlertTitle>
                  <AlertDescription>{arm64IntelBuildWarningDescription}</AlertDescription>
                  {desktopUpdateButtonAction !== "none" ? (
                    <AlertAction>
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={desktopUpdateButtonDisabled}
                        onClick={handleDesktopUpdateButtonClick}
                      >
                        {desktopUpdateButtonAction === "download"
                          ? "Download ARM build"
                          : "Install ARM build"}
                      </Button>
                    </AlertAction>
                  ) : null}
                </Alert>
              </SidebarGroup>
            ) : null}
            <SidebarGroup className="px-2 py-2">
              <button
                type="button"
                className="mb-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
                onClick={handleStartAddProject}
              >
                <PlusIcon className="size-3.5" />
                Add project
              </button>
              {shouldShowProjectPathEntry && (
                <div className="mb-2 space-y-1.5 px-1">
                  {isElectron && (
                    <button
                      type="button"
                      className="flex w-full items-center justify-center gap-2 rounded-md border border-border bg-secondary py-1.5 text-xs text-foreground/80 transition-colors duration-150 hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                      onClick={() => void handlePickFolder()}
                      disabled={isPickingFolder || isAddingProject}
                    >
                      <FolderIcon className="size-3.5" />
                      {isPickingFolder ? "Picking folder..." : "Browse for folder"}
                    </button>
                  )}
                  <div className="flex gap-1.5">
                    <input
                      ref={addProjectInputRef}
                      className={`min-w-0 flex-1 rounded-md border bg-secondary px-2 py-1.5 font-mono text-xs text-foreground placeholder:text-muted-foreground/40 focus:outline-none ${
                        addProjectError
                          ? "border-red-500/70 focus:border-red-500"
                          : "border-border focus:border-ring"
                      }`}
                      placeholder="/path/to/repo"
                      value={newCwd}
                      onChange={(event) => {
                        setNewCwd(event.target.value);
                        setAddProjectError(null);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") handleAddProject();
                        if (event.key === "Escape") {
                          setAddingProject(false);
                          setAddProjectError(null);
                        }
                      }}
                      autoFocus
                    />
                    <button
                      type="button"
                      className="shrink-0 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground transition-colors duration-150 hover:bg-primary/90 disabled:opacity-60"
                      onClick={handleAddProject}
                      disabled={!canAddProject}
                    >
                      {isAddingProject ? "Adding..." : "Add"}
                    </button>
                  </div>
                  {addProjectError && (
                    <p className="px-0.5 text-[11px] leading-tight text-red-400">
                      {addProjectError}
                    </p>
                  )}
                </div>
              )}

              {isManualProjectSorting ? (
                <DndContext
                  sensors={projectDnDSensors}
                  collisionDetection={projectCollisionDetection}
                  modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
                  onDragStart={handleProjectDragStart}
                  onDragEnd={handleProjectDragEnd}
                  onDragCancel={handleProjectDragCancel}
                >
                  <SidebarMenu>
                    <SortableContext
                      items={renderedProjects.map((renderedProject) => renderedProject.project.id)}
                      strategy={verticalListSortingStrategy}
                    >
                      {renderedProjects.map((renderedProject) => (
                        <SortableProjectItem
                          key={renderedProject.project.id}
                          projectId={renderedProject.project.id}
                        >
                          {(dragHandleProps) => renderProjectItem(renderedProject, dragHandleProps)}
                        </SortableProjectItem>
                      ))}
                    </SortableContext>
                  </SidebarMenu>
                </DndContext>
              ) : (
                <SidebarMenu ref={attachProjectListAutoAnimateRef}>
                  {renderedProjects.map((renderedProject) => (
                    <SidebarMenuItem key={renderedProject.project.id} className="rounded-md">
                      {renderProjectItem(renderedProject, null)}
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              )}
            </SidebarGroup>
          </SidebarContent>

          <SidebarFooter className="p-2">
            <SidebarUpdatePill />
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  size="sm"
                  className="gap-2 px-2 py-1.5 text-muted-foreground/70 hover:bg-accent hover:text-foreground"
                  onClick={() => void navigate({ to: "/settings" })}
                >
                  <SettingsIcon className="size-3.5" />
                  <span className="text-xs">Settings</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarFooter>
        </>
      )}
      <NewWorkspaceDialog
        open={newWorkspaceDialogProjectId !== null}
        projectId={newWorkspaceDialogProjectId}
        projectName={newWorkspaceDialogProject?.name ?? null}
        defaultCreateWorktree={appSettings.defaultWorkspaceEnvMode === "worktree"}
        onOpenChange={(open) => {
          if (!open) setNewWorkspaceDialogProjectId(null);
        }}
        onConfirm={handleNewWorkspaceDialogConfirm}
      />
      <ProjectSettingsDialog
        open={settingsDialogProjectId !== null}
        projectId={settingsDialogProjectId}
        projectName={settingsDialogProject?.name ?? null}
        scripts={settingsDialogProject?.scripts ?? []}
        onOpenChange={(open) => {
          if (!open) setSettingsDialogProjectId(null);
        }}
        onSave={handleProjectSettingsSave}
      />
    </>
  );
}
