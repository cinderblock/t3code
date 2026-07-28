import { useAtomValue } from "@effect/atom-react";
import { ChevronDownIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
  // The bubble header carries the plan/updated line, so this renders only the
  // charts — a second "Claude usage" heading here would duplicate it. Per
  // account labels stay when there is more than one account to tell apart.
  const showAccountHeading = accounts.length > 1;
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
              {showAccountHeading ? (
                <span className="truncate font-medium text-foreground/90 text-xs">
                  {account.accountKey}
                  {snapshot.planLabel ? ` · ${snapshot.planLabel}` : ""}
                </span>
              ) : null}
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
  const queuedMessages = useAtomValue(primaryQueuedMessagesAtom);
  const [expanded, setExpanded] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const chartsInnerRef = useRef<HTMLDivElement | null>(null);
  const metersInnerRef = useRef<HTMLDivElement | null>(null);
  const [chartsHeight, setChartsHeight] = useState(0);
  const [metersHeight, setMetersHeight] = useState(0);

  // Keep reset countdowns fresh while visible.
  useEffect(() => {
    const interval = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(interval);
  }, []);

  /*
   * Each section is a clipped wrapper whose height is animated by CSS between
   * 0 and its content's natural height. The content always lays out at full
   * size inside the wrapper, so it can be measured whether the section is
   * open or closed; the observer keeps the target honest as charts load.
   *
   * `accounts.length` is a dependency because the bubble renders nothing
   * until usage data arrives — without it the refs can still be null when
   * this first runs and the heights would stay 0 forever.
   */
  useEffect(() => {
    const chartsInner = chartsInnerRef.current;
    const metersInner = metersInnerRef.current;
    if (!chartsInner || !metersInner) return;
    const measure = () => {
      setChartsHeight(chartsInner.offsetHeight);
      setMetersHeight(metersInner.offsetHeight);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(chartsInner);
    observer.observe(metersInner);
    return () => observer.disconnect();
  }, [accounts.length]);

  if (accounts.length === 0) {
    return null;
  }

  const headlineAccount = accounts.find((account) => account.snapshot !== null) ?? accounts[0]!;
  const headlineSnapshot = headlineAccount.snapshot;
  const headline = [
    "Claude usage",
    headlineSnapshot?.planLabel ?? null,
    accounts.length > 1 ? `${accounts.length} accounts` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
  const pendingQueuedCount = queuedMessages.filter(
    (message) => message.status === "pending",
  ).length;
  const headlineStatus = [
    headlineAccount.unavailableReason !== null
      ? `stale (${headlineAccount.unavailableReason})`
      : headlineSnapshot !== null
        ? `updated ${new Date(headlineSnapshot.capturedAt).toLocaleTimeString()}`
        : null,
    pendingQueuedCount > 0
      ? `${pendingQueuedCount} queued message${pendingQueuedCount === 1 ? "" : "s"}`
      : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");

  return (
    // Rendered inside the composer's column, which already supplies the
    // horizontal inset; matching its max-width keeps the bubble exactly as
    // wide as the input box.
    // Negative top margin trims the composer's safe-area spacer above, which
    // otherwise leaves a wide gap between the input and this bubble.
    <div className="-mt-2 w-full shrink-0">
      <div className="mx-auto w-full max-w-3xl">
        {/*
         * One bubble sitting flush against the bottom edge of the window, so
         * only the top corners are rounded. Expanding grows it upward: the
         * chart section animates from 0 to its measured height while the
         * meter row animates to 0, so the bars give way to the charts.
         */}
        <div
          data-usage-bubble="true"
          className="alert-glass overflow-hidden rounded-t-2xl border border-b-0 border-border/60 shadow-sm"
        >
          <div
            data-usage-charts-wrap="true"
            className="overflow-hidden transition-[height] duration-300 ease-out motion-reduce:transition-none"
            style={{ height: expanded ? chartsHeight : 0 }}
            aria-hidden={!expanded}
          >
            <div ref={chartsInnerRef}>
              <div className="flex items-center justify-between gap-2 px-3 pt-2">
                <span className="min-w-0 truncate font-medium text-foreground/80 text-xs">
                  {headline}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  {headlineStatus.length > 0 ? (
                    <span className="text-[10px] text-muted-foreground">{headlineStatus}</span>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => setExpanded(false)}
                    aria-label="Collapse usage details"
                    tabIndex={expanded ? undefined : -1}
                    className={cn(
                      "flex size-5 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none",
                      "hover:bg-accent/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                    )}
                  >
                    <ChevronDownIcon className="size-3.5" />
                  </button>
                </span>
              </div>
              <div className="max-h-[45dvh] overflow-y-auto px-3 pt-1 pb-2.5">
                <ExpandedPanel accounts={accounts} nowMs={nowMs} />
              </div>
            </div>
          </div>

          <div
            className="overflow-hidden transition-[height] duration-300 ease-out motion-reduce:transition-none"
            style={{ height: expanded ? 0 : metersHeight }}
            aria-hidden={expanded}
          >
            <div ref={metersInnerRef}>
              <button
                type="button"
                onClick={() => setExpanded(true)}
                data-usage-toggle="true"
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
