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

1. [x] Record pre-merge tip; safety tag `pre-merge-2026-08-11` at `f7c3ba0db`.
2. [x] Rename fork usage → quota, fix importers. Typecheck green. Committed as
       `b5c6fb315`.
3. [x] `git merge upstream/main`; resolved all 11 conflicts.
4. [x] `pnpm install`, `pnpm typecheck` (0 errors, 15 packages), `pnpm lint`
       (exit 0).
5. [ ] Commit the merge.
6. [ ] Run the test suite.
7. [ ] DB repair: `scripts/fix-fork-migration-rows.ts` dry-run → show → `--apply`.
8. [ ] Build desktop + smoke test.
9. [ ] Rename the local branch to `master` (user asked mid-merge, 2026-08-11) and
       decide what happens to the stale local `main` and to the origin branch.

## Findings / gotchas

### `packages/shared/src/shell.ts` was a fake binary conflict (FIXED)

Git reported `warning: Cannot merge binary files` and refused a text merge,
leaving our side in the worktree with **zero conflict markers** — easy to mistake
for "merged fine".

Cause: the fork's side contained **two raw NUL bytes**, at line 109, inside a
template literal used as a cache key:

```ts
const cacheKey = `${platform}<NUL>${command}<NUL>${readEnvPath(env) ?? ""}`;
```

Not corruption — deliberate NUL-as-separator, but written as literal bytes rather
than escapes. Base and upstream both have zero NULs. Two bytes in a 23 KB file
made git classify the whole thing as binary.

Fix: replaced the raw bytes with `\0` escapes (semantically identical string), then
ran `git merge-file` on the three stages by hand. It merged with **zero
conflicts** — the entire conflict was the NUL artifact. Both sides' code coexists:
the fork's sync `resolveSpawnExecutableWithNode` + Map cache, and upstream's new
Effect-based `CommandResolutionCache` / `windowsPathExtensions` /
`CommandResolutionError`.

Corroboration that `\0` is the right call: upstream independently needed the same
separator and wrote it `String.fromCharCode(0)` — deliberately avoiding a raw byte
in source. `file` now reports the merged result as ASCII text, so this file will
merge normally from here on.

**Lesson worth generalising:** if a merge reports a binary conflict on a source
file, check for stray NULs before assuming encoding damage — and never assume a
conflicted file with no `<<<<<<<` markers was merged.

- `grep -r` reports `apps/web/src/components/chat/ChatComposer.tsx` as a "Binary
  file". **False alarm** — `file` says UTF-8 text, there are no NUL bytes, and
  `git check-attr` gives `text: auto, eol: lf`. It is a 126 KB single file that
  trips grep's binary heuristic. Merge it normally; no encoding repair needed.

## Conflict resolutions

| file | resolution |
| ---- | ---------- |
| `packages/shared/src/shell.ts` | Fake binary conflict from 2 raw NUL bytes — see Findings. Escaped them, hand-merged, zero real conflicts. |
| `packages/client-runtime/package.json` | Union: fork's `./state/quota` export + upstream's `./state/subagentRuntime`. |
| `apps/server/src/vcs/GitVcsDriverCore.ts` | Union of one import each. |
| `apps/server/src/project/ProjectFaviconResolver.ts` | Kept the fork's extracted `walkForFavicon` + TTL cache + resolve timeout; grafted upstream's explicit `faviconPath` override, placed **ahead of the cache** because it is a per-call argument while the cache is keyed on `projectCwd` alone. |
| `oxlint-plugin-t3code/test/utils.ts` | Took upstream. Upstream upstreamed the fork's own Windows fix (#5066) and derives the oxlint entry via `require.resolve` instead of hardcoding the pnpm layout. Fork change superseded. |
| `apps/desktop/src/window/DesktopApplicationMenu.test.ts` | Kept both tests (fork's Ctrl+W guard, upstream's zoom routing), with the fork's test rewritten onto upstream's new `configureMenu` helper. |
| `apps/web/src/components/chat/ChatComposer.tsx` | Kept the fork's `ClockIcon`; dropped `ListTodoIcon`, whose only consumer upstream removed. |
| `packages/client-runtime/src/connection/supervisor.ts` | Took **upstream's** `RETRY_DELAYS_MS` (base was `[1s…]`, so the fork never chose it; upstream deliberately raised the floor to 3s, which suits the fork's anti-storm intent anyway). Kept the fork's **30s** `CONNECTION_ESTABLISHMENT_TIMEOUT` (upstream left it at 15s; the fork raised it). Kept both the fork's `attemptMs`/`productive` timing and upstream's `failedWakeProbe` read. In the backoff branch, upstream's wake-probe fast path runs first and short-circuits; the fork's ladder decay + diagnostic then govern ordinary backoff. |
| `apps/web/rightPanelStore.ts`, `RightPanelTabs.tsx`, `ChatView.tsx` | Union of the fork's `gitGraph` surface with upstream's `pull-request` and `agents` surfaces. **Dropped `"plan"`** — see below. Fork's `gitGraph` tab icon restyled to `size-3` to match upstream's new sizing. |

### `"plan"` was dropped deliberately

The `plan` right-panel surface came from the **merge base**, not the fork. Upstream
removed it in this range (storage v9 — plans render inline in the transcript) and
ships a migration that strips persisted `plan` surfaces. Every piece of state it
depended on (`PlanSidebar` import, `autoOpenPlanSidebar`, `sidebarProposedPlan`,
`planSidebarLabel`) had already auto-merged away, because upstream deleted those
lines and the fork had not touched them. Keeping the JSX branch would have
referenced undefined bindings. Note `interactionMode === "plan"` is a *different*
feature (composer Plan/Build mode) and is untouched.

## Post-merge fixes required

- `RightPanelTabs.tsx`: the fork's "History" surface card needed `badgeCount: 0`;
  upstream added a badge to the card list and sets it on every entry.
- `routes/_chat.pull-requests.tsx`: upstream's new PR-list page renders
  `RightPanelTabs` and so had to be given the fork's `onAddGitGraph` /
  `gitGraphAvailable` props, stubbed `() => undefined` / `false` exactly like the
  peer surfaces that page does not support.
- `quota/ClaudeUsageApi.ts`: Effect beta.102 → **beta.103** replaced
  `Schema.UnknownFromJsonString` with the general
  `Schema.fromJsonString(schema)`. Now `Schema.fromJsonString(Schema.Unknown)`.
- Upstream added an oxlint rule `t3code(namespace-node-imports)` that fork-only
  files predate. Renamed `NodeFs`→`NodeFS`, `NodeOs`→`NodeOS`,
  `NodeFs`→`NodeFSP` (node:fs/promises), and switched
  `scripts/fix-fork-migration-rows.ts` to `import * as NodeSqlite`.
  `apps/desktop/scripts/start-electron.mjs` got the same
  `oxlint-disable-next-line t3code/no-global-process-runtime` its sibling scripts
  in that directory already use.

Remaining lint output is **3 warnings, all pre-existing fork code**, none merge
regressions: `no-array-reverse` in ChatView (safe — spread-then-reverse) and
`prefer-set-has` in the two fork migrations. `pnpm lint` exits 0.

## Progress log

- [x] Fetched upstream, established divergence and conflict set.
- [x] Confirmed the usage collision is add/add on both sides at the merge base.
- [x] User decisions taken on rename-to-quota and on the DB repair.
- [x] Renamed fork usage → quota (`b5c6fb315`).
- [x] Merged upstream/main, resolved all 11 conflicts.
- [x] `pnpm install`, typecheck (0 errors), lint (exit 0).
- [ ] Merge commit.
- [ ] Test suite.
- [ ] Live-DB migration repair.
- [ ] Desktop build + smoke test.
- [ ] Branch rename to `master`.

## Things not to do

- Do not rebase.
- Do not edit `apps/server/src/persistence/Migrations.ts` or add anything to
  upstream's `migrationEntries` — see the predecessor plan's dead-end table.
- Do not `git stash push`/`pop` — this is a shared worktree. Snapshot with
  `git stash store -m "..." "$(git stash create)"` only.
- Do not resolve the `usage.ts` conflicts by hand-merging both features into one
  file; the rename exists precisely to avoid that.
