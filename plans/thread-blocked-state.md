# Blocked threads

## Goal

Let a thread be parked as "blocked" on another thread, on its own sidebar shelf, and come
back on its own when that other thread settles or finishes its work. Agents and the user
can both set it. Requested 2026-11-01 alongside the end-of-turn TL;DR rewrite, because a
thread waiting on another thread had no way to say so.

## Environment / context

- Worktree: `C:\Users\camer\.t3\worktrees\t3code\feature-thread-blocked`, branch
  `feature/thread-blocked`, created from `master` at `dc371881f9`.
- Template for the shape of the change: thread priority (`plans/thread-priority.md`,
  commits `8f4c3d1197` and `13ef01ce3d`).
- Worktree setup needs `T3CODE_PROJECT_ROOT` set when run by hand.
- Heavy commands go through `~/.srm/bin/srmctl run --slots N --low`.

## Decisions already made (don't re-ask)

1. Fork first, not upstream. Upstream needs maintainer approval in an Ideas discussion, and
   auto-resume builds on the fork-only queued messages.
2. Blocked is parked state like snooze, not a run status.
3. A release brings the thread back for a look. Continuing on its own is opt-in, through a
   queued message with a thread trigger.
4. A blocker failing or being archived or deleted also releases, so nothing waits forever.
5. Cycles are rejected.

## Design

- Thread field `blockedOn: { threadId, until: "settled" | "finished", blockedAt } | null`.
- Commands `thread.block` / `thread.unblock`, events `thread.blocked` / `thread.unblocked`.
- `threadBlockReleased(block, blocker)` in contracts is the one rule, shared by the release
  service and the queued message trigger.
  - `finished` means the blocker has no active work, so it waits through back-to-back runs.
  - A failure counts only if it ended after `blockedAt`.
  - `thread.block` refuses a block that would release at once, because an agent can't see
    the sidebar to notice.
- Parked states are exclusive: block clears snooze, snooze clears block, and settling,
  pinning or a sent message clears the block, as they do for snooze.
- A thread raising its hand (approval, question, new failure) leaves the shelf with the
  block still stored, as snooze does.
- `ThreadBlockService` releases from the event stream, with a one-minute sweep to catch
  anything missed while the server was down.
- Queued message trigger `{ type: "thread", threadId, until, since }`; `t3_send_later` gains
  `afterThread`.

## Plan / steps

1. Contracts: schema, commands, events, capability, predicate.
2. Server: orchestrator, projections, relay, parked-state checks, release service.
3. MCP: block and unblock actions, blocked state in thread reads.
4. Queued message trigger and `t3_send_later`.
5. Client runtime: command, optimistic update, `effectiveBlocked`.
6. Web: shelf, row label, menus, palette, picker dialog.
7. Mobile: shelf, row menu, picker.
8. Docs and evals for the changed tool text.

## Findings / gotchas

- Auto-settle and idle compaction skip blocked threads. Usage-limit recovery does not: it
  continues the thread's own interrupted work, and the block stays stored.
- Worktree install on 2026-11-01: `C:` ran out mid-install (`os error 112`) at 1.2 GB free. Removing
  the partial `node_modules` showed 81 GB returned, but free space kept climbing afterwards with
  nothing of mine running, so the install is not proven to be the cause. pnpm hardlinks here.
- The install itself was fine: rerun with a free-space guard it finished in 5.5 minutes with `C:`
  still at 169 GB free, so something else filled the drive and released the space.
- `vp run check:changed` can't run here (`ENAMETOOLONG`, already in `ISSUES.md`). Format, lint,
  knip and tests were run by hand. The only lint errors left are on lines this work didn't touch.
- `OrchestratorMcpToolkit.integration.test.ts` has two Windows-only `C:\C:\` fixture failures that
  `ISSUES.md` already records.
- A `vp run --filter` typecheck stops at the first failing package, so a later package can look
  clean without having run. Read the `$ tsc` lines.
- Mobile shows blocked threads in Snoozed and can end a block, but can't set one: that needs a
  thread picker sheet on two native platforms, which can't be exercised on this machine.

## Progress log

- [x] Contracts
- [x] Server
- [x] MCP
- [x] Queued message trigger
- [x] Client runtime
- [x] Web
- [x] Mobile: display and ending a block
- [ ] Mobile: setting a block
- [x] User docs
- [x] Typecheck and tests (server, web, mobile, contracts, client-runtime)
- [ ] Evals for the changed tool text (no `ANTHROPIC_API_KEY` in a repo `.env` on this machine)
- [ ] Integrated pass in a real client (needs the user's go-ahead)
- [x] Merged into `master` as `fc3581ba1f` (2026-11-01), not pushed. Web typecheck clean on the merged tree.
- [ ] Running app rebuilt: the idle watcher (pid 27764) relaunches once no thread is working.

## Things not to do

- Don't touch the main checkout at `C:\Users\camer\git\t3code`; other threads work there.
- Don't run repo-wide checks (`vp check`, `vp run -r test`).
- Don't start a server against `~/.t3/userdata`.
- Don't post upstream without a per-post yes.
