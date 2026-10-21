# ATTEMPTS — connection drops, startup freeze, and backend load

**Purpose: stop agents re-running dead hypotheses.** This investigation has repeatedly
re-tried ideas that were already refuted, sometimes by the same agent a few days apart. If you
are about to investigate T3 Code disconnecting, freezing at startup, or the backend being
busy — **read the "Already refuted" table first.**

## For any agent picking this up

- **Append, don't rewrite.** Add your attempt to the log with the date, what you actually did,
  and the evidence. Negative results are the most valuable entries here; a refuted hypothesis
  saves the next agent a day.
- **Record evidence, not impressions.** "Felt faster" is not an entry. Numbers, log excerpts,
  file:line references are.
- **If you refute something in this file, say so and update it in the same change.** A stale
  entry is worse than none.
- **This is fork-only** (`plans/` is not tracked upstream), so it will not conflict on merge.
- Related detail lives in `plans/t3code-startup-freeze-deeper-fix.md` and
  `plans/t3code-connection-fixes-summary.md`.

## The problem, current understanding (2026-08-02)

Two symptoms, **linked through backend startup load**, not through the mechanism originally
assumed:

1. **Startup event-loop stalls.** Backend blocked 57% of the first 62s (2026-07-27), improved
   to 34% (2026-07-30), 29% of 204s (2026-08-02). Driven by a spawn flood: **~2,200 process
   spawns in the first 90s**, `spawn` at 22.7% of CPU.
2. **Connection drops during startup only.** Socket connects, lives **~10s**, closes; retry
   ladder climbs to its 16s cap giving ~26s cycles. **All drops fall inside the first ~162s
   and then stop for the rest of the session.** Close codes: `1006` (abnormal) during the
   busiest phase, then `1000` (clean).

**SUPERSEDED 2026-08-03** — the close mechanism IS now identified: the client's own ping
watchdog, firing at ~10s when the server does not answer a Ping within 5s. See the
"connection lifetime is a FIXED TIMEOUT" entry. Point 1 below (stalls) and point 2 (drops) are
**not** the same problem: the drops need no stall at all, and this framing sent the
investigation after CPU for weeks.

## Already refuted — do NOT re-run these

| Hypothesis                                                                                  | How it was killed                                                                                                                                                                                                                                              | Date       |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Health-probe timeouts cause the drops (the original theory for months)                      | **Zero `health-check-slow` records, ever.** The probe path is healthy.                                                                                                                                                                                         | 2026-07-31 |
| `navigator.onLine` flapping tears down the socket                                           | **`network-changed: 0`** — connectivity never reported offline                                                                                                                                                                                                 | 2026-08-02 |
| Backend crashes / is killed and restarted                                                   | Single PID across a whole storm, **zero** `sinceStartupMs` regressions                                                                                                                                                                                         | 2026-08-02 |
| Auth credential rejection closes connections                                                | Zero rejections in the trace during a storm                                                                                                                                                                                                                    | 2026-08-02 |
| The 3.3 GB database is the bottleneck                                                       | Real query shapes measured at **0.16–15 ms**, all indexed                                                                                                                                                                                                      | 2026-07-27 |
| Synchronous PATH walk in `resolveSpawnExecutableWithNode` (long-held "most likely culprit") | Full 77-entry PATH walk = **27.7 ms**, zero slow entries                                                                                                                                                                                                       | 2026-07-27 |
| Expensive spawns (antivirus etc.)                                                           | **REOPENED 2026-08-03 -- see the Defender entry.** Measured 9.2 ms/spawn and called it "normal for Windows", but that phrase already includes Defender, and it never asked who else was burning CPU. Spawn **count** still matters; cost is no longer settled. | 2026-07-28 |
| Stalls directly cause the socket closes                                                     | Worst pre-close stall **1.7 s**, far below any timeout. With stalls at a 29% duty cycle, finding one before any close is **expected by chance** — this correlation is NOT evidence.                                                                            | 2026-08-02 |
| `application-active-reconnect` wakeup replaces the lease                                    | **Mobile-only**; never fires on desktop                                                                                                                                                                                                                        | 2026-08-02 |

## Attempts log

### 2026-07-03 — throttle concurrent status refreshes — **REVERTED**

`320a2fd7e`, reverted by `408c68780`. Capping to 3 concurrent made startup **worse**: it
stretched the busy period past the desktop's 60s readiness timeout, so the app would not start
at all. **Lesson: throttling trades a short freeze for a longer busy period — wrong lever
against a hard deadline.**

### 2026-07-03 — 10s startup grace before the first status pass — **partial**

`STATUS_REFRESH_STARTUP_GRACE`. Readiness is now served cleanly (measured: no stalls before
t+9.2s), but the deferred burst still storms once released. Also **broke 5 upstream
`VcsStatusBroadcaster` tests** for ~3 weeks unnoticed — they drive a `TestClock` that does not
know to advance past the grace. Fixed later with an injectable `startupGrace` option.

### 2026-07-22 — cache favicon resolution — **worked**

`401da737f`. Removed the dominant slow-RPC toast source (measured: 70 `assets.createUrl` calls
up to 20.2s each in a 2h trace). Upstream independently did the same later (`1d77cec99`), at a
different layer — both are still useful.

### 2026-07-27 — event-loop lag monitor — **the unlock**

`apps/server/src/observability/EventLoopLagMonitor.ts`. Deferred three times before this;
every prior "fix" was guessed. First real number: **34.9s blocked out of 61.7s (57%)**.

### 2026-07-28 — in-process CPU profiler — **the unlock, part 2**

`apps/server/src/observability/CpuProfiler.ts`. **`NODE_OPTIONS=--cpu-prof` does not reach the
backend** — it profiled pnpm, vite-plus and Electron main instead (four profiles, none the
server). The server profiles itself via `node:inspector`, gated on `T3_CPU_PROF_DIR`, stopped
by a timer so it does not need a clean exit. Result: `spawn` 24.0s = **26.6% of CPU**.

### 2026-07-28 — hoist remote-refresh backoff out of the poller fiber — **shipped**

`3ff15b276`. The failure counter lived in a `Ref` inside a fiber that is interrupted whenever a
repo loses its last subscriber — and a client reconnect drops every subscription at once, so
backoff reset to zero exactly when it mattered. Now keyed by cwd at broadcaster scope.
**Trap:** the first version _cancelled_ the initial refresh instead of delaying it; when
`automaticGitFetchInterval` is 0 that is the only refresh there is, so it stranded repos and
hung 4 tests. **Delay, never cancel.**

### 2026-07-30 — durable diagnostics — **shipped**

`6d2f4f07e`. Both "obvious" sinks are unreliable: backend stdout capture into
`server-child.log` silently stopped recording, and `server.trace.ndjson` rotates every ~60–90s
(a ~19s window). Client disconnects now emit structured records through the crash-log IPC
bridge into `renderer.log`; server stalls append to a per-run `diagnostics.ndjson`.

### 2026-07-31 — capture the WebSocket close code — **shipped, after a bug**

`4e9e0fddb`, fixed by `1d78b30b2`. First version read the close info when `onDisconnect` built
its error and always reported `[no close event observed]` — Effect's socket fiber observes the
end **before** the browser dispatches `close`. Emit from the listener instead.

### 2026-08-02 — log network transitions — **hypothesis refuted, instrumentation kept**

`edabbea6b`. Produced `network-changed: 0`, killing the connectivity theory.

### 2026-08-02 — why the UI stays unusable through a storm — **shipped, UNVERIFIED at runtime**

This is the _user-visible_ half of the problem, and it is a separate bug from whatever closes
the socket. It explains "it's easy to get stuck in a loop where it doesn't seem to recover".

**The backoff ladder ratchets up and can never come back down.**

- `resetRetryLadder()` runs only when `outcome.stable`
  (`packages/client-runtime/src/connection/supervisor.ts:788`).
- `stable` is `connectedForMs >= BACKOFF_RESET_AFTER_MS`, and that constant is **30 s**
  (`supervisor.ts:39,713,717`).
- Measured connection lifetime during a storm is **~10 s** (see "current understanding" above).

So `stable` is never true during a storm. `failureCount` only ever increments
(`supervisor.ts:822`), and `retryDelayMs` is `RETRY_DELAYS_MS[min(failureCount, 4)]`
(`supervisor.ts:218`) — it pins at the **16 s cap and stays there for the rest of the session**.
Retries are unbounded, so it never "gives up"; it just settles into a permanent
~10 s-connected / ~16 s-waiting cycle. **The UI is blocked for the ~60% of wall-clock that is
not "connected"**, indefinitely, until a connection happens to survive a full 30 s by luck.
That matches the reported "given some time, the tool seems to have settled".

**What is actually blocked is send/queue, not typing.** The gate is
`activeEnvironmentUnavailable = activeEnvironment !== null && phase !== "connected"`
(`apps/web/src/components/ChatView.tsx:1672`), which feeds `environmentUnavailable` into both
`collapsedComposerPrimaryActionDisabled` and `queueDraftDisabled` in `ChatComposer.tsx`. It is
binary with no hysteresis, so it disables the composer during _every_ backoff window including
the 1 s ones.

**Dead code found while confirming this:** `ChatView.tsx:1293` is
`const [isConnecting, _setIsConnecting] = useState(false)` — the setter is unused, so
`isConnecting` is permanently `false`. It is nevertheless threaded into the composer and used
as the prompt editor's `disabled` gate (`ChatComposer.tsx:3092`) and into `isWorking`. Anyone
reading the composer will reasonably assume connection state disables typing; **it does not**.
Wire it or delete it, but do not trust it.

**Note on the obvious fix that does not work:** "let the user queue a message while
disconnected" is not available as written — queued messages are server-side (the fork's
`fork_queued_messages` table), so enqueueing needs the very connection that is down. Offline
queueing would need local persistence first.

**Shipped 2026-08-02** (`b6e36a265`, `73ab6481e`), after sign-off. Unit-tested only -- neither change has been observed in a real storm:

- `PRODUCTIVE_CONNECTION_MS = 5_000` in `supervisor.ts`. A connection that held at least that
  long walks the ladder **down** one rung instead of climbing it, so a storm recovers
  16s → 8s → 4s → … instead of locking at the cap. Failing to establish at all still climbs, so
  a dead backend keeps its full backoff; the 5 s floor stops an instant connect/drop loop from
  pulling the delay to 1 s and hammering a struggling backend. Timed in the `run` loop rather
  than threaded through `AttemptOutcome`, so the outcome types stay identical to upstream's and
  do not conflict on merge. Two regression tests in `supervisor.test.ts`.
- `ENVIRONMENT_UNAVAILABLE_SETTLE_MS = 2_500` + `apps/web/src/hooks/useSettledFlag.ts`. The
  composer gate must now stay non-connected that long before it trips, and clears immediately on
  reconnect, so short drops no longer flicker the UI. Applied at the single derivation site in
  `ChatView.tsx`, so every consumer inherits it.
- The diagnostic records now carry `attemptMs` and `productive`, so the decay is verifiable from
  `renderer.log` rather than by impression.

**RISK — check this before calling the decay a win.** Every reconnect drops all subscriptions
and re-runs bootstrap, which is what triggers the git-status spawn burst. The 16 s cap was
accidentally acting as **load shedding**. Decaying to 8 s/4 s re-runs bootstrap roughly twice as
often during the window that is already 29% event-loop-blocked, so the decay could plausibly
make startup _worse_ — the same shape as the 2026-07-03 throttle revert, pointed the other way.

Verify on the next restart, against these baselines, before trusting it:

| Metric                           | Where                                     | Baseline (2026-08-02, pre-fix) |
| -------------------------------- | ----------------------------------------- | ------------------------------ |
| Stall duty cycle, first ~180 s   | `diagnostics.ndjson` (`event-loop-stall`) | **29% of 204 s**               |
| Worst single stall               | same                                      | **2131 ms**, zero severe       |
| Drop count / window              | `renderer.log` (`lost-after-connect`)     | all within first **~162 s**    |
| `retryInMs` trend across a storm | same                                      | pinned at **16000**            |

Expected if the fix works: `retryInMs` walks _down_ (16000 → 8000 → 4000) with `productive:
true`, and the stall duty cycle does **not** rise. If duty cycle climbs materially above 29%,
the decay is feeding the spiral — gate it off during the first ~90 s of a session rather than
reverting it outright.

**Not done, deliberately:** deleting the dead `isConnecting`. It is a no-op at runtime
(permanently false, so every `isConnecting ||` folds away) but removing it touches ~29 sites
across `ChatView.tsx`, `ChatComposer.tsx` and `ComposerPrimaryActions.tsx` — three of the most
actively-developed upstream files. A permanent conflict surface that large is not worth a
cosmetic cleanup in a fork. It is upstream's dead code; report it there instead.

**Pre-existing test failures** in `supervisor.test.ts` at this commit, confirmed unrelated by
disabling the new decay and re-running: `retries when a session never becomes ready`,
`interrupts and releases a connection attempt when setup times out`, `does not let platform
wakeups reset an in-flight attempt`. Not investigated yet.

### 2026-08-03 — first measured run with the ladder decay — **decay kept, hysteresis REVERTED**

Run `C:\temp\t3runs\20260803-003716`, 134.7 s of `diagnostics.ndjson`.

**The backoff decay looks good, and the load-shedding risk did not materialise:**

| Metric           | Baseline 2026-08-02 | This run                                         |
| ---------------- | ------------------- | ------------------------------------------------ |
| Stall duty cycle | 29% of 204 s        | **15.2%** of 134.7 s (18.9% over the first 90 s) |
| Worst stall      | 2131 ms             | **1842 ms**                                      |
| Stalls ≥ 5000 ms | 0                   | **0**                                            |

Retrying ~2× more often did **not** raise the stall duty cycle — it fell. The
"decay feeds the spiral" risk recorded above is **not supported** by this run (one run, one
machine; not conclusive).

**New, important:** `systemCpuPct` is **98–100% on nearly every stall** while `selfCpuPct` is
28–54%. The backend is mostly being **starved by the machine**, not burning CPU itself. Chasing
backend work may be chasing the wrong thing on a contended box.

**The composer hysteresis was reverted** (`73ab6481e`, reverted by `78afab0f3`) after it broke
the UI within minutes of shipping. `useSettledFlag` cleared immediately on `false`, so **every
momentary `connected` blip reset the timer** — under flapping faster than the 2.5 s settle it
**never tripped at all**. Because `ChatView.tsx:6031` gates the sync pill on
`!activeEnvironmentUnavailable`, the user got a permanent "Syncing messages…", an enabled
composer, and sends that bounced, with no indication the environment was down.
**Lesson: an asymmetric debounce that is slow to raise and instant to clear is fooled by short
_connections_, not just short outages. Masking a disconnect is worse than the flicker it fixes.**

### 2026-08-03 — close code 1000 is NOT evidence of a deliberate server close — **refuted**

`.repos`/`node_modules` `effect` `Socket.ts:603` releases the socket with a hard-coded
`ws.close(1000)`. **Every** client-side scope release therefore reports a clean 1000, whatever
the reason. The 1000-vs-1006 split has been treated as forensic evidence in this investigation;
it mostly is not. 1000 means "the client tore down its own scope", not "someone deliberately
closed the connection".

### 2026-08-03 — the ping/pong watchdog: the best unexplored lead

Verified in the patched runtime (`node_modules/.pnpm/effect@4.0.0-beta.102*/…`):

- `RpcClient.ts:1169-1179` — ping every 5 s; if no pong arrived since the last ping, open the
  timeout latch. Ping at t≈5 s, timeout at t≈**10 s**.
- `RpcClient.ts:1091-1102` — that latch races the read loop and fails it with
  `SocketOpenError(kind: "Timeout", cause: "ping timeout")`.
- `session.ts:158` — `retryPolicy: Schedule.recurs(0)`, so it is **not retried**.
- `Socket.ts:603` — teardown then reports a clean **1000**.

**~10 s is exactly the observed connection lifetime.**

The critical implication: a ping timeout needs the server to miss a pong for **≥5 s**, and this
run had **zero stalls ≥5000 ms** (worst 1842 ms). So if this is the mechanism, **it is not
event-loop blocking**. The server answers `Ping` inside the per-client RPC message loop, and
bootstrap work is async subprocess wait — in-flight, not blocking (standing rule 2). A pong can
sit behind slow in-flight handlers for >5 s while the event loop looks healthy.

**This would explain why every hypothesis in the refuted table failed.** They are all variants
of "the server is too busy", measured via CPU and event-loop lag — and this mechanism is
invisible to both.

**Next step (not yet done):** the patched `RpcClient` exposes `onPing`/`onPong`/`onPingTimeout`
`ConnectionHooks`. `session.ts:130-148` wires only `onConnect`/`onDisconnect`; the ping hooks
have **never been observed**. Wire them into the existing crash-log bridge and record
ping→pong latency. Pong latency climbing past 5 s while stalls stay under 2 s confirms the root
cause; healthy pong latency exonerates the watchdog. Diagnostics only, no behaviour change.

### 2026-08-03 — Windows Defender as the CPU amplifier — **instrumented, awaiting a run**

**The 2026-07-28 "expensive spawns (antivirus)" refutation was too quick and is hereby
qualified.** It measured **9.2 ms/spawn** and called that "normal for Windows". Both parts are
true and the conclusion still does not follow: ~9 ms is slow for a process spawn, and "normal
for Windows" already includes Defender's real-time scanning on a typical machine. It measured
_our_ per-spawn latency and never asked **who else was burning CPU**.

Measured config on this machine (2026-08-03, `Get-MpComputerStatus` / `Get-MpPreference`):

- `RealTimeProtection`, `BehaviorMonitor`, `OnAccessProtection`: **all True**
- **No exclusion covers `C:\Users\camer\git\t3code`**, `git.exe`, or `node.exe`
- The user _has_ excluded many other dev trees (Rust `target`, `.venv`, PlatformIO, ESPHome,
  GitKraken) — so this repo is the unexcluded outlier, and it is the one spawning ~2,200
  `git.exe` processes in the first 90 s.

Why it fits everything the refuted table could not:

| Evidence                                         | Fits                                                     |
| ------------------------------------------------ | -------------------------------------------------------- |
| `systemCpuPct` 98–100% while `selfCpuPct` 28–54% | Defender burns CPU, backend is starved                   |
| Zero event-loop stalls ≥5000 ms, ever            | Starvation delays the pong **without blocking the loop** |
| Ping timeout at ~10 s → clean 1000 close         | Downstream consequence, not the cause                    |
| Drops stop after ~162 s                          | Defender's scan cache warms                              |
| User's own "maybe the cache is warm now?"        | Same observation, independently                          |
| Worse on a loaded machine                        | Contention for the same cores                            |

**Instrumentation added** (`scripts/sample-host-cpu.ps1`, wired into `start-t3.ps1` behind
`Config.HostCpu`, default ON): one out-of-process sample/second of per-process CPU
(`MsMpEng`, `System`, `electron`, `node`, `git`) for the first 240 s, to
`<run>/host-cpu.ndjson`. Epoch millis, so it lines up directly with `diagnostics.ndjson`.
Out-of-process on purpose — it measures the backend _while the backend is starved_, so it must
not share that event loop or die with it.

**Prediction to test:** `MsMpEngPct` is high through the storm window and falls away when the
drops stop. If instead MsMpEng is quiet while `systemCpuPct` is still pegged, Defender is
exonerated and the starvation is something else on the box.

**Do NOT add a Defender exclusion as a first move.** It is a real security decision, not a free
win: this repo is where coding agents execute arbitrary commands and write files. Measure
first, then choose deliberately among (narrowest first) excluding `git.exe` as a process,
excluding `.git` directories, excluding the whole tree — or the option that changes no security
posture at all, **cutting the ~2,200 spawns**, which has been the evidence-backed lever since
July.

### 2026-08-03 — Defender measured: real, but NOT the starver — **partially refuted**

Run `C:	emp	3runs60803-110932`, 188 host-CPU samples over 203 s, 12 cores.

`MsMpEng` averages **7.7–10.1%** of the machine through the first 120 s, peaking at **21.9%**,
then decaying. On a 12-core box that is ~1–2.6 cores. **Defender is a real contributor and
cannot be the thing pegging the machine.** The hypothesis as stated is not supported; treat
Defender as an amplifier at most.

**Correction, same run:** an earlier draft of this analysis claimed MsMpEng "hits exactly 0.0%
at t+162 s", matching the boundary where drops stop. **That was an artifact of the analysis
bucket edges**, which had been chosen at 162 s. The last non-zero MsMpEng sample is actually
**t+209 s**. There is no sharp 162 s transition in this data. A binned average is not an event.

**The actual open question.** Against the backend's own `systemCpuPct` of 100% during stalls,
the named watch list accounted for only 13–31%, leaving **69–87% unattributed**. That number is
NOT yet evidence for the spawn flood: sampler v1 only summed a five-name watch list, so
ordinary processes (chrome, SearchIndexer, the agent itself) landed in the shortfall too.
Sampler v2 attributes **every** process and publishes `machineCpuPct`, `sampledTotalPct`,
`unaccountedPct` and `topProcs`, so the next run can distinguish:

- shortfall **large** with small `topProcs` → short-lived processes, i.e. the spawn flood
  (`Get-Process` samples instantaneously and structurally cannot see a 9 ms `git.exe`);
- shortfall **explained by a name in `topProcs`** → a long-lived hog nobody thought to watch.

### 2026-08-03 — four bugs found while building the host-CPU sampler — **all fixed pre-ship**

Every one of these produced plausible, wrong output. Listed because the next person writing
instrumentation here will hit the same class of thing:

1. **First tick reported ~1,000,000%.** With no previous sample, each process's _lifetime_ CPU
   was counted as one interval's delta. Guarding on the wrong variable (already populated
   earlier in the same tick) did not catch it.
2. **Negative shortfalls.** Newly-appeared processes were also counted from zero, so the sampled
   sum could exceed the machine total. Fixed by **skipping processes absent from the previous
   tick** — which is also what makes short-lived spawn CPU land in `unaccountedPct`, the
   quantity being measured.
3. **`topProcs` emitted `c:l, 1:`.** PowerShell unrolls a single-element array of pairs into the
   pair itself, so `$_[0]`/`$_[1]` indexed into a _string_. Use `[pscustomobject]`, never nested
   arrays, for anything that might have exactly one element.
4. **A fully idle machine measured 92% busy.** `Win32_PerfRawData_PerfOS_Processor`'s `_Total`
   instance reports `PercentIdleTime` **already averaged across processors**. Dividing by core
   count again yields `100*(1 - 1/12)` = 92% at idle. Do not scale `_Total` by `$cores`.
   (`Get-Counter` was tried first and is also wrong here: it samples an instant, not an
   interval, so it disagrees with an interval-based sum.)

**Rule earned: sanity-check an instrument against a state whose answer you already know**
(here: an idle machine must read ~0%) before trusting a single number it produces.

### 2026-08-03 — full CPU attribution — **T3 is not the hog; the box is oversubscribed**

Run `C:	emp	3runs60803-115208`, 206 fully-attributed samples, 12 cores. The machine is
genuinely pegged: `machineCpuPct` averages **98-99% from t+30s through t+200s**. Average share
of the whole machine across the 147 samples where it was ≥90% busy:

| Consumer                                              | avg       | peak      |
| ----------------------------------------------------- | --------- | --------- |
| **This sampler** (`WmiPrvSE` + its `powershell` host) | **18.9%** | **35.4%** |
| `MsMpEng` (Defender)                                  | 10.6%     | 23.4%     |
| `esrv_svc` (Intel Energy Server Service)              | 10.3%     | **47.1%** |
| `chrome`                                              | 5.1%      | 19.8%     |
| **`electron` (T3 Code itself)**                       | **6.9%**  | 24.6%     |

**T3 Code is not what is pegging this machine.** It averages ~7% while the box sits at ~99%.
The starvation the backend reports (`systemCpuPct` 100%, `selfCpuPct` 14-41%) is real and is
**caused by other software on the host**. This is the strongest support yet for the user's
"overloaded computer" reading, and it means backend micro-optimisation has a low ceiling.

`esrv_svc` deserves a look: an Intel telemetry service, unrelated to T3, peaking at 47% of a
12-core box (≈5.6 cores). **Not touched — it is the user's machine and their call.**

**Refuted: my own "the unaccounted CPU is invisible short-lived spawns" theory** from earlier
the same day. With full attribution the shortfall collapses to **3-16%** (occasionally slightly
negative from sampling skew). The CPU is almost entirely attributable to _long-lived_ processes.
The spawn flood is not hiding in the gap; there is no meaningful gap.

### 2026-08-03 — the sampler perturbed the run it was measuring — **standing rule 4, violated by the person who wrote it**

`sample-host-cpu.ps1` was described in its own commit message as "read-only, ~1 sample/sec".
It was read-only. It was **not cheap**: a per-second `Get-CimInstance` drives `WmiPrvSE`, and
that plus its own PowerShell host made **the instrument the single largest CPU consumer on the
machine** (18.9% avg, 35.4% peak).

Effect on the very metric under study:

| Run               | Host sampler | Stall duty cycle | Worst stall |
| ----------------- | ------------ | ---------------- | ----------- |
| `20260803-003716` | off          | **15.2%**        | 1842 ms     |
| `20260803-115208` | on           | **31.7%**        | 2850 ms     |

The duty cycle **doubled**. Any comparison across those two runs is confounded, and the second
run's 31.7% must NOT be read as a regression in the app. `Config.HostCpu` is now `$false`.

**Rule: cost an instrument before trusting it, and measure the instrument's own footprint in
its first run.** "It only samples once a second" says nothing about what one sample costs --
`Get-CimInstance` is orders of magnitude more expensive than `Get-Process`.

### 2026-08-03 — connection lifetime is a FIXED TIMEOUT, not load — **the breakthrough**

From `renderer.log`, run `20260803-115208` (14 `lost-after-connect` records, t+60s to t+214s):

```
attemptMs: 10220 10233 10235 10254 10269 10282 10299 10495 10511 10615 10655 11233 13671
median 10495 ms   |   86% fall inside 10000-11000 ms
```

**86% of connection lifetimes sit in a one-second band.** Load-driven failure produces variance;
this is a fixed timer firing. Combined with the verified ping watchdog (ping at 5s, latch opens
on the next 5s tick with no pong → ~10s; `RpcClient.ts:1169-1179`, `1091-1102`), the mechanism
is no longer speculative:

**The client's own ping watchdog kills a perfectly live socket because the server did not answer
a Ping within 5s.** `Socket.ts:603` then reports the teardown as a clean 1000.

Why every previous hypothesis missed it:

- It is **client-initiated**, so no amount of server-side close-path reading would find it.
- It needs **no event-loop stall** — this run had zero stalls ≥5000 ms (worst 2850 ms). The
  server answers `Ping` inside the per-client RPC message loop, and bootstrap work is async
  subprocess wait: in-flight, not blocking (standing rule 2). The pong sits behind slow handlers
  while the loop looks healthy.
- The whole investigation instrumented **CPU and event-loop lag** — the two things that cannot
  see this.
- It self-limits: once bootstrap drains, pongs are prompt again and connections survive. That is
  the "all drops inside the first ~162s then stop" pattern, which was read for weeks as evidence
  of _load_ and is really evidence of _bootstrap congestion clearing_.

**Also: the backoff decay masked the symptom without touching the cause.** With
`failureCount=0` and `retryInMs=1000`, each drop now recovers in ~1s instead of 16s, so 14
disconnects were invisible to the user, who reported this startup as having no storm. It had
one. **Do not read "feels better" as "fixed" — check `lost-after-connect` counts.**

**The watchdog is not configurable.** `makeProtocolSocket` accepts only `retryTransientErrors`
and `retryPolicy`; the 5s interval is hard-coded (`Effect.delay("5 seconds")`,
`Schedule.spaced(5000)`). T3 sets `retryPolicy: Schedule.recurs(0)` (`session.ts:158`), so a
single missed pong is fatal with no retry. Changing this means extending the existing
`patches/effect@4.0.0-beta.102.patch`.

**Ping hooks now wired** (`packages/client-runtime/src/rpc/session.ts`, `cce1ec5c9`). `onPing`
stamps the send time, `onPong` reports `pongLatencyMs` (the first pong of each connection as a
baseline, then only those >= 500 ms so a healthy session stays quiet), `onPingTimeout` reports
`waitedMs`. Records reach `renderer.log` through the crash-log bridge with
`source: "connection-ping"`. Diagnostics only; no behaviour change.

Read the next run with:

```
grep -o '"event":"ping-timeout"[^}]*' renderer.log     # did the watchdog fire?
grep -o '"pongLatencyMs":[0-9]*' renderer.log          # how late is the server's Pong?
```

**What each outcome means.** `ping-timeout` records lining up with `lost-after-connect` confirm
the mechanism outright. High `pongLatencyMs` (seconds) while event-loop stalls stay under 3 s
localises the fault to the **server's per-client RPC message loop** rather than CPU. Healthy
`pongLatencyMs` with drops continuing **exonerates the watchdog**, and the 10.5 s timing match
was a coincidence -- worth knowing before anyone patches vendored `effect`.

The fork already has the template for the tolerant fix: `CONNECTION_PROBE_MAX_ATTEMPTS = 4`
exists because a slow-but-alive backend was being treated as dead, and reconnecting only re-ran
bootstrap and made it worse. The ping watchdog needs the same tolerance, but its 5 s interval is
hard-coded in vendored `effect`, so that means extending the patch.

### 2026-08-03 — where a late Pong could come from — **narrowed, NOT measured**

Read from the runtime `dist` copy of `RpcServer.js` (not `src` -- see the patch trap below).

The `Ping` branch does no work at all: `Effect.catchCause(send(client.id, constPong), ...)`. So
the server never "computes" a Pong slowly. A late Pong can therefore only come from:

1. **Queueing ahead of it** -- messages dispatched per client before the Ping is reached. Note
   the `Request` branch runs `schemas.decode(request.payload)` **inline** in the dispatch path,
   before `server.write` hands off to the handler. Decode is in the critical path; handler
   execution is not.
2. **Socket write backpressure** -- `send` cannot get the Pong onto the wire promptly.

**Deliberately not pursued further yet.** Distinguishing these needs the `pongLatencyMs` numbers
from the wired hooks; going deeper into vendored code first would be another unmeasured
hypothesis, which is how this investigation lost a month. If `pongLatencyMs` turns out healthy,
both candidates are moot and the watchdog is exonerated.

### 2026-09-26 — first Claude probe after launch took 36 s; the usage meter vanished meanwhile

Observed on the first launch of the v0.0.43 merge (`5f412a3e6b`, app started 18:24). The fork's
usage meter strip below the composer was missing, then reappeared on its own minutes later.

Evidence from `~/.t3/userdata/logs/server.trace.ndjson.*` (spans, sampled):

```
checkClaudeProviderStatus  durationMs 35777.97   (server.trace.ndjson.3, right after launch)
checkClaudeProviderStatus  durationMs  2732.35   (server.trace.ndjson.1, later)
checkClaudeProviderStatus  durationMs  2989.27   (server.trace.ndjson.7, earlier session)
```

Mechanism, from code not measurement: when the probe cannot read capabilities from the CLI's
initialization result, `ClaudeProvider.ts` publishes the provider with status `warning`
("Could not verify Claude authentication status from initialization result") and **no
`usageLimits` field at all**, and the meter strip hid itself when no provider had limits
(`UsageStatusBar.tsx`, `accounts.length === 0`). The next successful probe restores the field.
The strip now renders a "Waiting for usage data" notice in that state instead of nothing.

Not measured: why that first probe took 36 s (the startup spawn storm is the obvious suspect; a
`Subprocess spawn storm: 60 spawns in 30s` event sits in the same log), and whether it timed
out or returned late without capabilities. Worth a look if startup load comes back on the table.

### 2026-10-19 — reconnect storm mid-session, 51 s stall — **not the merge, not a restart; cause of the 51 s spike open**

User saw "reconnecting" around 14:50 on the 10-19 merge build (`0f33eeeaee`, backend pid 27056
up since 01:01 — **no restart**, single PID). Evidence from
`C:\temp\t3runs\20261019-005837\diagnostics.ndjson` and `~/.t3/userdata/logs/server.trace.ndjson.*`:

- One **51,355 ms** event-loop stall at 14:50:59 (self CPU 22%, system CPU 100%). The 14:00 hour:
  747 stalls, 539 s blocked. Storm began ~13:00; 01:00–12:59 had ≤5 stalls/hour.
- **Not new with the merge.** The previous build (run `20261017-014138`) had the same storms:
  10-18 22:00–00:59 at 356 / 637 / 275 stalls per hour, worst ~3 s. Quiet hours in both builds
  sit at 1–6 stalls/hour. Storm hours coincide with system CPU pinned at 100%.
- A `sqlite` span on the **writer** connection lasted 51,535 ms (14:50:07), `db.lock_wait_ms: 0`,
  under `ws.rpc.orchestration.subscribeThread` (thread `51bf7ebb…`, 194 events). **The query
  itself is cheap**: replayed read-only with the exact `restoredPayloadJson` CASE it takes
  11 ms cold / 3 ms warm, plan `SEARCH … idx_orch_events_stream_sequence`, anchor lookup by
  rowid. So the span's 51 s is the loop being unable to resume it, not SQL cost.
- Upstream's `persistence/Sqlite.ts` (merged in `0f33eeeaee`) now clears `sqlite_stat1` at startup (it is 0 rows now). For this
  query the stat-less plan is fine (above), so **planner regression refuted for this query**.
- ~~328 other spans _ended_ inside the 51 s window, which does not fit a fully blocked loop.~~
  **Refuted the same evening** (see the next entry): those were the web client's `otlp-span`
  records forwarded into `server.trace.ndjson`. Backend-only spans show a true, total block.
- Exonerated: the agent's own read-only diagnostic scans (full-table COUNT(*) on the 8.9 GB DB)
  ran at 13:51, an hour earlier.
- CPU snapshot at 14:53 (5 s): no single hog — MsMpEng 11%, open-task 6.5%, dwm 5.8%, claude
  5.5%, SearchIndexer 4.5%, cargo 3%; T3 backend 1.8%. Matches the 08-03 "box is oversubscribed"
  finding.

### 2026-10-19 evening — the stalls are synchronous main-thread SQLite reads that wait, not compute

Follow-up on the entry above. The 14:50 traces had rotated away by 21:27 (11 × 10 MB ≈ 3 h of
history), so a fresh **13,570 ms** stall at 21:24:35 was analysed instead; copies of its traces
are in `C:\temp\stall-1019\`.

- **The monitor is right; the loop really is blocked.** Backend-only (`type: "effect-span"`)
  completions per second: 72, 129, then **zero from 21:24:22 to 21:24:34**, then 31, 237…
- **Same culprit both times:** a `sqlite` span on the `writer` connection under
  `ws.rpc.orchestration.subscribeThread` starts at the exact millisecond the block begins
  (21:24:21.902) and lasts 13,755 ms, `db.lock_wait_ms: 0.003`. Thread `077beb05…` ("Deploy
  Camera Service to Raspberry Pi", 2,605 events, 5 MB).
- **The query is not slow by itself.** Every `readApplicationRows` variant replayed read-only
  against that thread: `readAgentEvents` by thread 24 ms, with `event_type` 77 ms, from the
  latest sequence 0 ms. Only the `INDEXED BY idx_orchestration_events_application_high_water`
  form with a thread filter is slow (2,971 ms warm), and no thread-scoped caller uses it.
- **It waits rather than computes:** self CPU 26% over the 13.6 s window.
- **Why it blocks the whole server:** `nodeSqliteClient` sends a query to the reader worker only
  inside `readOnly(...)`. In these traces **10,961 queries ran on the main-thread writer and 13 on
  the reader**, so thread-history reads are synchronous on the event loop, and any I/O wait inside
  them freezes every client.
- Disk is a Samsung 970 EVO Plus NVMe; at 21:3x it showed ~0 ms latency and 88% idle, so it is
  not saturated in steady state.
- Only pid 27056 has `statev2.sqlite` open (`handle.exe`), so no other process holds a lock.
- **Defender real-time scanning of the database: weakened, not refuted.** `~/.t3` is **not** in
  `ExclusionPath` (`~/git` and many build dirs are). A 3-minute `New-MpPerformanceRecording`
  (21:33:51–21:36:51, `C:\temp\stall-1019\defender.etl`) shows **zero scans** of
  `statev2.sqlite*`. Defender scans on open and on close-after-write, and the backend holds the
  database open, so reads do not trigger scans. T3's log files were scanned (6.9 s in total, max
  88 ms per scan: `server.trace.ndjson`, provider `events.*.log`, terminal logs). Caveat: no big
  stall happened in that window (5 stalls, worst 496 ms).
- **Capture in place for the next big stall.** `C:\temp\stall-1019\capture-on-stall.ps1` (pid 3888
  from 21:45, launched via WMI, elevated) keeps a `wpr -start CPU` ring buffer and saves it to
  `C:\temp\stall-1019\stall-*.etl` when `diagnostics.ndjson` logs a stall of 5 s or more (at most
  3 captures, 24 h). Analyse the backend's main-thread context-switch stacks (pid 27056) across
  the stall window: a blocking `NtReadFile`, `NtLockFile`, `NtFlushBuffersFile` or plain Ready
  (CPU starvation) each points to a different fix. Sizing: CPU-only is about 620 MB per save and
  takes about 2 min to write; adding `FileIO` and `DiskIO` produced 2 GB per 10 s on this machine.

## Unverified suspects (not yet tested)

- **HTTP response compression on the WebSocket route.** Upstream's merge added
  `httpCompressionLayer`, provided to a layer group that includes `websocketRpcRouteLayer`
  (`apps/server/src/server.ts:423,430`). Plausible, untested.
- **Whether the ~10s connection lifetime predates the upstream merges** (2026-07-30,
  `48a6ff172` / `6c9cd838a`). Client instrumentation only exists from 07-31, so the logs cannot
  answer it. A build from a pre-merge commit would.

## Instrumentation traps that have cost real time

Every one of these produced a confident wrong answer:

- **`server.trace.ndjson` also holds the web client's spans.** Records with `"type":"otlp-span"`
  and `service.name: "t3code-web"` are the renderer's, forwarded to the server. Counting them as
  backend work made a fully blocked event loop look alive (2026-10-19). Filter on
  `"type":"effect-span"` for the backend. The files also rotate in ~3 h under load: copy them out
  before analysing an event.

- **In a pnpm-patched package, `src/` is NOT what runs -- `dist/` is.** The `effect` patch
  applies to `dist/` only; `src/` inside `node_modules/.pnpm/effect@4.0.0-beta.102_patch_*/` is
  the **unpatched** upstream source. Verifying runtime behaviour against `src/` reads code that
  never executes. This produced a confident "the ping hooks do not exist" conclusion when they
  do -- both `dist/*.js` and `dist/*.d.ts` have them. For anything patched, check `dist/`.
- **Git Bash mangles `ref:path` arguments.** `git cat-file -e "upstream/main:$f"` became
  `upstream\main;...` and reported a tracked file as missing. Use `git ls-tree` to check
  existence.
- **`grep -c "A\|B"` alternation** matched an unrelated `Semaphore.make(1)` and produced a
  false "upstream already has this fix" claim.
- **Sorting records by `msSinceLoad` across sessions** interleaves them — it resets per page
  load. Sort by wall-clock timestamp, or filter to one session.
- **A `@effect-diagnostics` directive that suppresses nothing is itself a warning** (TS377000)
  and fails typecheck.
- **`Effect.async` does not exist in Effect 4** — it is `Effect.callback`. Using the wrong name
  types the result `unknown`, which poisons the requirements channel of every downstream layer
  and surfaces as ~60 errors _in another file_. Bisect by disabling the new layer.
- **A commit containing only `.ps1` files fails the pre-commit hook.** `vp fmt` gets no
  formattable target and exits 1 with "Expected at least one target file. All matched files may
  have been excluded by ignore rules." — which then reverts the staged state. Commit launcher
  and script changes together with a markdown or TS file.
- **The pre-commit hook (`vp staged` → `vp fmt`) OOMs on a large upstream merge.** It passes
  staged paths explicitly, bypassing `fmt.ignorePatterns`, so it tries to format ~12k vendored
  `.repos` files it is configured to skip. Killing it mid-run destroys the merge.

## Standing rules for this investigation

1. **Measure before fixing.** Every blind fix here has been reverted or refuted.
2. **In-flight is not blocking.** A `runGitCommand` span is mostly async subprocess wait; only
   synchronous work stalls the loop.
3. **Correlation at a high duty cycle is not evidence.** State the base rate before claiming a
   link.
4. **Turn heavyweight instrumentation back off when done.** CPU profiling perturbs the exact
   startup window under measurement.
