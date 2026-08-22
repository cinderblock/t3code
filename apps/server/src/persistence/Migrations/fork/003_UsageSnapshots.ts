import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

/**
 * Fork migration 3 — the last good usage snapshot per account.
 *
 * `fork_usage_samples` records one percentage per window per poll, which is
 * everything the history chart needs but not enough to rebuild a snapshot: it
 * carries no severity, scope detail, billing kind or plan label. Poll state was
 * memory-only, so a restart while the usage endpoint was rate-limiting us left
 * the meters blank until a poll finally got through — indistinguishable from the
 * feature being broken.
 *
 * One row per account, replaced on every successful poll, holding the encoded
 * `AccountUsageSnapshot`. See {@link ../fork/001_UsageSamples.ts} for why tables
 * are `fork_`-prefixed. This table is new to the fork migrator, so there is no
 * legacy unprefixed name to adopt.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_usage_snapshots (
      account_key TEXT PRIMARY KEY,
      captured_at TEXT NOT NULL,
      snapshot_json TEXT NOT NULL
    )
  `;
});
