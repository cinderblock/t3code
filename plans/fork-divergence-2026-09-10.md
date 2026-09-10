# Fork divergence snapshot — 2026-09-10

What `master` carries that `upstream/main` does not, after the 09-09 merge (merge base
`383cc40f4`; 111 files, ~11.6k lines added, ~120 removed; 134 fork commits of which ~60 are
plan docs). Companion to [`fork-divergence-review.md`](./fork-divergence-review.md) (the
Aug-01 code review, whose open items are listed at the bottom) and the merge plans.

## Absorbed by upstream since — no longer ours

| fork change                                                    | upstream equivalent                                                               | what the fork still keeps on top                                                                        |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| repo work-tree root cache (`49e26ab64`)                        | #8187 `repositoryRootCache`                                                       | negative TTL on failed lookups (upstream re-spawns)                                                     |
| favicon resolution cache (`401da737f`)                         | #9080 favicon cache                                                               | 5 s resolve timeout, cached as a miss                                                                   |
| oxlint test harness on Windows (`24009be74`)                   | #5066                                                                             | nothing — superseded                                                                                    |
| `vp fmt --no-error-on-unmatched-pattern` (`ccae9611f`)         | same flag upstream                                                                | the explanatory comment                                                                                 |
| OS-agnostic favicon test paths (`57f933a54`)                   | upstream Windows-proofed its own tests                                            | nothing                                                                                                 |
| null-screenshot degrade on `capturePage` failure (`175c46fda`) | `capturePageWithRetry`                                                            | nothing                                                                                                 |
| `remoteStatus({ refreshUpstream })` / `invalidateLocalStatus`  | upstream has both                                                                 | the `refreshStatus(cwd, { refreshUpstream })` option `ws.ts` uses                                       |
| retry-ladder floor (supervisor)                                | upstream raised `RETRY_DELAYS_MS` to 3 s                                          | ladder decay after a held connection, 30 s setup timeout                                                |
| Claude usage meter (partially)                                 | Limits tab #9507, `/usage-limits` #9875, normalized `account.rate-limits.updated` | the fork's own quota bubble + history chart + `UsageBroadcaster` sampling; **candidate for retirement** |

## Still ours — performance and stability (the crash investigation)

1. **VCS status refresh under load** — exponential backoff on failing remote fetches that
   survives poller restarts, a semaphore capping concurrent refreshes, 8 s fetch timeout,
   startup grace before the first refresh, throttled background refreshes, local-only refresh
   on window refocus, `isInsideWorkTree` timeout treated as "unknown" not a defect, negative
   cache for failed repo detection. (`VcsStatusBroadcaster`, `GitVcsDriver*`, `VcsDriverRegistry`)
2. **Spawn storm** — `ProcessSpawnObserver` (every spawn recorded with outcome/duration),
   memoized spawn-executable resolution in `packages/shared/src/shell.ts`, bounded + parallel
   - cached editor detection in `externalLauncher.ts`. Root-cause write-up:
     `process-spawn-storm.md`; drafts for upstream in `upstream-reports.md` (never posted).
3. **Connection resilience** (`packages/client-runtime`) — health check tolerates a
   slow-but-alive backend, environment-descriptor fetch retries on timeout, WebSocket close
   code + network-status transitions captured into disconnect errors, ping/pong latency
   measurement, durable disconnect/stall logging, retry-ladder decay.
4. **Shell state** — one unreachable environment no longer blanks the whole shell
   (`useEnvironmentsSettled` bounded gate), and `shellStreamDiagnostics.ts` reports when the
   client view stops matching the server or the stream goes silent (re-woven into upstream's
   batched `applyItems` on 09-09).
5. **Observability** — `EventLoopLagMonitor` (self vs machine CPU attribution),
   in-process `CpuProfiler` (env-armed only), renderer error capture to a desktop log,
   diagnostic scripts (`crash-snapshot.ps1`, `sample-host-cpu.ps1`, `span-profile.py`,
   `slow-spans.py`). `ATTEMPTS.md` records the refuted hypotheses.

## Still ours — features

1. **Queued messages** — schedule a message to send on a trigger (e.g. when a usage window
   resets); `QueuedMessageService`, panel + trigger picker in the composer, auto-queue the
   failed message when a turn dies on a usage cap. Fork migration 002.
2. **Claude quota meters** — session/weekly remaining-quota bubble on the composer with a
   history chart; `ClaudeUsageApi` + `UsageBroadcaster`; fork migrations 001/003. Overlaps
   upstream's Limits tab now (see above).
3. **Commit graph** right-panel surface — graph snapshot RPC, per-worktree staged/unstaged
   counts shown as rows above the graph, ref pills coloured per remote.
4. **Preview external links** — navigations that leave the current site open in the system
   browser (setting + per-tab override; OAuth popups deliberately stay in-app). Distinct
   from upstream's #9339 "Open links in" (which governs app links).
5. **Desktop** — Ctrl+W no longer quits the app on Windows/Linux; userData dir pinned so
   unpackaged builds decrypt the real profile; launcher arg passthrough; elevated diagnostic
   launcher (`scripts/start-t3.ps1`, `t3.cmd`, `t3.vbs`); builds run at below-normal
   priority through the CPU broker.
6. **Settings** — saved-backend removal stays reachable while stuck connecting.
7. **Fork migrations** — own `t3fork_migrations` table so upstream's `Migrations.ts` never
   needs editing (`ForkMigrations.ts`, `fix-fork-migration-rows.ts`).

## Open items from the Aug-01 review still standing

Checked 2026-09-10: F3 (always-on renderer crash log, unbounded), F7 (queued message
dispatched before `markSent`, no `sending` state), F9 (`.credentials.json` temp file written
0644), F11 (event-loop lag monitor is opt-out), F16 (two usage-meter PNGs in the repo root),
F18 (untouched `lefthook.yml` template). F1/F2 were fixed at review time; F5/F6/F8/F10/F12–F15
were not re-verified here.
