/**
 * One-off repair for databases migrated before the fork migrator existed.
 *
 * Background: this fork briefly carried its own migrations *inside* upstream's
 * `migrationEntries` (as ids 33/34, then 35/36). Effect's Migrator skips every
 * migration whose id is <= `MAX(migration_id)` in its tracking table, so those
 * rows leave upstream's high-water mark inflated: when upstream later adds its
 * own migrations 35 and 36, they would be **silently skipped** — no error, and
 * the missing schema only surfaces as a query failure much later.
 *
 * Fork migrations now live in their own table (see ForkMigrations.ts), so the
 * stale rows in `effect_sql_migrations` are the only thing left to remove.
 * Deleting them drops upstream's high-water mark back to 34, exactly matching a
 * database that had never run the fork's migrations.
 *
 * The fork's *tables* need no action here: fork migration 1/2 adopt the legacy
 * unprefixed tables by renaming them, preserving their rows.
 *
 * Dry run (default):  node scripts/fix-fork-migration-rows.ts
 * Apply:              node scripts/fix-fork-migration-rows.ts --apply
 * Specific database:  node scripts/fix-fork-migration-rows.ts --db <path> --apply
 *
 * Stop the desktop app first — it holds the database open in WAL mode.
 */

import { DatabaseSync } from "node:sqlite";
import * as NodeFs from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/** Rows this fork is known to have written into upstream's tracking table. */
const STALE_ROWS = [
  { id: 33, name: "UsageSamples" },
  { id: 34, name: "QueuedMessages" },
  { id: 35, name: "UsageSamples" },
  { id: 36, name: "QueuedMessages" },
] as const;

function defaultDatabasePaths(): ReadonlyArray<string> {
  const home = process.env.T3_HOME ?? NodePath.join(NodeOS.homedir(), ".t3");
  return ["userdata", "dev"].map((leaf) => NodePath.join(home, leaf, "state.sqlite"));
}

function repair(dbPath: string, apply: boolean): boolean {
  if (!NodeFs.existsSync(dbPath)) {
    console.log(`- ${dbPath}\n    skipped: no such database`);
    return false;
  }

  const db = new DatabaseSync(dbPath, { readOnly: !apply });
  try {
    const tracked = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .all("effect_sql_migrations");
    if (tracked.length === 0) {
      console.log(`- ${dbPath}\n    skipped: no effect_sql_migrations table`);
      return false;
    }

    const rows = db
      .prepare(`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id DESC`)
      .all() as ReadonlyArray<{ migration_id: number; name: string }>;

    // Match on id AND name: if upstream has since shipped its own 35/36, the names
    // differ and those rows are legitimate — deleting them would re-run real
    // upstream migrations against a schema that already has them.
    const stale = rows.filter((row) =>
      STALE_ROWS.some((entry) => entry.id === row.migration_id && entry.name === row.name),
    );

    if (stale.length === 0) {
      console.log(
        `- ${dbPath}\n    clean: high-water ${rows[0]?.migration_id ?? 0}, nothing to do`,
      );
      return false;
    }

    const description = stale.map((row) => `${row.migration_id}_${row.name}`).join(", ");
    if (!apply) {
      console.log(`- ${dbPath}\n    WOULD DELETE ${stale.length} row(s): ${description}`);
      return true;
    }

    db.exec("BEGIN IMMEDIATE");
    try {
      const remove = db.prepare(
        `DELETE FROM effect_sql_migrations WHERE migration_id = ? AND name = ?`,
      );
      for (const row of stale) remove.run(row.migration_id, row.name);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    const after = db
      .prepare(`SELECT MAX(migration_id) AS high FROM effect_sql_migrations`)
      .get() as { high: number | null };
    console.log(
      `- ${dbPath}\n    deleted ${stale.length} row(s): ${description}\n    high-water now ${after.high ?? 0}`,
    );
    return true;
  } finally {
    db.close();
  }
}

const argv = process.argv.slice(2);
const apply = argv.includes("--apply");
const dbIndex = argv.indexOf("--db");
const paths =
  dbIndex !== -1 && argv[dbIndex + 1] !== undefined ? [argv[dbIndex + 1]!] : defaultDatabasePaths();

console.log(apply ? "Applying fork migration-row repair:" : "Dry run (pass --apply to write):");
let affected = 0;
for (const dbPath of paths) {
  if (repair(dbPath, apply)) affected += 1;
}

if (!apply && affected > 0) {
  console.log(`\n${affected} database(s) need repair. Stop the app, then re-run with --apply.`);
} else if (apply) {
  console.log(`\nDone. ${affected} database(s) repaired.`);
}
