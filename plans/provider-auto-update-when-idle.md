# Automatically update providers when idle

## Goal

When a provider (Claude, Codex, OpenCode, …) has a newer version available, install it
automatically once that provider has been idle for about 5 minutes, instead of waiting for
someone to click "Update". It must never cut into running agent work.

## Environment / context

- Repo: `C:\Users\camer\git\t3code` (fork, branch `master`). Plans live in `plans/` and are committed (fork convention).
- Existing one-click update path: `apps/server/src/provider/providerMaintenanceRunner.ts`
  (`updateProvider`), resolver in `packages/provider-core/src/server/maintenanceResolver.ts`,
  design notes in `docs/internals/providers.md` ("Provider updates run only through the owning installer").
- Version advisories (`versionAdvisory.status === "behind_latest"`) are refreshed by the provider
  health refresh every 5 minutes (`DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL`); not gated on client demand.
- Live provider sessions: `apps/server/src/orchestration-v2/ProviderSessionManager.ts`. Each entry
  tracks `busyTurns`, `lastActivityAtMs`, `pinnedSinceMs`, `idleGeneration`; idle sessions are
  released after 30 min (`idle_timeout`) and resume on the next turn.
- Settings: `enableProviderUpdateChecks` in `packages/contracts/src/settings.ts`; surfaced in web
  `SettingsPanels.tsx` (~line 2807), mobile `SettingsServerControlsRouteScreen.tsx` (~488), MCP
  environment toolkit (`apps/server/src/mcp/toolkits/environment/`).

## Decisions already made (don't re-ask)

- **Server-side.** The server owns the idle timer, so it works with no client open, remotely, and for every client surface.
- **"Idle" = the provider being updated has no agent activity for 5 minutes**: no busy turns, no
  pending background work, no session activity, and no session opened or released, on any instance
  of that driver. Per-driver rather than environment-wide, so a busy Codex does not block a Claude
  update, and instances that share one install are covered together.
- **Opt-in server setting `autoUpdateProviders`, default off.** It runs installers unattended, so it
  should be a choice. Requires `enableProviderUpdateChecks`.
- **Release that driver's idle sessions before updating, and hold new session opens for it until
  the update finishes.** On Windows a running provider binary cannot be replaced (npm `EBUSY`), and a
  turn started mid-install would launch a half-written install. Released sessions resume on the next
  turn, the same as after the normal 30-minute idle release.
- **Same safety rules as the manual update**: only `behind_latest`, `canUpdate`, not broken/unsupported, runner re-verifies ownership.
- **After a failed or unverified auto-update, don't retry that version for 6 hours.**
- **Hoist `ProviderMaintenanceRunner` to one server-lifetime instance.** It was built per WebSocket
  connection, so its per-install update lock was not shared between clients; the auto-updater must
  share it with manual updates.

## Plan / steps

1. Contracts: `autoUpdateProviders` in server settings + patch.
2. Session manager: `runWhenIdle({ instanceIds, idleForMs, detail }, effect)` primitive with an
   admission gate in `open`; focused tests.
3. Hoist `ProviderMaintenanceRunner` into server-lifetime layers; ws.ts reuses it.
4. `ProviderAutoUpdater` service: 1-minute poll after a 5-minute startup wait, candidate selection, backoff; tests.
5. Surfaces: web settings toggle, mobile settings toggle, MCP environment toolkit, user + internals docs.
6. Targeted typecheck/lint/tests; commit. (done)
7. (Optional, needs the user's go-ahead) a real-client pass: enable the setting on a dev server with an outdated provider.

## Findings / gotchas

- `ProviderMaintenanceRunner.layer` is provided inside `layerWsRpc` in `apps/server/src/ws.ts`, i.e.
  per connection. Its `commandCoordinator` lock ("An update is already running…") was therefore
  per client.
- `ProviderSessionManagerV2.get` touches activity, which bumps `idleGeneration`; releasing with
  `onlyIfIdleGeneration` therefore safely skips a session someone just picked up.
- Not covered by the gate: text-generation helpers (titles/commit messages) spawn provider CLIs
  directly. They are short and user-triggered; accepted risk.
- Wrapping all of `open` in `admitOpen(...)` made the formatter re-indent ~130 lines (merge-conflict
  bait for upstream syncs). Applying it as `.pipe(...)` on the inner `Effect.gen` keeps the diff to
  one line. That puts admission inside the per-session open lock, which is safe: `releaseEntry` only
  takes that lock from its forked record-retry fiber.
- The gate claim must be in `Effect.acquireUseRelease`: an interrupt between claiming and
  installing `ensuring` would leave the instance's opens blocked forever.
- Older servers have no `autoUpdateProviders`; clients decode the missing key as `false`, and a
  write is dropped by the old server's patch schema. No capability flag was added (fork-only, all
  of the user's servers run the fork).
- Pre-existing, unrelated test failures on Windows: `McpHttpServer.test.ts` "saves the snapshot PNG"
  (JSON-escaped `\` paths) and `OrchestratorMcpToolkit.integration.test.ts` "Codex replay transcript"
  (`C:\C:\…` fixture path).
- `OrchestratorMcpToolkit.integration.test.ts` "delegates cross-provider tasks" is load-sensitive
  (40–120 s per run, with a 10 s real-time `delegate_task` wait inside). It failed several times with
  this change while the machine sat at ~63% CPU from other work; baseline comparison in progress.

## Progress log

- [x] 1. Contracts (`autoUpdateProviders`, default `false`)
- [x] 2. Session manager `runWhenIdle` + admission gate; 4 tests (gate test verified to fail without the gate)
- [x] 3. Runner hoisted to server lifetime (`server.ts`), `ws.ts` reuses it
- [x] 4. `ProviderAutoUpdater` + 7 tests; runner says "Provider updated automatically while idle."
- [x] 5. Web row + search entry, mobile row, MCP environment tools, `docs/user/updating.md`, `docs/internals/providers.md`
- [x] 6. Checks + commit — typecheck clean (server, web, mobile, contracts); targeted tests green (93). Committed 2026-10-27 3:05 PM PDT by the thread-priority thread during a master cleanup, after this thread sat idle for three days. The load-sensitive `delegates cross-provider tasks` baseline comparison was never finished; see Findings.
- [ ] 7. Optional real-client pass (needs the user's go-ahead)

## Open questions for the user

None yet.

## Things not to do

- Don't update while any session of that driver is busy or pinned by background work.
- Don't build a second runner instance for the auto-updater; it must share the update lock.
- Don't enable the setting in the user's live `~/.t3/userdata` settings; they flip it themselves.
