import type { AccountUsageState } from "@t3tools/client-runtime/state/quota";
import type { ModelSelection, UsageWindow } from "@t3tools/contracts";

/**
 * Presentation helpers for the usage meters. Kept free of React so the
 * ordering/emphasis rules are unit-testable.
 */

/**
 * Fixed categorical series slots (validated palette — see the dataviz
 * reference instance). Identity is bound to the scope, never to the order
 * windows happen to arrive in.
 */
const SERIES_SLOT_CLASSES: ReadonlyArray<string> = [
  // slot 1 blue — "All models"
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

export function seriesSlotClassForWindow(window: UsageWindow): string {
  if (window.scope.kind === "all") {
    return SERIES_SLOT_CLASSES[0]!;
  }
  const slot = KNOWN_MODEL_SLOTS[window.scope.displayName.toLowerCase()];
  return SERIES_SLOT_CLASSES[slot ?? 4]!;
}

export function windowShortLabel(window: UsageWindow): string {
  const scopeLabel = window.scope.kind === "all" ? "all models" : window.scope.displayName;
  switch (window.kind) {
    case "session":
      return "5h";
    case "weekly":
      return window.scope.kind === "all" ? "Week" : `Week · ${scopeLabel}`;
    case "monthly":
      return "Extra usage";
  }
}

export function windowLongLabel(window: UsageWindow): string {
  switch (window.kind) {
    case "session":
      return "5-hour window · all models";
    case "weekly":
      return window.scope.kind === "all"
        ? "Weekly window · all models"
        : `Weekly window · ${window.scope.displayName}`;
    case "monthly":
      return "Monthly extra usage";
  }
}

const WINDOW_KIND_ORDER: Readonly<Record<UsageWindow["kind"], number>> = {
  session: 0,
  weekly: 1,
  monthly: 2,
};

/** Session first, then weekly (all before scoped), then the spend pool. */
export function sortWindowsForDisplay(windows: ReadonlyArray<UsageWindow>): Array<UsageWindow> {
  return [...windows].sort((a, b) => {
    const kindDelta = WINDOW_KIND_ORDER[a.kind] - WINDOW_KIND_ORDER[b.kind];
    if (kindDelta !== 0) return kindDelta;
    const aScoped = a.scope.kind === "model" ? 1 : 0;
    const bScoped = b.scope.kind === "model" ? 1 : 0;
    if (aScoped !== bScoped) return aScoped - bScoped;
    const aName = a.scope.kind === "model" ? a.scope.displayName : "";
    const bName = b.scope.kind === "model" ? b.scope.displayName : "";
    return aName.localeCompare(bName);
  });
}

/**
 * Which weekly window deserves emphasis: the one scoped to the selected
 * model when there is such a window (e.g. Fable selected → Fable weekly
 * bar), otherwise the all-models weekly window.
 */
export function emphasizedWeeklyWindowId(
  windows: ReadonlyArray<UsageWindow>,
  selectedModelSlug: string | null,
): string | null {
  const weekly = windows.filter((window) => window.kind === "weekly");
  if (weekly.length === 0) return null;
  if (selectedModelSlug !== null) {
    const slug = selectedModelSlug.toLowerCase();
    const scoped = weekly.find(
      (window) =>
        window.scope.kind === "model" && slug.includes(window.scope.displayName.toLowerCase()),
    );
    if (scoped !== undefined) return scoped.id;
  }
  return weekly.find((window) => window.scope.kind === "all")?.id ?? weekly[0]!.id;
}

/**
 * Best-effort "selected Claude model" for emphasis: the sticky (or draft)
 * selection of any provider instance mapped to this usage account.
 */
export function selectedModelSlugForAccount(
  account: AccountUsageState,
  selectionsByInstance: Partial<Record<string, ModelSelection>>,
): string | null {
  for (const instanceId of account.snapshot?.instanceIds ?? []) {
    const selection = selectionsByInstance[instanceId];
    if (selection !== undefined) return selection.model;
  }
  return null;
}

/**
 * What to show when an account has no usage snapshot. Each reason gets its
 * own wording because the remedies differ — a rate limit clears itself, a
 * missing login does not.
 */
export function unavailableLabel(account: AccountUsageState): string {
  switch (account.unavailableReason) {
    case "rate-limited":
      return "Usage rate limited — retrying";
    case "no-credentials":
      return "Usage unavailable — no Claude login";
    case "token-rejected":
      return "Usage unavailable — sign in to Claude again";
    case "fetch-failed":
      return "Usage unavailable — retrying";
    case null:
      return "Checking usage…";
  }
}

export function severityMeterClass(window: UsageWindow): string {
  switch (window.severity) {
    case "exceeded":
    case "critical":
      return "bg-[var(--color-red-500)]";
    case "warning":
      return "bg-[var(--color-amber-500)]";
    case "normal":
      return "bg-[var(--color-blue-500)]";
  }
}

export function formatResetEta(resetsAt: string | null, nowMs: number): string | null {
  if (resetsAt === null) return null;
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
