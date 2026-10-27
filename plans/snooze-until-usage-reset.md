# Snooze until usage reset, and send-later on resets

## Goal

User request (2026-10-27):

1. Two new quick snooze presets for threads: **after the next 5-hour reset** and
   **after the next weekly reset**.
2. "Send this message later" — at a time, or after one of the resets — so a message
   waits for fresh quota instead of burning what is left of the current window.

## Findings

- **Item 2 already exists on web/desktop.** The fork's queued-messages feature
  (`plans/usage-meters-and-queued-messages.md`, `plans/queued-messages-ui.md`) puts a
  clock button left of Send in the composer (`ChatComposer.tsx`, "Queue message to send
  later"). Its picker (`QueuedMessageTriggerPicker.tsx`) offers: when the 5-hour window
  resets, when the weekly window resets, at a specific time, and a headroom trigger. The
  server (`apps/server/src/queue/QueuedMessageService.ts`) holds and dispatches them.
  The button only shows for server threads (not a local draft thread) and is disabled
  with an empty prompt.
- **Mobile has no send-later UI.** The mobile `queuedMessage` references are upstream's
  queued-turn feature, not this one.
- Snooze presets are pure, client-side, and resolve to an absolute `snoozedUntil`:
  `packages/client-runtime/src/state/threadSettled.ts` `resolveSnoozePresets(now)`.
  A reset time is known up front (`ServerProviderUsageWindow.resetsAt`), so a reset
  preset is just another absolute time; no server change needed.
- Web call sites of presets: `SidebarThreadRow.tsx` (row clock menu), `Sidebar.tsx`
  (row context menu and multi-select context menu), `useThreadActionMenu.ts` (chat
  header / palette menu). Mobile: `threadListV2.ts` + `thread-list-v2-items.tsx`.

## Decisions

- The reset times come from the thread's own provider instance
  (`thread.modelSelection.instanceId`), freshest limits across instances on the same
  login. A thread on a provider with no published reset hides the presets.
- Account-wide windows only (`five_hour`, `seven_day`), not model-scoped weeklies.
- Presets are hidden when `resetsAt` is missing or already past.
- Multi-select: offered only when every selected thread resolves to the same reset time.

## Progress

- [x] Shared helper + presets in client-runtime, tests
      (`usageResetsForInstance` in `client-runtime/state/quota.ts`; `windowScopeName` moved
      there from web `usagePresentation.ts` so mobile can share it)
- [x] Web call sites: row clock menu, row context menu, multi-select menu, chat action menu
- [x] Mobile list row snooze menu (string-valued atom so rows re-render only when a reset moves)
- [x] User docs: `docs/user/thread-sidebar.md` "Snooze until later"
- [x] Typecheck (client-runtime, web, mobile), focused tests, lint, commit

## Gotchas

- `vp run check:changed` dies with `spawn ENAMETOOLONG` on this fork: it diffs against
  upstream `main`, so the whole fork counts as changed. Run `vp fmt`/`vp lint` on the
  touched files and `tsc --noEmit` per package instead.
- `apps/web/node_modules/.bin/tsc` is a stale September shim pointing at the removed
  `typescript@7.0.2`, so `vp run --filter @t3tools/web typecheck` fails. Use
  `../../node_modules/.bin/tsc --noEmit` from `apps/web`.
- `useThreadActionMenu.test.ts` was already failing on master: the thread-priority merge
  added `readEnvironmentSupportsPriority` without updating the test's mock. Fixed
  separately in `d0e1c75bec`.
- Two `no-low-value-comments` lint errors in `usagePresentation.ts` predate this work.

## Not covered

- Agents (MCP snooze tool) still take an absolute time only; no "until reset" shorthand.

## Open questions for the user

1. Port send-later to mobile? (Not started; bigger job.)
