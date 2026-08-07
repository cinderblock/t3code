# Assessment: rewrite the backend in Rust, and/or the app in Tauri?

Status: **ASSESSED 2026-08-07 — recommendation is NO to both.** No code changed.
Awaiting a decision on what to do instead (see "Open questions").

## Goal

Answer a question raised after `plans/git-layer-native-binding.md` was shelved
(2026-08-06): would rewriting `apps/server` in Rust, and/or replacing Electron
with Tauri, be a reasonable move? Greenfield to approximate feature parity was on
the table, dropping T3 Connect and Tailscale.

## Verdict

**No to both**, for one reason that outranks all the cost estimates: **the rewrite
is aimed at the wrong layer.** The pain is an architectural choice (polling with a
spawn per status, no file watcher), not the implementation language. The fork's own
benchmarks say a native git layer makes the measured symptom _worse_, not better.

Tauri additionally has hard blockers that would cost a shipped feature and rebuild
auth, while not delivering the binary-size win that motivates it.

## Environment / context

- Repo `C:\Users\camer\git\t3code`, branch `debug/crash-investigation`.
- This is a **fork**: `origin` = `cinderblock/t3code`, `upstream` = `pingdotgg/t3code`.
- Upstream velocity: 861 commits in 90 days (~10/day), 2,315 total since 2026-02-07.
- **Local `main` is 688 commits behind `upstream/main`** (fetch was 8 days stale).
- Upstream README: "We are (mostly) not accepting contributions yet. Big features
  will not be." So fork-maintained, not upstreamable.
- Fork divergence: 57 commits / ~8,400 lines / 78 files, with ~24 open items in
  `plans/fork-divergence-review.md`.

## Scale (measured, not estimated)

| Area                      | LOC                      | Note                                              |
| ------------------------- | ------------------------ | ------------------------------------------------- |
| `apps/server` non-test    | 96,296                   |                                                   |
| `apps/server` tests       | 86,124 (197 files)       | encode the real product rules; do not port        |
| `apps/web`                | 145,639                  | unchanged if the wire stays identical             |
| `apps/mobile`             | 72,446                   | Expo/RN, 3 custom native modules, both app stores |
| `apps/desktop` non-test   | ~21,000                  | `preview/` 5,859 is the largest slice             |
| `packages/contracts`      | 16,544 (~13.4k non-test) | Effect Schema, 88 RPCs                            |
| `packages/client-runtime` | 28,041                   | shared by web + mobile                            |
| `native/resource-monitor` | 1,160                    | **already Rust**                                  |

## Findings

### 1. Effect is the architecture, not a dependency

1,325 `yield*` sites in `provider/`, 617 in `orchestration/`; 60 of 70 provider
files import `effect`. `Scope` _is_ the process-lifecycle model — `ProviderDriver.create`
returns `Effect<…, R | Scope.Scope>` and closing that scope releases every child
process, fiber and PubSub. There is no plain-TypeScript core to lift out. Rust has
no 1:1 for `Layer`/`Scope`/`Stream`/`Schema`, so this is a restructure, not a
translation.

### 2. `packages/contracts` cannot be deleted, only duplicated

Web, mobile and desktop all import `@t3tools/contracts` directly, and
`client-runtime`'s entire typed API is _inferred_ from `WsRpcGroup`
(`rpc/client.ts:39-40`). There is **no OpenAPI/protobuf/JSON-Schema artifact
anywhere** in the repo. A Rust server means hand-maintaining a parallel copy of:
88 RPC methods, ~21 HTTP endpoints, a 20-variant `ClientOrchestrationCommand`
union, a 27-variant `OrchestrationEvent` union, a 48-variant `ProviderRuntimeEvent`
union, plus exact `withDecodingDefault` values (71 in `settings.ts` alone) and
`TrimmedString`'s encode-side trim.

Wire protocol is Effect RPC v4 over a single WebSocket with `RpcSerialization.layerJson`
(plain JSON). Reimplementable, but you inherit the `Chunk`/`Ack` stream backpressure
protocol and the 5s Ping/Pong watchdog (client treats one missed Pong as fatal).

### 3. Providers split cleanly — except Claude

| Provider   | Mechanism                                      | Portable? |
| ---------- | ---------------------------------------------- | --------- |
| Codex      | subprocess `codex app-server`, JSON-RPC/NDJSON | yes       |
| Cursor     | subprocess `cursor-agent … acp`, ACP           | yes       |
| Grok       | subprocess `grok agent stdio`, ACP             | yes       |
| OpenCode   | subprocess `opencode serve`, HTTP/SSE          | yes       |
| **Claude** | `@anthropic-ai/claude-agent-sdk` `query()`     | **no**    |

`ClaudeAdapter.ts` (3,951 lines — largest file in the repo) holds the SDK handle
directly and drives its bidirectional control protocol (`interrupt()`,
`setPermissionMode()`, `getContextUsage()`), with a `satisfies never` guard over
25+ `system` message subtypes. Permissions run an Effect program _inside_ the SDK's
`CanUseTool` promise callback. Rust would mean reimplementing an undocumented,
fast-moving stream-json protocol.

`effect-acp` and `effect-codex-app-server` are ~5k hand-written lines over ~53k
**generated** lines (from upstream ACP v0.11.3 and openai/codex JSON Schemas) —
those regenerate in Rust cheaply. Not the problem.

### 4. The rewrite does not fix the reported problem — this is the decisive finding

- `plans/t3code-startup-freeze-deeper-fix.md`: **26.6% of self time (24.00s) in
  `spawn (native)`**, ~9.2ms synchronous event-loop block per spawn, implying
  **~2,600 git spawns in 90 seconds** with 14 repos.
- `plans/git-layer-native-binding.md` benchmarked libgit2 against the git CLI:
  ref enumeration 1.5× _faster_, but **`status` is 2.3–3.4× SLOWER**
  (234–340ms vs ~105ms).
- Root cause is polling: `VcsStatusBroadcaster.ts:30`
  `DEFAULT_VCS_STATUS_REFRESH_INTERVAL = 30s` per repo.
- **Verified: there is no workspace file watcher.** Only three `fs.watch` sites in
  the entire server — `keybindings.ts:593`, `serverSettings.ts:532`, and a
  `GIT_TRACE2` event-file tail at `GitVcsDriverCore.ts:807`. None watch repo files.

So Rust buys a faster way to do work that shouldn't happen at all. The shelved
native-binding plan already reached this and sequenced the watcher first.

Also unfixed and directly relevant: `fork-divergence-review.md` **F5** — a
`Date.now()`-derived atom key in `UsageHistoryChart.tsx:152` causing a
`usage.getHistory` RPC storm every render — is flagged in the fork's own notes as
"most likely of these to be implicated in the crash symptoms."

### 5. Tauri blockers

1. **`ELECTRON_RUN_AS_NODE=1`** (`DesktopBackendConfiguration.ts:397-413`) — Electron
   _is_ the Node runtime for the server child (`executablePath: process.execPath`).
   Tauri would need a separately shipped Node (~50–100 MB/platform) or a single-file
   compile, erasing most of the size win that motivates Tauri.
2. **fd 3 / fd 4 / fd 5** carry bootstrap config, telemetry, and telemetry control.
   Tauri's `Command` API has no arbitrary FD inheritance.
3. **`@clerk/electron` + `@clerk/electron-passkeys`** have no Tauri counterpart. Auth
   gets rebuilt, including secure storage, custom scheme, and the macOS Associated
   Domains entitlement + provisioning profile the build already stages.
4. **`preview/`** (~5k non-test lines) needs Electron `<webview>`, per-partition
   sessions, and raw CDP (`Page.startScreencast`) plus the Playwright injected
   runtime. `WebviewPreferences.ts` deliberately **disables `contextIsolation`** so
   `react-grab`/bippy can read the React DevTools hook. WKWebView / WebView2 /
   WebKitGTK offer no equivalent. This subsystem also backs the
   `mcp__t3-code__preview_*` tools. Would be redesigned or dropped.
5. **`protocol.handle`** reverse-proxies the local server and injects the CSP; the
   stable `t3code://app` origin is load-bearing for Clerk and the CSP.
6. **`wsl/`** (~1.4k lines) orchestrates a _second_ backend inside WSL — Node
   child-process logic that becomes Rust or stays a Node sidecar.
7. `scripts/build-desktop-artifact.ts` is 2,148 lines of electron-builder pipeline
   (Azure Trusted Signing on Windows, notarization on macOS, two update channels
   published to GitHub Releases) — all rewritten around `tauri build`.

Tauri would also unify nothing: mobile is Expo/RN with custom native modules
shipped to both stores, so TypeScript contracts stay regardless.

**Cheap-to-port, for the record:** dialogs, clipboard, `openExternal`, theme,
single-instance lock, window bounds persistence, power monitor, safe storage.
None of these were the problem.

### 6. IPC surface — correction to an earlier miscount

A grep for `ipcMain.handle|ipcMain.on` finds only **3** call sites, which is
misleading. Registration is centralized through `makeIpcMethod` in
`ipc/DesktopIpc.ts` (Effect wrappers with `Schema` codecs). `ipc/channels.ts`
declares **77 channel constants**: ~53 `invoke`/`handle`, 8 main→renderer push,
3 synchronous `sendSync`. **39 of the 77 are the preview subsystem.** The shape maps
onto `#[tauri::command]` + serde; the handler bodies are all Electron API calls and
do not.

### 7. The fork constraint

A rewrite means permanently forfeiting upstream work — alone, against a team
shipping ~10 commits/day — to fix a problem the fork's own benchmarks say the
rewrite makes worse. `fork-divergence-review.md` already notes merge pain is
concentrated in four hot files (`ChatView.tsx` 69 upstream commits in 3 months,
`ws.ts` 57, `ChatComposer.tsx` 41, `server.ts` 39).

## Recommended sequence (not started)

The strangler-fig path already exists and works: `native/resource-monitor` is Rust
(`sysinfo` 0.39, versioned NDJSON protocol, cross-compiled in CI), and
`VcsDriverRegistry` + `vcs/testing/VcsDriverContractHarness.ts` exist precisely so a
second driver can be proven equivalent.

1. **Workspace file watcher + status cache** — removes most of the ~2,600 spawns,
   no new language, benefits the current TS path immediately, and is worth doing
   independent of any binding decision (the shelved plan says so explicitly).
2. **F5**, then **F6/F7** from `fork-divergence-review.md` — the named likely crash
   cause and the queued-message poison pill / duplicate-send bugs.
3. **Reads-only native git binding** if the watcher proves insufficient — `git2-rs`,
   stateless, behind the existing registry. The prior probe covered 47 operations in
   365 Rust lines.

## Open questions for the user

1. Which next step — (a) the file watcher + status cache, (b) the
   `fork-divergence-review.md` fix list starting at F5, or (c) neither?
   **Recommendation: (b) first** — F5 is a small quantization fix on the item the
   fork's own notes call the most likely crash cause, so it is the cheapest way to
   test the crash hypothesis before investing in the watcher.

## Things not to do

- Don't rewrite `apps/server` in Rust to fix the startup freeze. Measured: libgit2
  `status` is 2.3–3.4× slower than the git CLI. It targets the wrong layer.
- Don't port to Tauri expecting a smaller binary — `ELECTRON_RUN_AS_NODE` means Node
  ships either way.
- Don't delete `packages/contracts` under any backend rewrite; three clients import
  it directly and `client-runtime`'s types are inferred from `WsRpcGroup`.
- Don't trust a raw `ipcMain.handle` grep to size the desktop IPC surface — read
  `ipc/channels.ts`.
- Don't re-open the nodegit option: it is NAN, not N-API, and is disqualified by the
  four runtimes the binding must load in (see `plans/git-layer-native-binding.md`).

## Loose end worth checking

`electron-store` is declared in `apps/desktop/package.json` but has **no direct
import in `src/`** — likely vestigial or a transitive `@clerk/electron` need. Cheap
to verify and drop.
