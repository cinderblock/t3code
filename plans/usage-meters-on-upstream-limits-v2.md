# Usage meters, round 2: fold into upstream's usage-limits UI, fix cadence and theming — 2026-10-23

## Goal

The user asked (2026-10-23) to rework the fork's usage meters onto upstream's
"new-ish" usage-limits machinery:

- **Keep**: the usage-over-time history charts, and the meters visible on threads
  (the strip under the composer in `ChatView`).
- **Unify**: reuse upstream's components / helpers instead of a parallel fork stack
  wherever the behaviour is the same.
- **Fix three bugs**:
  1. Checks too often at times and overloads backend (provider) limits.
  2. Does not check when no commands are being sent, so it goes stale.
  3. Colours ignore T3's theme system (hardcoded hexes / Tailwind palette).

Predecessor: [`quota-on-upstream-limits.md`](./quota-on-upstream-limits.md) (2026-09-10)
already moved the data source to `ServerProvider.usageLimits` and deleted the fork's
own OAuth poller. This round is about cadence, staleness, theming and UI reuse.

## Environment / context

- Shared checkout `C:\Users\camer\git\t3code`, branch `master`. Untracked files from
  other threads at start: `.claude-work-test/`, `apps/server/.claude-work-test/`,
  `lefthook.yml`, `plans/git-layer-native-binding.md`, `plans/multi-window-support.md`.
  Never stage those.
- Fork files in scope:
  - server: `apps/server/src/quota/UsageHistoryRecorder.ts` (samples
    `fork_usage_samples` whenever an instance's `usageLimits.checkedAt` advances)
  - contracts: `packages/contracts/src/quota.ts` (history RPC types)
  - client-runtime: `packages/client-runtime/src/state/quota.ts`
  - web: `apps/web/src/state/quota.ts`, `apps/web/src/components/quota/{UsageStatusBar,UsageHistoryChart,usagePresentation}.ts(x)`
  - queue feature consumes the same accounts (`apps/server/src/queue/QueuedMessageService.ts`)
- Upstream usage-limits pieces (in tree, merged through 2026-10-18):
  - contracts `packages/contracts/src/providerUsageLimits.ts`
  - Claude probe: `ClaudeProvider.ts` runs SDK `get_usage`
    (`usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`) inside the capabilities probe
  - UI: `apps/web/src/components/usage/UsageLimits.tsx` (`LimitWindows`, `barColor`,
    `PaceIcon`), `UsageLimitsPooled.tsx`, `UsagePage.tsx`,
    `components/chat/ComposerUsageLimits.tsx` + `useUsageLimitsPanel.ts` (`/usage-limits` banner)
  - colours: `components/usage/usageProviders.ts` `PROVIDER_PRESENTATION`
  - theme roles: `packages/shared/src/themePalettes.ts` `THEME_COLOR_ROLES`
    (accent, warning, error, muted, … — no categorical chart palette)
- Live data: `~/.t3/userdata/statev2.sqlite` (read-only only!), traces
  `~/.t3/userdata/logs/server.trace.ndjson*` (rotate every few minutes).

## Findings / gotchas

### Cadence evidence from the live DB (read-only query, 2026-10-23)

`fork_usage_samples` for `claudeAgent` since 2026-10-21: 422 distinct `checkedAt`s.

- Steady ~5-minute spacing while the app is in use (the `providerHealthRefreshInterval`
  probe).
- **125 of 422 samples are < 60 s after the previous one**, several 1–14 ms apart with
  _different_ values — turn-time sparse `rate_limit_event` updates merging on top of
  probe results (e.g. `seven_day_fable` 86 → 87 → 87 within 2 ms).
- **Multi-hour holes**: 06:28→08:53Z and 09:13→19:28Z on 10-23 (11:28 PM→1:53 AM and
  2:13 AM→12:28 PM PDT). Nothing refreshed while idle → stale meters (bug 2).

### Client-triggered `server.refreshProviders` — not the overload

Traces from ~12:09–1:09 PM PDT 10-23 hold 17 `server.refreshProviders` RPCs from the
desktop renderer, some 5 s apart. They come from
`ChatComposer.useProviderWorkspaceSnapshotRefresh` (`instanceId` + `cwd`), which runs
`probeClaudeWorkspaceSnapshot` with `includeUsage = false` (`ClaudeProvider.ts:457`).
**They never call `get_usage`.** Ruled out.

Same window: `checkClaudeProviderStatus` ran every ~5 min (12:28, 12:33, … 1:09 PM PDT),
each followed by one `readClaudeResetCredits`; one tick skipped 12:53→1:03 (lease not
foreground). Live settings: `backgroundActivity` = custom on `balanced` → 5-min
interval; only one Claude instance enabled; no usage hub source configured. So _right
now_ the steady load is one `get_usage` + one reset-credits read per 5 min.

### Upstream refresh machinery (full map from an Explore pass, line refs in tree)

- **One loop per instance** (`packages/provider-core/src/server/managedProvider.ts:259-286`):
  sleep `providerHealthRefreshInterval`, then a **full** re-probe (version, init,
  `get_usage`, skills, reset credits) only if `BackgroundPolicy` sees a `provider-status`
  lease. There is no usage-only refresh.
- **The gate** (`apps/server/src/background/BackgroundPolicy.ts:128-179`): on balanced,
  a lease counts only if the window is `visible && (focused || recentlyInteracted)`.
  Web reports every 25 s with a 45 s TTL (`apps/web/src/lib/backgroundActivityReporter.ts`).
  **A visible-but-unfocused window (second monitor) does not count → no probes.**
- **No catch-up**: regaining a lease does not probe; data waits up to a full interval.
  A turn ending never re-probes. Turn-time `rate_limit_event`s only touch the windows
  they name. → **Bug 2.**
- **Claude capabilities cache** (`ClaudeDriver.ts:67, 200-251`, 5-min TTL, success only)
  reuses the cached `get_usage` result, but `checkClaudeProviderStatus` stamps
  `checkedAt = now` (`ClaudeProvider.ts:489, 646-653`) and
  `resolveUsageLimitsAfterProbe` (`provider-core/src/server/usageLimits.ts:101-110`) lets
  the probe overwrite the published snapshot unconditionally. **A cached probe can
  overwrite newer turn-driven windows with older numbers, labelled fresh.** This matches
  the 1–14 ms sample pairs with _different_ values in the DB (e.g. 10-21 03:12:03Z
  `seven_day_fable` 77 then 78) and draws sawtooth noise into the history charts.
- **No coalescing / floor for usage reads**: `refreshInstance` runs N concurrent calls as
  N probes; a failed `get_usage` earns no TTL so every refresh re-hits the endpoint; no
  server-side minimum spacing. Other full-refresh triggers: Usage page (5-min client
  throttle `refreshUsageLimits` in `packages/client-runtime/src/state/usage.ts:46-77`),
  mobile widget (`apps/mobile/src/widgets/useSubscriptionUsage.ts`: mount, every
  foreground, every 5 min — separate throttle), settings refresh buttons, onboarding.
  → most plausible shape of **bug 1**: bursts from several clients/triggers stacking,
  plus retries with no floor while the endpoint is already 429ing.
- Web drops pushes that only move `checkedAt` for `providersIgnoringCheckedAtAtom`
  consumers; the strip reads `primaryServerProvidersAtom` (raw), so it does see them.
- The strip reads the **primary** environment only — wrong for threads on remote hosts.

### "This account has no subscription limits" — the symptom the user actually sees

User, 2026-10-23: overload not seen much lately; _more often "this account has no limit"
or stale numbers from hours ago._ That text is `limitsNotice` for
`unavailable.reason === "unsupported"`, which **clears the bars**. Claude maps a
`get_usage` response with `rate_limits_available: true` but `rate_limits: null` (the CLI's
own read of the claude.ai usage endpoint failed, e.g. 429) to `unsupported` on our master.
Upstream fixed this in **`2b6c291be9` (#18624, 2026-10-20)**, which landed after our
10-18 merge base → `probeFailed`, which keeps the last good bars. Cherry-pick it.

### The Claude capabilities cache already floors `get_usage`

`ClaudeDriver.ts` caches the whole capabilities probe (including `get_usage`) for 5 min
whenever the probe itself succeeds, even if the usage read inside it failed. So repeated
refreshes cannot re-hit the usage endpoint more than once per 5 min per instance unless
the whole probe fails. The "usage-read floor" idea was dropped as YAGNI.

## Decisions already made (don't re-ask)

- Normal meter fill = theme accent (`primary`); warning/critical = theme `warning` /
  `destructive`. (User, 2026-10-23.)
- Server fixes land as fork commits only; **no upstream PRs in this rework** — suggest
  them at the end. (User, 2026-10-23.)
- Bars keep filling with _used_ % (decision from the 09-10 round).

## Design

Server:

0. Cherry-pick upstream `2b6c291be9` (available-but-null → `probeFailed`).
1. **Honest `checkedAt` for cached usage**: the Claude capabilities probe records when
   `get_usage` actually ran; `checkClaudeProviderStatus` stamps usage limits with that
   time; `resolveUsageLimitsAfterProbe` keeps published windows that are newer than the
   probe's read (a turn update after the cached read wins).

Web (fork strip):

3. **Fresh while on screen**: when the strip is rendered and the document is visible
   (focus not required), and the shown account's `checkedAt` is older than the
   environment's refresh interval + 1 min grace, request a refresh through upstream's
   `refreshUsageLimits` throttle (shared with the Usage page, 5-min floor). Also fires
   on `visibilitychange` → immediate catch-up after idle. Server ticks keep `checkedAt`
   fresh while focused, so this only fills the gaps.
4. **Show staleness**: "updated 3 min ago" (local time on hover/expand), meters dim
   when older than 2× interval.
5. **Follow the thread**: strip reads the active thread's environment and puts the
   selected provider instance's account first (same selection rule as upstream's
   `/usage-limits` panel), instead of the primary environment.
6. **Reuse upstream helpers/UI**: `formatResetsIn`, `paceOf`/`elapsedShare` (even-pace
   tick on each meter, as upstream's bars draw), `limitsNotice`; reset credits and the
   "Manage usage" link from upstream's `ResetCredits` in the expanded panel.
7. **Theme colours**: severity from theme roles (`warning`, `error`/`destructive`),
   tracks on `muted`/`border`, chart lines/legend from theme roles; drop the hardcoded
   hex slots and Tailwind `red/amber/blue-500`.

## Progress log

- [x] Read predecessor plans and the fork's current meter code.
- [x] Measured live sample cadence (read-only).
- [x] Mapped every upstream path that triggers a usage probe.
- [x] User answered the open questions (2026-10-23).
- [x] Server 0: cherry-picked upstream #18624 → `54d6c82729`.
- [x] Server 1: honest `checkedAt` for cached Claude usage + newer-wins merge →
      `a67e168676` (tests: provider-core `usageLimits.test.ts`, server
      `ProviderRegistry.test.ts` "dates usage limits by when the cached probe read them").
- [x] Web 3–7 in one commit → `44a971ef77`: on-screen refresh
      (`components/quota/useUsageAutoRefresh.ts`), staleness dim + age, thread-environment
      accounts/queue (`usageAccountsAtom`, `usageWaitingDriversAtom`, `queuedMessagesAtom`
      families), theme colours, upstream pace mark / `formatResetsIn` / `ResetCredits`.
      Also fixed `windowScopeName` for upstream's `Weekly · <model>` labels and the
      pre-existing lint errors in `QueuedMessagesPanel` / strip / chart.
- [x] Recorder doc comment refreshed → `0aa9731857`.
- [x] Checks: server + web + provider-core typecheck clean; targeted lint clean; tests
      green (claudeUsageLimits 8, provider-core usageLimits 6, ProviderRegistry Claude 19,
      web quota 25).
- [x] Desktop rebuild: `-BuildOnly` refuses while the app runs ("Pre-warming now would
      swap the web chunks out from under the running app"), so it went through
      `scripts/restart-t3-when-idle.ps1` (started via WMI). All threads went idle and it
      rebuilt from `01680c2919` and relaunched at 2026-10-23 5:04 PM PDT (00:04Z). Run log:
      `C:\temp\t3runs\20261023-170231\launcher.log`. The watcher is one-shot and has exited.
- [ ] Integrated pass in a real client — needs the user's OK (AGENTS.md: ask before
      browsers / computer use), or the user looks at the strip in the running app.

## Findings during implementation

- `windowScopeName` returned the whole label for scoped windows, and upstream's Claude
  mapper now labels them `Weekly · Fable`. So the short label rendered as
  `Week · Weekly · Fable`, and `emphasizedWeeklyWindowId` never matched the selected
  model. Fixed by taking the text after the last `·`.
- The queue panel and the composer's queue picker read the **primary** environment even
  though `ChatView` enqueues to the thread's environment, so a remote thread's queued
  messages never showed. Fixed alongside the env-keyed atoms.
- `exactOptionalPropertyTypes` rejects `usageReadAt: string | undefined` on the probe
  type; the timestamp is built inline inside the `usage ?` spread instead.

## Follow-ups to suggest (not done, per user)

- Upstream PR candidates: the cached-usage `checkedAt` fix (`a67e168676`) is
  upstream code (`ClaudeProvider.ts`, `ClaudeDriver.ts`, provider-core `usageLimits.ts`)
  and fixes a real upstream bug.
- Upstream also has a "catch-up" gap of its own: regaining a foreground lease never
  probes (`managedProvider.ts` loop just sleeps). A server-side catch-up would help
  every client, but it's a bigger upstream change.
- Fork's queued messages vs upstream's `UsageLimitRecoveryWorker` (auto-resume after a
  usage-limit failure) overlap in purpose; unifying them is a separate task.
- Mobile has no fork strip; it shows upstream's composer `/usage-limits` panel only.

## Open questions for the user

1. OK to do one integrated pass in a real client (`test-t3-app`)? Otherwise restart the
   desktop app after the build finishes and check the strip yourself.

## Things not to do

- Don't open the live `statev2.sqlite` read-write or start a server against it.
- Don't add a fork-side poller of the Anthropic usage endpoint again (see
  `quota-meter-rate-limited.md`: shared per-account budget, 429s).
- Don't touch upstream's `components/usage/*` beyond what reuse needs.
