# Merge upstream/main into master — 2026-09-02

## Goal

Bring `master` up to date with `upstream/main` tip **`b9b1b8fdd`** (2026-09-02, past
`v0.0.38`, on the v0.0.39 nightlies). Two stages:

1. **Land the already-verified v0.0.34+v0.0.35 merges** sitting on
   `merge/upstream-v0.0.35` (= `cdada9797`) — blocked since 08-27 only by uncommitted
   edits to the 08-11 plan doc, now committed on master as `1ce3c0a41`.
2. **Merge the further 263 upstream commits** (since `d3c24a14b`, v0.0.35) on the same
   branch, in the dedicated worktree, then fast-forward `master`.

Predecessors: [`merge-upstream-main-2026-08-26.md`](./merge-upstream-main-2026-08-26.md)
(worktree technique, union-fusing trap), [`merge-upstream-main-2026-08-11.md`](./merge-upstream-main-2026-08-11.md)
(rename-before-merge for add/add collisions). Merge, not rebase — standing decision.

## Environment / context

- Shared checkout `C:\Users\camer\git\t3code` on `master`; merge work happens in the
  dedicated worktree `C:\Users\camer\git\t3code-merge-v0.0.34` (branch
  `merge/upstream-v0.0.34`; `merge/upstream-v0.0.35` points at the same commit — use
  the v0.0.35 name going forward per the 08-26 plan).
- Pre-merge geometry: `master` = `1ce3c0a41`, ffwds to `cdada9797`, which is
  123 ahead / 263 behind `upstream/main`.
- No other active sessions detected (workspace-contention markers clean); this session
  announced as `f6644379`.

## Decisions already made (don't re-ask)

- Merge, not rebase; no force-push, ever.
- Do the conflicted merge in the worktree so the shared checkout never sits in a
  conflicted state.
- The orphaned 08-11 plan-doc edits were committed on master (`1ce3c0a41`) rather than
  left to rot — they were finished documentation from a session dead since ~08-27.

## Predicted conflicts (16 files, from `git merge-tree cdada9797 upstream/main`)

Fork-fix-bearing — resolve deliberately, fork fix MUST survive:

| file                                                    | what must survive                                                                                          |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `apps/server/src/project/RepositoryIdentityResolver.ts` | **spawn-storm fix** (`repositoryRootCache`) — first time upstream has touched this file since the fork fix |
| `apps/server/src/project/ProjectFaviconResolver.ts`     | fork TTL cache + `walkForFavicon` (third merge in a row this conflicts)                                    |
| `apps/web/src/components/chat/ChatComposer.tsx`         | fork queue-draft control in upstream's footer                                                              |
| `apps/web/src/components/RightPanelTabs.tsx`            | fork commit-graph (History) surface                                                                        |
| `apps/web/src/components/ChatView.tsx`                  | fork gitGraph surface wiring                                                                               |

Likely upstream-drift, take upstream shape + re-apply fork additions:

- `apps/desktop/src/ipc/methods/preview.ts`, `apps/desktop/src/preview/Manager.ts`
- `apps/desktop/src/settings/DesktopClientSettings.test.ts`
- `apps/server/src/server.ts`, `apps/server/src/vcs/VcsStatusBroadcaster.ts`
- `apps/web/src/components/preview/PreviewMoreMenu.tsx`
- `apps/web/src/components/settings/SettingsPanels.tsx`
- `packages/contracts/src/{index,ipc,settings}.ts`
- `vite.config.ts`

## Plan / steps

1. [x] Commit the orphaned 08-11 plan edits on master (`1ce3c0a41`).
2. [x] Write this plan; commit on master so the branch sync picks it up.
3. [ ] Worktree: merge `master` into the merge branch (additive; picks up the two doc
       commits).
4. [ ] Worktree: `git merge upstream/main`; resolve the 16 conflicts, fork-bearing
       files first.
5. [ ] Worktree: `pnpm install`, typecheck, lint, targeted tests; compare failures
       against unmerged master before blaming the merge.
6. [ ] Commit the merge on the branch; push branch to origin.
7. [ ] Shared checkout: `git merge --ff-only` the branch into `master`;
       `pnpm install`.
8. [ ] Update this plan; release contention marker.

## Findings / gotchas

- The 42-line plan-file diff between master and the branch was pure `vp fmt` table
  re-padding; committing the orphaned edits through the pre-commit hook re-applied the
  same padding, so the copies converge.
- (running log below)

## Things not to do

- Don't rebase, don't force-push, don't `git checkout --`/`restore`/`reset --hard`.
- Don't take either side wholesale in `RepositoryIdentityResolver.ts` or
  `ProjectFaviconResolver.ts`.
- Don't union-merge conflict hunks whose sides share a closer outside the markers —
  see the 08-26 plan's "trap that cost the most time".
- Don't leave the shared checkout in a conflicted state; all conflict work in the
  worktree.
