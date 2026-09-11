# Sidebar host filter (show/hide threads per environment)

## Goal

Below the **All projects** scope combobox in the web sidebar, add a row of
toggle buttons: **All** plus one per connected environment (host). Each host
toggle shows/hides that host's threads. The row must make hidden work obvious,
with a count of hidden threads, so a filter can never produce a silent
"where did my projects go" empty list.

## Environment / context

- Repo: `C:\Users\camer\git\t3code` (fork of pingdotgg/t3code), branch `master`.
- Web sidebar: `apps/web/src/components/Sidebar.tsx` (~4900 lines). Pure
  helpers live in `apps/web/src/components/Sidebar.logic.ts` with tests in
  `Sidebar.logic.test.ts`.
- Persisted sidebar UI prefs: `apps/web/src/uiStateStore.ts` (zustand +
  localStorage key `t3code:ui-state:v1`), tests in `uiStateStore.test.ts`.
- Environments: `useEnvironments()` in `apps/web/src/state/environments.ts`
  yields `{ environmentId, label, serverConfig, ... }`. Machine icon via
  `EnvironmentMachineIcon` + `resolveEnvironmentMachineKind(serverConfig)`.
- The sidebar list is a flat thread list (pinned/active/snoozed/settled),
  filtered by `scopedProjectKeys` (project scope). Search operates on the
  already-partitioned list, so it inherits any list filter.
- Mobile already has a single-select "Environment" filter in its home menu
  (`apps/mobile/src/features/home/home-list-filter-menu.ts`). Not touched.

## Decisions already made (don't re-ask)

- **Hide-list, not show-list.** Persist `sidebarHiddenEnvironmentIds`. New
  hosts appear by default; **All** clears the list.
- **Multi-toggle semantics.** Each host button toggles that host. **All** is
  a reset that is "pressed" when nothing is hidden.
- **Solo mode** (requested as a follow-up): Alt-click a host to show only it;
  Alt-click the soloed host again to restore all. Right-click offers the same
  via a context menu (**Show only**, **Hide**/**Show**, **Show all hosts**)
  so touch and keyboard users are not locked out. Solo is expressed purely
  as the hide-list (hide every other catalog host), so no new persisted state.
- **Single-host setups show no row and hide nothing**, even if a stale hidden
  id is persisted. Effective hidden set = persisted ∩ catalog, and only when
  the catalog has 2+ environments.
- **Hiding every host is allowed.** The empty state then says how many
  threads the host filter hides and offers **Show all hosts**.
- **Counts** are non-archived threads per host within the current project
  scope, so numbers match what the list would show. Drafts are not counted.
- **Project scope combobox** only lists projects with at least one member on a
  visible host, plus the currently selected scope (so the combobox value is
  always among its items).
- **Selection clears** when the hidden set changes, mirroring the scope rule
  that bulk actions never touch invisible rows.
- Web/desktop only. Mobile keeps its own environment filter.
- No `title=` attributes (global rule). Counts are inline text.

## Plan / steps

1. [x] Explore sidebar, store, environment model, toggle components.
2. [x] Write this plan.
3. [x] `uiStateStore.ts`: `sidebarHiddenEnvironmentIds: string[]`, persisted
       and sanitized; reducers `setSidebarEnvironmentHidden` and
       `showAllSidebarEnvironments`; tests.
4. [x] `Sidebar.logic.ts`: `resolveSidebarHiddenEnvironmentIds`,
       `countSidebarThreadsByEnvironment`, `buildSidebarHostFilterEntries`; tests.
5. [x] `Sidebar.tsx`: wire state, filter list + drafts + combobox items, render
       the row, update the empty state, clear selection on change.
6. [x] `docs/user/thread-sidebar.md`: short "Filter the list" section.
7. [x] Targeted typecheck/lint/tests; committed as 255f9c6a39 on `master`.
8. [ ] Optional: one integrated pass in a real client with two environments
       connected (needs user OK for a dev server / browser).
9. [ ] Solo mode: store reducer `soloSidebarEnvironment`, `soloEnvironmentId`
       from `buildSidebarHostFilterEntries`, `buildSidebarHostContextMenuItems`,
       Alt-click + context menu wiring, docs; tests; committed on `master`.

## Findings / gotchas

- `ToggleGroup` (Base UI) with `multiple` would model the visible set, but
  **All** is an action rather than a group member. Standalone `Toggle`
  components (`variant="segmented" size="segmented"`) inside a group-styled
  div keep the semantics honest (`aria-pressed` per button).
- `uiStateStore.test.ts` has full-object `toEqual` assertions for parsed
  state; adding a field means updating those fixtures.
- Existing Settings button inside the scope combobox uses a `title=`
  attribute (upstream code). Left alone to keep the fork diff minimal.
- `vp run typecheck` in `apps/web` prints many `suggestion TS377…` lines from
  the Effect language service on untouched files; they are not errors and
  the command exits 0.
- `vp lint` on `Sidebar.tsx` reports pre-existing `react(refs)` and
  `react(set-state-in-effect)` warnings in upstream code, none in the new
  block.
- `useEnvironments().environments` changes identity on connection-state
  churn, so the effective hidden set is memoized on a joined id string to
  keep the list partition memo stable.
- The legacy sidebar (`LegacySidebar.tsx`, behind a settings flag) does not
  get the host row. It has no project scope either.

## Progress log

- [x] Research and design
- [x] Store + tests (22 pass)
- [x] Logic helpers + tests (Sidebar.logic.test.ts passes)
- [x] Sidebar UI
- [x] Docs
- [x] Final checks + commit (web typecheck exit 0, 186 tests pass, lint clean in new code)
- [x] Solo mode + tests (190 tests pass, typecheck exit 0)

## Open questions for the user

None blocking.

## Things not to do

- Don't run repo-wide checks (`vp check`, `-r typecheck`). Targeted only.
- Don't touch mobile's environment filter.
- Don't add `title=` tooltips.
