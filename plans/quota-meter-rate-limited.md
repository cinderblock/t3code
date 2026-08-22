# Quota meter shows nothing — Anthropic usage endpoint is rate-limiting us (2026-08-21)

## Goal

Explain why the fork's quota meter (bottom-of-composer usage bubble) stopped
showing meters, and decide what to change. Short answer: **the fork's code is
fine.** `GET https://api.anthropic.com/api/oauth/usage` is returning HTTP 429 for
this account, and the server has not had a single successful poll since it was
restarted.

## Environment / context

- Repo `C:\Users\camer\git\t3code`, branch `master`.
- Meter code (post-rename): `apps/server/src/quota/{ClaudeUsageApi,UsageBroadcaster}.ts`,
  `apps/web/src/components/quota/*`, `apps/web/src/state/quota.ts`,
  `packages/client-runtime/src/state/quota.ts`.
- Live server: electron child `apps/server/dist/bin.mjs`, PID 19796, started
  2026-08-21 15:20 local (22:20Z).
- Samples table: `fork_usage_samples` in `~/.t3/userdata/state.sqlite`.
- Traces: `~/.t3/userdata/logs/server.trace.ndjson*` (rotates every ~10 MB, which
  right now is every few minutes — absence of a span in the newest file proves
  nothing).
- A second, independent poller runs on this machine against the **same** account:
  the tray app `claude-usage` (`~/git/claude-usage`, PID 18340, running since
  2026-08-20). It polls the same endpoint every 2 minutes. Its log is
  `%LOCALAPPDATA%\com.cinderblock.claude-usage\logs\claude-usage.log` (UTC).

## What the evidence says

**Last successful poll: `2026-08-21T21:01:04.621Z`.** Before that, samples land
every 2 minutes exactly, going back to 2026-07-27 — the poller was healthy.

```
sqlite> SELECT DISTINCT captured_at FROM fork_usage_samples ORDER BY captured_at DESC LIMIT 3;
2026-08-21T21:01:04.621Z
2026-08-21T20:54:04.043Z
2026-08-21T20:52:03.606Z
```

Every poll since the server restarted has failed the same way — three attempts,
exactly 1800 s apart (`BACKOFF_MAX` = 30 min):

```
fetchClaudeUsage  1787354363  Failure   Error: Usage endpoint rate limited (retry after 0s)
fetchClaudeUsage  1787356164  Failure   Error: Usage endpoint rate limited (retry after 0s)
fetchClaudeUsage  1787357964  Failure   Error: Usage endpoint rate limited (retry after 0s)
```

Reproduced by hand with curl, same token, same headers as the server sends:

```
HTTP/1.1 429 Too Many Requests
Retry-After: 0
{"error":{"type":"rate_limit_error","message":"Rate limited. Please try again later."}}
```

The token is **not** the problem: `GET /api/oauth/profile` with the same bearer
token returns 200 with the account payload, and `expiresAt` is hours away.

## Findings / gotchas

### It is a shared, per-account budget on that one endpoint — not our client

A first probe made it look like a User-Agent allowlist: `t3code/usage-meter` got
429 while `claude-cli/usage-watcher` (what the tray app sends) got 200 seconds
later. **That was a coincidence** — a 5-UA sweep a minute later returned 429 for
_every_ UA including `claude-cli/usage-watcher` and a real
`claude-cli/2.0.14 (external, cli)` string. The budget is per account and very
tight; whoever asks when the bucket is empty gets 429, regardless of identity.

Corroboration from the other side: at `[2026-08-22][00:32:41]` the tray app
logged its own 429 — the same minute as the sweep. Our probes drained the bucket
out from under it.

### Both of my pollers are fighting over the same budget

The tray app has been eating 429s all day too, in long runs:

```
[2026-08-21][06:30:33] poll failed (consecutive 1, retrying in 300s): usage endpoint rate-limited us (429)
... consecutive 2..14, 1800s apart, through 11:59 ...
[2026-08-21][12:55:38] poll failed (consecutive 1, retrying in 300s): ...
... through 18:01 ...
[2026-08-21][21:26:08] poll ok: 5-hour 45%→~134% · Weekly 7%→~429% · Fable 11%→~657%
```

Two independent apps polling one account every 2 minutes is ~1440 requests/day
against a limit that clearly no longer tolerates it. The tray app wins the race
more often because on 429 it retries in 300 s, while t3code escalates to a
30-minute `BACKOFF_MAX` and so gets very few attempts at a refilled bucket.

`Retry-After: 0` is not usable guidance — the code correctly ignores it in favour
of the 5-minute `RATE_LIMIT_FLOOR`, but that floor is then overridden by the
larger exponential backoff (`delayMs = max(backoffMs, retryAfterMs, floor)`).

### Why it reads as "totally broken" rather than "stale"

`AccountPollState` lives only in memory. The server restarted at 22:20Z, so
`snapshot` is `null` for the account, and `AccountMeters` correctly renders the
placeholder — a pulsing dot plus "Usage rate limited — retrying" — instead of
bars. There are 12 996 rows of perfectly good history sitting in
`fork_usage_samples` that nothing reads at startup.

### Unrelated, and not a bug: the monthly/extra-usage meter is gone

`monthly:all` last sampled 2026-08-14T04:07Z. The tray app logs why on every
poll: `extra_usage present but not shown: is_enabled=false monthly_limit=None
used_credits=None`. `parseClaudeUsageResponse` only emits that window when
`monthly_limit > 0`, so it correctly stops emitting it. Nothing to fix.

## Decisions already made (don't re-ask)

User decisions, 2026-08-22:

- **Persist the snapshot and restore it at startup.** Applied.
- **Flat retry on 429, no exponential escalation.** Applied.
- **`POLL_INTERVAL` stays at 2 minutes.** Explicitly not lengthened.
- **The `claude-usage` tray app is not to run alongside t3code.** It has since
  exited (last poll 04:52:54Z) and nothing restarted it.

## One request returns everything

There is no per-window endpoint, so "poll the 5-hour window more often" is not a
cheaper thing to ask for than polling everything more often. A single
`GET /api/oauth/usage` returns `five_hour`, `seven_day`, the whole `limits[]`
array (including per-model weekly, e.g. Fable) and `extra_usage` in one body.

The only other call is `GET /api/oauth/profile` for the plan label, and it is not
per-poll: `pollAccount` stops asking once it has a label, and gives up after
`MAX_PLAN_FETCH_ATTEMPTS` (5) tries. So the steady state is exactly **one request
per poll per account**.

## Changes applied (2026-08-22)

1. **`fork_usage_snapshots`** — new fork migration 3, one row per account holding
   the encoded `AccountUsageSnapshot`, replaced on every successful poll.
   `fork_usage_samples` could not do this job: it stores a percentage per window
   and none of the severity, scope, billing kind or plan label the bars need.
2. **Restore at startup**, before the poll loop forks, so a poll that succeeds
   immediately wins rather than races. Windows whose `resetsAt` has passed are
   dropped — that percentage reset to near zero at a moment we weren't watching,
   and showing it would be confidently wrong. If nothing survives, nothing is
   restored. A row that fails to decode is skipped, not raised.
3. **429 no longer feeds the exponential ladder.** It sets `reason` and a flat
   `RATE_LIMIT_FLOOR` (5 min) delay, and does not increment `consecutiveErrors`.
   That counter existed to describe _our_ health; a shared-budget 429 says
   nothing about it, and letting it accumulate is precisely what pushed the
   retry out to 30 minutes and kept the meter dark for hours after the budget
   had room again.

Files: `apps/server/src/persistence/Migrations/fork/003_UsageSnapshots.ts`,
`apps/server/src/persistence/ForkMigrations.ts`,
`apps/server/src/quota/UsageBroadcaster.ts`, plus tests in
`apps/server/src/quota/UsageBroadcaster.test.ts` and
`.../Migrations/fork/ForkMigrations.test.ts`.

## Progress log

- [x] Confirmed the merge/rename left the quota wiring intact (server layer, WS
      method, atoms, `UsageStatusBar` mount point in `ChatView.tsx:6586`).
- [x] Found the last good sample (21:01:04Z) and the three failed polls since.
- [x] Reproduced the 429 by hand; ruled out token expiry and User-Agent.
- [x] Found the second poller and its matching 429 history.
- [x] **The outage ended on its own at 2026-08-22T00:49:26Z**, ~3h48m after it
      began and before anything was changed. Samples have landed every 2 minutes
      since, with a few 7–15 minute gaps from isolated 429s.
- [x] Persisted snapshot + startup restore + flat 429 retry implemented.
- [x] `tsgo --noEmit` clean; 28 tests pass in `src/quota` and
      `src/persistence/Migrations/fork`; lint reports only the two pre-existing
      `prefer-set-has` warnings in fork migrations 1 and 2.
- [ ] Restart the desktop app to pick up the new server bundle (migration 3 runs
      on next start).

## Things not to do

- Don't "fix" this by polling harder — the budget is shared with every other
  client signed in as this account, and t3code cannot win that race by asking
  more often.
- Don't read `Retry-After` as authoritative here; the endpoint sends `0`.
- Don't burst probe requests at the endpoint while diagnosing: five curls in a
  row visibly knocked out the tray app's next scheduled poll.
- Don't conclude anything from one probe. The first UA comparison looked like a
  clean allowlist result and was pure coincidence — the bucket refilled between
  the two requests.
- Don't judge the poller by the newest trace file. `server.trace.ndjson` rotates
  at 10 MB, which under normal use is every few minutes, so "no poll spans in the
  current file" is the expected state even when everything is healthy.
