# Merge upstream/main into master — 2026-10-02 (orchestrator v2)

## Goal

Bring `master` up to date with `upstream/main` tip **`cc1e634bfa`** (2026-10-02): **51 commits**
since the 09-30 merge (`a0f029255c`, upstream `9da066dbe9`). Merge, not rebase — standing decision.

This is not a routine merge. One of the 51 commits is **`de34391427` "feat(orchestrator):
introduce new orchestrator (#2829)"** — 1,907 files, +380k/−203k lines. It deletes the v1
orchestration engine (`apps/server/src/orchestration/**`, v1 provider adapters, v1 projection
persistence, `packages/contracts/src/orchestration.ts`'s old shape, client `threadReducer`) and
replaces it with `apps/server/src/orchestration-v2/**`.

Predecessor: [`merge-upstream-main-2026-09-25.md`](./merge-upstream-main-2026-09-25.md) (the
09-30 merge was 27 commits, one conflict, no plan doc).

## Environment / context

- Done in a **dedicated worktree**, not the shared checkout:
  `C:\Users\camer\.t3\worktrees\t3code\merge-upstream-new-orchestrator`, branch
  `merge/upstream-new-orchestrator`, branched from `master` = `a0f029255c`.
  A first attempt in the shared checkout was `git merge --abort`ed (tree was clean) once the
  size became clear.
- `master` in the shared checkout is untouched (`a0f029255c`, 114 ahead of `origin/master`).
- Fork delta vs the old base: 119 files, ~11.9k lines (52 added files, 67 modified upstream files).
- `vp i` in a fresh worktree takes ~15 min on this machine.

## What upstream's v2 changes for a running install (read before deploying)

From `docs/internals/legacy-orchestration-migration.md`:

- **New database file.** First launch snapshots `state.sqlite` → `statev2.sqlite` (SQLite backup
  API) and only the copy gets v2 migrations. `state.sqlite` is left untouched and is the recovery
  source. Later launches never refresh the copy from v1.
- **Old threads import shells first, transcripts lazily**, and only user + assistant messages.
  Provider session identity, checkpoints/diffs, activities/tool calls, approvals and proposed plans
  are **not** migrated. The first continuation of a migrated thread starts a fresh provider session
  with a ≤32k-char handoff of the transcript tail.
- **Protocol version 2.** `/ws` rejects a mismatched `orchestrationProtocol` with HTTP 426; clients
  refuse a host without it. Every environment (other machines, mobile app → 2.0.0) has to be
  updated together.
- Fork tables (`fork_usage_samples`, `fork_queued_messages`, `t3fork_migrations`) ride along in the
  snapshot copy; `runForkMigrations()` still runs after `runMigrations()` in `Sqlite.ts`.

## Decisions already made (don't re-ask)

- Merge, not rebase.
- Dedicated worktree + branch; `master` is only moved once the merge is verified.

## Decisions taken during this merge (flagged to the user)

- **Fork "cap-hit auto-queue" is dropped, superseded by upstream.** The fork turned a
  rate-limit-rejected turn into a queued message via (a) a `account.rate-limits.updated` thread
  activity emitted in v1 `ProviderRuntimeIngestion.ts` and (b) a `ChatView` effect reading
  `activeLatestTurn` / `threadActivities`. Both inputs no longer exist. Upstream v2 has the same
  capability natively: `UsageLimitRecoveryWorker` + `autoResumeLimitedThreads` /
  `snoozeLimitedThreads` settings re-dispatch a usage-limited run when its window resets.
- **Fork user-scheduled queue ("send later": `at` / `window-reset` / `headroom` triggers) is
  kept**, with `QueuedMessageService.dispatchMessage` ported from v1
  `OrchestrationEngine.dispatch({type:"thread.turn.start"})` to v2
  `ThreadManagementService.dispatch({type:"message.dispatch"})`.

## Conflicts (15 files)

| file                                                                                | resolution                                                                                                             |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `packages/client-runtime/package.json`                                              | both exports (`./state/quota`, `./state/subagent-display`)                                                             |
| `packages/contracts/src/rpc.ts`, `settings.ts`                                      | both                                                                                                                   |
| `packages/client-runtime/src/state/shell.ts`                                        | upstream namespace imports + fork stream-diagnostics import                                                            |
| `apps/server/src/persistence/Layers/Sqlite.ts`                                      | upstream `initializeV2Database` + namespace `ServerConfig`; fork `runForkMigrations` kept                              |
| `apps/server/src/server.ts`                                                         | upstream's restructured `RuntimeCoreDependenciesBaseLive`; fork layers re-attached (see progress)                      |
| `apps/server/src/ws.ts`                                                             | both handler sets                                                                                                      |
| `apps/server/src/server.test.ts`                                                    | deleted upstream — accepted; fork's two mock layers need a new home if upstream's replacement test builds the full app |
| `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`                  | deleted upstream — accepted; fork's rate-limit activity dropped (see decision above)                                   |
| `apps/desktop/src/preview/Manager.test.ts`                                          | both mocks; fork "external links" block + upstream's renamed colour-scheme test                                        |
| `apps/web/src/components/RightPanelTabs.test.tsx`, `routes/_chat.pull-requests.tsx` | fork git-graph props kept; `onAddAgents`/`agentsAvailable` dropped (upstream removed the Agents surface)               |
| `apps/web/src/components/chat/ChatComposer.tsx`                                     | upstream `onSend` signature + `onResume`; fork `onQueueDraft` + queue-draft button state                               |
| `apps/web/src/components/Sidebar.tsx`                                               | upstream `filterSidebarV2VisibleThreads` then fork host filter                                                         |
| `apps/web/src/components/ChatView.tsx`                                              | upstream v2 run/queue logic; fork `onQueueDraft`, git-graph surface                                                    |

## Findings / gotchas

- `git grep -r` style marker scans across `apps packages` walk `node_modules` and take minutes —
  use `git diff --name-only --diff-filter=U` / `git grep`.
- A typecheck run before `vp i` finishes "passes" with zero `error TS` lines because `vp` fails
  to load the task graph (`Cannot find package 'vite-plus'`). Check the log tail, not the count.
- **`vp` on PATH is the main checkout's** (`C:\Users\camer\git\t3code\node_modules\.bin\vp`,
  inherited from the T3 Code session). Run from the worktree, `vp test` then loads the main
  checkout's vitest runner while the test files import the worktree's vitest, and every suite
  fails with `Vitest failed to find the current suite` / `Cannot read properties of undefined
(reading 'config')`. Use `<worktree>/node_modules/.bin/vp` for tests. (`vp run typecheck` is
  unaffected: the package script's `tsc` resolves from the worktree.)
- Only two real typecheck root causes after the text merge: `contracts/src/queuedMessage.ts`
  imported `ModelSelection` / `RuntimeMode` / `ProviderInteractionMode` from the deleted
  `./orchestration.ts` (now `./modelSelection.ts` and `./providerPolicy.ts`), and the keep-both
  join in `ws.ts` lost the `),` closing the fork's last handler.
- Every keep-both hunk was re-audited against a three-way (`git merge-file --diff3`) view with
  the old base, to make sure "ours" only contributed fork additions and not base lines upstream
  had removed. All clean.
- **Pre-existing, not from this merge** (same result on `master` before merging):
  - `client-runtime` `connection/supervisor.test.ts` (7) and `rpc/session.test.ts` (3) fail —
    the fork's reconnect changes vs. upstream's tests.
  - `ChatComposer.tsx` queue-draft button fails `shadcn/no-restyle` (`rounded-full`,
    `text-muted-foreground/80` on `<Button>`).
  - `ClientSettingsSchema` carries `sidebarAutoSettleAfterDays` / `sidebarAutoSettleOnMerge`,
    which upstream keeps only in server settings — a leftover from an earlier merge.
  - Server `vcs/GitVcsDriverCore.test.ts` "keeps untracked filenames with pathspec magic" (NTFS
    rejects the `:` in `:(exclude)after.ts`, already noted on 09-25) and `vcs/GitVcsDriver.test.ts`
    "restores empty checkpoints without changing paths outside the workspace" (`ENOENT` writing
    `nested/added.txt`). Both Windows-only; both fail identically on `master`.

## Check results

- Typecheck (`tsc` via `vp run typecheck`): contracts, shared, client-runtime, server, web,
  desktop, mobile — all `rc=0` (Effect LSP suggestions only).
- Lint on the touched files: warnings only, apart from the pre-existing ChatComposer error above.
- Tests: server queue/quota/fork migrations/persistence layers/git graph/process/VCS status/
  GitWorkflowService (136 pass); project resolvers, processRunner, `src/vcs`, `src/auth`,
  ThreadManagementService (397 pass + the 2 Windows failures above); contracts (493 pass); desktop preview/window/settings (469 pass);
  web RightPanelTabs, Sidebar logic, stores, quota, git graph, preview, chat (1392 pass);
  client-runtime as above.
- `QueuedMessageService`'s dispatch path has no test (its existing tests cover trigger
  evaluation). Checked by reading `Orchestrator.ts`: `queue_after_active` only queues when a run
  is active (`shouldQueue = activeRun !== undefined && …`), otherwise it starts the run.

## Progress log

- [x] Fetch, size, abort shared-checkout attempt, create worktree.
- [x] First-pass text resolution of all 15 conflicts.
- [x] `vp i` in the worktree (15 min).
- [x] Typecheck all seven packages; fixed the two root causes.
- [x] Port `QueuedMessageService` to v2 dispatch; re-attach fork layers in `server.ts`.
- [x] Remove fork cap-hit auto-queue (ChatView effect; v1 ingestion activity went with the file).
- [x] Three-way audit of every keep-both hunk.
- [x] Lint + fmt touched files; focused tests.
- [x] Commit merge on branch `merge/upstream-new-orchestrator` (`git log -1 merge/upstream-new-orchestrator`).
- [x] User approved both open questions (2026-10-02: "let's embrace it").
- [x] `master` fast-forwarded to `69cbb0dcd2`; merge worktree and branch removed.
- [~] `CI=true vp i` in the main checkout **failed** (`exit 48`): pnpm purges `node_modules` because
  the layout changed, and hit `EPERM unlink …\electron\dist\dxcompiler.dll` — the running app
  holds Electron's files. `node_modules` is now empty apart from a partial `.pnpm`, and the
  global `vp.exe` cannot run at all (it loads the project's vite-plus from `node_modules`).
- [x] `scripts/start-t3.ps1` gained an install step: when `pnpm-lock.yaml` is newer than
      `node_modules\.modules.yaml` (or the latter is missing) it runs `vp i` with `CI=true`, or
      bootstraps with the cached `~\.vite-plus\package_manager\pnpm\<pinned>\pnpm\bin\pnpm.cjs`
      when `node_modules\vite-plus` is gone. Refused while electron is running, like the build.
      Tested: parse OK; dry run against the live app reports `install : REFUSED`. The install+build
      path runs for real on the next `t3.cmd`.
- [x] Pre-cutover backup: `VACUUM INTO P:\Backups\t3code\2026-10-02-pre-v2\state.sqlite` (6.27 GB)
      plus the userdata `*.json` settings files. C: is too tight for a second 6.4 GB copy.
- [x] Commit `scripts/start-t3.ps1` and this plan. Was blocked until the relaunch restored
      `node_modules` (the pre-commit hook runs `vp fmt`); committed after relaunch, hooks not skipped.
- [x] Relaunch via `scripts\t3.cmd` (user, 2026-10-02 15:36). Launcher run `C:\temp\t3runs\20261002-153635`:
      install detected the stale `node_modules`, bootstrapped pnpm 11.10.0 from `~\.vite-plus`,
      `Done in 3m 8.5s`; build ran (stale stamp); app up at 15:43. First launch on v2 confirmed:
      `statev2.sqlite` created (6.9 GB), all 901 v1 threads present as v2 thread shells, new
      threads work (this one runs on it). `state.sqlite` untouched since 15:28.

## Open questions for the user

None open — both answered yes on 2026-10-02. Kept for the record:

1. OK to fast-forward `master` to the merge? It makes the next build a v2 cutover (new DB file,
   protocol 2, old threads import as transcript-only). Recommendation: yes, but update all
   environments together.
2. OK that cap-hit auto-queue is replaced by upstream's auto-resume? (Turn it on in settings:
   `autoResumeLimitedThreads`.)

## Things not to do

- Don't rebase master onto upstream. Merge only.
- Don't start a server from this worktree against `~/.t3/userdata`.
- Don't trust a zero-error typecheck without reading the log tail.
- Don't run `vp run build:desktop` while the fork's desktop build is running — see the launcher.

## Relaunch facts (2026-10-02)

- **Observed on the real relaunch:** `server-child.log` logged `Timed out after 60000ms waiting for
desktop backend readiness` at 15:44 because the 6.4 GB backup copy outran the desktop shell's
  60 s readiness wait. Harmless here: the backend (pid 4576) kept running and the window connected
  once the copy finished. If a future first-launch copy is needed again, expect that log line.
- `server.log` is stale (last write April); backend stdout now lands only in `server-child.log` and
  the trace ndjson files. Don't look for v2 startup messages in `server.log`.
- `~/.t3/userdata/state.sqlite` is **6.4 GB** (1.56M pages, freelist 0, so all live data). C: had
  **22 GB free**. The first v2 launch backs the file up into `statev2.sqlite` via SQLite's backup
  API (temp file, then a hard link, so no second transient copy), leaving ~15 GB. Expect the first
  launch to spend minutes on the copy before the window appears; watch
  `~/.t3/userdata/logs/server-child.log`.
- After the copy, old threads appear as shells and transcripts import lazily when opened.
- Remote environments and the mobile app must be on protocol 2 too; mismatched pairs refuse to
  connect with an update notice. The connection catalog is encrypted on disk, so the environment
  list was not read here — check Settings → Connections after relaunch.
- Housekeeping candidates, not done: stale local branches `merge/upstream-v0.0.34/35/40`.
