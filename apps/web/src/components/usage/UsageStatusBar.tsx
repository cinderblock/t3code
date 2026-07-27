import { useAtomValue } from "@effect/atom-react";
import { useEffect, useState } from "react";
import type { AccountUsageState } from "@t3tools/client-runtime/state/usage";
import type { UsageWindow } from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import { useComposerDraftStore } from "../../composerDraftStore";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { primaryAccountUsageAtom, primaryQueuedMessagesAtom } from "../../state/usage";
import { UsageHistoryChart } from "./UsageHistoryChart";
import {
  emphasizedWeeklyWindowId,
  formatPercent,
  formatResetEta,
  selectedModelSlugForAccount,
  severityMeterClass,
  sortWindowsForDisplay,
  windowLongLabel,
  windowShortLabel,
} from "./usagePresentation";

/** Height of the meter strip itself (the expanded panel stacks above it). */
const USAGE_STATUS_BAR_HEIGHT_PX = 24;

function WindowMeter(props: { window: UsageWindow; emphasized: boolean; nowMs: number }) {
  const { window, emphasized, nowMs } = props;
  const percent = Math.max(0, Math.min(100, window.percent));
  const resetEta = formatResetEta(window.resetsAt, nowMs);
  return (
    <span
      className={cn(
        // Meters split the row proportionally so each track gets as much
        // resolution as the width allows; the emphasized window takes a
        // double share.
        "flex min-w-0 items-center gap-1.5",
        emphasized ? "flex-[2] opacity-100" : "flex-1 opacity-65",
      )}
    >
      <span
        className={cn(
          "whitespace-nowrap text-[10px] leading-none",
          emphasized ? "font-medium text-foreground/80" : "text-muted-foreground",
        )}
      >
        {windowShortLabel(window)}
      </span>
      <span
        // The track has to read as the full 0–100% domain, otherwise on dark
        // backgrounds the unfilled remainder disappears and you can't tell
        // where one meter ends and the next begins. A solid track plus an
        // inset ring gives it a definite end.
        className="relative h-2 min-w-6 flex-1 overflow-hidden rounded-full bg-foreground/10 ring-1 ring-border ring-inset dark:bg-foreground/20"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
        aria-label={`${windowLongLabel(window)}: ${formatPercent(window.percent)} used${resetEta ? `, ${resetEta}` : ""}`}
      >
        <span
          className={cn(
            "absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none",
            severityMeterClass(window),
          )}
          style={{ width: `${percent}%` }}
        />
        {/* Quartile ticks, drawn over the fill so they stay legible. */}
        {[25, 50, 75].map((tick) => (
          <span
            key={tick}
            className="absolute inset-y-0 w-px bg-background/60"
            style={{ left: `${tick}%` }}
          />
        ))}
      </span>
      <span
        className={cn(
          "whitespace-nowrap text-[10px] tabular-nums leading-none",
          emphasized ? "font-medium text-foreground/80" : "text-muted-foreground",
        )}
      >
        {formatPercent(window.percent)}
      </span>
    </span>
  );
}

function AccountMeters(props: {
  account: AccountUsageState;
  nowMs: number;
  showAccountLabel: boolean;
}) {
  const { account, nowMs, showAccountLabel } = props;
  const stickySelections = useComposerDraftStore((state) => state.stickyModelSelectionByProvider);
  const selectedModel = selectedModelSlugForAccount(account, stickySelections);
  const windows = sortWindowsForDisplay(account.snapshot.windows);
  const emphasizedWeeklyId = emphasizedWeeklyWindowId(windows, selectedModel);

  return (
    <span
      className={cn(
        "flex min-w-0 flex-1 items-center gap-3",
        account.unavailableReason !== null && "opacity-50",
      )}
    >
      {showAccountLabel ? (
        <span className="max-w-32 truncate text-[10px] text-muted-foreground/70">
          {account.snapshot.accountKey}
        </span>
      ) : null}
      {windows.map((window) => (
        <WindowMeter
          key={window.id}
          window={window}
          emphasized={window.kind === "session" || window.id === emphasizedWeeklyId}
          nowMs={nowMs}
        />
      ))}
      {account.unavailableReason !== null ? (
        <span className="whitespace-nowrap text-[10px] text-muted-foreground">
          {account.unavailableReason === "no-credentials" ? "no Claude login" : "usage stale"}
        </span>
      ) : null}
    </span>
  );
}

function ExpandedPanel(props: { accounts: ReadonlyArray<AccountUsageState>; nowMs: number }) {
  const { accounts, nowMs } = props;
  const environmentId = useAtomValue(primaryEnvironmentIdAtom);
  const queuedMessages = useAtomValue(primaryQueuedMessagesAtom);
  const pendingCount = queuedMessages.filter((message) => message.status === "pending").length;
  if (environmentId === null) return null;

  return (
    <div className="max-h-[45dvh] overflow-y-auto rounded-xl border border-border bg-popover px-3 py-2.5">
      <div className="flex flex-col gap-4">
        {accounts.map((account) => {
          const windows = sortWindowsForDisplay(account.snapshot.windows);
          const sessionWindows = windows.filter((window) => window.kind === "session");
          const weeklyWindows = windows.filter((window) => window.kind === "weekly");
          const monthlyWindow = windows.find((window) => window.kind === "monthly");
          const sessionEta = formatResetEta(sessionWindows[0]?.resetsAt ?? null, nowMs);
          const weeklyEta = formatResetEta(
            weeklyWindows.find((window) => window.scope.kind === "all")?.resetsAt ??
              weeklyWindows[0]?.resetsAt ??
              null,
            nowMs,
          );
          const spend = monthlyWindow?.dollars;
          return (
            <div key={account.snapshot.accountKey} className="flex flex-col gap-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium text-foreground/90 text-xs">
                  Claude usage
                  {account.snapshot.planLabel ? ` · ${account.snapshot.planLabel}` : ""}
                  {accounts.length > 1 ? ` · ${account.snapshot.accountKey}` : ""}
                </span>
                <span className="text-[10px] text-muted-foreground">
                  {account.unavailableReason !== null
                    ? `stale (${account.unavailableReason})`
                    : `updated ${new Date(account.snapshot.capturedAt).toLocaleTimeString()}`}
                  {pendingCount > 0
                    ? ` · ${pendingCount} queued message${pendingCount === 1 ? "" : "s"}`
                    : ""}
                </span>
              </div>
              {sessionWindows.length > 0 ? (
                <UsageHistoryChart
                  environmentId={environmentId}
                  accountKey={account.snapshot.accountKey}
                  windows={sessionWindows}
                  title={`5-hour window${sessionEta ? ` · ${sessionEta}` : ""}`}
                />
              ) : null}
              {weeklyWindows.length > 0 ? (
                <UsageHistoryChart
                  environmentId={environmentId}
                  accountKey={account.snapshot.accountKey}
                  windows={weeklyWindows}
                  title={`Weekly windows${weeklyEta ? ` · ${weeklyEta}` : ""}`}
                />
              ) : null}
              {spend !== undefined ? (
                <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                  <span>Extra usage this month</span>
                  <span className="tabular-nums">
                    {spend.currency === "USD" ? "$" : `${spend.currency} `}
                    {spend.used.toFixed(2)} / {spend.currency === "USD" ? "$" : ""}
                    {spend.limit.toFixed(2)}
                  </span>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * App-wide usage meter strip pinned to the bottom of the window. Shows one
 * cluster of meters per Claude account; click expands the history charts.
 */
export function UsageStatusBar() {
  const accounts = useAtomValue(primaryAccountUsageAtom);
  const [expanded, setExpanded] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Keep reset countdowns fresh while visible.
  useEffect(() => {
    const interval = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(interval);
  }, []);

  if (accounts.length === 0) {
    return null;
  }

  return (
    // Same horizontal inset + max-width as the composer, so the meters line
    // up with the input box no matter how wide the window gets.
    <div className="chat-composer-horizontal-inset w-full shrink-0 pb-1">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-1">
        {expanded ? <ExpandedPanel accounts={accounts} nowMs={nowMs} /> : null}
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          aria-label={expanded ? "Collapse usage details" : "Expand usage details"}
          className={cn(
            "flex w-full cursor-pointer items-center gap-4 rounded-lg px-2 text-left outline-none",
            "hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
          )}
          style={{ height: USAGE_STATUS_BAR_HEIGHT_PX }}
        >
          {accounts.map((account) => (
            <AccountMeters
              key={account.snapshot.accountKey}
              account={account}
              nowMs={nowMs}
              showAccountLabel={accounts.length > 1}
            />
          ))}
        </button>
      </div>
    </div>
  );
}
