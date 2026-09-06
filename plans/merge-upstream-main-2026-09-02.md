# Merge upstream/main into master — 2026-09-02

## Goal

Bring `master` up to date with `upstream/main` tip **`b9b1b8fdd`** (2026-09-02, past
`v0.0.38`, on the v0.0.39 nightlies). Two stages:

1. **Land the already-verified v0.0.34+v0.0.35 merges** sitting on
   `merge/upstream-v0.0.35` (= `cdada9797`) — blocked since 08-27 only by uncommitted
   edits to the 08-11 plan doc, now committed on master as `1ce3c0a41`.
2. **Merge the further 263 upstream commits** (since `d3c24a14b`, v0.0.35) on the same
   branch, in the dedicated worktree, then fast-forward `master`.

Predecessors: [`merge-upstream-main-2026-08-26.md`](./merge-upstream-main-2026-08-26.md)
(worktree technique, union-fusing trap), [`merge-upstream-main-2026-08-11.md`](./merge-upstream-main-2026-08-11.md)
(rename-before-merge for add/add collisions). Merge, not rebase — standing decision.

## Environment / context

- Shared checkout `C:\Users\camer\git\t3code` on `master`; merge work happens in the
  dedicated worktree `C:\Users\camer\git\t3code-merge-v0.0.34` (branch
  `merge/upstream-v0.0.34`; `merge/upstream-v0.0.35` points at the same commit — use
  the v0.0.35 name going forward per the 08-26 plan).
- Pre-merge geometry: `master` = `1ce3c0a41`, ffwds to `cdada9797`, which is
  123 ahead / 263 behind `upstream/main`.
- No other active sessions detected (workspace-contention markers clean); this session
  announced as `f6644379`.

## Decisions already made (don't re-ask)

- Merge, not rebase; no force-push, ever.
- Do the conflicted merge in the worktree so the shared checkout never sits in a
  conflicted state.
- The orphaned 08-11 plan-doc edits were committed on master (`1ce3c0a41`) rather than
  left to rot — they were finished documentation from a session dead since ~08-27.

## Predicted conflicts (16 files, from `git merge-tree cdada9797 upstream/main`)

Fork-fix-bearing — resolve deliberately, fork fix MUST survive:

| file                                                    | what must survive                                                                                          |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `apps/server/src/project/RepositoryIdentityResolver.ts` | **spawn-storm fix** (`repositoryRootCache`) — first time upstream has touched this file since the fork fix |
| `apps/server/src/project/ProjectFaviconResolver.ts`     | fork TTL cache + `walkForFavicon` (third merge in a row this conflicts)                                    |
| `apps/web/src/components/chat/ChatComposer.tsx`         | fork queue-draft control in upstream's footer                                                              |
| `apps/web/src/components/RightPanelTabs.tsx`            | fork commit-graph (History) surface                                                                        |
| `apps/web/src/components/ChatView.tsx`                  | fork gitGraph surface wiring                                                                               |

Likely upstream-drift, take upstream shape + re-apply fork additions:

- `apps/desktop/src/ipc/methods/preview.ts`, `apps/desktop/src/preview/Manager.ts`
- `apps/desktop/src/settings/DesktopClientSettings.test.ts`
- `apps/server/src/server.ts`, `apps/server/src/vcs/VcsStatusBroadcaster.ts`
- `apps/web/src/components/preview/PreviewMoreMenu.tsx`
- `apps/web/src/components/settings/SettingsPanels.tsx`
- `packages/contracts/src/{index,ipc,settings}.ts`
- `vite.config.ts`

## Plan / steps

1. [x] Commit the orphaned 08-11 plan edits on master (`1ce3c0a41`).
2. [x] Write this plan; commit on master so the branch sync picks it up.
3. [x] Worktree: merge `master` into the merge branch (clean).
4. [x] Worktree: `git merge upstream/main`; resolved all 16 conflicts.
5. [x] Worktree: `pnpm install`, typecheck (clean), lint (exit 0), full web/desktop/
       contracts/shared/client-runtime/server suites; failures = master's
       environmental baseline. See "Check results".
6. [x] Merge commit `695c34520`; plan doc `21fe16eb1`; branch pushed to
       `origin/merge/upstream-v0.0.35`.
7. [x] `master` fast-forwarded to `21fe16eb1` — **0 behind upstream/main, 128 ahead**.
       `pnpm install` in the shared checkout; `master` pushed to `origin/master`;
       `main` mirror fast-forwarded to `upstream/main`.
8. [x] Plan updated; contention marker released; desktop rebuild kicked off from the
       merged master.

## Post-landing state (2026-09-02)

- `master` = `21fe16eb1`, pushed. 0 behind `upstream/main` (`b9b1b8fdd`), 128 ahead.
- `merge/upstream-v0.0.35` = same commit, pushed. Local `merge/upstream-v0.0.34` is
  stale (pre-merge tip `cdada9797`) and fully merged — safe to delete whenever.
- The dedicated worktree `C:\Users\camer\git\t3code-merge-v0.0.34` served its purpose
  and was removed; recreate one for the next conflicted merge.
- 2026-09-06: the long-running GUI instance (up since 08-23 on the pre-merge bundle)
  was restarted onto the merged build (v0.0.38 bundle) via a one-shot elevated
  scheduled task — graceful close, then `pnpm start:desktop` relaunch. Two gotchas for
  next time: the app runs **elevated**, so a default-token scheduled task can neither
  read its path (`Get-Process .Path` returns empty across the integrity gap — use CIM)
  nor close it; register the task with `-RunLevel Highest`. Script kept at
  `C:\Users\camer\AppData\Local\t3-restart\restart-t3.ps1`; task itself removed.
- Follow-up worth considering: the ~165 Windows-only server test failures are all
  environmental (provider CLIs, POSIX-only tests, `/`-literal assertions). A pass that
  Windows-proofs the path assertions would be upstreamable and shrink the noise floor
  for future merge verification.

## Findings / gotchas

- The 42-line plan-file diff between master and the branch was pure `vp fmt` table
  re-padding; committing the orphaned edits through the pre-commit hook re-applied the
  same padding, so the copies converge.

### Upstream independently built both of the fork's perf caches

- **`RepositoryIdentityResolver`** — upstream #8187 added its own `repositoryRootCache`.
  Took upstream's layout/names and its new resolve semantic (`null` root → `null`
  identity, no `?? cwd` fallback), but kept the fork's **negative TTL** on failed root
  lookups where upstream uses `Duration.zero` (re-spawn on every resolve — exactly the
  vicious cycle under load the spawn-storm fix exists for, and a permanent re-spawn for
  non-repo project dirs). Upstream's new "retries after a failed lookup" test was
  adapted to a TestClock + 50 ms negative TTL so it verifies retry-after-TTL instead of
  immediate retry; the fork's own tests already pin TTL-delayed freshness at the
  identity level, so this is consistent.
- **`ProjectFaviconResolver`** — upstream #9080 shipped a favicon cache that supersedes
  the fork's Map cache: keyed on `(faviconPath, cwd)` (fork's was cwd-only), split
  positive/negative TTLs, and a re-stat on every hit so a deleted icon falls back
  immediately. Took upstream's cache wholesale and grafted the fork's
  `FAVICON_RESOLVE_TIMEOUT` (5 s) into the cache lookup, so a hung filesystem degrades
  to the fallback favicon and the timeout is cached as a negative result. Deleted the
  fork's now-contradictory test "caches resolution so a later removal still serves the
  cached path" (upstream's re-stat behavior is strictly better and has its own test).

### Other resolution notes

- `ChatView`: upstream moved `ComposerBannerStack` and `ThreadSyncStatusPill` _inside_
  `ChatComposer` (as `bannerItems`/`threadSyncPhase` props). Keeping the fork's copies
  would have double-rendered — took the deletion, re-grafted only the fork-only
  `QueuedMessagesPanel` into the hero ternary chain.
- `ChatComposer` footer: the fork's `inlineTasksBadge`/`inlineStashBadge` lines were
  dropped — upstream absorbed the stash + tasks badges with its own placements
  (banner column / activity stack); keeping them would double-render. Only the
  queue-draft popover was re-grafted, ahead of upstream's new attach-files button.
- `preview/Manager`: upstream added OAuth popup support (`previewWindowOpenAction`).
  Ordered popup-allow _before_ the fork's external-link policy in
  `setWindowOpenHandler` — an OAuth popup completes through its opener, which the
  system browser cannot reach; ordinary opens still obey the fork's policy.
- `SettingsPanels`: both sides added a full `<SettingsRow>` at the same anchor sharing
  closers — the union-fusing trap again. Split into two sibling rows
  (proactive-panels, then preview-external-links).
- `NodeSqliteClient` moved to `@t3tools/shared/nodeSqliteClient` (#7272);
  `ForkMigrations.test.ts` import updated.
- Fork test harness fixes: `Manager.test.ts` WebContents stubs needed
  `setAudioMuted`/`isCurrentlyAudible` (upstream's registerWebview now restores audio
  mute state). `DesktopClientSettings.test.ts` fixture needed the fork's two
  `sidebarAutoSettle*` fields re-added.
- Windows-proofed upstream's new favicon cache test (`path.join` instead of `/`
  literals) so it actually verifies the cache + timeout semantics on this machine; the
  6 other favicon test failures are the documented pre-existing `/`-vs-`\` class and
  fail identically on unmerged master.

## Check results (worktree, merged)

| check                   | result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| typecheck (15 packages) | clean                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| lint                    | exit 0, warnings only (pre-existing classes + upstream's own new code)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| web                     | **3446/3446 passing** (297 files)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| contracts               | 336/336 passing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| desktop                 | 702/721; the 19 failures are in the same 6 files failing on unmerged master (16 there — the +3 are upstream-added tests in those same files, same environmental class)                                                                                                                                                                                                                                                                                                                                                                                              |
| shared                  | 5 failures — the documented pre-existing relayClient/logging path class                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| client-runtime          | 9 failures — the documented pre-existing set                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| server                  | 3144/3318 passing; 165 failures across 31 files, **all environmental, none merge regressions** — verified by running the comparable 25 files on unmerged master (74 failures there, byte-for-byte same classes). Classes: provider CLIs not installed (Grok/Cursor/Codex adapters + textGeneration), POSIX-only tests upstream added in this range (`bootService` linux/darwin installers, a FIFO test in WorkspaceFileSystem, chmod-unreadable in `cli/theme`), and `/`-literal path assertions (ClaudeSkills, favicon). Upstream CI is Linux, so none fire there. |

Targeted conflict-area suites all pass: RepositoryIdentityResolver 15/15 (incl. the
TestClock-adapted retry test), ForkMigrations, Manager 86/86, DesktopClientSettings,
contracts 336/336.

## Things not to do

- Don't rebase, don't force-push, don't `git checkout --`/`restore`/`reset --hard`.
- Don't take either side wholesale in `RepositoryIdentityResolver.ts` or
  `ProjectFaviconResolver.ts`.
- Don't union-merge conflict hunks whose sides share a closer outside the markers —
  see the 08-26 plan's "trap that cost the most time".
- Don't leave the shared checkout in a conflicted state; all conflict work in the
  worktree.
