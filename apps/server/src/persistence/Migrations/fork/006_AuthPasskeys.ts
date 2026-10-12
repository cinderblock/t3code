import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

/**
 * Fork migration 6 — passkey login for public HTTPS origins.
 *
 * `fork_auth_public_access` is a single-row table holding the origins passkeys
 * may be used on and the proxies whose forwarding headers are trusted.
 * `fork_auth_passkeys` stores enrolled WebAuthn credentials; `user_handle` is
 * the WebAuthn user id the authenticator returns on discoverable login.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_auth_public_access (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      origins_json TEXT NOT NULL,
      trusted_proxies_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_auth_passkeys (
      id TEXT PRIMARY KEY,
      credential_id TEXT NOT NULL UNIQUE,
      public_key_jwk TEXT NOT NULL,
      algorithm INTEGER NOT NULL,
      sign_count INTEGER NOT NULL,
      transports_json TEXT NOT NULL,
      user_handle TEXT NOT NULL,
      rp_id TEXT NOT NULL,
      origin TEXT NOT NULL,
      label TEXT NOT NULL,
      scopes_json TEXT NOT NULL,
      backed_up INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT,
      revoked_at TEXT
    )
  `;
});
