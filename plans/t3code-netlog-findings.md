# Netlog findings — connection churn from saved remote environments

## Goal

Use a Chromium netlog capture (`--log-net-log`) of the desktop app to find network-level
errors worth fixing, in support of the ongoing crash/startup-freeze investigation on
`debug/crash-investigation`.

## Environment / context

- Netlog: `C:\temp\netlog.json` (app launched via `apps/desktop/scripts/start-electron.mjs`,
  which now forwards extra CLI args to Electron; session analyzed: ~3:59 PM–4:21 PM, 2026-07-16).
- Analysis scripts (reusable): `C:\temp\netlog-scan.mjs` (failures by host),
  `C:\temp\netlog-urls.mjs` (distinct URLs), `C:\temp\netlog-host.mjs` (per-host status codes).
  Run with `node <script> C:\temp\netlog.json [host]`. They tolerate a netlog still being written.
- Local machine has no `10.255.7.187` / `10.100.122.213` interface (checked `Get-NetIPAddress`) —
  those are remote machines (saved environments), not self-probes.

## Findings

### 1. Dead saved environments are retried every 16 s forever (biggest churn)

- `http://10.255.7.187:3773/.well-known/t3/environment` and
  `http://10.100.122.213:3773/...` — 89 attempts each in ~21 min, every one
  `ERR_CONNECTION_TIMED_OUT` (~10 s hang per attempt, 616 netlog failure events total).
- Cause: `packages/client-runtime/src/connection/supervisor.ts:32`
  `RETRY_DELAYS_MS = [1s, 2s, 4s, 8s, 16s]` — backoff **caps at 16 s** with no further growth,
  no circuit breaker, no network-change reset. An offline machine is re-dialed ~4×/min for the
  life of the app, each attempt holding a connecting socket ~10 s.

### 2. `homeassistant:3773` is in a reconnect loop — ticket endpoint 404s

- 104× descriptor fetch + 104× `/api/auth/websocket-ticket` in the session (~every 12 s).
- Status lines on those sources: 107× `200 OK`, **106× `404 Not Found`**, 6× `204`.
- **Zero** WebSocket events to that host — the connection never completes.
- Reading: descriptor succeeds (200), the websocket-ticket request 404s (server on the HA box
  is old / doesn't implement the endpoint — likely the t3ha deployment), client treats it as
  transient and retries forever.
- Fix directions: (a) client should classify a 404 on a known auth endpoint as
  blocked/version-skew (surface "environment incompatible — update it"), not transient retry;
  (b) user-side: update or remove the homeassistant environment.

### 3. Minor / benign

- `wpad:80` — 48× `ERR_PAC_NOT_IN_DHCP` + 32× `ERR_NAME_NOT_RESOLVED`: Windows proxy
  auto-detection noise. Could silence in dev with `--no-proxy-server`.
- `ERR_CACHE_RACE` (4×, worker js), `ERR_WS_UPGRADE` (2×, cancelled during reload): benign.
- `10.255.7.45:3773` connected fine (2 requests, no loop) — healthy saved environment.
- The earlier one-off console errors (`aa.online-metrix.net` -105, `-181` handshake) were from
  third-party web content, not app code; not present in this capture.

## Open questions for the user

1. What are `10.255.7.187` and `10.100.122.213`? (Presumably saved environments for machines
   now offline / re-addressed.) Remove them from the connections list, or keep and fix retry
   backoff first?
2. Is the homeassistant t3 server (t3ha?) expected to be current? Its
   `/api/auth/websocket-ticket` 404s.

## Proposed fixes (not yet started)

- [ ] Extend supervisor backoff: after N consecutive failures grow toward a 1–5 min cap
      (keep `retryNow` for instant manual retry; optionally reset on network change / app focus).
- [ ] Classify HTTP 404 from `/api/auth/websocket-ticket` (and other known endpoints) as a
      non-retryable / long-backoff "version skew or incompatible environment" state with UI surfacing.
- [ ] (Optional, dev QoL) add `--no-proxy-server` in dev launch to silence WPAD noise.

## 4. `UnknownVizError` snapshot spam (separate console log, 2026-07-16 run)

Repeated `Error occurred in handler for 'desktop:preview-automation-snapshot'` with
`cause: [Error: UnknownVizError]` across tab_1/2/3.

- **What it is:** `webContents.capturePage()` (`preview/Manager.ts`) rejects with Chromium's
  compositor error when the target has no compositable frame — a backgrounded/occluded preview
  tab (only the visible view is painted), or a page that failed to load (e.g. the interleaved
  `http://localhost:3199/admin ERR_CONNECTION_REFUSED` — a preview tab pointed at a down dev
  server, so nothing to capture).
- **Not a crash.** "Error occurred in handler for …" is Electron's own log for a rejected
  `ipcMain.handle` promise (`DesktopIpc.ts:96`); it's serialized back to the renderer and the app
  keeps running. The window close was independent/manual.
- **Weakness fixed:** in `captureAutomationSnapshot` the `capturePage()` call sat inside
  `Effect.all([...])` alongside the AX tree / diagnostics / timelines, so one uncapturable frame
  failed the _entire_ snapshot. Now the screenshot degrades to `null` (via `Effect.option`) and the
  rest of the snapshot returns normally.
  - `packages/contracts/src/previewAutomation.ts`: `screenshot` is now `Schema.NullOr(...)`.
  - `apps/server/src/mcp/McpHttpServer.ts`: `preview_snapshot` omits the image content block and
    reports `screenshot: null` when absent (previously always appended an image / indexed into it).
  - Tests: `Manager.test.ts` (null + success paths), existing `McpHttpServer.test.ts` still green.

## Things not to do

- Don't treat the `online-metrix` / `-181` console errors as app bugs — third-party content.
- Don't assume the 10.x probes are self-probes of local interfaces — verified they are not.
