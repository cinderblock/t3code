import * as SqlClient from "effect/sql/SqlClient";
import * as Effect from "effect/Effect";

/**
 * Fork migration 9 — a cancelled queued message stays restorable for a while.
 *
 * NULL `restorable_until` means nothing to restore, which is what every older row is: their
 * content was dropped when they were cancelled.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE fork_queued_messages ADD COLUMN restorable_until TEXT`;
  yield* sql`ALTER TABLE fork_queued_messages ADD COLUMN cancelled_by TEXT`;
});
