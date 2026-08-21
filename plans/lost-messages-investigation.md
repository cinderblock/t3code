# Lost messages / missing Claude responses (2026-08-21)

## Status: root cause found and fixed by a peer session

The user-visible message loss was **not** the socket drops investigated here. It was a UI
gate: `allEnvironmentShellsBootstrappedAtom` let one unreachable environment (BlackHole)
blank the whole shell, so a draft thread was never created server-side and the typed
prompt — client-only state — was discarded on navigation.

Fixed in **`83c40f170` fix(web): stop one unreachable environment blanking the whole
shell**. Full analysis: [`environment-isolation-fault.md`](./environment-isolation-fault.md).
The atom is **identical to upstream** — not a fork regression.

This document remains valid for the transport-layer findings, which are unresolved and
independent. See "What is still open" at the bottom.

## Goal

User report: "messages seem to be getting lost, I don't see the response from Claude
reliably." Determine whether the fork's divergence is responsible.

**Short answer: no, not this one.** The currently-active failure is in a component the
fork does not ship, and the kill mechanism is hardcoded in the `effect` library.

## Environment / context

- Repo `C:\Users\camer\git\t3code`, branch `master` (renamed from
  `debug/crash-investigation`). Investigated at `83c40f170`; the 6 commits that were
  local at the time have since been pushed to `origin/master`.
- Two environments in play, and the distinction is the whole story:
  - **Noook** — the local backend. Runs _our fork's_ `apps/server/dist/bin.mjs`.
  - **BlackHole** — a _remote environment_. Runs **stock upstream** from npm
    (`npx --yes t3@<ver>`), so none of the fork's server code executes there.
- Evidence sources: `~/.t3/userdata/logs/renderer.log` (7.7 MB, fork-added crash log),
  `server.trace.ndjson*` (covers 2026-08-21 04:22→19:47 only),
  `~/.t3/userdata/state.sqlite` (4.9 GB).
- `effect@4.0.0-beta.103` (patched).

## The kill mechanism (established, code-level certainty)

`effect/unstable/rpc/RpcClient.ts` `makePinger`:

- Writes a Ping every **5 seconds** — `Effect.delay("5 seconds")`, hardcoded.
- Holds a single `recievedPong` boolean. If no Pong arrived since the previous tick,
  it opens a latch that fails the read loop with `SocketError("ping timeout")`.
- **One missed Pong is fatal.** There is no strike count and no configuration seam.

T3 compounds this in `packages/client-runtime/src/rpc/session.ts`:
`makeProtocolSocket({ retryTransientErrors: false, retryPolicy: Schedule.recurs(0) })`
— so there is no protocol-level retry either. Both of these are **upstream**, not fork
changes (verified: they appear as unchanged context in `git diff upstream/main...HEAD`).

Teardown then reports a hard-coded `close(1000)`, while the browser observes `1006 /
wasClean=false`. Killing the socket tears down every in-flight RPC stream, including
`orchestration.subscribeThread` — which is how a streaming assistant response reaches
the UI.

## Measurements

### Pong latency is a queueing continuum, not a timer

From `renderer.log` (the fork's diagnostic only logs latency ≥500 ms, so this is the tail):

```
count 1130  min 1  p50 811  p90 2833  max 8897   (ms)
0-1s 692 | 1-2s 237 | 2-3s 104 | 3-4s 60 | 4-5s 34 | 5-6s 2 | 8-9s 1
```

Smooth decay from 500 ms to 5 s = load/queueing. A contended machine produces scatter;
a timer would produce a spike. **p90 of 2833 ms against a hard 5000 ms kill leaves very
little margin even when things look healthy.**

### Noook (local, our fork) — was bad, currently quiet

448 ping-timeout kills total. Killed-at-ping-sequence distribution:

```
pingSeq 1: 75   2: 21   3: 315   4: 26   5: 1   6: 1
then: 254, 2069, 2513, 6502, 7223, 24241, 30447, 47554, 132073
```

Strongly **bimodal**: ~440 connections die inside the first ~4 pings (~20 s), and 9
survive the opening burst and then live for _days_ (max lifetime 662,417,127 ms ≈ 7.7
days). Connection lifetime p50 20,615 ms / p90 23,820 ms.

This is a **reconnect-burst** problem, not steady-state load: whatever the client does
on connect (re-subscribe everything, refetch refs across ~14 repos) starves the Pong,
the socket is killed at ping 3, it retries in 3 s, and does the same burst again.

Peak 87 kills in one hour (2026-08-20T09) — a reconnect every ~40 s.

**Today (2026-08-21): Noook has zero ping-timeouts and zero socket-closes.** Only a
handful of slow-pong reports. The spiral is dormant, not demonstrably fixed.

### BlackHole (remote, stock upstream) — failing right now, on a metronome

Every hour today, ~2 disconnects, at an interval of **30.8 minutes ± 0.1**:

```
07:03:27  30.7 min      12:11:41  30.9 min      17:19:49  30.8 min
07:34:20  30.9 min      12:42:34  30.9 min      17:50:33  30.7 min
08:05:06  30.8 min      13:13:15  30.7 min      18:21:26  30.9 min
...                     ...                     19:31:18  69.9 min
```

A ±0.1 min interval over 13 hours is a **fixed timer**, not load — a relay idle timeout,
token TTL, or tunnel rekey. At the 30.8 min mark the remote stops answering Pings, the
5 s watchdog fires, and the socket dies with 1006.

**This is the failure the user is currently hitting, and it is in stock upstream code
running on the relay — the fork does not ship it.**

## Ruled out

- **The fork's queued-message feature.** `fork_queued_messages` is **empty** — zero rows
  in any status. The F6 poison-pill / F7 duplicate-send / F8 dismiss-no-op defects from
  `fork-divergence-review.md` are real code defects but are _not_ firing here.
- **The 4.9 GB database as fork bloat.** Breakdown by payload:
  `orchestration_events` 2113 MB, `projection_thread_activities` 1448 MB. Within
  `thread.activity-appended` (751,053 rows / 1362 MB):
  `tool.updated` 276,584 / 718 MB, `tool.completed` 138,906 / 515 MB,
  `tool.started` 139,043 / 43 MB, `context-window.updated` 93,842 / 35 MB.
  This is **upstream's event-sourcing of tool calls**, not fork-added. Notably
  `account.rate-limits.updated` (F12's concern) does not appear at all.
  The DB size is still worth addressing on its own merits, but it did not cause this.
- **A slow RPC handler blocking Pong.** Checked `RpcServer.ts`: `case "Ping"` replies
  with `constPong` inline, and `case "Request"` dispatches via `server.write` to a
  separate fiber. A slow handler does **not** sit in front of the Pong. The comment in
  `session.ts` asserting otherwise ("a Pong can sit behind slow handlers") is **wrong**
  — it should be corrected.

## Findings / gotchas

- `ws.rpc.vcs.listRefs` reaches **41,274 ms** (256 calls, median 131 ms). The handler and
  the client fan-out are both **upstream** (`apps/web/src/state/queries.ts` is unmodified
  by the fork). The fork added `vcsGraphSnapshot` / `vcsWorktreeChanges` alongside it.
- A single `generateThreadTitle` span took **43,202 ms**, spawning `claude` as a
  subprocess (`runClaudeJson`).
- The client _does_ have `afterSequence` resume with a `lastSequence` cursor
  (`packages/client-runtime/src/state/threads.ts:557`), so a drop is intended to heal.
  There is a documented trap in that code path: a windowed cache resuming against a
  server without pagination support drops history.
- Server traces only retain ~15 hours (10 MB × 10 rotation) — they did **not** cover the
  Aug 20 Noook spiral, so that correlation could not be run.

## Answer to "have we been messing with it too much?"

No, not for this symptom:

1. The active failure (BlackHole, 30.8 min metronome) is on a **remote environment
   running stock upstream from npm**. Fork server code is not involved.
2. The kill policy — 5 s ping, one strike, no retry — is **hardcoded in `effect`** plus
   an upstream `Schedule.recurs(0)`. The fork did not introduce or tune it.
3. The fork's own message queue is empty and cannot be losing messages.
4. The DB bloat is upstream's tool-activity event sourcing.

The fork's diagnostics are what made all of this measurable — close codes, pong
latency, ping sequence numbers. That divergence earned its keep.

The one genuinely fork-added risk in this path is **F3**: `apps/web/src/main.tsx:33`
forwards every `console.error`/`warn` to an unrotated, uncapped `appendFileSync` in
`apps/desktop/src/main.ts:226`. It is not causing the message loss, but it writes on
every one of these events and `renderer.log` is already 7.7 MB.

## Open questions — now answered

1. ~~Which environment are you losing responses in?~~ **Neither, in the sense asked.**
   The user was working in Noook (healthy); BlackHole being unreachable blanked the shell
   regardless. The "worst environment decides" conjunction was the fault.
2. ~~Does a missing response appear later, or is it gone for good?~~ **Gone for good, but
   not via the resume path.** The prompt never reached the server at all — the draft
   thread was never created. `afterSequence` resume was never implicated.
3. The 30.8 min metronome is still unexplained and still firing. Still open.

## What is still open (transport layer — independent of the fix)

Verified after `83c40f170` landed, from `renderer.log`:

- **BlackHole still disconnects.** Latest ping-timeout `2026-08-21T20:32:49.765Z`, with
  `lost-after-connect` and `socket-close` following. Noook still clean since Aug 20.
- **The interval changed.** Gaps were a consistent 30.7–30.9 min through 18:21, then
  **69.9 min** and **61.5 min**. Those are ≈2× the base interval, consistent with the same
  underlying timer firing but not always killing the socket. **Cause unproven** — could
  equally be an app restart or changed activity. Do not report this as an improvement
  without more samples.
- **The pong margin is unchanged and remains the real fragility**: p90 2833 ms against a
  hardcoded 5000 ms one-strike kill.
- Per `83c40f170`'s own commit message: the UI-gate fix "does not explain a response
  failing to arrive on an otherwise healthy thread." That case remains unproven.

## Recommended next steps (not yet done)

- [ ] Tolerate more than one missed Pong. Not configurable in `effect` — options are a
      `patches/` entry (the repo already patches `effect`) or reconnecting without
      tearing down thread subscriptions. **Highest remaining value: it converts these
      transient stalls from dropped connections into hiccups.**
- [ ] Correct the wrong comment in `packages/client-runtime/src/rpc/session.ts` claiming
      Pong queues behind slow handlers. (Verified wrong in `RpcServer.ts`.)
- [ ] Identify the ~30.8 min timer on the relay path; likely an upstream report.
- [ ] Fix F3 (unbounded renderer log) — independent of this bug.

## Things not to do

- Don't blame the fork's queued-message service without checking `fork_queued_messages`
  first — it was empty here.
- Don't assume a slow RPC handler starves the Pong. It does not; verified in `RpcServer.ts`.
- Don't try to tune the ping interval through T3 config. It is hardcoded in `effect`.
- Don't correlate against `server.trace.ndjson*` for anything older than ~15 hours.
