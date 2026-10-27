# Merge upstream/main into master — 2026-10-27

## Goal

Bring `master` up to date with `upstream/main` tip **`570d4b03ee`** (2026-10-27 1:20 PM PDT):
**1,517 commits** since the 10-19 merge (`0f33eeeaee`, upstream `1451e7cb23`). Includes nightlies up
to `v0.1.4-nightly.20261027.3783`.

Predecessor: [`merge-upstream-main-2026-10-19.md`](./merge-upstream-main-2026-10-19.md) (and the
10-16 plan's "Upstream changes that hit fork code").

## Environment / context

- Dedicated worktree `C:\Users\camer\.t3\worktrees\t3code\merge-upstream-2026-10-27`, branch
  `merge/upstream-2026-10-27`, from `master` = `fa45619aa5` (even with `origin/master`).
- Shared checkout `C:\Users\camer\git\t3code` stays on `master` until the fast-forward. It has
  another thread's uncommitted provider-auto-update work (settings.ts, ws.ts, SettingsPanels …);
  leave it alone. That thread will need to rebase its edits onto the merged files.
- Use the worktree's own `node_modules/.bin/vp`; `vp i --no-frozen-lockfile` after taking
  upstream's lockfile.

## Decisions already made (don't re-ask)

- Merge, not rebase; dedicated worktree; `master` only moves once verified (standing).
- Merge the tip of `upstream/main` (same as 10-19: "merge. i trust you").
- Telemetry stays off for this fork (10-19).

## Conflicts (48 files)

Three modify/delete: `web/RightPanelTabs.browser.test.tsx`, `web/RightPanelTabs.keyboard.browser.test.tsx`,
`web/lib/selectionActions.test.ts` (deleted upstream, modified in fork).

| file                                                                     | resolution                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| desktop `DesktopApplicationMenu(.test).ts`                               | upstream: #25860 fixed Ctrl+W closing the window itself; fork's custom Window menu + test dropped (supersedes `plans/ctrl-w-should-not-quit-app.md`)                                                                            |
| desktop `ipc/methods/preview.ts`, `preview/Manager.ts`                   | fork external-link IPC kept (made non-exported like upstream); upstream comment wording                                                                                                                                         |
| desktop `preview/Manager.test.ts`                                        | upstream deletions; fork `describe("external links")` re-inserted                                                                                                                                                               |
| server `auth/http.test.ts`                                               | fork passkey HTTP test kept; upstream-deleted relay span test dropped                                                                                                                                                           |
| server `GitWorkflowService.ts`                                           | fork `graphSnapshot`/`worktreeChanges` rewritten in upstream's `Effect.fn` style                                                                                                                                                |
| server `persistence/Sqlite.ts`                                           | `runForkMigrations()` + upstream's shortened comment                                                                                                                                                                            |
| server `processRunner.ts`                                                | fork `observeRun` kept                                                                                                                                                                                                          |
| server `RepositoryIdentityResolver(.test).ts`                            | upstream cache-key refactor; fork docs/comments + spawn-count test kept                                                                                                                                                         |
| server `ProviderRegistry.test.ts`, `claudeUsageLimits.test.ts`           | fork tests re-added (renamed `usageReadAt` → upstream's `usageCheckedAt`)                                                                                                                                                       |
| server `ClaudeProvider.ts`, `Drivers/ClaudeDriver.ts`                    | upstream implemented the fork's cached-usage timestamp as `usageCheckedAt`; took theirs                                                                                                                                         |
| provider-core `usageLimits.ts`                                           | fork's per-window merge kept (upstream replaces windows wholesale)                                                                                                                                                              |
| server `vcs/GitVcsDriver.ts`                                             | fork timeout log + upstream missing-executable catch                                                                                                                                                                            |
| server `vcs/GitVcsDriverCore.ts`                                         | upstream's new background fetch (dedup, backoff, cap 4) replaces fork semaphore; cap lowered to 2 with the fork's Windows SSH reasoning                                                                                         |
| server `vcs/VcsStatusBroadcaster.ts`                                     | upstream file + fork re-applied: startup grace (now a `VcsStatusRefreshStartupGrace` Context.Reference since `streamStatus` lost its options), refresh semaphore + permit timeout, broadcaster-scoped failure backoff           |
| server `VcsStatusBroadcaster.test.ts`                                    | upstream deletions; every test layer provides a zero startup grace                                                                                                                                                              |
| `vcs.refreshStatus`                                                      | upstream `localOnly` adopted; fork `refreshRemote` removed from contracts/web; fork's local-only window-refocus refresh ported to upstream's `vcsStatusRevalidation` via a new `localOnly` option                               |
| server `ws.ts`, contracts `rpc.ts`                                       | upstream now splits handlers by prefix for TS2589; fork keeps `ForkWsRpcGroup` separate and upstream's split runs over `UpstreamWsRpcGroup`                                                                                     |
| contracts `settings.ts`                                                  | fork `previewExternalLinkBehavior` + upstream working-shelf default true                                                                                                                                                        |
| client-runtime `rpc/session.ts`                                          | upstream frame counter wraps the fork's close-code observer                                                                                                                                                                     |
| client-runtime `state/shell.ts`, `state/vcs.ts`                          | both sides                                                                                                                                                                                                                      |
| client-runtime `supervisor.test.ts`                                      | fork ladder-decay tests kept; upstream deletions                                                                                                                                                                                |
| docs `user/telemetry.md`, shared `otelEnvironment.ts`                    | **relay tracing to Axiom made opt-in** like product events (see decisions)                                                                                                                                                      |
| web `main.tsx`                                                           | fork crash-log forwarding kept before upstream's `startAppServices()`                                                                                                                                                           |
| web `__root.tsx`                                                         | `PasskeyEnrollmentOffer` re-homed into upstream's slimmer root                                                                                                                                                                  |
| web `SettingsPanels.tsx`                                                 | fork preview-external-links row stays first in Display                                                                                                                                                                          |
| web `ConnectionsSettings*.tsx/.ts`                                       | upstream split out `AuthorizedClientsSettings.tsx`; fork passkey badge, revoke tooltip, full-scope warning moved there; public-origin endpoints + `PublicAccessSettings` re-applied                                             |
| web `_chat.pull-requests.tsx`                                            | upstream moved the page to `pullRequest/PullRequestsPage.tsx` + `usePullRequestListView.ts`; fork git-graph props + `useEnvironmentsSettled` re-applied there                                                                   |
| web `GitActionsControl.tsx`                                              | upstream revalidation atom                                                                                                                                                                                                      |
| web tests (`uiStateStore`, `Sidebar.logic`, `ConnectionsSettings.logic`) | upstream deletions + fork-added tests                                                                                                                                                                                           |
| web `Sidebar.tsx`                                                        | upstream file; fork host filter re-ported (hook, partition filter, scope-menu filter, draft count, toggles row, empty state); `SidebarDraftBlock` moved to `sidebar/SidebarDraftBlock.tsx` and got `hiddenEnvironmentIds` there |
| web `ChatView.tsx`                                                       | upstream extracted hooks; fork `onQueueDraft` re-added before `useComposerSend`; `addGitGraphSurface` moved into `chat/useRightPanelActions.ts`                                                                                 |
| web `ChatComposer.tsx`                                                   | upstream refactor + fork queue-later popover; **mobile attach fix (open upstream PR #23083) ported** from the PR branch, with `ChatComposer.attach.browser.test.tsx`                                                            |
| web `PreviewView.tsx`                                                    | fork external-link override wiring kept                                                                                                                                                                                         |
| web `RightPanelTabs(.keyboard).browser.test.tsx`                         | deleted (upstream #22557); fork only added props                                                                                                                                                                                |
| web `lib/selectionActions.test.ts`                                       | deleted upstream; recreated with only the fork's `resolveSelectionFocus` test                                                                                                                                                   |

## Decisions taken during this merge (flag to the user)

- **Relay tracing (new upstream: T3 Connect connection traces to Axiom) is opt-in on this fork**,
  gated on `T3CODE_TELEMETRY_ENABLED=true` like product events. Follows the 10-19 "telemetry off"
  decision. Mobile crash reports (also new, also Axiom) are a user toggle in mobile Settings and
  were left at upstream's default — question for the user.

## Findings / gotchas

- **Upstream's TS2589 split un-masked `ws.test.ts`**: with handler requirements no longer
  degrading to `any`, the test layer had to mock `PublicAccess`, `QueuedMessageService` and
  `UsageHistoryRecorder` (fork services it never provided).
- New upstream Effect diagnostics are typecheck errors: `effectFnOpportunity` (fork auth, process
  runner/observer, external launcher rewritten to `Effect.fn`/`fnUntraced`) and
  `schemaStructWithTag` (`QueuedMessageStreamEvent` now `Schema.TaggedStruct`, same wire shape).
- Upstream un-exported `providersWithLimits` (shared/usageLimits); fork web `state/quota.ts` needs
  it, re-exported.
- Fork contract makes the preview snapshot `screenshot` nullable; upstream's new
  `ServerBrowserPage.test.ts` needed a null guard.
- Fork's `eventuallyState` polling helper (supervisor.test) fails upstream's new
  `no-polling-loop-in-tests` lint; replaced with upstream's `awaitState`.
- A pre-commit hook runs `vp fmt` in worktrees now.

- Upstream #22557 deleted ~11k "low-signal" tests; most test conflicts are that deletion against
  fork edits. Resolution pattern: take the deletion, keep only fork-added tests.
- Python and Git Bash `/tmp` differ (memory note); scratch files live in `C:/temp/res`.
- zdiff3 hunks can start mid-test; appending fork blocks after "theirs" put a describe inside a
  test once (Sidebar.logic.test) — check placement of every re-inserted block.

## Progress log

- [x] Worktree + merge started (48 conflicts).
- [x] Conflicts resolved (all 48).
- [x] `vp i --no-frozen-lockfile` (4.6 min; lockfile = upstream + 16 lines).
- [x] Typecheck contracts, shared, client-runtime, provider-core, server, web, desktop, mobile:
      all rc=0 (logs read, not just counted).
- [x] Tests. shared otelEnvironment 31, client-runtime supervisor + revalidation 56, provider-core
      usageLimits 8, web unit (uiStateStore, Sidebar.logic, ConnectionsSettings.logic,
      selectionActions) 96, web browser ChatComposer.attach 1, desktop Manager + menu 67: all pass.
      Server auth/vcs/project/provider/ws/persistence/telemetry/process: 770+ pass. Failures are
      upstream-only Windows tests in files the fork never touched: 6 known `GitVcsDriverCore`
      (fake-ssh structured errors, pathspec magic), 1 new `GitVcsDriverCore` (temp dir name ends in
      a space), 2 `agentScope` (systemd), 1 `DatabaseMaintenance` (EBUSY deleting SQLite).
- [x] `vp fmt` on the 97 files differing from both parents; lint clean except 35
      `no-low-value-comments` on fork comments → logged in ISSUES.md.
- [x] Merge commit `c6f70643d8` on `merge/upstream-2026-10-27`.
- [ ] Fast-forward `master` ← **blocked**: 13 files with another thread's uncommitted
      provider-auto-update work in the main checkout are also changed by the merge, so
      `git merge --ff-only` refuses. Needs that work committed (or the user's call).
- [ ] Remove worktree + branch after the fast-forward.
- [ ] Push / restart the running app (user's call).

## Open questions for the user

1. Fast-forward `master`: wait for the provider-auto-update thread to commit, then fast-forward
   (recommended), or something else?
2. Push `master` to `origin` after the fast-forward?
3. Restart the running app on the merged build via the idle watcher, as on 10-19?
4. Mobile crash reports (new upstream, to Axiom via the relay) default on; turn off by default
   for the fork like product telemetry and relay tracing? Recommendation: yes, for consistency.

## Things not to do

- Don't rebase master onto upstream.
- Don't start a server from the worktree against `~/.t3/userdata`.
- Don't trust a zero-error typecheck without reading the log tail.
