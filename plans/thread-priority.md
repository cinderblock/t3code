# Thread priority in the sidebar inbox

## Goal

Let the user mark threads high or low priority so the sidebar's Active (inbox) section
lists important threads first, and let each priority group choose whether the
longest-waiting thread or the most recent one sits on top. Before this, with the Working
shelf on, the Active section was fixed newest-first, so a thread that just finished a turn
jumped to the top and old waiting threads sank.

## Environment / context

- Worktree: `C:\Users\camer\.t3\worktrees\t3code\feature-thread-priority`, branch
  `feature/thread-priority`, created from local `master` at `fa45619aa5`. Not pushed.
- Use this worktree's own `node_modules/.bin/vp`; the `vp` on PATH is the main checkout's.
- Inbox sort: `sortInboxThreadsByReturn` in
  `packages/client-runtime/src/state/threadInbox.ts` (shared by web and mobile). Its
  "waiting since" timestamp is the max of createdAt, unsettledAt, latestRun.requestedAt,
  latestRun.completedAt and the client-observed "left the Working shelf" time.

## Decisions already made (don't re-ask)

1. Priority is stored per thread on the server (`thread.priority.set` command,
   `thread.priority-set` event, `priority` on the thread and shell), so every client shows
   the same order.
2. Stored as an integer (-100..100) so open-ended levels are possible later. The UI offers
   three levels: high = 1, normal = null (0 is normalized to null), low = -1.
3. The Active section groups threads by priority, highest first.
4. Each group (high / normal / low) has its own sort-direction client setting,
   `sidebarInboxSortDirections`, "oldest_first" or "newest_first", default oldest first.
   Mobile stores the same shape in its own preferences file.
5. Every surface gets it: web/desktop context menu, command palette, unbound keybinding
   commands, mobile row menu, MCP `t3_thread_organize set_priority`, and Normal to clear.

## Decisions made during implementation (flag to user)

- Priority only reorders the Active list while the Working section is on. With it off, the
  Active list keeps its manual drag order; grouping by priority there would fight drag
  reordering (a drop between two high threads would still render in the normal group).
  The row arrow keeps priority visible in both modes.
- `thread.priority.raise` / `thread.priority.lower` ship without default keys: the free
  `Ctrl+Alt+Arrow` combination rotates the screen on many Windows Intel graphics drivers.
- No SQL migration: V2 threads live in `payload_json`. Migration 054 (the template) was for
  the legacy V1 table only.
- The row indicator has no hover tooltip (the user's tooltip rule); the arrow and its
  accessibility label carry the meaning.

## Findings / gotchas

- The first `vp i` ran ~25 min; a typecheck run before it finished printed no errors only
  because `vp` was missing. Check the exit code, not the error count.
- Four suites fail on Windows independent of this work; logged in `ISSUES.md`
  ("Four test suites fail on Windows regardless of the change under test").

## Progress log

- [x] Contracts, server, client-runtime, web context menu, palette, keybindings (`8f4c3d1197`)
- [x] MCP set_priority and priority in thread reads (`13ef01ce3d`)
- [x] Web settings rows and row arrows (`d09aa47fae`)
- [x] Mobile row menu, row arrow, settings (`2b413484f1`)
- [x] User docs (`b5921ea683`)
- [x] ISSUES.md entry for Windows test failures (`36296d9511`)
- [ ] Integrated pass in a real client (needs the user's go-ahead)
- [ ] Merge / push decision (user's call)

## Open questions for the user

1. Should priority also group the Active list when the Working section is off? Recommend
   no (see above).
2. Run an integrated web check with `test-t3-app`? Needs permission to start a dev server
   and browser.
3. Merge `feature/thread-priority` into `master` locally, or push it as a branch?

## Things not to do

- Don't touch the main checkout at `C:\Users\camer\git\t3code`; other threads have
  uncommitted work there.
- Don't run repo-wide checks (`vp check`, `vp run -r test`).
