import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/**
 * Usage history — the fork's time series behind the meter strip's charts.
 *
 * The live numbers come from `ServerProvider.usageLimits` (see
 * `providerUsageLimits.ts`); the server records one sample per window every
 * time an instance publishes limits with a new `checkedAt`. Samples key on the
 * provider instance and the provider's own window id (`five_hour`, `seven_day`,
 * …), so a chart for a window is one `usage.getHistory` read.
 */

export const UsageHistorySample = Schema.Struct({
  capturedAt: IsoDateTime,
  /** Used share of the window, 0–100, as the provider reported it. */
  percent: Schema.Number,
  resetsAt: Schema.NullOr(IsoDateTime),
});
export type UsageHistorySample = typeof UsageHistorySample.Type;

export const UsageHistoryInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  /** `ServerProviderUsageWindow.id`. */
  windowId: TrimmedNonEmptyString,
  /** Inclusive ISO bound; the server defaults to the last seven days. */
  since: Schema.optional(IsoDateTime),
});
export type UsageHistoryInput = typeof UsageHistoryInput.Type;

export const UsageHistoryResult = Schema.Struct({
  samples: Schema.Array(UsageHistorySample),
});
export type UsageHistoryResult = typeof UsageHistoryResult.Type;

export class UsageHistoryError extends Schema.TaggedError<UsageHistoryError>()(
  "UsageHistoryError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
