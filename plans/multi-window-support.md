# Multi-window support for T3 Code desktop

## Goal

Let the desktop app open **multiple top-level windows**, each scoped to a logical
group of projects, so each window can be parked on a different **Windows virtual
desktop** for work segregation.

Two separable features, and it matters to keep them separate:

1. **Multi-window** — the app can have N main windows at once. Infrastructure.
2. **Per-window project scoping** ("workspaces") — each window shows only its own
   subset of projects. This is the feature actually wanted; multi-window is the
   substrate it needs.

Shipping (1) without (2) gives N identical windows showing the same full project
list — not useless (different threads open side by side), but not the goal.

## Environment / context

- Electron main process, **Effect**-based (`Context.Service` + `Layer`), entry at
  `apps/desktop/src/main.ts`.
- Renderer is `apps/web` — a **TanStack file-router** SPA (`apps/web/src/routes/`)
  that talks to `apps/server` over websocket. Loaded via a custom protocol origin
  from `getDesktopUrl()` (`apps/desktop/src/electron/ElectronProtocol.ts:23`).
- Single-instance lock is held by the Clerk SDK bridge
  (`apps/desktop/src/app/DesktopClerk.ts:133`) → all windows live in **one
  process**. That is what we want anyway: one backend, N renderers.
- `native/` already exists (`libghostty-vt`, `resource-monitor`), so there is
  precedent for a native addon if Windows virtual-desktop APIs are ever needed.

## Key architectural finding

**The frontend is already a multi-client system.** The server serves concurrent
browser, mobile, and desktop clients today. A second window is just another
websocket client loading the same SPA. So the frontend/backend cost of multi-window
is low.

**The cost is concentrated in the Electron main process**, where "the main window"
is baked into _service interfaces_, not just implementations.

## Findings — where the singleton is

### Already plural-aware (good news)

`apps/desktop/src/electron/ElectronWindow.ts` — the low-level primitive service
already has `sendAll`, `syncAllAppearance`, `destroyAll`, `listWindows`, and a
`focusedMainOrFirst`. Only a single `mainWindowRef` (`:100`) is singular. This layer
needs the least work.

### Singular by interface (the real work)

`apps/desktop/src/window/DesktopWindow.ts:66-100` — the service contract itself is
singular:

```
createMain / ensureMain / revealOrCreateMain / createMainIfBackendReady
flushMainWindowBounds / zoomMain / activate / dispatchMenuAction
```

Every one of these must become window-keyed (or take a window handle). This is a
contract change that ripples to every consumer, and consumers are numerous —
`DesktopWindow.layer` is provided into `desktopBackendLayer`, which nearly the whole
app graph hangs off (`main.ts:158-197`).

### The biggest single blocker: PreviewManager

`apps/desktop/src/preview/Manager.ts` — ~3,700 lines, holds one
`mainWindowRef` (`:471`) set via `setMainWindow` (`:1428`), called from
`DesktopWindow.ts:447`. It attaches `WebContentsView`s to _that_ window.

It does not merely _ignore_ other windows, it **actively rejects** them:
`Manager.ts:1561-1565` refuses to register any webview whose
`hostWebContents !== mainWindow.webContents`. Keyboard-shortcut forwarding also hard-
targets that one window's `webContents.sendInputEvent` (`:1359-1364`). And the
picture-in-picture window at `Manager.ts:2360` is a raw `new BrowserWindow` that
bypasses the `ElectronWindow` service entirely.

Making preview per-window means a window-keyed map of preview state throughout a
very large file. **Recommend deferring**: pin preview to the window that owns it,
and disable (with a clear message, not a silent rejection) in others. Ship
multi-window without per-window preview first.

### Splash window — an existing bug caused by this very assumption

`DesktopWindow.ts:292-299` has a `withoutSplash` filter that exists _solely_ because
`currentMainOrFirst`'s `getAllWindows()[0]` fallback would otherwise latch onto the
"Connecting to WSL" splash and treat it as the main window. This is prior art that
the `[0]` fallback is already producing bugs at N=2 windows; a proper registry
removes the need for the workaround.

### Window bounds persistence — has an outright bug waiting

`DesktopWindow.ts:389` writes a single `desktopSettings.setMainWindowBounds(...)`
slot (schema at `settings/DesktopAppSettings.ts:29-30`, persisted to
`<stateDir>/desktop-settings.json` via a hand-rolled atomic JSON store at
`DesktopAppSettings.ts:402-446` — _not_ `electron-store`, despite that being a
dependency).

Worse: `DesktopWindow.ts:276` declares a **module-scoped mutable**
`let flushMainWindowBounds`, reassigned at `:445` by whichever `createWindow` ran
last. A second window silently clobbers the first window's bounds-flush closure, so
the first window's position is never saved. Drained on quit via
`DesktopLifecycle.ts:83`.

Needs: bounds keyed by window/workspace id, and the flush closure moved into the
window registry rather than module scope.

### IPC routing — sender is discarded outright

`apps/desktop/src/ipc/DesktopIpc.ts:96` registers
`ipcMain.handle(channel, (_event, raw) => …)` — **the sender event is thrown away**.
`handleSync` (`:129`) uses only `event.returnValue`. So no handler can know which
window called it; they all resolve a target via global focus/first heuristics:

- `ipc/methods/window.ts:68` — fullscreen state ← `currentMainOrFirst`
- `ipc/methods/window.ts:200` — dialog owner ← `focusedMainOrFirst`
- `ipc/methods/window.ts:240` — **renderer-driven context menu** ← `focusedMainOrFirst`
  (the in-window context menu built at `DesktopWindow.ts:462-508` _is_ correctly
  window-scoped; this renderer-initiated one is not)
- `ipc/methods/window.ts:285` — ditto

Handlers are installed **once per app run**, not per window
(`app/DesktopApp.ts:200` → `ipc/DesktopIpcHandlers.ts:47-94`), and `DesktopIpc.ts:95`
calls `removeHandler` first — so re-installing replaces rather than adds. Good: the
fix is a single change in `DesktopIpc` to pass the sender through, then an audit of
the ~4 call sites above.

Main→renderer is already **broadcast to all windows** via `ElectronWindow.sendAll`
(`:240-258`): preview state / recording frames / pointer events
(`ipc/methods/preview.ts:39,42,45`) and update state (`updates/DesktopUpdates.ts:272`).
With N windows, window A would receive window B's preview events — these need to
become targeted.

### SSH password prompts hard-fail

`ssh/DesktopSshPasswordPrompts.ts:286` does `yield* electronWindow.main` and raises
`DesktopSshPromptWindowUnavailableError` if absent, then sends to that one window
(`:429`) and binds `once("closed")` to it (`:425`). Needs to target the window whose
session triggered the prompt.

### Lifecycle

- `second-instance` (`DesktopClerk.ts:138-147`) reveals `currentMainOrFirst`, never
  creates — needs a policy (reveal most-recently-focused? open a new window?).
- `activate` (macOS dock, `DesktopWindow.ts:792-812` via `DesktopLifecycle.ts:206`)
  reuses the existing window; only creates one if none exists _and_ the backend is
  ready. Needs to restore the saved window set instead.
- `window-all-closed → app.quit` in `apps/desktop/src/app/DesktopLifecycle.ts`
  (:209-219, non-darwin). Multi-window changes this calculus favorably — see
  `plans/ctrl-w-should-not-quit-app.md`. Once N windows exist, closing one should
  close just that window, and `Ctrl+W` becomes _correct_ rather than catastrophic.
  **These two plans should land together**; multi-window is the principled fix for
  the Ctrl+W bug. `DesktopApplicationMenu.ts:216-224` even carries the comment
  _"because this is a single-window app, closing the window quits everything"_ —
  and its hand-built "Close Window" item (`:231-233`) already correctly uses the
  `browserWindow` argument, so that one item needs no change.
- There is **no tray** anywhere (only `app.dock?.setIcon` at
  `electron/ElectronApp.ts:175`), so no tray work is implied.

## Findings — renderer (smaller, but has a real bug class)

All windows share **one origin**, therefore **one `localStorage`**. ~19 non-test
files touch it (`uiStateStore`, `rightPanelStore`, `diffPanelStore`,
`terminalUiStateStore`, `composerDraftStore`, `browserHistoryStore`,
`useResizableWidth`, `useTheme`, `useSettings`, …).

Two distinct problems:

1. **Scope**: which state is per-window vs. app-wide? Mostly fine as shared — theme,
   settings, keybindings, composer drafts (keyed by thread) _should_ be shared. The
   genuinely per-window state ("which thread am I looking at") is **already in the
   URL** (`_chat.$environmentId.$threadId.tsx`), so it is per-window for free.
2. **Clobbering** (the real bug): these are Zustand stores that hydrate from
   `localStorage` at load and write back. Window B's write does not update window
   A's in-memory state, so A later writes stale data over B's. Last-writer-wins
   corruption of sidebar order, expansion state, etc.
   → Fix with a `BroadcastChannel` that pushes store updates between windows, or
   move truly-per-window state to `sessionStorage`.

`apps/web/src/uiStateStore.ts` (`PERSISTED_STATE_KEY = "t3code:ui-state:v1"`) holds
`projectOrder` / `projectExpandedById` / `collapsedProjectCwds` — exactly the state
most likely to clobber.

The **connection catalog** is separate and safer: `apps/web/src/connection/storage.ts`
backs it with **IndexedDB** (`makeCatalogBackend`, `:260`), which is transactional
rather than read-modify-write, so cross-window races there are far less likely. Web
clients also carry no `deviceId` (`connection/platform.ts:207` returns `Option.none()`),
so N windows are simply N anonymous clients to the server — no identity collision.

## Findings — the workspace feature

Clean insertion point exists: `apps/web/src/sidebarProjectGrouping.ts:53`
`buildSidebarProjectSnapshots(...)` is a **pure function** that builds the sidebar
project list. A per-window project filter goes here or at its call site.

Needed:

- Data model: `{ id, name, projectKeys[], bounds }` per window group.
- Where to persist: desktop settings (desktop-only) vs. server state (syncs to web
  and mobile). **Open question — see below.**
- Window identity must reach the renderer: pass `?workspace=<id>` on the URL from
  `getDesktopUrl()` so the SPA knows which group it is.
- UI: "New Window" menu item, "Move project to window…", window title = group name.

## Windows virtual desktops specifically

- **Placement works with zero Windows-specific code.** A new Electron window opens
  on the _currently active_ virtual desktop. Switch to desktop 3, open the "Work"
  window — done.
- **Windows does not persist app→virtual-desktop assignment across restart**, and
  there is no public API to do so cleanly. `IVirtualDesktopManager` (public COM)
  offers `GetWindowDesktopId` / `MoveWindowToDesktop`, so a window's desktop GUID
  _could_ be recorded and restored — but _enumerating or creating_ desktops requires
  `IVirtualDesktopManagerInternal`, which is undocumented and whose GUIDs change
  between Windows builds.
- **Recommendation: ship no virtual-desktop automation initially.** Windows remembers
  nothing; the user places windows manually each session. If it becomes annoying,
  a native addon calling the public `IVirtualDesktopManager::MoveWindowToDesktop`
  with a stored GUID is the supported route (degrade gracefully when the GUID no
  longer exists).

## Proposed phasing

- [ ] **Phase 0 — IPC sender routing.** Make `DesktopIpc.handle`/`handleSync` pass
      the sender through (`DesktopIpc.ts:96`,`:129`); audit every
      `currentMainOrFirst` / `focusedMainOrFirst` call site and classify as
      sender-scoped or global. Convert the `sendAll` broadcasts for preview and
      update state to targeted sends. Ships safely with one window; no behavior
      change, so it can land independently.
- [ ] **Phase 1 — window registry.** `ElectronWindow` gains a keyed registry
      replacing `mainWindowRef` + the `getAllWindows()[0]` fallback (which also
      retires the `withoutSplash` workaround). `DesktopWindow` contract goes
      window-keyed. Move `flushMainWindowBounds` out of module scope; key bounds by
      window id. Fix `DesktopSshPasswordPrompts.ts:286` to target the originating
      window. Preview stays pinned to one window.
- [ ] **Phase 2 — lifecycle.** Close-one-window semantics, `window-all-closed`
      policy, `second-instance` policy, macOS `activate`. Land together with
      `plans/ctrl-w-should-not-quit-app.md`.
- [ ] **Phase 3 — renderer state isolation.** `BroadcastChannel` sync for shared
      stores; audit which stores are per-window. Fixes the clobbering bug class.
- [ ] **Phase 4 — workspaces.** Data model, persistence, sidebar filter at
      `buildSidebarProjectSnapshots`, `?workspace=<id>` in the desktop URL, menu
      items, window titles.
- [ ] **Phase 5 (optional) — per-window preview.** The ~3,700-line
      `preview/Manager.ts` refactor. Only if pinning proves annoying.

## Open questions for the user

1. **Where do workspace definitions live** — desktop settings (simple, desktop-only)
   or server state (syncs to web/mobile, more work)?
   _Recommendation: server state._ Project grouping is a user-level concept, and the
   web/mobile clients would benefit from the same grouping as a filter.
2. **Can a project appear in more than one window?** Overlapping sets are more
   flexible; strict partition is easier to reason about and to build a "move
   project to window" UI for.
   _Recommendation: allow overlap_, treat the group as a filter/view, not ownership.
3. **Is per-window preview required for v1**, or is pinning preview to one window
   acceptable? This single answer is worth roughly a third of total scope.
   _Recommendation: pin for v1._
4. **Scope check** — is the desire really "N windows" or would "one window, better
   project grouping/collapsing" solve the actual pain more cheaply? The virtual-desktop
   segregation requirement suggests genuinely N windows, but worth confirming.

## Things not to do

- Do not try to run a **second Electron process** per window. The single-instance
  lock is held by the Clerk SDK bridge for OAuth deep-link forwarding
  (`DesktopClerk.ts:133`); a second process quits itself immediately. One process,
  N windows.
- Do not refactor `preview/Manager.ts` for per-window support before Phases 0–4 are
  done. It is the largest cost and the least of the value.
- Do not assume `localStorage` is per-window. It is shared across same-origin
  windows and will clobber silently.
- Do not reach for `IVirtualDesktopManagerInternal` for desktop
  enumeration/creation — undocumented and breaks between Windows builds.

## Progress log

- [x] Architecture survey of desktop window layer, IPC, renderer state, and the
      sidebar project model. (2026-08-11)
- [ ] User decisions on the four open questions above.
- [ ] Phase 0.
