import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS queued_messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      text TEXT NOT NULL,
      trigger_json TEXT NOT NULL,
      send_context_json TEXT NOT NULL,
      status TEXT NOT NULL,
      origin TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      sent_at TEXT,
      failure_detail TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_queued_messages_status
    ON queued_messages(status, thread_id)
  `;
});
