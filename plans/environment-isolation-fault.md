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

## Things not to do

- Don't delete the gate outright — it prevents the landing navigating to the wrong project.
- Don't test hooks here with `@testing-library/react`; it is not a dependency. Extract the
  logic, import from `vite-plus/test`.
- Don't assume the fork caused this. Both the atom and the landing gate are byte-identical to
  upstream; the fork's only delta in `_chat.index.tsx` is a titlebar header.
