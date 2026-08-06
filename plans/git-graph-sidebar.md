# Git graph right-panel surface

## Goal

Add a GitKraken/Tower/SourceTree-style graphical commit tree to T3 Code's right
panel. It renders the repository's history as a laned graph, shows where every
branch and tag (local and remote) points, and adds synthetic rows at the top for
uncommitted work — one pair (unstaged / staged) per worktree.

Selecting any row slides a change list up over the bottom ~60% of the panel.
Selecting a change in that list opens its diff in the main view.

## Decisions already made (don't re-ask)

| Decision         | Value                                                                                                                         | Reason                                                                                                                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mutations in v1  | **None — read-only viewer.** No checkout, stage, commit, discard, branch ops.                                                 | Keeps v1 shippable. Actions are a follow-up; they need conflict/error UX that doubles the scope.                                                                                       |
| Surfaces         | **Web + desktop.** Desktop wraps web, so it is one implementation. Mobile is out of scope.                                    | A laned commit graph is a poor fit for a phone; mobile can get a linear history later.                                                                                                 |
| Graph scope      | **The project's git repo, with every worktree represented.** Includes T3's per-thread worktrees under `<baseDir>/worktrees/`. | Matches the mental model of a desktop git client and makes cross-thread work visible.                                                                                                  |
| Panel placement  | **A new right-panel tab surface**, not a second right-hand region.                                                            | There is no "right sidebar" in this codebase (see Findings §1). The right panel is a tab list with a surface registry; a new region would fight the existing resize handle and layout. |
| Lane layout      | **Computed client-side** from `(oid, parents[])`.                                                                             | Keeps the wire payload small (AGENTS.md perf rule) and lets the client re-layout on scroll/expand with no round trip. Never parse `git log --graph` ASCII art.                         |
| Diff destination | **Main view**, hiding the chat column.                                                                                        | Explicit user request, and it matches every desktop git client. See "Open questions" #1 for the tension this creates.                                                                  |

## Environment / context

- Repo: `C:\Users\camer\git\t3code`, branch `debug/crash-investigation` at the time of writing.
- Monorepo: `apps/{web,server,desktop,mobile,marketing}`, `packages/{contracts,client-runtime,shared,...}`.
- Package manager is **pnpm** with `vp` (vite-plus) as the task runner — `vp i`, `vp run dev`, `vp test run <files>`. This repo does _not_ use Bun despite the global preference.
- Dev: `vp run dev` starts server + web. Worktree state defaults to that worktree's gitignored `.t3`.
- Verification rule from `AGENTS.md`: targeted tests/lint/typecheck only. **Do not run repo-wide `vp check` / `vp run -r test`.**

## Findings from the codebase survey

### 1. There is no right _sidebar_ — there is a tabbed right _panel_

Nothing uses `<Sidebar side="right">`. The right-hand surface is owned by `ChatView`:

- `apps/web/src/components/RightPanelTabs.tsx:272` — tab strip, `+` add-surface menu, context menu, empty state.
- `apps/web/src/components/preview/PreviewPanelShell.tsx:26` — the chrome. `PreviewPanelMode = "inline" | "sheet" | "sidebar" | "embedded"` (line 9). Inline mode is a `shrink-0 border-l` flex child sized by `useResizableWidth` (default 540, min 360, max 70vw, localStorage `t3code:preview-panel-width`).
- `apps/web/src/components/preview/RightPanelResizeHandle.tsx` — hand-rolled 8px drag handle.
- `apps/web/src/rightPanelLayout.ts:1` — `(max-width: 980px)` flips inline → `RightPanelSheet.tsx`.

State is **zustand**, per-thread, persisted:

- `apps/web/src/rightPanelStore.ts:238` — `create()(persist(...))`, localStorage key `t3code:right-panel-state:v2`, version 7, with `migratePersistedRightPanelState` at line 156.
- `byThreadKey: Record<string, { isOpen, activeSurfaceId, surfaces }>` (line 45), keyed by `scopedThreadKey(ScopedThreadRef)`.

**The surface registry** — `apps/web/src/rightPanelStore.ts:17`:

```ts
export const RIGHT_PANEL_KINDS = ["plan", "diff", "files", "file", "preview", "terminal"] as const;
```

Rendering switch: `rightPanelContent` in `apps/web/src/components/ChatView.tsx:5777-5850`.

**Gotcha:** `updateThread` (`rightPanelStore.ts:135`) _deletes the thread entry entirely_ when it lands on `{isOpen:false, activeSurfaceId:null, surfaces:[]}`. A surface that expects to persist a closed-but-present state must account for that pruning.

### 2. The app shell, and what "main view" means

`apps/web/src/components/AppSidebarLayout.tsx:119`, mounted from `routes/__root.tsx:118`:

```
<SidebarProvider>
  <Sidebar side="left" collapsible="offcanvas" resizable>…</Sidebar>
  {children}            // route Outlet → SidebarInset (<main>) → ChatView
  <SidebarControl />
</SidebarProvider>
```

The right panel is **not** a shell-level sibling of the left sidebar — it lives inside `children`, composed by `ChatView` (`ChatView.tsx:5852-5853`, `6249`) as a horizontal flex of [chat column] + [right panel].

There are **no main-view modes** today. Routes are TanStack Router file routes and the main area is always the chat thread. Files and diffs currently open as _right-panel surfaces_, never in the main view.

The closest existing precedent for a main-view takeover is right-panel maximize, which collapses the chat column to `w-0 flex-none` (`ChatView.tsx:5858`) while leaving it mounted. **Reuse that trick** — `MessagesTimeline` is a virtualized LegendList and remounting it is expensive.

### 3. The git subsystem is large, mature, and Effect-based

Everything shells out to the `git` binary through one hardened runner. **No git library** (no isomorphic-git/simple-git/nodegit/dugite).

| Layer                    | Path                                                               |
| ------------------------ | ------------------------------------------------------------------ |
| Process spawn            | `apps/server/src/vcs/VcsProcess.ts` (30s timeout, 1 MB output cap) |
| Driver shape             | `apps/server/src/vcs/GitVcsDriver.ts`                              |
| **All git commands**     | `apps/server/src/vcs/GitVcsDriverCore.ts` (2883 lines)             |
| Status cache + broadcast | `apps/server/src/vcs/VcsStatusBroadcaster.ts`                      |
| Workflow routing         | `apps/server/src/git/GitWorkflowService.ts`                        |
| Checkpoints              | `apps/server/src/checkpointing/*`                                  |
| Review diff preview      | `apps/server/src/review/ReviewService.ts`                          |

Every invocation funnels through `gitCommand` (`GitVcsDriver.ts:362-392`) → `process.run({ command: "git", args: ["-C", cwd, ...args] })`.

### 4. Two contract gaps that force new procedures

Both verified by reading `packages/contracts/src/git.ts`:

- **`VcsRef` has no commit oid** (line 75-83): `{ name, isRemote?, remoteName?, current, isDefault, worktreePath }`. A ref cannot be placed on the graph without its oid. It also only covers `refs/heads` and `refs/remotes` — **tags are absent** (`GitVcsDriverCore.ts:2249-2288`).
- **`VcsStatusResult.workingTree.files` is flat** (line 214-224): `{ path, insertions, deletions }`. No status code (M/A/D/R), and **no staged-vs-unstaged split** — even though the server already runs `status --porcelain=2`, which carries both. So the synthetic rows need new data.

There is also **no commit-history data of any kind**. The only `git log` in the repo is `GitVcsDriverCore.ts:2018` (`log --oneline <range>`), consumed internally to generate PR bodies. A commit graph is greenfield.

### 5. What can be reused as-is

- **Diff rendering.** `getRenderablePatch()` (`apps/web/src/lib/diffRendering.ts:109`) turns unified patch text into `FileDiffMetadata[]` via `@pierre/diffs`; hand those to `AnnotatableCodeView` (`components/diffs/AnnotatableCodeView.tsx`). The worker pool is already mounted app-wide by `DiffWorkerPoolProvider`. **The wire format for every diff in this app is raw unified patch text** (`Schema.String`) — match that.
- **Changed-files list.** `ChangedFilesTree` / `ChangedFilesCard` (`apps/web/src/components/chat/ChangedFilesTree.tsx`) already renders a nested directory tree with per-directory +/− stats and single-child compaction (`lib/turnDiffTree.ts:56-78`). Its item type is `OrchestrationCheckpointFile { path, kind, additions, deletions }`. **Shape the new change list to that exact struct and the slide-up panel renders for free.**
- **Ref snapshot caching.** `GitVcsDriverCore.ts:2377-2400` caches the `for-each-ref` snapshot per `--git-common-dir` with epoch/generation invalidation. Extend this rather than adding a parallel cache.
- **Client command throttling.** `vcsCommandScheduler` / `vcsCommandConcurrency` (`packages/client-runtime/src/state/vcsCommandScheduler.ts`).

### 6. The RPC pattern (Effect RPC over WebSocket)

Nine mechanical steps to add a read procedure. Verified against `vcs.listRefs`:

1. Method name → `WS_METHODS` in `packages/contracts/src/rpc.ts:181-291`
2. Payload/result schemas → `packages/contracts/src/git.ts`
3. `Rpc.make(WS_METHODS.x, { payload, success, error })` → `rpc.ts` (~line 551)
4. Register in `RpcGroup.make([...])` → `rpc.ts:857-944`
5. **Auth scope** → `apps/server/src/auth/RpcAuthorization.ts:71` (omitting this is a compile error)
6. Handler → `apps/server/src/ws.ts:1836` delegating to `GitWorkflowService`
7. Driver method → interface in `GitVcsDriver.ts:191-268`, implementation in `GitVcsDriverCore.ts`
8. Client atom → `packages/client-runtime/src/state/vcs.ts` (`createEnvironmentRpcQueryAtomFamily`)
9. Thin re-export → `apps/web/src/state/`

Streaming variants exist: `stream: true` for subscriptions (must also be added to `EnvironmentSubscriptionRpcTag` in `packages/client-runtime/src/rpc/client.ts:42-57`), and streaming commands for progress events.

Desktop IPC mirrors the contract in `packages/contracts/src/ipc.ts`.

## Design

### Wire model

Three new read-only procedures, all keyed on a `cwd` that the server resolves to a
repo via `--git-common-dir` (so two threads on different worktrees of one repo
share a cache entry).

**`vcs.graphSnapshot`** — one call returns everything needed to draw a page:

- `commits: { oid, parents: string[], summary, authorName, authorEmail, authoredAt, committedAt }[]`
  from `git log --date-order --parents --format=<NUL-delimited> -n <limit> --branches --tags --remotes HEAD`.
- `refs: { name, kind: "local" | "remote" | "tag", oid, current, isDefault, worktreePath }[]`
  from an extended `for-each-ref` that adds `refs/tags` and `%(objectname)`, plus
  `%(*objectname)` to peel annotated tags to their commit.
- `worktrees: { path, refName, headOid, isPrimary }[]` from the existing
  `worktree list --porcelain -z`.

Payload estimate: 500 commits ≈ 60 KB. Acceptable for one page; paginate beyond that.

**`vcs.rowChanges`** — the change list for one row. Discriminated input:
`{ kind: "commit", oid }` → `git diff --name-status --numstat <oid>^ <oid>` (root commits use the empty tree);
`{ kind: "unstaged", worktreePath }` → `git diff --name-status --numstat`;
`{ kind: "staged", worktreePath }` → `git diff --cached --name-status --numstat`.
Returns `OrchestrationCheckpointFile[]` so `ChangedFilesTree` consumes it unchanged.

**`vcs.rowFileDiff`** — unified patch text for one path within one row. Same
discriminated row input plus `path`. Returns `Schema.String`, matching every
other diff in the app.

### Lane layout (client-side)

Standard sweep over commits in the server's `--date-order`:

- Maintain `lanes: (oid | null)[]`, each slot holding the oid that lane is waiting for.
- For each commit, its column is the lane expecting its oid; if none, allocate the leftmost free lane.
- Replace that lane's expectation with `parents[0]`; route additional parents to lanes already expecting them, else allocate.
- Free lanes whose expectation is satisfied with no remaining children.
- Emit per-row edge segments (pass-through, branch, merge) for the SVG.

O(commits × lanes). Pagination must carry the open-lane state across the page
boundary or lanes will visibly reshuffle on load-more.

### Synthetic rows

Above the first commit, per worktree, up to two rows: **unstaged** then **staged**
(staged sits between unstaged and HEAD, which is the "extra step" from the
request). A row is omitted when empty. The active thread's worktree sorts first.

**Performance constraint — this is the main risk.** `VcsStatusBroadcaster` carries
exponential backoff specifically because a 14-repo machine once produced ~2600 git
spawns in 90 s. Fanning `status --porcelain=2` across every worktree on a timer
would recreate that. Rules:

- Synthetic-row status is fetched **only while the graph surface is visible**, in one
  batched call with a concurrency cap, and **only on explicit invalidation** — never on a timer.
- Invalidate on the signals that already exist: `refreshGitStatus(cwd)`
  (`apps/server/src/ws.ts:1012`, called from 10 mutation sites) and the post-turn
  `CheckpointReactor.ts:537` refresh.
- Reuse the already-running `subscribeVcsStatus` stream for the cheap
  `hasWorkingTreeChanges` bit so collapsed rows cost nothing.

### Client structure

- New surface kind `"gitGraph"` in `RIGHT_PANEL_KINDS`, plus `RightPanelSurface`
  union member, `singletonSurface()`, a storage `version` bump + `migrate` arm,
  `surfaceTitle()`, `SurfaceIcon()`, the `+` menu, `RightPanelEmptyState`, and the
  `rightPanelContent` switch.
- Surface state is per-thread (consistent with the panel), but **graph data is cached
  per repo** keyed by git-common-dir, so switching threads within a project is instant.
- Row virtualization is required — reuse LegendList as the timeline does.
- Graph glyphs as inline SVG per row. **No CSS animations on the graph** (AGENTS.md
  calls out animation-driven GPU spikes); the slide-up uses a single transform transition.

### Main-view diff

New main-view mode in `ChatView`. Chat column hidden with the existing
`w-0 flex-none` maximize trick so it stays mounted. New `GitDiffMainView` renders
`getRenderablePatch()` output through `AnnotatableCodeView`. Needs an obvious way
back to the chat — per AGENTS.md, "if you added a way in, add the way out."

## Plan / steps

Each phase is independently shippable behind a client setting
(`gitGraphEnabled`, following the `sidebarV2Enabled` pattern at
`packages/contracts/src/settings.ts:123`).

- [x] **Phase 1 — server graph data.** `vcs.graphSnapshot` end to end: contracts,
      auth scope, `GitVcsDriverCore` implementation (log parsing, extended
      `for-each-ref` with tags + oids), ws handler, focused server tests. Verifiable
      headlessly with no UI. **Done** — 18 tests pass (14 parser units, 4 real-git
      integration).
- [x] **Phase 2 — graph rendering.** Client atoms, lane-layout module + unit tests
      (this is the piece most worth testing in isolation), row list, SVG
      glyphs, ref chips. Read-only, no selection yet. New right-panel surface registered.
      **Done, but not yet seen running** — see "Phase 2 status" below.
- [ ] **Phase 3 — synthetic worktree rows.** `vcs.rowChanges` for staged/unstaged,
      batched per-worktree status with the invalidation rules above, rows rendered
      above HEAD.
- [ ] **Phase 4 — slide-up change list.** Bottom ~60% panel, `ChangedFilesTree`
      reused, row selection state.
- [ ] **Phase 5 — diff in main view.** `vcs.rowFileDiff`, `GitDiffMainView`,
      main-view mode in `ChatView`, exit affordance.
- [ ] **Phase 6 — polish.** Keybinding (`packages/contracts/src/keybindings.ts` +
      `packages/shared/src/keybindings.ts`), command palette entry, `docs/user/`
      page, `docs/internals/` note on the graph data flow.

## Things not to do

- **Do not parse `git log --graph` ASCII art.** Compute lanes from `--parents`.
- **Do not poll worktree status on a timer.** See the backoff incident above.
- **Do not remount `MessagesTimeline`** when entering the diff main view — hide the
  chat column, keep it mounted.
- **Do not send structured hunks over the wire.** Every diff in this app is unified
  patch text parsed client-side by `@pierre/diffs`; match it.
- **Do not widen `VcsStatusResult.workingTree.files`** to carry staged/unstaged.
  That contract is on the hot polling path and is also consumed by mobile; add a
  separate lazily-fetched procedure instead.
- **Do not add a second right-hand layout region.** Register a tab surface.
- **Do not use `git log --all`.** T3 writes checkpoint commits to
  `refs/t3/checkpoints/…` (`apps/server/src/checkpointing/Utils.ts:4`), and `--all`
  walks every ref under `refs/`, so checkpoints would appear as user history. The
  ref selection is `--branches --tags --remotes HEAD` plus each detached worktree's
  HEAD oid. There is a regression test for this.
- **Do not forget `RpcAuthorization.ts`** — a missing scope is a compile error, but
  the wrong scope is a security bug.
- **Do not let new procedures accept arbitrary cwds.** Mirror `ReviewService.ts:63-78`,
  which restricts to `config.cwd` or `config.worktreesDir`.

## Open questions for the user

1. **Diff in the main view is a new architectural precedent.** Today _every_ file and
   diff in T3 Code opens as a right-panel surface; the main view is always the chat.
   Sending git diffs to the main view is what was asked for and matches desktop git
   clients, but it means two different diff destinations depending on where you
   clicked. _Recommendation:_ build it as requested, but reuse the existing
   `diff` surface's rendering so the two stay visually identical.
2. **Tags:** include lightweight and annotated tags in v1? _Recommendation:_ yes —
   it is a few characters of `for-each-ref` format and the request named tags.
3. **History depth / pagination:** default page size and whether to offer "all
   refs" vs "current branch only". _Recommendation:_ 500 commits, `--date-order`,
   all refs, with load-more.

## Progress log

- [x] 2026-08-06 — Surveyed right-panel/layout architecture and the full git
      subsystem. Confirmed the two contract gaps (no ref oid, no staged/unstaged
      split) and that commit history is greenfield.
- [x] 2026-08-06 — Locked the three decisions in the table above.
- [x] 2026-08-06 — **Phase 1 landed.** `vcs.graphSnapshot` across contracts, auth,
      driver, workflow service, and the ws handler, with 18 passing tests. Targeted
      typecheck clean on `@t3tools/contracts` and `t3`; lint clean.

### Phase 1 deviations from the design above

Two things came out differently once the code was written. Both are deliberate.

1. **No shared cache with `listRefs`.** The plan said to extend the existing
   `for-each-ref` snapshot cache. In practice that snapshot feeds the branch
   toolbar on a hot path and carries no oids or tags; widening it would have put
   graph-shaped work on a path that runs whether or not the graph is open.
   `graphSnapshot` therefore does its own `for-each-ref` and returns a dedicated
   `VcsGraphRef` (with `oid` and `kind`), leaving `VcsRef` untouched. Cost: one
   extra `for-each-ref` per graph fetch, only while the graph is visible.
2. **No server-side cache at all yet.** `graphSnapshot` reuses
   `resolveRepositoryPaths` (which is cached) but performs a fresh walk each call.
   The client atom's `staleTimeMs` is the only coalescing. That is fine for a
   panel that only fetches when visible, but if Phase 2 shows repeated walks on a
   large repo, add an epoch/generation cache mirroring `resolveListRefsSnapshot`
   and invalidate it from `refreshGitStatus`.

### Phase 1 details worth carrying forward

- **Wire format is bigger than the plan's estimate.** Roughly 300 bytes per commit
  (40-char oid, 40-80 for parents, ISO-8601 timestamps via `Schema.DateTimeUtc`),
  so ~150 KB for 500 commits rather than 60 KB. Default page is therefore 200
  (`GIT_GRAPH_DEFAULT_LIMIT`), max 500 (`GIT_GRAPH_MAX_LIMIT`). Revisit if Phase 2
  feels heavy — dropping `authorEmail` and one timestamp would cut roughly a third.
- **Records are NUL-delimited, fields unit-separated (`\x1f`).** A commit subject
  can contain tabs and quotes, which would desynchronise the tab-delimited format
  the existing ref snapshot uses. Covered by a test.
- **Annotated tags are peeled** with `%(*objectname)`, so `VcsGraphRef.oid` is
  always a commit. The integration test asserts the general invariant: every
  returned ref points at a commit present in the returned commit list.
- **Detached worktree HEADs are passed to `git log` explicitly**, because no ref
  reaches them. This is why refs and worktrees are read before the commit walk
  rather than all four commands running concurrently.
- Empty commit subjects, root commits, unborn HEADs, bare repos, and prunable
  worktrees all have explicit handling and tests.

- [x] 2026-08-06 — **Phase 2 landed** (`880d8376b`). 23 new web tests; web
      typecheck and lint clean.

### Phase 2 verified in a real client (2026-08-06)

Ran the web app against a copy of real state and opened the History surface on
the t3code repo itself. **It works**: the surface registers (tab, icon,
empty-state card), the RPC resolves, 200 commits render with a genuine 10-lane
graph, merge/fork curves, local/remote/tag chips, ages and short oids.

Three layout faults only a real repo exposed, all fixed in `4232158a5`:

1. **Long branch names overran the author column.** `truncate` does not
   ellipsize a flex container's anonymous text child, so an `inline-flex` chip
   overflowed rather than clipping, and `shrink-0` stopped it yielding space.
   Chips are now `inline-block` and shrinkable.
2. **The lane gutter ate the row.** It is sized by the page's widest lane count,
   and this repo really does reach 10 lanes (verified: commits land in all ten
   columns, 19 rows carry curves). At 14px/lane that was 140px of a ~500px
   panel. Lanes are now 10px.
3. **A commit at several remote tips pushed the summary off the row.** Chips are
   capped at three per row (two plus "+N") and the chip group at 55% of the row.

Also confirmed a **false alarm**: the lane line looked dashed in a zoomed
screenshot, but measuring the DOM showed rows are contiguous (30px row, 30px
SVG, zero gap) and every row draws `y0→15` and `y15→30`. The apparent breaks are
the commit dot's background-coloured ring plus JPEG artefacts. Do not "fix" this.

**Environment gotcha:** seeding the test base dir from `~/.t3/userdata` produced
a **3.9 GB** snapshot, and the dev server spent minutes with a stalled event loop
(150+ `Event loop stalled` warnings) chewing on it, which froze the renderer
periodically. Next time seed a smaller database or register a single project by
hand — the huge copy bought nothing except realistic project data.

### Phase 2 status — the earlier caveat, now resolved

_(Superseded by the verification above — kept because the reasoning still applies
to future phases.)_ `apps/web` has no component-test
harness (every existing web test is pure logic), and no dev server or browser has
been run, so what is proven is: the layout algorithm and presentation helpers are
correct under test, and everything typechecks. What is _not_ proven is that the
panel mounts, the atom resolves, the SVG lines meet across rows, or the row
layout holds at a realistic panel width. That needs one pass in a real client via
the `test-t3-app` skill.

Deliberately not adding a component-test harness for this — introducing
testing-library to a repo with none would be a larger change than the feature.

### Phase 2 details worth carrying forward

- **Files added:** `apps/web/src/lib/gitGraphLayout.ts` (pure lane assignment),
  `apps/web/src/components/gitGraph/{GitGraphPanel,GitGraphRowGlyph,gitGraphPresentation}`.
- **Surface registration touched fewer places than expected.** `RIGHT_PANEL_KINDS`,
  the `RightPanelSurface` union, `singletonSurface()`, `surfaceTitle()`,
  `SurfaceIcon()`, the `+` menu, `RightPanelEmptyState`, and the `rightPanelContent`
  switch — but **no storage version bump**, because `migratePersistedRightPanelState`
  passes unrecognised surface kinds straight through and old persisted state can
  never contain `gitGraph`.
- **The paging invariant is tested:** laying out two pages, seeding the second with
  the first's `trailingLanes`, gives the same columns as one whole-history pass.
  Load-more must thread `trailingLanes` through or lanes will visibly reshuffle.
- **`cwd` passed to the panel is `gitCwd`** — the thread's worktree when it has one,
  else the project root. The server resolves it to `--git-common-dir`, so every
  thread on the same repo shares one graph, which is the "project repo, all
  worktrees" decision working as intended.
- **Rows are unvirtualized.** 200 rows is cheap and the repo's only list
  virtualization (`@legendapp/list`) is wired into `MessagesTimeline` in a way that
  would be substantial to replicate. Revisit when load-more can stack pages.

### Next: Phase 3

Synthetic worktree rows (`vcs.rowChanges` for staged/unstaged, batched per-worktree
status). Before that, a real-client pass on Phase 2 is worth doing — every later
phase builds on this panel's layout, so a rendering mistake here compounds.
