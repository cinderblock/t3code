import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

/**
 * Fork migration 1 — Claude usage sample history.
 *
 * Tables carry a `fork_` prefix so they can never collide with a table upstream
 * might add later. Databases created before the fork migrator existed have this
 * table under its old unprefixed name (it shipped as upstream migration 33, then
 * 35); adopt those by renaming rather than recreating, so usage history survives.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN ('usage_samples', 'fork_usage_samples')
  `;
  const names = tables.map((table) => table.name);
  if (names.includes("usage_samples") && !names.includes("fork_usage_samples")) {
    yield* sql`ALTER TABLE usage_samples RENAME TO fork_usage_samples`;
    yield* sql`DROP INDEX IF EXISTS idx_usage_samples_window`;
  }

  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_usage_samples (
      account_key TEXT NOT NULL,
      window_id TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      percent REAL NOT NULL,
      resets_at TEXT,
      PRIMARY KEY (account_key, window_id, captured_at)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_fork_usage_samples_window
    ON fork_usage_samples(account_key, window_id, captured_at)
  `;
});
