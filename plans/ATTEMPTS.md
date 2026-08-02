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

| Hypothesis                                                                                  | How it was killed                                                                                                                                                                   | Date       |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Health-probe timeouts cause the drops (the original theory for months)                      | **Zero `health-check-slow` records, ever.** The probe path is healthy.                                                                                                              | 2026-07-31 |
| `navigator.onLine` flapping tears down the socket                                           | **`network-changed: 0`** — connectivity never reported offline                                                                                                                      | 2026-08-02 |
| Backend crashes / is killed and restarted                                                   | Single PID across a whole storm, **zero** `sinceStartupMs` regressions                                                                                                              | 2026-08-02 |
| Auth credential rejection closes connections                                                | Zero rejections in the trace during a storm                                                                                                                                         | 2026-08-02 |
| The 3.3 GB database is the bottleneck                                                       | Real query shapes measured at **0.16–15 ms**, all indexed                                                                                                                           | 2026-07-27 |
| Synchronous PATH walk in `resolveSpawnExecutableWithNode` (long-held "most likely culprit") | Full 77-entry PATH walk = **27.7 ms**, zero slow entries                                                                                                                            | 2026-07-27 |
| Expensive spawns (antivirus etc.)                                                           | Measured **9.2 ms/spawn**, normal for Windows. It is spawn **count**, not cost.                                                                                                     | 2026-07-28 |
| Stalls directly cause the socket closes                                                     | Worst pre-close stall **1.7 s**, far below any timeout. With stalls at a 29% duty cycle, finding one before any close is **expected by chance** — this correlation is NOT evidence. | 2026-08-02 |
| `application-active-reconnect` wakeup replaces the lease                                    | **Mobile-only**; never fires on desktop                                                                                                                                             | 2026-08-02 |

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

### 2026-08-02 — why the UI stays unusable through a storm — **mechanism identified, not yet fixed**

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

Proposed but **not applied** (connection behaviour needs sign-off): decay the ladder on each
successful _establishment_ rather than all-or-nothing on 30 s of uptime, so repeated 10 s
connections walk the delay back down instead of pinning at max.

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
