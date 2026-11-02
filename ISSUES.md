# Issues

Known problems found while working on something else. Each entry is a seed for a separate fix.

## WebSocket upgrade accepts cookie sessions from any Origin

**Fixed upstream** by #18509 (`48595c787c`), arrived in merge `fe5c72318c`: every cookie-authenticated
request, the upgrade included, must now be same-origin by `Sec-Fetch-Site`, match `Host` /
`X-Forwarded-Host`, or come from a trusted app origin. Kept below for the record.

`authenticateWebSocketUpgrade` (`apps/server/src/auth/EnvironmentAuth.ts`, used by
`apps/server/src/ws.ts` and `apps/server/src/device/DeviceHubProxy.ts`) authenticates a browser
cookie without checking the `Origin` header. CORS does not apply to WebSockets, and the session
cookie is `SameSite=Lax`, which still attaches it on _same-site_ requests. So once an environment
is served on a public domain (e.g. `t3.example.com` behind a tunnel), a page on any sibling
subdomain (`*.example.com`) that is compromised or hosts untrusted content can open the RPC socket
with the user's session and drive agents (`orchestration:operate`). Reproduce: from a page on
another subdomain of the same registrable domain, `new WebSocket("wss://t3.example.com/ws")` while
signed in.

Why it matters: the session grants shell-level control of the host. A fix probably checks
`Origin` for cookie-authenticated upgrades against the request's own origin, configured public
origins, and the desktop renderer origins. Careful: cloudflared rewrites `Host` to the local
service by default, so comparing `Origin` to `Host` alone would break proxied access.

## Web browser tests can't start on Windows when the hashed port is reserved

`apps/web/vite.config.ts` hashes the checkout path into a browser-test API port in 61000–64999
(`browserTestApiPort`), with `strictPort: false`. Windows (Hyper-V / WinNAT) reserves blocks of
ports; on this machine `netsh int ipv4 show excludedportrange protocol=tcp` lists 60690–62189. A
checkout that hashes into a reserved block fails before any test runs, and `strictPort: false`
doesn't help because the error is `EACCES`, not `EADDRINUSE`:

    Error: listen EACCES: permission denied ::1:62018

Seen 2026-10-23 in `C:\Users\camer\.t3\worktrees\t3code\mobile-attach-pr`, running
`vp test run --project browser <file>`. `--browser.api.port` on the command line doesn't
override it, because the port is set per project. About 30% of the hash range is reserved
here, so roughly a third of worktrees can't run browser tests on this machine. Upstream has the
same code.

## React Compiler skips GitGraphPanel and PublicAccessSettings

`vp test run src/reactCompilerCoverage.test.ts` (in `apps/web`) fails on two committed files, as of
2026-10-24 10:33 PM PDT (2026-10-25 05:33Z) on `master` at `4f581b52c7`:

- `apps/web/src/components/gitGraph/GitGraphPanel.tsx`: five components or hooks skipped (one near
  line 43's pill class list).
- `apps/web/src/components/settings/PublicAccessSettings.tsx`: one skip,
  `react-compiler(Todo): (BuildHIR::lowerStatement) Handle TryStatement with` a `finally`.

Neither file is touched by uncommitted work. CI would fail this test, and a skipped component loses
all memoization. The last commits to touch them are the upstream merge `0f33eeeaee` and `8212f66f55`.

## Fork comments break upstream's new 4-line comment cap (lint)

Upstream added `t3code(no-low-value-comments)`, which fails lint on comment blocks over four
lines (and on `@public` followed by prose). Fork code arriving through the 2026-10-27 upstream
merge has ~35 violations across ~25 files, among them `server/vcs/VcsStatusBroadcaster.ts`,
`server/vcs/GitVcsDriverCore.ts`, `server/processSpawnObserver.ts`, `server/processRunner.ts`,
`server/auth/{PublicAccess,AuthAttemptLimiter}.ts`, `client-runtime/connection/supervisor.ts`,
`contracts/{queuedMessage,rpc,git,settings,auth}.ts`, `desktop/preview/Manager(.test).ts`.
Reproduce: `vp lint` on any of them. Matters because CI lint is red on fork code until the
comments are cut to their constraint (keep the why, drop the history; move long history to
`plans/`).

## Four test suites fail on Windows regardless of the change under test

Seen 2026-10-26 on `feature/thread-priority` (base `fa45619aa5`); none of these touch the code
being changed there.

- `apps/server/src/environment/ServerEnvironment.test.ts` › "publishes proven install ownership
  only for manually updated servers": `expected undefined to deeply equal { kind: 'npm-global', … }`.
  The test creates a `fs.symlink` and fakes `HostProcess.Platform` as `"linux"` on a Windows host.
- `apps/server/src/mcp/OrchestratorMcpToolkit.integration.test.ts` › "reports running and queued
  child follow-ups from a Codex replay transcript": `ENOENT … open 'C:\C:\Users\…\codex_transcript.ndjson'`
  — the fixture path is built from a URL pathname, doubling the drive letter.
- `apps/mobile/src/features/threads/checkout-new-task-branch.test.ts` (2 tests):
  `expected 'feature\r\n' to be 'feature\n'` — git output compared without normalizing CRLF.
- `apps/desktop/src/settings/DesktopClientSettings.test.ts` › "saves through a symlinked client
  settings file without replacing the link": resolved temp paths differ (symlink/realpath on Windows).

Why it matters: every Windows run shows red in suites unrelated to the change, which hides real
regressions and costs each agent time re-proving they are pre-existing.

## 26 server tests in 8 files fail on Windows regardless of the change under test

Seen 2026-10-30 running `vp test run src/orchestration-v2 src/queue src/mcp src/scheduledTasks
src/guest src/ws.test.ts` in `apps/server`: 26 failed, 2240 passed. The same 26 fail with entry K's
refusal disabled. Files: `ClaudeAdapterV2.test.ts` (13, mostly "preserves ... with native PDFs,
images, and paths"), `ProviderTurnStartService.test.ts` (4), `OpenCode2AdapterV2.test.ts` (2),
`ClaudeReplayFixtures.integration.test.ts` (2, "must stream its output"),
`OrchestratorMcpToolkit.integration.test.ts` (2), `AntigravityAdapterV2.test.ts` (1),
`AcpRegistryReplayFixtures.integration.test.ts` (1), `ThreadMessageIntake.test.ts` (1, "claims
question uploads"). Not confirmed on a clean `master`, and not diagnosed. Matters for the same
reason as the entry above: a red run hides real regressions.

## `userInputAttachments.test.ts` fails three path tests on Windows

`question answer paths`: the "extracts notebook cells", "preserves corrupt documents" and "keeps
selected values intact" tests fail on Windows. They expect a raw path and the answer holds it with
doubled backslashes. Matters because a focused run of this file is red on the maintainer's machine.

## Stray typed text lands in a hidden preview tab's composer

Seen 2026-10-30 12:52 to 1:06 PM PDT (19:52 to 20:06Z), driving a hidden preview tab (`preview_open` with `open` unset,
reported `visible: false`) of a dev server through `preview_act`. Text nobody asked for appeared in the tab's focused
composer: "l", "do thi", ".", "com", " ", "get", " so ". It came both before and after text sent with `preview_act type`,
and once with no typing at all, just after a pointer click focused the editor. It looks like live keyboard typing reaching
that tab. Not diagnosed. If it is the user's typing in the app, those keys go missing for them and land in a composer they
can't see. Setting text from the page and blurring the editor stopped it. Also seen in the same session: `preview_act`
clicks timing out on some controls, and "No preview automation host" for about a minute afterwards.

## mcp-tool-use eval's toolkit list is kept by hand

`t3SourceTools` in `evals/mcp-tool-use/run.ts` repeats `McpHttpServer.layerTools` by hand. A new toolkit
that is missed there is silently absent from the model's tool list, and `--dry-run` and `--context`
still look fine. `SendLaterToolkit` was missed this way until `7c2d4c8d7e`, so its eval cases could not
have passed. Why it matters: a guard fails for a reason unrelated to the text, and a control passes
without testing anything, at the cost of a paid run. Nothing checks that a tool named in a case's
`expect` exists.

## `vp run check:changed` crashes on this fork with ENAMETOOLONG

`scripts/check-changed.ts:277` throws `spawn ENAMETOOLONG` on Windows. The script diffs against
`main`, this fork is far enough ahead that the file list overflows the command line. The pre-push
check cannot run at all here, so its format, lint, knip and test steps have to be run by hand.

## `vp run typecheck` fails on a stale TypeScript shim

`vp run --filter ./packages/contracts typecheck` fails with `Cannot find module
node_modules\.pnpm	ypescript@7.0.2
ode_modules	ypescriptin	sc`. Only `typescript@6.0.3` and
`@tsc-rs/typescript@0.8.0` are installed, so a package `.bin` shim outlived a lockfile change.
Running `node_modules/.pnpm/@tsc-rs+typescript@0.8.0/node_modules/@tsc-rs/typescript/bin/tsc
--noEmit` from the package directory works. Typecheck is silently unavailable until this is fixed.

## Settings browser tests flake when run as a folder

`vp test run apps/web/src/components/settings` failed `SecretInput.browser.test.tsx` and
`TelemetryExportSettings.browser.test.tsx` with a different count on each run (`expected
'reeppllaacceemmeenntt' to be 'replacement'`, `Test timed out in 15000ms`). Both files pass alone,
twice in a row. Doubled keystrokes suggest something timing-dependent under load, which can fail
CI or hide a real regression.

## Source-launched desktop reports Electron's version as the app version

`scripts/start-t3.ps1` starts the app through `apps/desktop/scripts/start-electron.mjs`, which passes
`dist-electron/main.cjs` to Electron. Started that way, `app.getVersion()` returns Electron's version:
running the built app with `--version` printed `44.4.5`, not `0.1.0`.

Why it matters: `apps/desktop/src/main.ts:118` uses that value as the SSH runner version, so adding an
SSH environment fails with `curl: (22) The requested URL returned error: 404` while fetching
`v44.4.5/SHA256SUMS`. Other `appVersion` consumers, such as the update channel and default settings,
see the wrong value too. Correcting it to `0.1.0` alone would install upstream's server on the remote,
not this fork's.
