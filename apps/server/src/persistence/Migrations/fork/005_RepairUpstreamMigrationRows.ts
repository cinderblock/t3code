import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

/**
 * Fork migration 5 — remove the fork's rows from upstream's migration table.
 *
 * Before the fork migrator existed, the fork's migrations were interleaved into
 * upstream's list and recorded in `effect_sql_migrations` under ids 33–36. Those
 * rows inflate the table's high-water mark, and Effect's migrator skips every
 * upstream migration at or below that mark without running it — silently, with
 * the failure surfacing later as a missing column. `scripts/fix-fork-migration-rows.ts`
 * repairs a database by hand; this does the same on startup so no database
 * depends on someone remembering to run it.
 *
 * Matching is on id AND name: upstream has long since shipped its own 33–36, and
 * a genuine upstream row under one of those ids carries a different name.
 */
const STALE_ROWS: ReadonlyArray<{ readonly id: number; readonly name: string }> = [
  { id: 33, name: "UsageSamples" },
  { id: 34, name: "QueuedMessages" },
  { id: 35, name: "UsageSamples" },
  { id: 36, name: "QueuedMessages" },
];

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
  `;
  if (tables.length === 0) return;
  for (const row of STALE_ROWS) {
    yield* sql`
      DELETE FROM effect_sql_migrations WHERE migration_id = ${row.id} AND name = ${row.name}
    `;
  }
});
