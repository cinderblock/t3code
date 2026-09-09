# Merge upstream/main into master — 2026-09-09

## Goal

Bring `master` up to date with `upstream/main` tip **`383cc40f4`** (2026-09-09, past
`v0.0.40`, on the v0.0.41 nightlies): **694 commits** since the 09-02 merge
(`695c34520`, upstream `b9b1b8fdd`). Merge, not rebase — standing decision.

Predecessors: [`merge-upstream-main-2026-09-02.md`](./merge-upstream-main-2026-09-02.md)
(upstream absorbing the fork's caches; the elevated-app restart recipe),
[`merge-upstream-main-2026-08-26.md`](./merge-upstream-main-2026-08-26.md) (worktree
technique, union-fusing trap).

## Environment / context

- Shared checkout `C:\Users\camer\git\t3code` on `master` = `efd0cc159`. Merge work in a
  fresh dedicated worktree `C:\Users\camer\git\t3code-merge-v0.0.40`, branch
  `merge/upstream-v0.0.40` (created from master).
- Divergence at start: 130 ahead / 694 behind.
- No other active sessions (contention markers clean); this session announced as `f6644379`.
- Upstream bumped **Effect beta.103 → rc.112** (#10652) and vite-plus 0.3.0 (#9327) in
  this range. Fork-only Effect code (quota, fork migrations, shell diagnostics) has never
  been compiled against rc.112 — expect typecheck fallout there, not just in conflicts.

## Predicted conflicts (14 files, from `git merge-tree master upstream/main`)

Fork-fix-bearing — fork fix MUST survive:

| file | what must survive | upstream's reason for touching it |
| ---- | ----------------- | --------------------------------- |
| `apps/server/src/processRunner.ts` | **spawn-storm fix** — first upstream touch since | export classification (#10274), Effect rc.112 (#10652) |
| `apps/server/src/vcs/VcsStatusBroadcaster.ts` | fork `statusRefreshSemaphore` concurrency cap | export classification, project defaults (#9754), PR discovery (#9125) |
| `packages/client-runtime/src/state/shell.ts` | fork shell-stream diagnostics (`shell-subscribed`, silence readability) | sidebar perf (#10413), unused-export removal (#10167) |
| `apps/web/src/components/chat/ChatComposer.tsx` | fork queue-draft popover | — |
| `apps/desktop/src/preview/Manager.ts` | fork external-link policy (popup-first ordering from 09-02) | — |
| `apps/server/src/project/ProjectFaviconResolver.test.ts` | fork Windows-proofing of the cache test (09-02) | — |
| `apps/desktop/scripts/start-electron.mjs` | fork oxlint-disable + below-normal priority launch | Linux cookie keys (#7261) |

Likely upstream-drift, take upstream shape + re-apply fork additions:

- `apps/server/src/git/GitWorkflowService.ts`, `apps/server/src/mcp/McpHttpServer.ts`
- `apps/desktop/src/ipc/methods/preview.ts`, `apps/web/src/components/preview/PreviewView.tsx`
- `packages/client-runtime/src/rpc/session.ts`
- `packages/contracts/src/{ipc,rpc}.ts`

## Plan / steps

1. [x] Fetch, size the merge, peer check, announce, create worktree + branch.
2. [x] Write this plan; commit on the merge branch.
3. [ ] `git merge upstream/main`; resolve the 14 conflicts, fork-bearing first.
4. [ ] `pnpm install` (Effect rc.112!), typecheck, fix fork-only Effect API fallout, lint.
5. [ ] Suites: web, contracts, desktop, shared, client-runtime, server; compare failures
       against unmerged master before blaming the merge (09-02 plan has the baseline).
6. [ ] Commit merge; push branch; `git merge --ff-only` into master; `pnpm install`
       there; push master; ff the `main` mirror.
7. [ ] Rebuild desktop; restart GUI via the elevated scheduled-task recipe (09-02 plan).
8. [ ] Update this plan; release contention marker; remove worktree.

## Findings / gotchas

- (running log)

## Things not to do

- Don't rebase, don't force-push, don't `git checkout --`/`restore`/`reset --hard`.
- Don't take either side wholesale in `processRunner.ts` or `VcsStatusBroadcaster.ts`.
- Union-merge only complete syntactic units (08-26 "trap that cost the most time").
- All conflict work in the worktree; never leave the shared checkout conflicted.
