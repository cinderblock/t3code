import type {
  ModelSelection,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { limitsNotice } from "@t3tools/shared/usageLimits";

import type { UsageAccountView } from "../../state/quota";

/**
 * Presentation helpers for the usage meters. Kept free of React so the
 * ordering/emphasis rules are unit-testable.
 *
 * Windows are upstream's `ServerProviderUsageWindow`: a provider-assigned id
 * (`five_hour`, `seven_day`, `seven_day_fable`), a kind, a label and a used
 * percentage. A model-scoped window carries the model's display name as its
 * label; an account-wide window carries the kind's generic label.
 */

const ACCOUNT_WIDE_LABELS = new Set(["session", "weekly", "monthly", "primary", "secondary"]);
const ACCOUNT_WIDE_IDS = new Set(["five_hour", "seven_day", "primary", "secondary"]);

/**
 * The model a window is scoped to, or null for an account-wide window. Claude
 * scoped weeklies extend the base id (`seven_day_<model>`) and are labelled by
 * model; everything a provider labels with its kind is account-wide.
 */
export function windowScopeName(window: ServerProviderUsageWindow): string | null {
  if (ACCOUNT_WIDE_IDS.has(window.id) || ACCOUNT_WIDE_LABELS.has(window.label.toLowerCase())) {
    return null;
  }
  return window.label;
}

/**
 * Fixed categorical series slots (validated palette — see the dataviz
 * reference instance). Identity is bound to the scope, never to the order
 * windows happen to arrive in.
 */
const SERIES_SLOT_CLASSES: ReadonlyArray<string> = [
  // slot 1 blue — account-wide
  "[--series-color:#2a78d6] dark:[--series-color:#3987e5]",
  // slot 2 green — Fable
  "[--series-color:#008300] dark:[--series-color:#008300]",
  // slot 3 magenta — Opus
  "[--series-color:#e87ba4] dark:[--series-color:#d55181]",
  // slot 4 yellow — Sonnet
  "[--series-color:#eda100] dark:[--series-color:#c98500]",
  // slot 5 aqua — anything else
  "[--series-color:#1baf7a] dark:[--series-color:#199e70]",
];

const KNOWN_MODEL_SLOTS: Readonly<Record<string, number>> = {
  fable: 1,
  opus: 2,
  sonnet: 3,
};

export function seriesSlotClassForWindow(window: ServerProviderUsageWindow): string {
  const scope = windowScopeName(window);
  if (scope === null) {
    return SERIES_SLOT_CLASSES[0]!;
  }
  const slot = KNOWN_MODEL_SLOTS[scope.toLowerCase()];
  return SERIES_SLOT_CLASSES[slot ?? 4]!;
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

export function severityMeterClass(window: ServerProviderUsageWindow): string {
  switch (windowSeverity(window)) {
    case "exceeded":
    case "critical":
      return "bg-[var(--color-red-500)]";
    case "warning":
      return "bg-[var(--color-amber-500)]";
    case "normal":
      return "bg-[var(--color-blue-500)]";
  }
}

export function formatResetEta(resetsAt: string | undefined, nowMs: number): string | null {
  if (resetsAt === undefined) return null;
  const resetMs = Date.parse(resetsAt);
  if (!Number.isFinite(resetMs)) return null;
  const deltaMs = resetMs - nowMs;
  if (deltaMs <= 0) return "resetting…";
  const totalMinutes = Math.round(deltaMs / 60_000);
  if (totalMinutes < 60) return `resets in ${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  if (hours < 48) {
    const minutes = totalMinutes % 60;
    return minutes === 0 ? `resets in ${hours}h` : `resets in ${hours}h ${minutes}m`;
  }
  const days = Math.floor(hours / 24);
  return `resets in ${days}d ${hours % 24}h`;
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
