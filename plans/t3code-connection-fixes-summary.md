# T3 Code connection/crash fixes — summary (2026-07-03)

Work done on branch `debug/crash-investigation` (fork `cinderblock/t3code`) to fix the
"frequent disconnects / weird crashes" on a Windows desktop install with **many open repos**
(~14 under `C:\Users\camer\git\Personal Projects`).

## The core problem

The local backend (a Node child process the desktop app talks to over a loopback WebSocket)
gets **overwhelmed by git-status work and becomes unresponsive**, which surfaces many ways:

- "Noook did not respond to a connection health check" (WS probe timeout on window refocus)
- "Noook did not respond during connection setup" (establishment timeout)
- "Remote environment endpoint http://127.0.0.1:3773/.well-known/t3/environment timed out" (descriptor fetch)
- On remote environments (relay), the relay's own 10s health check marks a busy backend offline
  → "BlackHole disconnected"
- Under sustained load the backend is killed for unresponsiveness and restart-loops
  (`code=1` / native termination codes — the same family seen back in April, i.e. pre-existing).

### Root causes identified (with evidence from `~/.t3/userdata/logs`)

1. **Status remote fetches storm.** Each open repo had its own 30s loop doing `git fetch` with
   no shared concurrency limit → up to N simultaneous SSH handshakes. On Windows OpenSSH can't
   multiplex, so every fetch pays a full ~2-3s handshake; N in parallel contend, blow past the
   fetch timeout, and bog the backend. (One repo, `TWILL/odrive-balance`, showed 900+ timeouts.)
   The fetch failures were NOT a dead remote — `git fetch` succeeded in ~2-4s in isolation; the
   timeouts were self-inflicted contention.
2. **Refocus re-fetched remotes.** Every window refocus forced a remote fetch, colliding with the
   connection health-check probe that fires on the same event.
3. **Uncached executable resolution.** Every git spawn re-resolved the `git` binary by walking
   PATH with synchronous `statSync` — event-loop pressure that scales with spawn volume.
4. **No tolerance for a busy-but-alive backend.** The health-check probe, connection setup, and
   descriptor fetch each tore the connection down on first timeout and reconnected — and the
   reconnect re-runs bootstrap, bogging the backend more ("disposed before it finished
   bootstrapping" spiral).
5. **A defect on git timeout.** `isInsideWorkTree` could time out and its `VcsProcessTimeoutError`
   escaped its handled error channel as an Effect defect, crashing `vcs:refresh-status`.

## Commits (upstream/main..HEAD, oldest first)

| Commit      | Area       | What                                                                                      |
| ----------- | ---------- | ----------------------------------------------------------------------------------------- |
| `081eedf4c` | debug      | Capture renderer errors + un-silence Claude probe stderr to a log (investigation tooling) |
| `c5c6e8c17` | vcs        | Refresh only **local** git status on window refocus (optional `refreshRemote` flag)       |
| `d2427c84f` | desktop    | Pin Electron `userData` dir so an unpackaged `start:desktop` decrypts the real profile    |
| `fb4c91f54` | vcs        | Exponential backoff for failing status remote fetches                                     |
| `740898bea` | shell      | Memoize spawn executable resolution (kill per-spawn synchronous PATH walk)                |
| `a611bb774` | vcs        | Raise status upstream fetch timeout 5s → 15s **(last pushed)**                            |
| `1b2d18f19` | vcs        | Cap concurrent status fetches (semaphore) + lower fetch timeout 15s → 8s                  |
| `137f0cf4a` | connection | Tolerant health check: retry the WS probe (busy ≠ disconnected)                           |
| `2bdbe9d75` | vcs+conn   | Lower fetch concurrency 4 → 2 + raise setup timeout 15s → 30s                             |
| `8a72ed4d1` | vcs        | Handle `isInsideWorkTree` timeout instead of defecting status refresh                     |
| `f8808967e` | connection | Retry the environment descriptor fetch on timeout                                         |

**Pushed to `origin/cinderblock`:** through `a611bb774`.
**Local-only (unpushed):** `1b2d18f19`, `137f0cf4a`, `2bdbe9d75`, `8a72ed4d1`, `f8808967e`.
(Run `git push origin debug/crash-investigation` to update the fork — SSH from a normal terminal;
note: multiplexing must stay OFF in `~/.ssh/config` for github.com on Windows, see gotcha below.)

## The `settings.json` workaround (the thing that actually stabilized local)

`~/.t3/userdata/settings.json` → `"automaticGitFetchInterval": 0`. This disables **recurring**
remote status fetching (one initial refresh per repo at startup, then silent), which removed the
sustained storm. It's the single change that took local from crash-looping to usable. Reversible
via Source Control settings (fetch interval) or by deleting the line. Downside: ahead/behind
counts don't auto-refresh (manual refresh only).

## Current state

- **Remote environments: meaningfully better** (the tolerant health check + fetch tuning).
- **Local: usable but rough at startup.** The _initial_ local-status pass over all ~14 repos still
  freezes the event loop for a while on startup, so connections may blip/"reconnect" until it
  finishes (then recovers). This is the remaining issue — see the deeper-fix plan.

## For the maintainers (general robustness gaps, machine-independent)

1. Status remote fetching has no global concurrency cap; with many repos + slow-handshake remotes
   it storms and can bog the backend.
2. Connection liveness (probe / setup / descriptor) treats "backend busy" as "connection dead" and
   reconnects, which worsens load — tolerance/retry helps.
3. `VcsProcessTimeoutError` from low-level git ops (e.g. `isInsideWorkTree`) can escape as a defect.
4. The initial status pass isn't throttled, so N repos can freeze the event loop at startup, and
   it runs _before_ the backend serves readiness, so it can block bootstrap entirely (fix: defer the
   first pass past readiness, then throttle it).
5. `buildAvailableEditors` (editor detection) checked editors sequentially with no timeout, walking
   PATH with `fs.stat` per editor — a slow/dead PATH entry (e.g. an unresponsive mapped network
   drive) blocked the backend for ~60s and tripped the health check. General pattern: any
   backend op that walks PATH / spawns processes on the request/poll path needs a timeout.
6. Windows OpenSSH does not support `ControlMaster` multiplexing — don't recommend it; it breaks
   github SSH with "getsockname failed: Not a socket".

## Where the fixes actually run (2026-07-27) — the deployment gap

Three tiers, and they are NOT all reached by our fork:

| Component                         | Code that runs                                     | Gets our fixes? |
| --------------------------------- | -------------------------------------------------- | --------------- |
| Desktop app (Electron + renderer) | our fork's build                                   | **yes**         |
| Primary / "local" backend         | our fork's bundled `apps/server/dist/bin.mjs`      | **yes**         |
| Remote environments               | `npx --yes t3@<ver>` from **npm = stock upstream** | **NO**          |

"Local" and "backend" are not opposites — the primary backend IS a local Node child process
talking loopback WS. The distinction that matters is **local backend (forked) vs remote
environment backends (stock)**.

Consequences:

- All **server-side** fixes (favicon cache, status grace/semaphore, exec memoization, editor
  timeout, `isInsideWorkTree` defect) apply **only to the local backend**. A remote environment
  with many repos hits the identical bugs with none of the fixes.
- All **client-side** fixes (`packages/client-runtime/connection/supervisor.ts`: probe retry,
  30s establishment, descriptor retry) ship in the desktop app and therefore **do** improve
  connections to every environment, local and remote.
- Empirical proof the local backend runs our bundle, not npx: the fork-migrator DB behavior only
  changed after rebuilding `apps/server/dist/bin.mjs` (2026-07-27 session).

Remote spec resolution: `resolveRemoteT3CliPackageSpec` → `t3@<appVersion>` / `t3@nightly` /
`t3@latest` (`packages/ssh/src/command.ts:367`). To get fork fixes onto a remote you would have to
publish/point the spec at a fork build.

## Upstream has independently adopted some of these (2026-07-27)

Checked `upstream/main` directly. This confirms the problem class is **real and machine-independent**
— upstream hit it too — and tells us what we no longer need to carry:

| Fix                                                                                     | In upstream/main?                                                                                                                  |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Exponential backoff on failing status refresh (`VCS_STATUS_REFRESH_FAILURE_BASE_DELAY`) | **yes**                                                                                                                            |
| Remote-fetch concurrency cap (`STATUS_UPSTREAM_REFRESH_CONCURRENCY`)                    | **no — corrected 2026-07-27** (earlier "yes" was a false positive: `grep -c "X\|Semaphore"` matched unrelated `Semaphore.make(1)`) |
| Favicon resolution cache + timeout                                                      | no                                                                                                                                 |
| `isInsideWorkTree` timeout handling (defect fix)                                        | no                                                                                                                                 |
| Editor-detection timeout                                                                | no                                                                                                                                 |
| Exec-resolution memoization (`shell.ts`)                                                | no                                                                                                                                 |
| Startup grace + local status concurrency cap                                            | no                                                                                                                                 |
| Supervisor probe retry / establishment tolerance                                        | no — still `RETRY_DELAYS_MS` capped at 16s, 15s probe, no retry                                                                    |

## What is NOT established (be honest about this)

Well-evidenced: favicon storm (measured: 70 calls, up to 20.2s, 2h trace), dead-environment retry
loop (netlog: 89 attempts each, 616 failure events), HA 404 loop (106× 404), `isInsideWorkTree`
defect (code-level certainty), capturePage failing the whole snapshot.

**Not established:**

- The **startup freeze root cause was never measured.** The event-loop lag monitor has been proposed
  three times and never added. The first throttle attempt (`320a2fd7e`) was REVERTED for making
  startup worse — an explicit case of guessing without measurement.
- Hypothesis 2 (exec-cache misses) was "ruled out by code-read", not by instrumentation.
- The thing that actually stabilized local was the **`automaticGitFetchInterval: 0` setting**, not
  the code fixes. That strongly suggests the code fixes did not fully address the root cause.
- The original crash question is still open: `debug-t3code-crashes.md` progress log has
  "Reproduce a crash with the dev build" and "Triage / fix" **unchecked**, and its open questions
  (what the crash looks like, which provider) were never answered.
- **`~/.t3/userdata/state.sqlite` is 3.3 GB** and nobody has looked at why. A database that size is
  a plausible independent contributor to event-loop pressure and has never been ruled in or out.

Machine-specific confounds that inflate all of this: ~14 open repos, Windows OpenSSH (no
multiplexing → full ~2-3s handshake per fetch), possible dead mapped network drive on PATH.

## Gotchas learned (don't repeat)

- Don't enable SSH `ControlMaster`/multiplexing on Windows (breaks all github SSH).
- An unpackaged Electron binds safeStorage to `%APPDATA%\Electron`, not `%APPDATA%\t3code` — pass
  `--user-data-dir` (done in `start-electron.mjs`).
- After updating to upstream, run `vp i` before building (stale deps → `@pierre/diffs` `./editor`).
- Aggressive git timeouts that kill git mid-op leave `tmp_obj` garbage and stale `index.lock`.
