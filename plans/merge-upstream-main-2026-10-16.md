# Merge upstream/main into master — 2026-10-16 (v0.1.0)

## Goal

Bring `master` up to date with `upstream/main` tip **`e3b35d1b24`** (2026-10-16): **1,121 commits**
since the 10-02 merge (`69cbb0dcd2`, upstream `cc1e634bfa`). Includes the v0.1.0 release and
nightlies up to `v0.1.1-nightly.20261016.3190`. Merge, not rebase (standing decision).

Predecessor: [`merge-upstream-main-2026-10-02.md`](./merge-upstream-main-2026-10-02.md).

## Environment / context

- Dedicated worktree `C:\Users\camer\.t3\worktrees\t3code\merge-upstream-v0.1.0`, branch
  `merge/upstream-v0.1.0`, branched from `master` = `eec74f49df` (181 ahead of `origin/master`).
- Shared checkout `C:\Users\camer\git\t3code` stays on `master`, untouched until fast-forward.
- Use the worktree's own `node_modules/.bin/vp` for tests (see the 10-02 plan's gotchas).

## Decisions already made (don't re-ask)

- Merge, not rebase.
- Dedicated worktree + branch; `master` only moves once the merge is verified.

## Upstream changes that hit fork code (read before the next merge)

- **#16295 one module per service.** `apps/server/src/**/Layers/` and `Services/` folders are
  gone; e.g. `persistence/Layers/Sqlite.ts` → `persistence/Sqlite.ts`. The fork's
  `runForkMigrations()` call was re-applied there (modify/delete conflict). No other fork file
  lived in a dissolved folder.
- **Effect module paths.** `effect/unstable/{sql,http,reactivity}` → `effect/{sql,http,reactivity}`,
  `effect/unstable/httpapi` → `effect/http-api`, `effect/Encoding` → `effect/encoding/Base64Url` etc.
  Fork-only files were rewritten by `sed` (15 files).
- **#15548 RPC instrumentation moved to group middleware.** `ws.ts` handlers no longer wrap in
  `observeRpcEffect`; the fork's usage/queue/git-graph handlers were unwrapped to match.
- **#9787 / #9786 source-control and admin write scopes** moved to `clientRpcRequiredScopes` in
  contracts. Fork's write entries (`vcsCreateWorktree` …) dropped from `RpcAuthorization.ts`;
  the fork's two read methods (`vcsGraphSnapshot`, `vcsWorktreeChanges`) kept.
- **#14897 / #14518 connection supervisor rewrite**: jittered exponential backoff to 5 min,
  per-route setup budgets (15 s + 75 s per synchronising route), deadline-based probes.
- **ChatView** handlers became plain functions + `useStableCallback`; fork's `onQueueDraft` and
  `addGitGraphSurface` follow the same pattern.
- **PreviewMoreMenu** now takes an `actions` object and also serves server-rendered tabs.

## Decisions taken during this merge (flag to the user)

- **Connection supervisor: upstream's probe loop and timeouts adopted; fork's probe-retry loop
  (`runConnectionHealthCheck`, 4 × probe attempts, 30 s establishment timeout) dropped.**
  Upstream's rewrite targets the same "slow backend is not a dead backend" failure. Kept from the
  fork: the productive-connection ladder decay (more important now that the cap is 5 min, not
  16 s) and the `renderer.log` connection diagnostics (lost-after-connect / attempt-failed /
  network-changed, socket close codes, ping timeouts).
- **Pong-latency diagnostics dropped.** Effect 4.0.5 stable has no `onPing`/`onPong` connection
  hooks (they came from upstream's old `effect@4.0.0-rc.115` patch). Ping _timeouts_ are still
  logged via `makeProtocolSocket({ onPingTimeout })`. The `[no close event observed]` suffix on
  disconnect errors was removed: it never carried data (the close event always fires after the
  error is built) and it broke upstream's exact-message tests. Close codes still reach
  `renderer.log` from the socket listener.
- **Fork RPCs split into `ForkWsRpcGroup`** (contracts), merged into `WsRpcGroup` for the wire;
  the server builds the two handler layers separately. One handler map for all 203 RPCs hit
  TS2589 ("excessively deep") in `ws.ts`, which surfaced as `any` requirements in `server.ts`,
  `binCli.ts` and `cli/server.ts`. Proven by experiment: removing the 8 fork RPCs made the server
  typecheck clean. Upstream alone has ~195, so a future upstream addition may hit this too.
- **Preview target=\_blank:** under the fork's default system-browser policy a cross-origin
  `target=_blank` goes to the OS rather than upstream's new preview tab; same-origin ones (and
  everything under the per-tab "in-app" override) open upstream's new tab.
- **Preview external links** survive as an optional `externalLinks` prop on `PreviewMoreMenu`,
  passed only for desktop-rendered tabs (the desktop shell is the only enforcer). The desktop
  window-open handler now checks the system-browser policy before upstream's new "open in a new
  preview tab" action.
- **`useEnvironmentsSettled` kept** on the landing and pull-requests routes instead of upstream's
  unbounded `useAllEnvironmentShellsBootstrapped`.
- `ClientSettingsSchema.sidebarAutoSettle*` (a leftover flagged on 10-02) removed with the
  conflict; upstream keeps them in server settings only.

## Conflicts (41 files)

| file                                                                              | resolution                                                                                                                                                      |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contracts/src/{rpc,environmentHttp,auth,ipc,settings}.ts`                        | both sides; fork preview-external-link schema kept                                                                                                              |
| `server/package.json`, `web/package.json`, `pnpm-lock.yaml`                       | upstream versions + fork deps (`tiny-cbor`, `@simplewebauthn/browser`); lockfile regenerated                                                                    |
| `server/persistence/Layers/Sqlite.ts`                                             | deleted upstream; fork hook moved to `persistence/Sqlite.ts`                                                                                                    |
| `server/auth/{http,utils,RpcAuthorization}.ts`, `http.test.ts`                    | upstream paths/previous-credential arg + fork limiter/trusted-proxy; fork passkey HTTP test kept                                                                |
| `server/server.ts`, `ws.ts`                                                       | upstream renames; fork layers/handlers re-attached                                                                                                              |
| `server/vcs/{VcsDriverRegistry,VcsStatusBroadcaster,GitVcsDriverCore}.ts` (+test) | upstream 5-min detection TTL + fork 30 s failure TTL; upstream remote-then-local order + fork `refreshUpstream`; upstream `includeRemote` + fork `startupGrace` |
| `server/git/GitWorkflowService.ts`, `project/RepositoryIdentityResolver.test.ts`  | both                                                                                                                                                            |
| `desktop/main.ts`                                                                 | upstream `layerDesktopRuntime`; fork renderer log; duplicate `NodeFS` import merged                                                                             |
| `desktop/preview/Manager.ts`, `ipc/methods/preview.ts`                            | both IPC methods; window-open handler merged (see decisions)                                                                                                    |
| `desktop/preview/Manager.test.ts`                                                 | upstream (it moved the automation tests out; the fork's null-screenshot test was for code upstream replaced)                                                    |
| `client-runtime/connection/supervisor.ts`                                         | see decisions                                                                                                                                                   |
| `client-runtime/rpc/session.ts`                                                   | fork close-code/ping diagnostics + upstream `pingTimedOut` message                                                                                              |
| `client-runtime/state/shell.ts`                                                   | upstream write lock + deferred PR fills; fork stream diagnostics                                                                                                |
| `web/ChatView.tsx`, `chat/ChatComposer.tsx`                                       | upstream stable callbacks + compaction label; fork queue draft + git graph                                                                                      |
| `web/Sidebar.tsx`                                                                 | upstream `resolveSidebarProjectScopeKey` + `inboxReturns`; fork host filter                                                                                     |
| `web/preview/{PreviewMoreMenu,PreviewView}.tsx` (+test)                           | see decisions                                                                                                                                                   |
| `web/settings/ConnectionsSettings*.ts(x)`                                         | upstream permission gating + `canRevokeOtherClients`; fork passkey tooltip and public-origin endpoints                                                          |
| `web/environments/primary/auth.ts`                                                | both flags (`pairedWithCredential`, `explicitPairingRequested`)                                                                                                 |
| `web/routes/_chat.index.tsx`, `_chat.pull-requests.tsx`                           | upstream, with fork `useEnvironmentsSettled`                                                                                                                    |
| `vite.config.ts`                                                                  | upstream (pruned comment)                                                                                                                                       |

## Findings / gotchas

- `git cat-file -e upstream/main:.gitignore` under Git Bash fails: MSYS rewrites the `rev:path`
  argument. Not a missing file.
- `vp i` with `CI=true` refuses a lockfile whose specifiers lag a `package.json`
  (`ERR_PNPM_OUTDATED_LOCKFILE`); pass `--no-frozen-lockfile` after taking upstream's lockfile.
- **Browser-session origin check (upstream #18509, `48595c787c`).** Every cookie-authenticated
  request, the WebSocket upgrade included, must be same-origin by `Sec-Fetch-Site`, match
  `Host`/`X-Forwarded-Host`, or come from a trusted app origin. Real browsers on the public passkey
  page send `Sec-Fetch-Site: same-origin`, so sign-in through cloudflared keeps working. It also
  closes the ISSUES.md "WebSocket upgrade accepts cookie sessions from any Origin" entry.
- **Python vs Git Bash `/tmp`.** Python writing `/tmp/x` lands in `C:\tmp\x`; `git -F /tmp/x` reads
  `%TEMP%\x`. A stale file there became a merge commit message once; fixed by recreating the merge
  with `git commit-tree` on the same tree and parents. Pass `cygpath -w` paths to Python.
- The worktree's Electron binary was not downloaded by `vp i`; run
  `node node_modules/.pnpm/electron@*/node_modules/electron/install.js` before desktop tests.
- `PRAGMA optimize` samples, so `sqlite_stat1` estimates shift with the fork's extra tables;
  upstream's planner-stats test now asserts only the exact row count.
- Server `VcsStatusBroadcaster` tests that stream with a remote poller need
  `startupGrace: Duration.zero` (the fork's 10 s grace), or `TestClock.adjust` misses the refresh.

## Progress log

- [x] Fetch, size (1,121 commits, 41 conflicts), create worktree, start merge.
- [x] Resolve conflicts (text level).
- [x] `vp i --no-frozen-lockfile` (26 min); lockfile = upstream + the fork's 2 deps.
- [x] Typecheck contracts, shared, client-runtime, server, web, desktop, mobile: all rc=0, 0 errors.
- [~] Three-way audit: done per hunk while resolving (each "ours" side checked against the merge
  base where it looked like base content: Manager.test, contracts auth, ChatView revert,
  settings, Sidebar), not as a separate full `diff3` pass.
- [x] Lint/fmt touched files. Mechanical fork lint fixes committed separately; the Sidebar
      host-filter `Toggle`/`Badge` and ChatComposer queue-button restyles logged in ISSUES.md.
- [x] Focused tests. Server 621 pass; client-runtime 1,062 pass (the 10 supervisor/session
      failures listed as pre-existing on 10-02 are fixed); contracts 667; web 1,885; desktop 511.
      Remaining failures are Windows-only upstream tests: 6 in `GitVcsDriverCore.test.ts` (5 fake-ssh
      `GIT_SSH_COMMAND` "structured errors", 1 pathspec-magic filename) and 3 in desktop (two
      symlinked-settings tests and one download path, all `/` vs `\`).
- [x] Commits on `merge/upstream-v0.1.0`: merge `b0b47eefeb`, lint fixes, ISSUES.md, this plan.
- [x] Fast-forwarded `master` to `d24cc6b05b` (2026-10-16); merge worktree and branches removed.
- [x] Restyle lint fixed with stock variants (`ae24dbb225`): host-filter toggles take
      `segmented`'s own colors, count badge puts `tabular-nums` on an inner span, send-later
      button is `ghost-muted`. Seen in a dev client (composer); host filter needs 2+ hosts.
- [ ] Next launch: `scripts/start-t3.ps1` reinstalls (lockfile changed) and rebuilds. Not run by an
      agent: it now stops the running app first, which is the app hosting the agent.
- [x] Launcher (2026-10-17, user request): `t3.vbs` is safe to run while T3 Code is open. It installs
      and builds first (a failed build leaves the running app alone), then closes the running app
      (window close, forced after 20s; this build and the installed app), launches, and waits up to
      300s for the backend to answer. Failure handling: a `trap` shows the console and waits on any
      error; a C# watchdog timer on its own thread shows it if a phase overruns (scan 120s, install
      1500s, build 1200s, stop 90s); a named mutex refuses a second launch while one is starting.
      Verified: parse, dry runs under pwsh 7 and Windows PowerShell 5.1, watchdog fire/disarm on 5.1,
      trap on a missing `vp`. The real stop/launch path has not run yet.
- [x] `fork-restyle-lint` worktree and its merged branches removed (2026-10-17).
- [~] 2026-10-17 01:04: `scripts/restart-t3-when-idle.ps1` (`19fce52cec`) started via WMI (pid 36596 since 01:29, pre-stop re-check `c187ed2023`, no time limit `bfd7c71af2`;
  parent WmiPrvSE, elevated) to run the launcher once no thread is running/queued/waiting for 120s.
  Log: `C:\temp\t3runs\restart-when-idle.log`; waits with no time limit.

## Open questions for the user

None open. Answered 2026-10-16: the user approved keeping upstream's supervisor design and dropping pong-latency logging.

## Things not to do

- Don't rebase master onto upstream.
- Don't start a server from this worktree against `~/.t3/userdata`.
- Don't trust a zero-error typecheck without reading the log tail.
