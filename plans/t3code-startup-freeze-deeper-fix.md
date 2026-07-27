# Deeper fix: eliminate the startup event-loop freeze (many-repo local backend)

Status: **INSTRUMENTED 2026-07-27** — the lag monitor that was deferred three times now exists.
Awaiting one app restart to capture a startup profile. Do not attempt another blind fix.

## 2026-07-27 measurement session — what was ruled IN and OUT

**Event-loop lag monitor built and verified.** `apps/server/src/observability/EventLoopLagMonitor.ts`,
wired into `makeServerLayer`. A fiber sleeps 250 ms and reports overshoot — overshoot is by
definition time the loop could not run timers. Verified end-to-end with a headless scratch-home
run: at `T3_EVENT_LOOP_LAG_MS=1` it emitted 91 reports with working annotations
(`lagMs`, `sinceStartupMs`, `maxLagMs`, `totalStalledMs`, `stallCount`). Default threshold 250 ms;
`T3_EVENT_LOOP_LAG_OFF` disables it.

**Where its output lands:** server stdout → `~/.t3/userdata/logs/server-child.log`. That file
rotates roughly monthly (10 MB × 10), so startup evidence survives. Do **not** rely on
`server.trace.ndjson` — see below.

### RULED OUT: the 3.3 GB database is not the startup bottleneck

Measured directly against the live database, read-only:

| Query (real shapes used by the app)                       | Time    |
| --------------------------------------------------------- | ------- |
| append probe `WHERE aggregate_kind = ? AND stream_id = ?` | 0.16 ms |
| projection catch-up `WHERE sequence > ? LIMIT 500`        | 9.55 ms |
| thread list (557 rows)                                    | 10.2 ms |
| activities for one thread (667 rows)                      | 14.7 ms |

All indexed; the append probe uses a covering index. **Do not repeat this false alarm:** a
synthetic `SELECT * FROM orchestration_events WHERE stream_id = ?` (no `aggregate_kind`) does a
full 733k-row SCAN and takes **2.8 s**, because both stream indexes lead with `aggregate_kind`.
The application never issues that shape. It is a latent footgun for future code, not a live bug.

### RULED OUT: steady state is not freezing

Gap analysis over live traces (a blocked loop emits no span start/end events): one 76 s window had
2 gaps > 0.5 s totalling 6.2 s (8%); a 39 s window had **zero**. Steady state is healthy now.

Also corrected: `sql.execute` appears to consume 94% of wall-clock by naive span-duration summing,
but merging overlapping intervals gives **19.1%** with a 6.5× overlap factor — the spans include
async waiting, not pure blocking. Do not quote the 94% figure.

### Database size: a housekeeping problem, not a performance one

3.3 GB total: `orchestration_events` 1.44 GB / 733k rows, `projection_thread_activities` 985 MB /
513k rows, `orchestration_command_receipts` 140 MB / 725k rows, rest indexes. **Nothing ever prunes
it** — no `DELETE FROM orchestration_events`, no retention, no VACUUM anywhere in the server. It is
an append-only event log growing unboundedly (~3.3 GB per ~4 months on this machine). Worth an
upstream issue and eventually a retention policy, but it is not causing the freeze.

### Observability gap found along the way

`server.trace.ndjson` rotates **10 MB × 10 files in ~12 minutes** (~100 MB per 12 min) under normal
use. Any startup evidence is destroyed within minutes, which is a large part of why this has stayed
undiagnosed. Trace volume is dominated by `sql.execute` (4131 spans / 20k lines), `sql.transaction`,
`runProjectorForEvent`, `runAttachmentSideEffects`.

### Next step (do exactly this, do not skip to a fix)

1. Restart the desktop app (server bundle already rebuilt with the monitor).
2. `grep -A5 "Event loop" ~/.t3/userdata/logs/server-child.log`
3. Read `sinceStartupMs` + `lagMs` to see **when** during startup the loop blocks and **for how
   long**. Only then choose the lever.

--- pre-2026-07-27 history below ---

Status: FIRST ATTEMPT REVERTED (2026-07-03). Throttle was counterproductive at startup.

### IMPORTANT correction (2026-07-03)

- `320a2fd7e` (throttle status refreshes to 3 concurrent) was REVERTED by `408c68780`. It made
  STARTUP WORSE: the desktop bootstrap waits up to **60s** for backend readiness
  (`httpReadiness`, probes `/.well-known/t3/environment`). Serializing the per-repo status pass
  (3 at a time instead of all at once) STRETCHED the busy period past 60s, so readiness timed out
  and the app **wouldn't start at all**. The backend WAS alive (logged session-reaper at ~112s) —
  it just became ready too late. Parallel-burst (unbounded) finished under 60s; throttled did not.
- LESSON: the initial status burst blocks backend READINESS. Throttling concurrency trades a short
  freeze for a longer busy period — wrong lever for a hard 60s deadline.
- CORRECTED FIX DIRECTION: **defer the initial status refresh until AFTER the backend is ready**
  (so readiness responds fast), then run the deferred burst (optionally throttled) post-connect.
  Candidate: in `VcsStatusBroadcaster.ts makeRemoteRefreshLoop`, add a startup grace delay before
  the first refresh even when `refreshImmediately` is true; and/or don't start the pollers until the
  HTTP server reports ready. Verify readiness responds in <a few seconds with 14 repos.
  Alternative/complement: raise the `httpReadiness` 60s timeout (band-aid; backend still slow).
- DO THIS WITH THE EVENT-LOOP LAG MONITOR and off the live app — the throttle regression happened
  because I couldn't measure startup timing and guessed.

### SECOND ATTEMPT (2026-07-03): defer initial refresh — commit `5b5951edb`

- Added `STATUS_REFRESH_STARTUP_GRACE = Duration.seconds(10)` and a `yield* Effect.sleep(grace)` at
  the top of `makeRemoteRefreshLoop`, so each poller waits 10s before its first refresh. This lets
  the backend serve its readiness endpoint (idle during the grace) before the initial status burst.
- No throttle this time (one variable). The deferred burst still runs unbounded post-connect; the
  client tolerance fixes (probe retry, descriptor retry) handle any brief post-connect blip.
- Trade-off: remote (ahead/behind) status is ~10s late at startup AND for a newly-opened repo (its
  poller also graces). Local status (working-tree changes) is unaffected (on-demand).
- IF startup is now fast: consider re-adding the throttle ON TOP (safe now the burst is post-
  readiness) to also calm the post-connect burst. IF startup still fails: the grace wasn't the whole
  story — add the event-loop lag monitor before guessing further.

--- superseded first attempt below ---
Status: FIX IMPLEMENTED (2026-07-03), pending user verification.

- Commit `320a2fd7e` fix(vcs): throttle concurrent background status refreshes — added a shared
  `Semaphore.make(STATUS_REFRESH_CONCURRENCY=3)` in `VcsStatusBroadcaster.ts` and wrapped the remote
  poller's `refreshRemoteStatus` call, so at most 3 repos refresh at once instead of all N fanning
  out at startup. On-demand status requests are NOT throttled.
- Hypothesis 2 (exec-cache misses) RULED OUT by code-read: status git ops pass no env override, so
  `resolveSpawnExecutableWithNode` keys on the stable host PATH and the cache hits. Not the bottleneck.
- Event-loop lag monitor: NOT added (kept the change to one file). Add it only if the throttle
  proves insufficient and we need to measure the residual freeze directly.
- VERIFY: restart, watch `~/.t3/userdata/logs` — connection setup / descriptor timeouts on startup
  should drop; refreshRemoteStatus spans should stay short. If still freezing, lower
  STATUS_REFRESH_CONCURRENCY to 2 and/or add the lag monitor.

--- original plan below (for context / next steps if needed) ---

This is the "do it properly" follow-up to the tolerance band-aids in
`t3code-connection-fixes-summary.md`. Do this off the critical path (not as a live hot-patch on the
user's running app) — the live iteration caused regressions.

## Goal

Make the local backend stay responsive at startup when many repos (~14+) are open, so connection
setup / health checks / descriptor fetches don't time out during the initial status pass. The
tolerance fixes already shipped make timeouts non-fatal; this removes the freeze that causes them.

## Symptom (confirmed)

On backend start, the initial local-status refresh runs for ALL open repos at once. During that
pass the event loop is frozen long enough that a loopback HTTP GET
(`/.well-known/t3/environment`, 10s) times out and connections can't establish until the pass
finishes ("finally recovered on its own"). `automaticGitFetchInterval: 0` removed the _recurring_
remote storm but NOT this _initial_ local pass.

## Hypotheses to confirm (instrument first — don't guess)

1. **Unthrottled initial local-status fan-out.** Remote fetches got a semaphore
   (`STATUS_UPSTREAM_REFRESH_CONCURRENCY=2` in `GitVcsDriverCore.ts`), but the LOCAL status pass
   (detectRepository + `git status` etc. per repo) has no shared concurrency limit. N repos ×
   several git spawns each, all at once, at startup.
   - Where: `apps/server/src/vcs/VcsStatusBroadcaster.ts` — per-repo loops are `Effect.forkIn`ed
     independently (`makeRemoteRefreshLoop` and the local equivalent); `refreshImmediately` fires
     the initial pass. No cross-repo cap.
2. **Synchronous event-loop blocking**, not just async load. Candidates:
   - `resolveSpawnExecutableWithNode` (`packages/shared/src/shell.ts`) uses synchronous `statSync`
     PATH walks. It was memoized in `740898bea` — **verify the cache actually HITS**. If the cache
     key (`platform+command+PATH`) varies per spawn (e.g. per-repo env changes PATH), it misses and
     every spawn re-walks PATH synchronously → sustained freeze. This is the single most likely
     culprit and the highest-value thing to confirm.
   - Large synchronous git-output parsing.
3. Git child-process spawn cost on Windows (process creation is expensive); N at once compounds.

## Investigation steps

1. **Add an event-loop lag monitor to the backend** (the measurement repeatedly deferred). A tiny
   `setInterval`-drift sampler in the server startup (`apps/server/src/bin.ts` → `cli/server.ts`
   long-running program) that logs when lag exceeds a threshold, with a timestamp. Confirms whether
   the loop is truly blocked and for how long, and correlates with the startup pass.
2. **Verify the executable-resolution cache hit rate.** Add a temporary counter/log to
   `resolveSpawnExecutableWithNode` (hits vs misses, and the cache key). If misses dominate, fix the
   key (normalize PATH / drop env-specific parts) so `git` resolves once per process.
3. **Measure per-repo local-status cost** and the total startup-pass duration for N repos.

## Fix approaches (apply what the instrumentation supports)

- **Throttle the initial/local status pass** with a shared semaphore (mirror the remote-fetch cap),
  e.g. process repos a few at a time so the loop breathes. Likely in `VcsStatusBroadcaster.ts`
  around the fork of per-repo loops / the initial refresh.
- **Fix the exec-cache** if it's missing (see step 2) — likely the biggest single win, since a
  cold/broken cache means synchronous PATH walks on every spawn.
- **Stagger** the initial refresh (small jittered delay per repo) so N repos don't all fire on the
  same tick.
- Consider making the local-status git ops yield / run at lower priority.

## Verification

- Event-loop lag stays under (say) a few hundred ms during startup with 14 repos.
- A loopback HTTP GET to `/.well-known/t3/environment` returns fast throughout startup.
- Connection establishes on the first attempt at startup; no "reconnecting" churn.
- Re-enable `automaticGitFetchInterval` to a sane value (e.g. 60s) and confirm steady state is fine.

## Things NOT to do

- Don't iterate live on the user's running app — regressions there blocked them repeatedly.
- Don't just add more per-path timeout tolerance; that treats symptoms, not the freeze.
- Don't raise timeouts further without a concurrency cap — longer timeouts + contention made a
  contended fetch bog the backend LONGER (regression seen at concurrency 4 / 15s).
- Don't enable SSH multiplexing on Windows.

## Relevant files

- `apps/server/src/vcs/VcsStatusBroadcaster.ts` — per-repo refresh loops, initial refresh, interval.
- `apps/server/src/vcs/GitVcsDriverCore.ts` — remote fetch semaphore + backoff (pattern to mirror).
- `packages/shared/src/shell.ts` — `resolveSpawnExecutableWithNode` exec cache (verify hits).
- `apps/server/src/bin.ts` / `apps/server/src/cli/server.ts` — where to add the lag monitor.
- `packages/client-runtime/src/connection/supervisor.ts` — already-tolerant probe/setup (reference).
