import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../../Migrations.ts";
import { runForkMigrations, FORK_MIGRATIONS_TABLE } from "../../ForkMigrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

// Each case needs a database of its own: a suite-level `it.layer` would share one
// in-memory database across cases, so migrations run by the first case would
// already be recorded for the rest and the fixtures below would be meaningless.
const withDatabase = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })));

const FORK_MIGRATION_LIST: ReadonlyArray<readonly [number, string]> = [
  [1, "UsageSamples"],
  [2, "QueuedMessages"],
  [3, "UsageSnapshots"],
  [4, "DropUsageSnapshots"],
  [5, "RepairUpstreamMigrationRows"],
];

const tableNames = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table'
  `;
  return rows.map((row) => row.name);
});

const indexNames = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'index'
  `;
  return rows.map((row) => row.name);
});

it.effect("fork migrations track a high-water mark separate from upstream's", () =>
  withDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations();
      yield* runForkMigrations();

      // The two migrators must not share a tracking table. Effect's Migrator skips
      // every migration whose id is <= MAX(migration_id), so a shared table would
      // let one side's ids silently suppress the other's pending migrations.
      const upstream = yield* sql<{ readonly migration_id: number }>`
        SELECT migration_id FROM effect_sql_migrations ORDER BY migration_id DESC
      `;
      const fork = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM ${sql(FORK_MIGRATIONS_TABLE)} ORDER BY migration_id
      `;

      assert.deepStrictEqual<ReadonlyArray<ReadonlyArray<number | string>>>(
        fork.map((row) => [row.migration_id, row.name]),
        FORK_MIGRATION_LIST,
      );
      // Fork ids restart at 1, well below upstream's, which is only safe because
      // they live in a different table.
      assert.isAbove(upstream[0]!.migration_id, FORK_MIGRATION_LIST.length);
    }),
  ),
);

it.effect("fork migrations create fork-prefixed tables on a fresh database", () =>
  withDatabase(
    Effect.gen(function* () {
      yield* runMigrations();
      yield* runForkMigrations();

      const tables = yield* tableNames;
      assert.include(tables, "fork_usage_samples");
      assert.include(tables, "fork_queued_messages");
      // Created by 003 and retired by 004: usage limits now come from the provider
      // snapshots, so there is no last-good read to restore.
      assert.notInclude(tables, "fork_usage_snapshots");
      // Unprefixed names are reserved for upstream, so they must not reappear.
      assert.notInclude(tables, "usage_samples");
      assert.notInclude(tables, "queued_messages");
      assert.notInclude(tables, "usage_snapshots");
    }),
  ),
);

it.effect("fork migrations adopt legacy unprefixed tables, preserving their rows", () =>
  withDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations();

      // Reproduce a database created before the fork migrator existed, when these
      // tables shipped inside upstream's migration list under unprefixed names.
      yield* sql`
        CREATE TABLE usage_samples (
          account_key TEXT NOT NULL,
          window_id TEXT NOT NULL,
          captured_at TEXT NOT NULL,
          percent REAL NOT NULL,
          resets_at TEXT,
          PRIMARY KEY (account_key, window_id, captured_at)
        )
      `;
      yield* sql`
        CREATE INDEX idx_usage_samples_window
        ON usage_samples(account_key, window_id, captured_at)
      `;
      yield* sql`
        INSERT INTO usage_samples (account_key, window_id, captured_at, percent)
        VALUES ('acct-1', 'weekly:all', '2026-07-25T00:00:00.000Z', 19.0)
      `;
      yield* sql`
        CREATE TABLE queued_messages (
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
        INSERT INTO queued_messages (
          id, thread_id, message_id, text, trigger_json, send_context_json,
          status, origin, created_at, updated_at
        )
        VALUES (
          'queued-1', 'thread-1', 'message-1', 'hello', '{}', '{}',
          'pending', 'composer', '2026-07-25T00:00:00.000Z', '2026-07-25T00:00:00.000Z'
        )
      `;

      yield* runForkMigrations();

      const tables = yield* tableNames;
      assert.include(tables, "fork_usage_samples");
      assert.include(tables, "fork_queued_messages");
      assert.notInclude(tables, "usage_samples");
      assert.notInclude(tables, "queued_messages");

      // Renamed, not recreated — the rows must survive, since queued messages can
      // be real pending user work and usage samples are accumulated history.
      const samples = yield* sql<{ readonly percent: number }>`
        SELECT percent FROM fork_usage_samples
      `;
      assert.deepStrictEqual(
        samples.map((row) => row.percent),
        [19.0],
      );
      const queued = yield* sql<{ readonly id: string }>`
        SELECT id FROM fork_queued_messages
      `;
      assert.deepStrictEqual(
        queued.map((row) => row.id),
        ["queued-1"],
      );

      // The stale index followed the rename; the prefixed one replaces it.
      const indexes = yield* indexNames;
      assert.include(indexes, "idx_fork_usage_samples_window");
      assert.notInclude(indexes, "idx_usage_samples_window");
    }),
  ),
);

it.effect("a database stopped at an earlier fork migration picks up the rest", () =>
  withDatabase(
    Effect.gen(function* () {
      yield* runMigrations();

      // Every existing install is here: it ran the fork migrations that existed
      // when it last started, and must adopt newer ones on the next start.
      const before = yield* runForkMigrations({ toMigrationInclusive: 3 });
      assert.strictEqual(before.length, 3);
      assert.include(yield* tableNames, "fork_usage_snapshots");

      const after = yield* runForkMigrations();

      assert.deepStrictEqual<ReadonlyArray<ReadonlyArray<number | string>>>(
        after.map(([id, name]) => [id, name]),
        FORK_MIGRATION_LIST.slice(3),
      );
      assert.notInclude(yield* tableNames, "fork_usage_snapshots");
    }),
  ),
);

it.effect("fork migrations are idempotent across repeated runs", () =>
  withDatabase(
    Effect.gen(function* () {
      yield* runMigrations();
      const first = yield* runForkMigrations();
      const second = yield* runForkMigrations();

      assert.strictEqual(first.length, FORK_MIGRATION_LIST.length);
      assert.strictEqual(second.length, 0);
    }),
  ),
);

it.effect("the repair migration drops the fork's rows from upstream's table by id and name", () =>
  withDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();

      // A database from before the fork migrator recorded the fork's migrations
      // under upstream ids. Upstream's genuine 35/36 never ran there (the whole
      // problem), so stand those rows in for them.
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id IN (35, 36)`;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name, created_at)
        VALUES (35, 'UsageSamples', '2026-07-25T00:00:00.000Z'),
               (36, 'QueuedMessages', '2026-07-25T00:00:00.000Z')
      `;
      const genuineBefore = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM effect_sql_migrations
        WHERE name NOT IN ('UsageSamples', 'QueuedMessages')
      `;

      yield* runForkMigrations();

      const stale = yield* sql<{ readonly migration_id: number }>`
        SELECT migration_id FROM effect_sql_migrations
        WHERE name IN ('UsageSamples', 'QueuedMessages')
      `;
      assert.deepStrictEqual(stale, []);
      const genuineAfter = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM effect_sql_migrations
        WHERE name NOT IN ('UsageSamples', 'QueuedMessages')
      `;
      assert.strictEqual(Number(genuineAfter[0]!.count), Number(genuineBefore[0]!.count));
    }),
  ),
);
