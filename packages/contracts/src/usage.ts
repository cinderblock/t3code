import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/**
 * Account-level usage contracts.
 *
 * Provider-generic model of rate-limit / spend windows so the same wire
 * shape can eventually carry Codex, API-key spend, or any other provider's
 * quota data. Today only the Claude subscription poller emits snapshots.
 *
 * Terminology:
 *  - "window": one rolling limit bucket (5-hour session, 7-day weekly, a
 *    calendar-month spend pool, ...). Identified by `kind` + `scopeKey`.
 *  - "scope": which portion of traffic the window meters. `all` covers
 *    every model on the account; model-scoped windows meter one model
 *    family (e.g. weekly Fable) and carry its display name.
 */

/** Broad cadence classes — used for grouping bars and charts, not math. */
export const UsageWindowKind = Schema.Literals(["session", "weekly", "monthly"]);
export type UsageWindowKind = typeof UsageWindowKind.Type;

/**
 * Provider-reported pressure on the window. `exceeded` means the cap is
 * active (requests are rejected until reset).
 */
export const UsageSeverity = Schema.Literals(["normal", "warning", "critical", "exceeded"]);
export type UsageSeverity = typeof UsageSeverity.Type;

/** How the account pays for the metered traffic. */
export const UsageBillingKind = Schema.Literals(["subscription", "pay-per-use"]);
export type UsageBillingKind = typeof UsageBillingKind.Type;

export const UsageScope = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("all") }),
  Schema.Struct({
    kind: Schema.Literal("model"),
    /** Provider model id when reported (often absent). */
    modelId: Schema.optional(TrimmedNonEmptyString),
    /** Human label, e.g. "Fable", "Opus", "Sonnet". */
    displayName: TrimmedNonEmptyString,
  }),
]);
export type UsageScope = typeof UsageScope.Type;

/** Stable key for a scope, used to join snapshots with history samples. */
export function usageScopeKey(scope: UsageScope): string {
  return scope.kind === "all" ? "all" : `model:${scope.displayName}`;
}

export const UsageDollars = Schema.Struct({
  used: Schema.Number,
  limit: Schema.Number,
  currency: TrimmedNonEmptyString,
});
export type UsageDollars = typeof UsageDollars.Type;

export const UsageWindow = Schema.Struct({
  /** Stable identity within a snapshot: `${kind}:${scopeKey}`. */
  id: TrimmedNonEmptyString,
  kind: UsageWindowKind,
  scope: UsageScope,
  /** 0–100 (may exceed 100 for soft windows). */
  percent: Schema.Number,
  severity: UsageSeverity,
  /** When this window resets; null when the provider did not report one. */
  resetsAt: Schema.NullOr(IsoDateTime),
  /** Nominal window length used to derive the window start for pacing. */
  windowHours: Schema.Number,
  /** Provider says traffic is currently being limited by this window. */
  isActive: Schema.Boolean,
  billing: UsageBillingKind,
  /** Present for spend pools (usage-based billing). */
  dollars: Schema.optional(UsageDollars),
});
export type UsageWindow = typeof UsageWindow.Type;

export const AccountUsageSnapshot = Schema.Struct({
  /**
   * Identity of the account the windows belong to. For Claude this is the
   * resolved home directory the credentials were read from, so multiple
   * provider instances sharing one login share one snapshot.
   */
  accountKey: TrimmedNonEmptyString,
  /** Provider instances currently mapped to this account. */
  instanceIds: Schema.Array(ProviderInstanceId),
  /** Human plan label when known (e.g. "Max 20x"). */
  planLabel: Schema.NullOr(TrimmedNonEmptyString),
  capturedAt: IsoDateTime,
  windows: Schema.Array(UsageWindow),
});
export type AccountUsageSnapshot = typeof AccountUsageSnapshot.Type;

export const AccountUsageUnavailableReason = Schema.Literals([
  "no-credentials",
  "token-rejected",
  "rate-limited",
  "fetch-failed",
]);
export type AccountUsageUnavailableReason = typeof AccountUsageUnavailableReason.Type;

/**
 * A known account and whatever we currently have for it. `snapshot` is null
 * before the first successful poll — the account is still reported so the UI
 * can show a placeholder instead of silently rendering nothing, which is
 * indistinguishable from a bug.
 */
export const AccountUsageStatus = Schema.Struct({
  accountKey: TrimmedNonEmptyString,
  snapshot: Schema.NullOr(AccountUsageSnapshot),
  unavailableReason: Schema.NullOr(AccountUsageUnavailableReason),
  unavailableDetail: Schema.NullOr(Schema.String),
});
export type AccountUsageStatus = typeof AccountUsageStatus.Type;

export const AccountUsageStreamEvent = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("snapshot"),
    accounts: Schema.Array(AccountUsageStatus),
  }),
  Schema.Struct({
    _tag: Schema.Literal("accountUpdated"),
    snapshot: AccountUsageSnapshot,
  }),
  Schema.Struct({
    /**
     * Emitted when an account's usage can no longer be fetched. The last
     * good snapshot (if any) should be kept on screen, dimmed.
     */
    _tag: Schema.Literal("accountUnavailable"),
    accountKey: TrimmedNonEmptyString,
    reason: AccountUsageUnavailableReason,
    detail: Schema.NullOr(Schema.String),
  }),
]);
export type AccountUsageStreamEvent = typeof AccountUsageStreamEvent.Type;

export const UsageHistorySample = Schema.Struct({
  capturedAt: IsoDateTime,
  percent: Schema.Number,
  resetsAt: Schema.NullOr(IsoDateTime),
});
export type UsageHistorySample = typeof UsageHistorySample.Type;

export const UsageHistoryInput = Schema.Struct({
  accountKey: TrimmedNonEmptyString,
  windowId: TrimmedNonEmptyString,
  /** Inclusive ISO bound; omit for "since retention start". */
  since: Schema.optional(IsoDateTime),
});
export type UsageHistoryInput = typeof UsageHistoryInput.Type;

export const UsageHistoryResult = Schema.Struct({
  samples: Schema.Array(UsageHistorySample),
});
export type UsageHistoryResult = typeof UsageHistoryResult.Type;

export class AccountUsageError extends Schema.TaggedErrorClass<AccountUsageError>()(
  "AccountUsageError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
