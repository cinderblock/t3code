# Merge upstream/main into debug/crash-investigation (2026-08-11)

## Goal

Bring `debug/crash-investigation` up to date with `upstream/main`, which has moved
236 commits ahead (through release tag `v0.0.33`, 2026-08-10, and on to
`c196f422e` 2026-08-12). Done by **merge**, not rebase.

Predecessor plan: `plans/merge-upstream-main-2026-07-25.md` — read it, especially
the "Migration divergence is a dead end" section. This plan does not repeat it.

## Environment / context

- Repo: `C:\Users\camer\git\t3code`, branch `debug/crash-investigation`.
- `origin` = `git@github.com:cinderblock/t3code.git` (fork), `upstream` =
  `https://github.com/pingdotgg/t3code.git`.
- Pre-merge branch tip: `f7c3ba0db`. Local branch is 409 commits ahead of
  `origin/debug/crash-investigation` (never pushed).
- Merge base: `4029b858e` (2026-07-30).
- Divergence at start: 236 behind / 90 ahead (87 non-merge).
- Local `main` is a stale mirror of upstream (924 behind, 0 ahead). Not
  load-bearing, not part of this merge.

## Decisions already made (don't re-ask)

- **Merge, not rebase.** 87 local commits over 236 upstream commits is not worth
  rewriting, and the branch already carries three `Merge upstream/main` commits —
  this is the established pattern for this fork.
- **The usage-name collision is resolved by renaming the fork's feature to
  `quota`** (user decision, 2026-08-11). See below.
- **The pending live-DB migration repair gets applied** as part of this work
  (user decision, 2026-08-11), dry-run shown first, `--apply` with the app
  stopped.

## The usage collision

Upstream shipped its own "usage" feature in this range — PRs #5684 (usage page
reading provider transcripts), #5743 (mobile dashboard), #5887 (Codex
double-count fix), #6170 (hourly 24h view). It adds:

```
apps/server/src/usage/{UsageService,usageAggregation,usagePricing,usageScanCache,usageTranscriptReader,usageTranscripts}.ts
apps/web/src/components/usage/{UsagePage,UsageProviderChart,usageProviders}.tsx
apps/web/src/routes/usage.tsx        apps/web/src/state/usage.ts
apps/mobile/src/features/usage/*     apps/mobile/src/state/usage.ts
packages/shared/src/{usageFormat,usageMerge}.ts
packages/contracts/src/usage.ts      docs/user/usage.md
```

The fork independently built a _different_ feature under the same names: a
rate-limit **quota** meter (`ClaudeUsageApi` reads Claude's limit windows;
`UsageBroadcaster` samples them into `fork_usage_samples`; `UsageStatusBar`
renders remaining session/weekly quota with a severity colour).

They share **zero symbols** — upstream's is tokens and dollars per provider per
day; the fork's is percentage-of-limit remaining per window. They collide only on
file paths. Every colliding file is **absent at the merge base** on both sides,
i.e. these are add/add collisions, not a divergent shared file.

**Resolution: rename the fork's files to `quota` _before_ running the merge.**
Then upstream's usage feature lands at its exact bytes as a clean add, and the
collision can never recur — the same reasoning that took `Migrations.ts` out of
the conflict set permanently in the last merge.

| fork file (before)                                           | after                                                        |
| ------------------------------------------------------------ | ------------------------------------------------------------ |
| `packages/contracts/src/usage.ts`                            | `packages/contracts/src/quota.ts`                            |
| `packages/client-runtime/src/state/usage.ts`                 | `packages/client-runtime/src/state/quota.ts`                 |
| `apps/web/src/state/usage.ts`                                | `apps/web/src/state/quota.ts`                                |
| `apps/server/src/usage/ClaudeUsageApi{,.test}.ts`            | `apps/server/src/quota/ClaudeUsageApi{,.test}.ts`            |
| `apps/server/src/usage/UsageBroadcaster.ts`                  | `apps/server/src/quota/UsageBroadcaster.ts`                  |
| `apps/web/src/components/usage/UsageHistoryChart.tsx`        | `apps/web/src/components/quota/UsageHistoryChart.tsx`        |
| `apps/web/src/components/usage/UsageStatusBar.tsx`           | `apps/web/src/components/quota/UsageStatusBar.tsx`           |
| `apps/web/src/components/usage/usagePresentation{,.test}.ts` | `apps/web/src/components/quota/usagePresentation{,.test}.ts` |

Also: the `@t3tools/client-runtime` export `./state/usage` becomes `./state/quota`
in `packages/client-runtime/package.json`.

**Scope limit — paths only, not symbols.** `AccountUsageSnapshot`, `UsageWindow`,
`usageEnvironment` etc. keep their names for now. Both barrels do
`export * from "./usage.ts"` / `"./quota.ts"`, and the two export sets have no
overlapping identifiers, so this typechecks. Renaming the symbols too would be
more coherent but is a much larger diff to land in the middle of a 236-commit
merge. Left as a follow-up.

## Migration state

Upstream adds migrations **036–040** in this range
(`ProjectionThreadsPinned`, `ProjectionTurnsKeysetIndex`,
`ProjectionThreadsPinOrderKey`, `ProjectionProjectsDefaultThreadEnvMode`,
`ProjectionProjectFaviconPath`). The fork migrator (`t3fork_migrations`) means
`Migrations.ts` needs no fork edits and merged without conflict.

⚠️ **The deferred repair from the last merge now matters.** `~/.t3/userdata/state.sqlite`
still carries stale rows `35_UsageSamples` / `36_QueuedMessages` in
`effect_sql_migrations`, pinning upstream's high-water at 36. Upstream's real
migration 36 (`ProjectionThreadsPinned`) is `<=` that mark and would be **silently
skipped**, producing a missing-column failure later at query time. Fix with
`scripts/fix-fork-migration-rows.ts` (dry-run default, `--apply` with app stopped).

Checked whether fork `Migrations.ts` had drifted: **it has not.**
`git diff <merge-base> HEAD -- apps/server/src/persistence/Migrations.ts` is
empty. The `Effect`/`Layer` import reorder visible when diffing against
`upstream/main` is upstream's own change in this range, not fork drift. The
predecessor plan's "back to upstream's exact bytes" claim still holds, and the
file needs no action — the merge takes upstream's version cleanly.

## Predicted conflicts (13, from `git merge-tree`)

Two of them (`apps/web/src/state/usage.ts`, `packages/contracts/src/usage.ts`)
are eliminated by the pre-merge rename. Remaining 11:

- `apps/desktop/src/window/DesktopApplicationMenu.test.ts`
- `apps/server/src/project/ProjectFaviconResolver.ts`
- `apps/server/src/vcs/GitVcsDriverCore.ts`
- `apps/web/src/components/ChatView.tsx`
- `apps/web/src/components/RightPanelTabs.tsx`
- `apps/web/src/components/chat/ChatComposer.tsx`
- `apps/web/src/rightPanelStore.ts`
- `oxlint-plugin-t3code/test/utils.ts`
- `packages/client-runtime/package.json`
- `packages/client-runtime/src/connection/supervisor.ts`
- `packages/shared/src/shell.ts`

## Plan / steps

1. [ ] Record pre-merge tip; safety snapshot.
2. [ ] Rename fork usage → quota, fix importers, restore `Migrations.ts` to
       upstream bytes. Typecheck. Commit as its own change.
3. [ ] `git merge upstream/main`; resolve the 11 conflicts.
4. [ ] `pnpm install` (lockfile), `pnpm typecheck`, lint, tests.
5. [ ] Commit the merge with a substantive message (per fork convention, the
       merge commit body documents each non-obvious resolution).
6. [ ] DB repair: `scripts/fix-fork-migration-rows.ts` dry-run → show → `--apply`.
7. [ ] Build desktop + smoke test.

## Findings / gotchas

- `grep -r` reports `apps/web/src/components/chat/ChatComposer.tsx` as a "Binary
  file". **False alarm** — `file` says UTF-8 text, there are no NUL bytes, and
  `git check-attr` gives `text: auto, eol: lf`. It is a 126 KB single file that
  trips grep's binary heuristic. Merge it normally; no encoding repair needed.

## Progress log

- [x] Fetched upstream, established divergence and conflict set.
- [x] Confirmed the usage collision is add/add on both sides at the merge base.
- [x] User decisions taken on rename-to-quota and on the DB repair.
- [ ] (everything else)

## Things not to do

- Do not rebase.
- Do not edit `apps/server/src/persistence/Migrations.ts` or add anything to
  upstream's `migrationEntries` — see the predecessor plan's dead-end table.
- Do not `git stash push`/`pop` — this is a shared worktree. Snapshot with
  `git stash store -m "..." "$(git stash create)"` only.
- Do not resolve the `usage.ts` conflicts by hand-merging both features into one
  file; the rename exists precisely to avoid that.
