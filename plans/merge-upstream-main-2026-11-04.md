# Merge upstream/main into master — 2026-11-04

## Goal

Bring `master` up to date with `upstream/main` tip **`67eebaca23`** (2026-11-04): **1,445 commits**
since the 10-27 merge (upstream `570d4b03ee`). The user also asked that the fork's features work
well with upstream's **new beta UI**.

Predecessor: [`merge-upstream-main-2026-10-27.md`](./merge-upstream-main-2026-10-27.md).

## Environment / context

- Dedicated worktree `C:\Users\camer\.t3\worktrees\t3code\merge-upstream-2026-11-04`, branch
  `merge/upstream-2026-11-04`, from `master` = `eb78ee61e9` (1,603 ahead of `origin/master`, not pushed).
- Shared checkout `C:\Users\camer\git\t3code` stays on `master` until the fast-forward.
- Use the worktree's own `node_modules/.bin/vp`; `vp i --no-frozen-lockfile` after the merge.
- Merge log `C:\temp\merge-1104.log`, conflict list `C:\temp\conflicts-1104.txt`.

## What "the new beta UI" means

**Corrected 2026-11-05:** the user pointed at Theo's video "Agents Sucked At UI (Until Today)"
(https://www.youtube.com/watch?v=xq0eB8vxeqk, 2026-11-03), linked from upstream PR #25251. The beta
UI is the **New design**, not the boring sidebar:

- #24865 (10-25): UI overhaul behind a Settings → Beta toggle.
- #25251 (10-26): color back where it means something. Identity icons in color; action and state
  in T3 blue (`primary`/`info`); semantic add/delete colors; wake times blue with a clock; shelf
  headers "label, count, chevron"; shelf rows drop the PR number.
- #25600: dark-mode emphasis. **#25778 (10-27): the new design is the only design, no toggle.**
  It is in this merge, so every fork surface already renders in the new design.
- The video covers the process (a model council scoring screenshots), not a spec. Its transcript
  was saved to session scratch only.

So the job is a design audit of every fork UI surface against the New design, plus a real-client
visual pass. The boring-sidebar work (below) still stands; it is a separate Beta option.

Fork sidebar features that must also work in the boring sidebar: host filter, thread priority
arrow + inbox order, blocked threads, Scheduled section (send-later), snooze until usage reset,
Working section behavior, Ctrl+W settle, Alt+Enter send-and-next.

### New-design audit findings

- [x] Blocked rows reused the snooze wake slot (blue alarm clock, "Wake thread now"). Now a muted
      waiting icon + truncated "Waiting on X", action "Stop waiting" (`1e50dc14b0`).
- [x] Scheduled/Blocked rows had no keyboard-tree parent; every shelf now links (`1e50dc14b0`).
- [x] "Scheduled" row status now `info` blue (`1e50dc14b0`).
- [x] Audit of other fork surfaces (read-only agent), fixes in `d30315555e`: queue rows on
      `ComposerBannerStack` (detached); usage strip + queue follow Chat width; trigger picker on
      RadioGroup/ToggleGroup; block dialog check + outline Cancel; History subheader + RefreshIcon;
      send-later tooltip; palette "Set priority to high" + check; one primary button on pairing.
- [x] Usage strip now reads **% left** in the provider's accent color (warning/destructive near
      the cap, pace tick at time left), matching upstream's Limits bars. History chart kept (user,
      2026-11-05): labels say "used", series in the provider color, drawn at measured width so
      labels stay `text-3xs` (`6657393378`).
- [x] Nitpicks fixed (`36af67f183`): History refs on `Badge` (current `info`, remotes `label` in
      per-remote color, tags `outline` + icon); preview External links help cut to one line; only
      the first Inbox order setting carries the boring-sidebar note.
- [x] Real-client visual pass: the user will check it in the relaunched desktop app (2026-11-05).
      A hidden preview tab neither paints nor takes input (see ISSUES.md), so it can't be done
      headless here.

## Decisions already made (don't re-ask)

- Merge, not rebase; dedicated worktree; `master` only moves once verified (standing).
- Merge the tip of `upstream/main`.
- Telemetry stays off for this fork (10-19, 10-27).

## Conflicts (69 files)

Resolution table filled in as files are done.

| file                                                                                                                                                                                        | resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| web `Sidebar.tsx`                                                                                                                                                                           | upstream boring-sidebar folders + multi-project scope; fork host filter, Scheduled/Blocked shelves, priority, next-waiting re-applied. **Boring mode:** no Working shelf (upstream), so Scheduled threads stay in their folders but rows still read "Scheduled" (keys load from the user's setting, not the effective working-shelf flag); Blocked keeps its own shelf below folders like Snoozed; folder threads sort by latest send _within_ priority groups (`sortThreadsByPriority`); pinned folders whose projects live only on hidden hosts are dropped. Fork capability gating kept only for `threadBlocking`/`threadPriority` (upstream gates snooze/settle/pin on `configLoaded` now). `hostsUndoNotice` gone (upstream moved the undo notice to the footer). Host-filter empty state speaks upstream's multi-scope ("in these projects"). |
| web `Sidebar.snooze.ts`                                                                                                                                                                     | upstream configurable presets (`environmentId`, `pickSnoozePreset`) + optional fork `resets` arg passed through to the shared options                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| web `Sidebar.logic(.test).ts`                                                                                                                                                               | fork wait-tier/next-waiting + host filter helpers kept; upstream dropped `shouldClearThreadSelectionOnMouseDown`, `archiveSelectedThreadEntries`, exported `SidebarProjectScopeMenuState`; new `sortThreadsByPriority`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| web `sidebar/SidebarThreadRow.tsx`                                                                                                                                                          | upstream folder/multiline rows + `TopStatusIcon` map; fork `scheduled: ClockIcon` added to the map, priority arrow beside the pin in slim/folder and card rows, snooze menu passes usage resets                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| web `uiStateStore(.test).ts`                                                                                                                                                                | upstream `sidebarProjectScopeKeys[]` + fork `sidebarHiddenEnvironmentIds` and host actions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| web `useThreadActionMenu(.test).ts`, `useThreadActions.ts`                                                                                                                                  | upstream dropped the snooze/settle/pin capability readers (`configLoaded`); fork blocking/priority readers kept; usage resets passed to snooze presets                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| client-runtime `state/shell.ts`                                                                                                                                                             | upstream batched delta apply; fork shell diagnostics now per batch (coarser: first stale delta per batch; heartbeat at 1 and each multiple of 10)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| client-runtime `state/threadCommands.ts`                                                                                                                                                    | upstream's trimmed type re-exports; fork block/unblock/setPriority inputs re-imported                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| client-runtime `state/threadSettled.ts`                                                                                                                                                     | fork usage-reset presets folded into upstream `SnoozePresetOptions.resets`; appended after upstream's configurable presets; `pickSnoozePreset` re-resolves reset ids; `isUsageResetSnoozePreset(id: string)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| client-runtime `state/threadInbox.ts`                                                                                                                                                       | fork shelf model (Working/Scheduled, blocked excluded) + upstream perf tweaks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| mobile thread list (`threadListV2`, `useThreadListV2`, `thread-list-v2-items`)                                                                                                              | upstream memoized layout + `pickSnoozePreset`; fork scheduled keys, inbox directions, priority, resets                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| mobile `thread-list-environments.ts`, `usage.ts`, `ThreadSettingsSections.tsx`                                                                                                              | upstream simplifications; fork `priorityEnvironmentIds` (+ `threadPriority` capability key), usage resets; `ListChoiceRow as SettingsChoiceRow` (upstream deleted `SettingsChoiceRow.tsx`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| server auth (`EnvironmentAuth`, `RpcAuthorization`, `utils`, `http.test`), `RpcInstrumentation`, contracts `rpc.ts`                                                                         | fork public access/passkeys + scopes kept; Effect 4.1.2 `Digest`/`SecureRandom`; upstream-deleted `subscribeBackgroundPolicy` dropped; `http.ts` re-imports `AuthAccessReadScope` (upstream deleted its last use, fork `publicAccess` still needs it)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| contracts `orchestrationV2.ts`                                                                                                                                                              | fork `priority`/`blockedOn` + upstream `tags`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| server orchestration-v2 (`IdleCompaction*`, `ProjectionStore`, `ProjectionMaintenance`, `ProviderSessionManager`, `ThreadSettlementService`, `runtimeLayer`, tests)                         | both sides; **upstream deleted `lastActivityAtMs` as unused but fork `runWhenIdle` needs it — restored**; side chats no longer compact-before-send (upstream's lineage rule)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| server `ws.ts`/`ws.test.ts`, `VcsStatusBroadcaster.test`, `AgentContextBudget.test`, `migrate-dev-db(.test)`                                                                                | both sides; `agentContextBudget.json` `mcpToolListJsonBytes` re-measured = 49296                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| client-runtime `connection/supervisor(.test).ts`                                                                                                                                            | fork productive-connection ladder + upstream silent-route backoff                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| web chat (`ChatComposer`, `useComposerSend`, `useThreadLifecycle`, `ChatView*`, `ComposerAttachmentStrip`, `RightPanelSurfaceContent`, `composer-logic`)                                    | upstream side chats / prompt history / env contexts + fork queue-later, Alt+Enter, Ctrl+W, priority keys, mobile attach; `ChatView.logic` queued-behind-compaction takes upstream's runtime-status rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| web settings/auth/misc (`Connections*`, `AuthorizedClients`, `PairingRouteSurface`, `PreviewView`, `primary/auth.ts`, `entities.ts`, `_chat.index`, `CommandPalette`, `contextWindow.test`) | both sides; upstream removed unused capability readers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| web `settingsSearch.ts`                                                                                                                                                                     | fork scheduled/inbox-order entries + upstream boring-sidebar entries                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

## Findings / gotchas

- **Effect 4.1.2 removed `effect/Crypto`.** Fork files that merged cleanly still imported it
  (`mcp/toolkits/sendLater/*`, `ThreadBlockService`) → `effect/crypto/SecureRandom` (`uuidV4`).
  Fork tests needing auth/git layers now also need `NodeCrypto.layer` (+ `ManagedPolicy.layerTest()`).
- New upstream Effect diagnostic `processEnvInEffect`: fork `CpuProfiler`/`EventLoopLagMonitor`
  read env through `Config.String` now.
- MCP toolkit tests use `McpHttpServer.layerInProcessMcpServer`, not `McpServer.McpServer.layer`.
- Upstream added _environment contexts_ (@-mention a machine). The fork's queue-later path now
  carries them (send, stranded-context warning with `linkedEnvironments`, restore on cancel) and
  refuses `/side` like other local commands.
- Duplicate helpers: `hasDismissedResumeCompaction`/`shouldOfferResumeCompaction` exist in both
  fork `@t3tools/shared/claudeCompaction` and upstream `client-runtime/state/contextWindow` (different
  input shapes). Left as is; worth deduplicating later.
- Auto-merge silently dropped the fork's `isSidebarThreadWorking` re-export from `Sidebar.logic.ts`;
  only typecheck caught it.

## Progress log

- [x] Worktree + merge started (69 conflicts).
- [x] Conflicts resolved (3 parallel agents + lead on sidebar).
- [x] `vp i --no-frozen-lockfile` (4.5 min).
- [x] Typecheck: contracts, shared, client-runtime, provider-core, server, web, desktop, mobile all clean.
- [x] Tests for every test file beside a file that differs from upstream: web 631, client-runtime
      281, contracts 82, shared 153, provider-core 8, mobile 121 + thread folder 314, desktop 92,
      server 1,333. Fixed along the way: fork runtimeLayer test answered only one of two questions
      (upstream now refuses partial answers before the archived check); mobile
      `useThreadListV2.test` needed a stable `scheduled-messages` mock (real hook pulls in Expo).
      **Remaining failures are upstream-only Windows tests in files the fork doesn't change**
      (path separators / CRLF): `GitVcsDriverCore` ×10, `userInputAttachments` ×3,
      `ThreadMessageIntake` ×1, `ServerEnvironment` ×1, `GuestShareService` ×1,
      desktop `DesktopClientSettings` symlink ×1, mobile `checkout-new-task-branch` ×8.
- [x] `vp fmt` on the 199 files differing from both parents; lint clean except fork
      `no-low-value-comments` (already in ISSUES.md).
- [x] Boring-sidebar audit of fork features (see the Sidebar row; settings text + `docs/user/thread-sidebar.md` updated).
- [x] Pre-commit hook (lint + knip on staged files) forced fork cleanup: 39 long comments trimmed,
      `GitGraphPanel` brought to upstream's React/shadcn rules, 35 unused fork exports un-exported
      or deleted (dead `ForkMigrationsLive`, `processSpawnObserver` layers), fork scripts added
      as knip entries, web `ChatView` back on upstream's `client-runtime` resume-compaction helpers.
      Remaining fork lint debt (45 errors, untouched files) logged in ISSUES.md.
- [x] Merge commit `8131be7e66`; `master` fast-forwarded (2026-11-05 12:33 AM PST).
- [x] Idle restart watcher started 2026-11-05 12:33 AM PST (08:33Z), pid 31416, via WMI; log
      `C:\temp\t3runs\restart-when-idle.log`. It waits for this thread to go idle.
- [x] Worktree + branch removed.
- [x] Push `master` to `origin` — approved by the user 2026-11-05.
- [x] Idle restart watcher restarted after the design fixes (see Progress log tail).

## Open questions for the user

All answered 2026-11-05: beta UI is the New design; push yes; usage strip to upstream's style
(keep the chart); the user does the visual check in the relaunched app; the boring-sidebar choices
(Scheduled stays in folders, priority within folders, Blocked a shelf) still apply, since the
boring sidebar survives as a Labs option rendered in the New design.

## Things not to do

- Don't rebase master onto upstream.
- Don't start a server from the worktree against `~/.t3/userdata`.
- Don't trust a zero-error typecheck without reading the log tail.
