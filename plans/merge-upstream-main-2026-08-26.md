# Merge upstream/main (v0.0.34) into master — 2026-08-26

## Goal

Bring `master` up to date with `upstream/main`, which has moved **356 commits** ahead
(through `v0.0.34` and on to `a3a8cbd60`, 2026-08-26). Done by **merge**, not rebase.

Predecessor: [`merge-upstream-main-2026-08-11.md`](./merge-upstream-main-2026-08-11.md) — read it
for the add/add collision technique (rename the fork's file _before_ merging so upstream's lands
at its exact bytes). This plan does not repeat it.

## Why now

The cost of waiting is measurable and steep:

|                   | 2026-08-21 | 2026-08-26 |
| ----------------- | ---------- | ---------- |
| ahead             | 98         | 114        |
| behind            | 225        | **356**    |
| conflicting files | **2**      | **18**     |

Five days turned 2 conflicts into 18. Deferring again is the expensive option.

## Environment / context

- Repo `C:\Users\camer\git\t3code`, branch `master`, tracking `origin/master`.
- Pre-merge tip: **`b66ea3cf6`**. Safety snapshot: `git stash` entry
  _"safety: before merging upstream/main v0.0.34 into master"_ (`3e76a69c7`).
- Upstream tip `a3a8cbd60`; latest release tag `v0.0.34`.
- Merge base with upstream: `ad5e0bb3b` (the 2026-08-11 merge).

## Decisions already made (don't re-ask)

- **Merge, not rebase.** The fork's standing decision, and the reasoning has only strengthened:
  114 local commits over 356 upstream is not worth rewriting, the branch already carries several
  `Merge upstream/main` commits, and a rebase would need a **force-push** to an already-published
  branch — forbidden without per-push approval, and unsafe with other agent sessions active.
- **The other session's uncommitted work is not to be disturbed.** `plans/` is fork-only
  (`git ls-tree upstream/main plans/` is empty) and zero upstream commits touch it. Verified
  against the actual merge result: the blob for `plans/merge-upstream-main-2026-08-11.md` is
  byte-identical in `HEAD` and in the computed merge tree (`87aa2e9a0`). The merge cannot
  touch it.

## What this merge does NOT bring

Checked before starting, so expectations are right:

- **Upstream is still on `effect@4.0.0-beta.103`** — same catalog pin as ours. The Windows
  `taskkill` fix (Effect-TS/effect#7154, shipped in beta.107) does **not** arrive with this
  merge. See [`process-spawn-storm.md`](./process-spawn-storm.md).
- **`RepositoryIdentityResolver.ts` and `processRunner.ts`: zero upstream commits** since the
  merge base. Our spawn-storm fix remains ours alone and remains necessary.

So this merge is for upstream's 356 commits of features and fixes, not for relief on anything
currently being chased.

## The 18 conflicts, and which carry fork fixes that MUST survive

The danger in this merge is not the conflict count — it is resolving one as "take theirs" and
silently deleting a fork fix. These are the ones that matter:

| file                                                | what must survive                                                                                                                                                                                                                                                                              |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/project/ProjectFaviconResolver.ts` | **Our cache (`401da737f`).** Upstream touched this file for a _feature_ (`feat(desktop): choose external project icons`, #7823) and their version still has **no cache** — verified. Taking theirs reintroduces the 20 s `assets.createUrl` stalls. Needs _their feature_ **and** _our cache_. |
| `apps/web/src/routes/_chat.index.tsx`               | The bounded environment gate (`useEnvironmentsSettled`) plus the fork titlebar header.                                                                                                                                                                                                         |
| `apps/web/src/routes/_chat.pull-requests.tsx`       | The same bounded gate.                                                                                                                                                                                                                                                                         |
| `apps/web/src/components/RightPanelTabs.tsx`        | The fork's commit-graph panel.                                                                                                                                                                                                                                                                 |
| `apps/web/src/components/chat/ChatComposer.tsx`     | The fork's ref pills.                                                                                                                                                                                                                                                                          |

The remaining 13 are upstream-vs-upstream drift in desktop IPC, preview, settings and contracts
(`apps/desktop/src/ipc/*`, `preview/Manager.ts`, `preload.ts`, `settings/*`,
`packages/contracts/src/{ipc,rpc,settings}.ts`, `apps/server/src/process/externalLauncher.ts`)
and should generally take upstream's shape, with fork additions re-applied on top where present.

## Plan / steps

1. ~~Verify the merge cannot touch the other session's uncommitted files~~ — done, proven above.
2. ~~Safety snapshot~~ — done (`3e76a69c7`).
3. Start the merge, do not commit automatically.
4. Resolve the 18 conflicts, fork-fix-bearing files first and deliberately.
5. Typecheck, lint, and run the affected suites.
6. Commit the merge; do **not** push until checks pass.

## Findings / gotchas

- `git merge-tree --write-tree --name-only HEAD upstream/main` is the read-only way to preview
  conflicts and even to inspect the resulting tree, without touching the working tree. Used it
  to prove the other session's file was safe before starting.
- A naive "which dirty files does the merge touch" check using `git diff --name-only HEAD
upstream/main` produces **false positives**: fork-only files show as differing simply because
  upstream never had them. Compare blobs against the merge-tree result instead.

## Attempt 1 — 2026-08-26 16:21: 3 of 18 resolved, then aborted deliberately

The merge was started, three conflicts were resolved, and it was then **aborted on purpose**.
Tree verified clean afterwards at `b66ea3cf6`, with the other session's 63 uncommitted lines in
`plans/merge-upstream-main-2026-08-11.md` intact.

### Why aborted rather than finished

26 conflict hunks remained across 15 files, and the largest cluster is the **preview
subsystem** — `apps/desktop/src/preview/Manager.ts` (4 hunks),
`apps/desktop/src/ipc/methods/preview.ts` (3), plus `PreviewView.tsx`, `PreviewView.test.tsx`,
`channels.ts`, `preload.ts`. `ChatComposer.tsx` (3 hunks) needs the fork's **queued messages**
feature reconciled against upstream's new `ComposerSubmissionIntent`.

Those need fork-feature knowledge to resolve without silently breaking something, and a wrong
resolution in a 356-commit merge is very hard to spot afterwards. Meanwhile a conflicted merge
state in this worktree **blocks the other live sessions from committing**, so it was not
something to leave sitting while working slowly through unfamiliar UI code.

**Do the next attempt in a dedicated `git worktree`**, not in the shared checkout. That removes
the time pressure entirely — the merge can sit half-resolved for as long as it needs without
blocking anyone.

### Resolutions already derived — reuse these, do not re-derive

Saved verbatim under the session scratchpad `merge-resolutions/`, and described here so they
survive that being cleaned up.

**1. `apps/server/src/project/ProjectFaviconResolver.ts`** — one hunk.

Upstream _inlined_ into `resolvePath` the preamble (normalize + saved-icon check) that the fork
had extracted into `walkForFavicon`, and added a required third parameter to
`findExistingFile`: `candidateScope: "workspace" | "filesystem"`.

- Keep the **HEAD** side of the hunk (the `walkForFavicon` extraction). The fork's `resolvePath`
  further down already performs that preamble _and_ the cache.
- Then fix the call sites for the new signature. Upstream passes `"filesystem"` for the saved
  icon path — that is their external-icon feature, letting an absolute path outside the
  workspace resolve — so the fork's call becomes
  `findExistingFile(projectCwd, [faviconPath], "filesystem")`. Discovery call sites take
  `"workspace"`.
- Verified afterwards: `FAVICON_CACHE_TTL`, `cache.get`/`cache.set` and the
  `walkForFavicon` + `Effect.timeoutOption` path all intact. **The cache survives.**

**2. `apps/web/src/routes/_chat.index.tsx`** — one hunk, imports only. Union both sides.
The merged body uses upstream's `WorkspacePageHeader` (3 references) and the fork's inline
header is gone — which is _correct_, because the fork's titlebar inset now lives inside
`WorkspacePageHeader.tsx` itself (`COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS`, line 4 and 22).
Nothing is lost. Keep `useEnvironmentsSettled` alongside it.

**3. `apps/web/src/routes/_chat.pull-requests.tsx`** — two hunks.
Upstream restructured this page from single- to multi-environment; the merged body uses
`environmentIds` and `environments`. So take upstream's import set, drop the two fork imports
the restructure orphaned (`usePrimaryEnvironment`, `useEnvironmentQuery` — each had exactly one
occurrence, the import line itself), and add `useEnvironmentsSettled`. For the second hunk keep
the fork's `useEnvironmentsSettled()` call but take **upstream's comment**: the fork's wording
("the page reads one environment") is now factually wrong.

### Remaining 15 files / 26 hunks

| hunks  | file                                                                                                                                                              | needs                                                                                                                                                                                         |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4      | `apps/desktop/src/preview/Manager.ts`                                                                                                                             | fork preview vs upstream preview                                                                                                                                                              |
| 3      | `packages/contracts/src/ipc.ts`                                                                                                                                   | contract union                                                                                                                                                                                |
| 3      | `apps/web/src/components/chat/ChatComposer.tsx`                                                                                                                   | fork queued-messages vs upstream `ComposerSubmissionIntent` — hunks 1 and 2 look like clean unions (import; `onSend` gains `intent?`, fork keeps `onQueueDraft`), hunk 3 is a large JSX block |
| 3      | `apps/desktop/src/ipc/methods/preview.ts`                                                                                                                         | preview IPC                                                                                                                                                                                   |
| 2      | `apps/web/src/components/settings/SettingsPanels.tsx`                                                                                                             | settings                                                                                                                                                                                      |
| 2      | `apps/server/src/process/externalLauncher.ts`                                                                                                                     | external launcher                                                                                                                                                                             |
| 1 each | `contracts/{settings,rpc}.ts`, `settingsSearch.ts`, `PreviewView{,.test}.tsx`, `RightPanelTabs.tsx`, `DesktopClientSettings.test.ts`, `preload.ts`, `channels.ts` | mostly mechanical                                                                                                                                                                             |

`RightPanelTabs.tsx` is a single hunk in the surface menu — the fork's commit-graph tab must
remain among the `SurfaceMenuItem` entries.

## Attempt 2 — DONE. Merge complete on `merge/upstream-v0.0.34`

Run in a dedicated worktree at `C:/Users/camer/git/t3code-merge-v0.0.34`, so the shared
checkout was never left in a conflicted state. Merge commit **`c9e4cd010`** (parents
`a144222c1` + `a3a8cbd60`), pushed to `origin/merge/upstream-v0.0.34`.

**`master` fast-forwards to it cleanly, and it is 0 commits behind upstream.** Not fast-forwarded
here on purpose: master lives in the shared checkout where other sessions are working, and
moving it changes thousands of files under them.

### Checks

| check                        | result                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------ |
| typecheck (monorepo, `-r`)   | clean                                                                                            |
| lint                         | clean (warnings only, all pre-existing style)                                                    |
| web tests                    | **2918 / 2918 passing** (285 files)                                                              |
| server + contracts + desktop | 286 / 286 passing                                                                                |
| client-runtime               | 9 failing — **pre-existing**, verified identical on unmerged master; merge adds 81 passing tests |

### How the fork-bearing conflicts were resolved

- **ProjectFaviconResolver** — upstream inlined the preamble the fork had extracted into
  `walkForFavicon` and added a required `candidateScope` argument to `findExistingFile`. Kept
  the fork's extraction and TTL cache; adopted upstream's `"filesystem"` scope for the saved
  icon path, which is what lets their external-icon feature resolve an absolute path.
- **externalLauncher** — upstream rewrote `buildAvailableEditors` around
  `resolveUsableFileManagerCommand`, but sequentially. Kept upstream's APIs inside the fork's
  concurrent, `EDITOR_DETECTION_TIMEOUT`-bounded shape, and kept the fork's `availableEditors`
  cache while taking upstream's env composition.
- **RightPanelTabs** — took upstream's data-driven surface menu and restored the fork's
  History (commit graph) surface into it. Also had to give the fork's _existing_ History action
  the `shortcut` upstream now requires of every entry: one member without it makes the whole
  tuple fail `surfaceShortcutActionForKey`.
- **ChatComposer** — upstream rewrote the footer earlier in the file and deleted this copy, so
  keeping the fork's would have rendered **two footers**. Took the deletion and re-grafted the
  fork's queue-draft control into upstream's footer in the same relative position. Kept
  upstream's `onSend` (which gained `ComposerSubmissionIntent`) plus the fork's `onQueueDraft`.

### The trap that cost the most time

Several conflicts aligned **two unrelated additions at one position**, sharing a closing
brace, JSDoc opener, or `});` _outside_ the conflict markers. A naive union fuses them into one
broken declaration — and it does so **silently**, producing valid-looking text. It hit
`contracts/ipc.ts` (twice), `contracts/settings.ts`, `settingsSearch.ts`, `PreviewView.test.tsx`,
`preview.ts`, `preview/Manager.ts` and `SettingsPanels.tsx`.

Union is only safe when each side is a _complete_ syntactic unit. Otherwise split into siblings
and give each its own closer. Typecheck catches these, so always run it before trusting a
union-heavy resolution.

Also: a regex sweep for "orphaned JSDoc openers" produced a **false positive** inside a JSX
comment and had to be reverted. Do not automate that repair.

### Verification gap worth naming

`ChatComposer` is the one resolution not proven by a test: the queue-draft control's _placement_
inside upstream's rewritten footer is structurally correct and typechecks, but nothing asserts
how it looks. Worth a visual check of the composer's queue (clock) button before relying on it.

### Next

- Fast-forward `master` to `merge/upstream-v0.0.34` when the shared checkout is quiet.
- The worktree can be removed afterwards with `git worktree remove ../t3code-merge-v0.0.34`.

## 2026-08-27 — v0.0.35 folded in. Zero conflicts.

Upstream released `v0.0.35` (tip `d3c24a14b`). Merged into the same branch.

**This is the payoff from not deferring again:**

|                   | v0.0.34 merge                                  | v0.0.35 merge   |
| ----------------- | ---------------------------------------------- | --------------- |
| commits behind    | 356                                            | **3**           |
| conflicting files | 18                                             | **0**           |
| effort            | ~2 hours, a worktree, an aborted first attempt | one clean merge |

Upstream's content: release version bumps, a macOS desktop preview CI workflow, and a
regenerated codex app-server schema plus a new test for Codex 0.150 multi-agent events.

### Checks

- typecheck clean across the monorepo; lint clean
- `effect-codex-app-server` **21/21**, including the new schema test
- server suite reports 129 failures — **pre-existing and environmental**, the provider CLIs
  are not installed on this machine. Unmerged master reports **118** of the same class, and the
  three files that looked new (`GrokProvider`, `ProviderRegistry`, `ProviderInstanceRegistryLive`)
  were run directly against master and fail there **identically, 8 for 8**. The merge adds 19
  test files and 373 passing tests, and failed _files_ went **down**, 29 → 27.

### Branch state

`merge/upstream-v0.0.35` and `merge/upstream-v0.0.34` now both point at **`b9e519a55`** — same
lineage, two names. Use `merge/upstream-v0.0.35`. It contains the v0.0.34 merge, the v0.0.35
merge, and master's plan commits, is **0 behind upstream**, and **`master` fast-forwards to it**.

```
git -C C:/Users/camer/git/t3code merge --ff-only merge/upstream-v0.0.35
```

### Gotcha worth remembering

`master` kept moving after the worktree was branched (plan-doc commits), so the merge branch
stopped being a fast-forward target. Fixed by merging `master` _into_ the branch, which is
additive and needs no force-push. Watch for this whenever a long-lived merge branch is in
flight — check `git merge-base --is-ancestor master <branch>` before assuming the fast-forward
still holds.

Also: `git branch -f` moves a pointer, but the worktree stays on whatever branch it had checked
out. A merge run in the worktree lands on _that_ branch, not the one just repointed.

## Things not to do

- Don't rebase, and don't force-push. Both are ruled out above.
- Don't resolve `ProjectFaviconResolver.ts` by taking either side wholesale.
- Don't `git checkout --`/`restore`/`reset --hard` anything: 13 Claude sessions are live on this
  machine and one has uncommitted work in `plans/`.
- Don't push until typecheck, lint and the affected tests pass.
