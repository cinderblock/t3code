# Debug T3 Code crashes (build from source)

## Goal

Build T3 Code from source on this Windows machine so we can reproduce and debug the "weird crashes" the user has been seeing in the installed desktop app.

## Environment

- OS: Windows 11 Pro N (10.0.26200)
- Shell: PowerShell (use PowerShell syntax; Bash also available)
- Repo root: `C:\Users\camer\git\t3code`
- Fork: `cinderblock/t3code` (origin), `pingdotgg/t3code` (upstream)
- Node: v24.11.1 installed; `package.json` `engines.node` is `^24.13.1` — slightly below required. Watch for engine warnings; may need to upgrade Node if anything breaks.
- pnpm: 10.24.0 (corepack provisions the version pinned in `packageManager`)
- bun: 1.3.0 (docs reference `bun run dev:desktop` but package scripts shell out to `node scripts/dev-runner.ts dev:desktop` so bun isn't strictly required)
- vp (Vite+): not yet installed — required per CONTRIBUTING

## Decisions already made (don't re-ask)

- Debug target: **Desktop (Electron) app** — user confirmed they hit crashes on the installed Windows desktop build.
- Fork lives at `cinderblock/t3code`; origin points there, upstream points at pingdotgg.
- Following the project's documented dev path (`vp` + `vp i` + `bun run dev:desktop`) rather than substituting pnpm directly. User prefers "best" path.

## Plan / steps

1. ~~Clone repo to `C:\Users\camer\git\t3code`~~ — done.
2. ~~Fork `pingdotgg/t3code` → `cinderblock/t3code`, wire `origin` to fork, `upstream` to pingdotgg.~~ — done.
3. Install `vp` via the Windows installer: `irm https://vite.plus/ps1 | iex`.
4. Run `vp i` from the repo root to install workspace dependencies.
5. Launch `bun run dev:desktop` (or `node scripts/dev-runner.ts dev:desktop` if bun proves flaky).
6. Reproduce the crash, capture logs / stack traces.
7. Fix or open issue upstream.

## Findings / gotchas

- The fork at `cinderblock/t3code` already existed (probably from a previous attempt). Remotes were rewired in place, no re-clone needed.
- README says "We are not accepting contributions yet" and CONTRIBUTING is explicit that PRs are likely to be closed. If we find a fix, expect to maintain it on the fork rather than land it upstream quickly.
- `vp` (Vite+) is the project's task runner — a Vite-team commercial CLI that wraps pnpm. Installed via `irm https://vite.plus/ps1 | iex` with `$env:VP_NODE_MANAGER='yes'` to skip the interactive prompt and let vp also manage Node.
- vp manages Node per-project: it picked up `engines.node: ^24.13.1` from package.json and shimmed Node 24.16.0 even though my system Node is 24.11.1. No engine warning.
- `bun run dev:desktop` succeeded. Pipeline: vite+ builds web/renderer → `apps/desktop/scripts/dev-electron.mjs` waits for built `main.cjs` + `preload.cjs` + server `bin.mjs` + dev TCP port, then spawns Electron with `--watch` restart on file changes. Window opens; clean shutdown via `before-quit` event.
- Two log roots are live at the same time on Windows:
  - `~/.t3/dev/logs/` — the source-built dev session
  - `~/.t3/userdata/logs/` — the installed prod app (`%LOCALAPPDATA%\Programs\t3-code-desktop\`)
    Both can run simultaneously; they don't share state. User had the prod app open at PID 20624 while the dev session ran.
- Coverage of existing logs (effect Logger → console pretty + NDJSON trace + per-session NDJSON):
  - **Main process** (Electron): `desktop.trace.ndjson`, `desktop-main.log` (older / per-run). Level hardcoded `Info` at `apps/desktop/src/app/DesktopObservability.ts:349`.
  - **Server (in-process backend)**: `server.log`, `server.trace.ndjson`, plus `server-child.log` (subprocess stdout). Level configurable. Setup at `apps/server/src/serverLogger.ts`.
  - **Provider (Claude SDK)**: `~/.t3/userdata/logs/provider/<sessionId>.log` — one NDJSON file per Claude session, written by `ClaudeAdapter.ts:1059-1111`.
  - **Renderer**: GAP — console logs are DevTools-only. No IPC bridge to disk. (preload.ts has no logging channel.)
  - **Claude probe stderr**: GAP — `apps/server/src/provider/Layers/ClaudeProvider.ts:542` has `stderr: () => {}` which discards probe failures. Tiny patch but worth fixing if the user's crash involves probe paths.
- Rotation: 10 MB × 10 files for every log. Older rotated files (`.1` ... `.10`) are kept until size cap hits.
- Crash-snapshot tool lives at `scripts/crash-snapshot.ps1`. Defaults: last 3 minutes, both log roots, includes per-session provider logs touched in-window. Output zip goes to `.crash-reports/snapshot-<timestamp>.zip` and bundles metadata.json (git commit, branch dirty, OS, Node/pnpm/vp versions, full process tree with command lines).
- Hit on the installed prod app: 721 historical provider/<uuid>.log files going back to first install — meaning every Claude session ever has its own NDJSON. If the user can identify which session crashed by approximate time, the historical log for it is still on disk.

## Progress log

- [x] Clone repo
- [x] Fork and rewire remotes
- [x] Install vp (with Node management)
- [x] vp i
- [x] Launch dev:desktop — confirmed window opens, app/backend ready
- [x] Map logging architecture
- [x] Build snapshot tool — `scripts/crash-snapshot.ps1`, tested OK
- [ ] Decide whether to patch renderer log capture (code change) — pending user call
- [ ] Decide whether to patch the ClaudeProvider probe stderr discard — pending user call
- [ ] Reproduce a crash with the dev build
- [ ] Triage / fix

## Open questions for the user

1. What does the crash look like? (full app close, white screen, error dialog, specific action that triggers it, provider involved)
2. Which provider/CLI was active when crashes happen (Codex / Claude / Cursor / OpenCode)?
3. Any crash logs already captured? Default location for Electron on Windows: `%APPDATA%\T3Code\logs\` (best guess — confirm once running).

## 2026-07-22: "still getting >15s warnings" — diagnosed the toast source

- The "things taking more than 15s" warning is the **"Some requests are slow"** toast
  (`SlowRpcRequestToastCoordinator`), fired when a tracked RPC round-trip exceeds
  `SLOW_RPC_ACK_THRESHOLD_MS = 15_000` (`apps/web/src/rpc/requestLatencyState.ts`). Subscriptions
  and `previewAutomationConnect` are excluded (`shouldTrackRpcAck`).
- Analyzed the **live** prod trace (`~/.t3/userdata/logs/server.trace.ndjson{,.1,.2}`, ~2h window)
  via `scripts/slow-spans.py`. Slow _unary_ RPCs (the ones that actually toast), ranked:
  - **`ws.rpc.assets.createUrl` — 70 calls, up to 20.2s each** ← dominant source.
    Backed by `AssetAccess.issueAssetUrl` → `ProjectFaviconResolver.resolvePath` (67 calls, 16.3s).
  - `ws.rpc.vcs.listRefs` (2), `server.getConfig` (1), `server.discoverSourceControl` (1) — minor.
  - The big git-status spans (`getOrLoadLocalStatus` 27s ×50) feed `subscribeVcsStatus`, a
    **subscription** → excluded from the toast (they congest the loop but don't toast directly).
- **Root cause of the favicon storm:** `ProjectFaviconResolver.resolvePath` has **no cache** and does
  up to 21 sequential `stat`s + 7 `readFileString`s per call. The web client re-issues one
  `createUrl` per project (~14) on **every reconnect** (atom re-runs), and reconnects are exactly what
  the git storm causes → compounding load. 70 walks in 2h.
- **Fix (2026-07-22):** cache favicon resolution per normalized workspace root with a TTL, plus a
  bounded timeout so a hung/slow FS (e.g. mapped network drive) degrades to the fallback favicon
  instead of blocking `createUrl` for 20s. Removes the dominant toast source and cuts FS load.
- Tool: `scripts/slow-spans.py <thresholdMs>` — pipe trace NDJSON in, get slow spans grouped by name.
- STATUS: committed `401da737f` (fix(assets): cache project favicon resolution). Server bundle rebuilt
  (`vp run --filter t3 build`); `dist/bin.mjs` contains the fix. **Pending: restart the app** to load
  the new bundle, then re-run `slow-spans.py` — `assets.createUrl` occurrences should collapse.
- Verify after restart: `cat ~/.t3/userdata/logs/server.trace.ndjson | python3 scripts/slow-spans.py 5000`
  — expect `ws.rpc.assets.createUrl` / `ProjectFaviconResolver.resolvePath` to drop out of the top slow spans.
- SEPARATE (pre-existing, not from this fix): `ProjectFaviconResolver.test.ts` has 2 Windows-only
  failures — `toContain("public/brand/logo.svg")` asserts a forward-slash path against a `\`-separated
  absolute path (lines ~69, ~193). They fail on HEAD too; a cross-platform test fix (normalize sep) is
  a small separate cleanup.

## Things not to do

- Don't run global PATH-modifying installers without flagging — `irm | iex` for vp is sanctioned by CONTRIBUTING but still touches user PATH.
- Don't open a PR upstream without checking first; the project is explicitly not accepting external contributions right now.
