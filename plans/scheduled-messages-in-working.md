# Threads with send-later messages count as in progress

## Goal

User request (2026-10-27): an option that marks threads with queued (send-later) messages
as "in progress", without counting them as busy, so a pending message never holds off the
idle restart that applies a T3 Code update.

## Environment / context

- Send-later messages: the fork's queued-message feature. Server store
  `apps/server/src/queue/QueuedMessageService.ts`, outside the orchestration event source;
  contracts `packages/contracts/src/queuedMessage.ts`; client RPC atoms
  `packages/client-runtime/src/state/quota.ts` (`createUsageEnvironmentAtoms`); web
  `apps/web/src/state/quota.ts` `queuedMessagesAtom(environmentId)`. Mobile has none of this yet.
- Not to be confused with upstream's composer follow-up queue or mobile's offline outbox
  (`apps/mobile/src/state/use-thread-outbox.ts`, `queuedThreadKeys`).
- "In progress" in the sidebar = the **Working** section (beta, on by default), decided by
  `isThreadWorking` + `createInboxReturns().observe()` in
  `packages/client-runtime/src/state/threadInbox.ts`; web `Sidebar.tsx`
  `partitionSidebarThreads`, mobile `threadListV2.ts` / `useThreadListV2.ts`.
- Restart busy checks: `scripts/t3-busy.mjs` (used by `restart-t3-when-idle.ps1` and
  `start-t3.ps1 -WaitForIdle`) counts only projection runs in active states and pending
  runtime requests. `ProviderAutoUpdater` uses provider sessions. Neither reads sidebar
  placement or the queue store, so a client-side mark cannot block a restart.

## Decisions

- Client setting, per device like the Working section it extends: web `ClientSettings`
  `sidebarScheduledMessagesWorking`, mobile preference `scheduledMessagesWorking`.
  Default on (fork-only feature, the user asked for it).
- Placement only, plus a "Scheduled" row status so it is clear why the thread is there.
  No run, runtime state or server state is created.
- A pending approval, question, subagent request or guest request still sends the thread
  back to the active list. A failed or usage-limited run does not (an auto-queued message
  after a cap hit is the main case this exists for).
- Only `pending` queue rows count (not sending/sent/failed/cancelled).
- Snoozed, settled, pinned threads keep their sections.

## Plan

1. client-runtime: `observe(threads, isScheduled?)`, helper, tests.
2. contracts: client setting.
3. web: scheduled thread keys atom, Sidebar partition, row status, settings row.
4. mobile: queue subscription atoms, list placement, row status, settings row.
5. docs/user, checks, commit.

## Progress

- [x] client-runtime: `isThreadWorkingOrScheduled`, `observe(threads, isScheduled)`,
      `scheduledThreadKeys`; tests in `threadInbox.test.ts`
- [x] contracts: `ClientSettings.sidebarScheduledMessagesWorking` (default true)
- [x] web: `scheduledThreadKeysAtom` (subscribes only when the option and Working section are
      on), Sidebar partition, row status "Scheduled" (clock), settings row + search entry
- [x] mobile: `apps/mobile/src/state/scheduled-messages.ts` (own queue subscription, per-row
      boolean atom), list placement, row status, settings switch, preference
- [x] docs/user/thread-sidebar.md; typecheck contracts/client-runtime/web/mobile/desktop;
      focused tests; lint (only pre-existing errors); committed
- [ ] Not yet seen in a running client

## Gotchas

- `DesktopClientSettings.test.ts` "saves through a symlinked client settings file" fails on
  Windows regardless (already in ISSUES.md).
- `packages/contracts/src/settings.ts:269` `no-low-value-comments` predates this work.

## Not covered (follow-ups)

- Server auto-settle (`ThreadSettlementService.isAutoSettlementCandidate`) does not know
  about send-later messages, so a thread idle 3 days with a weekly-reset message can still
  auto-settle; sending the message brings it back.
