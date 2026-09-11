import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

/**
 * Fork migration 4 — retire the last-good-snapshot table.
 *
 * `fork_usage_snapshots` existed so a restart could show the fork's own Claude poller's
 * last read before its first poll landed. Usage limits now come from upstream's provider
 * snapshots, which the capabilities probe re-reads at startup, so there is nothing to
 * restore. `fork_usage_samples` stays: it is the history chart's series.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP TABLE IF EXISTS fork_usage_snapshots`;
});
