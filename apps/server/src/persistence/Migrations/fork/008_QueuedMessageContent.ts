import * as SqlClient from "effect/sql/SqlClient";
import * as Effect from "effect/Effect";

/**
 * Fork migration 8 — queued messages keep everything the composer held, not just the text.
 *
 * NULL on both columns means "text only", which is what every older row is.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE fork_queued_messages ADD COLUMN attachments_json TEXT`;
  yield* sql`ALTER TABLE fork_queued_messages ADD COLUMN context_json TEXT`;
});
