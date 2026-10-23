import type {
  ModelSelection,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { formatDuration, limitsNotice } from "@t3tools/shared/usageLimits";

import type { UsageAccountView } from "../../state/quota";

/**
 * Presentation helpers for the usage meters. Kept free of React so the
 * ordering/emphasis rules are unit-testable.
 *
 * Windows are upstream's `ServerProviderUsageWindow`: a provider-assigned id
 * (`five_hour`, `seven_day`, `seven_day_fable`), a kind, a label and a used
 * percentage. A model-scoped window is labelled `<Kind> · <Model>` (Claude's
 * `Weekly · Fable`); an account-wide window carries the kind's generic label.
 */

const ACCOUNT_WIDE_LABELS = new Set(["session", "weekly", "monthly", "primary", "secondary"]);
const ACCOUNT_WIDE_IDS = new Set(["five_hour", "seven_day", "primary", "secondary"]);

/**
 * The model a window is scoped to, or null for an account-wide window. Claude
 * scoped weeklies extend the base id (`seven_day_<model>`) and put the model
 * after the kind in the label; everything labelled with its kind alone is
 * account-wide.
 */
export function windowScopeName(window: ServerProviderUsageWindow): string | null {
  if (ACCOUNT_WIDE_IDS.has(window.id) || ACCOUNT_WIDE_LABELS.has(window.label.toLowerCase())) {
    return null;
  }
  const separator = window.label.lastIndexOf(" · ");
  return separator === -1 ? window.label : window.label.slice(separator + 3);
}

export interface SeriesStyle {
  readonly color: string;
  readonly dashArray: string | undefined;
}

/**
 * Chart series drawn from the active theme rather than a fixed palette, so
 * every theme (including imported VS Code ones) colours them. Themes carry no
 * categorical palette, so series past the first step away from the accent in
 * colour and dash together; the direct label at each line end carries
 * identity, never colour alone.
 */
const SERIES_STYLES: ReadonlyArray<SeriesStyle> = [
  { color: "var(--primary)", dashArray: undefined },
  { color: "color-mix(in oklab, var(--primary) 50%, var(--foreground))", dashArray: "6 3" },
  { color: "var(--muted-foreground)", dashArray: "2 3" },
];

/** Style for the `index`th series of a chart whose windows are in display order. */
export function seriesStyle(index: number): SeriesStyle {
  return SERIES_STYLES[Math.min(index, SERIES_STYLES.length - 1)]!;
}

/** Nominal window length in hours, from the provider when it says, else by kind. */
export function windowHours(window: ServerProviderUsageWindow): number {
  if (window.windowDurationMins !== undefined && window.windowDurationMins > 0) {
    return window.windowDurationMins / 60;
  }
  switch (window.kind) {
    case "session":
      return 5;
    case "weekly":
      return 7 * 24;
    case "monthly":
      return 30 * 24;
    case "other":
      return 24;
  }
}

export function windowShortLabel(window: ServerProviderUsageWindow): string {
  const scope = windowScopeName(window);
  switch (window.kind) {
    case "session":
      return windowHours(window) === 5 ? "5h" : window.label;
    case "weekly":
      return scope === null ? "Week" : `Week · ${scope}`;
    case "monthly":
      return scope === null ? "Month" : `Month · ${scope}`;
    case "other":
      return window.label;
  }
}

export function windowLongLabel(window: ServerProviderUsageWindow): string {
  const scope = windowScopeName(window);
  const scopeLabel = scope === null ? "all models" : scope;
  switch (window.kind) {
    case "session":
      return `${windowHours(window) === 5 ? "5-hour" : window.label} window · ${scopeLabel}`;
    case "weekly":
      return `Weekly window · ${scopeLabel}`;
    case "monthly":
      return `Monthly window · ${scopeLabel}`;
    case "other":
      return `${window.label} · ${scopeLabel}`;
  }
}

const WINDOW_KIND_ORDER: Readonly<Record<ServerProviderUsageWindow["kind"], number>> = {
  session: 0,
  weekly: 1,
  monthly: 2,
  other: 3,
};

/** Session first, then weekly (account-wide before scoped), then the rest. */
export function sortWindowsForDisplay(
  windows: ReadonlyArray<ServerProviderUsageWindow>,
): Array<ServerProviderUsageWindow> {
  return [...windows].sort((a, b) => {
    const kindDelta = WINDOW_KIND_ORDER[a.kind] - WINDOW_KIND_ORDER[b.kind];
    if (kindDelta !== 0) return kindDelta;
    const aScope = windowScopeName(a);
    const bScope = windowScopeName(b);
    if ((aScope === null) !== (bScope === null)) return aScope === null ? -1 : 1;
    return (aScope ?? "").localeCompare(bScope ?? "");
  });
}

/**
 * Which weekly window deserves emphasis: the one scoped to the selected
 * model when there is such a window (e.g. Fable selected → Fable weekly
 * bar), otherwise the account-wide weekly window.
 */
export function emphasizedWeeklyWindowId(
  windows: ReadonlyArray<ServerProviderUsageWindow>,
  selectedModelSlug: string | null,
): string | null {
  const weekly = windows.filter((window) => window.kind === "weekly");
  if (weekly.length === 0) return null;
  if (selectedModelSlug !== null) {
    const slug = selectedModelSlug.toLowerCase();
    const scoped = weekly.find((window) => {
      const scope = windowScopeName(window);
      return scope !== null && slug.includes(scope.toLowerCase());
    });
    if (scoped !== undefined) return scoped.id;
  }
  return weekly.find((window) => windowScopeName(window) === null)?.id ?? weekly[0]!.id;
}

/**
 * Best-effort "selected model" for emphasis: the sticky (or draft) selection
 * of any provider instance on this account.
 */
export function selectedModelSlugForAccount(
  account: Pick<UsageAccountView, "instanceIds">,
  selectionsByInstance: Partial<Record<string, ModelSelection>>,
): string | null {
  for (const instanceId of account.instanceIds) {
    const selection = selectionsByInstance[instanceId];
    if (selection !== undefined) return selection.model;
  }
  return null;
}

/**
 * What to show instead of bars. Upstream phrases the unavailable reasons;
 * limits with windows have nothing to say here.
 */
export function unavailableLabel(limits: ServerProviderUsageLimits): string | null {
  return limitsNotice(limits);
}

export type UsageSeverity = "normal" | "warning" | "critical" | "exceeded";

/**
 * Pressure on the window from its used share alone. The provider's own
 * status (rejected/warning) is not on the snapshot; a window it refuses to
 * serve reports 100% used, which is the `exceeded` case.
 */
export function windowSeverity(window: ServerProviderUsageWindow): UsageSeverity {
  if (window.usedPercent >= 100) return "exceeded";
  if (window.usedPercent >= 90) return "critical";
  if (window.usedPercent >= 75) return "warning";
  return "normal";
}

/** Theme roles only, so the meters follow whichever theme is active. */
export function severityMeterClass(window: ServerProviderUsageWindow): string {
  switch (windowSeverity(window)) {
    case "exceeded":
    case "critical":
      return "bg-destructive";
    case "warning":
      return "bg-warning";
    case "normal":
      return "bg-primary";
  }
}

/**
 * Slack past the server's own refresh interval before the strip asks for a
 * read itself. The server's ticks keep `checkedAt` inside the interval while
 * it sees a focused window, so the strip only fills the gaps it leaves.
 */
const REFRESH_GRACE_MS = 60_000;
/** Numbers younger than this never read as stale, however short the interval. */
const MIN_STALE_AFTER_MS = 10 * 60_000;

/**
 * The oldest read among accounts that can report limits; that is the one a
 * refresh would bring forward. Unsupported accounts never get newer.
 */
export function oldestUsageCheckMs(
  accounts: ReadonlyArray<Pick<UsageAccountView, "limits">>,
): number | null {
  let oldest: number | null = null;
  for (const account of accounts) {
    if (account.limits.unavailable?.reason === "unsupported") continue;
    const checkedMs = Date.parse(account.limits.checkedAt);
    if (Number.isFinite(checkedMs) && (oldest === null || checkedMs < oldest)) oldest = checkedMs;
  }
  return oldest;
}

/**
 * Whether an on-screen strip should ask the server for fresh limits. A
 * non-positive interval means the user turned background refresh off, which
 * the strip honours too.
 */
export function usageRefreshDue(
  checkedMs: number | null,
  nowMs: number,
  refreshIntervalMs: number,
): boolean {
  if (checkedMs === null || refreshIntervalMs <= 0) return false;
  return nowMs - checkedMs > refreshIntervalMs + REFRESH_GRACE_MS;
}

/** Old enough that the meters should say so instead of passing for current. */
export function usageIsStale(
  checkedMs: number | null,
  nowMs: number,
  refreshIntervalMs: number,
): boolean {
  if (checkedMs === null) return false;
  return nowMs - checkedMs > Math.max(MIN_STALE_AFTER_MS, 2 * refreshIntervalMs);
}

export function formatUsageAge(checkedMs: number, nowMs: number): string {
  const ageMs = nowMs - checkedMs;
  return ageMs < 60_000 ? "just now" : `${formatDuration(ageMs)} ago`;
}

export function formatPercent(percent: number): string {
  if (!Number.isFinite(percent)) return "–";
  if (percent > 0 && percent < 10) {
    return `${percent.toFixed(1).replace(/\.0$/, "")}%`;
  }
  return `${Math.round(percent)}%`;
}

/**
 * The provider window id a queued-message trigger should watch for a kind:
 * the account-wide window of that kind when the account has one, else the
 * fork's legacy `<kind>:all` id, which the server still resolves by kind.
 */
export function accountWindowIdForKind(
  account: Pick<UsageAccountView, "limits">,
  kind: ServerProviderUsageWindow["kind"],
): string {
  const window = sortWindowsForDisplay(account.limits.windows).find(
    (candidate) => candidate.kind === kind && windowScopeName(candidate) === null,
  );
  return window?.id ?? `${kind}:all`;
}

/** Human window name for a trigger's window id, whichever generation of id it carries. */
export function describeTriggerWindow(windowId: string): string {
  if (windowId === "five_hour" || windowId.startsWith("session")) return "5-hour window";
  if (windowId.startsWith("seven_day") || windowId.startsWith("weekly")) return "weekly window";
  if (windowId.startsWith("monthly")) return "monthly window";
  return `${windowId} window`;
}

/** Whether a trigger's window id names the weekly window. */
export function isWeeklyTriggerWindow(windowId: string): boolean {
  return windowId.startsWith("seven_day") || windowId.startsWith("weekly");
}
