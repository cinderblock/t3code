# Merge upstream/main into debug/crash-investigation (2026-07-25)

## Goal

Bring `debug/crash-investigation` (22 commits ahead) up to date with
`upstream/main` (was 227 commits behind), and rebuild. Done via **merge** (not
rebase) to avoid rewriting 22 local commits over a dirty shared worktree.

## What happened

- Pre-merge: committed pending tracked work as `bdd91ef8e` (Ctrl+W fix +
  test + plan) and `7801bb1ad` (launcher arg passthrough, formatting, plan +
  lockfile churn). Safety snapshot stash: `pre-merge-upstream-main safety snapshot`.
- Merge commit: `Merge remote-tracking branch 'upstream/main'` (amended to
  include typecheck fixes). 9 conflicts, all resolved.
- `pnpm install`, `pnpm typecheck` green, desktop build + smoke test green.

## Key decisions (don't re-litigate)

- **Migration renumbering**: both sides added migrations 33/34. Upstream keeps
  33 (`ProjectionThreadsSettled`) / 34 (`ProjectionThreadsSnoozed`); local
  `UsageSamples`/`QueuedMessages` renumbered to **35/36** (files renamed).
  Verified both live DBs (`~/.t3/userdata/state.sqlite`, `~/.t3/dev/state.sqlite`)
  were at migration 32 — the old 33/34 numbering only ever ran against a
  disposable smoke-test scratch DB, so no DB fixup was needed. Next app start
  applies 33–36 in order.
  **⚠️ This trick works exactly once — see "Migration divergence is a dead end"
  below. `userdata` has since run 33–36 (high-water 36); `dev` is still at 32.**
- **ClaudeProvider probe**: dropped local `[claude-probe stderr]` debug capture;
  upstream's `buildClaudeCapabilitiesProbeQueryOptions` supersedes the local
  settingSources/allowedTools/env changes.
- **VcsStatusBroadcaster.refreshStatus**: combined both — full
  `invalidateStatus` (bypasses PR-lookup cache) normally, only
  `invalidateLocalStatus` when `refreshUpstream: false` (anti fetch-storm).
- **ConnectionsSettings Remove button**: same fix existed on both sides; kept
  upstream's copy (`variant="outline"`).
- **ChatView / AppSidebarLayout**: took upstream's redesign (draft hero, glass
  shell, sidebar v2/resize) and grafted local usage-meter status bar
  (`--app-statusbar-height`) and `QueuedMessagesPanel` + `onQueueDraft` back in.
  QueuedMessagesPanel renders in the non-draft-hero branch, guarded on
  `activeThread`.
- **main.ts debug renderer log**: kept, with `@effect-diagnostics-next-line`
  suppressions (nodeBuiltinImport ×2, globalDate) — upstream lint now flags it.
- **pnpm-lock**: took upstream's, regenerated with `pnpm install`.

## Known issues (pre-existing upstream, not merge regressions)

- `packages/shared` `relayClient.test.ts` (4) and `logging.test.ts` (1) fail on
  Windows — POSIX assumptions (exec bit / error-shape). Runtime code is
  win32-aware; upstream CI is Linux. Files are byte-identical to upstream/main.
- Fixed one such Windows issue that was cheap: oxlint rule-harness now spawns
  the JS entry via node instead of the POSIX .bin shim (`24009be74`).
- Engine warning: repo wants node ^24.13.1, machine has 24.11.1.

## Migration divergence is a dead end (verified 2026-07-25)

Read `effect/unstable/sql/Migrator.ts` (v4.0.0-beta.78). The contract:

- `latestMigration` = `SELECT ... ORDER BY migration_id DESC`, row [0] — i.e. a
  single **high-water mark**, the max recorded id.
- Run loop: `if (currentId <= latestMigrationId) continue;` — every migration at
  or below the high-water mark is skipped **whether or not it ever ran**.
- The `name` column is written but **never compared**. A DB row `35_UsageSamples`
  against code declaring 35 as something else raises no error at all.
- `migration_id` is PRIMARY KEY; a duplicate id in the code list fails loudly
  with `MigrationError{kind:"Duplicates"}`.

Consequences for this fork — say the next upstream merge adds its own 35/36/37:

| Approach                               | Result                                                                                                                                                                                      |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Renumber local 35/36 → 38/39           | high-water is 36 → **upstream 35 and 36 silently skipped forever** (missing schema, fails later at query time); then 38/39 re-run local DDL that already exists → `table already exists`    |
| Leave local at 35/36                   | id collision → hard startup failure, `Found duplicate migration id's` (loud, but blocks the app)                                                                                            |
| Reserve a high block (local ids 1000+) | **worst option** — once a DB records 1000, _every_ future upstream migration is below the high-water mark and is skipped silently, forever. This is the intuitive first idea; do not do it. |

So local migrations must never be interleaved into upstream's `migrationEntries`.

**Fix (IMPLEMENTED 2026-07-27): a second, independent migrator with its own
tracking table.** `MigratorOptions.table` is configurable (`Migrator.ts:66`).

- `apps/server/src/persistence/Migrations.ts` is back to upstream's **exact
  bytes** — it should never be edited again, which removes it as a conflict
  source permanently.
- New `apps/server/src/persistence/ForkMigrations.ts`: own entries numbered from
  1, own `Migrator.make(...)` against table **`t3fork_migrations`**, own layer.
- Fork migrations live in `Migrations/fork/001_UsageSamples.ts` and
  `002_QueuedMessages.ts`.
- Wired at `persistence/Layers/Sqlite.ts` — one added line, `runForkMigrations()`
  immediately after `runMigrations()`, so fork migrations may depend on upstream
  tables. That single line is the whole fork footprint in shared code.
- Fork tables are **`fork_`-prefixed** (`fork_usage_samples`,
  `fork_queued_messages`) so upstream can never collide with them. Queries in
  `usage/UsageBroadcaster.ts` and `queue/QueuedMessageService.ts` updated to match.
- Fork migrations 1/2 **adopt legacy unprefixed tables by rename** rather than
  recreating them, so existing usage history and pending queued messages survive.
  Covered by `Migrations/fork/ForkMigrations.test.ts` (4 tests: separate
  high-water marks, fresh install, legacy adoption preserving rows, idempotency).

### Rules for future fork migrations

- Append to `forkMigrationEntries` with the next free id. **Never renumber or
  reuse an id**, and never add anything to upstream's `migrationEntries`.
- Prefix new tables with `fork_`.
- Prefer additive changes; a fork migration that ALTERs an upstream table is
  still fragile, since upstream may alter the same column later.

### Remaining live-database cleanup (NOT yet applied)

`userdata/state.sqlite` still has stale rows `35_UsageSamples` / `36_QueuedMessages`
in `effect_sql_migrations`, holding upstream's high-water at 36. Harmless today,
but it would silently swallow upstream's future migrations 35 and 36.

Repair script: **`scripts/fix-fork-migration-rows.ts`** — dry-run by default,
matches on id AND name (so it refuses to touch genuine upstream rows), deletes
only within a transaction.

```
node scripts/fix-fork-migration-rows.ts           # dry run
node scripts/fix-fork-migration-rows.ts --apply   # after stopping the app
```

Not applied yet because the desktop app was running and holding the database
(WAL active). `dev/state.sqlite` is at 32 and reports clean. No table surgery is
needed — fork migration 1/2 adopt the legacy tables by rename on next start.

## Not done

- Branch not pushed anywhere.
- Full `pnpm build` (marketing/mobile) not run — typecheck covered all packages.
