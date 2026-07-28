import { useAtomValue } from "@effect/atom-react";
import { ChevronDownIcon } from "lucide-react";
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
  unavailableLabel,
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
  const snapshot = account.snapshot;

  // No snapshot yet — say so instead of rendering nothing, which looks
  // identical to the feature being broken.
  if (snapshot === null) {
    return (
      <span className="flex min-w-0 flex-1 items-center gap-2 text-[10px] text-muted-foreground/70">
        <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-muted-foreground/50" />
        <span className="truncate">{unavailableLabel(account)}</span>
      </span>
    );
  }

  const windows = sortWindowsForDisplay(snapshot.windows);
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
          {account.accountKey}
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
    // The surrounding bubble supplies the surface and the scroll bounds; this
    // is just the content.
    <div>
      <div className="flex flex-col gap-4">
        {accounts.map((account) => {
          const snapshot = account.snapshot;
          if (snapshot === null) {
            return (
              <div key={account.accountKey} className="text-[11px] text-muted-foreground">
                {unavailableLabel(account)}
              </div>
            );
          }
          const windows = sortWindowsForDisplay(snapshot.windows);
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
            <div key={account.accountKey} className="flex flex-col gap-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium text-foreground/90 text-xs">
                  Claude usage
                  {snapshot.planLabel ? ` · ${snapshot.planLabel}` : ""}
                  {accounts.length > 1 ? ` · ${account.accountKey}` : ""}
                </span>
                <span className="text-[10px] text-muted-foreground">
                  {account.unavailableReason !== null
                    ? `stale (${account.unavailableReason})`
                    : `updated ${new Date(snapshot.capturedAt).toLocaleTimeString()}`}
                  {pendingCount > 0
                    ? ` · ${pendingCount} queued message${pendingCount === 1 ? "" : "s"}`
                    : ""}
                </span>
              </div>
              {sessionWindows.length > 0 ? (
                <UsageHistoryChart
                  environmentId={environmentId}
                  accountKey={account.accountKey}
                  windows={sessionWindows}
                  title={`5-hour window${sessionEta ? ` · ${sessionEta}` : ""}`}
                />
              ) : null}
              {weeklyWindows.length > 0 ? (
                <UsageHistoryChart
                  environmentId={environmentId}
                  accountKey={account.accountKey}
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
    // Rendered inside the composer's column, which already supplies the
    // horizontal inset; matching its max-width keeps the bubble exactly as
    // wide as the input box.
    <div className="w-full shrink-0 pt-1.5">
      <div className="mx-auto w-full max-w-3xl">
        {/*
         * One bubble anchored at the bottom of the composer stack. Expanding
         * grows it upward: the charts row animates from 0fr to 1fr while the
         * meter row animates to 0fr, so the collapsed bars give way to the
         * charts instead of both being on screen at once.
         */}
        <div className="alert-glass overflow-hidden rounded-2xl border border-border/60 shadow-sm">
          <div
            className={cn(
              "grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none",
              expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
            )}
          >
            <div className="min-h-0 overflow-hidden">
              <div className="flex items-center justify-between gap-2 px-3 pt-2">
                <span className="font-medium text-foreground/80 text-xs">Claude usage</span>
                <button
                  type="button"
                  onClick={() => setExpanded(false)}
                  aria-label="Collapse usage details"
                  className={cn(
                    "flex size-5 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none",
                    "hover:bg-accent/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                  )}
                >
                  <ChevronDownIcon className="size-3.5" />
                </button>
              </div>
              <div className="max-h-[45dvh] overflow-y-auto px-3 pt-1 pb-2.5">
                <ExpandedPanel accounts={accounts} nowMs={nowMs} />
              </div>
            </div>
          </div>

          <div
            className={cn(
              "grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none",
              expanded ? "grid-rows-[0fr]" : "grid-rows-[1fr]",
            )}
          >
            <div className="min-h-0 overflow-hidden">
              <button
                type="button"
                onClick={() => setExpanded(true)}
                aria-expanded={expanded}
                aria-label="Expand usage details"
                tabIndex={expanded ? -1 : undefined}
                className={cn(
                  "flex w-full cursor-pointer items-center gap-4 px-3 py-1.5 text-left outline-none",
                  "hover:bg-accent/30 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                )}
                style={{ height: USAGE_STATUS_BAR_HEIGHT_PX + 12 }}
              >
                {accounts.map((account) => (
                  <AccountMeters
                    key={account.accountKey}
                    account={account}
                    nowMs={nowMs}
                    showAccountLabel={accounts.length > 1}
                  />
                ))}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
