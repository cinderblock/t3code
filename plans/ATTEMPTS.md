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

The exact close mechanism is **still unidentified**. Chasing it directly has cost many
restarts for no result. The lever with evidence behind it is the startup load.

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

## Unverified suspects (not yet tested)

- **HTTP response compression on the WebSocket route.** Upstream's merge added
  `httpCompressionLayer`, provided to a layer group that includes `websocketRpcRouteLayer`
  (`apps/server/src/server.ts:423,430`). Plausible, untested.
- **Whether the ~10s connection lifetime predates the upstream merges** (2026-07-30,
  `48a6ff172` / `6c9cd838a`). Client instrumentation only exists from 07-31, so the logs cannot
  answer it. A build from a pre-merge commit would.

## Instrumentation traps that have cost real time

Every one of these produced a confident wrong answer:

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
