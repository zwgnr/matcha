import {
  type OrchestrationEvent,
  type OrchestrationMessage,
  type OrchestrationProposedPlan,
  type ProjectId,
  type ProviderKind,
  WorkspaceId,
  type OrchestrationReadModel,
  type OrchestrationSession,
  type OrchestrationCheckpointSummary,
  type OrchestrationWorkspace,
  type OrchestrationSessionStatus,
} from "@matcha/contracts";
import { resolveModelSlugForProvider } from "@matcha/shared/model";
import { create } from "zustand";
import {
  findLatestProposedPlan,
  hasActionableProposedPlan,
  derivePendingApprovals,
  derivePendingUserInputs,
} from "./session-logic";
import { sanitizeWorkspaceErrorMessage } from "./rpc/transportError";
import {
  type ChatMessage,
  type Project,
  type SidebarWorkspaceSummary,
  type Workspace,
} from "./types";

// ── State ────────────────────────────────────────────────────────────

export interface AppState {
  projects: Project[];
  workspaces: Workspace[];
  sidebarWorkspacesById: Record<string, SidebarWorkspaceSummary>;
  workspaceIdsByProjectId: Record<string, WorkspaceId[]>;
  bootstrapComplete: boolean;
}

const initialState: AppState = {
  projects: [],
  workspaces: [],
  sidebarWorkspacesById: {},
  workspaceIdsByProjectId: {},
  bootstrapComplete: false,
};
const MAX_WORKSPACE_MESSAGES = 2_000;
const MAX_WORKSPACE_CHECKPOINTS = 500;
const MAX_WORKSPACE_PROPOSED_PLANS = 200;
const MAX_WORKSPACE_ACTIVITIES = 500;
const EMPTY_WORKSPACE_IDS: WorkspaceId[] = [];

// ── Pure helpers ──────────────────────────────────────────────────────

function updateWorkspace(
  workspaces: Workspace[],
  workspaceId: WorkspaceId,
  updater: (t: Workspace) => Workspace,
): Workspace[] {
  let changed = false;
  const next = workspaces.map((t) => {
    if (t.id !== workspaceId) return t;
    const updated = updater(t);
    if (updated !== t) changed = true;
    return updated;
  });
  return changed ? next : workspaces;
}

function updateProject(
  projects: Project[],
  projectId: Project["id"],
  updater: (project: Project) => Project,
): Project[] {
  let changed = false;
  const next = projects.map((project) => {
    if (project.id !== projectId) {
      return project;
    }
    const updated = updater(project);
    if (updated !== project) {
      changed = true;
    }
    return updated;
  });
  return changed ? next : projects;
}

function normalizeModelSelection<T extends { provider: "codex" | "claudeAgent"; model: string }>(
  selection: T,
): T {
  return {
    ...selection,
    model: resolveModelSlugForProvider(selection.provider, selection.model),
  };
}

function mapProjectScripts(scripts: ReadonlyArray<Project["scripts"][number]>): Project["scripts"] {
  return scripts.map((script) => ({ ...script }));
}

function mapSession(session: OrchestrationSession): Workspace["session"] {
  return {
    provider: toLegacyProvider(session.providerName),
    status: toLegacySessionStatus(session.status),
    orchestrationStatus: session.status,
    activeTurnId: session.activeTurnId ?? undefined,
    createdAt: session.updatedAt,
    updatedAt: session.updatedAt,
    ...(session.lastError ? { lastError: session.lastError } : {}),
  };
}

function mapMessage(message: OrchestrationMessage): ChatMessage {
  const attachments = message.attachments?.map((attachment) => ({
    type: "image" as const,
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    previewUrl: toAttachmentPreviewUrl(attachmentPreviewRoutePath(attachment.id)),
  }));

  return {
    id: message.id,
    role: message.role,
    text: message.text,
    turnId: message.turnId,
    createdAt: message.createdAt,
    streaming: message.streaming,
    ...(message.streaming ? {} : { completedAt: message.updatedAt }),
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
  };
}

function mapProposedPlan(
  proposedPlan: OrchestrationProposedPlan,
): Workspace["proposedPlans"][number] {
  return {
    id: proposedPlan.id,
    turnId: proposedPlan.turnId,
    planMarkdown: proposedPlan.planMarkdown,
    implementedAt: proposedPlan.implementedAt,
    implementationWorkspaceId: proposedPlan.implementationWorkspaceId,
    createdAt: proposedPlan.createdAt,
    updatedAt: proposedPlan.updatedAt,
  };
}

function mapTurnDiffSummary(
  checkpoint: OrchestrationCheckpointSummary,
): Workspace["turnDiffSummaries"][number] {
  return {
    turnId: checkpoint.turnId,
    completedAt: checkpoint.completedAt,
    status: checkpoint.status,
    assistantMessageId: checkpoint.assistantMessageId ?? undefined,
    checkpointTurnCount: checkpoint.checkpointTurnCount,
    checkpointRef: checkpoint.checkpointRef,
    files: checkpoint.files.map((file) => ({ ...file })),
  };
}

function mapWorkspace(workspace: OrchestrationWorkspace): Workspace {
  return {
    id: workspace.id,
    codexWorkspaceId: null,
    projectId: workspace.projectId,
    title: workspace.title,
    modelSelection: normalizeModelSelection(workspace.modelSelection),
    runtimeMode: workspace.runtimeMode,
    interactionMode: workspace.interactionMode,
    session: workspace.session ? mapSession(workspace.session) : null,
    messages: workspace.messages.map(mapMessage),
    proposedPlans: workspace.proposedPlans.map(mapProposedPlan),
    error: sanitizeWorkspaceErrorMessage(workspace.session?.lastError),
    createdAt: workspace.createdAt,
    archivedAt: workspace.archivedAt,
    updatedAt: workspace.updatedAt,
    latestTurn: workspace.latestTurn,
    pendingSourceProposedPlan: workspace.latestTurn?.sourceProposedPlan,
    branch: workspace.branch,
    worktreePath: workspace.worktreePath,
    turnDiffSummaries: workspace.checkpoints.map(mapTurnDiffSummary),
    activities: workspace.activities.map((activity) => ({ ...activity })),
  };
}

function mapProject(project: OrchestrationReadModel["projects"][number]): Project {
  return {
    id: project.id,
    name: project.title,
    cwd: project.workspaceRoot,
    defaultModelSelection: project.defaultModelSelection
      ? normalizeModelSelection(project.defaultModelSelection)
      : null,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    scripts: mapProjectScripts(project.scripts),
  };
}

function getLatestUserMessageAt(
  messages: ReadonlyArray<Workspace["messages"][number]>,
): string | null {
  let latestUserMessageAt: string | null = null;

  for (const message of messages) {
    if (message.role !== "user") {
      continue;
    }
    if (latestUserMessageAt === null || message.createdAt > latestUserMessageAt) {
      latestUserMessageAt = message.createdAt;
    }
  }

  return latestUserMessageAt;
}

function buildSidebarWorkspaceSummary(workspace: Workspace): SidebarWorkspaceSummary {
  return {
    id: workspace.id,
    projectId: workspace.projectId,
    title: workspace.title,
    interactionMode: workspace.interactionMode,
    session: workspace.session,
    createdAt: workspace.createdAt,
    archivedAt: workspace.archivedAt,
    updatedAt: workspace.updatedAt,
    latestTurn: workspace.latestTurn,
    branch: workspace.branch,
    worktreePath: workspace.worktreePath,
    latestUserMessageAt: getLatestUserMessageAt(workspace.messages),
    hasPendingApprovals: derivePendingApprovals(workspace.activities).length > 0,
    hasPendingUserInput: derivePendingUserInputs(workspace.activities).length > 0,
    hasActionableProposedPlan: hasActionableProposedPlan(
      findLatestProposedPlan(workspace.proposedPlans, workspace.latestTurn?.turnId ?? null),
    ),
  };
}

function sidebarWorkspaceSummariesEqual(
  left: SidebarWorkspaceSummary | undefined,
  right: SidebarWorkspaceSummary,
): boolean {
  return (
    left !== undefined &&
    left.id === right.id &&
    left.projectId === right.projectId &&
    left.title === right.title &&
    left.interactionMode === right.interactionMode &&
    left.session === right.session &&
    left.createdAt === right.createdAt &&
    left.archivedAt === right.archivedAt &&
    left.updatedAt === right.updatedAt &&
    left.latestTurn === right.latestTurn &&
    left.branch === right.branch &&
    left.worktreePath === right.worktreePath &&
    left.latestUserMessageAt === right.latestUserMessageAt &&
    left.hasPendingApprovals === right.hasPendingApprovals &&
    left.hasPendingUserInput === right.hasPendingUserInput &&
    left.hasActionableProposedPlan === right.hasActionableProposedPlan
  );
}

function appendWorkspaceIdByProjectId(
  workspaceIdsByProjectId: Record<string, WorkspaceId[]>,
  projectId: ProjectId,
  workspaceId: WorkspaceId,
): Record<string, WorkspaceId[]> {
  const existingWorkspaceIds = workspaceIdsByProjectId[projectId] ?? EMPTY_WORKSPACE_IDS;
  if (existingWorkspaceIds.includes(workspaceId)) {
    return workspaceIdsByProjectId;
  }
  return {
    ...workspaceIdsByProjectId,
    [projectId]: [...existingWorkspaceIds, workspaceId],
  };
}

function removeWorkspaceIdByProjectId(
  workspaceIdsByProjectId: Record<string, WorkspaceId[]>,
  projectId: ProjectId,
  workspaceId: WorkspaceId,
): Record<string, WorkspaceId[]> {
  const existingWorkspaceIds = workspaceIdsByProjectId[projectId] ?? EMPTY_WORKSPACE_IDS;
  if (!existingWorkspaceIds.includes(workspaceId)) {
    return workspaceIdsByProjectId;
  }
  const nextWorkspaceIds = existingWorkspaceIds.filter(
    (existingWorkspaceId) => existingWorkspaceId !== workspaceId,
  );
  if (nextWorkspaceIds.length === existingWorkspaceIds.length) {
    return workspaceIdsByProjectId;
  }
  if (nextWorkspaceIds.length === 0) {
    const nextWorkspaceIdsByProjectId = { ...workspaceIdsByProjectId };
    delete nextWorkspaceIdsByProjectId[projectId];
    return nextWorkspaceIdsByProjectId;
  }
  return {
    ...workspaceIdsByProjectId,
    [projectId]: nextWorkspaceIds,
  };
}

function buildWorkspaceIdsByProjectId(
  workspaces: ReadonlyArray<Workspace>,
): Record<string, WorkspaceId[]> {
  const workspaceIdsByProjectId: Record<string, WorkspaceId[]> = {};
  for (const workspace of workspaces) {
    const existingWorkspaceIds =
      workspaceIdsByProjectId[workspace.projectId] ?? EMPTY_WORKSPACE_IDS;
    workspaceIdsByProjectId[workspace.projectId] = [...existingWorkspaceIds, workspace.id];
  }
  return workspaceIdsByProjectId;
}

function buildSidebarWorkspacesById(
  workspaces: ReadonlyArray<Workspace>,
): Record<string, SidebarWorkspaceSummary> {
  return Object.fromEntries(
    workspaces.map((workspace) => [workspace.id, buildSidebarWorkspaceSummary(workspace)]),
  );
}

function checkpointStatusToLatestTurnState(status: "ready" | "missing" | "error") {
  if (status === "error") {
    return "error" as const;
  }
  if (status === "missing") {
    return "interrupted" as const;
  }
  return "completed" as const;
}

function compareActivities(
  left: Workspace["activities"][number],
  right: Workspace["activities"][number],
): number {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
  } else if (left.sequence !== undefined) {
    return 1;
  } else if (right.sequence !== undefined) {
    return -1;
  }

  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function buildLatestTurn(params: {
  previous: Workspace["latestTurn"];
  turnId: NonNullable<Workspace["latestTurn"]>["turnId"];
  state: NonNullable<Workspace["latestTurn"]>["state"];
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  assistantMessageId: NonNullable<Workspace["latestTurn"]>["assistantMessageId"];
  sourceProposedPlan?: Workspace["pendingSourceProposedPlan"];
}): NonNullable<Workspace["latestTurn"]> {
  const resolvedPlan =
    params.previous?.turnId === params.turnId
      ? params.previous.sourceProposedPlan
      : params.sourceProposedPlan;
  return {
    turnId: params.turnId,
    state: params.state,
    requestedAt: params.requestedAt,
    startedAt: params.startedAt,
    completedAt: params.completedAt,
    assistantMessageId: params.assistantMessageId,
    ...(resolvedPlan ? { sourceProposedPlan: resolvedPlan } : {}),
  };
}

function rebindTurnDiffSummariesForAssistantMessage(
  turnDiffSummaries: ReadonlyArray<Workspace["turnDiffSummaries"][number]>,
  turnId: Workspace["turnDiffSummaries"][number]["turnId"],
  assistantMessageId: NonNullable<Workspace["latestTurn"]>["assistantMessageId"],
): Workspace["turnDiffSummaries"] {
  let changed = false;
  const nextSummaries = turnDiffSummaries.map((summary) => {
    if (summary.turnId !== turnId || summary.assistantMessageId === assistantMessageId) {
      return summary;
    }
    changed = true;
    return {
      ...summary,
      assistantMessageId: assistantMessageId ?? undefined,
    };
  });
  return changed ? nextSummaries : [...turnDiffSummaries];
}

function retainWorkspaceMessagesAfterRevert(
  messages: ReadonlyArray<ChatMessage>,
  retainedTurnIds: ReadonlySet<string>,
  turnCount: number,
): ChatMessage[] {
  const retainedMessageIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "system") {
      retainedMessageIds.add(message.id);
      continue;
    }
    if (
      message.turnId !== undefined &&
      message.turnId !== null &&
      retainedTurnIds.has(message.turnId)
    ) {
      retainedMessageIds.add(message.id);
    }
  }

  const retainedUserCount = messages.filter(
    (message) => message.role === "user" && retainedMessageIds.has(message.id),
  ).length;
  const missingUserCount = Math.max(0, turnCount - retainedUserCount);
  if (missingUserCount > 0) {
    const fallbackUserMessages = messages
      .filter(
        (message) =>
          message.role === "user" &&
          !retainedMessageIds.has(message.id) &&
          (message.turnId === undefined ||
            message.turnId === null ||
            retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      )
      .slice(0, missingUserCount);
    for (const message of fallbackUserMessages) {
      retainedMessageIds.add(message.id);
    }
  }

  const retainedAssistantCount = messages.filter(
    (message) => message.role === "assistant" && retainedMessageIds.has(message.id),
  ).length;
  const missingAssistantCount = Math.max(0, turnCount - retainedAssistantCount);
  if (missingAssistantCount > 0) {
    const fallbackAssistantMessages = messages
      .filter(
        (message) =>
          message.role === "assistant" &&
          !retainedMessageIds.has(message.id) &&
          (message.turnId === undefined ||
            message.turnId === null ||
            retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      )
      .slice(0, missingAssistantCount);
    for (const message of fallbackAssistantMessages) {
      retainedMessageIds.add(message.id);
    }
  }

  return messages.filter((message) => retainedMessageIds.has(message.id));
}

function retainWorkspaceActivitiesAfterRevert(
  activities: ReadonlyArray<Workspace["activities"][number]>,
  retainedTurnIds: ReadonlySet<string>,
): Workspace["activities"] {
  return activities.filter(
    (activity) => activity.turnId === null || retainedTurnIds.has(activity.turnId),
  );
}

function retainWorkspaceProposedPlansAfterRevert(
  proposedPlans: ReadonlyArray<Workspace["proposedPlans"][number]>,
  retainedTurnIds: ReadonlySet<string>,
): Workspace["proposedPlans"] {
  return proposedPlans.filter(
    (proposedPlan) => proposedPlan.turnId === null || retainedTurnIds.has(proposedPlan.turnId),
  );
}

function toLegacySessionStatus(
  status: OrchestrationSessionStatus,
): "connecting" | "ready" | "running" | "error" | "closed" {
  switch (status) {
    case "starting":
      return "connecting";
    case "running":
      return "running";
    case "error":
      return "error";
    case "ready":
    case "interrupted":
      return "ready";
    case "idle":
    case "stopped":
      return "closed";
  }
}

function toLegacyProvider(providerName: string | null): ProviderKind {
  if (providerName === "codex" || providerName === "claudeAgent") {
    return providerName;
  }
  return "codex";
}

function resolveWsHttpOrigin(): string {
  if (typeof window === "undefined") return "";
  const bridgeWsUrl = window.desktopBridge?.getWsUrl?.();
  const envWsUrl = import.meta.env.VITE_WS_URL as string | undefined;
  const wsCandidate =
    typeof bridgeWsUrl === "string" && bridgeWsUrl.length > 0
      ? bridgeWsUrl
      : typeof envWsUrl === "string" && envWsUrl.length > 0
        ? envWsUrl
        : null;
  if (!wsCandidate) return window.location.origin;
  try {
    const wsUrl = new URL(wsCandidate);
    const protocol =
      wsUrl.protocol === "wss:" ? "https:" : wsUrl.protocol === "ws:" ? "http:" : wsUrl.protocol;
    return `${protocol}//${wsUrl.host}`;
  } catch {
    return window.location.origin;
  }
}

function toAttachmentPreviewUrl(rawUrl: string): string {
  if (rawUrl.startsWith("/")) {
    return `${resolveWsHttpOrigin()}${rawUrl}`;
  }
  return rawUrl;
}

function attachmentPreviewRoutePath(attachmentId: string): string {
  return `/attachments/${encodeURIComponent(attachmentId)}`;
}

function updateWorkspaceState(
  state: AppState,
  workspaceId: WorkspaceId,
  updater: (workspace: Workspace) => Workspace,
): AppState {
  let updatedWorkspace: Workspace | null = null;
  const workspaces = updateWorkspace(state.workspaces, workspaceId, (workspace) => {
    const nextWorkspace = updater(workspace);
    if (nextWorkspace !== workspace) {
      updatedWorkspace = nextWorkspace;
    }
    return nextWorkspace;
  });
  if (workspaces === state.workspaces || updatedWorkspace === null) {
    return state;
  }

  const nextSummary = buildSidebarWorkspaceSummary(updatedWorkspace);
  const previousSummary = state.sidebarWorkspacesById[workspaceId];
  const sidebarWorkspacesById = sidebarWorkspaceSummariesEqual(previousSummary, nextSummary)
    ? state.sidebarWorkspacesById
    : {
        ...state.sidebarWorkspacesById,
        [workspaceId]: nextSummary,
      };

  if (sidebarWorkspacesById === state.sidebarWorkspacesById) {
    return {
      ...state,
      workspaces,
    };
  }

  return {
    ...state,
    workspaces,
    sidebarWorkspacesById,
  };
}

// ── Pure state transition functions ────────────────────────────────────

export function syncServerReadModel(state: AppState, readModel: OrchestrationReadModel): AppState {
  const projects = readModel.projects
    .filter((project) => project.deletedAt === null)
    .map(mapProject);
  const workspaces = readModel.workspaces
    .filter((workspace) => workspace.deletedAt === null)
    .map(mapWorkspace);
  const sidebarWorkspacesById = buildSidebarWorkspacesById(workspaces);
  const workspaceIdsByProjectId = buildWorkspaceIdsByProjectId(workspaces);
  return {
    ...state,
    projects,
    workspaces,
    sidebarWorkspacesById,
    workspaceIdsByProjectId,
    bootstrapComplete: true,
  };
}

export function applyOrchestrationEvent(state: AppState, event: OrchestrationEvent): AppState {
  switch (event.type) {
    case "project.created": {
      const existingIndex = state.projects.findIndex(
        (project) =>
          project.id === event.payload.projectId || project.cwd === event.payload.workspaceRoot,
      );
      const nextProject = mapProject({
        id: event.payload.projectId,
        title: event.payload.title,
        workspaceRoot: event.payload.workspaceRoot,
        defaultModelSelection: event.payload.defaultModelSelection,
        scripts: event.payload.scripts,
        createdAt: event.payload.createdAt,
        updatedAt: event.payload.updatedAt,
        deletedAt: null,
      });
      const projects =
        existingIndex >= 0
          ? state.projects.map((project, index) =>
              index === existingIndex ? nextProject : project,
            )
          : [...state.projects, nextProject];
      return { ...state, projects };
    }

    case "project.meta-updated": {
      const projects = updateProject(state.projects, event.payload.projectId, (project) => ({
        ...project,
        ...(event.payload.title !== undefined ? { name: event.payload.title } : {}),
        ...(event.payload.workspaceRoot !== undefined ? { cwd: event.payload.workspaceRoot } : {}),
        ...(event.payload.defaultModelSelection !== undefined
          ? {
              defaultModelSelection: event.payload.defaultModelSelection
                ? normalizeModelSelection(event.payload.defaultModelSelection)
                : null,
            }
          : {}),
        ...(event.payload.scripts !== undefined
          ? { scripts: mapProjectScripts(event.payload.scripts) }
          : {}),
        updatedAt: event.payload.updatedAt,
      }));
      return projects === state.projects ? state : { ...state, projects };
    }

    case "project.deleted": {
      const projects = state.projects.filter((project) => project.id !== event.payload.projectId);
      return projects.length === state.projects.length ? state : { ...state, projects };
    }

    case "workspace.created": {
      const existing = state.workspaces.find(
        (workspace) => workspace.id === event.payload.workspaceId,
      );
      const nextWorkspace = mapWorkspace({
        id: event.payload.workspaceId,
        projectId: event.payload.projectId,
        title: event.payload.title,
        modelSelection: event.payload.modelSelection,
        runtimeMode: event.payload.runtimeMode,
        interactionMode: event.payload.interactionMode,
        branch: event.payload.branch,
        worktreePath: event.payload.worktreePath,
        latestTurn: null,
        createdAt: event.payload.createdAt,
        updatedAt: event.payload.updatedAt,
        archivedAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      });
      const workspaces = existing
        ? state.workspaces.map((workspace) =>
            workspace.id === nextWorkspace.id ? nextWorkspace : workspace,
          )
        : [...state.workspaces, nextWorkspace];
      const nextSummary = buildSidebarWorkspaceSummary(nextWorkspace);
      const previousSummary = state.sidebarWorkspacesById[nextWorkspace.id];
      const sidebarWorkspacesById = sidebarWorkspaceSummariesEqual(previousSummary, nextSummary)
        ? state.sidebarWorkspacesById
        : {
            ...state.sidebarWorkspacesById,
            [nextWorkspace.id]: nextSummary,
          };
      const nextWorkspaceIdsByProjectId =
        existing !== undefined && existing.projectId !== nextWorkspace.projectId
          ? removeWorkspaceIdByProjectId(
              state.workspaceIdsByProjectId,
              existing.projectId,
              existing.id,
            )
          : state.workspaceIdsByProjectId;
      const workspaceIdsByProjectId = appendWorkspaceIdByProjectId(
        nextWorkspaceIdsByProjectId,
        nextWorkspace.projectId,
        nextWorkspace.id,
      );
      return {
        ...state,
        workspaces,
        sidebarWorkspacesById,
        workspaceIdsByProjectId,
      };
    }

    case "workspace.deleted": {
      const workspaces = state.workspaces.filter(
        (workspace) => workspace.id !== event.payload.workspaceId,
      );
      if (workspaces.length === state.workspaces.length) {
        return state;
      }
      const deletedWorkspace = state.workspaces.find(
        (workspace) => workspace.id === event.payload.workspaceId,
      );
      const sidebarWorkspacesById = { ...state.sidebarWorkspacesById };
      delete sidebarWorkspacesById[event.payload.workspaceId];
      const workspaceIdsByProjectId = deletedWorkspace
        ? removeWorkspaceIdByProjectId(
            state.workspaceIdsByProjectId,
            deletedWorkspace.projectId,
            deletedWorkspace.id,
          )
        : state.workspaceIdsByProjectId;
      return {
        ...state,
        workspaces,
        sidebarWorkspacesById,
        workspaceIdsByProjectId,
      };
    }

    case "workspace.archived": {
      return updateWorkspaceState(state, event.payload.workspaceId, (workspace) => ({
        ...workspace,
        archivedAt: event.payload.archivedAt,
        updatedAt: event.payload.updatedAt,
      }));
    }

    case "workspace.unarchived": {
      return updateWorkspaceState(state, event.payload.workspaceId, (workspace) => ({
        ...workspace,
        archivedAt: null,
        updatedAt: event.payload.updatedAt,
      }));
    }

    case "workspace.meta-updated": {
      return updateWorkspaceState(state, event.payload.workspaceId, (workspace) => ({
        ...workspace,
        ...(event.payload.title !== undefined ? { title: event.payload.title } : {}),
        ...(event.payload.modelSelection !== undefined
          ? { modelSelection: normalizeModelSelection(event.payload.modelSelection) }
          : {}),
        ...(event.payload.branch !== undefined ? { branch: event.payload.branch } : {}),
        ...(event.payload.worktreePath !== undefined
          ? { worktreePath: event.payload.worktreePath }
          : {}),
        updatedAt: event.payload.updatedAt,
      }));
    }

    case "workspace.runtime-mode-set": {
      return updateWorkspaceState(state, event.payload.workspaceId, (workspace) => ({
        ...workspace,
        runtimeMode: event.payload.runtimeMode,
        updatedAt: event.payload.updatedAt,
      }));
    }

    case "workspace.interaction-mode-set": {
      return updateWorkspaceState(state, event.payload.workspaceId, (workspace) => ({
        ...workspace,
        interactionMode: event.payload.interactionMode,
        updatedAt: event.payload.updatedAt,
      }));
    }

    case "workspace.turn-start-requested": {
      return updateWorkspaceState(state, event.payload.workspaceId, (workspace) => ({
        ...workspace,
        ...(event.payload.modelSelection !== undefined
          ? { modelSelection: normalizeModelSelection(event.payload.modelSelection) }
          : {}),
        runtimeMode: event.payload.runtimeMode,
        interactionMode: event.payload.interactionMode,
        pendingSourceProposedPlan: event.payload.sourceProposedPlan,
        updatedAt: event.occurredAt,
      }));
    }

    case "workspace.turn-interrupt-requested": {
      if (event.payload.turnId === undefined) {
        return state;
      }
      return updateWorkspaceState(state, event.payload.workspaceId, (workspace) => {
        const latestTurn = workspace.latestTurn;
        if (latestTurn === null || latestTurn.turnId !== event.payload.turnId) {
          return workspace;
        }
        return {
          ...workspace,
          latestTurn: buildLatestTurn({
            previous: latestTurn,
            turnId: event.payload.turnId,
            state: "interrupted",
            requestedAt: latestTurn.requestedAt,
            startedAt: latestTurn.startedAt ?? event.payload.createdAt,
            completedAt: latestTurn.completedAt ?? event.payload.createdAt,
            assistantMessageId: latestTurn.assistantMessageId,
          }),
          updatedAt: event.occurredAt,
        };
      });
    }

    case "workspace.message-sent": {
      return updateWorkspaceState(state, event.payload.workspaceId, (workspace) => {
        const message = mapMessage({
          id: event.payload.messageId,
          role: event.payload.role,
          text: event.payload.text,
          ...(event.payload.attachments !== undefined
            ? { attachments: event.payload.attachments }
            : {}),
          turnId: event.payload.turnId,
          streaming: event.payload.streaming,
          createdAt: event.payload.createdAt,
          updatedAt: event.payload.updatedAt,
        });
        const existingMessage = workspace.messages.find((entry) => entry.id === message.id);
        const messages = existingMessage
          ? workspace.messages.map((entry) =>
              entry.id !== message.id
                ? entry
                : {
                    ...entry,
                    text: message.streaming
                      ? `${entry.text}${message.text}`
                      : message.text.length > 0
                        ? message.text
                        : entry.text,
                    streaming: message.streaming,
                    ...(message.turnId !== undefined ? { turnId: message.turnId } : {}),
                    ...(message.streaming
                      ? entry.completedAt !== undefined
                        ? { completedAt: entry.completedAt }
                        : {}
                      : message.completedAt !== undefined
                        ? { completedAt: message.completedAt }
                        : {}),
                    ...(message.attachments !== undefined
                      ? { attachments: message.attachments }
                      : {}),
                  },
            )
          : [...workspace.messages, message];
        const cappedMessages = messages.slice(-MAX_WORKSPACE_MESSAGES);
        const turnDiffSummaries =
          event.payload.role === "assistant" && event.payload.turnId !== null
            ? rebindTurnDiffSummariesForAssistantMessage(
                workspace.turnDiffSummaries,
                event.payload.turnId,
                event.payload.messageId,
              )
            : workspace.turnDiffSummaries;
        const latestTurn: Workspace["latestTurn"] =
          event.payload.role === "assistant" &&
          event.payload.turnId !== null &&
          (workspace.latestTurn === null || workspace.latestTurn.turnId === event.payload.turnId)
            ? buildLatestTurn({
                previous: workspace.latestTurn,
                turnId: event.payload.turnId,
                state: event.payload.streaming
                  ? "running"
                  : workspace.latestTurn?.state === "interrupted"
                    ? "interrupted"
                    : workspace.latestTurn?.state === "error"
                      ? "error"
                      : "completed",
                requestedAt:
                  workspace.latestTurn?.turnId === event.payload.turnId
                    ? workspace.latestTurn.requestedAt
                    : event.payload.createdAt,
                startedAt:
                  workspace.latestTurn?.turnId === event.payload.turnId
                    ? (workspace.latestTurn.startedAt ?? event.payload.createdAt)
                    : event.payload.createdAt,
                sourceProposedPlan: workspace.pendingSourceProposedPlan,
                completedAt: event.payload.streaming
                  ? workspace.latestTurn?.turnId === event.payload.turnId
                    ? (workspace.latestTurn.completedAt ?? null)
                    : null
                  : event.payload.updatedAt,
                assistantMessageId: event.payload.messageId,
              })
            : workspace.latestTurn;
        return {
          ...workspace,
          messages: cappedMessages,
          turnDiffSummaries,
          latestTurn,
          updatedAt: event.occurredAt,
        };
      });
    }

    case "workspace.session-set": {
      return updateWorkspaceState(state, event.payload.workspaceId, (workspace) => ({
        ...workspace,
        session: mapSession(event.payload.session),
        error: sanitizeWorkspaceErrorMessage(event.payload.session.lastError),
        latestTurn:
          event.payload.session.status === "running" && event.payload.session.activeTurnId !== null
            ? buildLatestTurn({
                previous: workspace.latestTurn,
                turnId: event.payload.session.activeTurnId,
                state: "running",
                requestedAt:
                  workspace.latestTurn?.turnId === event.payload.session.activeTurnId
                    ? workspace.latestTurn.requestedAt
                    : event.payload.session.updatedAt,
                startedAt:
                  workspace.latestTurn?.turnId === event.payload.session.activeTurnId
                    ? (workspace.latestTurn.startedAt ?? event.payload.session.updatedAt)
                    : event.payload.session.updatedAt,
                completedAt: null,
                assistantMessageId:
                  workspace.latestTurn?.turnId === event.payload.session.activeTurnId
                    ? workspace.latestTurn.assistantMessageId
                    : null,
                sourceProposedPlan: workspace.pendingSourceProposedPlan,
              })
            : workspace.latestTurn,
        updatedAt: event.occurredAt,
      }));
    }

    case "workspace.session-stop-requested": {
      return updateWorkspaceState(state, event.payload.workspaceId, (workspace) =>
        workspace.session === null
          ? workspace
          : {
              ...workspace,
              session: {
                ...workspace.session,
                status: "closed",
                orchestrationStatus: "stopped",
                activeTurnId: undefined,
                updatedAt: event.payload.createdAt,
              },
              updatedAt: event.occurredAt,
            },
      );
    }

    case "workspace.proposed-plan-upserted": {
      return updateWorkspaceState(state, event.payload.workspaceId, (workspace) => {
        const proposedPlan = mapProposedPlan(event.payload.proposedPlan);
        const proposedPlans = [
          ...workspace.proposedPlans.filter((entry) => entry.id !== proposedPlan.id),
          proposedPlan,
        ]
          .toSorted(
            (left, right) =>
              left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
          )
          .slice(-MAX_WORKSPACE_PROPOSED_PLANS);
        return {
          ...workspace,
          proposedPlans,
          updatedAt: event.occurredAt,
        };
      });
    }

    case "workspace.turn-diff-completed": {
      return updateWorkspaceState(state, event.payload.workspaceId, (workspace) => {
        const checkpoint = mapTurnDiffSummary({
          turnId: event.payload.turnId,
          checkpointTurnCount: event.payload.checkpointTurnCount,
          checkpointRef: event.payload.checkpointRef,
          status: event.payload.status,
          files: event.payload.files,
          assistantMessageId: event.payload.assistantMessageId,
          completedAt: event.payload.completedAt,
        });
        const existing = workspace.turnDiffSummaries.find(
          (entry) => entry.turnId === checkpoint.turnId,
        );
        if (existing && existing.status !== "missing" && checkpoint.status === "missing") {
          return workspace;
        }
        const turnDiffSummaries = [
          ...workspace.turnDiffSummaries.filter((entry) => entry.turnId !== checkpoint.turnId),
          checkpoint,
        ]
          .toSorted(
            (left, right) =>
              (left.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER) -
              (right.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER),
          )
          .slice(-MAX_WORKSPACE_CHECKPOINTS);
        const latestTurn =
          workspace.latestTurn === null || workspace.latestTurn.turnId === event.payload.turnId
            ? buildLatestTurn({
                previous: workspace.latestTurn,
                turnId: event.payload.turnId,
                state: checkpointStatusToLatestTurnState(event.payload.status),
                requestedAt: workspace.latestTurn?.requestedAt ?? event.payload.completedAt,
                startedAt: workspace.latestTurn?.startedAt ?? event.payload.completedAt,
                completedAt: event.payload.completedAt,
                assistantMessageId: event.payload.assistantMessageId,
                sourceProposedPlan: workspace.pendingSourceProposedPlan,
              })
            : workspace.latestTurn;
        return {
          ...workspace,
          turnDiffSummaries,
          latestTurn,
          updatedAt: event.occurredAt,
        };
      });
    }

    case "workspace.reverted": {
      return updateWorkspaceState(state, event.payload.workspaceId, (workspace) => {
        const turnDiffSummaries = workspace.turnDiffSummaries
          .filter(
            (entry) =>
              entry.checkpointTurnCount !== undefined &&
              entry.checkpointTurnCount <= event.payload.turnCount,
          )
          .toSorted(
            (left, right) =>
              (left.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER) -
              (right.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER),
          )
          .slice(-MAX_WORKSPACE_CHECKPOINTS);
        const retainedTurnIds = new Set(turnDiffSummaries.map((entry) => entry.turnId));
        const messages = retainWorkspaceMessagesAfterRevert(
          workspace.messages,
          retainedTurnIds,
          event.payload.turnCount,
        ).slice(-MAX_WORKSPACE_MESSAGES);
        const proposedPlans = retainWorkspaceProposedPlansAfterRevert(
          workspace.proposedPlans,
          retainedTurnIds,
        ).slice(-MAX_WORKSPACE_PROPOSED_PLANS);
        const activities = retainWorkspaceActivitiesAfterRevert(
          workspace.activities,
          retainedTurnIds,
        );
        const latestCheckpoint = turnDiffSummaries.at(-1) ?? null;

        return {
          ...workspace,
          turnDiffSummaries,
          messages,
          proposedPlans,
          activities,
          pendingSourceProposedPlan: undefined,
          latestTurn:
            latestCheckpoint === null
              ? null
              : {
                  turnId: latestCheckpoint.turnId,
                  state: checkpointStatusToLatestTurnState(
                    (latestCheckpoint.status ?? "ready") as "ready" | "missing" | "error",
                  ),
                  requestedAt: latestCheckpoint.completedAt,
                  startedAt: latestCheckpoint.completedAt,
                  completedAt: latestCheckpoint.completedAt,
                  assistantMessageId: latestCheckpoint.assistantMessageId ?? null,
                },
          updatedAt: event.occurredAt,
        };
      });
    }

    case "workspace.activity-appended": {
      return updateWorkspaceState(state, event.payload.workspaceId, (workspace) => {
        const activities = [
          ...workspace.activities.filter((activity) => activity.id !== event.payload.activity.id),
          { ...event.payload.activity },
        ]
          .toSorted(compareActivities)
          .slice(-MAX_WORKSPACE_ACTIVITIES);
        return {
          ...workspace,
          activities,
          updatedAt: event.occurredAt,
        };
      });
    }

    case "workspace.approval-response-requested":
    case "workspace.user-input-response-requested":
      return state;
  }

  return state;
}

export function applyOrchestrationEvents(
  state: AppState,
  events: ReadonlyArray<OrchestrationEvent>,
): AppState {
  if (events.length === 0) {
    return state;
  }
  return events.reduce((nextState, event) => applyOrchestrationEvent(nextState, event), state);
}

export const selectProjectById =
  (projectId: Project["id"] | null | undefined) =>
  (state: AppState): Project | undefined =>
    projectId ? state.projects.find((project) => project.id === projectId) : undefined;

export const selectWorkspaceById =
  (workspaceId: WorkspaceId | null | undefined) =>
  (state: AppState): Workspace | undefined =>
    workspaceId ? state.workspaces.find((workspace) => workspace.id === workspaceId) : undefined;

export const selectSidebarWorkspaceSummaryById =
  (workspaceId: WorkspaceId | null | undefined) =>
  (state: AppState): SidebarWorkspaceSummary | undefined =>
    workspaceId ? state.sidebarWorkspacesById[workspaceId] : undefined;

export const selectWorkspaceIdsByProjectId =
  (projectId: ProjectId | null | undefined) =>
  (state: AppState): WorkspaceId[] =>
    projectId
      ? (state.workspaceIdsByProjectId[projectId] ?? EMPTY_WORKSPACE_IDS)
      : EMPTY_WORKSPACE_IDS;

export function setError(
  state: AppState,
  workspaceId: WorkspaceId,
  error: string | null,
): AppState {
  return updateWorkspaceState(state, workspaceId, (t) => {
    if (t.error === error) return t;
    return { ...t, error };
  });
}

export function setWorkspaceBranch(
  state: AppState,
  workspaceId: WorkspaceId,
  branch: string | null,
  worktreePath: string | null,
): AppState {
  return updateWorkspaceState(state, workspaceId, (t) => {
    if (t.branch === branch && t.worktreePath === worktreePath) return t;
    const cwdChanged = t.worktreePath !== worktreePath;
    return {
      ...t,
      branch,
      worktreePath,
      ...(cwdChanged ? { session: null } : {}),
    };
  });
}

// ── Zustand store ────────────────────────────────────────────────────

interface AppStore extends AppState {
  syncServerReadModel: (readModel: OrchestrationReadModel) => void;
  applyOrchestrationEvent: (event: OrchestrationEvent) => void;
  applyOrchestrationEvents: (events: ReadonlyArray<OrchestrationEvent>) => void;
  setError: (workspaceId: WorkspaceId, error: string | null) => void;
  setWorkspaceBranch: (
    workspaceId: WorkspaceId,
    branch: string | null,
    worktreePath: string | null,
  ) => void;
}

export const useStore = create<AppStore>((set) => ({
  ...initialState,
  syncServerReadModel: (readModel) => set((state) => syncServerReadModel(state, readModel)),
  applyOrchestrationEvent: (event) => set((state) => applyOrchestrationEvent(state, event)),
  applyOrchestrationEvents: (events) => set((state) => applyOrchestrationEvents(state, events)),
  setError: (workspaceId, error) => set((state) => setError(state, workspaceId, error)),
  setWorkspaceBranch: (workspaceId, branch, worktreePath) =>
    set((state) => setWorkspaceBranch(state, workspaceId, branch, worktreePath)),
}));
