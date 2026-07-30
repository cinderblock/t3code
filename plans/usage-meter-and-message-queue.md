# Usage Meter & Message Queue for T3 Code

## Goal

Add Claude API usage metering and a message scheduling system to T3 Code's UI, inspired by the claude-usage project. Users should see real-time usage bars (5-hr and weekly separate) and be able to queue messages with smart triggers (time-based, usage-based, or reset events).

## Environment / Context

- T3 Code: Electron desktop app, TypeScript/React frontend in `apps/desktop/src/`
- Design reference: `C:\Users\camer\git\claude-usage` — Svelte/Tauri app with:
  - Horizontal usage bars with 0–100% scale
  - Crisp SVG charts (multi-series, projections, pace tracking)
  - Per-model vs. "All models" visualization logic
  - Alert states (ok/warn/crit)
- Scope: Claude models only initially (Fable, Opus, Sonnet, Haiku)
- Architecture requirement: Extensible for future plans/subscriptions

## Decisions Already Made (Don't Re-Ask)

1. **Single bar across bottom** with ticks/segments for 0–100% progress (not a complex chart initially)
2. **5-hr and weekly separate** — two bars or a toggle
3. **Click to expand** into a chart view (modal or dropdown)
4. **Model-specific prominence**: when Fable is selected, show Fable bar prominently; otherwise show "All models"
5. **Queue system**: automatic conversion to queued message when usage cap hit
6. **Trigger types**: time-based (at 3am, on reset), usage-based (>20% remaining), event-based (5h/weekly window ends)
7. **Prioritize styling** over doc generation — keep claude-usage color/layout logic

## Plan / Steps

### Phase 1: Data Layer & Backend Integration

- [ ] Add types for usage/projection data (mirror claude-usage schema or fetch from Anthropic API)
- [ ] Create usage service to poll Claude API for current usage (5-hr, weekly windows)
- [ ] Store usage history locally (SQLite or JSON) for trending
- [ ] Calculate projections and alert states (ok/warn/crit)

### Phase 2: UI Components (Bottom Bar)

- [ ] Build `UsageBar.tsx` — compact horizontal bar with:
  - Current % as filled segment
  - Ticks at 0%, 25%, 50%, 75%, 100%
  - Color coding (green ok, amber warn, red crit)
  - Toggle between 5-hr and weekly
  - Click to open expanded view
- [ ] Integrate into main window footer
- [ ] Add styling (reuse claude-usage palette; adapt for React/CSS-in-JS)

### Phase 3: Expanded Chart View

- [ ] Build `UsageChart.tsx` (React port of claude-usage SVG chart)
  - Multi-series (per-model + all-models)
  - Projections (dashed line)
  - Pace reference line
  - "Now" indicator
  - Responsive width
- [ ] Modal or panel to display on bar click
- [ ] Allow switching between 5-hr/weekly/monthly

### Phase 4: Message Queue System

- [ ] Design queue schema (trigger type, condition, scheduled message, status)
- [ ] Add queue storage (SQLite table or JSON file)
- [ ] Build trigger types:
  - `TimeOfDay` (send at 3am)
  - `EventReset` (send when 5h/weekly window resets)
  - `UsageThreshold` (send when usage > threshold %)
- [ ] Automatic conversion UI: when cap hit, prompt user to queue message
- [ ] Background daemon to check triggers periodically

### Phase 5: Queue UI

- [ ] Build `QueuePanel.tsx` — list queued messages with:
  - Trigger description ("send when 5h window finishes")
  - Scheduled message preview
  - Edit trigger / delete / test
  - Status (pending, sent, failed)
- [ ] Add to sidebar or modal
- [ ] Keyboard shortcut to open queue

### Phase 6: Polish & Testing

- [ ] Handle offline/missing API key gracefully
- [ ] Test across model selection transitions
- [ ] Edge cases: cap hit mid-typing, queue fire while drafting

## Findings / Gotchas

(Will update as work progresses)

## Progress Log

- [ ] Audit current T3 Code architecture (data flow, backend integration, styling)
- [ ] Define usage data types & API contract
- [ ] Implement usage service
- [ ] Build UsageBar component
- [ ] Build expanded chart view
- [ ] Implement queue schema & storage
- [ ] Implement trigger engine
- [ ] Build QueuePanel UI
- [ ] Integration & testing

## Open Questions for the User

1. **Polling frequency?** How often should we fetch usage from the Anthropic API? (Every 30s? On-demand? Websocket if available?)
2. **Chart in modal or sidebar?** Should the expanded chart be a separate modal/popup or a collapsible sidebar panel?
3. **Queue UI placement?** Separate tab in sidebar, modal, or inline with the usage bar?
4. **Estimated vs. actual usage?** Should we show client-side usage estimates (tokens sent) vs. server-side actuals? Both?

## Things Not to Do

- Don't rebuild the full claude-usage app; cherry-pick components/logic
- Don't hardcode model names; use config/enum
- Don't rely on websockets initially; polling is simpler and sufficient
- Don't add undo/redo to queue edits — simple edit-and-delete is fine
- Don't persist queue across app restarts yet (nice-to-have for v2)
