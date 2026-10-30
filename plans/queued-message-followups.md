# Queued-message follow-ups (coordinated)

## Goal

Five follow-ups to send-later messages, each done by its own top-level thread, strictly one at
a time, then one idle relaunch of T3 Code carrying all of them. This thread only coordinates.

Coordinator: `t3-thread://v1/mcp:f7da2c0f-4441-4f98-909d-b4074bedd371`

## Environment / context

- Fork checkout `C:\Users\camer\git\t3code`, branch `master`. Do not push, do not open PRs.
- Baseline commits, already on `master`: `c7d2e59252` (snooze until reset), `3c20161349` (send-later
  threads in Working, `sidebarScheduledMessagesWorking`), `934ba3953c` (auto-settle skips them),
  `d0e1c75bec` (test mock).
- Related docs: `plans/scheduled-messages-in-working.md`, `plans/snooze-until-usage-reset.md`,
  `plans/queued-messages-ui.md`.
- The parent thread `ab3781d7-a1dd-4bbb-b3e9-6331e19b7569` is no longer available to read
  (`thread_not_found`, 2026-10-30), so the brief recorded here is the source of truth.
- `vp run check:changed` fails here with ENAMETOOLONG. Use `vp fmt` / `vp lint` on touched files,
  `../../node_modules/.bin/tsc --noEmit` per package, focused `vp test run`.

## Decisions already made (don't re-ask)

- Serial item threads. Only the relaunch thread may run alongside them.
- The user runs the official T3 Code mobile app from upstream, and the fork's native code does
  not reach it. Item 2 is limited to what the fork's server can do for the unmodified app; if
  that is nothing useful, record it and stop.
- Items 1 and 4 are read as one design (see below). If the user's wording turns out to mean
  something else, ask rather than guess.
- Send-later messages never count as busy for a restart.

## Items

1. Separate section instead of Working: a new section for idle threads holding a queued message.
   A thread that is actually working stays in Working even with a queued message.
   Revisit `isThreadWorkingOrScheduled` and the setting's name and label.
2. Send-later on mobile, server side only (see decisions).
3. Edit a queued message, and/or cancelling restores the composer as if it was never queued
   (all text and attachments still there).
4. Queued messages on idle threads get a section (working threads stay in Working). Expected to
   be a verification of item 1.
5. Queue sends on brand new threads.

## Relaunch

A separate thread, started once item 1 is running. It prepares first, then waits for this thread
to message it that all five items are finished. The handoff has to leave no run active on either
side when the watcher polls, because `t3-busy.mjs` counts both.

Relaunch thread: `t3-thread://v1/mcp:2cf06899-8261-49a9-bb43-530157899ff1`

### Decided (phase 1, 2026-10-30 3:15 AM PDT, 10:15Z)

- **Past the busy check: no exclusions.** `t3-busy.mjs` is unchanged. The coordinator ends its turn
  after messaging the relaunch thread, and that thread ends its turn right after starting the
  watcher, so neither has a run for the 120s quiet period or `-WaitForIdle`'s 60s second check.
  Unrelated threads still hold it off, as designed. Send-later messages are not read at all.
- **Build check without touching the app.** `start-t3.ps1 -BuildOnly` refuses while the app runs, and
  a build in this checkout swaps the web chunks under it and breaks its lazy routes. So the phase 2
  build happens in a throwaway sibling worktree at `master`'s HEAD, next to this checkout, not here.
- **Start check.** In that worktree, boot the built server with an isolated `--home-dir` holding a
  copy of `~/.t3/userdata/statev2.sqlite`, so migrations run against real data. Confirm
  `/.well-known/t3/environment` answers, stop it by its captured PID, remove the worktree.
- **Wake-up: an interval task bound to the relaunch thread, every 30 minutes**, created last in
  phase 2 and deleted once the relaunch is confirmed. Each firing reads
  `restart-when-idle.log`, `latest.txt` and that run's `launcher.log`; if nothing has finished it
  ends straight away. A firing is a run, so it can reset the idle timers, but it lasts about a
  minute against a 30-minute gap. One cut off by the relaunch just fires again.
- **Failed start.** With the app down no thread can wake, so the watcher now stays until the launch
  has an outcome: no app running means one more launch, then `relaunch-failed.txt` opened in Notepad
  on the desktop. A failed build with the old app still up is logged and found by the next firing.

### Phase 2 steps

1. Check `Win32_Process` for `restart-t3-when-idle.ps1`; none may be running. Launcher 11888 from
   2026-10-27 4:01 PM PDT is expected: it owns the running app and `Stop-RunningT3` handles it.
2. Check `pnpm-lock.yaml` against `node_modules\.modules.yaml`. If the lockfile is newer, the
   launcher stops the app before installing, so a later build failure leaves no app. Run the
   preflight first and treat a failure there as blocking.
3. Build and boot in the sibling worktree (above). Fix errors on `master` and repeat.
4. Create the 30-minute interval task, then start the watcher through WMI, then end the turn.
5. On a firing that finds `relaunched:` in the log: compare `apps\desktop\dist-electron\.t3-build-stamp.json`
   with `master`'s HEAD, check the new features are in the running bundles, delete the task, and
   send the result to the coordinator.

### Phase 2 preflight (2026-10-30 4:30 AM PDT, 11:30Z)

Passed at `1caf826cc9`, in a sibling worktree removed afterwards. The running app was not touched.

- **Build:** `vp i` then `vp run build:desktop`, 5 of 5 tasks.
- **Copy:** `migrate-dev-db --projects 1000 --threads-per-project 100000` gave 4.2 GB, 703,482 events,
  11 queue rows (2 pending, due later today), no scheduled tasks, no active runs.
- **Migration 8, first run on real data: pass.** The tool did not run it (see `ISSUES.md`), so the boot
  did: the server logged `fork:8_QueuedMessageContent`, `t3fork_migrations` went from 7 to 8, both
  columns exist, all 11 rows kept their statuses with NULL in both new columns, as designed.
- **Boot with `befbb8ce81`'s layer: pass.** `/.well-known/t3/environment` answered 200 in 5s and the
  server stayed up about 30s, through two 15s queue ticks over those rows. No errors, no run started,
  nothing sent. Two warnings: a deleted worktree's PR lookup, and a git spawn-rate notice.
- `t3_send_later` is in the server bundle, "Scheduled section" and "Edit message" in the web bundles.
- **Not covered:** Electron itself, a queue `list` RPC, and any feature used by hand.

### Relaunch result (2026-10-30 4:36 AM PDT, 11:36Z)

Confirmed at 5:02 AM PDT (12:02Z) by the first wake-up firing, running on the new app.

- **Running commit `dc5788d30a`**, which is `master`'s HEAD: `1caf826cc9` plus the preflight notes and
  `ISSUES.md`, so no code differs from what the preflight built. The stamp says not dirty.
- **Timeline:** watcher started 4:32:11 AM, idle 4:32:31, launcher 4:34:32, build about a minute,
  `-WaitForIdle` quiet for 60s, app closed normally, backend answered in 6s, `relaunched:` 4:36:32.
  It ran no earlier than the coordinator and this thread had both ended their turns.
- **Live app:** backend PID 36916 runs Electron from this checkout, port 3773, and serves
  `assets/index-C7QoUlKL.js`, which is in `apps\web\dist`.
- **Migration 8 on the real database: applied 2026-10-30 4:36:23 AM PDT (11:36:23Z).** All 16 rows
  kept their statuses (12 sent, 3 pending, 1 cancelled). The 3 pending are due 8:01 AM, 8:04 AM and
  12:21 PM PDT today.
- **Features:** `t3_send_later` is exposed by the running server and its `list` answered. The rest are
  present by bundle strings only: "Scheduled section", "Edit message" and the restore toasts, and the
  new-thread queue strings plus `sendContext.launch`.
- **Not done:** no feature was used in a client, and no queued message has fired on this build. The
  watcher's failure paths are still tested against a stub only; the success path now ran for real.
- Wake-up task deleted. One firing was needed; it never held up the watcher.

## Progress

- [x] Item 1: `3c5f230f83`, plus four lines of its drag test that landed in `d94f7ab701`
- [x] Item 2: `t3_send_later` built; evals not run (no API key)
- [x] Item 3: `1fe8d05411` (server), `6617e3db3b` (web and user docs)
- [x] Item 4: verified, one fix in `eea3dab9a1`
- [x] Item 5: `befbb8ce81` (server), `dce4536401` (web and docs)
- [x] Relaunch, confirmed on `dc5788d30a`

## Outstanding work (user asked 2026-10-30 9:00 AM PDT, 16:00Z)

"Make a thread to work on each outstanding issue serially." One thread per entry, one at a time, in
this order. Scope is what the follow-ups left open, not the older `ISSUES.md` entries.

- **Order reasons.** `migrate-dev-db` goes first because a seeded dev server can send the user's real
  pending messages, and client verification needs that seed. Verification follows the fixes so it
  covers them. Evals go last because they need an API key and must not stall the chain.
- **No thread:** the three placement calls from item 4 (ready plan, Limited label, Scheduled section
  with Working off). Those are the user's to change; the current behavior stands until then.
- **Build rule.** The running app serves `apps/web/dist` from this checkout, so nothing may build here.
  Dev servers and builds belong in a sibling worktree.
- The running app stays on `dc5788d30a`; these fixes need another relaunch to go live.

- [x] A. `migrate-dev-db` keeps pending send-later messages: `a8bd3de314`
- [x] B. Window-reset message fires at once on a nearly unused window: `df77fd47b6`
- [x] C. Queued messages skip the Claude effort prefix: not a bug; mode bug found and fixed, `72edfecd24`, `e2ccdb5c3a`
- [x] D. Pending message outlives its deleted thread: `2d3e603d9c`; dispatch on a deleted thread was worse than logged
- [x] E. Cancel gaps: `bb4ffe01fe` (server, migration 9), `78d8c8dbaf` (web, docs); a cancel now keeps the message restorable for 7 days
- [x] F. Imported thread that never ran reads Waiting in Working: `32e9035d29`; runtime stays non-null because it locks the provider
- [ ] I. Local composer commands are sent to the provider when queued (found by entry C)
- [ ] J. Queued messages skip idle compaction (found by entry C)
- [ ] K. `message.dispatch` starts a run on a deleted or archived thread (found by entry D)
- [ ] G. Real-client verification, including the first real firings
- [ ] H. `t3_send_later` evals

## Entry F result (2026-10-30 11:12 AM PDT, 18:12Z)

Done: `32e9035d29`, two status lines in `packages/client-runtime`, plus one test. Claimed in `582a14ebcf`.

**The fix.** A thread with a provider thread and no run now presents runtime `completed`, not `idle`, in
`shellRuntime` (shell list) and `deriveThreadStructureRuntime` (open thread). The row reads the same as
any other never-run thread (no Waiting), and it leaves Working; with a queued message it lands in
Scheduled. Parking is decided first, so a thread with no run that really is parked on awaited
background work stays `idle` and in Working. The new test covers both.

**Why not `runtime: null`, which would be the literal same status as a new thread.** Non-null runtime is
what marks a native-imported thread as started: such a thread has no run, no items and no user message,
so `threadHasStarted` and `threadShellHasStarted` on web would unlock its provider, and it would be
switchable away from the native conversation it is bound to. Null also turns `derivePhase` from `ready`
to `disconnected`, and changes "Restart agent session" and delete, which call `stopThreadSession` only
when runtime is non-null. Provider-native subagent threads are also runless with a provider thread and
would take the same changes.

**The server's shell status stays `idle`.** That is correct there: every never-run thread has it, and
`shellRuntime` was the place that gave it a second meaning. No contract change.

**Who reads the status.** `idle` is singled out only by `isThreadWorking` and by
`resolveSidebarThreadStatus` plus its mobile copy, all three fixed by this. Everything else that reads
it treats `idle` and `completed` alike: `derivePhase`, `threadRuntimeCanArchive`, the archive and
delete checks, `threadSettled`, `isLatestRunSettled` (false with no run). No reader checks runtime
`completed` by name. `resolveThreadWorkingStartedAt` and the local dispatch only compare or read
activity fields. Mobile `threadListV2` follows from the shared code. The `thread.runtime !== null`
sites are unchanged.

**Other threads this reaches.** Provider-native subagent threads and a thread whose only run is held also
present `completed` now. Neither is a regression: subagents have no sidebar row and their working state
comes from `deriveRunlessWorkStartedAt`, and the held case is the same wrong `idle` as this bug.

**Surfaces.** Applied: web and desktop sidebar, shelf and open thread, mobile (shared code, reaches only a
fork client). Not applicable: providers (presentation only, no adapter sets this), MCP and agents (server
status unchanged), contracts, connection modes, docs (the row just stops being wrong), reverse states.
Item 5's brand new threads are untouched: their runtime is still null, as asserted by the existing test.

**Checks.** The new test failed before the fix (`"status": "idle"`). `vp fmt` and `vp lint` clean on the
touched files. `tsc --noEmit` clean in client-runtime, web, mobile. `vp test run`: client-runtime
`src/state` 708 in 62 files; web `Sidebar.logic`, `ChatView.logic`, `session-logic` 163; mobile
`threadListV2`, `thread-provider-switching` 68. Not seen in a running client, and no such thread exists in
the live database, so it is proven through `presentThreadShell` and `deriveThreadRuntime` only.

**Left open.** Mobile's `threadDetailToShell` does not pass `pendingBackgroundTasks`, so in that fallback (a
thread not yet in the shell index) a run-less thread with a provider thread, parked on background work,
reads `completed` until the shell arrives; it read `idle` before this. That is a small regression in the
rarest of combinations, and the same fallback already loses the parked state with no provider thread,
and the fork's mobile code does not reach the user's phone, so it is left alone.

## Entry E result (2026-10-30 11:05 AM PDT, 18:05Z)

Done in `bb4ffe01fe` and `78d8c8dbaf`. A cancel no longer destroys anything: it keeps the message
restorable, and one later step removes the content. That single change closes gaps 1 and 2, and the same
step closes gap 3.

**Item 3's order already had the bytes in memory.** The client downloaded, then cancelled, so a lost response
never lost the bytes on the server's side of the cancel alone: it threw away its own copy by treating the
failure as a lost race. An idempotent retry would fix only that case. It would not cover a tab closed
mid-cancel, and it does nothing for an agent's cancel, so the state had to live on the server.

Decisions:

- **Cancel is soft, discard is the removal.** `cancel` sets `status = 'cancelled'` plus `restorable_until`
  and `cancelled_by`, and keeps text, attachments, context and files. `queue.discardMessage` removes them.
  Why this over the alternatives: a retry token solves only gap 1, and a client-held copy dies with the tab.
  One retained row solves 1 and 2 with one sweep. It costs one RPC and fork migration 9.
- **Take-back is download, cancel, restore, discard.** The server's copy goes only after the draft holds the
  message. Every failure leaves a row that can be restored, so the worst case is a duplicate, never a loss. A
  failed discard leaves a harmless row that the X or the sweep clears.
- **Seven days** (`RESTORE_WINDOW`). The row exists mostly for a message an agent cancelled while the user was
  away, so a short window would defeat it. The bound is enforced by the sweep.
- **Sweep on the reactor loop.** `sweepRestorable` runs before each 15s tick, with its own error catch so it
  can't stop sends. It covers startup too, and a long-running server. It shares `discardRow` with the X.
- **Thread deletion extends entry D's paths.** `cancelForDeletedThread` and its startup scan now also take
  restorable rows, so a delete removes everything at once. No second mechanism.
- **Failed rows: the X discards and removes files, unless the send landed.** `dispatch` passes the row's
  claimed files straight to the thread message, so an interrupted send that went out shares those files.
  `threadHoldsFiles` looks up `messageId` in the thread for rows with a `failureDetail` and attachments. A
  read failure fails the discard, leaving the row, rather than guessing. Edit message on a failed row keeps
  the files until the draft has them.
- **An agent cancelling its own message keeps nothing.** It isn't the user's work and it has no attachments.
- **`cancelledBy` is a column, not a reuse of `failure_detail`.** That field means a send failed, and
  `threadHoldsFiles` depends on that meaning.
- **Two clients restoring the same row both succeed.** Restore has no claim step, because a claim's lost
  response would recreate gap 1. A duplicate draft is the failure mode, and cancel itself stays first-wins.
- **Model-facing text is unchanged.** The tool description and result shape are the same, so no eval changes.

| Case                                    | Behavior                                                                                           |
| --------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Cancel response lost, or tab closed     | Row shows **Cancelled** with **Restore** and **X**. A toast points at it when the client survives. |
| Restore clicked                         | Downloads, fills the draft, discards. Download failure leaves the row, with a toast.               |
| Agent cancels the user's message        | Row shows **Cancelled by an agent** for 7 days. No draft changes.                                  |
| Agent cancels its own message           | Discarded at once. Nothing shows.                                                                  |
| X on a failed message                   | Discarded. Files removed, unless the send reached the thread.                                      |
| Edit message on a failed message        | Files stay until the draft holds it, then as above.                                                |
| Failed on an archived thread (entry D)  | Not landed, so the X removes the files. That gap is closed.                                        |
| 7 days pass                             | Swept: content and files gone, clients get an upsert, the row leaves the panel.                    |
| Thread or project deleted               | Everything gone at once, restorable rows included.                                                 |
| Restorable row on a thread gone at boot | Cleared by the startup scan.                                                                       |
| First message of an unstarted thread    | Restore uses the same path, so it reopens a new-thread draft and deletes the empty thread.         |

**Migration 9** adds two nullable columns and touches no rows, so existing cancelled rows read as not
restorable, which is right because their content is already gone. Measured read-only on the live database at
11:00 AM PDT (18:00Z): 16 rows (14 sent, 1 cancelled, 1 pending), migrations at 8, no attachments held. Both
`ALTER`s ran on a copy of that table in `C:\temp\entry-e-queue-copy.sqlite`, all 16 rows kept, both columns
NULL. Rows dismissed before this keep whatever files they leaked: their ids are gone, and today's database
holds none.

**Surfaces.** Applied: server, contracts (additive optional fields, one RPC), client-runtime, web and desktop
(shared panel), user docs (`docs/user/thread-sidebar.md`), reverse states (Restore and X are both ways out of
the cancelled row, re-queue is the way back). Agents: `t3_send_later` cancel is the case being fixed, and
`list` still leaves cancelled rows out. Mobile has no panel: `apps/mobile` still compiles and only reads
pending rows, so a phone shows no Restore row, but the same row is on web or desktop for 7 days. Not
applicable: providers, keybindings, settings. Connection modes: the download path is item 3's, not exercised
on a real remote.

**Checks.**

- Test first: 9 of the server tests in `QueuedMessageAttachments.test.ts` failed before the service change, and
  5 in `queuedMessageRestore.test.ts` before the web change. Two more are guards that passed by design: an
  agent cancelling its own message, and delete removing a restorable row (the old cancel had already removed
  it).
- `vp test run`: server 368 of 368 across `src/queue`, `sendLater`, fork migrations, `migrate-dev-db`,
  `runtimeLayer`, `src/project`, `GuestShareService`, `ws.test.ts`. Web 51 of 51 across `queuedMessageRestore`,
  `queuedMessageEdit`, `composerSend.logic`.
- `tsc --noEmit` clean in server, web, contracts, client-runtime, mobile, desktop.
- `vp fmt` clean. `vp lint` clean on web files. Four old long-header `no-low-value-comments` errors remain on
  `ForkMigrations.ts`, `queuedMessage.ts`, `rpc.ts` and `QueuedMessageService.ts`, on lines this didn't touch.

**Not verified.**

- **Not seen in a running client.** The Restore row, its toast and its focus behavior are read and typechecked
  only. The panel's filter and the take-back order are tested, the panel's markup and `useQueuedMessageComposer`
  are not. Entry G should cover a Restore, an X on a failed row, and an agent cancel.
- **No server boot.** The change adds no layer or dependency, and the tests run the real service against real
  SQLite, so migration 9 has run through the real migrator only in tests. The relaunch preflight's boot on a
  database copy is its first full run.
- `threadHoldsFiles` is tested against a mocked thread. The `messageIds` filter it passes is read from
  `ProjectionStore`, not run here.

**Open.**

- A user who is not looking at the thread gets no notice of an agent's cancel: the row waits in the panel,
  and the thread leaves Scheduled with it. A toast or sidebar mark would be new scope.
- Attachments over the composer's limit during a restore are named in a toast and then lost with the discard.
  That is item 3's accepted behavior, unchanged.
- A failed row that is never dismissed keeps its files until its thread is deleted. Nothing sweeps those, by
  design: it is the user's undelivered message.
- Temp files left, per the brief: `C:\temp\entry-e-*`.

## Entry D result (2026-10-30 10:50 AM PDT, 17:50Z)

Done in `2d3e603d9c`. Deleting a thread now takes back what was waiting on it, and a row can no longer
start a turn on a thread that is gone.

**The issue undersold it.** It said the row "fails at dispatch". Measured with a real orchestrator in
`runtimeLayer.test.ts`: `message.dispatch` on a deleted thread succeeds, commits the message and leaves
a run in `starting`, and the same happens on an archived thread. Launch rows and `sendToThread` are the
ones that refuse. So a plain row could go out as `sent` into an invisible thread, and the check has to
come before the send. Reacting to a failed dispatch would not have worked. `ISSUES.md` logs the
orchestrator gap.

Decisions:

- **Delete cancels; it does not fail.** Nothing is left to show a failure on, and the user chose to
  delete. Pending, `sending` and failed rows all go to `cancelled` with their files removed.
- **Failed rows lose their files here, unlike a dismiss.** A dismiss keeps them because the thread may
  own them. With the thread gone they are the thread's or nobody's, and thread cleanup only knows ids
  on messages that landed.
- **The trigger is an outbox effect, `queued-messages.cleanup`,** from `planThreadDeletion`, next to
  `scheduled-tasks.cleanup` and handled through `ResourceCleanupService`. `thread.delete` and the project
  cascade share that plan, so both get it, and it runs after commit, durably, replay-safe and idempotent.
  The orchestrator's decide step only adds the effect.
- **One instance.** `QueuedMessageService.layer` moved from `server.ts` to `runtimeLayer.ts`
  (`layerQueuedMessageProvided`), the same shape as `layerScheduledTaskProvided`. Consumers share that one
  layer reference, so it builds once and only one dispatcher runs. Layer order is safe: the effect worker
  starts after layer build in both positions, and the queue's dependencies still build first.
- **Two backstops, because the effect can't reach everything.** The reactor reads the thread before each
  claim, covering the gap before the effect runs and an enqueue that raced the delete. Startup clears
  pending and failed rows on gone threads, covering rows from an earlier build. The running app is still
  the old build, so deletes before the next relaunch make exactly these rows.
- **Archive keeps the row, and a due row fails with a reason.** Archive is reversible, so the row stays.
  If it comes due while archived it is marked failed with "The thread was archived when this message came
  due", no run starts, and files stay. Unarchiving shows it with **Edit message**. Sending on unarchive was
  rejected: a stale prompt would start a turn without asking. Unarchiving before it is due sends normally.

| Case                                     | Behavior                                                                                      |
| ---------------------------------------- | --------------------------------------------------------------------------------------------- |
| Thread deleted, row pending              | `cancelled`, files gone, clients get an upsert, as the cancel path does.                      |
| Project deleted                          | Same; each child thread's delete queues the effect (tested).                                  |
| New thread deleted from the sidebar      | Same row, same result, so nothing fails at the trigger.                                       |
| `sending` at delete                      | `cancelled`. The send's `markSent`/`markFailed` match no row, and it republishes `cancelled`. |
| Failed row at delete                     | `cancelled`, files gone.                                                                      |
| Sent or cancelled row                    | Untouched; a replayed effect changes nothing.                                                 |
| Due before the effect ran                | Cancelled by the reactor, no send.                                                            |
| Archived, comes due                      | `failed` with the reason, no run, files kept.                                                 |
| Archived, unarchived before due          | Sends normally.                                                                               |
| Existing rows on deleted threads at boot | Cleared at startup, silently. Live rows untouched. A read failure logs and retries next boot. |
| Take-back of a waiting new thread        | Unchanged: bytes download, cancel, draft, then delete. The row is already `cancelled`.        |

**Live database, read-only, 2026-10-30 10:30 AM PDT (17:30Z):** 16 rows (14 sent, 1 cancelled, 1 pending),
all on live threads with a v2 row. None on deleted or archived threads, no failed rows, no attachments
held. So the startup path has nothing to do today; it exists for deletes between now and the relaunch.

**Restored drafts are safe.** A draft holds downloaded bytes, not server ids (`takeBackQueuedMessage`), and
it is written only after the cancel, so the row is already `cancelled` and this path doesn't see it. Pending
uploads the composer may retry from are separate files, because claims copy.

**Scheduled section.** It follows the queue stream, and this publishes the same `upserted` event as cancel.
The thread itself leaves the sidebar on the delete. Read from the code, not seen in a client.

**Surfaces.** Applied: server, both delete routes (`thread.delete` and `ProjectService.delete`, which every
client, MCP and CLI path ends in), user docs (`docs/user/thread-sidebar.md`). Web, desktop and mobile take it
from the stream, no client change. Not applicable: contracts (the status and event already existed), evals
(no model-facing text), providers.

**Checks.**

- Test first: 7 of 9 new tests in `QueuedMessageAttachments.test.ts` and both effect-list tests failed before
  the change. The other two are guards that passed by design. The first green run also caught a real bug:
  `RETURNING attachments_json` hands back the new NULL, so the row is read before the update.
- `vp test run`: 240 of 240 across `src/queue`, `sendLater`, `ThreadDeletion`, `ProjectService.deletion`,
  `runtimeLayer`, `GuestShareService`, `ThreadSettlementService`, `EffectOutbox`, `EffectWorker`, `Migrations`.
- `userInputAttachments.test.ts`: 3 failures, Windows path escaping in tests that don't use this change.
  Not confirmed against a clean `master`. Logged in `ISSUES.md`.
- `tsc --noEmit` clean in `apps/server`, the only package with code changes. `vp fmt` clean. `vp lint` clean
  except the old `no-low-value-comments` header on `QueuedMessageService.ts`.
- Boot: `node src/bin.ts` on an empty isolated `--base-dir` answered `/.well-known/t3/environment` 200, ran
  20s more with no errors, and stopped by its captured PID. Run here rather than in a sibling worktree: it
  builds nothing and doesn't touch `apps/web/dist`. A 503 before startup finishes is normal.

**Not verified.**

- Not seen in a client, and no thread deleted on a running server with a real row. The effect's route is
  tested against a recording mock, the service against mocked threads. Real `getThreadShell` was measured
  separately: null for deleted, non-null for archived.
- That one dispatcher runs is from layer memoization and the `ScheduledTaskService` precedent, plus the boot.
  No test counts instances.

**Open.**

- An archived-then-failed row keeps its files, and dismissing it with the **X** leaks them, since a dismiss
  never removes files. That is entry E's "dismissed failed messages" gap, with one more way in.
- A failed row on an archived thread stays invisible until the thread is reopened. Nothing notifies. If the
  user would rather have it sent, or hold until unarchive, that is a small change in `sendIfThreadIsLive`.
- A delete landing between the reactor's read and its dispatch can still start one run on the deleted thread.
  The row and files are cleaned up; closing it needs the orchestrator fix in `ISSUES.md`.
- Temp files left, per the brief: `C:\temp\entry-d-*`, `C:\temp\scratch.*`, `C:\temp\red.out`,
  `C:\temp\green.out`, `C:\temp\final.out`, `C:\temp\runtimeLayer.test.ts.orig`, `C:\temp\uia.test.ts`,
  and two `t3-entry-d-boot-*` directories under `%TEMP%`.

## Entry A result (2026-10-30 9:47 AM PDT, 16:47Z)

Done in `a8bd3de314`. A new seed holds no queued messages, and the tool runs fork migrations.

- **All statuses are cleared, not just pending.** `fork_queued_messages` joins `CLEARED_TABLES`, so its
  rows are never copied. Only `pending` fires. `sending` becomes `failed` at boot, and `sent`, `failed`
  and `cancelled` are inert. But they are real message text, the tool copies no attachments for them,
  `scheduled_tasks` loses its history the same way, and a future status fails safe. Entry G queues its
  own messages, so it loses nothing.
- **Fork migrations run after upstream's, as at boot.** They are reported as `fork:8_QueuedMessageContent`,
  so "already current" is now true. The two parts depend on each other: a source with no fork tables
  would otherwise fail the prune's `DELETE` on a missing table.
- **Other pending work: none found.** Every table in the live database was checked. `fork_usage_samples`
  and `fork_auth_*` hold no work. Scheduled tasks, webhook pending rows (by foreign key), the effect
  outbox and launch workflows were already cleared. Webhook delivery tables are dedupe history.
  Threads with active runs or open requests are already excluded as not stopped.
- **First-run and manual seeding are the same path.** `dev-runner.ts` runs this script, so one fix covers
  both. No guard was added to dev starts: it would delete messages queued on purpose in a sandbox.
- **Existing seeds: nothing to clean.** A read-only scan of `~/.t3/dev`, this checkout's `.t3` and every
  worktree found one database, `mobile-attach-pr`, with no queue rows. It is at fork 7, and its own
  server boot migrates it. Any older seed elsewhere needs a rerun of `vp run migrate-dev-db`.

**Checks.** The new test cases failed before the fix (3 failed, 5 passed) and pass now (8 of 8). `vp fmt`
clean, `vp lint` exit 0 on both files, `tsc --noEmit` clean in `apps/server`. Real seed into a temp
directory, `--projects 200 --threads-per-project 30`: source `pending=1 sent=14 cancelled=1`, seed 0 queue
rows, 0 scheduled tasks, 0 outbox rows, 778 threads, fork 8, and the pending row's thread was kept.

**Not verified.** No dev server was booted on the seed. The source is already at fork 8, so on real data
the "already current" line was correct but no fork migration ran; that case is covered by the test only.

**Open.**

- `verifyMigrationSlots` still checks upstream ids only, so a fork id clash between branches would not
  be caught. Not seen, so left.
- A waiting new thread's row is dropped but its empty thread stays in the seed. Harmless.
- The real-data seed and check scripts from this entry were left in place for the user to decide about:
  `C:\Users\camer\AppData\Local\Temp\seedcheck.sl2g` (3.4 GB copy of real data), and `src.mjs`,
  `check.mjs`, `seeds.mjs` and `tables.mjs` in `C:\Users\camer\AppData\Local\Temp\`.

## Entry B result (2026-10-30 10:15 AM PDT, 17:15Z)

Done in `df77fd47b6`. "When the window resets" now means the next reset after queueing, from any usage level.

**What the data showed** (read-only, `fork_usage_samples`, Sep 11 to Oct 30).

- **"Reset time changed" can't be the signal.** Claude's `resetsAt` jitters about ±1 second between reads,
  in thousands of samples. So the trigger stores one reset and compares the clock to it.
- **Claude's idle `five_hour` has no reset at all.** 1322 of 6038 samples are null, every one at 0%. The
  clock starts with the first use. `seven_day` and `seven_day_fable` always had one here.
- **Early resets are real, and the old rule covered them.** Oct 20: 73% to 1% with the reset nearly 3 hours
  away. This is why the usage rule stays, with memory added, instead of being removed.
- **Usage falls inside a window** (99 to 98, seen hundreds of times), so "usage dropped" alone is not a reset.
- **Reset times that moved before passing were account switches** (Oct 19 and 20, including 12-hour swings
  and straight back). A stored reset rightly ignores them.
- **Other providers, by reading the code only.** Cursor, Grok, OpenCode and Antigravity report a reset when
  they have one. It is optional in the schema, so "no reset time" is a real case. `monthly_spend` has none
  but is not offered as a trigger.

**The fix.** The `window-reset` trigger gains two optional fields, stamped by the server: `resetsAt` (the
reset this message waits for, null until one is advertised ahead) and `peakPercent` (highest usage seen since
queueing). It is due when the stored reset passes, or when the window falls to 5% or less from a peak above 5%.

- **Web composer, Edit trigger and `t3_send_later`** all go through `enqueue` or `update`, which stamp the
  baseline from the server's own read and replace anything a client sent. A text-only edit keeps it.
- **The reactor folds each read in** (`observeTriggerWindow`) and saves it silently, so an idle window adopts
  the reset it starts, and a provider with no reset time still has a peak to fall from. The save matches the
  stored JSON, so it can't overwrite a concurrent edit.
- **`t3_send_later`'s nearly-unused refusal is gone,** since it existed only for this bug. Its description and
  parameters did not change, so entry H has no new text to test. The budget test still passes.
- **Usage-limit auto-queue: nothing to change.** No code produces `cap-hit-auto`; only the panel reads it.
  `UsageLimitRecoveryWorker` does not use this trigger.

**Replay against real samples** (the same rule rewritten in a script, queue points every 25 samples, since
Sep 20). The script's "true reset" check counts account switches as resets, so read these as rough.

| Window            | Queue points | At 5% or less | Old rule early | New rule early | Still waiting at end of data |
| ----------------- | ------------ | ------------- | -------------- | -------------- | ---------------------------- |
| `five_hour`       | 183          | 65            | 62             | 0              | 1                            |
| `seven_day`       | 183          | 5             | 1              | 0              | 3                            |
| `seven_day_fable` | 182          | 14            | 9              | 0              | 3                            |

"Still waiting" was not inspected row by row. The count fits queue points after the last reset in the data.

**Decisions.**

- **No migration.** Both fields live in the existing JSON column and are optional.
- **Existing pending rows keep the old rule, which is right for them.** A row with no baseline outlived a build
  that fired at 5%, so its window was above that, and a fall to 5% now really is a reset. That also covers a
  reset during the relaunch. They are never stamped unless the user re-picks the trigger.
- **The pending row in the live database is an `at` row** (12:21 PM PDT, 19:21Z today), so this does not touch
  it. There are no pending window-reset rows right now. Any queued before the relaunch take the case above.
- **An idle window with no clock waits,** rather than sending now. It sends at the reset of the clock the next
  use starts. If nothing ever uses that provider it waits indefinitely, visibly, and can be cancelled. Documented
  in `docs/user/thread-sidebar.md`. An agent calling `t3_send_later` is itself using the window, so no refusal
  was kept for this case.
- **A reset that a stale read shows as already past is not waited for** (reads are 5 to 7 minutes apart). A
  capped window still sends when the next read shows it fell. A nearly unused one waits for the next real reset.
- **Reactor saves publish nothing.** Clients don't use the fields, and a busy window would otherwise write to
  every stream.

**Surfaces.** Applied: web composer and Edit trigger (shared server path, no web change), `t3_send_later`,
contracts (additive, older decoders ignore the fields), user docs. Reverse states: unchanged, cancel and edit
still work. Connection modes and clients: server-side only. Not applicable: mobile UI, evals.

**Checks.**

- The new reactor tests failed before the fix: 3 failed, 3 passed in `sendLater.test.ts`.
- `vp test run` after: 66 passed across `src/queue`, `sendLater` and `AgentContextBudget`; 24 in web
  `queuedMessageRestore`.
- Mutation: with the reactor's save removed, the idle-window test fails.
- `tsc --noEmit` clean in contracts, server, web, client-runtime, mobile.
- `vp fmt` clean. `vp lint`: only the three long-header `no-low-value-comments` errors already in `ISSUES.md`.

**Not verified.**

- **No real firing.** Not run on a real server or in a client; the reactor tests use the test clock and a mocked
  provider registry. Entry G's first real firings cover this, after a relaunch.
- **Codex's idle behavior is unmeasured.** There are no Codex samples in the database. If its idle window
  advertises a reset that keeps sliding forward (a recollection, not confirmed), a message queued there uses the
  first value it saw. It sends one window length after queueing, which could be early by however long the window
  sat idle before first use. Bounded, so left.

**Open.**

- With no reset time, a partial reset that stops above 5% does not fire. None seen.
- A mid-window switch to a nearly unused account reads as a reset. The old rule did the same.
- Temp files left for the user to decide about: `C:\Users\camer\AppData\Local\Temp\entryB\` (read-only query
  scripts, edit scripts and a backup of `QueuedMessageService.ts` from the mutation check).

## Entry C result (2026-10-30 10:30 AM PDT, 17:30Z)

The issue as written is not a bug. Comparing the two paths found one that is, and three smaller ones. Fixed in
`72edfecd24` (modes, with the issue's removal) and `e2ccdb5c3a` (draft checks).

**Why the effort prefix was never lost.**

- **Ultrathink is draft text, not a setting.** `getTraitSelectChange` writes `Ultrathink:\n` into the prompt and
  never touches the model options. The row stores that text, so the keyword goes out with it.
- **The composer can't hold it as a selection.** `resolveDescriptorChoiceValue` maps a prompt-injected value back
  to the default. Probed against the real catalog: 13 models, 11 with Ultrathink, 85 model and effort
  combinations, and `promptEffort` was prompt-injected in none. `formatOutgoingPrompt` adds nothing on any of
  them, and `snapshotComposerSend` already trims. Calling it from the queue would have been a no-op.
- **The server has its own copy.** `ClaudeAdapterV2` applies the prefix from the turn's model selection, so a
  selection set some other way (an agent, an older thread) still gets it.
- **The live rows agree.** All 16 rows carry a model selection with their options, including the pending one.

**Traps from the brief.**

| Trap                                | Result                                                                                                                                                                                             |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Restored draft, doubled prefix      | No change needed. The text is what the user had in the composer, prefix and rainbow frame included. Nothing is added, and `applyClaudePromptEffortPrefix` refuses to double. Both now have a test. |
| Can the server reach the formatter? | It already calls `applyClaudePromptEffortPrefix`. The row already stores the model and effort options, from before `1fe8d05411`. No fire-time prefix was added.                                    |
| Rows already pending                | Nothing to do. No migration, and no stored field changes. They send as they would have.                                                                                                            |
| First messages (`befbb8ce81`)       | Pass. The launch carries the text and `modelSelection`, now tested with `effort` and the prefix together.                                                                                          |
| `t3_send_later`                     | Nothing added. The agent writes its own text, and it omits the model, so the turn uses the thread's selection, effort included. Prefixing an agent's words would change what it wrote.             |

**The real bug: modes.** On a server thread, the Plan and access toggles write only to the draft, and a send saves
them (`persistThreadSettingsForNextTurn`). The queue saved nothing, and a row's modes are not replayed. So a
message queued in Plan fired in the thread's old mode, with the composer showing Plan. This is the issue's
complaint, in a setting the issue didn't name, and it can fire with broader access than the composer showed.
Item 5's note that modes "were set on the thread at queue time" held only for a new thread.

**Decision: save at queue time, in the client, through the send's own call.** Rejected:

- Replaying the row at fire time. A stale row could undo a later change, including putting back full access after
  the user lowered it, and rows already pending hold values nobody saved.
- Saving inside `QueuedMessageService.enqueue`. `queue.enqueueMessage` is a plain RPC, while mode changes go
  through the caller's limits (`OrchestratorThreadAboveModeLimitError`). The server doing it would skip them.

A failed save stops the queue and keeps the draft. The cost: the mode changes when you queue, not when it fires, so
it applies to the thread's other turns too. A send does the same. A cancel doesn't put the old mode back, but the
composer still shows the saved mode, so the two agree. Two messages queued in different modes both use the later
one. `docs/user/thread-sidebar.md` states the rule.

**Other differences between the paths.**

| `useComposerSend` does                        | Queue path                   | Outcome                                                                   |
| --------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------- |
| Length limit on the prompt                    | Skipped                      | Fixed, same inline error                                                  |
| Refuses a thread context from another machine | Skipped                      | Fixed, shared `strandedThreadContextWarning`                              |
| Warns on expired terminal contexts            | Dropped silently             | Fixed, same toasts                                                        |
| Idle compaction before the message            | Skipped                      | Logged in `ISSUES.md`: needs server-side data, bigger                     |
| `/plan`, `/default`, Codex `/feedback`        | Sent to the provider as text | Logged in `ISSUES.md`: needs a decision                                   |
| Plan follow-up                                | Clock hidden in that state   | No gap                                                                    |
| Saves a local checkout's branch mismatch      | Skipped                      | Left: not prompt-affecting, and the checkout at fire time is what matters |

**Surfaces.** Applied: composer clock (the one entry point), web and desktop (shared), first messages (a local draft
saves nothing here, its modes go through `thread.create`; an empty server thread does save), contracts (comment
only), user docs. Providers: all, since modes are thread state. Reverse states: covered above. Not applicable: mobile
(no composer queue), `t3_send_later` (no composer modes; `enqueueForThread` uses the thread's), evals (no
model-facing text changed).

**Checks.**

- The two `enqueueAfterSavingModes` tests failed before the fix. The new Ultrathink tests passed before any change
  to production code, which is the evidence that the issue wasn't a bug.
- `vp test run` on the final code: 27 in `queuedMessageRestore`; 89 across `queuedMessageRestore`,
  `composerProviderState` and `ChatView.logic`; server `QueuedMessageFirstSend` 11; shared `model` 11.
- `tsc --noEmit` clean in web, contracts, server.
- `vp fmt` clean. `vp lint`: only the long header at `queuedMessage.ts:16`, already in `ISSUES.md`. Shortening the
  comment at line 89 cleared that one.

**Not verified.**

- **`queueDraft` itself has no test,** as at item 3: the hook needs a browser test, and browsers are out of scope
  here. The save's order is tested in the extracted helper. That the hook calls it, and all three checks in
  `e2ccdb5c3a`, are from reading and typecheck only. Entry G should queue from Plan with a thread in default and
  check the fired turn's mode.
- No real firing, and no real Claude turn, so that the keyword changes the model's thinking is assumed from the
  adapter and catalog.

**Open.**

- `formatOutgoingPrompt`'s effort branch is dead for every bundled model, in upstream code too. It still trims. Left.
- Temp files left for the user to decide about: `C:\Users\camer\AppData\Local\Temp\entryC\` (edit scripts) and
  an empty `probe-effort.mts` in Git Bash's `/tmp`.

## Item 1 result (2026-10-30 3:25 AM PDT, 10:25Z)

- **Section name: Scheduled**, not "Waiting". "Waiting" is already the row status for a thread
  parked on background work or another thread (`resolveSidebarThreadStatus`), and those rows sit
  in Working, so a Waiting section would hold rows that don't read Waiting while Working holds
  rows that do. "Queued" would collide with the composer follow-up queue and the `queued` run
  status. "Scheduled" is the row status these threads already had, and it matches the section
  names Working, Snoozed and Settled.
- **Setting: `sidebarScheduledShelfEnabled`, label "Scheduled section"**, default on, shown only
  while the Working section is on. Off leaves these threads in the active list. Not migrated:
  the running app's bundles are `c7d2e59252`, older than the old key, and
  `~/.t3/userdata/client-settings.json` does not contain it. A dev browser that switched the old
  option off goes back to the default.
- **Idle has a trap.** `runtime.status === "idle"` does not mean an idle thread. It means parked
  on background work (`shellRuntime`, row reads Waiting), which the existing rule counts as
  working, so those threads stay in Working with a queued message. A finished thread is
  `completed` or null, and only those reach Scheduled.
- **Tracker.** `createInboxReturnTracker` keeps its grace and return stamps, and now reports a
  shelf (`working`, `scheduled`, none) with `resolveThreadShelf`. Working to Scheduled is held for
  the grace, so chained runs don't flicker, and stamps no return. A sent message holds its place
  until its run starts, then moves straight to Working. A cancelled message returns the thread
  after the grace; an approval or question returns it at once.
- **Web behavior.** Order is Active, Working, Scheduled, Snoozed, Settled. Card rows, because slim
  rows have no status and a Failed or Limited one must stay visible. Collapsed by default. Drag out
  as chat context only, like Working. Sorted by last sent message, because soonest-to-send would
  need trigger data in `scheduledThreadKeysAtom`; window triggers have no stored time on the row.
- **Surfaces.** Applied: web and desktop sidebar (shared `Sidebar.tsx`, jump order, search list,
  undo notice host), Settings row, search entry and restore list, contracts, user docs. Reverse
  states: cancel in the thread, or the setting. No keybinding or palette entry exists for sections.
  Not applicable: providers (client placement only), agents and MCP (no sidebar placement is
  exposed), connection modes (reuses the per-environment queue subscription, no new traffic or
  per-row subscription), server (auto-settle untouched).
- **Mobile, deliberately left.** The fork's native code never reaches the user's phone, so no new
  shelf. `useThreadListV2.ts` maps any shelf to Working, so behavior, the "Send-later messages
  count as working" switch and the `scheduledMessagesWorking` preference are unchanged. Docs say so.
- **Checks.** `vp fmt` and `vp lint` on touched files: only `settings.ts:269`, which predates this.
  `tsc --noEmit` clean in contracts, client-runtime, web, mobile. `vp test run`: `threadInbox` 42,
  `Sidebar.logic` + `Sidebar.drag` 120, `threadListV2` 64, contracts `settings` 24, all passing.
  Not seen in a running client: browsers are out of scope here.
- **Open.** Whether the section should work with the Working section off (it does not today).

## Item 2 result (2026-10-30 3:32 AM PDT, 10:32Z)

Compared against `upstream/main` `570d4b03ee` (2026-10-27), which is `master`'s merge base. The
store build may lag that commit; nothing here reads the store binary itself.

**The brief's premise is off: `t3_queue` is not the send-later queue.** It manages orchestration
queued runs (follow-ups behind an active run: `queued-run.edit`, `.cancel`, `.reorder`,
`queued-message.promote-to-steer`). Send-later rows live in `fork_queued_messages` behind
`QueuedMessageService`, reachable only through the `queue.*` WS methods, which the official app
does not know. So before this item no agent could touch send-later messages.

**Built: `t3_send_later`**, the one idea that cleared the bar (see "What was built" below).

What the official app already has, with no fork involvement:

- **Resume at reset.** `UsageLimitRecoveryCard` on a usage-limited thread: "Resume at reset" and
  "Snooze until reset", backed by upstream's `UsageLimitRecoveryWorker`, which sends "Continue where
  you left off." at the reset. `autoResumeLimitedThreads` and `snoozeLimitedThreads` are both already
  on in this user's settings. This covers the capped case, the one an agent cannot help with
  because a capped agent cannot take a turn.
- **Settings → Scheduled tasks.** Lists, pauses, runs and deletes every task, and creates tasks.
  But created tasks always have `threadId: null` (a new thread per run), and schedules are only
  `interval`, `fixed_time` (repeats daily or on weekdays) and `webhook`. No one-shot, no existing
  thread, no usage trigger.
- **`schedule_task` through an agent** can bind to the current thread (default) and appears in that
  same list, so see and delete work without a turn. It repeats until deleted, and it has no usage
  trigger. Bound runs use `sendToThread` with `mode: "queue"` (self-test in Findings below).

Ideas rejected, with the reason:

| Idea                                                                     | Why not                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Server-side `/later` via `ServerProvider.slashCommands`                  | The menu is data-driven, so it would appear. But the app keeps an acknowledged message on screen until the projection echoes that message id (`selectPendingAcknowledgedMessages`, a keep-alive atom), so a swallowed message is a ghost bubble until the app restarts. Rejecting it instead restores the draft with an error, which reads as failure. |
| Hold it as a real queued run so `ThreadQueueControl` shows it            | A queued run on an idle thread starts at once. Holding one is the fake run state the brief forbids, and `t3-busy.mjs` counts runs.                                                                                                                                                                                                                     |
| List rows as synthetic `ScheduledTask`s                                  | The one-shot and usage triggers don't fit the schedule schema, `runNow`, pause and edit would all need faking, and web would list them twice.                                                                                                                                                                                                          |
| Surface it through snooze, title, `limitRecovery` or provider advisories | Each is fake state on a field that means something else.                                                                                                                                                                                                                                                                                               |
| MCP App widget (`McpAppWebView`)                                         | Needs an agent turn to appear and a confirmation dialog on each write. Not small.                                                                                                                                                                                                                                                                      |
| Mobile UI in `apps/mobile`                                               | Unreachable by the official app; out of scope.                                                                                                                                                                                                                                                                                                         |

**Mobile code that never reaches the official app** (fork native/JS code ships only in a fork build,
and the app's OTA channel is upstream's):

- `c7d2e59252`: `apps/mobile/src/state/usage.ts`, and the snooze-until-reset presets in
  `threadListV2.ts` and `thread-list-v2-items.tsx`.
- `3c20161349`: `state/scheduled-messages.ts`, `useThreadListV2.ts`, `thread-list-v2-items.tsx`, the
  "Send-later messages count as working" switch (`ThreadSettingsSections.tsx`, `settings-search.ts`)
  and the `scheduledMessagesWorking` preference in `mobile-preferences.ts`.
- `3c5f230f83`: the `useThreadListV2.ts` mapping of the Scheduled shelf to Working.

**Compatibility with the official app: no break found.**

- `ORCHESTRATION_PROTOCOL_VERSION` and the compatibility check are unchanged.
- `packages/contracts` diff against upstream is additive only: optional fields (`priority`,
  `threadPriority` capability), new settings with decoding defaults, new RPC methods in
  `ForkWsRpcGroup`, new error-reason literals. `ServerProvider` is unchanged.
- The one enum addition that travels to clients is the `thread.priority-set` event. The shell stream
  sends shells, not events. The thread stream has `OrchestrationV2UnknownThreadStreamEvent`, so an
  older client decodes it as `unknown-event` and advances its cursor. Shells carry `priority` as an
  optional field, which older decoders drop.
- `3c20161349`: client-only plus a settings field. `934ba3953c`: a server-side skip, so the app only
  sees a thread that doesn't settle. `3c5f230f83`: client-only plus a settings field.

**What was built.** A fork-only MCP tool, `t3_send_later`, with `schedule`, `list` and `cancel`
(`apps/server/src/mcp/toolkits/sendLater/`, plus `enqueueForThread` and `cancelForThread` on
`QueuedMessageService`). Someone on the official app types "send this at 3 AM" or "send this when my
5-hour limit resets" in a thread, and the agent queues a real send-later message. It sends once, and
shows in the desktop panel and Scheduled section like any other.

- Why it cleared the bar over `schedule_task`: one-shot instead of repeating until deleted, usage
  triggers, and it lands in the same queue the desktop uses. About 230 lines of server code.
- **Agent-authored, so `origin: "agent"` and `createdBy: "agent"`.** Sending as `user` would put the
  agent's words in the user's mouth.
- `windowReset` takes `session` or `weekly`, resolved to the provider's real window id when queued.
  Refused with a reason: a time in the past, a window the provider doesn't report (it would never
  fire), and a window at 5% or less (`isTriggerDue` would fire it on the next tick). That last bug
  also affects the web picker: logged in `ISSUES.md`.
- `modelSelection` is left out of the send context, so the send follows the thread's model at that
  time. No attachments, and no headroom trigger (desktop only). Editing belongs to item 3.
- Limits, stated in `docs/user/thread-sidebar.md`: each request costs a turn, and it can't help once
  the provider is capped. Resume at reset covers that case.
- A new top-level toolkit rather than an addition to `ThreadToolkit`, so upstream merges stay clean
  and the upstream toolkit tests need no new mock.
- `agentContextBudget.json`: `mcpToolListJsonBytes` 42328 → 43393. Upstream's CI would want the
  `agent-context-increase` label; this fork opens no PR.

**Surfaces.** Applied: agents (the point of this), contracts (`origin` literal, additive), user docs,
tool presentation (`t3McpToolPresentation`, so web and desktop label it), handoff analytics
(`INPUT_TARGET_ACTIONS`). Providers: every provider that gets T3's MCP tools; a provider with no
usage limits gets the "no window" refusal. Reverse states: cancel. Connection modes: unchanged,
because it is a server tool. Not applicable: entry points (nothing new in the UI), mobile UI.

**Checks.**

- `vp fmt` and `vp lint` clean on the new files. The three lint errors on touched files are existing
  long comment headers (`queuedMessage.ts`, `QueuedMessageService.ts`), already in `ISSUES.md`.
- `tsc --noEmit` clean in contracts, shared, server, web.
- `vp test run`: 68 passing across `sendLater.test.ts`, `src/queue`, `AgentContextBudget`,
  `toolkits/core`; 4 in `t3McpToolPresentation`; 13 in the eval grader.
- Mutation check: with `createdBy` forced to `user`, the send-as-agent test fails on `createdBy`.

**Not done.**

- **The evals did not run.** There is no `.env` or `ANTHROPIC_API_KEY` here. Both new cases build with
  `--dry-run`, but no model has seen the new description, so whether an agent picks this tool over
  `schedule_task` or `t3_queue` is unmeasured. `--context` shows the tool list is built with it.
- **Not run on a real server or from the official app.** Layers typecheck and the tool test drives the
  real service, but the relaunch thread's boot check is the first real start. No phone was used.

**Open.** Nothing in the official app shows a pending send-later message without asking the agent, and
every way to change that fails the bar. That remains a real gap.

## Item 3 result (2026-10-30 3:55 AM PDT, 10:55Z)

**The row never held attachments.** `onQueueDraft` read only `promptRef`, then `clearComposerContent`
wiped images, files, terminal contexts, review comments, annotations and thread contexts, and
dispatch hard-coded `attachments: []`. So queueing silently lost them, before cancel was ever
involved. Restoring needs the row to carry them, which also makes the send correct.

Decisions:

- **The row carries `attachments` and `context`** (fork migration 8), and dispatch sends them. The
  enqueue claims uploads into the thread's id space, because a pending upload is swept after 24
  hours and a message can wait a week for a weekly reset.
- **The draft clears only after the server accepts the message.** It used to clear first and fire
  and forget, so a failed enqueue lost the text.
- **The client downloads the bytes before it cancels, and restores only on confirmed success.** A
  failed download leaves the message queued, a lost race leaves the composer alone, and nothing has
  to survive the cancel on the server. An attachment that is gone for good does not block the cancel.
- **The cancel removes a pending row's claimed files**, so a cancel by anyone leaves no orphans. A
  failed row keeps them: its send may have reached the thread, which then owns those files.
- **Restore is a function of the thread's draft target, not of the mounted composer.** It works if
  the user navigates away while the cancel runs, and during a queued-run edit or pending question,
  without those modes taking the text.
- **Non-empty composer: append** after a blank line, as stash restore does. Attachments merge up to
  the limit, and anything left out is named in a toast.
- **No second editor.** "Edit message" takes the message back into the composer and the clock picker
  reopens on the same trigger, so a re-queue is two clicks. An in-place editor would need its own
  attachment UI to do the same thing. Cost: the message is unqueued while being edited, but it sits
  in the composer as a persisted draft.
- **Failed rows** get "Edit message" (restores) next to the X (dismisses without restoring). The
  dismiss stays non-restoring because an interrupted send may in fact have gone out.
- **Only the clicking client restores**, from the command's result, never from the stream. So
  another client or an agent cancel touches no draft.
- **Runtime and interaction mode are not restored.** They are thread state, which queueing saves
  (entry C) and the send doesn't replay. Model selection is restored; it is draft state.

**What changed beyond the design.** Attachment-only messages can now be queued, since the clock
button follows the same "has sendable content" rule as send. The clock is hidden during a queued-run
edit, where it would have queued the edit's draft. A cancel that finds the row already cancelled now
fails, so two clients can't both restore. Sent and cancelled rows drop their `attachments_json` and
`context_json`, because `list` returns every status and the snapshot would otherwise grow forever.
Row previews show context labels instead of raw link markup.

**Cases.**

| Case                                  | Behavior                                                                                                          |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Composer already holds a draft        | Draft text first, a blank line, then the message. Attachments merge; any over the limit are named in a toast.     |
| Navigated away while the cancel runs  | Restores into the message's own thread draft, not the thread on screen.                                           |
| Another client, or an agent, cancels  | No draft changes. Restore runs only from the clicking client's command result.                                    |
| Already `sending` or `sent`           | Buttons are gone at `sending`. A click that loses the race gets a failed cancel, a toast, and an untouched draft. |
| Download fails first                  | Nothing is cancelled; a toast says it is still queued.                                                            |
| An attachment is gone for good        | The cancel still goes through and the toast names the file, so a message can't get stuck.                         |
| Failed row                            | Edit message restores it. The X dismisses without restoring. Files stay in both cases.                            |
| Queued-run edit or question on screen | Restores into the thread draft, which shows when that mode ends. Cursor reset is skipped.                         |
| Enqueue fails                         | The draft was never cleared.                                                                                      |
| Draft edited while queueing           | The message queues and the draft stays, with a toast. Duplicated rather than lost.                                |

**Surfaces.** Applied: entry points (`QueuedMessagesPanel` is the only UI that cancels; `UsageStatusBar`
only reads a count), web and desktop (shared code), contracts (additive, optional fields), reverse
states (Edit message and Cancel are the way out of the queue, re-queue is the way back), docs
(`docs/user/thread-sidebar.md`). Connection modes: uploads and downloads use the same paths as send
and paste, so remote works the same, but this is unverified on a real remote. Agents: `t3_send_later`
is unchanged and an agent edits by cancelling and scheduling. Not applicable: providers (dispatch is the
normal path), mobile UI (`apps/mobile` still compiles), keybindings (none exist for the queue).

**Checks.**

- `vp fmt` clean. `vp lint` clean on web files and docs. Four `no-low-value-comments` errors remain on
  the long headers of `queuedMessage.ts`, `ForkMigrations.ts` and `QueuedMessageService.ts`; they
  predate this and are in `ISSUES.md`.
- `tsc --noEmit` clean in server, web, contracts, client-runtime, mobile, desktop.
- `vp test run`: server 49 passing (`src/queue`, `sendLater`, fork migrations, `AttachmentClaims`); web 14
  in `queuedMessageRestore`, plus `queuedMessageEdit` and `composerSend.logic`.
- The seven server attachment tests failed before the service change. Swapping restore and cancel in
  `takeBackQueuedMessage` fails the two ordering tests.

**Not verified.**

- **Not seen in a running client.** Browsers are out of scope here, and the app must not be restarted.
  `useQueuedMessageComposer` and the panel have no test: draft clearing, focus and toasts are checked
  by reading and typecheck only. The first real use is after the relaunch.
- **Migration 8 has not run on real data.** The fork migration test covers a fresh database. The
  relaunch thread's boot check on a copy of `statev2.sqlite` is its first real run.

**Open.**

- A cancel whose response is lost in transit looks like a lost race, though the server did cancel. The
  message then leaves the panel and the composer stays empty. Text survives in the row; attachments
  do not. Rare, and left alone.
- An agent cancel removes the attachments of a message the user queued. An agent has always been
  able to cancel any message in its thread; the attachments are new. Worth a look if it ever bites.
- Failed rows keep their claimed files after a dismiss, since nothing can tell whether the thread
  uses them. A small leak until the thread is deleted, at most.

## Item 4 result (2026-10-30 4:05 AM PDT, 11:05Z)

**Closed.** `master` satisfies the sentence. Checked by reading the code plus a throwaway test feeding
real shell shapes through `presentThreadShell` and `resolveThreadShelf`. One real defect, fixed.

| #   | Check                              | Result              | Proof                                                                                                                                                                                             |
| --- | ---------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Idle thread lands in Scheduled     | Pass, one exception | `threadInbox.ts:42`. Probe: `completed`, `interrupted`, `failed`, `cancelled`, `rolled_back`, and never-ran all give `scheduled`. Exception: an imported thread that never ran (below).           |
| 2   | Working stays Working              | Pass                | `threadInbox.ts:18`. Probe: all five active statuses and parked on awaited background work give `working`. An unawaited dev server gives `scheduled`, which is right.                             |
| 3   | Transitions                        | Fail, then fixed    | `threadInbox.ts`, `eea3dab9a1`. See below.                                                                                                                                                        |
| 4   | Requests and other sections        | Pass                | `threadInbox.ts:47`, `Sidebar.tsx:645` (snoozed, settled and pinned resolve before `inbox`).                                                                                                      |
| 5   | Item 3, `sending`, `t3_send_later` | Pass                | `quota.ts:82` counts only `pending`. Edit and Cancel both go through `cancel`, which publishes (`QueuedMessageService.ts:514`). `t3_send_later` goes through `enqueue`, same upsert, same stream. |
| 6   | Reachability                       | Pass, with a wart   | `Sidebar.tsx:519` jump order, `:544` search, `SettingsPanels.tsx:901` and `settingsSearch.ts:414`.                                                                                                |

**The defect.** Leaving a shelf skipped the 2-second grace for any "actionable" thread, and that test
counts a failed run or a ready plan. Both were already true while the thread sat in Scheduled. So a
message firing on a failed or usage-limited thread, the main case, could put it in the active list
with a return stamp until its run started. Item 1's "a sent message holds its place" was false for
exactly those threads. It needs the queue's `sent` to reach the client before the shell's `queued`
run: they are separate streams with no ordering between them, and the server sends `sent` after the
dispatch commits. So the window is short, and how often the client saw it is unmeasured. Now only a
new request for the user skips the grace. Cost: cancelling on a failed thread returns it after the
grace instead of at once, the same as any other thread.

**`sending` is invisible in normal use.** `claim` publishes nothing, so a client sees `pending` then
`sent` or `failed`. It only sees `sending` in a snapshot taken mid-dispatch, where it correctly counts
as not scheduled. A crash leaves `sending`, which boot retires to `failed`, so the thread leaves.

**Working section off: not a contradiction, left as is.** The sentence describes splitting Working:
idle queued threads get a section, "working threads are in working". With Working off there is no such
split, and the user has opted out of folding threads, so a new collapsed section would hide an idle
thread they asked to keep in view. This user has Working on (`client-settings.json`). The result off
is sensible: the thread stays in the list, the message sends on time, and the panel above the composer
shows it. The row doesn't say Scheduled, because the keys aren't subscribed then. Also, the Legacy
sidebar has no sections at all, so it has neither Working nor Scheduled.

**Wart.** With Working off, a settings search for "Scheduled section" opens a page where that row is
hidden. Left alone: it is one click of no consequence.

**Left open, not defects.**

- A ready plan with a queued message sits in Scheduled, though `resolveThreadShelf`'s comment says a
  request for the user does not stay. The brief names only approvals and questions, and the queued
  message is often the answer to that plan. Moving it is one line if the user wants it surfaced.
- A usage-limited thread with a queued message reads Scheduled, not Limited (`SidebarThreadRow.tsx:743`).
  Failed still shows. Item 1's note that a Limited row "must stay visible" and the docs' "unless it has
  a failure" read wider than the code, but this is the case the row status exists for.
- An imported thread that never ran stays in Working, reading Waiting, with or without a message. It
  predates this work and is not queue-specific. No such thread exists in the live database (0 of 1501).
  Logged in `ISSUES.md`.

**Checks.** `vp fmt` and `vp lint` clean on both touched files. `tsc --noEmit` clean in client-runtime,
web, mobile. `vp test run`: 70 in `threadInbox`, `entities`, `threadShell`; 120 in `Sidebar.logic` and
`Sidebar.drag`; 64 in mobile `threadListV2`. The two new held-message cases failed before the fix.
Read-only query of `~/.t3/userdata/statev2.sqlite` for the count above. Not seen in a running client:
the stream ordering is from reading the server code.

## Item 5 result (2026-10-30 4:20 AM PDT, 11:20Z)

Done: `befbb8ce81` (server), `dce4536401` (web and docs), plus one attachment test with this note. A new
thread's first message can be queued from the composer's clock, with any trigger, and goes out later as
the thread's first turn.

**Confirmed first.** A new thread is a client-side draft. The clock was gated on `isServerThread`. A
first send is not `thread.create` plus a message: it is `orchestration.launchThread`, which owns the
worktree, setup script, branch rename, title seed and Scratch folder. `launch` with
`reuseExistingThread` already accepts an existing empty thread.

**Design: the real thread at queue time, the launch at fire time.** The row carries a spec,
`sendContext.launch` (`projectId`, `title`, `workspaceStrategy`), in the existing JSON column, so no
migration. `enqueue` creates the thread with plain `thread.create`: no run, no worktree, no provider
session. When it fires, a row with a spec on a still-empty thread goes through
`ThreadLaunchService.launch`, otherwise plain `message.dispatch`. This reuses the queue, sidebar and
cancel code unchanged, a send fires with no client attached, and the launch path is the real first
send rather than a copy of it. Keeping it client-side was rejected: a closed client can't fire.

Decisions:

- **Creation happens in `enqueue`, on the server,** not as a client `thread.create` then enqueue, so one
  request does both. A failed insert deletes the thread it just made and releases the claims.
- **While waiting, the thread's `branch` is the base ref,** standing in until the launch records the
  real branch. Same shape as an empty server thread picking a worktree.
- **`checkWorktreeBase` runs at queue time,** so a bad base is refused now, not a week later.
- **The draft is finalized explicitly.** Promotion normally waits for a message or run, which will not
  appear, so it would have stayed on the draft route forever.
- **Reverse state: Cancel or Edit message reopens a draft and deletes the empty thread.** The draft is
  written first, then the thread is deleted, because deleting the thread under its own route navigates
  to `/`. Text, attachments, context, model, worktree or branch choice, runtime and interaction mode,
  and the trigger for the picker all come back. No junk thread and no lost text. It is client-driven
  because only the client holds the bytes; a failed delete leaves an empty thread, which is harmless.
- **The thread stays, and the text goes to its own draft, when:** it has started, another message is
  still waiting on it, or the user navigated away during the take-back (no yanking them to a draft).
- **A second message queued on the thread inherits the spec,** so cancelling the first can't send the
  second at the project root instead of the chosen worktree.
- **Sending directly on the waiting thread uses the queued setup.** `ChatView` reads the pending spec for
  env mode and start-from-origin. Without this it read as Local and ran at the root. The queued
  message then sends as a follow-up, because the fire re-checks that the thread is empty.
- **A title the user changed while it waited is kept** (`generateTitle` only if unchanged).
- **Multiple models: clock disabled.** A row sends once on one model. The docs say so.
- **Runtime and interaction mode come from the thread at fire time,** like every queued message. They
  were set on the thread at queue time, so nothing is lost.

**Checks from the brief.**

- **Same first-send path: pass.** Real orchestrator test: no run or worktree while waiting, then message,
  run, worktree and setup on fire.
- **Worktree timing:** created at fire, never at queue, so it starts from the base as it is then. In
  `docs/user`.
- **Attachments (`1fe8d05411`): pass.** Claimed at enqueue, passed through `initialMessage`. The
  attachment-only prompt is tested. Context records go through the same field; no test of their own.
- **Title:** the seed shows at once, and regeneration runs on fire through `titleSeed`.
- **No provider session:** fine, `launch` starts one. `thread.create` sets `activeProviderThreadId` null.
- **Model:** `sendContext.modelSelection`, asserted in the test.
- **Sidebar: Scheduled, not Waiting in Working.** Runtime is null for a never-run thread (`entities.test`),
  and a shelf test was added. The imported-thread issue does not apply.
- **Auto-settle: holds.** The skip filters by pending row before anything looks at runs.
- **`t3-busy.mjs`: nothing busy by construction.** No run and no request while waiting; script unchanged.
- **Restart:** row and thread are both durable, and a test reads the spec back from storage. Not tested
  across a real restart.
- **Agents: no change.** `t3_send_later` targets a thread that has already run, and `t3_thread_launch`
  covers new threads.

**Surfaces.** Applied: new-thread composer (every entry point, including `/new` links, the sidebar, palette,
project-scoped new thread and keybinding, lands on the one `/draft/$draftId` `ChatView`), web and desktop
(shared), contracts (one optional field), reverse states, user docs. Empty server threads in worktree mode
now keep their worktree too. Providers: all, through the launch path. Connection modes: unchanged, one
server call; not verified on a real remote. Not applicable: mobile UI (`apps/mobile` compiles), MCP and
evals (no model-facing text changed), keybindings (the queue has none).

**Checks run.**

- `vp fmt` clean. `vp lint` clean on web and test files; three `no-low-value-comments` errors remain on
  the long headers of `queuedMessage.ts` and `QueuedMessageService.ts`, already in `ISSUES.md`.
- `tsc --noEmit` clean in contracts, client-runtime, server, web, mobile.
- `vp test run`: server 76 across `src/queue`, `sendLater`, `ThreadSettlementService`; `ThreadLaunchService`
  43; web 160 across `queuedMessageRestore`, `queuedMessageEdit`, `composerSend.logic`, `composerDraftStore`,
  `ChatView.logic`; client-runtime `threadInbox` 46.
- Eight of the nine original `QueuedMessageFirstSend` tests failed before the server change.
- Boot: `src/bin.ts` on an empty isolated `--base-dir` answered `/.well-known/t3/environment` 200, proving
  the new layer dependency resolves. Stopped by the port owner's PID after checking its command line.

**Not verified.**

- **Not seen in a running client.** Browsers are out of scope and the app must not be restarted. The hook
  and `ChatView` wiring have no test: draft promotion on queue, the reopen navigation and focus are from
  reading and typecheck. `ChatComposer.attach.browser.test.tsx` was edited for the removed prop and
  typechecks, but browser tests were not run.
- Not fired against a real provider or a real git repository; the integration test mocks git and uses the
  replay adapter.

**Open.**

- **Changing the worktree toolbar on a waiting thread doesn't change the queued message.** It applies to a
  direct send. Edit message is the way to change the setup, and the docs say so.
- The **X** on a failed first message dismisses it and leaves the empty thread, which then behaves as an
  empty server thread. Failing with the thread still empty needs a disabled provider or similar, so left.
- Deleting a waiting new thread from the sidebar leaves the row to fail at its trigger. That is the
  existing `ISSUES.md` entry.
- A new thread may show in the active list until the queue row arrives, because the shell and queue are
  separate streams. Expected to be about a frame; unmeasured.

## Findings / gotchas

- `d94f7ab701` (relaunch thread) swept in four lines of item 1's `Sidebar.drag.test.ts` from the
  shared tree. Harmless and left as is; it passes with `3c5f230f83`.
- Last watcher run ended 2026-10-27 3:30 PM PDT (22:30Z) by launching; none is running as of
  2026-10-30 3:02 AM PDT (10:02Z).
- The running app's bundles are `c7d2e59252`, older than `master`'s HEAD (build stamp, and the
  `start-t3.ps1 -DryRun` output). No active run is a zombie: every one at 3:06 AM PDT (10:06Z) was
  requested within the previous seven minutes, so `t3-busy.mjs` has nothing stale to wait on forever.
- Use an interval task for the wake-up, never `fixed_time`: `isMissedFixedTimeRun` skips a fixed-time
  run more than 10 minutes late, while an interval run due during downtime fires after boot.
- `t3 thread send` can reach a thread from outside the app, but it was rejected for the wake-up:
  it issues an MCP client session from its own process, which writes to `~/.t3/userdata`.
- Live self-test, 2026-10-30 3:12 AM PDT (10:12Z): a one-minute interval task bound to the relaunch
  thread fired on time and, with that thread busy, queued its prompt as the next turn. Task deleted
  and queued message cancelled afterwards. Firing after a real restart is from the code only.
- A process started through WMI lands in session 1, the same as this shell, so its Notepad window
  is on the user's desktop (tested 2026-10-30).
- Watcher outcomes tested against a stub launcher in `C:\temp`: success, slow backend, failed with
  the app up, failed once with the app down, failed twice with the app down. The real launcher's
  `-NoElevate -DryRun -WaitForIdle` exits 0 and lists the right five processes plus launcher 11888.

- Under vite-plus, `node.exe` is a shim: `Stop-Process` on the PID from `Start-Process` left the real
  server listening under another PID. Stop the port owner as well, after checking its command line.

## Things not to do

- Do not restart or kill the running app, and never write to `~/.t3/userdata`.
- Do not start two watchers.
- Do not relaunch while an item thread runs.
