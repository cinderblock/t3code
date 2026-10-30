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

## Progress

- [x] Item 1: `3c5f230f83`, plus four lines of its drag test that landed in `d94f7ab701`
- [x] Item 2: `t3_send_later` built; evals not run (no API key)
- [ ] Item 3
- [ ] Item 4
- [ ] Item 5
- [ ] Relaunch, confirmed on the new commit

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

## Things not to do

- Do not restart or kill the running app, and never write to `~/.t3/userdata`.
- Do not start two watchers.
- Do not relaunch while an item thread runs.
