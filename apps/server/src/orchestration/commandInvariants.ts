import type {
  OrchestrationCommand,
  OrchestrationProject,
  OrchestrationReadModel,
  OrchestrationWorkspace,
  ProjectId,
  WorkspaceId,
} from "@matcha/contracts";
import { Effect } from "effect";

import { OrchestrationCommandInvariantError } from "./Errors.ts";

function invariantError(commandType: string, detail: string): OrchestrationCommandInvariantError {
  return new OrchestrationCommandInvariantError({
    commandType,
    detail,
  });
}

export function findWorkspaceById(
  readModel: OrchestrationReadModel,
  workspaceId: WorkspaceId,
): OrchestrationWorkspace | undefined {
  return readModel.workspaces.find((workspace) => workspace.id === workspaceId);
}

export function findProjectById(
  readModel: OrchestrationReadModel,
  projectId: ProjectId,
): OrchestrationProject | undefined {
  return readModel.projects.find((project) => project.id === projectId);
}

export function listWorkspacesByProjectId(
  readModel: OrchestrationReadModel,
  projectId: ProjectId,
): ReadonlyArray<OrchestrationWorkspace> {
  return readModel.workspaces.filter((workspace) => workspace.projectId === projectId);
}

export function requireProject(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly projectId: ProjectId;
}): Effect.Effect<OrchestrationProject, OrchestrationCommandInvariantError> {
  const project = findProjectById(input.readModel, input.projectId);
  if (project) {
    return Effect.succeed(project);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Project '${input.projectId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

export function requireProjectAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly projectId: ProjectId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (!findProjectById(input.readModel, input.projectId)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Project '${input.projectId}' already exists and cannot be created twice.`,
    ),
  );
}

export function requireWorkspace(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly workspaceId: WorkspaceId;
}): Effect.Effect<OrchestrationWorkspace, OrchestrationCommandInvariantError> {
  const workspace = findWorkspaceById(input.readModel, input.workspaceId);
  if (workspace) {
    return Effect.succeed(workspace);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Workspace '${input.workspaceId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

export function requireWorkspaceArchived(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly workspaceId: WorkspaceId;
}): Effect.Effect<OrchestrationWorkspace, OrchestrationCommandInvariantError> {
  return requireWorkspace(input).pipe(
    Effect.flatMap((workspace) =>
      workspace.archivedAt !== null
        ? Effect.succeed(workspace)
        : Effect.fail(
            invariantError(
              input.command.type,
              `Workspace '${input.workspaceId}' is not archived for command '${input.command.type}'.`,
            ),
          ),
    ),
  );
}

export function requireWorkspaceNotArchived(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly workspaceId: WorkspaceId;
}): Effect.Effect<OrchestrationWorkspace, OrchestrationCommandInvariantError> {
  return requireWorkspace(input).pipe(
    Effect.flatMap((workspace) =>
      workspace.archivedAt === null
        ? Effect.succeed(workspace)
        : Effect.fail(
            invariantError(
              input.command.type,
              `Workspace '${input.workspaceId}' is already archived and cannot handle command '${input.command.type}'.`,
            ),
          ),
    ),
  );
}

export function requireWorkspaceAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly workspaceId: WorkspaceId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (!findWorkspaceById(input.readModel, input.workspaceId)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Workspace '${input.workspaceId}' already exists and cannot be created twice.`,
    ),
  );
}

export function requireNonNegativeInteger(input: {
  readonly commandType: OrchestrationCommand["type"];
  readonly field: string;
  readonly value: number;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (Number.isInteger(input.value) && input.value >= 0) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.commandType,
      `${input.field} must be an integer greater than or equal to 0.`,
    ),
  );
}
