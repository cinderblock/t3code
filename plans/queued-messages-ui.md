# Queued Messages UI (chat view)

## Goal

User-facing UI for the already-implemented queued-messages backend/state layer:
queue a composer draft to send later (window reset / specific time / headroom),
list + edit + cancel pending/failed queued messages per thread, and auto-convert
a rate-limit-rejected turn into a queued message.

## Files (this task's changes — do not commit alongside other threads' work)

- `apps/web/src/components/chat/QueuedMessageTriggerPicker.tsx` (new) — shared
  trigger form (`QueuedMessageTriggerForm`), `describeQueuedMessageTrigger`,
  `resolveQueuedMessageAccountKey`.
- `apps/web/src/components/chat/QueuedMessagesPanel.tsx` (new) — per-thread rows
  above the composer; Edit trigger (popover) + Cancel for pending, dismiss for
  failed. Reads `primaryQueuedMessagesAtom`/`primaryAccountUsageAtom`/
  `primaryEnvironmentIdAtom`; dispatches update/cancel commands.
- `apps/web/src/components/chat/ChatComposer.tsx` — clock icon button next to
  send (server threads only, needs draft text) opening the trigger popover; new
  required prop `onQueueDraft(trigger)`.
- `apps/web/src/components/ChatView.tsx` — `onQueueDraft` handler (enqueue +
  clear draft, mirrors onSend's send-context/id generation); auto-enqueue effect
  on cap hit (latest turn `error` + `account.rate-limits.updated` activity with
  `status: "rejected"`, guarded per-turn via ref + pending-duplicate text check,
  `origin: "cap-hit-auto"`, weekly window when rateLimitType contains
  `seven_day`); renders `QueuedMessagesPanel` above `ComposerBannerStack`.

## Findings / gotchas

- **Pre-existing contract gap (not fixable from apps/web):**
  `EnvironmentSubscriptionRpcTag` in `packages/client-runtime/src/rpc/client.ts`
  is missing `WS_METHODS.subscribeAccountUsage` and
  `WS_METHODS.subscribeQueuedMessages`. This makes
  `packages/client-runtime/src/state/usage.ts` (4 errors) and
  `apps/web/src/state/usage.ts` (2 errors) fail typecheck — the subscription
  value type falls back to the VCS snapshot union member. Both files are
  untracked work from the state-layer thread. Fix belongs in client-runtime.
- Web-app typecheck (`pnpm run typecheck` in apps/web): only those 6
  pre-existing errors remain; none in the files above.
- Auto-enqueue is conservative: requires the thread's latest user message's
  `turnId` to equal the failed turn's id, and the rate-limit activity's
  `turnId` to be null or match; otherwise skips.
- Queue affordance is hidden for local draft threads (no server thread id yet).

## To-do / open

- [ ] Fix the subscription-tag gap in client-runtime, then re-run typecheck.
- [ ] Runtime verification once the backend thread's work is in place.
