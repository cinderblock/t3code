# Upstream reports — ready to paste

Drafts for the four places the spawn-storm work should land. Evidence and prior art are in
[`process-spawn-storm.md`](./process-spawn-storm.md). Nothing here has been posted.

Fork branch carrying the fixes: `https://github.com/cinderblock/t3code/tree/master`
Commits: `49e26ab64` (fix + instrumentation), `2aea7c04a` (investigation notes).

---

## 1. Comment on pingdotgg/t3code#2037 — asking to reopen

> Requesting reopen, as invited in the closing comment.
>
> The close said the analysed path was rewritten and that "the narrow cache proposal also no
> longer represents the current bottleneck". The first half is right — `replayEvents` no longer
> follows the synchronous per-event path. But the defect in section 4 of this issue,
> `resolveRepositoryIdentityCacheKey` being uncached, survived the rewrite. It just moved
> callers, and it is now the single largest source of subprocess churn in the server.
>
> `resolve()` still runs `git rev-parse --show-toplevel` to compute the key for its own
> `Cache`, so every cached lookup is still paid for with a process spawn. The current caller is
> `ProjectionSnapshotQuery.resolveRepositoryIdentitiesForProjects`, which resolves identity for
> every unique workspace root on every projection snapshot at concurrency 4.
>
> Measured on t3code desktop, Windows 11, ~14 projects, over a 146 s window of
> `server.trace.ndjson`:
>
> | span                                         | n   | rate  | avg ms | p50  | p95  | max   |
> | -------------------------------------------- | --- | ----- | ------ | ---- | ---- | ----- |
> | `RepositoryIdentityResolver.resolveCacheKey` | 551 | 3.8/s | 1509   | 1059 | 4013 | 10381 |
> | `RepositoryIdentityResolver.resolve`         | 551 | 3.8/s | 1769   | 1278 | 4660 | 12923 |
> | `processRunner.runProcessCore` (all spawns)  | 637 | 4.4/s | 929    | 796  | 1989 | 3216  |
>
> 551 of 637 spawns — **86% of every subprocess the server created** — were this one uncached
> key lookup.
>
> The consequence is event-loop starvation rather than CPU load. The machine was well under
> 20% CPU across 12 threads, but in the same window `sql.execute` measured **p50 0.2 ms against
> p95 646 ms**, a 3268x spread, and `sql.transaction` 0.4 ms against 1336 ms. An in-process
> SQLite query does not get 3000x slower because SQLite is slow; it queues behind subprocess
> plumbing. That is what pushes tracked RPCs past `SLOW_RPC_ACK_THRESHOLD_MS` and produces the
> "Some requests are slow" toast this issue was originally about. (The toast counting to ~256
> is `MAX_TRACKED_RPC_ACK_REQUESTS`, so the real backlog can be larger than it displays.)
>
> On Windows there is a second-order cost. `git rev-parse` in a directory that is not a
> repository exits 128, and `@effect/platform-node-shared` responds to any non-zero child exit
> by running `taskkill` — see #2537. So the uncached lookup also drives that path.
>
> Suggested Fix 1 in the original report is still the right fix. Implemented and running here:
> [`cinderblock/t3code@49e26ab6`](https://github.com/cinderblock/t3code/commit/49e26ab64).
> It caches the root behind the same capacity and TTL policy as the identity cache, and returns
> `null` instead of falling back to `cwd` so an indeterminate answer takes the _negative_ TTL —
> under load this git call is the first to time out, and caching its fallback as a confirmed
> root would pin a wrong identity for the full positive TTL.
>
> Guarded by a test that counts subprocesses: five `resolve()` calls against one directory must
> cost exactly one `rev-parse` and one `remote`. It fails without the fix with
> `expected 5 to be 1`.
>
> Happy to open a PR if you would rather have one than a reopened issue.

---

## 2. Comment on pingdotgg/t3code#2537 — the version pin, plus the perf angle

> Two things to add, both verified today.
>
> **The upstream fix is published.** Effect-TS/effect#7154 merged 2026-08-09 and ships in
> `@effect/platform-node-shared@4.0.0-beta.107` (published 2026-08-10). Confirmed by unpacking
> the tarball — `dist/NodeChildProcessSpawner.js` now has
> `NodeChildProcess.execFile("taskkill", ["/pid", ..., "/T", "/F"], { windowsHide: true })`.
> `pnpm-workspace.yaml` pins the `@effect/*` catalog to `4.0.0-beta.103` (2026-08-04), so this
> repo is four betas short of it, as noted above.
>
> **It is not only cosmetic.** Sampling `Win32_Process` every 700 ms for 75 s on an otherwise
> idle desktop session, the server process spawned 277 processes and the machine saw 750:
>
> | image        | spawns in 75 s |
> | ------------ | -------------- |
> | conhost.exe  | 280            |
> | cmd.exe      | 168            |
> | git.exe      | 162            |
> | taskkill.exe | 104            |
>
> CPU stayed under 20% of 12 threads, but `sql.execute` in the server measured p50 0.2 ms
> against p95 646 ms in the same period. The flashing windows and the "Some requests are slow"
> toast are the same phenomenon seen from two ends — process-creation pressure starving the
> Node event loop. Worth noting for prioritising the catalog bump.
>
> **One part of this is not fixed by #7154.** For a non-zero exit the kill fires on a process
> that has _already exited_, and it fires twice — once from the `on("exit")` listener and again
> from the `acquireRelease` finalizer's `if (exited)` branch. Both are still present at #7154's
> merge commit and in beta.107. After the bump that is 2 stray `taskkill` processes per
> non-zero-exit command rather than 8, but it is still avoidable. Filing that separately
> upstream; linking back here once it exists.
>
> Relevant to this repo because non-zero exits are routine on these paths, not exceptional —
> `git rev-parse --show-toplevel` returns 128 for any non-repository directory, and
> `RepositoryIdentityResolver` treats that as a normal outcome (#2037).

---

## 3. New issue — Effect-TS/effect

**Title:** `NodeChildProcessSpawner taskkills already-exited processes on Windows, twice, for any non-zero exit`

> ## What happens
>
> On Windows, a child process that exits on its own with a non-zero code still gets
> `taskkill /pid <pid> /T /F` run against it — twice.
>
> In `packages/platform-node-shared/src/NodeChildProcessSpawner.ts`:
>
> ```ts
> childProcess.on("exit", (code) => {
>   if (code !== 0 && Predicate.isNotNull(code)) {
>     killProcessGroupOnExit(childProcess, cmd.options.killSignal ?? "SIGTERM");
>   }
> });
> ```
>
> and again in the `acquireRelease` release function:
>
> ```ts
> const exited = yield* Deferred.isDone(exitSignal)
> if (exited) {
>   const [code] = yield* Deferred.await(exitSignal)
>   if (code !== 0 && Predicate.isNotNull(code)) {
>     return yield* Effect.ignore(killWithTimeout(killProcessGroup))
>   }
>   ...
> }
> ```
>
> Both branches are reached only when the process has already exited, so the PID is gone. The
> `/T` flag suggests the intent is orphaned grandchildren, but the trigger is the _parent's exit
> code_, which does not indicate whether any children were left behind — and the same reasoning
> would apply to a zero exit, which is not treated this way.
>
> ## Why it matters
>
> A non-zero exit is an ordinary outcome for probing commands, not an error path.
> `git rev-parse --show-toplevel` exits 128 in any non-repository directory; `git remote -v`, `gh`, and version
> probes behave similarly. Each such call therefore spawns extra processes on Windows, where
> process creation is expensive.
>
> Measured in a downstream app (pingdotgg/t3code, which polls git across ~14 project
> directories): 104 `taskkill.exe` in a 75 s window against 162 `git.exe`, on an idle session.
> The load was not CPU-bound but it starved the Node event loop — an in-process SQLite query in
> the same period measured p50 0.2 ms against p95 646 ms.
>
> ## Relationship to #7154
>
> #7154 fixed the per-kill cost (`exec` through `cmd.exe` to `execFile` plus `windowsHide`), so
> each kill is now 1 process instead of 4. This issue is about the kills happening at all. Both
> call sites above are unchanged at #7154's merge commit
> (`e74c302afe0368e5d3f15d18c10fc54cf33f9003`) and in the published `4.0.0-beta.107`. After
> #7154 the cost is 2 stray processes per non-zero-exit command instead of 8.
>
> ## Suggested fix
>
> Skip the process-group kill when the child has already exited, or gate it on actually having
> spawned a group worth cleaning (`detached`), rather than on the exit code. At minimum, do not
> run it twice for the same condition — the `on("exit")` listener and the release finalizer
> currently duplicate each other.
>
> Happy to open a PR if the direction is agreed.

---

## 4. PR description — pingdotgg/t3code (only if #2037 gets reopened / invited)

**Title:** `fix(server): stop resolving a repo's work-tree root on every identity lookup`

Keep it to the single resolver file plus its test — CONTRIBUTING is explicit that small and
focused is what gets accepted, and that unrelated fixes should not be mixed in.

> Fixes the defect described in #2037 section 4, which survived the rewrite that closed that
> issue.
>
> `RepositoryIdentityResolver.resolve` runs `git rev-parse --show-toplevel` to compute the key
> for its own `Cache`, so every cached lookup still costs a subprocess spawn. With
> `ProjectionSnapshotQuery.resolveRepositoryIdentitiesForProjects` resolving every project's
> workspace root on each projection snapshot, that measured at 551 spawns in 146 s — 86% of all
> subprocesses the server created in the window — and starved the event loop
> (`sql.execute` p50 0.2 ms vs p95 646 ms).
>
> Caches the root lookup behind the same capacity and TTL policy as the identity cache. It
> returns `null` rather than falling back to `cwd` so an indeterminate answer takes the negative
> TTL; under load this git call is the first to time out, and caching its fallback as a
> confirmed root would pin a wrong identity for the full positive TTL.
>
> Test counts subprocesses: five `resolve()` calls against one directory cost exactly one
> `rev-parse` and one `remote`. Reverting the fix fails it with `expected 5 to be 1`.
>
> No UI change, so no before/after images apply.

### Do NOT include in that PR

- `processSpawnObserver.ts` — useful to us, but it is new infrastructure rather than a small
  bug fix, and mixing it in is exactly what CONTRIBUTING warns against. Offer it separately
  after the small fix lands, if there is appetite.
- `scripts/span-profile.py`, the `plans/` docs, and the `GitVcsDriver` timeout patch.
