# Merge upstream/main into master — 2026-10-19

## Goal

Bring `master` up to date with `upstream/main` tip **`1451e7cb23`** (2026-10-18 23:03 -0700):
**762 commits** since the 10-16 merge (`b0b47eefeb`, upstream `e3b35d1b24`). Includes previews up to
`v0.1.1-preview.20261019.3339`. Also: turn upstream's new telemetry off for this fork.

Predecessor: [`merge-upstream-main-2026-10-16.md`](./merge-upstream-main-2026-10-16.md) (read its
"Upstream changes that hit fork code" and gotchas).

## Environment / context

- Dedicated worktree `C:\Users\camer\.t3\worktrees\t3code\merge-upstream-2026-10-19`, branch
  `merge/upstream-2026-10-19`, from `master` = `8050f6ef98`.
- Shared checkout `C:\Users\camer\git\t3code` stays on `master` until the fast-forward.
- Use the worktree's own `node_modules/.bin/vp`; `vp i --no-frozen-lockfile` after taking
  upstream's lockfile.

## Decisions already made (don't re-ask)

- Merge the tip of `upstream/main`, not a preview tag (user, 2026-10-19: "merge. i trust you").
- Merge, not rebase. Dedicated worktree; `master` only moves once verified.
- **Telemetry off** for this fork (user, 2026-10-19).
- Upstream #20432 (pairing grants access + relay management by default; `AuthAdministrativeScopes`
  deleted): adapt administrator passkeys to "always the current full scope set"; drop the fork's
  "Full access" link preset, now redundant. Existing passkey `d7d09b81` (`administrative=1`) must
  keep full access.

## Expected conflicts (in-memory trial merge, 11 files)

`desktop/preview/Manager.ts`, `server/persistence/Sqlite.ts` (+test), `server/vcs/GitVcsDriverCore.ts`,
`web/ChatView.tsx`, `web/RightPanelTabs.test.tsx`, `web/Sidebar.tsx`, `web/preview/PreviewView.test.tsx`,
`web/settings/ConnectionsSettings.tsx`, `web/routes/_chat.pull-requests.tsx`, `pnpm-lock.yaml`.
Plus non-textual breakage: fork code importing `AuthAdministrativeScopes`.

## Conflict resolutions

| file                                   | resolution                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server/persistence/Sqlite.ts`         | upstream drops planner stats (clears `sqlite_stat1`) instead of `PRAGMA optimize`; fork `runForkMigrations()` kept before it                                                                                                                                                                                                    |
| `server/persistence/Sqlite.test.ts`    | upstream (its stats test was replaced; the fork's loosened assertion was for the removed test)                                                                                                                                                                                                                                  |
| `server/vcs/GitVcsDriverCore.ts`       | fork status-fetch semaphore around upstream's new `--` before the remote name                                                                                                                                                                                                                                                   |
| `desktop/preview/Manager.ts`           | both (fork external-link handling + upstream focus check / detached-session recovery)                                                                                                                                                                                                                                           |
| `web/RightPanelTabs.test.tsx`          | upstream (deleted the static-markup favicon tests)                                                                                                                                                                                                                                                                              |
| `web/preview/PreviewView.test.tsx`     | deleted upstream (moved to `PreviewView.browser.test.tsx`); fork's `setExternalLinkBehavior` bridge stub added there                                                                                                                                                                                                            |
| `web/routes/_chat.pull-requests.tsx`   | upstream `usePullRequestScope` hook; fork `useEnvironmentsSettled` re-applied inside it                                                                                                                                                                                                                                         |
| `web/settings/ConnectionsSettings.tsx` | upstream un-memoized (React Compiler) endpoints; fork public-origin endpoints re-added in that style                                                                                                                                                                                                                            |
| `web/ChatView.tsx`                     | upstream extracted `chat/RightPanelSurfaceContent.tsx`; fork git-graph surface moved there (`gitGraph` prop); fork queue-draft kept; `pendingRevert`/`closePreview`/`resolveEnvironmentMachineKind` removed as upstream did                                                                                                     |
| `web/Sidebar.tsx`                      | upstream file, fork host filter re-ported: `useSidebarHostFilter` hook, `hiddenEnvironmentIds` through `useSidebarThreads` → `partitionSidebarThreads`, draft block + draft count, scope-menu filter, toggles row, empty state. Selection clearing moved from an effect into the setters (upstream's pattern for scope changes) |
| `pnpm-lock.yaml`                       | upstream, regenerated by `vp i --no-frozen-lockfile`                                                                                                                                                                                                                                                                            |

## Findings / gotchas

- **Telemetry was already on before this merge.** The 10-16 code defaulted
  `T3CODE_TELEMETRY_ENABLED` to true and posted to `us.i.posthog.com`; upstream only moved the
  endpoint to `ingest.t3.codes`. Only the server sends (`apps/server/src/telemetry/AnalyticsService.ts`);
  desktop just forwards the variable. Fork default is now false.
- **#20432 folds access/relay management into `AuthStandardClientScopes`** and deletes
  `AuthAdministrativeScopes`. Full-access passkeys now key on the standard set; the DB column and
  contract field keep the name `administrative`. The "only access managers may enroll" test now
  uses standard minus `access:write`.
- Upstream web now relies on the React Compiler: new code avoids `useMemo`/`useCallback` and puts
  derived maps inside small hooks (see the comment on `useSidebarThreads`).
- Bash heredocs containing backticks/`${}` inside `python - <<'EOF'` failed once with "unexpected
  EOF"; writing the script with the Write tool avoided it.

## Progress log

- [x] Worktree + merge started (11 conflicts, as predicted).
- [x] Conflicts resolved (see table).
- [x] Passkey adaptation to #20432: "Full access" link preset removed; warning keys on the
      standard set; docs reworded.
- [x] Telemetry off by default; test covers unset and false.
- [x] `vp i --no-frozen-lockfile` (28 min); lockfile = upstream + the fork's 2 deps.
- [x] Typecheck contracts, shared, client-runtime, server, web, desktop, mobile: all rc=0. Web had 4
      errors first, all fork code meeting the React Compiler refactor (`useCallback` no longer
      imported, `autoPairTokenRef` became `autoPairToken` state, new browser test missing the
      git-graph props).
- [x] Tests. Server auth/telemetry/Sqlite/fork-migrations/http/EnvironmentAuth/vcs: 244 pass; the 6
      `GitVcsDriverCore` failures are the known Windows-only ones from 10-16. Upstream's new
      `VcsStatusBroadcaster` "background refresh reconciles…" test needed `startupGrace:
Duration.zero` (same fork gotcha as 10-16) → 27/27. Web unit 262 pass; web browser tests
      (PreviewView, RightPanelTabs, keyboard, Sidebar pointer) 59 pass after installing Playwright's
      `chromium-headless-shell` (upstream moved these to real-browser mode). Desktop preview Manager
      112 pass. Telemetry "not enabled" test proven to fail with the old default.
- [x] `vp fmt` on all 133 fork-differing TS files; `vp lint` on touched files clean apart from two
      upstream warnings.
- [x] Merge commit `bb23081e6b`; `master` fast-forwarded; worktree and branch removed.
- [~] Restart via the idle watcher: pid 48232 started 2026-10-19 00:52 via WMI; log `C:\temp\t3runs\restart-when-idle.log`.

## Open questions for the user

None.

## Things not to do

- Don't rebase master onto upstream.
- Don't start a server from the worktree against `~/.t3/userdata`.
- Don't trust a zero-error typecheck without reading the log tail.
