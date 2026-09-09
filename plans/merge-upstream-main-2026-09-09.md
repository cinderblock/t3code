# Merge upstream/main into master — 2026-09-09

## Goal

Bring `master` up to date with `upstream/main` tip **`383cc40f4`** (2026-09-09, past
`v0.0.40`, on the v0.0.41 nightlies): **694 commits** since the 09-02 merge
(`695c34520`, upstream `b9b1b8fdd`). Merge, not rebase — standing decision.

Predecessors: [`merge-upstream-main-2026-09-02.md`](./merge-upstream-main-2026-09-02.md)
(upstream absorbing the fork's caches; the elevated-app restart recipe),
[`merge-upstream-main-2026-08-26.md`](./merge-upstream-main-2026-08-26.md) (worktree
technique, union-fusing trap).

## Environment / context

- Shared checkout `C:\Users\camer\git\t3code` on `master` = `efd0cc159`. Merge work in a
  fresh dedicated worktree `C:\Users\camer\git\t3code-merge-v0.0.40`, branch
  `merge/upstream-v0.0.40` (created from master).
- Divergence at start: 130 ahead / 694 behind.
- No other active sessions (contention markers clean); this session announced as `f6644379`.
- Upstream bumped **Effect beta.103 → rc.112** (#10652) and vite-plus 0.3.0 (#9327) in
  this range. Fork-only Effect code (quota, fork migrations, shell diagnostics) has never
  been compiled against rc.112 — expect typecheck fallout there, not just in conflicts.

## Predicted conflicts (14 files, from `git merge-tree master upstream/main`)

Fork-fix-bearing — fork fix MUST survive:

| file                                                     | what must survive                                                       | upstream's reason for touching it                                     |
| -------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `apps/server/src/processRunner.ts`                       | **spawn-storm fix** — first upstream touch since                        | export classification (#10274), Effect rc.112 (#10652)                |
| `apps/server/src/vcs/VcsStatusBroadcaster.ts`            | fork `statusRefreshSemaphore` concurrency cap                           | export classification, project defaults (#9754), PR discovery (#9125) |
| `packages/client-runtime/src/state/shell.ts`             | fork shell-stream diagnostics (`shell-subscribed`, silence readability) | sidebar perf (#10413), unused-export removal (#10167)                 |
| `apps/web/src/components/chat/ChatComposer.tsx`          | fork queue-draft popover                                                | —                                                                     |
| `apps/desktop/src/preview/Manager.ts`                    | fork external-link policy (popup-first ordering from 09-02)             | —                                                                     |
| `apps/server/src/project/ProjectFaviconResolver.test.ts` | fork Windows-proofing of the cache test (09-02)                         | —                                                                     |
| `apps/desktop/scripts/start-electron.mjs`                | fork oxlint-disable + below-normal priority launch                      | Linux cookie keys (#7261)                                             |

Likely upstream-drift, take upstream shape + re-apply fork additions:

- `apps/server/src/git/GitWorkflowService.ts`, `apps/server/src/mcp/McpHttpServer.ts`
- `apps/desktop/src/ipc/methods/preview.ts`, `apps/web/src/components/preview/PreviewView.tsx`
- `packages/client-runtime/src/rpc/session.ts`
- `packages/contracts/src/{ipc,rpc}.ts`

## Plan / steps

1. [x] Fetch, size the merge, peer check, announce, create worktree + branch.
2. [x] Write this plan; commit on the merge branch.
3. [x] `git merge upstream/main`; resolved all 14 conflicts.
4. [x] `pnpm install`, typecheck (clean after rc.112 fallout fixes), lint (exit 0).
5. [x] All suites run and compared against master — see "Check results".
6. [ ] Commit merge; push branch; `git merge --ff-only` into master; `pnpm install`
       there; push master; ff the `main` mirror.
7. [ ] Rebuild desktop; restart GUI via the elevated scheduled-task recipe (09-02 plan).
8. [ ] Update this plan; release contention marker; remove worktree.

## Findings / gotchas

### Upstream keeps absorbing fork concerns — take theirs, keep the fork's extra

- `ProjectFaviconResolver.test.ts`: upstream Windows-proofed the same three assertions
  itself (exact `path.join(cwd, …)` with `toBe`) — took theirs, which supersedes the
  09-02 fork fix.
- `McpHttpServer.ts` + `preview/Manager.ts` screenshot: the fork degraded a failed
  `capturePage` (UnknownVizError on an occluded tab) to a null screenshot; upstream now
  handles the same failure with `capturePageWithRetry` plus bounded snapshot text and
  `screenshotPath` saving. Took upstream for all snapshot hunks. Watch the fork's two
  "null screenshot" tests in `Manager.test.ts`.
- `Manager.ts` shortcuts: upstream replaced `forwardShortcut` (forward app shortcuts to
  the main window) with `syncMenuShortcuts` (toggle `setIgnoreMenuShortcuts`). Dropped
  `forwardShortcut` (nothing references it now) and re-grafted only the fork's
  external-link helpers ahead of `syncMenuShortcuts`. The 09-02 popup-first ordering in
  `setWindowOpenHandler` auto-merged intact.

### Re-woven fork fixes

- `processRunner.ts`: the fork's `observeRun` (spawn observer) sits directly before
  `make`; upstream only added a `/** @public */` doc line there. Both kept.
- `VcsStatusBroadcaster.ts`: upstream wrapped `refreshStatus` in `withRemoteWriteLock`
  and added `refreshPullRequestStatus`; the fork's `refreshUpstream` option (used by
  `ws.ts`'s explicit-refresh RPC) was re-grafted inside the lock. Semaphore kept.
  Upstream now has `invalidateLocalStatus` itself, so nothing else was needed.
- `client-runtime/state/shell.ts`: upstream turned per-item `applyItem` into batched
  `applyItems` (one state write per batch, #10413). The fork's stream/applied
  diagnostics were re-woven into the loop, with `previousSnapshot` taken from the
  running batch value so a stale event mid-batch is still reported.
- `ChatComposer.tsx`: queue-draft popover re-grafted ahead of upstream's new
  `showComposerAttachAction` button; `isServerThread` kept un-underscored because the
  fork still reads it (upstream renamed it `_isServerThread` as unused); `FileIcon`
  import dropped (unused upstream now).
- `contracts/rpc.ts`: upstream un-exported two RPC consts (export classification); the
  fork's own RPC consts (graph snapshot, worktree changes, quota history, queue) stay
  exported because fork code imports them.
- `session.ts`: fork's `closeInfo` suffix and upstream's `networkHint` suffix both
  appended to the disconnect message.
- `start-electron.mjs`: fork's `resolveUserDataDir` + upstream's `build-browser-secret`
  step both kept.

### Post-merge fallout (Effect rc.112 and upstream renames)

- `Schema.TaggedErrorClass` → `Schema.TaggedError` in the fork's `quota.ts` and
  `queuedMessage.ts` contracts (upstream's own #10652 migration did the same rename).
- `account.rate-limits.updated` payload changed from the raw SDK `rateLimits` message to
  normalized `limits.windows` (upstream's Limits tab, #9507+). The fork's ingestion case
  (which feeds auto-queue-on-cap-hit) now derives `rejected` from a window at
  `usedPercent >= 100` — upstream drops the raw `status`, and `usedPercent` is
  `utilization * 100` capped at 100 — and emits `{ limits, rejected }`. `ChatView`'s
  consumer reads `payload.rejected` and picks the queue window from the rejected window's
  `kind`, keeping the old `rateLimitInfo.status`/`rateLimitType` reads as fallback for
  activities persisted before this merge. **Semantic note:** this is a proxy for the SDK's
  explicit "rejected" status; a window pinned at exactly 100% without a rejection would
  also count. Acceptable for the queue-offer use case.
- `Manager.ts` automation snapshot: the fork's `Option.match` over the capture result was
  replaced with upstream's direct image handling (capture now retries then fails).
  Deleted the fork's "returns a null screenshot when the tab has no capturable frame"
  test — upstream's retry test (`UnknownVizError` mocked twice) covers the same failure.
- Test stubs: `Manager.test.ts` WebContents stubs needed `setIgnoreMenuShortcuts`
  (upstream's `syncMenuShortcuts`). `ProjectFaviconResolver.test.ts` had a duplicate
  `path` binding (the 09-02 fork line plus upstream's own).
- `settingsSearch`: upstream #9339 added an integrations setting `browser-link-target`
  ("Open links in" — where _app_ links open) and a test expecting it to top the query
  "external links". The fork's `preview-external-links` (where _in-preview_ navigations
  leaving the site go — a different concern, both kept) was retitled to "Off-site links in
  the preview browser" so it no longer outranks it.

## Check results (worktree, merged)

| check                   | result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| typecheck (15 packages) | clean                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| lint                    | exit 0 (655 warnings, overwhelmingly upstream's new code)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| web                     | **4465/4466 → 4466/4466** after the search-entry retitle                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| contracts               | 375/375                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| shared                  | 587/587 — upstream fixed the old Windows path failures                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| desktop                 | Manager 97/97 after stubs; remaining failures are Linux-only Wayland screenshot backends upstream added (`NiriSnapShot`/`KdeSnapShot`/`HyprlandSnapShot`: unix-socket `listen EACCES` on Windows) plus the documented `electron-launcher` environmental one                                                                                                                                                                                                                                                                                                 |
| client-runtime          | 11 failures vs 9 on master — the 2 new are upstream-new tests in the same 5 s-timeout family (relay-split "never opens", "network hint for a stalled relay"), verified as plain `Test timed out in 5000ms`                                                                                                                                                                                                                                                                                                                                                  |
| server                  | **4267/4342 passing, 9 failures** (down from 165 on the 09-02 merge — upstream made the provider adapter tests self-contained). All 9 are in files/tests that do not exist on master and hit Windows specifics: `McpHttpServer` + `userInputAttachments` assert raw `\` paths inside JSON text (JSON escapes them to `\`), `AgentSessionScanner` expects case variants to stay distinct (NTFS is case-insensitive), `providerMaintenance` ×6 assert POSIX npm/pnpm/Homebrew prefix layouts. The two of these files that exist on master pass there (22/22). |

## Things not to do

- Don't rebase, don't force-push, don't `git checkout --`/`restore`/`reset --hard`.
- Don't take either side wholesale in `processRunner.ts` or `VcsStatusBroadcaster.ts`.
- Union-merge only complete syntactic units (08-26 "trap that cost the most time").
- All conflict work in the worktree; never leave the shared checkout conflicted.
