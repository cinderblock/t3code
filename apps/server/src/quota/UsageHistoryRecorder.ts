/**
 * UsageHistoryRecorder — turns the usage limits every provider instance publishes into a
 * time series for the meter strip's history chart.
 *
 * Upstream owns the reads: adapters push sparse `account.rate-limits.updated` events during
 * a turn, the capabilities probe does a full `get_usage`, and `makeManagedServerProvider`
 * re-probes on `providerHealthRefreshInterval`. Each of those republishes the instance's
 * `usageLimits` with a new `checkedAt`. This service only watches that stream and writes one
 * `fork_usage_samples` row per window whenever `checkedAt` advances, so there is no second
 * poller and no credentials handling here.
 *
 * Rows key on the provider instance id (`account_key`), which is stable across restarts
 * because it is the settings key. Rows from the fork's earlier Claude-home-keyed poller are
 * simply never read again and age out with the retention sweep.
 */
import type { ServerProvider, UsageHistoryInput, UsageHistoryResult } from "@t3tools/contracts";
import { UsageHistoryError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";

const HISTORY_RETENTION_DAYS = 90;
/** How far back a history read looks when the caller does not say. */
const DEFAULT_HISTORY_SPAN_DAYS = 7;
/** Hard cap per read; the chart samples at most a few per minute over a week. */
const MAX_SAMPLES_PER_READ = 5_000;

export class UsageHistoryRecorder extends Context.Service<
  UsageHistoryRecorder,
  {
    readonly getHistory: (
      input: UsageHistoryInput,
    ) => Effect.Effect<UsageHistoryResult, UsageHistoryError>;
    /**
     * Record one sample per window for every instance whose limits carry a `checkedAt`
     * not seen before. Returns the number of rows written. Exposed for tests; the layer
     * drives it from the registry's change stream.
     */
    readonly recordProviders: (providers: ReadonlyArray<ServerProvider>) => Effect.Effect<number>;
  }
>()("t3/quota/UsageHistoryRecorder") {}

const toHistoryError = (message: string) => (cause: unknown) =>
  new UsageHistoryError({ message, cause });

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const providerRegistry = yield* ProviderRegistry;
  /** instanceId -> the `checkedAt` already sampled, so a republish with the same read is a no-op. */
  const recordedRef = yield* Ref.make(new Map<string, string>());

  const sweepRetention = Effect.gen(function* () {
    const now = yield* DateTime.now;
    const cutoff = DateTime.formatIso(DateTime.add(now, { days: -HISTORY_RETENTION_DAYS }));
    yield* sql`DELETE FROM fork_usage_samples WHERE captured_at < ${cutoff}`;
  });

  const recordProviders: UsageHistoryRecorder["Service"]["recordProviders"] = Effect.fn(
    "UsageHistoryRecorder.recordProviders",
  )(function* (providers) {
    const recorded = yield* Ref.get(recordedRef);
    const next = new Map(recorded);
    let written = 0;
    for (const provider of providers) {
      const limits = provider.usageLimits;
      // An unavailable read carries no windows worth a point; a probe failure keeps the
      // previous windows in the snapshot, but re-plotting them under a new timestamp would
      // draw a flat line for data nobody measured.
      if (limits === undefined || limits.unavailable !== undefined || limits.windows.length === 0) {
        continue;
      }
      if (recorded.get(provider.instanceId) === limits.checkedAt) {
        continue;
      }
      next.set(provider.instanceId, limits.checkedAt);
      for (const window of limits.windows) {
        yield* sql`
          INSERT OR REPLACE INTO fork_usage_samples (account_key, window_id, captured_at, percent, resets_at)
          VALUES (${provider.instanceId}, ${window.id}, ${limits.checkedAt}, ${window.usedPercent}, ${window.resetsAt ?? null})
        `;
        written += 1;
      }
    }
    yield* Ref.set(recordedRef, next);
    if (written > 0) {
      yield* sweepRetention;
    }
    return written;
  }, Effect.orDie);

  yield* Stream.concat(
    Stream.fromEffect(providerRegistry.getProviders),
    providerRegistry.streamChanges,
  ).pipe(
    Stream.runForEach((providers) =>
      recordProviders(providers).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to record usage history", { detail: String(cause) }),
        ),
      ),
    ),
    Effect.forkScoped,
  );

  const getHistory: UsageHistoryRecorder["Service"]["getHistory"] = Effect.fn(
    "UsageHistoryRecorder.getHistory",
  )(function* (input) {
    const since =
      input.since ??
      DateTime.formatIso(DateTime.add(yield* DateTime.now, { days: -DEFAULT_HISTORY_SPAN_DAYS }));
    const rows = yield* sql<{
      readonly capturedAt: string;
      readonly percent: number;
      readonly resetsAt: string | null;
    }>`
      SELECT captured_at AS "capturedAt", percent, resets_at AS "resetsAt"
      FROM fork_usage_samples
      WHERE account_key = ${input.instanceId}
        AND window_id = ${input.windowId}
        AND captured_at >= ${since}
      ORDER BY captured_at ASC
      LIMIT ${MAX_SAMPLES_PER_READ}
    `.pipe(Effect.mapError(toHistoryError("Failed to load usage history")));
    return {
      samples: rows.map((row) => ({
        capturedAt: String(row.capturedAt),
        percent: Number(row.percent),
        resetsAt: row.resetsAt === null ? null : String(row.resetsAt),
      })),
    };
  });

  return UsageHistoryRecorder.of({ getHistory, recordProviders });
});

export const layer = Layer.effect(UsageHistoryRecorder, make);
