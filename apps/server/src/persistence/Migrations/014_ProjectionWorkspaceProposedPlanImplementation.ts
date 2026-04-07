import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_workspace_proposed_plans
    ADD COLUMN implemented_at TEXT
  `;

  yield* sql`
    ALTER TABLE projection_workspace_proposed_plans
    ADD COLUMN implementation_workspace_id TEXT
  `;
});
