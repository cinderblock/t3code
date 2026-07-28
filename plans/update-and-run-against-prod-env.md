# Update to latest + run local build against prod env

## Goal

Build/run a **local** T3 Code desktop build from the latest source, pointed at the **same cloud env the production app uses** (Clerk + relay), so crashes can be compared apples-to-apples against the installed prod app. Also bump a "bootstrap load timeout" to 15s.

## Environment

- OS: Windows 11 Pro N (10.0.26200), PowerShell primary. Repo: `C:\Users\camer\git\t3code`.
- Fork: origin=`cinderblock/t3code`, upstream=`pingdotgg/t3code`.
- Installed prod desktop app: `%LOCALAPPDATA%\Programs\t3-code-desktop\` — **v0.0.28** (release channel per `resources/app-update.yml`), installed Jun 29.
- Dev launch path (from prior plan): `bun run dev:desktop` works. `vp` (Vite+) installed.

## Key findings (2026-07-01)

- Local `main` == origin/main == `3ea6adf17`, **353 commits behind upstream/main** (`7b9eef7ac`). upstream/main == latest nightly tag `v0.0.29-nightly.20260701.697` (same commit).
- Working tree has uncommitted crash-capture work on branch `debug/crash-investigation`:
  - `apps/desktop/src/main.ts` (+ipc renderer-log sink), `apps/desktop/src/preload.ts` (+`__t3CrashLog`), `apps/web/src/main.tsx` (+window.onerror/unhandledrejection/console capture), `apps/server/.../ClaudeProvider.ts` (probe stderr no longer discarded), `.gitignore` (+`.crash-reports/`). Plus untracked `scripts/crash-snapshot.ps1`, `plans/`. **MUST preserve.**
- `LOCAL_BOOTSTRAP_LOAD_TIMEOUT_MS` does not exist anywhere (checkout or upstream). Closest real knobs in `apps/web/src/environments/primary/auth.ts`:
  - `AUTH_SESSION_ESTABLISH_TIMEOUT_MS = 2_000` — wait for authenticated session to establish after bootstrap before throwing `PrimaryEnvironmentAuthSessionTimeoutError`. (candidate: 2s→15s)
  - `BOOTSTRAP_RETRY_TIMEOUT_MS = 15_000` — retry window for transient 502/503/504 bootstrap errors. (already 15s)
- "Same env" injection mechanism (build-time `repoEnv` via `scripts/lib/public-config.ts`, consumed in `apps/{web,server,desktop}/vite.config.ts`). Needed repo-root `.env` vars to match prod:
  - `T3CODE_CLERK_PUBLISHABLE_KEY` = `pk_live_Y2xlcmsudDMuY29kZXMk` (extracted from prod binary) ✅
  - `T3CODE_CLERK_JWT_TEMPLATE` = `t3-relay` (repo default) ✅
  - `T3CODE_RELAY_URL` = ??? (need from user / prod binary) ❌
  - `T3CODE_CLERK_CLI_OAUTH_CLIENT_ID` = `oauthapp_...` ??? (need from user / prod binary) ❌

## RESOLVED / status (2026-07-01)

- **`LOCAL_BOOTSTRAP_LOAD_TIMEOUT_MS` was HALLUCINATED** by another agent. It claimed
  `const LOCAL_BOOTSTRAP_LOAD_TIMEOUT_MS = 5_000` in `apps/web/src/connection/desktopLocal.ts`.
  Truth: that file has NO timeout (just connection-id helpers + a synchronous
  `getLocalEnvironmentBootstraps()` reader). The constant name exists nowhere in repo/upstream.
  → **Step 2 is void as written.** Real local/primary-load timeouts are hardcoded in
  `apps/web/src/environments/primary/auth.ts`: `AUTH_SESSION_ESTABLISH_TIMEOUT_MS = 2_000`
  (closest real match) and `BOOTSTRAP_RETRY_TIMEOUT_MS = 15_000`. **No runtime override exists**
  (grep of connection/environment load path for env/localStorage/query = 0 hits).
- **Step 1 DONE.** Committed crash-capture patch on `debug/crash-investigation`
  (commit `081eedf4c`), rebased cleanly onto `upstream/main` (= `v0.0.29-nightly.20260701.697`).
  Safety snapshot in stash: `86ab381e...`. Branch preserved (user: still useful, keep it).
- Prod env values: chose extract-from-binary. app.asar extracted to scratchpad
  `.../scratchpad/asar-extract`. Still need `T3CODE_RELAY_URL` + `T3CODE_CLERK_CLI_OAUTH_CLIENT_ID`.
- **PAUSED** — user dismissed follow-up (timeout step + whether to build against prod env).

## Actual crash symptom (2026-07-01): connection health-check timeout

- User's real error: "Noook: Failed to connect. Reconnecting… Noook did not respond to a
  connection health check." ("Noook" = user's own hostname NOOOK.)
- Source: `packages/client-runtime/src/connection/supervisor.ts:413`. The "health check" is a
  full RPC round-trip `serverGetConfig` over the EXISTING socket (`rpc/session.ts:122`),
  fired ONLY on `application-active` wakeup (supervisor.ts:405).
- Relevant constants (supervisor.ts:32-35): `CONNECTION_PROBE_TIMEOUT="15 seconds"` (the error),
  `CONNECTION_ESTABLISHMENT_TIMEOUT="15 seconds"`, `RETRY_DELAYS_MS=[1,2,4,8,16]s`,
  `BACKOFF_RESET_AFTER_MS=30000`. Also `rpc/session.ts:23 SOCKET_OPEN_TIMEOUT="15 seconds"`.
- ROOT CAUSE (diagnosed): NO WS keepalive/ping anywhere (protocol.ts is 8 lines, recurs(0)).
  After sleep/suspend the socket is half-open (readyState OPEN, no onclose), so the probe
  writes into a dead socket and waits the full 15s. The 15s is pure dead-wait, not backend work.
- CONCLUSION: raising the timeout is WRONG (slower recovery). Options: (A) LOWER probe timeout to
  ~3-4s to fail fast; (B) reconnect-on-wake instead of probing stale socket; (C) add client
  keepalive/heartbeat (root fix, matches AGENTS.md reliability priority). Recommend C long-term,
  A as quick mitigation. Caveat: if host "Noook" also slept, backend is down → reconnect fails
  regardless of timeout (separate issue).
- Awaiting user decision on fix direction before editing.

## ROOT CAUSE FOUND (2026-07-01) — evidence-based

- "Noook" = the LOCAL backend (user confirmed): renderer <-> loopback WS <-> child server process.
- NOT the old crash-loop: `desktop-main.log`'s 5201 "backend exited unexpectedly (code=1)" are
  ALL from Apr 2-20 (stale old-format log). Current `desktop.trace.ndjson` (through today) = 0
  backend exits. Backend is stable now. (Corrected an earlier over-claim.)
- REAL current cause: slow `git fetch` remote-status refreshes block the health-check probe.
  Evidence from `~/.t3/userdata/logs/server.trace.ndjson`:
  - `server.getConfig` (the probe RPC) appears **0 times** — probe not processed around failures.
  - 70 spans >5s, ALL git remote-status: `VcsStatusBroadcaster.refreshRemoteStatus`,
    `remoteStatus`, `readRemoteStatus`, `statusDetailsRemote`. Peak **17.3s** (> 15s probe timeout).
  - `server-child.log`: 10,902 `GitCommandError` (mostly `git fetch --no-tags origin ... timed out`).
- Mechanism: remote status refreshes every 30s (`VcsStatusBroadcaster.ts:27
DEFAULT_VCS_STATUS_REFRESH_INTERVAL=30s`) AND on window focus (`GitActionsControl.tsx:1202`
  refreshes git status on the SAME focus/visibility event that fires the probe). Each refresh runs
  `fetchRemoteForStatus` = `git fetch` with a 20s timeout (`GitVcsDriver.ts:473 timeoutMs:20_000`).
  A hung fetch ties up the backend past the 15s probe window -> "did not respond to a connection
  health check" banner. Exact coupling (event-loop block vs per-connection RPC serialization) is the
  one thing not provable from static logs.
- KEY SIMPLIFICATION: this bug is 100% LOCAL. Reproducing needs only `bun run dev:desktop` — NO prod
  cloud env, so the relay-URL / OAuth-client-ID extraction is NOT needed for this investigation.
- Candidate fixes (symptom -> root): (1) don't `git fetch` on every focus / debounce; (2) lower the
  20s fetch-for-status timeout; (3) decouple the health-check probe from the RPC/work path (WS ping
  or priority); (4) back off remotes that repeatedly time out. Raising probe timeout only masks it.
- Logging option (user chose "improve logging first"): add a backend event-loop lag monitor (proves
  block-vs-queue) + client probe start/timeout timing to renderer.log. `os-jank.ts` is NOT a jank
  monitor (it's PATH hydration) — would be a new module. Server boots via `bin.ts` -> `cli/server.ts`.

## Corrections during investigation (for honesty/future sessions)

- Over-claimed "5201 backend crashes" — those were Apr 2-20 (stale `desktop-main.log`); current = 0.
- Over-read "0 server.getConfig spans = probe never reached server" — actually RPC tracing is OFF
  (`ws.ts:1812 disableTracing:true`), so that was an artifact. RPC dispatch is concurrent by default;
  git runs async (`VcsProcess` uses `ChildProcessSpawner`), so the exact probe-starvation mechanism
  is NOT fully pinned by static analysis. The heavy git remote-status load is real regardless.
- The fast upstream fetch is already 5s-capped + cached (`STATUS_UPSTREAM_REFRESH_TIMEOUT=5s`,
  15s interval). The 20s timeouts (`GitVcsDriver.ts:473,565`) are ls-files/check-ignore, not fetch.

## FIX IMPLEMENTED (2026-07-01) — "reduce the git trigger" (user's choice)

Chosen lever: stop forcing a remote `git fetch` on passive window refocus (the event that collides
with the health-check probe). Threaded a `refreshRemote` flag contracts -> server -> client:

- `packages/contracts/src/git.ts`: `VcsStatusInput` gains optional `refreshRemote` (honored only by
  vcs.refreshStatus; false = local refresh, reuse cached remote).
- `apps/server/src/vcs/VcsStatusBroadcaster.ts`: `refreshStatus` takes `{ refreshUpstream? }`; when
  false, invalidates local only and calls `remoteStatus({cwd},{refreshUpstream:false})` (no fetch),
  still returns full `VcsStatusResult`.
- `apps/server/src/ws.ts`: vcsRefreshStatus handler passes `refreshUpstream: input.refreshRemote !== false`.
- `apps/web/src/components/GitActionsControl.tsx`: window focus/visibility refresh now passes
  `refreshRemote:false` (local-only). Menu-open and thread-action refreshes stay full (remote).
  Typecheck: my 4 files clean; contracts + client-runtime pass via `vp run typecheck`. Pre-existing
  unrelated failures remain (tailscale hostProcess, marketing astro, WorkspaceSearchIndex, various web).
  NOT yet: `vp check` (lint/format), build, or reproduce. Fix lives on branch `debug/crash-investigation`
  (uncommitted, on top of the rebased crash-capture commit `081eedf4c`).

## NETWORK ACCESS insight (2026-07-01) — user data point

- User had "network access" ENABLED, recently disabled it "for more reliability."
- "Network access" = `DesktopServerExposure`: ON binds LAN host + Tailscale serve + advertised
  endpoints (`DesktopServerExposure.ts:113 loopback` vs `:128 LAN bind`); OFF = loopback only.
- Likely reconciliation: with it ON, "Noook" (user hostname) was reached over a NETWORK path
  (LAN/Tailscale HTTPS), which has real failure modes (half-open sockets, DERP/relay hiccups, TLS,
  NAT) → "did not respond to a connection health check" on refocus. OFF -> loopback -> reliable.
  This makes the ORIGINAL half-open/network hypothesis correct for the network-access-ON regime;
  the git-fetch-on-focus fix is a separate contributor that can trip the probe even on loopback.
- connection-catalog.json is ENCRYPTED on disk (couldn't confirm Noook's endpoint directly).
- User answers: connects same-machine desktop app; WANTS network access reliable (needs multi-device);
  hasn't re-tested since disabling. => network-reliability fix (keepalive / reconnect-on-wake) is
  the real long-term goal so they can re-enable network access.

## RUN OUR BUILD (user asked how) — in progress

Path chosen: production-mode source build using the REAL ~/.t3/userdata profile (not the ~/.t3/dev
sandbox that dev:desktop uses). Commands:
pnpm build:desktop # vp build desktop + t3 server from working tree (includes the fix)
pnpm start:desktop # scripts/start-electron.mjs -> Electron on dist-electron/main.cjs (prod mode)
Caveats told to user: (1) close installed prod app first (shared userdata profile => backend
conflict); (2) cloud sign-in/relay OFF without T3CODE\_\* env (LAN/Tailscale network access still
works; relay/managed-endpoint remote access would need relay URL + OAuth client id — Clerk key we
have: pk_live_Y2xlcmsudDMuY29kZXMk); (3) this build has the git-fetch fix but NOT the
network-reliability fix — re-enabling network access may still show errors (expected, next task).
STATUS: `pnpm build:desktop` running in background (task bawp43gzo). Then start:desktop to launch.

## BUILD + RUN follow-ups (2026-07-01)

- First `build:desktop` FAILED: `@pierre/diffs` had no `./editor` export. Root cause = stale deps
  after the 353-commit update; never reran install. Fixed with `vp i` (now `@pierre/diffs@1.3.0-beta.5`
  with ./editor). Rebuilt clean; fix verified in bundles (bin.mjs has `refreshUpstream`, web assets
  have `refreshRemote`). (This also means the earlier "pre-existing typecheck errors" were stale-deps.)
- `pnpm start:desktop` FAILED to decrypt connection-catalog.json (ElectronSafeStorageDecryptError),
  sessions didn't load. ROOT CAUSE: unpackaged Electron on Windows defaults app name to "Electron"
  -> Chromium os_crypt binds the safeStorage key under %APPDATA%\Electron\Local State BEFORE the
  app's runtime setPath("userData", <appData>/t3code) runs. Prod (packaged) uses %APPDATA%\t3code\
  Local State (mtime May 10) as its key. Different key -> can't decrypt prod's catalog. Data is
  intact, just wrong key. Confirmed by filesystem: %APPDATA%\t3code\Local State (May 10, prod) +
  %APPDATA%\Electron\Local State (Jun 6, our unpackaged runs); no t3code-dev dir.
- FIX: `apps/desktop/scripts/start-electron.mjs` now passes `--user-data-dir=<appData>/t3code`
  (t3code-dev in dev) so os_crypt binds to prod's dir from launch. No rebuild needed (script run
  directly by `node`). User must fully quit the installed prod app first (shared profile), then
  rerun `pnpm start:desktop`. Fallback if still failing: `pnpm dist:desktop:win` (packaged identity).

## BLACKHOLE analysis (2026-07-01) — user pulled logs to T:\log dump\blackhole

- CONFIRMED same slow-git problem: 955 `git fetch ... timed out`, ALL on ONE repo
  `C:\Users\ChrisTacklind\git\TWILL\odrive-balance\.git` (remote unreachable/slow from BlackHole).
- Trace storm: `shell.isExecutableFile` 11,428 calls (uncached exec resolution) + ~100MB trace/15min.
  isExecutableFile uses async fs.stat -> LOAD not a hard event-loop block => BlackHole is thrashing,
  "too busy to answer the relay's 10s health check" -> "BlackHole disconnected" + 10000ms timeout
  (relay EnvironmentConnector health probe, ENVIRONMENT_MINT_REQUEST_TIMEOUT_MS=10s). Some genuine
  TransportError/HttpClientError too.
- CORRECTION: remote is NOT unreachable. `odrive-balance` origin = git@github.com:TWILL-Tech/
  odrive-balance.git (SSH). Log reason is purely "timed out" (killed at 5s STATUS*UPSTREAM_REFRESH*
  TIMEOUT), no SSH/auth error. Manual `git fetch` on BlackHole = 2.34s (well under 5s). => the 915
  timeouts were SELF-INFLICTED LOAD: every-5s retry storm + uncached PATH walks saturated the box,
  pushing a 2.3s fetch past 5s -> timeout -> retry -> more load. The backoff + exec-cache commits
  break this loop, so fetches should succeed once load drops. Do NOT bump the 5s timeout (adequate).
  Optional zero-code extra margin: SSH ControlMaster/ControlPersist for github.com on BlackHole
  (2.3s is mostly cold-handshake; multiplexing -> ~0.2s).
- User wanted (as SEPARATE commits): (1) remote-fetch backoff; (2) cache resolved git exec path.

## COMMITS LANDED (2026-07-02) on debug/crash-investigation — all typecheck clean

- c5c6e8c17 fix(vcs): refresh only local git status on window refocus (contracts refreshRemote flag +
  VcsStatusBroadcaster.refreshStatus {refreshUpstream} + ws.ts handler + GitActionsControl focus).
- d2427c84f fix(desktop): pin userData dir (start-electron.mjs --user-data-dir) — VERIFIED session loads.
- fb4c91f54 fix(vcs): exponential backoff for failing status remote fetches (GitVcsDriverCore: per-remote
  failure streak Map + timeToLive(exit,key), 5s→…→cap 5min). Targets the odrive-balance retry storm.
- 740898bea perf(shell): memoize spawn executable resolution (shell.ts: bounded cache keyed by
  platform+command+PATH; kills per-git-spawn synchronous statSync PATH walk).
- Leftover working tree: pnpm-lock.yaml (from `vp i`) NOT committed — decide separately. plans/ untracked.
- Rebuilding desktop (backoff+exec-cache are server-side) → restart start:desktop to pick them up.
  Deploy this build to BlackHole's backend to help its storm; still worth fixing WHY odrive-balance's
  remote is unreachable from BlackHole (zero-code win). User OK with me running builds (see memory).

## PILEUP FIX (2026-07-02) — the real local-blip cause: concurrent fetch storm

- Local backend polls ~14 `Personal Projects` github repos; each has its OWN 30s refresh loop
  (`makeRemoteRefreshLoop` -> `Effect.forkIn`) with NO shared concurrency limit -> up to 14
  simultaneous `git fetch` = 14 concurrent SSH handshakes. github SSH is healthy but ~2.3s/handshake
  (Windows OpenSSH can't multiplex — confirmed, `OpenSSH_for_Windows_9.5p1`; ControlMaster is
  unsupported on the MS port, not a path issue). Concurrent handshakes contend -> fetches balloon
  past the (15s) timeout -> 40s `refreshRemoteStatus` spans, 839 spans>3s -> backend bog -> the
  "did not respond to a connection health check" AND "did not respond during connection setup"
  (CONNECTION_ESTABLISHMENT_TIMEOUT) blips. Running build WAS our latest (electron started 00:36,
  after 00:24 rebuild), so backoff/exec-cache/15s were active but don't cap concurrency.
- Also: the 15s timeout I'd bumped is counterproductive at this scale (prolongs each contended fetch).
- FIX commit 1b2d18f19: Semaphore.make(4) around fetchRemoteForStatus (STATUS*UPSTREAM_REFRESH*
  CONCURRENCY=4) + STATUS_UPSTREAM_REFRESH_TIMEOUT 15s->8s. Typecheck clean, rebuilt (bin.mjs 14:20).
  Restart start:desktop to apply. NOT pushed yet (branch is published; offer to push).
- Separate: `C:\Users\camer\git\Personal Projects\node-null` has a corrupt T3 checkpoint ref
  (`refs/t3/checkpoints/.../turn/24` bad object) -> that repo's fetch fails regardless.
- ssh-agent IS loaded (2 keys) — not an auth issue.

## CONNECTION CORRECTNESS (2026-07-02) — "bad state shouldn't bring down T3"

- Principle (user): a repo in bad state (T3-caused or external) must not disconnect T3. node-null
  measured: fetch ~5-6s then always fails (bad object refs/t3/checkpoints/.../turn/24) + leftover
  objects/41/tmp_obj garbage = a T3 checkpoint ref pointing at a never-finished object (interrupted
  write; killed git ops leave this too). Minor load contributor (1/14, backed off); NOT the root.
  Flag to maintainers: T3 shouldn't leave a checkpoint ref for an unfinished object, and aggressive
  timeout-kills of git can create this garbage.
- FIX commit 137f0cf4a (packages/client-runtime/src/connection/supervisor.ts): the application-active
  health-check probe now RETRIES (runConnectionHealthCheck, CONNECTION_PROBE_MAX_ATTEMPTS=4, ~60s
  tolerance) instead of tearing the connection down on the first 15s timeout. Real socket death still
  caught instantly via session.closed. So backend busyness (bad repo, git storm, anything) surfaces as
  slowness, not a disconnect -> breaks the reconnect/bootstrap death spiral. Applies to ALL connections
  (client-side). Typecheck clean; rebuilt (web 17:24). Restart start:desktop to apply.
- NOT done (riskier, follow-up): making the ESTABLISHMENT/setup path ("did not respond during
  connection setup", CONNECTION_ESTABLISHMENT_TIMEOUT 15s) tolerant — no live conn to preserve during
  setup. Server concurrency cap already reduces the bog that trips it.

## Plan / steps (pending answers)

1. Commit uncommitted crash-capture work on `debug/crash-investigation` (safety) — or safety-stash snapshot.
2. Update to chosen "latest"; rebase debug branch on top so crash-capture patch survives.
3. Apply the timeout change (15s) per Q1.
4. Create repo-root `.env` with prod public values.
5. `vp i` if lockfile changed; build/run `dev:desktop` (or packaged build) against prod env.
6. Verify it connects to prod cloud (sign-in works, same relay).

## Things not to do

- Don't `git checkout -- `/`restore`/`reset --hard` — shared-tree rules; uncommitted crash work must survive.
- Don't push to origin main or open upstream PRs.
- Don't put server-side secrets in `.env` (only public client values).
