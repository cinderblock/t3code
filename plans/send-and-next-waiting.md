# Send, then go to the next thread waiting on you

## Goal

`Ctrl+Alt+Enter` sends and opens a new-thread draft. The maintainer wants the same "send and
leave" action, but landing on a thread that needs them instead of a draft.

## Decisions

- New commands rather than changing `composer.sendAndNewThread`, so the existing shortcut and
  upstream's default keep working.
- `composer.sendAndNextWaiting`: `alt+enter`, `composerFocus && !draftThreadRoute`. Plain Alt+Enter
  is unbound and the composer ignores it today.
- `thread.nextWaiting`: `mod+alt+]`, the same jump without sending.
- "Needs you" has two tiers. Agent blocked on you first (approval, input, guest request), then
  finished work you have not read (failed, limited, unseen completion, woke). Settled, snoozed and
  still-working threads never qualify.
- Search runs in sidebar order from the current thread, wrapping, never the current thread.
- Nothing waiting: stay put and say so with a toast. Do not create a stray draft.
- Existing threads only. In a draft, `Ctrl+Enter` already sends in the background.

## Findings

- `settleAndAdvance.ts` is the established bridge from chat code to sidebar state: the sidebar
  registers a handler, chat calls it, `false` means no sidebar is mounted.
- `resolveSidebarThreadStatus` returns `waiting` for an idle runtime, so its top status hides unread
  state. The tiers must read status and unread separately.
- `rightPanelOpen` is not in the chat shortcut context, and unknown `when` keys are false, so
  `!rightPanelOpen` is always true there. A `mod+w` to `thread.settle` rule would settle even with
  a panel open. Do not suggest that rule without adding the key.
- `Ctrl+Shift+S` toggles: on an already-settled thread it un-settles.
- The Tiptap Enter block treated Alt+Enter as plain Enter inside a code block or on a fence line,
  inserting a newline instead of sending. It now skips `altKey`.
- `thread.next` uses the rendered order, which leaves out collapsed shelves, so the waiting search
  reads `searchableThreads` instead.
- `vp run check:changed` dies with `spawn ENAMETOOLONG` on this fork, and `vp run typecheck` fails
  on a stale `typescript@7.0.2` shim. Both are in ISSUES.md. Typecheck ran through the tsc-rs binary
  directly; format, lint and tests ran on the changed files.

## Progress

- [x] Contracts, defaults, migration for existing keybindings files
- [x] Pure resolver with tests
- [x] Bridge, sidebar handler, send path
- [x] Docs
- [x] Checks and commit
- [ ] Rebuild and restart the desktop app. `start-t3.ps1 -BuildOnly` refuses while the app runs, since
      swapping web chunks would break its lazy routes, and restarting it would stop the app hosting
      this thread, so that step is the maintainer's.
- [ ] Try `Alt+Enter` and `Ctrl+Alt+]` in the real app. Not done: no browser verification was requested.

## Open questions

1. Should `Ctrl+W` settle the thread when nothing is left to close? Upstream does not do this. It
   needs a `rightPanelOpen` key in the chat shortcut context plus a new rule.
