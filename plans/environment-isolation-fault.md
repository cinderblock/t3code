# One unreachable environment blanks the whole UI (2026-08-21)

## Goal

User report: working **only** in the local environment (Noook), but new threads hang, and
switching away loses a new thread and its typed prompt. A stale remote environment
(BlackHole, running an old version) is present in the catalog but unused.

User's framing, which turned out to be exactly right: _"BlackHole running an old version
should not affect us. This is a design fault."_

Companion investigation by a peer session: [`lost-messages-investigation.md`](./lost-messages-investigation.md)
— that one covers the socket/ping-timeout side. This one covers the UI gate.

## The fault

`apps/web/src/state/shell.ts` — `allEnvironmentShellsBootstrappedAtom` (**identical to
upstream**; not a fork regression):

```ts
for (const environmentId of catalog.value.entries.keys()) {
  if (Option.isSome(get(environmentShell.stateValueAtom(environmentId)).snapshot)) continue;
  const connection = ...;
  if (connectionProjectionPhase(connection) !== "disconnected") return false;
  if (connection.phase === "backoff" && connection.desired && connection.attempt <= 2) return false;
}
return true;
```

Every catalogued environment must _either_ have produced a shell snapshot _or_ be in a
`disconnected` projection phase. Per `connection/model.ts`, `connectionProjectionPhase` maps
`connecting → "synchronizing"` and `connected → "ready"`, and only
`available | offline | backoff | blocked → "disconnected"`.

So an environment that **answers the socket but never delivers a shell snapshot** is neither
disconnected nor bootstrapped, and pins the atom to `false` **with no time bound and no
attempt bound**. An outdated or wedged backend is precisely that shape.

The consumer that hurts, `apps/web/src/routes/_chat.index.tsx` (`IndexDraftLanding`):

```ts
const bootstrapped = useAllEnvironmentShellsBootstrapped();
const mostRecentProject = useMemo(
  () => (bootstrapped ? sortScopedProjectsForSidebar(...)[0] ?? null : null), ...);
useEffect(() => { if (mostRecentProject === null || startingRef.current) return; ... handleNewThread(...) }, ...);
if (!bootstrapped) {
  return null;      // <- blank screen
}
```

Two consequences while the gate is false:

1. The landing renders `null` — a blank screen.
2. `mostRecentProject` is forced to `null`, so the effect that opens a **draft thread never
   fires**. That is "new threads seem to hang".

A typed prompt in a draft that was never created server-side is client-only state, so
navigating away discards it — "switching loses the new thread and its prompt".

`apps/web/src/routes/_chat.pull-requests.tsx:174` gates its empty state on the same atom, so
it shows "no projects" logic driven by an unrelated environment.

**A healthy local backend cannot rescue any of this.** The gate is conjunctive across all
environments, so the worst environment decides.

## Why the gate exists (don't just delete it)

It is not gratuitous. Rendering the landing before projects load makes
`sortScopedProjectsForSidebar(...)[0]` pick the wrong "most recent" project and navigate the
reader somewhere they did not ask for. The wait is right; the _unbounded, conjunctive_ wait is
the bug.

## The fix

`apps/web/src/hooks/useEnvironmentsSettled.ts` — bound the wait.

`shouldWaitForEnvironments({ bootstrapped, elapsedMs, graceMs })` keeps the strict signal as
the preferred fast path (the common case, preserving the anti-flash behaviour), but stops
waiting after `ENVIRONMENT_SETTLE_GRACE_MS` (2.5 s). Past the deadline the UI renders with
whatever environments reported — which is the honest answer, since a down environment
contributes no projects however long you wait.

2.5 s is comfortably longer than a healthy local shell snapshot and short enough that a wedged
environment is a pause, not a dead screen.

Both consumers now use it: `_chat.index.tsx` and `_chat.pull-requests.tsx`.

Pure decision function is extracted and tested, matching the `useLiveRefresh` pattern in this
repo (hook tests here test extracted logic; `@testing-library/react` is **not** a dependency of
`apps/web`, and `vite-plus/test` is the test import, not `vitest`).

## Checked and ruled out

- **Other cross-environment loops** (`state/presentation.ts:53`, `state/projectEntities.ts:74`,
  `state/shell.ts:338,379`, `state/threadShell.ts:152`) are _aggregations_, not boolean gates —
  a missing environment yields fewer items and degrades gracefully. This was the only
  conjunctive gate.
- **Multi-window** — not implicated; `multi-window-support.md` has every phase unchecked, so
  the feature does not ship. "Switching windows" is a focus/visibility rehydrate.
- **The connection registry** — `leaseLocks` are per-environment, each with its own semaphore;
  the global `leaseLocksGuard` is held only for map mutation. Properly isolated.
- **Thread state** — `EnvironmentThreadState` is scoped per environment via
  `followStreamInEnvironment`. Isolated.
- **The spawn-storm fix and instrumentation from `process-spawn-storm.md`** — not implicated.
  The storm warning never fired, there are no resolver or projection errors, and today's
  socket closes are 31 BlackHole / **0 Noook**.

## What this does NOT fix

Be honest about the third symptom. _"I send a message, usage goes up, but the response doesn't
make it back"_ is **not** explained by this gate, and no evidence was found tying it to
BlackHole for a Noook thread. Candidates, unproven:

- The `afterSequence` resume may not replay activity missed across a drop (peer plan's open
  question 2). There is **no instrumentation for whether resume heals**, so the logs cannot
  currently distinguish "hiccup" from "data loss". That gap is worth closing next.
- A draft thread that was never created server-side (the bug fixed here) would also lose its
  reply, so some fraction of this symptom may resolve with this fix. Unverified.

## Status

- [x] Locate the gate and prove it is upstream, not fork
- [x] Bound the wait; both consumers migrated
- [x] Pure-logic test, typecheck, lint, format
- [ ] **Rebuild and restart the app** — nothing takes effect until then
- [ ] Confirm with the user whether "response never arrives" survives the fix
- [ ] If it survives: add resume instrumentation before guessing further

## 2026-08-21 14:00 — it came back after ~20 minutes, and the gate was not the whole story

The gate fix held on first load, then threads started going missing again. Ruled out, with
evidence, in this order:

| layer        | evidence                                                                          | verdict             |
| ------------ | --------------------------------------------------------------------------------- | ------------------- |
| Server       | 2 failed spans (`readFile`) out of **10,194** since restart                       | healthy             |
| Data         | 7 threads updated in the last 20 min; none deleted, archived, settled, or snoozed | healthy             |
| Local socket | **zero** ping-timeouts and zero closes on Noook since the 13:25 restart           | healthy             |
| Remote       | all 31 closes today are BlackHole, on its 30.8 min metronome                      | irrelevant to Noook |

So the threads exist server-side and the connection carrying them never dropped. **The client's
shell view is silently diverging from the server.** Noook pong latency in this window ran
664–3274 ms against the hardcoded 5000 ms kill, so the margin is thin but was never crossed.

### A hypothesis that looked right and is wrong — do not retry it

`applyShellStreamEvent` has no gap detection: an event whose sequence is far ahead of the
cached snapshot is applied and the cursor jumps, apparently skipping everything between. That
looks exactly like "threads go missing", and it is tempting.

It is wrong. `computeSnapshotSequence` (`ProjectionSnapshotQuery.ts:233`) is a **min across
`REQUIRED_SNAPSHOT_PROJECTORS` of `lastAppliedSequence`** — the global orchestration event-log
sequence. Most logged events are not shell-relevant, so **gaps are the normal case**. Adding
`sequence + 1` gap detection would force a resnapshot on almost every event.

### What was added instead

`packages/client-runtime/src/state/shellStreamDiagnostics.ts`, wired into `applyItem`.

The shell path previously reported **nothing** when it lost fidelity: `applyShellStreamEvent`
silently returns the previous snapshot for a stale event, and `applyItem` silently returns when
an event arrives with no cached snapshot. Three conditions are now reported to `renderer.log`
via the same crash-log bridge as the connection diagnostics:

- `shell-view-shrank` — the thread or project count went **down**
- `shell-event-discarded` — an event at or behind the cached cursor was ignored
- `shell-event-dropped` — an event arrived with no snapshot to apply it to

Each carries both sequences and both counts. Deliberately quiet otherwise; a sequence jump
alone is explicitly **not** reported, for the reason above.

Next time threads vanish, `grep '"source":"shell-stream"' renderer.log` distinguishes:
the view shrank (reducer removed them), the cursor wedged (a run of discards), or the events
never arrived at all (silence — which would point at the server stream or the subscription).

### Deliberately not fixed blind

No second speculative fix was shipped. The gate fix was justified by reading the code; this one
is not yet, and a wrong guess here corrupts the thread list rather than merely delaying it.

### Status of the earlier gate fix

Still correct and still worth keeping — an unbounded conjunctive gate is a real fault. It just
was not the only one. Note one risk it introduced: past the 2.5 s grace, if the local shell
snapshot has not arrived, the landing now renders `NoProjectsHero` instead of waiting. If "no
projects" ever flashes on a healthy machine, that is this, and the grace needs raising.

## 2026-08-21 14:40 — the reproduction produced silence, and silence was ambiguous

User reproduced the fault on the build carrying the failure-only diagnostics. **Zero
`shell-stream` records.** That was a negative result, but not a usable one.

Verified the instrumentation really was loaded, so the silence is not a packaging mistake:

- client bundle `query-yhoUdFt6.js` built 14:07, contains `shell-view-shrank`
- app loaded ~14:08:08 (`msSinceLoad` 6573 at 21:08:15 UTC), ran to at least 14:32
- renderer.log for the window holds 4 records, all `connection-ping` pongs
- the server was busy on shell work throughout: `resolveThreadShell` ×141,
  `refreshThreadShellSummary` ×110 in the 21:08:10→21:37:03 UTC trace window
- a thread was created and persisted at 21:32 (`e5216507`), so the system was live

### Why silence could not be read

The diagnostics only fired on failure, so no record was consistent with two opposite worlds:
the stream delivered everything cleanly, or it delivered nothing at all.

**The server trace cannot break the tie either, and this is worth remembering:**
`orchestration.subscribeShell` and `orchestration.subscribeThread` appear **nowhere** in
`server.trace.ndjson`. That is not evidence of absence — an Effect span is emitted when it
_ends_, and a healthy long-lived subscription has not ended. Earlier in the day, when
reconnects were frequent, `ws.rpc.orchestration.subscribeThread` did appear (n=21, avg 69 s),
precisely because those subscriptions were dying.

### Closed the blind spot

`shell-subscribed` (every subscribe/resubscribe: resumed-or-fresh, cursor, cached thread count)
and `shell-applied` (heartbeat on the first applied item and every tenth, with sequence and
current counts). Rate limited because renderer.log is unrotated and append-only.

Next recurrence reads directly:

| observation                                             | meaning                                                       |
| ------------------------------------------------------- | ------------------------------------------------------------- |
| no `shell-subscribed`                                   | the subscription never opened                                 |
| `shell-subscribed`, no `shell-applied`                  | it opened and nothing came down it                            |
| `shell-applied` counts healthy while the UI shows fewer | loss is downstream of the reducer, in the atoms or the render |
| `shell-view-shrank`                                     | the reducer itself removed them                               |

### Also ruled out this round

- `threadRefsEqual` and `arrayElementsEqual` (`state/entities.ts:109,123`) — the memoized
  identity guards behind the thread-list atoms. Both compare length **and** element identity
  correctly, so a stale-array freeze is not the mechanism.

## 2026-08-21 15:37 — stable, with a healthy baseline captured for the first time

App running since 15:20 on the build carrying the positive signals. User reports it stable.
Confirmed against the log rather than taken on impression:

```
shell-subscribed  22:20:27  env=a379f331 (remote)  resumed=true   cursor=107589   cachedThreads=47
shell-subscribed  22:20:33  env=ab3781d7 (local)   resumed=false  cursor=1058296  cachedThreads=326
shell-applied     22:37:39  env=ab3781d7  kind=thread-upserted  n=250  seq=1060358  threads=328  projects=98
```

- **29 records: 27 `shell-applied`, 2 `shell-subscribed`, zero failures.** No
  `shell-view-shrank`, no `shell-event-discarded`, no `shell-event-dropped`.
- Local environment applied **250 items in ~17 minutes**, sequence advancing monotonically,
  thread count steady at **328** and projects at **98**.
- Both environments subscribed cleanly; the local one took a fresh authoritative snapshot
  (`resumed=false`) rather than resuming a cursor.

**This is a baseline, not a proof of fix.** The fault was always intermittent, and it was never
caught in the act with instrumentation attached. Two changes are in flight that could plausibly
account for it — the bounded environment gate and, indirectly, the resolver spawn fix — but
neither has been demonstrated to be the cause. Treat the bug as unconfirmed-fixed.

What is genuinely new is that a recurrence is now diagnosable in one grep, against known-good
numbers: threads=328, projects=98, roughly 15 applied items per minute.

### Incidental observation worth a look later

250 applied items in 17 minutes, essentially all `thread-upserted`, while the thread count never
moved. The server is pushing ~15 thread updates a minute that change nothing about list
membership — almost certainly `updated_at` churn. Harmless to correctness, but it is real
per-client work on a 4.9 GB database, and it is the same family of avoidable load as
`process-spawn-storm.md`. Not chased here.

## Things not to do

- Don't delete the gate outright — it prevents the landing navigating to the wrong project.
- Don't test hooks here with `@testing-library/react`; it is not a dependency. Extract the
  logic, import from `vite-plus/test`.
- Don't assume the fork caused this. Both the atom and the landing gate are byte-identical to
  upstream; the fork's only delta in `_chat.index.tsx` is a titlebar header.
