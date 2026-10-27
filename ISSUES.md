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
