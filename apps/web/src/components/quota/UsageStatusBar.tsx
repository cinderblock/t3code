import { useAtomValue } from "@effect/atom-react";
import { ChevronDownIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type {
  EnvironmentId,
  ProviderInstanceId,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { elapsedShare, formatResetsIn } from "@t3tools/shared/usageLimits";

import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import { useComposerDraftStore } from "../../composerDraftStore";
import { ensureLocalApi } from "../../localApi";
import {
  orderUsageAccountsForSelection,
  queuedMessagesAtom,
  usageAccountsAtom,
  usageWaitingDriversAtom,
  type UsageAccountView,
} from "../../state/quota";
import { providerClients } from "../settings/providerDriverMeta";
import { Button } from "../ui/button";
import { ResetCredits } from "../usage/UsageLimits";
import { UsageHistoryChart } from "./UsageHistoryChart";
import {
  emphasizedWeeklyWindowId,
  formatPercent,
  formatUsageAge,
  oldestUsageCheckMs,
  selectedModelSlugForAccount,
  severityMeterClass,
  sortWindowsForDisplay,
  unavailableLabel,
  usageIsStale,
  windowLongLabel,
  windowScopeName,
  windowShortLabel,
} from "./usagePresentation";
import { useUsageAutoRefresh, useUsageRefreshIntervalMs } from "./useUsageAutoRefresh";

/** Height of the meter strip itself (the expanded panel stacks above it). */
const USAGE_STATUS_BAR_HEIGHT_PX = 24;
/** Countdowns and the "updated" age only need minute resolution. */
const CLOCK_TICK_MS = 30_000;

function WindowMeter(props: {
  window: ServerProviderUsageWindow;
  emphasized: boolean;
  nowMs: number;
}) {
  const { window, emphasized, nowMs } = props;
  const percent = Math.max(0, Math.min(100, window.usedPercent));
  const resetsIn = formatResetsIn(window, nowMs);
  // Where even spending would have the fill by now, as upstream's Limits bars mark it.
  const elapsed = elapsedShare(window, nowMs);
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
          "whitespace-nowrap text-3xs leading-none",
          emphasized ? "font-medium text-foreground/80" : "text-muted-foreground",
        )}
      >
        {windowShortLabel(window)}
      </span>
      <span
        className="relative h-2 min-w-6 flex-1"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
        aria-label={`${windowLongLabel(window)}: ${formatPercent(window.usedPercent)} used${resetsIn ? `, ${resetsIn}` : ""}`}
      >
        {/*
         * The track has to read as the full 0–100% domain, otherwise on dark
         * backgrounds the unfilled remainder disappears and you can't tell
         * where one meter ends and the next begins. An inset ring gives it a
         * definite end in every theme.
         */}
        <span className="absolute inset-0 overflow-hidden rounded-full bg-muted ring-1 ring-border ring-inset">
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
        {elapsed !== null ? (
          <span
            aria-hidden
            className="absolute -inset-y-0.5 w-px -translate-x-1/2 bg-foreground/70"
            style={{ left: `${elapsed * 100}%` }}
          />
        ) : null}
      </span>
      <span
        className={cn(
          "whitespace-nowrap text-3xs tabular-nums leading-none",
          emphasized ? "font-medium text-foreground/80" : "text-muted-foreground",
        )}
      >
        {formatPercent(window.usedPercent)}
      </span>
    </span>
  );
}

function AccountMeters(props: {
  account: UsageAccountView;
  nowMs: number;
  showAccountLabel: boolean;
}) {
  const { account, nowMs, showAccountLabel } = props;
  const stickySelections = useComposerDraftStore((state) => state.stickyModelSelectionByProvider);
  const selectedModel = selectedModelSlugForAccount(account, stickySelections);
  const notice = unavailableLabel(account.limits);

  // Say why there are no bars instead of rendering nothing, which looks
  // identical to the feature being broken.
  if (notice !== null) {
    return (
      <span className="flex min-w-0 flex-1 items-center gap-2 text-3xs text-muted-foreground/70">
        <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
        <span className="truncate">{notice}</span>
      </span>
    );
  }

  const windows = sortWindowsForDisplay(account.limits.windows);
  const emphasizedWeeklyId = emphasizedWeeklyWindowId(windows, selectedModel);

  return (
    <span className="flex min-w-0 flex-1 items-center gap-3">
      {showAccountLabel ? (
        <span className="max-w-32 truncate text-3xs text-muted-foreground/70">{account.label}</span>
      ) : null}
      {windows.map((window) => (
        <WindowMeter
          key={window.id}
          window={window}
          emphasized={window.kind === "session" || window.id === emphasizedWeeklyId}
          nowMs={nowMs}
        />
      ))}
    </span>
  );
}

function ExpandedPanel(props: {
  environmentId: EnvironmentId;
  accounts: ReadonlyArray<UsageAccountView>;
  nowMs: number;
}) {
  const { environmentId, accounts, nowMs } = props;
  // The bubble header carries the plan/updated line, so this renders only the
  // charts. Per-account labels stay when there is more than one to tell apart.
  const showAccountHeading = accounts.length > 1;

  return (
    <div className="flex flex-col gap-4">
      {accounts.map((account) => {
        const notice = unavailableLabel(account.limits);
        const externalUsage = account.limits.externalUsage;
        const extras = (
          <>
            {externalUsage ? (
              <Button
                size="sm"
                variant="link"
                className="self-start"
                onClick={() => void ensureLocalApi().shell.openExternal(externalUsage.url)}
              >
                Manage usage
              </Button>
            ) : null}
            {account.limits.resetCredits ? (
              <ResetCredits
                environmentId={environmentId}
                input={{ instanceId: account.instanceId }}
                credits={account.limits.resetCredits}
                now={nowMs}
              />
            ) : null}
          </>
        );
        if (notice !== null) {
          return (
            <div key={account.key} className="flex flex-col gap-1 text-2xs text-muted-foreground">
              {notice}
              {extras}
            </div>
          );
        }
        const windows = sortWindowsForDisplay(account.limits.windows);
        const sessionWindows = windows.filter((window) => window.kind === "session");
        const weeklyWindows = windows.filter((window) => window.kind === "weekly");
        const otherWindows = windows.filter(
          (window) => window.kind !== "session" && window.kind !== "weekly",
        );
        const sessionEta = sessionWindows[0] ? formatResetsIn(sessionWindows[0], nowMs) : null;
        const weeklyReference =
          weeklyWindows.find((window) => windowScopeName(window) === null) ?? weeklyWindows[0];
        const weeklyEta = weeklyReference ? formatResetsIn(weeklyReference, nowMs) : null;
        return (
          <div key={account.key} className="flex flex-col gap-3">
            {showAccountHeading ? (
              <span className="truncate font-medium text-foreground/90 text-xs">
                {account.label}
                {account.plan ? ` · ${account.plan}` : ""}
              </span>
            ) : null}
            {sessionWindows.length > 0 ? (
              <UsageHistoryChart
                environmentId={environmentId}
                instanceId={account.instanceId}
                windows={sessionWindows}
                nowMs={nowMs}
                title={`5-hour window${sessionEta ? ` · ${sessionEta}` : ""}`}
              />
            ) : null}
            {weeklyWindows.length > 0 ? (
              <UsageHistoryChart
                environmentId={environmentId}
                instanceId={account.instanceId}
                windows={weeklyWindows}
                nowMs={nowMs}
                title={`Weekly windows${weeklyEta ? ` · ${weeklyEta}` : ""}`}
              />
            ) : null}
            {otherWindows.map((window) => (
              <UsageHistoryChart
                key={window.id}
                environmentId={environmentId}
                instanceId={account.instanceId}
                windows={[window]}
                nowMs={nowMs}
                title={windowLongLabel(window)}
              />
            ))}
            {extras}
          </div>
        );
      })}
    </div>
  );
}

function driverLabel(account: UsageAccountView): string {
  return providerClients.get(account.driver)?.label ?? String(account.driver);
}

function formatClockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/**
 * Usage meter strip under the composer. Shows one cluster of meters per
 * signed-in account on the thread's environment, the selected provider's
 * account first; click expands the history charts.
 */
export function UsageStatusBar(props: {
  environmentId: EnvironmentId;
  selectedInstanceId: ProviderInstanceId | null;
}) {
  const { environmentId, selectedInstanceId } = props;
  const allAccounts = useAtomValue(usageAccountsAtom(environmentId));
  const accounts = orderUsageAccountsForSelection(allAccounts, selectedInstanceId);
  const waitingDrivers = useAtomValue(usageWaitingDriversAtom(environmentId));
  const queuedMessages = useAtomValue(queuedMessagesAtom(environmentId));
  const refreshIntervalMs = useUsageRefreshIntervalMs(environmentId);
  const [expanded, setExpanded] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  // State rather than refs: the bubble renders nothing until usage data
  // arrives, so the measuring effect has to rerun once the nodes exist.
  const [chartsInner, setChartsInner] = useState<HTMLDivElement | null>(null);
  const [metersInner, setMetersInner] = useState<HTMLDivElement | null>(null);
  const [chartsHeight, setChartsHeight] = useState(0);
  const [metersHeight, setMetersHeight] = useState(0);

  // Advance the clock while visible, and at once on becoming visible again so
  // a catch-up read starts the moment the strip is back on screen.
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") setNowMs(Date.now());
    };
    const interval = window.setInterval(tick, CLOCK_TICK_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", tick);
    };
  }, []);

  const checkedMs = oldestUsageCheckMs(accounts);
  useUsageAutoRefresh({ environmentId, checkedMs, nowMs, refreshIntervalMs });
  const stale = usageIsStale(checkedMs, nowMs, refreshIntervalMs);

  /*
   * Each section is a clipped wrapper whose height is animated by CSS between
   * 0 and its content's natural height. The content always lays out at full
   * size inside the wrapper, so it can be measured whether the section is
   * open or closed; the observer keeps the target honest as charts load.
   */
  useEffect(() => {
    if (!chartsInner || !metersInner) return;
    const measure = () => {
      setChartsHeight(chartsInner.offsetHeight);
      setMetersHeight(metersInner.offsetHeight);
    };
    measure();
    return observeResize([chartsInner, metersInner], measure);
  }, [chartsInner, metersInner]);

  if (accounts.length === 0) {
    if (waitingDrivers.length === 0) return null;
    // A provider that reports usage but has not published limits yet is
    // waiting on its first probe, which can take a while after startup. Say
    // so: an empty strip looks identical to the feature being broken.
    const waitingOn = waitingDrivers
      .map((driver) => providerClients.get(driver)?.label ?? String(driver))
      .join(", ");
    return (
      <div className="-mt-2 w-full shrink-0">
        <div className="mx-auto w-full max-w-3xl">
          <div
            data-usage-bubble="true"
            className="alert-glass overflow-hidden rounded-t-2xl border border-b-0 border-border/60 shadow-sm"
          >
            <div
              role="status"
              className="flex items-center gap-2 px-3 text-3xs text-muted-foreground/70"
              style={{ height: USAGE_STATUS_BAR_HEIGHT_PX + 12 }}
            >
              <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
              <span className="truncate">Waiting for usage data from {waitingOn}</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const headlineAccount =
    accounts.find((account) => unavailableLabel(account.limits) === null) ?? accounts[0]!;
  const drivers = new Set(accounts.map(driverLabel));
  const headline = [
    drivers.size === 1 ? `${driverLabel(headlineAccount)} usage` : "Usage limits",
    headlineAccount.plan ?? null,
    accounts.length > 1 ? `${accounts.length} accounts` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
  const pendingQueuedCount = queuedMessages.filter(
    (message) => message.status === "pending" || message.status === "sending",
  ).length;
  const headlineNotice = unavailableLabel(headlineAccount.limits);
  const headlineStatus = [
    headlineNotice !== null
      ? headlineNotice
      : checkedMs !== null
        ? `updated ${formatClockTime(checkedMs)} (${formatUsageAge(checkedMs, nowMs)})`
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
            <div ref={setChartsInner}>
              <div className="flex items-center justify-between gap-2 px-3 pt-2">
                <span className="min-w-0 truncate font-medium text-foreground/80 text-xs">
                  {headline}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  {headlineStatus.length > 0 ? (
                    <span
                      className={cn("text-3xs", stale ? "text-warning" : "text-muted-foreground")}
                    >
                      {headlineStatus}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => setExpanded(false)}
                    aria-label="Collapse usage details"
                    tabIndex={expanded ? undefined : -1}
                    className={cn(
                      "flex size-5 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none",
                      "hover:bg-accent/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                    )}
                  >
                    <ChevronDownIcon className="size-3.5" />
                  </button>
                </span>
              </div>
              <div className="max-h-[45dvh] overflow-y-auto px-3 pt-1 pb-2.5">
                <ExpandedPanel environmentId={environmentId} accounts={accounts} nowMs={nowMs} />
              </div>
            </div>
          </div>

          <div
            className="overflow-hidden transition-[height] duration-300 ease-out motion-reduce:transition-none"
            style={{ height: expanded ? 0 : metersHeight }}
            aria-hidden={expanded}
          >
            <div ref={setMetersInner}>
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
                <span
                  className={cn(
                    "flex min-w-0 flex-1 items-center gap-4",
                    // Old numbers must not pass for current ones.
                    stale && "opacity-50 grayscale",
                  )}
                >
                  {accounts.map((account) => (
                    <AccountMeters
                      key={account.key}
                      account={account}
                      nowMs={nowMs}
                      showAccountLabel={accounts.length > 1}
                    />
                  ))}
                </span>
                {stale && checkedMs !== null ? (
                  <span className="shrink-0 whitespace-nowrap text-3xs text-warning tabular-nums">
                    {formatUsageAge(checkedMs, nowMs)}
                  </span>
                ) : null}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
