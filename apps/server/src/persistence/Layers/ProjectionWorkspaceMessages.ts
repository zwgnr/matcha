import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema, Struct } from "effect";
import { ChatAttachment } from "@matcha/contracts";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  GetProjectionWorkspaceMessageInput,
  ProjectionWorkspaceMessageRepository,
  type ProjectionWorkspaceMessageRepositoryShape,
  DeleteProjectionWorkspaceMessagesInput,
  ListProjectionWorkspaceMessagesInput,
  ProjectionWorkspaceMessage,
} from "../Services/ProjectionWorkspaceMessages.ts";

const ProjectionWorkspaceMessageDbRowSchema = ProjectionWorkspaceMessage.mapFields(
  Struct.assign({
    isStreaming: Schema.Number,
    attachments: Schema.NullOr(Schema.fromJsonString(Schema.Array(ChatAttachment))),
  }),
);

function toProjectionWorkspaceMessage(
  row: Schema.Schema.Type<typeof ProjectionWorkspaceMessageDbRowSchema>,
): ProjectionWorkspaceMessage {
  return {
    messageId: row.messageId,
    workspaceId: row.workspaceId,
    turnId: row.turnId,
    role: row.role,
    text: row.text,
    isStreaming: row.isStreaming === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.attachments !== null ? { attachments: row.attachments } : {}),
  };
}

const makeProjectionWorkspaceMessageRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionWorkspaceMessageRow = SqlSchema.void({
    Request: ProjectionWorkspaceMessage,
    execute: (row) => {
      const nextAttachmentsJson =
        row.attachments !== undefined ? JSON.stringify(row.attachments) : null;
      return sql`
        INSERT INTO projection_workspace_messages (
          message_id,
          workspace_id,
          turn_id,
          role,
          text,
          attachments_json,
          is_streaming,
          created_at,
          updated_at
        )
        VALUES (
          ${row.messageId},
          ${row.workspaceId},
          ${row.turnId},
          ${row.role},
          ${row.text},
          COALESCE(
            ${nextAttachmentsJson},
            (
              SELECT attachments_json
              FROM projection_workspace_messages
              WHERE message_id = ${row.messageId}
            )
          ),
          ${row.isStreaming ? 1 : 0},
          ${row.createdAt},
          ${row.updatedAt}
        )
        ON CONFLICT (message_id)
        DO UPDATE SET
          workspace_id = excluded.workspace_id,
          turn_id = excluded.turn_id,
          role = excluded.role,
          text = excluded.text,
          attachments_json = COALESCE(
            excluded.attachments_json,
            projection_workspace_messages.attachments_json
          ),
          is_streaming = excluded.is_streaming,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `;
    },
  });

  const getProjectionWorkspaceMessageRow = SqlSchema.findOneOption({
    Request: GetProjectionWorkspaceMessageInput,
    Result: ProjectionWorkspaceMessageDbRowSchema,
    execute: ({ messageId }) =>
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
        WHERE message_id = ${messageId}
        LIMIT 1
      `,
  });

  const listProjectionWorkspaceMessageRows = SqlSchema.findAll({
    Request: ListProjectionWorkspaceMessagesInput,
    Result: ProjectionWorkspaceMessageDbRowSchema,
    execute: ({ workspaceId }) =>
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
        WHERE workspace_id = ${workspaceId}
        ORDER BY created_at ASC, message_id ASC
      `,
  });

  const deleteProjectionWorkspaceMessageRows = SqlSchema.void({
    Request: DeleteProjectionWorkspaceMessagesInput,
    execute: ({ workspaceId }) =>
      sql`
        DELETE FROM projection_workspace_messages
        WHERE workspace_id = ${workspaceId}
      `,
  });

  const upsert: ProjectionWorkspaceMessageRepositoryShape["upsert"] = (row) =>
    upsertProjectionWorkspaceMessageRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionWorkspaceMessageRepository.upsert:query")),
    );

  const getByMessageId: ProjectionWorkspaceMessageRepositoryShape["getByMessageId"] = (input) =>
    getProjectionWorkspaceMessageRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionWorkspaceMessageRepository.getByMessageId:query"),
      ),
      Effect.map(Option.map(toProjectionWorkspaceMessage)),
    );

  const listByWorkspaceId: ProjectionWorkspaceMessageRepositoryShape["listByWorkspaceId"] = (
    input,
  ) =>
    listProjectionWorkspaceMessageRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionWorkspaceMessageRepository.listByWorkspaceId:query"),
      ),
      Effect.map((rows) => rows.map(toProjectionWorkspaceMessage)),
    );

  const deleteByWorkspaceId: ProjectionWorkspaceMessageRepositoryShape["deleteByWorkspaceId"] = (
    input,
  ) =>
    deleteProjectionWorkspaceMessageRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionWorkspaceMessageRepository.deleteByWorkspaceId:query"),
      ),
    );

  return {
    upsert,
    getByMessageId,
    listByWorkspaceId,
    deleteByWorkspaceId,
  } satisfies ProjectionWorkspaceMessageRepositoryShape;
});

export const ProjectionWorkspaceMessageRepositoryLive = Layer.effect(
  ProjectionWorkspaceMessageRepository,
  makeProjectionWorkspaceMessageRepository,
);
