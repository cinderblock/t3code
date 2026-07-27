import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

/**
 * Fork migration 2 — queued (not yet sent) composer messages.
 *
 * See {@link ../fork/001_UsageSamples.ts} for why tables are `fork_`-prefixed and
 * why the legacy unprefixed table is adopted by rename: queued messages may be
 * real pending user work, so recreating the table instead would discard it.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN ('queued_messages', 'fork_queued_messages')
  `;
  const names = tables.map((table) => table.name);
  if (names.includes("queued_messages") && !names.includes("fork_queued_messages")) {
    yield* sql`ALTER TABLE queued_messages RENAME TO fork_queued_messages`;
    yield* sql`DROP INDEX IF EXISTS idx_queued_messages_status`;
  }

  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_queued_messages (
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
    CREATE INDEX IF NOT EXISTS idx_fork_queued_messages_status
    ON fork_queued_messages(status, thread_id)
  `;
});
