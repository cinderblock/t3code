/**
 * Fork migrations, tracked in their own table. Effect's `Migrator` keeps only a high-water mark,
 * so any fork id interleaved with upstream's would make later upstream migrations either collide
 * or be skipped silently. See `plans/merge-upstream-main-2026-07-25.md`.
 */

import * as Migrator from "effect/sql/Migrator";
import * as Effect from "effect/Effect";

import ForkMigration0001 from "./Migrations/fork/001_UsageSamples.ts";
import ForkMigration0002 from "./Migrations/fork/002_QueuedMessages.ts";
import ForkMigration0003 from "./Migrations/fork/003_UsageSnapshots.ts";
import ForkMigration0004 from "./Migrations/fork/004_DropUsageSnapshots.ts";
import ForkMigration0005 from "./Migrations/fork/005_RepairUpstreamMigrationRows.ts";
import ForkMigration0006 from "./Migrations/fork/006_AuthPasskeys.ts";
import ForkMigration0007 from "./Migrations/fork/007_AdministrativePasskeys.ts";
import ForkMigration0008 from "./Migrations/fork/008_QueuedMessageContent.ts";
import ForkMigration0009 from "./Migrations/fork/009_QueuedMessageRestore.ts";

/** Tracking table for fork migrations, kept apart from upstream's `effect_sql_migrations`. */
export const FORK_MIGRATIONS_TABLE = "t3fork_migrations";

const forkMigrationEntries = [
  [1, "UsageSamples", ForkMigration0001],
  [2, "QueuedMessages", ForkMigration0002],
  [3, "UsageSnapshots", ForkMigration0003],
  [4, "DropUsageSnapshots", ForkMigration0004],
  [5, "RepairUpstreamMigrationRows", ForkMigration0005],
  [6, "AuthPasskeys", ForkMigration0006],
  [7, "AdministrativePasskeys", ForkMigration0007],
  [8, "QueuedMessageContent", ForkMigration0008],
  [9, "QueuedMessageRestore", ForkMigration0009],
] as const;

const makeForkMigrationLoader = (throughId?: number) =>
  Migrator.fromRecord(
    Object.fromEntries(
      forkMigrationEntries
        .filter(([id]) => throughId === undefined || id <= throughId)
        .map(([id, name, migration]) => [`${id}_${name}`, migration]),
    ),
  );

const run = Migrator.make({});

export interface RunForkMigrationsOptions {
  readonly toMigrationInclusive?: number | undefined;
}

/**
 * Run all pending fork migrations.
 *
 * Must run *after* {@link ../persistence/Migrations.ts | runMigrations} so fork
 * migrations may reference upstream tables.
 */
export const runForkMigrations = Effect.fn("runForkMigrations")(function* ({
  toMigrationInclusive,
}: RunForkMigrationsOptions = {}) {
  const executedMigrations = yield* run({
    loader: makeForkMigrationLoader(toMigrationInclusive),
    table: FORK_MIGRATIONS_TABLE,
  });
  const migrations = executedMigrations.map(([id, name]) => `fork:${id}_${name}`);
  yield* migrations.length === 0
    ? Effect.logDebug("Fork database schema is current")
    : Effect.log("Fork migrations ran successfully").pipe(Effect.annotateLogs({ migrations }));
  return executedMigrations;
});
