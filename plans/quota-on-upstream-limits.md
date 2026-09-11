# Quota meter on upstream's usage limits + open review items — 2026-09-10

## Goal

1. Keep the fork's **in-session usage view** (the always-visible meter strip under the
   composer that expands into history charts) but drive it from **upstream's usage-limits
   data** (`ServerProvider.usageLimits`, the Limits tab's model) instead of the fork's own
   Claude OAuth poller. Retire `ClaudeUsageApi` + `UsageBroadcaster`. Bonus: the strip
   becomes provider-generic (Codex windows show up too).
2. Fix the items still open from [`fork-divergence-review.md`](./fork-divergence-review.md).

## Environment / context

- Shared checkout `C:\Users\camer\git\t3code`, `master` = `f1693ddea` at start. **Another
  session has uncommitted sidebar work** (`Sidebar*.ts*`, `uiStateStore*.ts`,
  `docs/user/thread-sidebar.md`, `plans/sidebar-host-filter.md`) — never touch or stage those.
- Upstream data flow (verified): adapters emit `account.rate-limits.updated` during turns
  (sparse window updates); the capabilities probe runs the SDK `get_usage` for a full read,
  and `makeManagedServerProvider` re-probes every `providerHealthRefreshInterval`
  (**default 5 min**, `DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL`) when background policy
  allows. Windows: Claude `five_hour` (session), `seven_day` (weekly), `seven_day_<model>`
  (model-scoped weekly, label = model display name); Codex ids per its own mapper. Client
  gets them on the server-config subscription (`primaryServerProvidersAtom`).
- Upstream helpers to reuse: `providersWithLimits`, `limitsNotice`, `paceOf`,
  `remainingPercent`, `formatResetsIn` (`@t3tools/shared/usageLimits`).

## Decisions

- **Keep the fork's presentation semantics** (bars fill with _used_ %, session + weekly
  emphasis by selected model, expand-to-chart) — that is the view the user likes. Upstream's
  Limits tab shows _remaining_; the two coexist.
- **No fork polling.** 5-min probe + turn events is the cadence. History is sampled from
  upstream's published snapshots whenever `checkedAt` changes.
- **Account identity = provider instance.** History rows key on `instanceId`; the UI groups
  instances into accounts by `(driver, auth.email)` like upstream's `collectLimitAccounts`.
  Old sample rows keyed by Claude home path become orphans and age out (90-day retention).
- **Queued-message triggers** keep their shape; `windowId` becomes the provider window id
  (`five_hour`, `seven_day`) with the legacy `session:all` / `weekly:all` still accepted by
  kind, so already-queued messages keep firing.
- Review items that the rewrite makes moot: F5 (history atom key storm), F9 (credentials
  file), F10 (raw error text). F19 (elevated launcher) is left as a question for the user.

## Plan / steps

### A. Server

1. [x] `quota/UsageHistoryRecorder.ts` — subscribe `ProviderRegistry.streamChanges`; for each
       provider with usable `usageLimits`, insert samples when `checkedAt` advances; 90-day
       retention; `getHistory` with `since` default 7 days and `LIMIT` (F25).

2. [x] Delete `ClaudeUsageApi*`, `UsageBroadcaster*`; fork migration 004 drops
       `fork_usage_snapshots`; migration 005 removes stale fork rows from
       `effect_sql_migrations` (F15).

3. [x] `QueuedMessageService`: read limits from `ProviderRegistry`; legacy window-id mapping;
       F6 per-row decode (bad rows marked failed), F7 `sending` claim state + restart sweep,
       F8 cancel accepts failed rows.

4. [x] `ws.ts`/`server.ts`/`RpcAuthorization`/contracts: drop `subscribeAccountUsage`, wire
       the recorder for `usage.getHistory`.

5. [x] F12: `ProviderRuntimeIngestion` emits the rate-limit activity only when rejected.

6. [x] F11: lag monitor opt-in (`T3_EVENT_LOOP_LAG_MS` or `T3_DIAGNOSTICS_FILE`).

7. [x] F13: detection timeout takes the failure TTL. F14: bound the semaphore hold.

8. [x] F24: `PATHEXT` in the spawn-resolution cache key.

### B. Contracts / client-runtime / web

9. [x] `contracts/quota.ts` → history + error only; `QueuedMessageStatus` gains `sending`.

10. [x] `client-runtime/state/quota.ts` → history query + queue atoms only.

11. [x] `web/state/quota.ts` → `primaryUsageAccountsAtom` built from
        `primaryServerProvidersAtom` (grouped by driver+email, instanceIds kept).

12. [x] `usagePresentation.ts`, `UsageStatusBar.tsx`, `UsageHistoryChart.tsx` on
        `ServerProviderUsageWindow`; severity from used-% thresholds; F5 quantized `since`.

13. [x] Queue UI + ChatView auto-queue on the new accounts; `sending` shown as pending.

### C. Desktop / hygiene

14. [x] F3/F4: renderer log opt-in (`T3_RENDERER_LOG`), sender validated, no raw console
        args, 5 MB rotation.

15. [x] F16 delete root PNGs (script writes to `.crash-reports/`); F18 delete `lefthook.yml`.

### D. Verify / land

16. [x] Typecheck, lint, targeted tests (recorder, trigger matching, queue claim, ingestion,
        presentation); web suite. Commit per unit; push; rebuild; restart GUI.

## Findings / gotchas

- **No polling survived.** Upstream re-probes limits every `providerHealthRefreshInterval`
  (5 min default, background-policy gated) and pushes turn-time updates; the strip only
  reads `ServerProvider.usageLimits` and the recorder samples `checkedAt` changes.
- Upstream's `LimitAccount` grouping (`collectLimitAccounts`) keys by driver + signed-in
  email but hides the instance ids; the fork keeps its own `groupUsageAccounts` in
  `web/state/quota.ts` because history reads and queue triggers need an instance id.
- The old `fork_usage_samples` rows keyed by Claude home path are orphaned (new rows key on
  the instance id) and age out with the 90-day sweep. Not migrated on purpose.
- `Effect.timeout` inside `withPermits` (F14) surfaces as an ordinary failure to the
  poller's existing backoff — no special handling needed.
- Letting `VcsProcessTimeoutError` propagate from `isInsideWorkTree` (F13) typechecks
  because it is already a member of the contracts `VcsError` union; the earlier "defect"
  wording in the fork commit was loose.
- Bash heredocs in this harness choke on some large TSX/TS bodies; the file tool is the
  reliable path for whole-file writes.
- Review items **not** taken: F19 (the launcher elevates the app — a question for the user,
  since the 09-06 restart relied on it), F20/F21/F26 (script/plan hygiene), F22 (favicon
  cache is now upstream's `Effect.Cache`), F23 (editor cache scope; low value).

## Progress log

- [x] A1–A8 server: recorder, poller removed, migrations 004/005, queue service on the
      registry with claim/settle (F6/F7/F8), ws/server/auth rewired, F11, F12, F13, F14, F24.
- [x] B9–B13 contracts/client-runtime/web: history-only quota contract, `sending`
      status, account view model, strip/chart/picker/panel/ChatView on upstream windows,
      quantized chart `since` (F5).
- [x] C14–C15 desktop/hygiene: renderer log opt-in + validated + rotated (F3/F4), PNGs and
      `lefthook.yml` removed (F16/F18), diagnose script writes to `.crash-reports/`.
- [x] D16 verify: typecheck 15/15 clean, lint exit 0, web 4527/4527, server touched
      tests green (recorder 2, queue 21, fork migrations 6, server layer, ingestion),
      desktop at its Wayland/launcher environmental baseline.

## Things not to do

- Don't stage the other session's sidebar files. `git add` by explicit path only.
- Don't add polling back; if the strip looks stale, the answer is the health interval.
- Don't touch upstream's `UsageLimits*.tsx`; the fork UI stays in `components/quota/`.
