/**
 * ForkMigrations - migrations owned by this fork, tracked independently.
 *
 * ## Why this exists separately from `Migrations.ts`
 *
 * Effect's `Migrator` tracks progress as a single **high-water mark**: it reads
 * `MAX(migration_id)` from its table and skips every migration whose id is `<=`
 * that value, regardless of whether that migration actually ran. It records a
 * migration's `name` but never compares it against the code.
 *
 * That makes it unsafe for a fork to interleave its own migrations into
 * upstream's list. Whatever numbering we pick, the next upstream merge breaks it:
 *
 * - Numbering ours *above* upstream's and renumbering on each merge means any new
 *   upstream migration lands below the recorded high-water mark and is **silently
 *   skipped forever** — missing schema, no error, a crash much later at query time.
 * - Numbering ours *into* upstream's range collides on id and fails startup with
 *   `Found duplicate migration id's`.
 * - Reserving a high block (say ids from 1000) is the worst of the three: once a
 *   database records 1000, *every* future upstream migration is below the
 *   high-water mark and is skipped silently, permanently.
 *
 * So fork migrations get their own list, numbered from 1, and their own tracking
 * table. Two independent high-water marks that never see each other: upstream can
 * add migrations forever and so can we. As a bonus, `Migrations.ts` stays
 * byte-identical to upstream and stops being a merge conflict entirely.
 *
 * ## Rules for adding a fork migration
 *
 * - Append to {@link forkMigrationEntries} with the next free id; never renumber
 *   an existing entry, and never reuse an id.
 * - Prefix new tables with `fork_` so upstream can never collide with them.
 * - Prefer additive changes. A fork migration that ALTERs an upstream table is
 *   fragile — upstream may alter the same column later.
 */

import * as Migrator from "effect/unstable/sql/Migrator";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";

import ForkMigration0001 from "./Migrations/fork/001_UsageSamples.ts";
import ForkMigration0002 from "./Migrations/fork/002_QueuedMessages.ts";

/** Tracking table for fork migrations, kept apart from upstream's `effect_sql_migrations`. */
export const FORK_MIGRATIONS_TABLE = "t3fork_migrations";

export const forkMigrationEntries = [
  [1, "UsageSamples", ForkMigration0001],
  [2, "QueuedMessages", ForkMigration0002],
] as const;

export const makeForkMigrationLoader = (throughId?: number) =>
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

export const ForkMigrationsLive = Layer.effectDiscard(runForkMigrations());
