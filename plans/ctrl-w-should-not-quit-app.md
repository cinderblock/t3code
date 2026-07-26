# Ctrl+W should not close the whole app

## Goal

Pressing `Ctrl+W` must not silently close/quit the entire T3 Code app. At minimum
it should warn; ideally it should not quit at all.

## Root cause

`apps/desktop/src/window/DesktopApplicationMenu.ts` adds `{ role: "windowMenu" }`
to the application menu. On Windows/Linux, Electron's `windowMenu` role expands to
a **Close** item bound to `CmdOrCtrl+W`. T3 Code is a single-window app, so closing
that window fires `window-all-closed` → `app.quit` in
`apps/desktop/src/app/DesktopLifecycle.ts` (lines ~191-201). Result: an accidental
`Ctrl+W` quits everything with no warning.

On macOS, `Cmd+W` (via the File menu `role: "close"`) closes the window but does NOT
quit the app (standard mac behavior; `window-all-closed` skips quit on darwin). So the
bug is non-darwin only.

The renderer also binds `Ctrl+W` to `terminal.close` (only when the terminal is
focused) — see `apps/web/src/keybindings.ts` / `keybindings.test.ts`. The menu
accelerator collides with that too.

## Fix

In `DesktopApplicationMenu.ts`, keep `{ role: "windowMenu" }` on darwin, but on
non-darwin build the Window submenu explicitly with a plain "Close Window" item that
has NO accelerator (do not use `role: "close"`, which forces the Ctrl+W accelerator).
Menu-click close is intentional and stays; the keyboard accelerator is dropped, and
`Ctrl+W` is freed for the renderer (terminal.close, or a no-op otherwise).

## Decisions made

- Prefer "don't quit at all on Ctrl+W" over "warn then quit" — strictly better and
  satisfies the "at least a warning" floor.
- Keep an explicit Close Window menu entry (intentional click) — only drop the
  keyboard binding.

## Progress

- [x] Root cause identified (windowMenu role → Ctrl+W → single-window quit)
- [x] Edit DesktopApplicationMenu.ts — non-darwin Window menu built explicitly;
      "Close Window" via click handler, no accelerator. darwin keeps windowMenu.
- [x] Add regression test asserting no menu item binds Ctrl+W (and no role:close/
      role:windowMenu on non-darwin). Both menu tests pass.
- [x] Typecheck / test — my files are clean. Pre-existing failures remain:
      14 unrelated Windows path-separator test failures (`/userdata` vs `\userdata`)
      and pre-existing effect-lint errors in main.ts (fs/path/new Date). Not mine.

## Result

Ctrl+W no longer closes/quits the app on Windows/Linux. Outside the terminal it is
a no-op; when the terminal is focused the renderer's terminal.close now reliably
receives it (menu accelerator no longer preempts). Menu-click Close Window still
closes intentionally.
