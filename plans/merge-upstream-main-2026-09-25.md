# Merge upstream/main into master — 2026-09-25

## Goal

Bring `master` up to date with `upstream/main` tip **`7a12aff471`** (2026-09-25, v0.0.43
nightlies): **643 commits** since the 09-09 merge (`8a2ee67803`, upstream `383cc40f4`).
Merge, not rebase — standing decision.

Predecessor: [`merge-upstream-main-2026-09-09.md`](./merge-upstream-main-2026-09-09.md).

## Environment / context

- Shared checkout `C:\Users\camer\git\t3code` on `master` = `9fc50e3b9`. Merge done directly
  in the shared checkout this time: the tree was clean (only untracked plan files), no peer
  session markers, and the other worktree (`.t3/worktrees/.../task-manager-sidebar`) is on
  its own branch.
- Divergence at start: 153 ahead / 643 behind. Tag range v0.0.41-nightly.20260909 →
  v0.0.43-nightly.20260925.
- Effect rc.112 → rc.115 arrived in this range (lockfile), alchemy beta.76 → beta.79.

## Conflicts (20 files) and how each was resolved

Almost all were "both sides appended to the same list" — keep both:

| file                                                                                                             | resolution                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/desktop/src/preview/Manager.ts`                                                                            | fork `will-navigate` hook + upstream recording-input IPC, both kept                                                                                                                                                                                                           |
| `apps/desktop/src/window/DesktopApplicationMenu.test.ts`                                                         | fork Ctrl+W test kept whole, upstream's two Paste-as-Text tests appended                                                                                                                                                                                                      |
| `apps/server/src/git/GitWorkflowService.ts`                                                                      | fork `graphSnapshot`/`worktreeChanges` kept; upstream's `createWorktree(input, options)` signature                                                                                                                                                                            |
| `apps/server/src/process/externalLauncher.ts`                                                                    | fork concurrent + 2s-timeout editor detection kept; upstream replaced `resolveAvailableCommand` with `resolveEditorCommand(editor, env)` (from `@t3tools/shared/editor`), swapped in                                                                                          |
| `apps/server/src/server.ts`                                                                                      | both imports; fork's `QueuedMessageService`+`Checkpointing` slot kept (pipe 20-arg ceiling); `UsageHistoryRecorder.layer` merged into upstream's Terminal/Preview/Device slot                                                                                                 |
| `apps/server/src/vcs/GitVcsDriverCore.ts`                                                                        | both imports; fork graph entries + upstream createWorktree                                                                                                                                                                                                                    |
| `apps/web/src/components/ChatView.tsx`                                                                           | both lazy imports; fork `onQueueDraft` kept, upstream `onCompactContext` + `restoreQueuedMessagesToComposer` appended                                                                                                                                                         |
| `apps/web/src/components/RightPanelTabs.tsx`                                                                     | `GitPullRequest` import dropped (upstream uses `PullRequestGlyph`); fork History surface + upstream Device surface; added `gitGraph` to upstream's new `SURFACE_UNAVAILABLE_HINTS`                                                                                            |
| `RightPanelTabs.test.tsx`, `_chat.pull-requests.tsx`                                                             | both prop sets                                                                                                                                                                                                                                                                |
| `apps/web/src/components/Sidebar.tsx`                                                                            | upstream extracted the header into a component with its own New project button — fork's Tooltip New project button dropped as superseded; fork host-filter toggle row re-attached after the header component, inside the same `SidebarGroup`. `Input` import dropped (unused) |
| `apps/web/src/components/chat/ChatComposer.tsx`, `rightPanelStore.ts`                                            | both                                                                                                                                                                                                                                                                          |
| `docs/user/thread-sidebar.md`                                                                                    | upstream multi-model paragraph, then fork "Filter the list" section                                                                                                                                                                                                           |
| `packages/client-runtime/src/environment/descriptor.ts`                                                          | upstream `client.descriptor()` (group client flattened) wrapped in the fork's auth-timeout retry                                                                                                                                                                              |
| `packages/client-runtime/src/rpc/client.ts`, `state/vcs.ts`, `state/shell.ts`, `packages/contracts/src/index.ts` | both                                                                                                                                                                                                                                                                          |
| `pnpm-lock.yaml`                                                                                                 | took upstream, then `pnpm install` regenerated fork entries                                                                                                                                                                                                                   |

## Findings / gotchas

- **Upstream now has a client-side message queue** (`useQueuedMessageStore`,
  `useQueuedMessages`, `onSend(..., queuedMessage)`) alongside the fork's server-side
  `QueuedMessageService` (cap-hit auto-queue). Both compile side by side; they are separate
  features. Worth revisiting whether the fork's server queue should be rebuilt on top of
  upstream's, but not in this merge.
- Upstream added a **Device** right-panel surface (shortcut `M`) — fork's History surface
  keeps `H`.

### Post-merge typecheck fallout (outside the conflict hunks)

- `ChatView.tsx`: `randomUUID` imported twice (fork line + upstream's `cn, randomHex, randomUUID`);
  fork's `queuedMessages` (server queue atom) collided with upstream's new `queuedMessages`
  (client queue). Fork variable renamed to `serverQueuedMessages`.
- `ChatComposer.tsx`: four imports (`ElementContextDraft`, `ComposerPendingElementContexts`,
  `ComposerPendingReviewComments`, `ComposerPreviewAnnotationCards`) pointed at modules upstream
  deleted in #11265; the merged file no longer used them. Dropped.
- `NodeSqliteClient.layerMemory()` was removed upstream (#9917). Fork tests
  (`ForkMigrations.test.ts`, `UsageHistoryRecorder.test.ts`) now use
  `NodeSqliteClient.layer({ filename: ":memory:" })` like upstream's migration tests.
- `ForkMigrations.test.ts`: `assert.deepStrictEqual` now infers a mutable array type from the
  first argument; annotated as `ReadonlyArray<ReadonlyArray<number | string>>`.

### Check results

- Typecheck: contracts, shared, client-runtime, server, web, desktop all clean (contracts emits
  Effect LSP _suggestions_ only).
- Lint on the 21 touched files: warnings only, all in pre-existing ChatView patterns.
- `vp fmt --check`: server.ts reflowed, otherwise clean.
- Tests: desktop menu + preview Manager (105 pass); server fork migrations, usage recorder,
  externalLauncher, queue (44 pass, 22 skipped); web RightPanelTabs + rightPanelStore (86 pass);
  client-runtime environment/shell/vcs (19 pass); server GitWorkflowService pass.
- **Pre-existing Windows failure, not from the merge:** `GitVcsDriverCore.test.ts` case from
  upstream #8086 writes a file literally named `:(exclude)after.ts`; NTFS rejects the colon
  (`ENOENT`). Not present on master before the merge; upstream CI is Linux/macOS. Left alone.

## Progress log

- [x] Fetch, size, peer check, announce.
- [x] `git merge upstream/main`; 20 conflicts resolved (script-driven, spot-checked).
- [x] `pnpm install`, typecheck touched packages, lint, fmt, focused tests.
- [x] Merge commit on `master`; pushed to origin.
- [x] Release contention marker.

## Things not to do

- Don't rebase master onto upstream. Merge only.
- Don't drop `Layer.mergeAll(QueuedMessageService.layer, CheckpointingLayerLive)` into
  separate `provideMerge` calls — the server.ts pipe is at the 20-argument ceiling.
