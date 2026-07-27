# Usage Meters + Queued Messages

## Goal

Two related features for T3 Code, inspired by the `C:\Users\camer\git\claude-usage` project:

1. **Usage meters** — a single bar across the bottom of the window with ticks/segments
   showing rate-limit usage progress 0–100%. 5-hour and weekly windows kept separate.
   Clicking expands into a chart (historical usage). Architecture must generalize to
   all models/providers and both usage kinds (subscription rate limits vs pay-per-use),
   but v1 only needs Claude (subscription) models.
   - Specialization: when a Fable model is selected, make the Fable bar more prominent;
     otherwise make "All models" more prominent (weekly Claude bars).
2. **Queued messages** — queue a message with an editable trigger:
   - "send when 5h window resets"
   - "send at 3am" (absolute time)
   - "send when weekly usage resets"
   - "send when >20% usage remains before end of this weekly/hourly window"
   - When a usage cap is hit mid-conversation, the pending message should automatically
     convert to a queued message with an editable trigger.

## Environment / context

- Repo: `C:\Users\camer\git\t3code`, branch `debug/crash-investigation` (shared working
  tree — only stage own changes; other threads have uncommitted work in
  `apps/desktop/scripts/start-electron.mjs`, `DesktopApplicationMenu.*`, `pnpm-lock.yaml`).
- Reference project: `C:\Users\camer\git\claude-usage` (how to fetch/model Claude usage).
- Windows 11, pnpm monorepo.

## Decisions already made (don't re-ask)

- 5-hour and weekly meters stay separate (user said so).
- Generalize data model for all models/plans/usage-kinds, but implement Claude-only now.
- Prominence rule: Fable bar emphasized when Fable selected; otherwise "All models"
  emphasized on the weekly Claude bars.
- Click-to-expand chart.
- No `title=` attributes for tooltips (global user rule) — info must be inline/tap-to-expand.

## Architecture (designed 2026-07-24)

### Data source decision

- **Primary: direct `GET https://api.anthropic.com/api/oauth/usage`** (claude-usage
  approach) — only source with per-model scoped weekly windows incl. **Fable**
  (`limits[]` w/ `weekly_scoped` + `scope.model.display_name`), severity, extra_usage.
  The SDK's `usage_EXPERIMENTAL...()` snapshot has fixed keys (opus/sonnet only) and is
  marked unstable. Token from `~/.claude/.credentials.json` (HOME resolved like
  `ClaudeHome.ts`); refresh via `POST console.anthropic.com/v1/oauth/token` with public
  Claude Code client id, atomic write-back (claude-usage proven pattern).
- **Supplementary: ingest the already-emitted `account.rate-limits.updated`** runtime
  event (SDK `rate_limit_event`, currently dropped at `ProviderRuntimeIngestion.ts:623`)
  → used for instant cap-hit detection (status "rejected") to drive auto-queue.

### Layering (all provider-generic at the contract level)

- `packages/contracts/src/usage.ts` (new): `UsageScope` (all-models | model | surface…),
  `UsageWindow { id, kind: "session"|"weekly"|"monthly", scopeKey, scopeLabel, percent,
severity, resetsAt, windowHours, isActive, dollars? }`, `AccountUsageSnapshot
{ providerInstanceId, capturedAt, planLabel?, windows[] }`, plus queued-message
  command/trigger schemas.
- `apps/server`: `ClaudeUsagePoller` service — poll per claudeAgent provider instance
  (keyed by resolved HOME), 120s cadence, exp backoff capped 30min, 429 floor 300s,
  keep last-good, lenient parse (null-tolerant, drop bad limits[] entries, all-dropped
  = failed poll). Persist samples to SQLite (new migration `usage_samples`) for charts.
  Publish snapshot over WS (new method `usage.subscribe` + `usage.history`).
- `packages/client-runtime` + `apps/web`: usage atom; `UsageMeterBar` across the app
  bottom (in `AppSidebarLayout`), segments per window; prominence driven by effective
  composer model (Fable selected → Fable weekly bar prominent, else All-models
  prominent); click expands hand-rolled SVG chart panel fed by `usage.history`.
- Queued messages: orchestration command `thread.message.queue` (+ cancel/update),
  projection table via next migration, `QueuedMessageReactor` (timer + usage-snapshot
  subscriber) dispatches real `thread.turn.start` when trigger fires. Triggers:
  `{ at }` | `{ windowReset: session|weekly }` | `{ headroom: { window, minRemainingPct } }`.
  Auto-convert: on turn failure w/ rate_limit (or rejected rate_limit_event), client
  offers/creates queued message from the failed send with editable trigger.

## Plan / steps

1. [done] Explore both projects.
2. [current] Set up dedicated worktree + feature branch.
3. Contracts: usage schemas + queued-message schemas.
4. Server: usage poller (credentials, fetch, parse, backoff) + samples persistence +
   WS subscribe/history methods. Ingest `account.rate-limits.updated`.
5. Client: atoms + bottom meter bar + prominence + expandable chart (read dataviz
   skill first).
6. Queued messages: command + projection + reactor + composer UI + auto-convert.
7. Tests (`vp check`, `vp run typecheck`, unit tests) + verify in running app.
   Commit at each phase boundary.

## Findings / gotchas

### claude-usage project (reference implementation)

- **Usage endpoint:** `GET https://api.anthropic.com/api/oauth/usage` with headers
  `Authorization: Bearer <accessToken>`, `anthropic-beta: oauth-2025-04-20`, plus a UA.
  Plan tier: `GET https://api.anthropic.com/api/oauth/profile` →
  `organization.rate_limit_tier` (e.g. `default_claude_max_20x` → "Max 20x").
- **Auth:** reuses Claude Code's OAuth token — Windows: `~/.claude/.credentials.json`
  (`{ claudeAiOauth: { accessToken, refreshToken, expiresAt(ms), ... } }`).
  Token refresh: `POST https://console.anthropic.com/v1/oauth/token` with
  `{ grant_type: "refresh_token", refresh_token, client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e" }`
  (public Claude Code client id); write rotated token back atomically.
  Prefer NOT refreshing ourselves if t3code already manages tokens — check.
- **Response shape (lenient parse!):**
  - `five_hour` / `seven_day`: `{ utilization, resets_at }` (legacy scalars; may be null)
  - `limits[]`: `{ kind: "session"|"weekly_all"|"weekly_scoped", group, percent,
severity: "normal"|"warning"|"critical"|"exceeded", resets_at,
scope: null | { model: { id, display_name: "Fable"|"Opus"|"Sonnet" }, surface }, is_active }`
    — `scope: null` = all-models. Malformed entries should be dropped individually;
    explicit JSON `null` on scalars must parse as default (degraded backend nulls fields).
  - `extra_usage`: `{ is_enabled, monthly_limit, used_credits, utilization, currency,
decimal_places }` — amounts in integer minor units. Visibility must derive from
    dollar figures, NOT `is_enabled` (API flips is_enabled=false when pool exhausted!).
    No reset timestamp → anchor to calendar month (UTC).
- **Statuses/colors:** ok green `#3fb950`/(46,160,67), warn amber, crit red; worst-of
  across windows for aggregate. "all" scope colored green, models cycle a palette.
- **Polling:** 120s default (floor 30s), exponential backoff ×2 capped 30min,
  429 → max(backoff, Retry-After, 300s); persist cooldown across restarts so
  relaunch doesn't hammer. Keep last-good snapshot on error; if `limits` parses
  empty, treat as failed poll (don't publish empty snapshot).
- **`resets_at` jitter:** ±1min wobble between polls of same window; tolerate ~10min
  jitter when grouping window instances.
- **Charts:** hand-drawn SVG; usage line + dashed even-pace diagonal + projection
  line + "now" marker; weekly charts share one 7-day axis for all+per-model series.

## Implementation map (what was built where)

- Contracts: `packages/contracts/src/usage.ts` (UsageWindow/AccountUsageSnapshot/stream
  events/history), `packages/contracts/src/queuedMessage.ts` (QueuedMessage, triggers:
  at | window-reset | headroom); wired into `index.ts` + `rpc.ts` (WS methods
  `usage.getHistory`, `subscribeAccountUsage`, `queue.*`, `subscribeQueuedMessages`).
- Server: `apps/server/src/usage/ClaudeUsageApi.ts` (credentials read/refresh w/
  atomic write-back, lenient parser — pure & unit-tested), `usage/UsageBroadcaster.ts`
  (per-account poll loop keyed by resolved Claude HOME, 2min cadence, backoff,
  last-good retention, SQLite samples + 90d retention, PubSub stream),
  `queue/QueuedMessageService.ts` (SQL store + pure `isTriggerDue` + 15s reactor
  dispatching real `thread.turn.start`). Migrations 033 (usage_samples),
  034 (queued_messages). Ingestion case added for `account.rate-limits.updated`
  (was silently dropped) → thread activity, tone error on status "rejected".
  Layers wired in `server.ts` (NOTE: pipe() maxes at 20 args — fold new layers
  into existing mergeAll slots!). ws.ts handlers + scopes. server.test.ts mocks.
- Client: `packages/client-runtime/src/state/usage.ts` (projection folds + atoms;
  subpath export added to package.json; tags added to `rpc/client.ts`
  EnvironmentSubscriptionRpcTag), `apps/web/src/state/usage.ts`.
- Web UI: `components/usage/usagePresentation.ts` (pure helpers; validated palette
  slots — all=blue #2a78d6/#3987e5, Fable=green #008300, Opus=magenta, Sonnet=yellow),
  `UsageStatusBar.tsx` (fixed bottom strip 24px, per-window meters, severity colors,
  Fable-vs-all weekly emphasis from sticky composer model, click → expanded panel),
  `UsageHistoryChart.tsx` (SVG lines + pace diagonal + now marker + crosshair).
  Shell integration: `AppSidebarLayout.tsx` + `ui/sidebar.tsx` reserve the strip
  via `--app-statusbar-height`.
- Queued-message UI (built by subagent): `chat/QueuedMessageTriggerPicker.tsx`,
  `chat/QueuedMessagesPanel.tsx`, ChatComposer queue button (`onQueueDraft`),
  ChatView auto-convert on cap hit (rejected rate-limit activity + errored turn →
  auto-enqueue with `origin: "cap-hit-auto"`, dedup per turn). Its notes:
  `plans/queued-messages-ui.md`.

## Findings (gotchas hit during implementation)

- Repo lint (tsgo effect plugin) BANS in server code: `new Date()`, `Date.now()`
  (use `DateTime.now`/`Clock.currentTimeMillis`/`DateTime.makeUnsafe(ms)`),
  `JSON.parse/stringify` (use `Schema.fromJsonString(schema)` /
  `Schema.UnknownFromJsonString` codecs), try/catch in Effect.gen.
- `pipe()` accepts max 20 args — exceeding silently collapses types to
  never/any and the errors surface FAR away (bin.ts/cli). Both server.ts and
  server.test.ts hit this; fixed by folding layers into Layer.mergeAll slots.
- `Layer.mock(Service)({...})` is the test-stub idiom in server.test.ts.
- Shared tree: `server.ts`, `ws.ts`, `server.test.ts`, `Migrations.ts`,
  `ProviderRuntimeIngestion.ts` also carry ANOTHER thread's uncommitted edits —
  stage hunks carefully, never whole-file `git add` on those.

## Progress log

- [x] Exploration
- [x] Design
- [x] Contracts
- [x] Usage backend (poller, persistence, WS, ingestion)
- [x] Meter UI + chart (palette validated via dataviz validator)
- [x] Queued messages (server + UI + auto-convert)
- [x] Unit tests: 27 server + 14 web, all passing
- [x] Typecheck: contracts ✓, client-runtime ✓, web ✓; server re-running after
      pipe-arity fix
- [x] Server smoke test: headless `node src/bin.ts serve --port 39371` with scratch
      `T3CODE_HOME` — migrations 1–34 ran, server listening; awaiting first poller
      samples in scratch DB (proves credentials→fetch→parse→persist).
- [x] Lint: only 2 findings in my files (both fixed); remaining lint errors live in
      desktop files owned by another thread. `vp fmt` run.
- [x] Live poller confirmed end-to-end: smoke server first got HTTP 429 from the
      usage endpoint (account throttled — poller backed off with the 5-min floor
      as designed), then on retry fetched and persisted real samples:
      session:all 25%, weekly:all 19%, **weekly:model:Fable 35%**.
- [x] Committed as `9512c06b1` on `debug/crash-investigation` (32 files, staged
      only feature files; desktop files / pnpm-lock / lefthook.yml / other
      plans/\* left untouched for their threads).

## Status: DONE (v1)

Not yet visually verified in the running desktop app (didn't want to fight the
user's live instance); typecheck/lint/unit tests/live server smoke all green.

## Open questions for the user

1. The commit sits on `debug/crash-investigation` (branch switching in the shared
   tree would disrupt other threads). Say the word and it can be cherry-picked to
   a proper feature branch.
2. Headroom trigger semantics were interpreted as "burn capacity that would
   otherwise expire": fire when ≥N% remains AND the reset is within `leadMinutes`
   (default 60). Both knobs are editable in the trigger picker — adjust if you
   meant something different.

## Open questions for the user

(none yet)

## Things not to do

- Don't use HTML `title=` attributes anywhere.
- Don't touch other threads' uncommitted changes; stage only my own files.
