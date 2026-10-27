# Replacing the git CLI layer with a native libgit2 binding

## Goal

Evaluate moving T3 Code's git layer off shell-outs to the `git` binary and onto a
native libgit2 binding. The motivation is architectural taste as much as
performance: parsing porcelain text is fragile, and the current layer carries a
lot of hand-rolled output parsing that a typed in-process API would eliminate.

The user's framing: _"I want a bonafide libgit (libgit2) based native
abstraction. I hate this wrapping of cli."_ The starting question was nodegit;
that has since broadened to the whole native-binding landscape.

**Status: SHELVED 2026-08-06.** Evaluation complete enough to act on; no code has
been changed in this repo. Shelved in favour of a **separate upstream project to
produce an N-API libgit2 binding** (user's stated plan: "I'm going to do a
different project to fork to n-api"). Resume this plan once that binding exists.

## Decisions already made (don't re-ask)

| Decision                  | Value                                                                                                                           | Reason                                                                                                                                                                                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Direction                 | Native libgit2 binding is the **preferred** end state, not merely tolerated                                                     | Explicit user preference. Don't re-argue "just keep the CLI, it works" as if it were news.                                                                                                                                                                                                 |
| nodegit specifically      | **Rejected for use here** — see Findings §3                                                                                     | NAN-based, which is disqualifying for this repo's four runtimes. Not a maintenance judgement; a technical one.                                                                                                                                                                             |
| What "CLI fallback" means | Acceptable **per-operation**, not as a reason to abandon the effort                                                             | Some operations (hooks, credential helpers) provably cannot be done in-process. Those staying on the CLI is a correct design, not a failure.                                                                                                                                               |
| Hooks / credentials       | **Fully native, shelling out from inside libgit2's callbacks** — option 3, not the hybrid                                       | User: _"fully native, with shell out support. I want to drop the spawning of binaries constantly."_ The goal is eliminating _constant_ subprocess churn, not eliminating subprocesses absolutely. Occasional spawns from a credential/hook callback are fine; a spawn per `status` is not. |
| Motivation                | **All four** apply: architectural taste/fragility, status latency, dropping the binary dependency, and the commit-graph sidebar | So this is not a "targeted fast-path" job. Go as native as libgit2 allows.                                                                                                                                                                                                                 |
| Immediate next move       | **Shelved here; work happens upstream first** — fork/build an N-API libgit2 binding as its own project                          | Nothing in this repo should change until a viable N-API binding exists to change it to.                                                                                                                                                                                                    |

## Environment / context

- Repo `C:\Users\camer\git\t3code`, branch `debug/crash-investigation`.
- Monorepo, pnpm + `vp` (vite-plus). Dev tooling is **not** Bun here, despite the
  global preference — but the _server_ does support running under Bun at runtime
  (`apps/server/src/persistence/Layers/Sqlite.ts:28` branches on
  `process.versions.bun`), which constrains binding choice.
- Verification rule from `AGENTS.md`: targeted tests/lint/typecheck only. **Do not
  run repo-wide `vp check` / `vp run -r test`.**

### The four runtimes any binding must load in

This is the central constraint and the reason nodegit fails.

1. **Electron 41.5.0** (ABI 145) — the desktop backend is spawned as a child of
   Electron itself with `ELECTRON_RUN_AS_NODE=1`
   (`apps/desktop/src/backend/DesktopBackendConfiguration.ts:398`).
2. **The user's WSL Linux Node** — Windows desktop runs a second backend via
   `wsl.exe -- node` (`DesktopBackendConfiguration.ts:469-600`). System ABI, not
   Electron's.
3. **Arbitrary Node ≥ 22.16** — `npx t3@latest` is the documented primary install
   path (`docs/user/install.md`), plus systemd `pinnedRuntime` installs on remote
   hosts (`apps/server/src/cloud/pinnedRuntime.ts`). **No compile-at-install is
   acceptable on these.**
4. **Bun**, possibly (see above).

Implication: **the binding must be N-API**, not NAN. N-API is ABI-stable across
Node majors and works on Bun; NAN is V8-ABI-bound and needs one binary per Node
major _and_ per Electron major, and cannot work on Bun at all.

### Native-module precedent already in the repo

The infrastructure for shipping platform binaries exists twice over:

- `native/resource-monitor` — a standalone **Rust** sidecar executable (sysinfo
  0.39), cross-compiled in CI for darwin-arm64/x64, linux-x64, win32-x64
  (`.github/workflows/release.yml`), spawned via
  `apps/server/src/resourceTelemetry/ResourceMonitorBinary.ts`.
- `node-pty@^1.1.0` — N-API prebuilds. Note `stageWslNodePtyPrebuild`
  (`scripts/build-desktop-artifact.ts:1640-1706`) + CI job `build_wsl_node_pty`,
  which exist solely to ship **two ABIs of the same addon** in the Windows
  installer. Its code comment says this works _only_ because node-pty is N-API.

So a Rust/napi-rs binding fits the existing shape well. A NAN addon breaks the
WSL staging path outright.

Bundler note: `apps/server/vite.config.ts` `pack.deps.alwaysBundle` inlines only
`@pierre/diffs`, `@t3tools/*`, `effect-acp`, `effect-codex-app-server`.
Everything else is externalized, so a native module needs **no bundler change** —
but must be in `apps/server/package.json` `dependencies` so the desktop stage
`vp install --prod` and the npm publish both pick it up.

## Findings

### 1. The git layer is ~9,500 lines, all in `apps/server`

Nothing in desktop/web/mobile touches git; they reach it over RPC.

| File                                                                                                        | Lines | Role                                                                |
| ----------------------------------------------------------------------------------------------------------- | ----: | ------------------------------------------------------------------- |
| `apps/server/src/vcs/GitVcsDriverCore.ts`                                                                   |  2883 | Spawns `git`; all porcelain/plumbing + output parsing               |
| `apps/server/src/git/GitManager.ts`                                                                         |  2149 | Cached status, PR resolution, stacked actions, AI commit messages   |
| `apps/server/src/vcs/GitVcsDriver.ts`                                                                       |   888 | Service interface + a _second_ git impl (checkpoints, file listing) |
| `apps/server/src/vcs/VcsStatusBroadcaster.ts`                                                               |   689 | Status fan-out, remote-refresh backoff                              |
| `packages/contracts/src/{git,vcs}.ts`                                                                       |   732 | Effect Schemas + typed error unions                                 |
| `apps/server/src/git/GitWorkflowService.ts`, `VcsDriverRegistry.ts`, `VcsProjectConfig.ts`, `VcsProcess.ts` |  ~660 | Facade, driver detection, subprocess wrapper                        |
| Tests (`GitManager.test.ts` alone is 4013)                                                                  | ~7500 | Mix of real-`git` temp repos and faked spawners                     |

**The abstraction is already the right shape.** `VcsDriver` is an Effect
`Context.Service` with a registry, a `VcsDriverCapabilities` record, and a
contract harness (`vcs/testing/VcsDriverContractHarness.ts`) built so a `jj`
driver could drop in. That harness is the natural place to prove a native driver
behaves identically to the CLI driver.

Two structural warts to know about:

- **Two independent spawn paths.** `GitVcsDriverCore` sets the child's `cwd` and
  passes no `-C`; `GitVcsDriver.makeVcsDriverShape` passes `-C <cwd>` and spawns
  from `process.cwd()`. Different error types, different timeout/limit defaults,
  and only Core emits metrics/OTEL spans.
- **Three modules bypass the driver** and spawn `git` directly:
  `project/RepositoryIdentityResolver.ts`, `sourceControl/SourceControlRepositoryService.ts`
  (clone), `sourceControl/SourceControlDiscovery.ts` (`git --version` probe).

The git binary path is **never configurable or discovered** — every site passes
the literal `"git"` and relies on `PATH`.

### 2. The 24 operations a native driver must cover

Extracted as the requirements spec for the coverage matrix (research in flight).

**Read:** `status --porcelain=2 --branch`; `diff HEAD --numstat` (+ unborn-HEAD
fallback); `symbolic-ref refs/remotes/origin/HEAD` / `remote get-url origin`;
`rev-parse` (`--show-toplevel`, `--git-common-dir`, `--abbrev-ref`,
`--is-inside-work-tree`, `--verify <rev>^{commit}`); `rev-list --left-right
--count` (ahead/behind); `for-each-ref` with committerdate/symref and
upstream-mapping formats; `show-ref --verify --quiet`; `log --oneline <range>` /
`diff --stat` / `diff --patch`; `config --get` + writing `branch.<b>.gh-merge-base`;
`ls-files --cached --others --exclude-standard -z`; `check-ignore --no-index -z
--stdin`; `branch --list --format` / `--show-current`; a commit-graph walk for the
planned DAG sidebar.

**Write:** `add -A` / `reset` / `commit -m -m`; `checkout [--track]`, `branch`
create/rename/`--set-upstream-to`/`--force`; `init`, `clone`; the checkpoint
snapshot dance; checkpoint restore; `diff --patch <a>^{commit} <b>^{commit}`.

**Network:** `fetch` (incl. `+refs/pull/<n>/head:...`); `push` / `push -u`;
`pull --ff-only`; `remote` / `remote -v` / `remote add`.

**Worktrees:** `worktree add [-b] <path> <ref>`; `worktree remove [--force]`;
`worktree list --porcelain -z` with prunable detection.

Operations expected to be hard for any libgit2 binding:

- **Checkpoints via a detached temp index** (`GitVcsDriver.ts:661-741`). Sets
  `GIT_INDEX_FILE=<git-common-dir>/t3-checkpoint-index-<uuid>` plus fixed
  `GIT_AUTHOR_*`/`GIT_COMMITTER_*`, then `read-tree HEAD` → `add -A -- .` →
  `write-tree` → `commit-tree` → `update-ref`. The whole point is to snapshot the
  worktree **without touching the user's index**. A binding must expose
  `git_index_open` on an arbitrary path, `read_tree`, `add_all`,
  `write_tree_to(repo)`, and commit-with-explicit-tree-and-signature.
- **Bulk `check-ignore --stdin`** — one CLI call with chunked stdin vs. N FFI
  calls for ~100k paths. Needs benchmarking, not assumption.
- **`pull --ff-only`** — libgit2 has no `pull` primitive at all. Must be composed
  from fetch + merge-analysis + manually fast-forwarding HEAD.
- **Worktrees** — including `Repository.open` inside a linked worktree created
  with `--relative-paths` (git ≥ 2.48).

### 3. Why nodegit is rejected

**It is NAN, not N-API.** `0.28.0-alpha.38` depends on
`nan: "github:axosoft/nan#v2.26.2-axosoft.0"`. This alone disqualifies it against
the four runtimes above: no Bun, one binary per Node major _and_ Electron major,
and it breaks the `stageWslNodePtyPrebuild` dual-ABI pattern.

Supporting facts:

- npm `latest` is **0.27.0, 2020-07-28**, bundling libgit2 0.28. The only usable
  line is `next` — `0.28.0-alpha.38` (2026-04-23) — alpha for **4+ years and 38
  releases**.
- Electron prebuilds are named by **minor** (`electron-v41.3`), so the prebuild
  resolves for Electron 41.3.x and nothing else. Our Electron upgrade cadence
  would couple to nodegit's ~3-6 alphas/year.
- The `electron-v41.3-win32-x64` prebuild is **246 MB** — it ships build
  intermediates (`libgit2.lib` is 82 MB inside the tarball).
- No musl prebuild; no Linux-arm64 prebuild for Node (only for Electron).
- Source-build fallback needs Python + MSVC (+ Strawberry Perl and NASM on
  Windows, plus a separate OpenSSL build because Electron uses BoringSSL).
- Vendored libgit2 is 1.9.1 + fork commits, predating **libgit2 1.9.5
  (2026-07-18)** and CVE-2026-53584/53585/53586/53587 (53584 is a submodule
  path-traversal).

**On "the repo still has active development" — true, and the correction matters.**
Commits per year: 2021: 112 · 2022: 115 · 2023: 7 · 2024: 38 · **2025: 91** ·
2026: 11. Not archived. But the content is entirely NAN-debt servicing — V8
deprecation fixes (`v8::Local<T>::GetIsolate`, `PropertyCallbackInfo::This()`),
alloc/dealloc mismatch fixes, dependabot, one more prebuild ABI. Verified via the
GitHub API:

- **Zero N-API migration effort.** All 42 issue/PR hits for
  `n-api`/`napi`/`node-addon-api` are users reporting _install failures_.
- **#1774 "Make nodegit context-aware for compatibility with Electron 9 and
  beyond" — open since 2021-12-17.** Electron 9.
- 20 open PRs; newest substantive one (#2040, mempack ODB + `Index.create`)
  unmerged since 2026-03-15. Fourteen PRs share a `2025-11-15` last-updated date,
  the signature of one triage sweep rather than ongoing review.
- July 2026: every maintainer with recent commits (Tyler Ang-Wanek, Ian
  Hattendorf, `@zawata`) moved to "Alumni", leaving `@AlexaXs`.
- GitKraken — nodegit's decade-long sponsor — shipped a **"Use Git Executable"**
  preference that routes around it.

Summary: **maintained, not developed**, and specifically not developed in the
direction that would make it viable here.

### 4. libgit2-inherent limits — no binding can fix these

Independent of which binding is chosen. These decide which operations must keep a
CLI fallback.

- **Hooks never run.** libgit2#964, closed wontfix 2015-06-08: _"We will not be
  executing any hooks directly."_ carlosmn's argument is that libgit2 couldn't do
  it correctly anyway — it doesn't know whether you're committing in the
  `git commit` sense. `core.hooksPath` is never even read (PR #4620 open since
  2018). **Directly affects us:** the `GIT_TRACE2` hook-progress telemetry in
  `GitVcsDriverCore.ts:437-627` would have nothing to bind to, and users'
  pre-commit hooks would silently stop running on commit.
- **Credential helpers never invoked** — GCM, osxkeychain, wincred. libgit2#4873
  open since 2018. Our `GCM_INTERACTIVE=never` / `GIT_ASKPASS` suppression block
  (`GitVcsDriverCore.ts:76-82`) becomes meaningless. _Possible mitigation:_ shell
  out to `git credential fill` ourselves inside the binding's credential callback
  — needs verification that the callback surface allows it.
- **Clean/smudge filters never read from config** → **git-lfs repos silently
  check out ~130-byte pointer files with no error.** Only `crlf` and `ident` are
  registered.
- **No sparse-checkout, no partial clone** — and a repo with `index.sparse=true`
  or `extensions.partialclone` **won't open at all**.
- **Rename detection off by default**, even under `GIT_STATUS_OPT_DEFAULTS`.
- **`.gitignore` negation semantics are wrong** (libgit2 collects bottom-up; git
  traverses top-down and stops at an excluded dir). libgit2#7283, #7284.
- **No fsmonitor** — every status is a full walk with one `lstat` per path.
- **`git subtree` has no equivalent** — it's a shell script in git's `contrib/`,
  never a builtin. `scripts/sync-reference-repos.ts` uses it and must stay CLI.
- **reftable and SHA-256** are unreleased on libgit2 `main` (both landed 2026);
  repos using them hard-fail on 1.9.x.

### 5. Coverage matrix — no binding available today is sufficient (empirical)

Both candidates were **installed and executed** against this repo and against
purpose-built scratch repos (not read from docs). Type definitions were pulled
from the published npm tarballs.

**Result: es-git 0.7.0 scores 8 Full / 12 Partial / 4 Absent** of the 24
operations. `@napi-rs/simple-git` 1.1.0 is worse on coverage but better on
several specific points — **neither is a superset of the other.**

Three defects are disqualifying rather than merely inconvenient:

1. **es-git cannot open a repo using git 2.48 relative worktrees.** With
   `worktree.useRelativePaths=true`, _every_ operation fails repo-wide —
   including on the main checkout — with `unsupported extension name
extensions.relativeworktrees`. Cause: es-git's committed `Cargo.lock` pins
   `libgit2-sys 0.18.3+1.9.2`; the extension was allowlisted in libgit2 **1.9.4**
   (PR #7254, a one-line diff). `@napi-rs/simple-git` ships no `Cargo.lock`,
   floats to 1.9.6, and opens fine. We don't use `--relative-paths` — but a
   _user's_ repo might, and the failure is total.
2. **es-git's patch output is corrupt** — `Diff.print({format:'Patch'})` drops the
   `+`/`-` origin markers, producing `"@@ -1 +1,2 @@\nhello\nmod\n"` instead of
   `"@@ -1 +1,2 @@\n hello\n+mod\n"`. Not an applicable patch, and insertions vs.
   deletions are unrecoverable. `simple-git` has no `print()` at all. Neither
   exposes a `Patch` class or `git_patch_line_stats`, so there is **no workaround**
   — `DiffStats` gives only repo-wide `filesChanged/insertions/deletions`.
3. **The detached temp index would silently corrupt checkpoints.** The
   `GIT_INDEX_FILE` workaround _does_ work — `openRepository(path, {fromEnv:true})`
   yields a `Repository` whose `index()` is the temp index, and
   `Repository.commit(tree, msg, {updateRef, author, committer, parents: []})`
   covers `commit-tree` + `update-ref` exactly, including our parentless root
   commit. **But neither binding exposes `Index.read_tree`**, so the index cannot
   be seeded from HEAD. Measured tree OIDs on a purpose-built case:

   | Method                          | Tree OID    | Entries                                         |
   | ------------------------------- | ----------- | ----------------------------------------------- |
   | `git read-tree HEAD` + `add -A` | `49c53be7…` | `.gitignore, a.txt, b.txt, ignored-tracked.txt` |
   | `addAll(['.'])` (both bindings) | `8407afdd…` | `.gitignore, a.txt, b.txt`                      |

   **A tracked-but-ignored file vanishes from the checkpoint**, so restoring it
   would delete the user's file. The workaround also mutates `process.env`
   globally — racy in a concurrent server.

**The architectural problem is async, not raw speed.** es-git is async only for
`fetch/push/prune/defaultBranch`, submodules, and `open/clone/init/discover`.
**`statuses`, `diff`, `revwalk`, `index`, `commit`, `checkout` are all synchronous
and block the event loop.** That is the real objection for a server: even a fast
call is a _blocking_ call, and the CLI path is already async and off-thread.

> ⚠️ **The first benchmark pass in this plan was wrong and has been retracted.**
> It reported es-git's ref enumeration at **17,593 ms (44× slower than CLI)**.
> That number is off by ~185×. It came from an unwarmed, mis-shaped harness that
> was almost certainly timing an error path (`peelToCommit` does not exist on
> `Reference`; only `peelToTree` does — the wrong call throws 843 times). The CLI
> baseline was also inflated (397 ms reported, 140 ms actual).

**Re-measured directly, warmed, 7 iterations, `min`/`med`, on this repo (843 refs,
1087 loose / 121 packed, 280 MB `.git`, Windows, node 24.18.0, es-git 0.7.0):**

| Operation                                                    |     es-git |    CLI | verdict                |
| ------------------------------------------------------------ | ---------: | -----: | ---------------------- |
| `for-each-ref` + `committerdate` + `symref`, full equivalent |  **94 ms** | 140 ms | **es-git 1.5× FASTER** |
| ↳ `branches()` alone                                         |     113 ms |      — |                        |
| ↳ `+ findReference`                                          |      85 ms |      — |                        |
| ↳ `+ target()` → oid                                         |      87 ms |      — |                        |
| ↳ `+ findCommit + time()` (full)                             |      93 ms |      — |                        |
| `openRepository()`                                           | **2–3 ms** |      — | not a startup cost     |
| single `findReference` / `findCommit` / `commit.time()`      |    <0.5 ms |      — |                        |
| `status --porcelain=2` (compute only)                        |     234 ms | 102 ms | **~2.3× slower**       |
| `status` + read every entry                                  |     340 ms | 106 ms | **~3.4× slower**       |

**So the performance picture inverts for reads.** Ref enumeration — the exact
workload behind the graph sidebar and `listRefs` — is _faster_ in libgit2, and
repo open is free. The `Index.entries()` 5× win is plausible in that light.

**Status genuinely is slower**, ~2–3×, and that result is _expected_: libgit2 has
no fsmonitor and no untracked-cache (libgit2#4230), so every status is a full walk
with one `lstat` per path. That is a real, structural libgit2 limitation — not a
harness artifact. Our `-c core.fsmonitor=false` hardening means we already forgo
some of that on the CLI side, but git still has the untracked cache.

The §2 `check-ignore` question remains **answered: keep the CLI** — but note the
~35 s/100k-path figure came from the same discredited harness and should be
re-measured before being cited.

**Lesson for the eventual binding: benchmark against a warmed cache with repeats,
and assert the call actually succeeded before timing it.**

Other verified points:

- **Both are N-API (napi6, napi-rs 3.x)** → no `electron-rebuild`, and **both were
  loaded and exercised under Bun 1.3.0 on win32-x64-msvc**. Bun support is now
  empirically confirmed rather than inferred. Prebuilds cover all 7 triples we
  need (es-git 10 targets, simple-git 15).
- **SSH fails on Windows in both** bindings.
- **Credential callbacks:** es-git has **none** — only a declarative `Credential`
  union (`Default`/`SSHKeyFromAgent`/`SSHKeyFromPath`/`SSHKey`/`Plain`), so you
  must resolve eagerly and **cannot** shell to `git credential fill` lazily.
  `simple-git` **does** expose `RemoteCallbacks.credentials((url, username,
allowed) => Cred)` — that is the hook the "shell out from inside the callback"
  design needs, though it is synchronous. Neither passes through gitconfig
  `credential.helper` (simple-git's `git2` 0.21 config drops `CredentialHelper`).
- **`pull --ff-only` confirmed impossible in either alone**: es-git has
  `analyzeMerge()` but no way to point an existing ref at a new OID; simple-git
  can set a ref but has no merge analysis.
- **es-git `Commit` has no `parents()` — independently CONFIRMED** by reading
  `node_modules/es-git/index.d.ts`. The complete `Commit` surface is
  `id/author/committer/message/summary/body/time/treeId/tree/asObject/amend/
authorWithMailmap/committerWithMailmap`. No parent accessor of any kind.
  simple-git has `parentCount()`/`parentId()`. Load-bearing for the graph sidebar.
- **Two further API shape findings from direct inspection** (both worth knowing
  for the binding design): `Repository` has **no `references()`** at all — only
  `branches(filter)`, `findReference(name)`, `getReference(name)`; and `Reference`
  has **no `peelToCommit()`**, only `peelToTree()`, so reaching a commit means
  round-tripping the OID through a JS string (`ref.target()` →
  `repo.findCommit(oid)`). Also `BranchesItem` is a plain `{type, name}` struct
  with no handle, forcing a second lookup per branch. None of this is slow — but
  it is exactly the "object-graph design" cost that §8 says dominates effort.
- **No gitoxide Node binding exists.** `isomorphic-git` is pure JS; it gained the
  ability to _operate inside_ a worktree in v1.37.3 but still has no worktree
  management API.

### 6. Minimum viable delta for an upstream binding project

This is the concrete spec the evaluation produced — the smallest set of changes
that would make a binding sufficient for this codebase:

1. Bump libgit2 to **≥ 1.9.4** (unblocks `extensions.relativeworktrees`).
2. Fix `Diff.print` origin markers; expose `Patch` + `git_patch_line_stats`
   (unblocks reqs 2, 8, 19).
3. Add `Index.open` / `read_tree` / `write_tree_to` (unblocks req 17 **without
   data loss**). All exist in the Rust `git2` crate already, and
   `git_index_write_tree_to` has no ODB/owner requirement — libgit2's `index.c`
   asserts only `oid/index/repo`. A binding PR here is genuinely small. Caveat:
   `add_path` fails on a bare index, so a true standalone index needs
   `Repository::blob()` + `Index::add` with pre-computed entries.
4. Add `Commit.parents()` (graph sidebar).
5. Add ref-set-target (unblocks `pull --ff-only` when combined with existing
   `analyzeMerge`).
6. Add `commondir()` (`rev-parse --git-common-dir`, which this repo calls).
7. Add a **credential callback** rather than a declarative union.
8. **Make the hot reads async** — this is the largest and most important item.

### 7. Nobody restarted nodegit — and forking it is the wrong move

**~8 live forks exist. Every one is still NAN.** They are companies vendoring
their own ABI builds, not a successor project:

| package                              | latest               | published  |  DL/mo | divergence              |
| ------------------------------------ | -------------------- | ---------- | -----: | ----------------------- |
| `@figma/nodegit`                     | 0.28.0-figma.9       | 2025-11-20 | 13,801 | 7 ahead, **134 behind** |
| `@axosoft/nodegit`                   | 0.28.0-alpha.30-gk.2 | 2026-04-24 |  9,749 | shared S3 with upstream |
| `@readme/nodegit`                    | 3.2.0                | 2025-11-17 |  4,024 | **37 ahead, 31 behind** |
| `@swimlane/nodegit`                  | 2.0.9                | 2026-06-05 |  2,659 | repo 404s               |
| `@git-glint`, `@rtinternal`, `@alvl` | —                    | 2025       |    low | thin                    |

Plus ~20 dead ones (`@adobe`, `@cardstack`, `@omneedia`, `@sosuisen`, `pj-nodegit`,
`nodegit-atom`, …). `elastic/nodegit` is archived. **No `nodegit-ng` / `nodegit2` /
community restart exists** — those npm names 404.

The two interesting forks (`@readme`, `@swimlane`) swapped node-pre-gyp+S3 for
**`node-gyp-build` (prebuildify)** — binaries inside the tarball, no install-time
network fetch. `@readme`'s `master` supports Node 24/26, **ahead of upstream** —
but v3.3.0 is committed and **never published**.

**The N-API rewrite was formally proposed and then abandoned.**
[nodegit#1298](https://github.com/nodegit/nodegit/issues/1298), opened 2017-06-06
by Hitesh Kanwathirtha **on behalf of the Node.js N-API Working Group** (nodegit
was a top-30 native module by dependency count). Maintainers engaged genuinely
across June–July 2017; John Haley listed the blockers (no Electron N-API support
yet, no Node 6, no node-pre-gyp support). **Every one of those blockers has since
evaporated.** The last comment is `implausible` (Tyler Ang-Wanek), **2019-01-31**:

> _"We should probably get around to this sometime this year."_

Open, silent, seven and a half years later. The companion issue #1774
("context-aware for Electron 9+", the _prerequisite_ for NAN→N-API) is likewise
open since 2020. **No departing maintainer announced a successor project** —
checked `zawata`, `ianhattendorf`, `twwanek`; all are on unrelated work.

**Conclusion: don't fork nodegit.** You would inherit a C++ codebase, a
hand-maintained `vendor/libgit2.gyp`, 363 open issues, and the NAN debt you're
trying to escape — to reach a place `git2-rs` already is.

### 8. Build fresh on napi-rs + git2-rs — measured, not estimated

A probe **actually compiled a working 47-operation napi-rs + git2 binding** to
replace guesswork with numbers.

|                       |   Rust LOC | files | `#[napi]` fns | built by    | over                     |
| --------------------- | ---------: | ----: | ------------: | ----------- | ------------------------ |
| es-git                | **14,393** |    40 |           366 | 2 engineers | ~5 months, ~110 commits  |
| `@napi-rs/simple-git` |      7,828 |    24 |           255 | 1 human     | one week (the 1.0 sweep) |
| **the 47-op probe**   |    **365** |     1 |            47 | 1 agent     | one session              |

**The 40× gap is the key insight, and it is architectural, not scope.** es-git
averages ~39 Rust lines per exported function; the probe **7.8**. The difference
is that es-git exposes a **class/handle object graph** (`Repository` → `Tree` →
`TreeEntry`, iterators, disposal semantics) while the probe is **stateless** —
each call opens the repo, does the work, returns owned data. **Effort is dominated
by object-graph design, not operation count.** A stateless ~40-op binding is a
**days-to-two-weeks** job; the class-based one is the months-long job es-git did.

**The two things that made nodegit painful are both gone:**

- **No cmake.** `libgit2-sys`'s build-deps are exactly `pkg-config` and `cc` — it
  compiles libgit2's C sources directly. `cargo tree -e normal,build` shows no
  cmake crate anywhere. (nodegit's gyp/Python/MSVC gauntlet exists because it
  hand-translated libgit2's build.)
- **OpenSSL is avoidable and Linux-only anyway.** `libgit2-sys/build.rs:259-265`
  picks TLS by target: Windows → WinHTTP, Apple → SecureTransport, else OpenSSL.
  **Omitting the `https` feature drops the graph from 78 packages to 44** and
  removes OpenSSL everywhere. `git2` 0.21.0 changed `default = []` (was
  `["ssh","https"]`), so that's now the default posture. perl/nasm are only needed
  for `vendored-openssl`, i.e. Linux — never Windows.

**`git2-rs` is healthy infrastructure**, not a hobby project: `rust-lang` org,
owners `joshtriplett`/`ehuss`, recent commits from `weihanglo` (Cargo team),
106M all-time downloads, maintained _as_ Cargo's dependency. **`libgit2-sys`
0.18.7+1.9.6 (2026-07-22) → libgit2 1.9.6, all six July-2026 CVEs patched** —
already ahead of es-git (1.9.2, pinned by committed lockfile) and nodegit (1.9.1).

**napi-rs v3 is stable** (v3.0.0 GA 2025-07-17; `napi` 3.12.0, `@napi-rs/cli`
3.8.2). **One binary per platform works across all Node _and_ Electron versions**
— `napi-sys`'s `dyn-symbols` resolves Node-API symbols at runtime via `libloading`
against the host process, so there's no link-time binding. Electron ≥35 supports
Node-API 10; napi-rs runs **blocking Electron CI** on `electron ^43`.
**`electron-rebuild` is not needed** — there's no `binding.gyp` for it to act on.
_(Caveat: Electron's own docs still make a blanket "recompile native modules"
claim with no Node-API carve-out — the conclusion rests on the contract + napi-rs's
CI, not an explicit electronjs.org statement.)_

**Our existing Rust CI mostly carries over.** `native/resource-monitor` already
gives us `dtolnay/rust-toolchain` with per-target provisioning
(`release.yml:395-398`), a 4-leg matrix, `cargo build --locked --release --target`
(`build-desktop-artifact.ts:1196-1204`), `lipo -create` for universal macOS
(`:1243`), and staging into `apps/desktop/prod-resources/` (`:645-646`).
**Every leg is a native runner for its own OS**, which sidesteps C
cross-compilation entirely — no zig, no Docker, no `TARGET_CC`.

Deltas: add `crate-type = ["cdylib"]` + `build.rs` calling `napi_build::setup()`
(build-dep `napi-build = "2"` — ⚠️ the official v2→v3 migration guide erroneously
says `"3"`; max published is 2.4.0); add `@napi-rs/cli` as a devDependency to
generate `index.js`/`index.d.ts` (`cargo build` alone yields a bare
`.dll`/`.dylib`/`.so`); **skip the per-platform npm package machinery entirely**
if it ships inside the app — build the `.node` in the existing 4-leg matrix and
copy it into `prod-resources` like the sidecar already does. Coverage stays at 4
targets (no linux-arm64, no musl, no win-arm64). No packaging change beyond
`asarUnpack`.

**Gotchas, with the pattern to copy:**

- **Lifetimes.** git2's `Tree<'repo>`/`Commit<'repo>` are borrow-bound but napi
  objects must be `'static`. Neither incumbent uses `ouroboros`/`self_cell`/
  `transmute`; both use napi-rs's `Reference<T>::share_with` →
  `SharedReference<Owner, git2::X<'static>>`. Consequence: a live `Tree`
  transitively pins the whole `Repository` (mmaps and fds included). simple-git
  had to hand-build a liveness net — an `Arc<AtomicBool>` through 19 structs with
  `ensure_alive()` called **169 times**. **Going stateless skips this entire
  problem class.**
- **Threading.** `git2::Repository` is `Send` but **not `Sync`**
  (`git2-rs/src/repo.rs:116`). **Copy simple-git, not es-git:** simple-git's
  `reopen_worker_repo(path, flags)` opens a fresh worker-local `Repository` in
  every `compute()` so nothing aliases the main-thread handle (3
  `unsafe impl Send`, each justified in prose). **es-git carries the live
  JS-visible handle onto the libuv worker with 11 `unsafe impl Send` blocks and
  zero `SAFETY:` comments**, with only an `RwLock` on the immediate object and
  nothing protecting the `!Sync` parent.
- **Zero-copy `Buffer` does not work in Electron** (V8 memory cage) — napi-rs
  silently _copies_ the `Vec<u8>`. Matters for large diffs/blobs.
- **git2 0.21 API churn:** the probe's first draft threw 17 compile errors — 9
  `E0597` lifetime errors, 8 from 0.21.0 moving accessors from `Option<&str>` to
  `Result<&str>` (`Reference::name()`, `Commit::summary()`, `StringArray::iter()`)
  while `Signature::name()` stayed `Option<&str>`. One mechanical pass; it's why
  es-git pins `=0.20.4` exactly.

**Binary size:** probe **1.91 MB** (win32-x64) vs es-git 3.71 MB / 9.05 MB
(linux-x64-gnu). The 5.34 MB win-vs-linux gap on identical Rust _is_ vendored
OpenSSL — dropping `https` saves ~2 MB on every platform. Cold build of git2 +
vendored libgit2: **~1m54s**.

**One correction to §4 worth carrying forward:** `~/.ssh/config` support is
**binding-choice, not a libgit2 limit.** libgit2 v1.8.0+ has an `exec` SSH
transport that shells out to real `ssh` and gets Host aliases, `IdentityFile`,
`ProxyCommand`, and `core.sshCommand`. nodegit disables it
(`vendor/libgit2.gyp` sets `GIT_SSH_LIBSSH2`, comments out `ssh_exec.c:161`);
es-git and simple-git both use libssh2 and inherit the same gap. **A binding we
write could enable it.**

### 9. Can a caching layer reach status parity? Yes — but it is orthogonal

Measured directly on this repo (15,704 tracked files, **257,923 files on disk**,
2.2 MB index):

|                                                  |                   time |
| ------------------------------------------------ | ---------------------: |
| CLI `status --porcelain=2 --branch` (`-unormal`) |         **112–119 ms** |
| CLI `-uno` (skip untracked)                      | 114 ms — **no faster** |
| CLI `-uall` (expand untracked)                   |                 152 ms |
| es-git `statuses()` default                      |                 245 ms |
| es-git matched to `-unormal`                     |                 254 ms |
| es-git `includeUntracked: false`                 |                 252 ms |
| es-git `noRefresh: true`                         |    **380 ms — slower** |

**Three findings, and the first one demolishes the original explanation.**

**(a) git is _not_ using a cache here.** `core.untrackedCache` is unset and the
index contains **neither `UNTR` nor `FSMN`** (verified by parsing `.git/index`
directly; only `TREE` and `link` are present). `core.fscache=true` is set, but
that's a within-process Windows lstat cache, not a persisted one. So the earlier
"libgit2 has no fsmonitor/untracked-cache, that's why it's slower" framing is
**wrong for our case** — both sides are doing a cold full walk, and git is simply
~2× faster at walking. The untracked walk is nearly free either way because
`-unormal` stops at the first untracked _directory_ rather than recursing.

**(b) es-git's `StatusOptions` appear not to take effect.** `len()` returns **50
entries regardless** of `includeUntracked`, `includeIgnored`, or
`recurseUntrackedDirs`, and `noRefresh: true` makes it _slower_ — which is
nonsensical. Timing is flat at ~250 ms across every option combination. Either the
options aren't wired through or `len()` ignores them. **Add to the es-git defect
list** alongside the timezone and `Diff.print` bugs; do not rely on status
filtering.

**(c) Therefore caching absolutely can reach parity — but the cache is not a
libgit2 concern, and it would speed up the CLI path identically.**

To beat a cold walk you must _not walk_, which means knowing what changed —
i.e. an fsmonitor-equivalent. That is a **filesystem watcher**, and **we do not
have one.** Grepping the server turns up only three `fs.watch` sites, all
narrow: `keybindings.ts:593` and `serverSettings.ts:532` (config _directories_),
and `GitVcsDriverCore.ts:807` (tailing the GIT_TRACE2 event file). **There is no
workspace file watcher.** Building one over 257k files is its own project —
Node's recursive `fs.watch` works on Windows/macOS but **not Linux**, so it means
adopting `@parcel/watcher` or `chokidar`, plus ignore-aware pruning so we don't
watch `node_modules`.

We do already cache: `GitVcsDriverCore` holds repository paths (10 min), ref
snapshots (2 min, epoch-invalidated), and **status results (1 s)**, and
`VcsStatusBroadcaster` does push-based fan-out with backoff.

**The strategic point: a watcher + cache is worth doing on its own merits and is
independent of the binding decision.** It would take status off the hot path
entirely, at which point libgit2's 2× disadvantage on the cold walk stops
mattering — but so does libgit2's speed advantage on refs. **Caching is not an
argument for es-git; it's an argument for a watcher regardless of binding.**

### 10. Recommendation: prototype on es-git, don't build on it

es-git has the best API surface and is the right vehicle to _prove_ the design.
It is not something to take a production dependency on today, because **four of
our headline surfaces are blocked by defects, not gaps**:

| Need                                     | Blocker                                                              |
| ---------------------------------------- | -------------------------------------------------------------------- |
| Graph sidebar                            | `Commit` has **no `parents()`** (confirmed by reading `index.d.ts`)  |
| Review + checkpoint diffs                | `Diff.print` **drops `+`/`-` origin markers**; no `Patch` line stats |
| Checkpoints                              | no `Index.read_tree` → **silently drops tracked-but-ignored files**  |
| Any repo w/ `--relative-paths` worktrees | **repo won't open at all** (pinned libgit2 1.9.2)                    |
| Status filtering                         | `StatusOptions` appear inert (§9b)                                   |
| GCM / credential passthrough             | declarative `Credential` union, **no callback**                      |

Plus: **81 days without a commit**, sole maintainer visibly working on another
repo, three unreviewed bug-fix PRs, and a **committed `Cargo.lock` pinning libgit2
1.9.2 — three security releases and six July-2026 CVEs behind, unpatchable without
a human.** Adopting it means planning to fork it.

Set against §8: a **stateless, async-first binding measured at 365 lines of Rust
for 47 operations**, on `git2-rs` (rust-lang-maintained, already libgit2 1.9.6,
fully patched), built in our existing 4-leg native-runner Rust CI, with no cmake
and no OpenSSL if we omit `https`. That is days-to-weeks, and we own the libgit2
version and the async story — the two things es-git can't give us.

**Suggested sequence:** (1) prototype the graph sidebar against
`@napi-rs/simple-git`, which _does_ expose `parentCount()`/`parentId()`, to
validate the read path end-to-end; (2) build the watcher + cache, which pays off
on the current CLI path immediately; (3) build the async-first binding for reads
only, keeping the CLI for network, commit, and anything hook- or credential-
adjacent.

## Plan / steps

1. ~~Survey the existing git layer; quantify size and API surface.~~ **Done.**
2. ~~Assess nodegit specifically.~~ **Done — rejected, §3.**
3. **← Current.** Research forks/successors of nodegit, and deep-dive the modern
   N-API landscape (es-git, `@napi-rs/simple-git`, any gitoxide binding).
   _In flight._
4. **← Current.** Build the 24-operation coverage matrix against each candidate's
   real `index.d.ts`. _In flight._
5. Decide: adopt an existing binding, roll a purpose-built napi-rs + `git2-rs`
   binding, or stay on the CLI. Record the decision and its reasoning here.
6. If proceeding: implement as a **second `VcsDriver`** behind the existing
   registry, proven against `VcsDriverContractHarness`, with per-operation CLI
   fallback for the §4 limits. Never a big-bang replacement.

## Things not to do

- **Don't adopt any NAN-based addon.** The four-runtime constraint is hard.
- **Don't do a big-bang replacement of `GitVcsDriverCore`.** The registry +
  contract harness exist precisely to allow a parallel driver.
- **Don't drop the CLI dependency entirely.** Hooks, credential helpers, LFS, and
  `git subtree` provably require it. The realistic win is "native for the hot
  read paths", not "no git binary".
- **Don't assume per-path FFI beats one CLI call.** `check-ignore` over ~100k
  paths is the case to benchmark before believing.
- **Don't break the WSL dual-ABI staging path** (`stageWslNodePtyPrebuild`) — it
  depends on N-API ABI stability.
- **Don't run repo-wide checks** (`AGENTS.md`).

## Open questions for the user

_All three original questions are answered — see "Decisions already made". What
remains is scoped to the upstream binding project, not to this repo:_

1. **Fork nodegit, or build fresh on napi-rs + `git2-rs`?** Worth deciding
   deliberately. nodegit's bindings are **code-generated** from JSON descriptors
   (hence 12,778 files in the tarball), so a NAN→N-API migration means rewriting
   generator templates rather than hand-porting call sites — more tractable than
   it first looks, but it inherits a C++ toolchain, a hand-maintained
   `vendor/libgit2.gyp`, and 343 open issues. A fresh napi-rs binding gets
   turnkey cross-platform prebuilds and `git2-rs` doing the FFI, at the cost of
   no API compatibility with existing nodegit users.
2. **Does this need building at all?** `es-git` (Toss/Viva Republica) is already a
   napi-rs binding over `git2-rs` with the broadest API surface I found —
   including `Rebase`, `Worktree`, `Submodule`, `Stash`. If it covers the
   24 operations, forking nodegit is redundant effort. **Resolve this before
   writing any code.** Research was in flight when this was shelved.

## Progress log

- [x] Surveyed the git layer — ~9,500 lines + ~7,500 test lines, all `apps/server`.
- [x] Mapped the four runtimes the binding must load in.
- [x] Assessed nodegit — rejected on NAN; verified activity claims against the
      GitHub API and corrected the "life support" framing to "maintained, not
      developed".
- [x] Catalogued libgit2-inherent limits that no binding can fix.
- [x] Extracted the 24-operation requirements spec.
- [x] Confirmed direction with the user: fully native, shelling out from inside
      callbacks; all four motivations apply.
- [x] **Shelved 2026-08-06** pending a separate upstream N-API binding project.
- [ ] Fork/successor research + modern N-API landscape deep-dive. _Was in flight
      at shelving time; results belong to the upstream project, not this repo._
- [x] 24-operation coverage matrix — **done, empirically** (§5). Best available
      binding covers 8/24 cleanly; three defects are disqualifying; sync APIs are
      a worse problem than the coverage gaps. Confirms nothing should change here
      until an upstream binding improves.
- [x] Produced the **minimum viable delta** spec for the upstream project (§6).
- [ ] Decision + recommendation. _Deferred until a binding exists._

## Resuming this

The requirements spec (§2, the 24 operations) and the runtime constraints
("Environment / context") are the durable artifacts here — they are what the
upstream binding must satisfy. When a viable N-API binding exists:

1. Re-check §4 against that binding's actual capabilities (the libgit2 limits are
   fixed, but the callback surface for hooks/credentials varies by binding).
2. Implement as a second `VcsDriver` behind the existing registry.
3. Prove it against `apps/server/src/vcs/testing/VcsDriverContractHarness.ts`
   before switching any caller.
4. Benchmark `check-ignore` bulk filtering and `status` on a large repo before
   assuming the native path wins.
