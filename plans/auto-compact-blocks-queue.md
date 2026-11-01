# Auto-compaction blocks the composer

## Goal

When a send triggers automatic compaction, `/compact` runs first and the message waits behind it.
That part works. While it waits, the composer must stay usable: the user must be able to queue
another message and edit the waiting one.

## Environment / context

- Compaction before send: `planComposerTurn` (`compactBeforeSend`) in `apps/web/src/components/ChatView.logic.ts`,
  dispatched by `useComposerSend.ts`, with `idleCompaction: "onReturn"` on the `/compact` message.
- Live install is read-only for this work: `~/.t3/userdata/statev2.sqlite` opened with `mode=ro`.

## Root cause

- `isSilentRunForShell` (`ProjectionStore.ts`) drops automatic compaction runs from the thread shell.
  It landed 2026-10-25 in `b6c326d12f` (#25122) so that background compactions stop showing Working.
- With the compaction filtered out, the shell's only live run is the queued message, so the shell
  reports `status: "queued"` and no `activityRunStatus`.
- `hasServerAcknowledgedLocalDispatch` passes that shell runtime to `derivePhase`, which maps
  `queued` to `connecting`, and returns false for any connecting state.
- So `isSendBusy` stays true for the whole compaction. The send button shows a spinner and
  "Submitting message", the queue button is disabled, and `onSend` returns silently at its guard.
  That guard runs before `queuedRunEdit.saveEdit`, so an opened edit cannot save either.
- Manual `/compact` has no `idleCompaction`, stays in the shell, and is unaffected.

## Decisions

- Fix the acknowledgement, not the shell. A server-queued message is delivered, whatever is ahead of
  it. Changing the shell would undo #25122.
- This also covers the gap after any run ends and before the queued run starts, which reads as
  `connecting` in both the shell and the detail runtime and re-activated a finished local dispatch.
- `preparing` and `starting` still hold the composer: the run is really starting.

## Findings

Measured on the live database and server traces, 2026-11-01.

- Refuted: `startTurn` staying in flight. Both dispatches returned in under 200 ms (181 ms and 136 ms
  at 12:17:24 PM PST (20:17:24Z)). Compaction then ran 40–60 s.
- Refuted: the server rejecting the second send. No dispatch reached it during that window. The
  block is entirely client side.
- Refuted: the gap between compaction ending and the queued run starting as the main cause. It
  averages 4.7 s after auto-compaction against 3.7 s after ordinary runs, so it is not specific to
  compaction, though the same bug applies inside it.
- Queueing during compaction: manual 7 of 149 compactions, automatic 1 of 52, at 119 s into a 206 s
  compaction on 2026-10-30. Thread switches reset local dispatch state, which may explain that one;
  not confirmed.
- `orchestration_v2_command_receipts` is empty and `orchestration_v2_events` has no rows for these
  runs on this install, so neither can show history here. Use `orchestration_v2_projection_runs` and
  `logs/server.trace.ndjson*`.

## Progress

- [x] Find the cause
- [x] Failing test in `ChatView.logic.test.ts`
- [x] Fix `hasServerAcknowledgedLocalDispatch`
- [x] Keep compaction unavailable while the thread is connecting
- [x] Focused tests pass (73), plus format, lint and web typecheck on the changed files
- [x] Commit
- [ ] Confirm in the real app after the next launch. Not tried live: the cause comes from the code,
      real run data and unit tests, and a real auto-compaction needs an idle Claude session over the
      token threshold.

`vp run check:changed` could not run (the known `ENAMETOOLONG` crash in `ISSUES.md`). The web
`tsc` shim in the main checkout is stale, so typecheck ran through
`node_modules/.pnpm/@tsc-rs+typescript@0.8.0/node_modules/@tsc-rs/typescript/bin/tsc`.

Deploying: `start-t3.ps1 -BuildOnly` refuses while the app runs, by design, because it would swap web
chunks under the live session. The fix arrives through the rebuild on the next normal launch.

## Things not to do

- Do not add compaction runs back to the shell.
- Do not treat `connecting` as acknowledged in general: first sends rely on it.
