import * as SqlClient from "effect/sql/SqlClient";
import * as Effect from "effect/Effect";

/**
 * Fork migration 7 — administrator passkeys.
 *
 * A passkey enrolled from a session holding every administrative scope signs
 * in with the administrative set current at sign-in, not the snapshot stored in
 * `scopes_json`, so permissions upstream adds later do not strand it. Existing
 * rows keep their snapshot.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE fork_auth_passkeys ADD COLUMN administrative INTEGER NOT NULL DEFAULT 0
  `;
});
