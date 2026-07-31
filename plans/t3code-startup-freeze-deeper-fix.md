# Deeper fix: eliminate the startup event-loop freeze (many-repo local backend)

Status: **INSTRUMENTED 2026-07-27** — the lag monitor that was deferred three times now exists.
Awaiting one app restart to capture a startup profile. Do not attempt another blind fix.

## 2026-07-31 — THE DISCONNECTS ARE A SEPARATE BUG. Two problems, not one.

The first run with client-side disconnect diagnostics overturned the working theory.
**Do not conflate these again:**

### Problem 1 — startup event-loop stalls (real, and now much improved)

Same 62s window as the 2026-07-27 baseline:

| | 2026-07-27 | 2026-07-30 |
| --- | --- | --- |
| stalled | 34.9s (**57%**) | 21.3s (**34%**) |
| worst stall | 3745 ms | **2131 ms** |
| severe (>=5s) | several | **0** |

After the first 62s it is flat: 3 stalls totalling 0.8s over the next 16 minutes.

### Problem 2 — a metronomic 26-second disconnect cycle (the actual toast source)

Every recorded drop is:

```
event: lost-after-connect   reason: transport   hadEstablished: true
```

- **Period 26.2s, metronomic** — 19:00:43, 19:01:09, 19:01:35, 19:02:01 ... It is not
  network flakiness and it is **not startup-specific**: a prior session logged the same
  cycle continuously for **13 hours** (1,485 records).
- **Zero `health-check-slow` records.** If the loop were starving probes we would see
  near-misses. There are none, so the probe path is healthy and this is NOT the
  event-loop blocking that Problem 1 describes.
- Server side, `ws.rpc.server.getConfig` and `PreviewAutomationBroker.acquireConnection`
  both show a **26.3s median gap** — but those are the *consequence* (bootstrap
  re-running after each reconnect), not the cause.
- **Ruled out:** auth credential rejection (zero in the current trace).

The socket connects, works, and is ended ~26s later. `onDisconnect` fires with no
browser `close` event seen, which means either the close event arrives after Effect's
socket fiber observes the end, or **the socket never closed and the session was torn
down for another reason**. Distinguishing those is the next step: `session.ts` now
emits a separate `socket-close` record from the close listener itself, so its presence
or absence answers it without depending on ordering.

**Lesson repeated from earlier in this investigation:** the reconnect symptom was
assumed to be the event-loop spiral because they co-occurred at startup. They are
independent. Measure the symptom directly before attributing it to a known cause.

## ROOT CAUSE FOUND (2026-07-28) — spawn flood driven by a reconnect feedback loop
### (this explains Problem 1 above, NOT the disconnects)

First real backend CPU profile: `C:\temp\t3runs\20260728-010854\cpuprof\server-11212-startup.cpuprofile`
(90 s from server start, 52,397 samples).

| Self time   | %CPU      | Frame                  |
| ----------- | --------- | ---------------------- |
| 40.03 s     | 44.3%     | `(idle)`               |
| **24.00 s** | **26.6%** | **`spawn` (native)**   |
| 2.13 s      | 2.4%      | `all` (native)         |
| 1.69 s      | 1.9%      | anonymous, `effect.js` |

Everything below `spawn` is noise. Ancestry confirms the caller:
`spawn (native)` ← `node:child_process` ← `NodeChildProcessSpawner.js` ← Effect runtime.

**`child_process.spawn` is synchronous**, so those 24 s are 24 s the event loop could not run —
matching the independently-measured 34.9 s of stalls.

### It is spawn COUNT, not spawn cost

Measured the synchronous portion of `spawn()` directly against a real repo:
**9.2 ms/spawn** (40 spawns, 368 ms). Normal for Windows — no antivirus pathology.

So 24 s ÷ 9.2 ms ≈ **2,600 spawns in 90 seconds (~29/sec)** with 14 repos. That is the bug.

### Why so many: the backoff never escalates

In the same window the backend logged **386 `GitWorkflowService.remoteStatus` failures**
(`GitManagerError`) and **138 failed `gh` PR lookups** (`SourceControlProviderError`). Every failure
reported `consecutiveFailures: 1, nextDelayMs: 30000` — the exponential backoff **never grows past
the first step**.

The backoff code itself is correct. The state is what is lost: `consecutiveFailuresRef` is created
by `Ref.make(0)` _inside_ `makeRemoteRefreshLoop` (line ~405), and that fiber is forked when a repo
gains its first subscriber (~485) and **interrupted when its last subscriber leaves** (~508-523).

That closes a self-reinforcing loop:

1. Spawn flood blocks the event loop.
2. The client's health probe times out → it reconnects.
3. Reconnecting drops every `subscribeVcsStatus` → subscriber counts hit 0 → **all 14 pollers are
   interrupted**.
4. Re-subscribing re-forks all 14 pollers, each with `refreshImmediately` and a **fresh failure
   counter of 0**.
5. Failures restart at a 30 s delay instead of escalating → more spawns → back to 1.

This is precisely the "disconnect spiral" earlier plans described from its symptoms; it is now
evidence-backed from the inside.

### FIX IMPLEMENTED 2026-07-28 (counter hoist)

`VcsStatusBroadcaster.make` now holds `remoteFailuresRef` — a `Map<cwd, {consecutiveFailures,
lastFailureAtMs}>` at **broadcaster scope**, replacing the `Ref.make(0)` that lived inside the
poller fiber. Success clears the entry; failure increments it. Backoff therefore survives the
poller being interrupted and re-forked on resubscription.

A re-forked poller also **serves out the remaining backoff** before its first attempt, so a
reconnect no longer re-fires an immediate fetch at a repo that is known to be failing.

**Trap hit while doing this — do not repeat:** the first attempt _cancelled_ the initial refresh
(cleared `needsInitialRefreshRef`) instead of delaying it. When `automaticGitFetchInterval` is 0
the initial refresh is the ONLY refresh that ever runs, so that stranded those repos with no remote
status at all and hung 4 tests. Delay, never cancel.

### PR (`gh`) lookups already have a cache — the epoch bump defeats it

Answering "do we want a local cache for gh calls": there already is one, and it is good.
`GitManager.prLookupCache` is an Effect `Cache` with **negative caching**:
`timeToLive: (exit) => Exit.isSuccess(exit) ? PR_LOOKUP_CACHE_TTL (2 min) : PR_LOOKUP_FAILURE_TTL
(20 s)`, capacity 2048, plus a `lastKnownPrByBranchKey` fallback so a transient failure does not
clear an existing PR badge.

So failures _are_ cached for 20 s. What defeats it is the cache **key**, which includes
`prLookupEpoch(cwd)` — and `invalidateStatus` bumps that epoch. The code even says the periodic
poll deliberately avoids full invalidation to "keep the PR cache warm". But `refreshStatus` (which
calls `invalidateStatus`) is invoked from ~8 sites in `ws.ts` plus `ProviderCommandReactor`, and
each bump produces a brand-new cache key — a guaranteed miss and a fresh `gh` spawn.

Under reconnect churn this fires constantly, which is why 138 PR lookups failed in 90 s despite a
20 s negative TTL. **Adding another cache would not help; the existing one needs its epoch bumped
less often.** Not changed yet — it is upstream code on the explicit-freshness path, and the counter
hoist above should be measured first.

### Fix direction (remaining, not started)

- **Move the failure counter out of the poller fiber.** Key it by `cwd` in broadcaster-level state
  so backoff survives resubscription. Highest-value single change.
- **Do not honour `refreshImmediately` when that cwd failed recently** — a reconnect should not
  re-trigger an immediate fetch for a repo that is known to be failing.
- **Cache/back off failed PR lookups** — 138 failed `gh` spawns is pure waste.
- Longer term: batch per-repo git invocations (currently ~10+ spawns per repo per pass).

Note this is upstream code, so the same loop should affect any user with several repos where remote
status fails (offline remote, auth prompt, slow SSH) — not just this machine.

### PRE-EXISTING: 5 of 12 `VcsStatusBroadcaster.test.ts` tests already fail

Baselined by restoring HEAD's file and re-running: **5 failed / 7 passed, 480 s, identical with and
without the counter-hoist change.** Not caused by it, and not caused by the parallel agent.

Cause: the tests drive a `TestClock` (`TestClock.adjust(Duration.seconds(30))` etc.), but the fork
added `STATUS_REFRESH_STARTUP_GRACE = 10s` as an `Effect.sleep` at the top of every poller loop on
2026-07-03. The upstream tests were written without that grace in their virtual-time budget, so
four hang to a 120 s timeout and one asserts `expected 1 to equal 2`.

**This is a fork-introduced test regression that has gone unnoticed since 2026-07-03.** Fix by
making the grace injectable (a `StreamStatusOptions` field defaulting to 10 s) so tests can set it
to zero — do not "fix" it by deleting the grace, which is load-bearing for backend readiness.

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

## 2026-07-27 — FIRST ACTUAL MEASUREMENT OF THE FREEZE

Restarted the app with the monitor. The freeze is real and now quantified:

- **34.9 s of the first 61.7 s blocked = 57% of startup**, 40 stalls, worst single stall **3745 ms**.
- Timeline shape (t+seconds → stall ms):
  - `0 – 9.1` clean — **the 10 s `STATUS_REFRESH_STARTUP_GRACE` is working**; readiness is served.
  - `9.2 – 19.4` ramp: 300–1500 ms stalls.
  - `23.2 – 32.3` **peak: 3554, 3745, 2314, 2326 ms** — this is what fails a client probe.
  - `33 – 62` long tail of 300–1000 ms stalls.

So the grace fixed _bootstrap readiness_ but the deferred burst still blocks hard once released.

### What is in flight during the stalls

Spans enclosing the stall instants (150 ms–8 s, so long-lived subscriptions excluded), by frequency:
`runGitCommand` (avg 5.3 s), `VcsDriverRegistry.detect` / `detectRepository` (avg ~5.4 s),
`GitVcsDriver.statusDetails.unstagedNumstat` / `stagedNumstat` (avg ~6 s),
`ProjectFaviconResolver.walkForFavicon` (avg 5.2 s), `GitVcsDriver.originRemoteExists`,
`resolveHostingProvider`, `readBranchRecency`.

It is the initial git-status pass, as long suspected. **But in-flight ≠ blocking:** a
`runGitCommand` span is mostly async subprocess wait, which does not stall the loop.

### Ruled out BY MEASUREMENT this time (not by code-read)

| Hypothesis                                                                                          | Measurement                                                                              | Verdict                                                   |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Synchronous PATH walk in `resolveSpawnExecutableWithNode` (the plan's "single most likely culprit") | Full 77-entry PATH walk for one command = **27.7 ms**, **zero** entries slower than 5 ms | **NOT the cause**                                         |
| Database size / slow queries                                                                        | Real query shapes 0.16–15 ms, all indexed                                                | **NOT the cause**                                         |
| Process-spawn cost                                                                                  | 35 concurrent `git status` spawns → **200 ms** total stall                               | Real but ~2 s at startup scale, **cannot explain 34.9 s** |

So the synchronous work is somewhere not yet identified. Stop guessing — profile it.

### Next step: CPU profile — use the launcher

`scripts/start-t3.ps1` exists so a diagnostic run is reproducible instead of hand-typed. It
self-elevates, cd's to the repo root, **rebuilds when any source file is newer than the bundles**,
and sets the diagnostic env/args.

**The only command Cameron runs, with no arguments, ever:**

```
C:\Users\camer\git\t3code\scripts\t3.cmd
```

Then let it finish starting (~60 s) and **quit the app normally** (CPU profiles flush only on clean
exit).

**Claude configures the run by editing the `$Config` block in `scripts/start-t3.ps1` and committing
it** — `CpuProf`, `NetLog`, `LagMs`, `Build`. Never ask for a flag at the call site; if a session
needs different diagnostics, edit that block. `t3.cmd` takes no arguments and exists only because
Win+R cannot execute a `.ps1` (Windows opens it in an editor).

### Run markers — how to find a run's data

Every run creates `C:\temp\t3runs\<yyyyMMdd-HHmmss>\`, and `C:\temp\t3runs\latest.txt` holds the
newest run's path. Inside:

- `run.json` — start/end UTC, duration, exit code, branch/commit/dirty, whether it rebuilt and why,
  the effective config, and **`logStartOffset` / `logEndOffset` / `logBytesAppended`** for
  `server-child.log`. Those byte offsets are the marker: read exactly the slice this run appended
  instead of guessing timestamps.
- `launcher.log` — full transcript of the launcher.
- `cpuprof/` — this run's V8 profiles (per-run, so profiles never pile up ambiguously).
- `netlog.json` — only when `NetLog` is enabled.

Oldest run directories are pruned beyond `KeepRuns` (10). The launcher also warns if electron is
already running, since a second instance contends for the database and port.

Then analyse the largest `.cpuprofile` in `C:\temp\t3prof`. The self-time hot path is the answer.
Only then pick the lever.

### NODE_OPTIONS=--cpu-prof DOES NOT WORK HERE — superseded 2026-07-27

The first attempt set `NODE_OPTIONS=--cpu-prof` before launching. It produced four profiles and
**none of them was the backend**: pnpm (22 MB), vite-plus (25 MB), a tiny helper, and the Electron
main process (20 MB, identified by `dist-electron/main.cjs` + `node:electron/js2c/node_init`
frames). `DesktopBackendConfiguration.ts` copies `process.env` into the child and strips only
`T3CODE_*`, so Electron appears to sanitise `NODE_OPTIONS` for spawned children.

It was also the wrong shape: those profiles covered the entire 36-minute session at 20–200 MB each,
so the ~62 s of startup we care about was a rounding error inside them.

**Replaced by in-process profiling:** `apps/server/src/observability/CpuProfiler.ts` drives V8
through `node:inspector` from inside the server, gated on `T3_CPU_PROF_DIR`, and stops on a timer
(`T3_CPU_PROF_SECONDS`, default 90). Guaranteed to be the right process, scoped to startup, and
**written on a timer rather than at exit** — so killing the app no longer loses the profile.
Verified end to end: a scratch-home run logged "CPU profiler started" → "CPU profile written" 12 s
later and produced a valid 220 KB profile (606 nodes, 8540 samples).

Two Effect-4 gotchas hit while writing it, both worth remembering:

- **`Effect.async` does not exist in Effect 4** — it is `Effect.callback`. Using the wrong name
  types the result as `unknown`, which then poisons the requirements channel of every layer
  downstream. It surfaced as ~60 errors in `bin.test.ts` and **zero** in the offending file, which
  is a very misleading failure mode. Bisect by disabling the new layer if this shape appears again.
- An `@effect-diagnostics-next-line` directive that suppresses nothing is itself a **warning**
  (`TS377000`) and fails typecheck. `node:inspector` needs no suppression; `node:fs`/`node:path` do.

### Launcher gotcha already hit and fixed (2026-07-27)

The first version compared the newest source mtime against the **oldest build
artifact**, and so rebuilt on _every single launch_ (~2 min each). Cause: the build writes its
outputs at different times **and regenerates a source file mid-build** —
`apps/desktop/src/preview/AnnotationStyles.generated.ts` is written at 17:21:20 while
`apps/web/dist/index.html` from the same build is 17:21:14. A generated source therefore always
post-dated an artifact.

Fix: compare against `.t3-build-stamp.json`'s `builtAtUtc`, which is written **after** the build
finishes, so nothing the build touches can post-date it; and skip `*.generated.*` when scanning.
Verified: stamp 17:21:30 vs newest real source 15:19:45 → correctly reports "up to date".

**Rule for anything like this: never use an artifact mtime as the freshness reference when the
build mutates its own inputs. Use a marker written last.**

### Window behaviour

`t3.cmd` launches the pre-elevation process hidden (it exists only to raise the UAC prompt). The
elevated console stays visible through build and startup, then hides itself once an electron window
actually appears — done from a background job, since the launch call blocks until the app exits. It
is re-shown on a non-zero exit so a failure never disappears silently.

### The staleness check is the point

The desktop runs **bundles, not source** (`apps/server/dist/bin.mjs`,
`apps/desktop/dist-electron/main.cjs`). A stale bundle silently runs old code. This already cost a
session: a database repair looked like it had failed, when in fact a month-old server bundle was
re-applying the migrations the repair had just removed. The launcher compares the newest source
mtime against the oldest artifact and rebuilds, so "am I running the code we just changed?" stops
being a question.

### Repo gotcha: committing a lone `.ps1` fails

The pre-commit hook is `vp staged` (`.vite-hooks/pre-commit`, `core.hooksPath=.vite-hooks/_`).
`vp fmt` has no formatter for `.ps1`, and errors with _"Expected at least one target file"_ when
**no** staged file is formattable. Commit PowerShell alongside a `.ts`/`.md` file (which is how
`scripts/crash-snapshot.ps1` originally landed), rather than reaching for `--no-verify`.

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
