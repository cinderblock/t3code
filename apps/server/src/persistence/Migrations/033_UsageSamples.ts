import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS usage_samples (
      account_key TEXT NOT NULL,
      window_id TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      percent REAL NOT NULL,
      resets_at TEXT,
      PRIMARY KEY (account_key, window_id, captured_at)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_usage_samples_window
    ON usage_samples(account_key, window_id, captured_at)
  `;
});
