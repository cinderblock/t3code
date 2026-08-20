# Preview: open external links in the system browser

## Goal

When a link inside the integrated browser (the "preview" panel) navigates **away from
the origin the tab is currently on**, hand it to the system browser via
`shell.openExternal` instead of loading it inside the panel.

Expose the behavior two ways (both were explicitly requested):

1. A **global preference** in Settings — discoverable and searchable.
2. A **per-tab override** in the preview three-dot menu, which can also fall back to
   "use the global default".

## Environment / context

- Repo: `C:\Users\camer\git\t3code`, branch `master`. Electron + React + Effect.
- Package manager: `pnpm` (not bun — this repo has `pnpm-workspace.yaml` and
  `pnpm-lock.yaml`, so the global "JS projects use Bun" rule does not apply here).
- The preview is an Electron `<webview>` tag rendered by the **renderer**, whose guest
  `WebContents` is driven from the **main process** by `PreviewManager`.
  It is not a `BrowserView`/`WebContentsView` and not an iframe.

## Decisions already made (don't re-ask)

- **Policy: "leaving the origin → system browser."** A navigation whose origin differs
  from the tab's current origin goes external. Same-origin clicks (and in-site OAuth
  hops) stay in-panel. Chosen over "only `target=_blank`" and over
  "anything non-localhost".
- **Both surfaces**: global setting _and_ per-tab three-dot override. The per-tab
  control has three states: `Use default` / `Open in preview` / `Open in system browser`.
- **Default value: enabled** (`system-browser`). This is the behavior that was asked
  for, so it ships as the default rather than opt-in.
- **Out of scope for this change**: a right-click context menu on the preview guest
  offering "Open Link in System Browser". It needs a main-process `context-menu`
  handler on the guest `WebContents`, which does not exist at all today. Noted as a
  follow-up.

## Findings so far (from code exploration)

### What happens today

`apps/desktop/src/preview/Manager.ts:1400-1418` is the only place listeners are attached
to the guest `WebContents`:

- **There is no `will-navigate` listener on the guest.** Ordinary link clicks to any
  external origin navigate freely inside the panel.
- `setWindowOpenHandler` (`Manager.ts:1409-1416`) denies the popup and then
  **`wc.loadURL(url)` in the same webview** — so `target="_blank"` also stays in-app,
  with no origin check.
- `did-navigate` / `did-navigate-in-page` only mirror state back to the renderer; they
  do not gate navigation.

### The asymmetry to fix

The **main app window** already implements exactly the desired policy —
`apps/desktop/src/window/DesktopWindow.ts:510-530` — using
`isSameOriginRendererNavigation` (`DesktopWindow.ts:172-181`) plus
`ElectronShell.parseSafeExternalUrl`. It was simply never applied to the preview
webview.

### Existing external-open plumbing (reuse, don't rebuild)

- `apps/desktop/src/electron/ElectronShell.ts:8-47` — `SAFE_EXTERNAL_PROTOCOLS`
  (`http:`/`https:` only), `parseSafeExternalUrl`, `openExternal`.
- IPC `openExternal` already exists: `apps/desktop/src/ipc/methods/window.ts:254-261`
  → `preload.ts:107` → `packages/contracts/src/ipc.ts:1050`.

### Existing UI affordance (the thing the user hadn't found)

`apps/web/src/components/preview/PreviewChromeRow.tsx:205-227` — an `ExternalLink` icon
button in the address bar, `aria-label="Open in system browser"`. It is **hover-only**
(`opacity-0 … group-hover/address:opacity-100`) and opens the _current_ page, not a
clicked link. There is no setting anywhere: `packages/contracts/src/settings.ts` has
zero external-link keys, and the settings UI has no such control.

### Wiring template to follow

`setColorScheme` is the closest analogue for a per-tab, renderer-pushed preview
control. Full path:

`packages/contracts/src/ipc.ts:948` (input schema) → `apps/desktop/src/ipc/channels.ts:53`
→ `apps/desktop/src/ipc/methods/preview.ts:142-150` → `apps/desktop/src/preload.ts:163`
→ `packages/contracts/src/ipc.ts:1084` (bridge type) → `Manager.ts:1988` (impl),
`Manager.ts:3312`/`3605`/`3705` (service registration).

Client-settings template: `confirmThreadArchive` —
`packages/contracts/src/settings.ts:115` (`ClientSettingsSchema`) and `:758`
(`ClientSettingsPatch`), surfaced in
`apps/web/src/components/settings/SettingsPanels.tsx:2157-2172`.

## Plan / steps

1. **Contracts — settings.** Add `PreviewExternalLinkBehavior` literal
   (`"in-app" | "system-browser"`) + default, a `previewExternalLinkBehavior` key on
   `ClientSettingsSchema`, and the matching `ClientSettingsPatch` optional key.
2. **Contracts — IPC.** Add a per-tab input schema + bridge method type for pushing the
   _effective_ behavior down to the main process.
3. **Desktop main.** New channel, IPC method, and `PreviewManager` operation storing
   per-tab behavior; then enforce it in `will-navigate` and `setWindowOpenHandler`.
4. **Preload.** Expose the new bridge method.
5. **Renderer.** Per-tab override state; `PreviewView` resolves
   `override ?? globalSetting` and pushes it to main; `PreviewMoreMenu` gets an
   "External links" submenu.
6. **Settings UI.** Add the global control (+ search entry).
7. **Tests.** Extend `apps/desktop/src/preview/Manager.test.ts` for the navigation
   policy; add a pure unit test for the origin comparison.
8. **Checks.** Typecheck / lint / test, then commit.

**All steps complete.** Landed in commit `4d5195a1b`.

## Gotchas identified so far

- `will-navigate` does **not** fire for `webContents.loadURL()`. That is what we want:
  address-bar submits (`PreviewView.tsx:176-188`) and agent-driven navigations
  (`Manager.navigate`, `Manager.ts:1689-1743`) must never be bounced to the system
  browser. Only page/user-initiated navigation is subject to the policy.
- `will-navigate` does **not** fire for HTTP 3xx redirects (`will-redirect` does). So an
  OAuth flow that _redirects_ cross-origin stays in-panel, but the initial _click_ to
  the provider would go external. This is an accepted consequence of the chosen policy.
- **Guard the empty/`about:blank` case.** A fresh tab's `wc.getURL()` is `""` or
  `about:blank`; naively comparing origins would send the _first_ navigation to the
  system browser. If the current URL is not `http(s)`, always allow in-app.
- Only apply to main-frame navigations — an iframe going cross-origin must not open a
  browser window.
- `parseSafeExternalUrl` already restricts to `http:`/`https:`, so `mailto:` and custom
  schemes are not opened by this path. Keep that guarantee.

## Things not to do

- Don't have the main process read the client-settings file per navigation.
  `DesktopClientSettings` (`apps/desktop/src/settings/DesktopClientSettings.ts`) is a
  get/set persistence backend with **no change notification** — the renderer is the
  component that knows the setting reactively, so the renderer pushes the resolved
  policy down. Same shape as `setColorScheme`.
- Don't add `title=` attributes for any new UI (global rule).
- Don't gate the policy on loopback-vs-public (`isPreviewableUrl` in
  `packages/shared/src/preview.ts:40`) — that is the rejected "anything non-localhost"
  option.

## What landed

| Concern                                               | File                                                                       |
| ----------------------------------------------------- | -------------------------------------------------------------------------- |
| The decision, pure and testable                       | `apps/desktop/src/preview/ExternalLinkPolicy.ts` (+ `.test.ts`, 10 cases)  |
| Enforcement (`will-navigate`, `setWindowOpenHandler`) | `apps/desktop/src/preview/Manager.ts`                                      |
| Per-tab value + `setExternalLinkBehavior` op          | `apps/desktop/src/preview/Manager.ts`                                      |
| IPC channel / method / preload                        | `apps/desktop/src/ipc/channels.ts`, `ipc/methods/preview.ts`, `preload.ts` |
| Setting + IPC schemas                                 | `packages/contracts/src/settings.ts`, `packages/contracts/src/ipc.ts`      |
| Per-tab override store                                | `apps/web/src/browser/previewExternalLinkOverrides.ts`                     |
| Override retired on tab close                         | `apps/web/src/browser/desktopTabLifetime.ts`                               |
| Resolve global vs override, push to main              | `apps/web/src/components/preview/PreviewView.tsx`                          |
| "External links" submenu                              | `apps/web/src/components/preview/PreviewMoreMenu.tsx`                      |
| Global setting row + search entry                     | `apps/web/src/components/settings/SettingsPanels.tsx`, `settingsSearch.ts` |

## Notes from implementation

- `will-navigate` is main-frame-only in Electron 41 and carries a `details` object
  (`url`, `isMainFrame`); the positional `(event, url, isInPlace, isMainFrame, …)` args
  are deprecated. Used `details`, still guarded on `isMainFrame`.
- Enforcement reads a **plain `Map`**, not a `Ref`. `will-navigate` must call
  `preventDefault()` synchronously inside the listener; there is no opportunity to run
  an Effect first. (Note `forwardShortcut` nearby _does_ `preventDefault()` after a
  `yield* Ref.get` — that only works because `runFork` runs a fully-synchronous fiber to
  completion before returning. Fragile; not copied here.)
- New tests use `vite-plus/test`, not `vitest` — importing `vitest` directly fails
  typecheck in this repo.
- Adding `useClientSettings` to `PreviewView` pulled `~/state/server` into
  `PreviewView.test.tsx`, whose `~/state/session` mock exposes only
  `readPreparedConnection`. Fixed by mocking `~/hooks/useSettings` in that suite.

## Verification

- `pnpm typecheck` — clean across the monorepo.
- `pnpm lint` — clean (3 pre-existing warnings in untouched files).
- `@t3tools/web` tests — 238 files / 2254 tests pass.
- `@t3tools/contracts` tests — 18 files / 241 tests pass.
- `@t3tools/desktop` `Manager.test.ts` + `ExternalLinkPolicy.test.ts` — 52 tests pass.
- `@t3tools/desktop` full suite — 18 failed / 446 passed (464). Neither preview test
  file appears in the failure list. The count moved from a pre-change baseline of
  17 failed / 440 passed (457): +7 tests (the new integration cases, all passing) and
  one _additional_ failure, `DesktopObservability > bounds the number of retained
backend child output chunks` — which passes on its own (6/6) and is a load-related
  flake of the kind the `compute-budget` skill describes, not a regression.
- Pre-existing failures in
  `DesktopEnvironment`, `DesktopAppIdentity`, `DesktopAssets`,
  `DesktopConnectionCatalogStore`, `DesktopSavedEnvironments`,
  `DesktopBackendConfiguration` and `electron-launcher`. All are Windows `\` vs `/`
  path-separator assertions in files this change does not touch — pre-existing.
- `pnpm fmt:check` — clean for every file in this change. Four plan docs elsewhere in
  `plans/` are unformatted; they belong to other in-flight work and were left alone.

### Attempted live GUI verification — blocked by the single-instance lock

`pnpm build:desktop` succeeds, and the built `dist-electron/main.cjs` does contain the
new code (`will-navigate`, `preview-set-external-link-behavior`,
`externalNavigationTarget`).

Launching it to click a real link did **not** work, and the reason is worth recording:

```
T3CODE_HOME=/tmp/t3code-extlink-verify pnpm start:desktop   # exits 0, no window, no new process
```

The app holds Electron's single-instance lock (`apps/desktop/src/app/DesktopClerk.ts:133-136`);
a secondary instance calls `electronApp.quit` and interrupts bootstrap before
`whenReady`. **`T3CODE_HOME` does not bypass this** — it isolates state, not the lock. So
while any T3 Code is running, a second launch just fires `second-instance` on the
primary (which reveals its window) and exits.

Consequence: a live click-through requires quitting the running T3 Code first. That was
not done here because the user's own session was live in it.

**So: not verified by clicking a link in a running app.** What _is_ verified is the
listener wiring, via `Manager.test.ts` -> "external links", which installs the real
manager against a fake guest `WebContents` and invokes the handlers the manager
registered. That covers cross-origin -> `openExternal` + `preventDefault`, same-origin
passthrough, subframe passthrough, the per-tab override, both window-open branches, and
the unknown-tab error. The remaining unknown is Electron itself behaving as documented.

## Progress log

- [x] Investigated current behavior; confirmed no `will-navigate` on the guest and that
      `setWindowOpenHandler` re-loads in-panel.
- [x] Confirmed no existing setting of any kind for external-link behavior.
- [x] Confirmed the hover-only address-bar button is the only current escape hatch.
- [x] Chose policy + both setting surfaces with the user.
- [x] Steps 1-8: contracts, IPC, main-process enforcement, preload, renderer, settings
      UI, tests, checks. Committed as `4d5195a1b`.

## How to finish verifying (30 seconds, needs T3 Code closed)

1. Quit every running T3 Code (the single-instance lock above).
2. `pnpm build:desktop && pnpm start:desktop`
3. Open a preview on any page with an off-site link — the thread's preview panel,
   address bar → `example.com`, then click "More information..." (which points at
   `iana.org`).
4. Expected: the system browser opens `iana.org` and the panel **stays** on
   `example.com`. Then ⋮ → External links → "Open in preview" and click again — it
   should now navigate in-panel.

## Possible follow-ups

- A `context-menu` handler on the preview guest, giving a per-link "Open Link in System
  Browser" / "Copy Link Address". Nothing registers `context-menu` on the guest today —
  `DesktopWindow.ts:462-508` covers the React renderer only.
- The address-bar "Open in system browser" button is still hover-only
  (`PreviewChromeRow.tsx`), so it is invisible on a touch screen. Worth promoting into
  the three-dot menu.

## Open questions for the user

None outstanding.
