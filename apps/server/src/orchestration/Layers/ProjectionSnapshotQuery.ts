import {
  ChatAttachment,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  OrchestrationCheckpointFile,
  OrchestrationProposedPlanId,
  OrchestrationReadModel,
  ProjectScript,
  TurnId,
  type OrchestrationCheckpointSummary,
  type OrchestrationLatestTurn,
  type OrchestrationMessage,
  type OrchestrationProposedPlan,
  type OrchestrationProject,
  type OrchestrationSession,
  type OrchestrationWorkspace,
  type OrchestrationWorkspaceActivity,
  ModelSelection,
  ProjectId,
  WorkspaceId,
} from "@matcha/contracts";
import { Effect, Layer, Option, Schema, Struct } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  isPersistenceError,
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type ProjectionRepositoryError,
} from "../../persistence/Errors.ts";
import { ProjectionCheckpoint } from "../../persistence/Services/ProjectionCheckpoints.ts";
import { ProjectionProject } from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectionState } from "../../persistence/Services/ProjectionState.ts";
import { ProjectionWorkspaceActivity } from "../../persistence/Services/ProjectionWorkspaceActivities.ts";
import { ProjectionWorkspaceMessage } from "../../persistence/Services/ProjectionWorkspaceMessages.ts";
import { ProjectionWorkspaceProposedPlan } from "../../persistence/Services/ProjectionWorkspaceProposedPlans.ts";
import { ProjectionWorkspaceSession } from "../../persistence/Services/ProjectionWorkspaceSessions.ts";
import { ProjectionWorkspace } from "../../persistence/Services/ProjectionWorkspaces.ts";
import { ORCHESTRATION_PROJECTOR_NAMES } from "./ProjectionPipeline.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotCounts,
  type ProjectionWorkspaceCheckpointContext,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";

const decodeReadModel = Schema.decodeUnknownEffect(OrchestrationReadModel);
const ProjectionProjectDbRowSchema = ProjectionProject.mapFields(
  Struct.assign({
    defaultModelSelection: Schema.NullOr(Schema.fromJsonString(ModelSelection)),
    scripts: Schema.fromJsonString(Schema.Array(ProjectScript)),
  }),
);
const ProjectionWorkspaceMessageDbRowSchema = ProjectionWorkspaceMessage.mapFields(
  Struct.assign({
    isStreaming: Schema.Number,
    attachments: Schema.NullOr(Schema.fromJsonString(Schema.Array(ChatAttachment))),
  }),
);
const ProjectionWorkspaceProposedPlanDbRowSchema = ProjectionWorkspaceProposedPlan;
const ProjectionWorkspaceDbRowSchema = ProjectionWorkspace.mapFields(
  Struct.assign({
    modelSelection: Schema.fromJsonString(ModelSelection),
  }),
);
const ProjectionWorkspaceActivityDbRowSchema = ProjectionWorkspaceActivity.mapFields(
  Struct.assign({
    payload: Schema.fromJsonString(Schema.Unknown),
    sequence: Schema.NullOr(NonNegativeInt),
  }),
);
const ProjectionWorkspaceSessionDbRowSchema = ProjectionWorkspaceSession;
const ProjectionCheckpointDbRowSchema = ProjectionCheckpoint.mapFields(
  Struct.assign({
    files: Schema.fromJsonString(Schema.Array(OrchestrationCheckpointFile)),
  }),
);
const ProjectionLatestTurnDbRowSchema = Schema.Struct({
  workspaceId: ProjectionWorkspace.fields.workspaceId,
  turnId: TurnId,
  state: Schema.String,
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  assistantMessageId: Schema.NullOr(MessageId),
  sourceProposedPlanWorkspaceId: Schema.NullOr(WorkspaceId),
  sourceProposedPlanId: Schema.NullOr(OrchestrationProposedPlanId),
});
const ProjectionStateDbRowSchema = ProjectionState;
const ProjectionCountsRowSchema = Schema.Struct({
  projectCount: Schema.Number,
  workspaceCount: Schema.Number,
});
const WorkspaceRootLookupInput = Schema.Struct({
  workspaceRoot: Schema.String,
});
const ProjectIdLookupInput = Schema.Struct({
  projectId: ProjectId,
});
const WorkspaceIdLookupInput = Schema.Struct({
  workspaceId: WorkspaceId,
});
const ProjectionProjectLookupRowSchema = ProjectionProjectDbRowSchema;
const ProjectionWorkspaceIdLookupRowSchema = Schema.Struct({
  workspaceId: WorkspaceId,
});
const ProjectionWorkspaceCheckpointContextWorkspaceRowSchema = Schema.Struct({
  workspaceId: WorkspaceId,
  projectId: ProjectId,
  workspaceRoot: Schema.String,
  worktreePath: Schema.NullOr(Schema.String),
});

const REQUIRED_SNAPSHOT_PROJECTORS = [
  ORCHESTRATION_PROJECTOR_NAMES.projects,
  ORCHESTRATION_PROJECTOR_NAMES.workspaces,
  ORCHESTRATION_PROJECTOR_NAMES.workspaceMessages,
  ORCHESTRATION_PROJECTOR_NAMES.workspaceProposedPlans,
  ORCHESTRATION_PROJECTOR_NAMES.workspaceActivities,
  ORCHESTRATION_PROJECTOR_NAMES.workspaceSessions,
  ORCHESTRATION_PROJECTOR_NAMES.checkpoints,
] as const;

function maxIso(left: string | null, right: string): string {
  if (left === null) {
    return right;
  }
  return left > right ? left : right;
}

function computeSnapshotSequence(
  stateRows: ReadonlyArray<Schema.Schema.Type<typeof ProjectionStateDbRowSchema>>,
): number {
  if (stateRows.length === 0) {
    return 0;
  }
  const sequenceByProjector = new Map(
    stateRows.map((row) => [row.projector, row.lastAppliedSequence] as const),
  );

  let minSequence = Number.POSITIVE_INFINITY;
  for (const projector of REQUIRED_SNAPSHOT_PROJECTORS) {
    const sequence = sequenceByProjector.get(projector);
    if (sequence === undefined) {
      return 0;
    }
    if (sequence < minSequence) {
      minSequence = sequence;
    }
  }

  return Number.isFinite(minSequence) ? minSequence : 0;
}

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): ProjectionRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeProjectionSnapshotQuery = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const listProjectRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionProjectDbRowSchema,
    execute: () =>
      sql`
        SELECT
          project_id AS "projectId",
          title,
          workspace_root AS "workspaceRoot",
          default_model_selection_json AS "defaultModelSelection",
          scripts_json AS "scripts",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_projects
        ORDER BY created_at ASC, project_id ASC
      `,
  });

  const listWorkspaceRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionWorkspaceDbRowSchema,
    execute: () =>
      sql`
        SELECT
          workspace_id AS "workspaceId",
          project_id AS "projectId",
          title,
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          branch,
          worktree_path AS "worktreePath",
          latest_turn_id AS "latestTurnId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          deleted_at AS "deletedAt"
        FROM projection_workspaces
        ORDER BY created_at ASC, workspace_id ASC
      `,
  });

  const listWorkspaceMessageRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionWorkspaceMessageDbRowSchema,
    execute: () =>
      sql`
        SELECT
          message_id AS "messageId",
          workspace_id AS "workspaceId",
          turn_id AS "turnId",
          role,
          text,
          attachments_json AS "attachments",
          is_streaming AS "isStreaming",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_workspace_messages
        ORDER BY workspace_id ASC, created_at ASC, message_id ASC
      `,
  });

  const listWorkspaceProposedPlanRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionWorkspaceProposedPlanDbRowSchema,
    execute: () =>
      sql`
        SELECT
          plan_id AS "planId",
          workspace_id AS "workspaceId",
          turn_id AS "turnId",
          plan_markdown AS "planMarkdown",
          implemented_at AS "implementedAt",
          implementation_workspace_id AS "implementationWorkspaceId",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_workspace_proposed_plans
        ORDER BY workspace_id ASC, created_at ASC, plan_id ASC
      `,
  });

  const listWorkspaceActivityRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionWorkspaceActivityDbRowSchema,
    execute: () =>
      sql`
        SELECT
          activity_id AS "activityId",
          workspace_id AS "workspaceId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          payload_json AS "payload",
          sequence,
          created_at AS "createdAt"
        FROM projection_workspace_activities
        ORDER BY
          workspace_id ASC,
          CASE WHEN sequence IS NULL THEN 0 ELSE 1 END ASC,
          sequence ASC,
          created_at ASC,
          activity_id ASC
      `,
  });

  const listWorkspaceSessionRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionWorkspaceSessionDbRowSchema,
    execute: () =>
      sql`
        SELECT
          workspace_id AS "workspaceId",
          status,
          provider_name AS "providerName",
          provider_session_id AS "providerSessionId",
          provider_workspace_id AS "providerWorkspaceId",
          runtime_mode AS "runtimeMode",
          active_turn_id AS "activeTurnId",
          last_error AS "lastError",
          updated_at AS "updatedAt"
        FROM projection_workspace_sessions
        ORDER BY workspace_id ASC
      `,
  });

  const listCheckpointRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionCheckpointDbRowSchema,
    execute: () =>
      sql`
        SELECT
          workspace_id AS "workspaceId",
          turn_id AS "turnId",
          checkpoint_turn_count AS "checkpointTurnCount",
          checkpoint_ref AS "checkpointRef",
          checkpoint_status AS "status",
          checkpoint_files_json AS "files",
          assistant_message_id AS "assistantMessageId",
          completed_at AS "completedAt"
        FROM projection_turns
        WHERE checkpoint_turn_count IS NOT NULL
        ORDER BY workspace_id ASC, checkpoint_turn_count ASC
      `,
  });

  const listLatestTurnRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionLatestTurnDbRowSchema,
    execute: () =>
      sql`
        SELECT
          workspace_id AS "workspaceId",
          turn_id AS "turnId",
          state,
          requested_at AS "requestedAt",
          started_at AS "startedAt",
          completed_at AS "completedAt",
          assistant_message_id AS "assistantMessageId",
          source_proposed_plan_workspace_id AS "sourceProposedPlanWorkspaceId",
          source_proposed_plan_id AS "sourceProposedPlanId"
        FROM projection_turns
        WHERE turn_id IS NOT NULL
        ORDER BY workspace_id ASC, requested_at DESC, turn_id DESC
      `,
  });

  const listProjectionStateRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionStateDbRowSchema,
    execute: () =>
      sql`
        SELECT
          projector,
          last_applied_sequence AS "lastAppliedSequence",
          updated_at AS "updatedAt"
        FROM projection_state
      `,
  });

  const readProjectionCounts = SqlSchema.findOne({
    Request: Schema.Void,
    Result: ProjectionCountsRowSchema,
    execute: () =>
      sql`
        SELECT
          (SELECT COUNT(*) FROM projection_projects) AS "projectCount",
          (SELECT COUNT(*) FROM projection_workspaces) AS "workspaceCount"
      `,
  });

  const getActiveProjectRowByWorkspaceRoot = SqlSchema.findOneOption({
    Request: WorkspaceRootLookupInput,
    Result: ProjectionProjectLookupRowSchema,
    execute: ({ workspaceRoot }) =>
      sql`
        SELECT
          project_id AS "projectId",
          title,
          workspace_root AS "workspaceRoot",
          default_model_selection_json AS "defaultModelSelection",
          scripts_json AS "scripts",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_projects
        WHERE workspace_root = ${workspaceRoot}
          AND deleted_at IS NULL
        ORDER BY created_at ASC, project_id ASC
        LIMIT 1
      `,
  });

  const getFirstActiveWorkspaceIdByProject = SqlSchema.findOneOption({
    Request: ProjectIdLookupInput,
    Result: ProjectionWorkspaceIdLookupRowSchema,
    execute: ({ projectId }) =>
      sql`
        SELECT
          workspace_id AS "workspaceId"
        FROM projection_workspaces
        WHERE project_id = ${projectId}
          AND deleted_at IS NULL
        ORDER BY created_at ASC, workspace_id ASC
        LIMIT 1
      `,
  });

  const getWorkspaceCheckpointContextWorkspaceRow = SqlSchema.findOneOption({
    Request: WorkspaceIdLookupInput,
    Result: ProjectionWorkspaceCheckpointContextWorkspaceRowSchema,
    execute: ({ workspaceId }) =>
      sql`
        SELECT
          workspaces.workspace_id AS "workspaceId",
          workspaces.project_id AS "projectId",
          projects.workspace_root AS "workspaceRoot",
          workspaces.worktree_path AS "worktreePath"
        FROM projection_workspaces AS workspaces
        INNER JOIN projection_projects AS projects
          ON projects.project_id = workspaces.project_id
        WHERE workspaces.workspace_id = ${workspaceId}
          AND workspaces.deleted_at IS NULL
        LIMIT 1
      `,
  });

  const listCheckpointRowsByWorkspace = SqlSchema.findAll({
    Request: WorkspaceIdLookupInput,
    Result: ProjectionCheckpointDbRowSchema,
    execute: ({ workspaceId }) =>
      sql`
        SELECT
          workspace_id AS "workspaceId",
          turn_id AS "turnId",
          checkpoint_turn_count AS "checkpointTurnCount",
          checkpoint_ref AS "checkpointRef",
          checkpoint_status AS "status",
          checkpoint_files_json AS "files",
          assistant_message_id AS "assistantMessageId",
          completed_at AS "completedAt"
        FROM projection_turns
        WHERE workspace_id = ${workspaceId}
          AND checkpoint_turn_count IS NOT NULL
        ORDER BY checkpoint_turn_count ASC
      `,
  });

  const getSnapshot: ProjectionSnapshotQueryShape["getSnapshot"] = () =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const [
            projectRows,
            workspaceRows,
            messageRows,
            proposedPlanRows,
            activityRows,
            sessionRows,
            checkpointRows,
            latestTurnRows,
            stateRows,
          ] = yield* Effect.all([
            listProjectRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listProjects:query",
                  "ProjectionSnapshotQuery.getSnapshot:listProjects:decodeRows",
                ),
              ),
            ),
            listWorkspaceRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listWorkspaces:query",
                  "ProjectionSnapshotQuery.getSnapshot:listWorkspaces:decodeRows",
                ),
              ),
            ),
            listWorkspaceMessageRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listWorkspaceMessages:query",
                  "ProjectionSnapshotQuery.getSnapshot:listWorkspaceMessages:decodeRows",
                ),
              ),
            ),
            listWorkspaceProposedPlanRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listWorkspaceProposedPlans:query",
                  "ProjectionSnapshotQuery.getSnapshot:listWorkspaceProposedPlans:decodeRows",
                ),
              ),
            ),
            listWorkspaceActivityRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listWorkspaceActivities:query",
                  "ProjectionSnapshotQuery.getSnapshot:listWorkspaceActivities:decodeRows",
                ),
              ),
            ),
            listWorkspaceSessionRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listWorkspaceSessions:query",
                  "ProjectionSnapshotQuery.getSnapshot:listWorkspaceSessions:decodeRows",
                ),
              ),
            ),
            listCheckpointRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listCheckpoints:query",
                  "ProjectionSnapshotQuery.getSnapshot:listCheckpoints:decodeRows",
                ),
              ),
            ),
            listLatestTurnRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listLatestTurns:query",
                  "ProjectionSnapshotQuery.getSnapshot:listLatestTurns:decodeRows",
                ),
              ),
            ),
            listProjectionStateRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listProjectionState:query",
                  "ProjectionSnapshotQuery.getSnapshot:listProjectionState:decodeRows",
                ),
              ),
            ),
          ]);

          const messagesByWorkspace = new Map<string, Array<OrchestrationMessage>>();
          const proposedPlansByWorkspace = new Map<string, Array<OrchestrationProposedPlan>>();
          const activitiesByWorkspace = new Map<string, Array<OrchestrationWorkspaceActivity>>();
          const checkpointsByWorkspace = new Map<string, Array<OrchestrationCheckpointSummary>>();
          const sessionsByWorkspace = new Map<string, OrchestrationSession>();
          const latestTurnByWorkspace = new Map<string, OrchestrationLatestTurn>();

          let updatedAt: string | null = null;

          for (const row of projectRows) {
            updatedAt = maxIso(updatedAt, row.updatedAt);
          }
          for (const row of workspaceRows) {
            updatedAt = maxIso(updatedAt, row.updatedAt);
          }
          for (const row of stateRows) {
            updatedAt = maxIso(updatedAt, row.updatedAt);
          }

          for (const row of messageRows) {
            updatedAt = maxIso(updatedAt, row.updatedAt);
            const workspaceMessages = messagesByWorkspace.get(row.workspaceId) ?? [];
            workspaceMessages.push({
              id: row.messageId,
              role: row.role,
              text: row.text,
              ...(row.attachments !== null ? { attachments: row.attachments } : {}),
              turnId: row.turnId,
              streaming: row.isStreaming === 1,
              createdAt: row.createdAt,
              updatedAt: row.updatedAt,
            });
            messagesByWorkspace.set(row.workspaceId, workspaceMessages);
          }

          for (const row of proposedPlanRows) {
            updatedAt = maxIso(updatedAt, row.updatedAt);
            const workspaceProposedPlans = proposedPlansByWorkspace.get(row.workspaceId) ?? [];
            workspaceProposedPlans.push({
              id: row.planId,
              turnId: row.turnId,
              planMarkdown: row.planMarkdown,
              implementedAt: row.implementedAt,
              implementationWorkspaceId: row.implementationWorkspaceId,
              createdAt: row.createdAt,
              updatedAt: row.updatedAt,
            });
            proposedPlansByWorkspace.set(row.workspaceId, workspaceProposedPlans);
          }

          for (const row of activityRows) {
            updatedAt = maxIso(updatedAt, row.createdAt);
            const workspaceActivities = activitiesByWorkspace.get(row.workspaceId) ?? [];
            workspaceActivities.push({
              id: row.activityId,
              tone: row.tone,
              kind: row.kind,
              summary: row.summary,
              payload: row.payload,
              turnId: row.turnId,
              ...(row.sequence !== null ? { sequence: row.sequence } : {}),
              createdAt: row.createdAt,
            });
            activitiesByWorkspace.set(row.workspaceId, workspaceActivities);
          }

          for (const row of checkpointRows) {
            updatedAt = maxIso(updatedAt, row.completedAt);
            const workspaceCheckpoints = checkpointsByWorkspace.get(row.workspaceId) ?? [];
            workspaceCheckpoints.push({
              turnId: row.turnId,
              checkpointTurnCount: row.checkpointTurnCount,
              checkpointRef: row.checkpointRef,
              status: row.status,
              files: row.files,
              assistantMessageId: row.assistantMessageId,
              completedAt: row.completedAt,
            });
            checkpointsByWorkspace.set(row.workspaceId, workspaceCheckpoints);
          }

          for (const row of latestTurnRows) {
            updatedAt = maxIso(updatedAt, row.requestedAt);
            if (row.startedAt !== null) {
              updatedAt = maxIso(updatedAt, row.startedAt);
            }
            if (row.completedAt !== null) {
              updatedAt = maxIso(updatedAt, row.completedAt);
            }
            if (latestTurnByWorkspace.has(row.workspaceId)) {
              continue;
            }
            latestTurnByWorkspace.set(row.workspaceId, {
              turnId: row.turnId,
              state:
                row.state === "error"
                  ? "error"
                  : row.state === "interrupted"
                    ? "interrupted"
                    : row.state === "completed"
                      ? "completed"
                      : "running",
              requestedAt: row.requestedAt,
              startedAt: row.startedAt,
              completedAt: row.completedAt,
              assistantMessageId: row.assistantMessageId,
              ...(row.sourceProposedPlanWorkspaceId !== null && row.sourceProposedPlanId !== null
                ? {
                    sourceProposedPlan: {
                      workspaceId: row.sourceProposedPlanWorkspaceId,
                      planId: row.sourceProposedPlanId,
                    },
                  }
                : {}),
            });
          }

          for (const row of sessionRows) {
            updatedAt = maxIso(updatedAt, row.updatedAt);
            sessionsByWorkspace.set(row.workspaceId, {
              workspaceId: row.workspaceId,
              status: row.status,
              providerName: row.providerName,
              runtimeMode: row.runtimeMode,
              activeTurnId: row.activeTurnId,
              lastError: row.lastError,
              updatedAt: row.updatedAt,
            });
          }

          const projects: ReadonlyArray<OrchestrationProject> = projectRows.map((row) => ({
            id: row.projectId,
            title: row.title,
            workspaceRoot: row.workspaceRoot,
            defaultModelSelection: row.defaultModelSelection,
            scripts: row.scripts,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            deletedAt: row.deletedAt,
          }));

          const workspaces: ReadonlyArray<OrchestrationWorkspace> = workspaceRows.map((row) => ({
            id: row.workspaceId,
            projectId: row.projectId,
            title: row.title,
            modelSelection: row.modelSelection,
            runtimeMode: row.runtimeMode,
            interactionMode: row.interactionMode,
            branch: row.branch,
            worktreePath: row.worktreePath,
            latestTurn: latestTurnByWorkspace.get(row.workspaceId) ?? null,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            archivedAt: row.archivedAt,
            deletedAt: row.deletedAt,
            messages: messagesByWorkspace.get(row.workspaceId) ?? [],
            proposedPlans: proposedPlansByWorkspace.get(row.workspaceId) ?? [],
            activities: activitiesByWorkspace.get(row.workspaceId) ?? [],
            checkpoints: checkpointsByWorkspace.get(row.workspaceId) ?? [],
            session: sessionsByWorkspace.get(row.workspaceId) ?? null,
          }));

          const snapshot = {
            snapshotSequence: computeSnapshotSequence(stateRows),
            projects,
            workspaces,
            updatedAt: updatedAt ?? new Date(0).toISOString(),
          };

          return yield* decodeReadModel(snapshot).pipe(
            Effect.mapError(
              toPersistenceDecodeError("ProjectionSnapshotQuery.getSnapshot:decodeReadModel"),
            ),
          );
        }),
      )
      .pipe(
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getSnapshot:query")(error);
        }),
      );

  const getCounts: ProjectionSnapshotQueryShape["getCounts"] = () =>
    readProjectionCounts(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getCounts:query",
          "ProjectionSnapshotQuery.getCounts:decodeRow",
        ),
      ),
      Effect.map(
        (row): ProjectionSnapshotCounts => ({
          projectCount: row.projectCount,
          workspaceCount: row.workspaceCount,
        }),
      ),
    );

  const getActiveProjectByWorkspaceRoot: ProjectionSnapshotQueryShape["getActiveProjectByWorkspaceRoot"] =
    (workspaceRoot) =>
      getActiveProjectRowByWorkspaceRoot({ workspaceRoot }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getActiveProjectByWorkspaceRoot:query",
            "ProjectionSnapshotQuery.getActiveProjectByWorkspaceRoot:decodeRow",
          ),
        ),
        Effect.map(
          Option.map(
            (row): OrchestrationProject => ({
              id: row.projectId,
              title: row.title,
              workspaceRoot: row.workspaceRoot,
              defaultModelSelection: row.defaultModelSelection,
              scripts: row.scripts,
              createdAt: row.createdAt,
              updatedAt: row.updatedAt,
              deletedAt: row.deletedAt,
            }),
          ),
        ),
      );

  const getFirstActiveWorkspaceIdByProjectId: ProjectionSnapshotQueryShape["getFirstActiveWorkspaceIdByProjectId"] =
    (projectId) =>
      getFirstActiveWorkspaceIdByProject({ projectId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getFirstActiveWorkspaceIdByProjectId:query",
            "ProjectionSnapshotQuery.getFirstActiveWorkspaceIdByProjectId:decodeRow",
          ),
        ),
        Effect.map(Option.map((row) => row.workspaceId)),
      );

  const getWorkspaceCheckpointContext: ProjectionSnapshotQueryShape["getWorkspaceCheckpointContext"] =
    (workspaceId) =>
      Effect.gen(function* () {
        const workspaceRow = yield* getWorkspaceCheckpointContextWorkspaceRow({ workspaceId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getWorkspaceCheckpointContext:getWorkspace:query",
              "ProjectionSnapshotQuery.getWorkspaceCheckpointContext:getWorkspace:decodeRow",
            ),
          ),
        );
        if (Option.isNone(workspaceRow)) {
          return Option.none<ProjectionWorkspaceCheckpointContext>();
        }

        const checkpointRows = yield* listCheckpointRowsByWorkspace({ workspaceId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getWorkspaceCheckpointContext:listCheckpoints:query",
              "ProjectionSnapshotQuery.getWorkspaceCheckpointContext:listCheckpoints:decodeRows",
            ),
          ),
        );

        return Option.some({
          workspaceId: workspaceRow.value.workspaceId,
          projectId: workspaceRow.value.projectId,
          workspaceRoot: workspaceRow.value.workspaceRoot,
          worktreePath: workspaceRow.value.worktreePath,
          checkpoints: checkpointRows.map(
            (row): OrchestrationCheckpointSummary => ({
              turnId: row.turnId,
              checkpointTurnCount: row.checkpointTurnCount,
              checkpointRef: row.checkpointRef,
              status: row.status,
              files: row.files,
              assistantMessageId: row.assistantMessageId,
              completedAt: row.completedAt,
            }),
          ),
        });
      });

  return {
    getSnapshot,
    getCounts,
    getActiveProjectByWorkspaceRoot,
    getFirstActiveWorkspaceIdByProjectId,
    getWorkspaceCheckpointContext,
  } satisfies ProjectionSnapshotQueryShape;
});

export const OrchestrationProjectionSnapshotQueryLive = Layer.effect(
  ProjectionSnapshotQuery,
  makeProjectionSnapshotQuery,
);
