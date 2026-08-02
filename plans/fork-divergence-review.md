# Fork divergence review (debug/crash-investigation vs upstream/main)

## Goal

Assess whether the fork's divergence from upstream is reasonable and correct, and
produce an actionable fix list. Review snapshot: `4600f82c4`.
(`edabbea6b feat(connection): record observed network status transitions` landed
from a concurrent session after the snapshot and is NOT covered.)

## Environment / context

- Repo: `C:\Users\camer\git\t3code`, branch `debug/crash-investigation`.
- Compare against **`upstream/main`**, not local `main` — local `main` is 688
  commits behind, so `git diff main...HEAD` is mostly upstream noise.
- Divergence: 57 local commits, ~8,400 lines, 78 files.
- Purpose per `plans/debug-t3code-crashes.md`: personal crash investigation +
  personal features (usage meters, message queue). Not aimed at an upstream PR.

## Baseline facts established

- `bun run typecheck` — passes.
- `npx vp fmt --check` — failed on 1 file at review time (F2, now fixed).
  Note: `plans/t3code-startup-freeze-deeper-fix.md` now also fails, introduced by
  a concurrent session's commit `05aaf35b3`. Not touched here — not our change.
- `apps/server` `VcsStatusBroadcaster.test.ts` — **4 failed / 8 passed**, 386s
  at review time (fork-caused, see F1; now 13 passed / 3.4s).
- `packages/shared` `logging.test.ts` + `relayClient.test.ts` — 5 failures.
  **Pre-existing**: confirmed by running the identical tests in a detached
  worktree at `upstream/main`, which produced the same 5 failures. Windows
  environment artifacts (e.g. a 300-char filename asserting `ENAMETOOLONG`).
  Not caused by the fork; do not chase.
- No new npm dependencies. `.gitignore` adds `.crash-reports/` only.

## Verdict

The engineering is good. Effect idioms are followed correctly (PubSub +
acquireRelease + forkIn, Clock/DateTime over Date, scoped RPC auth with a
`satisfies` exhaustiveness gate). The diagnosis work is real and the caching /
backoff fixes are mostly well-reasoned, with TTLs so nothing needs a restart to
self-heal. **No remote profiling trigger exists** — `CpuProfiler` arms only from
`T3_CPU_PROF_DIR` at process start and is unreachable from RPC/MCP/HTTP.

The problems are concentrated in: the queued-message service, one client render
path, and an always-on renderer log.

## Fix list (ordered)

### Ship blockers

- [x] **F1. `VcsStatusBroadcaster.ts:440` 10s grace broke 4 of its own tests.**
      Unconditional `Effect.sleep(STATUS_REFRESH_STARTUP_GRACE)` added; the test
      file was never updated (still at its upstream revision). 3 tests hung to
      the 120s vitest timeout, 1 asserted a stale count.
      **FIXED**: added an optional `startupGrace` to `StreamStatusOptions`
      (defaults to `STATUS_REFRESH_STARTUP_GRACE`, so production is unchanged) and
      threaded it through `retainRemotePoller` → `makeRemoteRefreshLoop`. All 7
      `streamStatus` call sites in the test file now pass `Duration.zero`.
      Chose the options seam over `TestClock.adjust` because `StreamStatusOptions`
      already exists for exactly this (`automaticRemoteRefreshInterval` is
      overridden the same way) and adjusting the clock would have made every test
      also step past the grace before asserting.
      Verified: `13 passed / 3.4s`, was `4 failed / 386s`.
- [x] **F2. `GitVcsDriverCore.ts:1186` fails `vp fmt --check`** — stray double
      blank line from the throttle revert/re-land. **FIXED** (removed by hand
      rather than running the repo-wide formatter, since the tree is shared).

### High

- [ ] **F3. Renderer crash log is always-on, unbounded, unredacted.**
      `apps/web/src/main.tsx:33` guards only on `if (bridge)` — always true in the
      packaged app, so this ships to production. It forwards the _full_ serialized
      args of every `console.error`/`warn`, bypassing upstream's existing
      `safeErrorLogAttributes` redaction. Receiver at `apps/desktop/src/main.ts:226`
      is a bare `appendFileSync` with **no rotation and no size cap**, unlike every
      other desktop log. A reconnect spiral writes at retry cadence.
      Fix: dev/opt-in gate, drop the raw `args`, route through the rotating writer.
- [ ] **F4. IPC channel has no sender validation.** `main.ts:221`
      `ipcMain.on("__t3-debug-renderer-log")` ignores the event sender, and
      `preload.ts:252` exposes `__t3CrashLog` to the main world unconditionally
      (outside the `DesktopBridge` contract). Any script in the app renderer can
      append arbitrary lines to a file on disk.
- [ ] **F5. `UsageHistoryChart.tsx:152` RPC storm.** When `resetsAt` is null,
      `since` derives from `Date.now()` at render → new atom key every render →
      new `usage.getHistory` RPC; `staleTimeMs` never applies. `UsageStatusBar`
      re-renders every 30s. Quantize `since` to the window bucket.
      _Most likely of these to be implicated in the crash symptoms._
- [ ] **F6. `QueuedMessageService.ts:131` poison pill halts the whole queue.**
      `rowToMessage` uses `Schema.decodeUnknownSync` (throws) and `reactorTick`
      decodes every row. One bad row → defect → caught and logged → **no queued
      message ever fires again**, silently. Decode per-row, skip/flag bad rows.
- [ ] **F7. `QueuedMessageService.ts:356` duplicate sends.** Dispatch happens
      before `markSent`; if that UPDATE fails the row stays `pending` and the
      reactor re-dispatches every 15s indefinitely. Needs a `sending` state
      written before dispatch.
- [ ] **F8. Dismissing a failed queued message is a no-op.** `cancel` is
      `WHERE id = ? AND status = 'pending'` (`QueuedMessageService.ts:257`) but
      `QueuedMessagesPanel.tsx:77` wires it to _failed_ rows. Zero rows update,
      RPC reports success, row never disappears. The contract's
      `_tag: "removed"` event is never emitted by the server at all.

### Medium

- [ ] **F9. Credential file permission downgrade.** `ClaudeUsageApi.ts:184`
      writes the temp file with no mode (0644 after umask), then `rename`s it over
      `~/.claude/.credentials.json`, which Claude Code creates 0600. On
      macOS/Linux the OAuth token becomes world-readable. A failed rename also
      leaves `.credentials.json.t3tmp` on disk holding both tokens. No lock
      against Claude Code's own refresh — token rotation could log the user out.
- [ ] **F10. Raw error text broadcast to clients.** `UsageBroadcaster.ts:368`
      puts `failure.message` into `unavailableDetail`; those strings are built by
      interpolating HttpClientErrors whose requests carry the refresh/bearer
      token. Redact to `_tag` + status.
- [ ] **F11. Event-loop lag monitor is opt-OUT.** `EventLoopLagMonitor.ts:71`
      disables only on `T3_EVENT_LOOP_LAG_OFF`, and it's wired into
      `makeServerLayer`. Invert to opt-in, matching `CpuProfiler`'s correct shape.
- [ ] **F12. `account.rate-limits.updated` spams the thread work log.**
      `ProviderRuntimeIngestion.ts:596` persists every one; the kind isn't on
      `deriveWorkLog`'s skip list (`session-logic.ts:632`). Fires per-turn-or-more
      from both Claude and Codex adapters, and the Codex path persists the entire
      raw payload. Add to skip list; store only what `ChatView.tsx:2155` reads.
- [ ] **F13. VCS timeout fixes cancel out.** `GitVcsDriver.ts:423` maps an
      `isInsideWorkTree` timeout to `false` → `detectRepository` returns `null`,
      and `VcsDriverRegistry.ts:132` gives success-`null` a `Duration.zero` TTL.
      So under the exact overload `DETECTION_FAILURE_TTL` exists for, the timeout
      path escapes the negative cache and keeps re-spawning git. Also user-visible:
      a healthy repo briefly reports "not a repository".
- [ ] **F14. Broadcaster semaphore has no time bound on a held permit.**
      `VcsStatusBroadcaster.ts:501` holds 1 of 3 permits across
      `refreshRemoteStatus`; the inner `git fetch` is capped at 8s but `gh` PR
      lookups are not. Three slow repos stall all background refresh.
- [ ] **F15. Fork-migration repair is a manual script.** `ForkMigrations.ts`
      design is correct (separate `t3fork_migrations` table, own high-water mark,
      runs after upstream). But any DB that ran the old interleaved migrations
      keeps an inflated mark in `effect_sql_migrations`, and if
      `fix-fork-migration-rows.ts --apply` is never run, upstream's next
      migrations are silently skipped. Make it fork migration `003`.

### Hygiene / lower

- [ ] **F16. Delete `usage-anim-expanded.png` and `usage-anim-nobubble.png`** from
      the repo root (653 KB). Recreated by `diagnose-usage-animation.mjs` writing
      relative to cwd. The expanded one shows live account state (plan tier, usage
      percentages). Point the script at `.crash-reports/`.
- [ ] **F17. `packages/shared/src/shell.ts` is treated as binary by git** — two
      literal NUL bytes at offsets 4044/4055, used as cache-key delimiters. The
      technique is fine; write them as `\0` escapes so git can diff and merge the
      file. Currently `git diff` shows only "Binary files differ".
- [ ] **F18. `lefthook.yml` is the unmodified `lefthook init` template** — 42 lines,
      all comments, referenced nowhere. Delete or make it real.
- [ ] **F19. `start-t3.ps1:133` runs the entire app elevated** via `RunAs` unless
      `-NoElevate`, so Electron, the backend, and every agent-spawned subprocess
      run as Administrator. Confirm this is still wanted.
- [ ] **F20. Machine-specific content in committed scripts** — `C:\temp\t3runs`,
      hardcoded `C:\Users\camer\...` paths, "Cameron runs…" comments.
- [ ] **F21. Consolidate duplicate plans** — `usage-meter-and-message-queue.md`
      and `usage-meters-and-queued-messages.md` cover the same feature.
      `t3code-netlog-findings.md` is stale by the fork's own account.
- [ ] F22. Favicon cache: no capacity bound, no single-flight (so a reconnect
      burst still does N walks — the exact case it was written for). `Effect.Cache`
      is used three times elsewhere in this same diff.
- [ ] F23. Editor cache is a module-level `let`, not layer-scoped — leaks across
      tests and survives service rebuilds.
- [ ] F24. Spawn-resolution cache key omits `PATHEXT` though resolution reads it.
- [ ] F25. `getHistory` has no LIMIT and `since` is optional (defaults to epoch).
- [ ] F26. `crash-snapshot.ps1:294` captures hostname, user, and 600-char command
      lines into a zip meant for sharing.

## Things not to do

- Don't chase the 5 `packages/shared` test failures — confirmed pre-existing on
  `upstream/main` in a clean worktree. Windows environment artifacts.
- Don't diff against local `main` — it's 688 commits behind upstream.

## Merge-maintenance note

The fork touches files upstream changes constantly: `ChatView.tsx` (69 upstream
commits in 3 months), `ws.ts` (57), `ChatComposer.tsx` (41), `server.ts` (39).
Every upstream merge will conflict there. The usage/queue feature is otherwise
well-isolated in new files; keeping the touch-points in those four hot files as
small as possible is what keeps this fork mergeable.
