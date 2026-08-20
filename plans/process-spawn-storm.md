# The subprocess spawn storm behind "Some requests are slow"

## Goal

Find and fix the feedback loop that makes T3 Code periodically saturate the machine and
raise the **"Some requests are slow"** toast, climbing to ~256 tracked requests and repeating.
The user cannot reproduce it on command, so **instrumentation that survives to the next storm
is as important as the fix itself.**

## Environment / context

- Windows 11 Pro N (10.0.26200), 6 physical cores / 12 threads.
- Repo `C:\Users\camer\git\t3code`, branch `master`, fork `cinderblock/t3code`.
- The app under observation was the **dev build from this repo**
  (`node_modules/.pnpm/electron@41.5.0/...`), started 2026-08-19 17:02, running the
  server bundle `apps/server/dist/bin.mjs` built 2026-08-13.
  It writes to `~/.t3/userdata/logs/`, NOT `~/.t3/dev/logs/` (those are stale, from June).
- Server process during the capture: `electron.exe` PID 34988 (utility/server child of 44036).
- Effect 4.0.0-beta.103 (patched); process spawning via
  `@effect/platform-node-shared` `NodeChildProcessSpawner` (pulled in by `NodeServices.layer`).

## Measurements (2026-08-20 ~02:18-02:24 PDT)

Process churn, sampled by polling `Win32_Process` every 700 ms for 75 s:

| image        | spawns in 75 s               |
| ------------ | ---------------------------- |
| conhost.exe  | 280                          |
| cmd.exe      | 168                          |
| git.exe      | 162                          |
| taskkill.exe | 104                          |
| **total**    | **750 spawned / 754 exited** |

- **277 of those were spawned directly by the server process (PID 34988)** — ~3.7/sec sustained.
- The machine was **not CPU-bound**: a 5 s sample put total CPU well under 20% of 12 threads.
  The sluggishness is process-creation and event-loop pressure, not compute.
- 46-90 helper processes were alive at any instant, sustained across repeated samples.

Effect trace profile over a 146 s window (`scripts/span-profile.py`):

| span                                         | n    | rate   | avg ms | p50     | p95     | max   |
| -------------------------------------------- | ---- | ------ | ------ | ------- | ------- | ----- |
| `sql.execute`                                | 1746 | 11.9/s | 106.2  | **0.2** | **646** | 3038  |
| `processRunner.collectText`                  | 1272 | 8.7/s  | 837    | 702     | 1903    | 3049  |
| `WorkspacePaths.statWorkspaceRoot`           | 975  | 6.7/s  | 132    | 72      | 486     | 1561  |
| `processRunner.runProcessCore`               | 637  | 4.4/s  | 929    | 796     | 1989    | 3216  |
| `RepositoryIdentityResolver.resolveCacheKey` | 551  | 3.8/s  | 1509   | 1059    | 4013    | 10381 |
| `RepositoryIdentityResolver.resolve`         | 551  | 3.8/s  | 1769   | 1278    | 4660    | 12923 |
| `ws.rpc.assets.createUrl`                    | 504  | 3.4/s  | 3634   | 3380    | 6969    | 13624 |

## Findings

### 1. Event-loop starvation is the proximate symptom (certain)

`sql.execute` has **p50 0.2 ms but p95 646 ms — a 3268x ratio**; `sql.transaction` 0.4 ms to 1336 ms.
An in-process SQLite query that is normally instant does not become 646 ms because SQLite got
slow. It becomes 646 ms because the Node event loop is buried. Everything queues behind
subprocess plumbing, so latency inflates uniformly across unrelated operations. That is what
pushes RPC round-trips past the client's 15 s threshold.

### 2. `RepositoryIdentityResolver` spawns a subprocess to compute its own cache key (certain)

`apps/server/src/project/RepositoryIdentityResolver.ts` — `resolve(cwd)` does:

1. `resolveRepositoryIdentityCacheKey(cwd)` spawns `git rev-parse --show-toplevel`,
   **uncached, on every single call**
2. `Cache.get(repositoryIdentityCache, cacheKey)` — this part _is_ cached (1 min TTL)

The Effect `Cache` protects step 2 (`git remote -v`) but step 1 pays a full process spawn on
every lookup. **The cache is defeated by its own key computation.**

At 551 calls/146 s that is **86% of all 637 subprocess spawns the server made** in the window.

Caller: `ProjectionSnapshotQuery.resolveRepositoryIdentitiesForProjects`
(`apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts:352`) resolves identity for
every unique workspace root on every projection snapshot, at concurrency 4. With ~14 projects
that is 14 git spawns per snapshot, and snapshots land roughly every 3.7 s.

### 3. Effect taskkills already-dead processes on Windows, twice, for any non-zero exit (certain)

`@effect/platform-node-shared/dist/NodeChildProcessSpawner.js` (verified in the **installed dist**,
not just the reference checkout at `.repos/effect-smol`):

```js
childProcess.on("exit", code => {
  if (code !== 0 && Predicate.isNotNull(code)) {
    killProcessGroupOnExit(childProcess, ...);   // line 365-369
  }
});
```

and the `acquireRelease` finalizer does it **again** for the same condition:

```js
if (exited) {
  const [code] = yield * Deferred.await(exitSignal);
  if (code !== 0 && Predicate.isNotNull(code)) {
    return yield * Effect.ignore(killWithTimeout(killProcessGroup));
  }
}
```

`killProcessGroup` on Windows is:

```js
NodeChildProcess.exec(`taskkill /pid ${childProcess.pid} /T /F`, ...)
```

`NodeChildProcess.exec` runs through `cmd.exe /s /c`, so **one kill costs 4 processes**
(cmd.exe + its conhost + taskkill.exe + its conhost). Two kills per non-zero exit means
**~8 processes to "clean up" a process that already exited on its own.**

This is unrelated to timeouts. It fires on _ordinary, expected_ non-zero exits — and
`resolveRepositoryIdentityCacheKey` explicitly handles `code !== 0` as a normal outcome
(a workspace root that is not a git repo returns 128).

That matches the observed image mix: 104 taskkill + 168 cmd + 280 conhost against 162 git.

### 4. Why it is a _storm_ and not just overhead

Positive feedback: git spawns cause the event loop to saturate, git commands then take longer
and more of them fail or time out, producing more non-zero exits, producing more
double-taskkill cleanups at 8 processes each, producing more process-creation pressure. It is
self-reinforcing, which is why it comes on suddenly and stays bad, exactly as reported.

### 5. The 256 is a display cap, not a real ceiling

`MAX_TRACKED_RPC_ACK_REQUESTS = 256` in `apps/web/src/rpc/requestLatencyState.ts`. The toast
stops _counting_ at 256; the actual backlog may be larger. So "it gets to ~256 and repeats" is
the counter saturating, not a queue limit being hit.

### 6. Fork vs upstream — this is upstream's bug

Verified with `git diff HEAD upstream/main -- <file>` against upstream tip `beab6886f`
(2026-08-20):

- `apps/server/src/project/RepositoryIdentityResolver.ts` — **IDENTICAL to upstream tip.**
  Upstream has touched this file exactly once ever (`b0a3a5044`, a refactor). Never fixed.
- `apps/server/src/processRunner.ts` — **IDENTICAL to upstream tip.**
- `apps/server/src/vcs/VcsProcess.ts`, `apps/server/src/stream/collectUint8StreamText.ts` — identical.
- The taskkill behaviour is in the `@effect/platform-node-shared` dependency, upstream of
  t3code entirely.

Our fork's only delta in this area is `GitVcsDriver.ts` (+22/-1), which is a _prior_
symptom-level patch from this same investigation: catching `isInsideWorkTree` timeouts so they
don't crash status refresh under load.

### 7. Prior favicon fix is working — the cost moved

`401da737f` (cache project favicon resolution) is in HEAD and in the running bundle.
`ProjectFaviconResolver.resolvePath` is now a cheap cache hit (avg 146 ms, p50 78 ms) and
`walkForFavicon` never appears in the trace. `assets.createUrl` is still slow (avg 3.6 s) but
its own children only account for ~1.6 s of that — the rest is queueing, i.e. finding 1, not
favicon work. Do not re-diagnose favicons.

## Things not to do

- Don't blame the favicon resolver again — measured, it is fixed (finding 7).
- Don't blame CPU load — the box is not CPU-bound (see measurements).
- Don't try to read `taskkill` command lines by polling `Win32_Process`; the processes are too
  short-lived and WMI does not populate `CommandLine` in time. Two attempts returned zero rows
  while the churn counter simultaneously showed 104 taskkills. Infer the kill source from the
  parent chain and the Effect source instead, or use ETW if command lines are truly needed.
- Don't assume `~/.t3/dev/logs/` is live — for this app it is stale; the running dev build logs
  to `~/.t3/userdata/logs/`.

## Progress log

- [x] Rule out CPU saturation
- [x] Measure process churn and attribute it to the server process
- [x] Profile the Effect trace; identify event-loop starvation signature
- [x] Find the uncached cache-key spawn in `RepositoryIdentityResolver`
- [x] Find the Windows double-taskkill on non-zero exit in Effect's spawner
- [x] Confirm both are upstream, not fork regressions
- [x] Explain the 256
- [x] Add `scripts/span-profile.py`
- [x] Add spawn instrumentation that survives to the next storm —
      `apps/server/src/processSpawnObserver.ts`, wired into `ProcessRunner`
- [x] Fix the cache-key spawn — root lookup now cached in `RepositoryIdentityResolver`
- [ ] **Restart the app on a rebuilt bundle** so both land (the running server is the
      2026-08-13 build; nothing here takes effect until it restarts)
- [ ] Verify against a live storm

## What was changed

### Instrumentation: `apps/server/src/processSpawnObserver.ts`

Records every subprocess that goes through `ProcessRunner` — command, subcommand, cwd,
duration, exit code, outcome. When the trailing 30 s window sustains >= 2 spawns/sec (idle is
far below that; the storm measured ~4.4/sec) it emits one `logWarning` with structured
annotations, rate-limited to one report per 60 s so it cannot become its own noise source.

The report carries what this investigation had to reconstruct by hand: spawn rate, non-zero
exit count, timeouts, the estimated Windows `taskkill` amplification, the top commands by
count with average durations, and the busiest working directories. That should make the next
storm diagnosable from `server.log` alone, without needing to catch it live with a process
sampler.

Design notes worth keeping:

- The store is **module-level, not layer-scoped**, on purpose. Roughly seven layers
  (`VcsProcess`, `TerminalManager`, `ServerEnvironment`, `PortScanner`,
  `RepositoryIdentityResolver`, `selfUpdate`, `cli/service`) each build their own
  `ProcessRunner`. Layer-scoped state would fragment the measurement into partial views, and
  what is being measured — how fast this OS process creates children — is process-global.
- `ProcessRunner` looks the observer up with `Effect.serviceOption` and **defaults to the live
  one**, so no server wiring is required and a spawn cannot go unrecorded because of how some
  layer happened to be assembled. Tests can still inject `ProcessSpawnObserver.noop`.
- `pickSubcommand` skips `-C <path>` and `-c key=value` runs, because the VCS layer prefixes
  nearly every git call with those and grouping on `args[0]` would just report `-C`.

### Fix: cache the work-tree root in `RepositoryIdentityResolver`

`resolveRepositoryRoot` (was `resolveRepositoryIdentityCacheKey`) now returns `null` instead
of falling back to `cwd`, and sits behind its own `Cache` with the same capacity and TTL
policy as the identity cache. `resolve` maps `null` back to `cwd`, preserving the previous
behaviour for non-repository directories.

Returning `null` rather than the `cwd` fallback matters: under load this is the first git call
to time out, and caching the fallback as though it were a confirmed root would pin a wrong
identity for the full _positive_ TTL. `null` takes the negative TTL instead.

Guarded by a regression test that counts subprocesses: five `resolve` calls against one
directory must cost exactly one `rev-parse` and one `remote`. **Verified it fails without the
fix** — reverting to per-call resolution gives `expected 5 to be 1`.

### `scripts/span-profile.py`

Aggregates trace NDJSON by span name (rate, avg/p50/p95/max, total wall time) and flags spans
whose p95/p50 ratio indicates queueing rather than slow work. Complements `slow-spans.py`,
which lists individual slow spans.

## Still open — the dependency bug is not fixed

Finding 3 (Effect's double `taskkill` on non-zero exit, through `cmd.exe`) is **untouched**.
The fix above removes ~86% of the spawns that feed it, which should keep the feedback loop
from igniting, but the amplifier is still armed for any other command that exits non-zero.
Options, in increasing order of intrusiveness:

1. Report upstream to Effect. The fix there is small and obvious: don't kill a process that
   already exited, and use `execFile("taskkill", [...])` instead of `exec` so the kill doesn't
   route through `cmd.exe` (that alone halves the process cost of each kill).
2. Add a `patches/@effect__platform-node-shared@*.patch` locally — the repo already patches 15
   packages, so the mechanism is established.

Recommendation: do (1) first since it is upstream's bug and a clean report, and only reach for
(2) if storms recur after the resolver fix ships.

## Open questions for the user

1. Report finding 3 (double-taskkill on non-zero exit) upstream to Effect, and finding 2 to
   pingdotgg/t3code? Both are clean, self-contained reproductions. Recommendation: yes for
   Effect — it is a pure dependency bug with an obvious fix (don't kill a process that already
   exited; and use `execFile` instead of `exec` to skip cmd.exe).
