/**
 * Event-loop lag monitor.
 *
 * The backend is a single Node process; anything synchronous (a `statSync` PATH
 * walk, a large `JSON.parse`, a synchronous SQLite query — the driver is
 * `node:sqlite`'s `DatabaseSync`) blocks the loop for its whole duration. While
 * blocked the process cannot answer its readiness endpoint or the WebSocket
 * health probe, so the desktop client concludes the backend is dead and
 * reconnects — which re-runs bootstrap and blocks it further.
 *
 * Every diagnosis of that spiral so far has been inferred from *effects*
 * (timeouts, reconnects) rather than measured. This measures it directly: a
 * fiber sleeps a fixed interval and reports how much longer than requested the
 * sleep actually took. That overshoot is, by definition, time the loop was
 * unavailable to run timers — i.e. blocked.
 *
 * Cheap by construction: 4 wakeups/second that do nothing but subtract two
 * numbers, and it only logs when it sees a real stall.
 *
 * Tuning via environment:
 * - `T3_EVENT_LOOP_LAG_MS` — report threshold in ms (default 250).
 * - `T3_EVENT_LOOP_LAG_OFF` — set to disable the monitor entirely.
 */

import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

const SAMPLE_INTERVAL = Duration.millis(250);
const SAMPLE_INTERVAL_MS = Duration.toMillis(SAMPLE_INTERVAL);
const DEFAULT_THRESHOLD_MS = 250;

/** Stalls at or above this are worth a louder log line — a client probe times out around here. */
const SEVERE_THRESHOLD_MS = 5_000;

function resolveThresholdMs(): number {
  const raw = process.env.T3_EVENT_LOOP_LAG_MS?.trim();
  if (!raw) return DEFAULT_THRESHOLD_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_THRESHOLD_MS;
}

interface LagStats {
  readonly maxLagMs: number;
  readonly totalLagMs: number;
  readonly stallCount: number;
}

const ZERO_STATS: LagStats = { maxLagMs: 0, totalLagMs: 0, stallCount: 0 };

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    if (process.env.T3_EVENT_LOOP_LAG_OFF) {
      return;
    }

    const thresholdMs = resolveThresholdMs();
    const statsRef = yield* Ref.make(ZERO_STATS);
    const startedAt = yield* Clock.currentTimeMillis;
    const lastRef = yield* Ref.make(startedAt);

    const sample = Effect.gen(function* () {
      yield* Effect.sleep(SAMPLE_INTERVAL);
      const now = yield* Clock.currentTimeMillis;
      const previous = yield* Ref.getAndSet(lastRef, now);
      // Overshoot beyond the requested sleep is time the loop could not run timers.
      const lagMs = now - previous - SAMPLE_INTERVAL_MS;
      if (lagMs < thresholdMs) {
        return;
      }

      const stats = yield* Ref.updateAndGet(statsRef, (previous) => ({
        maxLagMs: Math.max(previous.maxLagMs, lagMs),
        totalLagMs: previous.totalLagMs + lagMs,
        stallCount: previous.stallCount + 1,
      }));
      const message =
        lagMs >= SEVERE_THRESHOLD_MS
          ? "Event loop blocked long enough to fail a client health check"
          : "Event loop stalled";
      yield* Effect.logWarning(message).pipe(
        Effect.annotateLogs({
          lagMs: Math.round(lagMs),
          sinceStartupMs: Math.round(now - startedAt),
          maxLagMs: Math.round(stats.maxLagMs),
          totalStalledMs: Math.round(stats.totalLagMs),
          stallCount: stats.stallCount,
        }),
      );
    });

    yield* Effect.forkScoped(Effect.forever(sample));
    yield* Effect.logDebug("Event loop lag monitor started").pipe(
      Effect.annotateLogs({ thresholdMs, sampleIntervalMs: SAMPLE_INTERVAL_MS }),
    );
  }),
);
