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
 * - `T3_DIAGNOSTICS_FILE` — also append each stall as JSON to this path.
 *
 * ## Why it writes its own file
 *
 * `Effect.logWarning` goes to stdout and the trace, and both proved unreliable
 * for this: the desktop's capture of backend stdout into `server-child.log`
 * silently stopped recording (a run's "CPU profiler started" line exists in no
 * current log despite the profile being written), and `server.trace.ndjson`
 * rotates roughly every 60-90s under load, so a 19s window is all that
 * survives. Appending directly — the same approach that makes CpuProfiler
 * reliable — means stall evidence outlives both.
 */

// @effect-diagnostics-next-line nodeBuiltinImport:off - diagnostic sink must not depend on the app's FileSystem layer or its logger
import * as NodeFS from "node:fs";
// node:os needs no suppression (no Effect equivalent, so the rule ignores it);
// adding one is itself a TS377000 warning that fails typecheck.
import * as NodeOS from "node:os";

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

/**
 * CPU accounting, so a stall can be attributed rather than guessed at.
 *
 * A stall says the loop was unavailable; it does not say why. These two numbers
 * separate the only answers that matter:
 *
 * - `selfCpuPct` high  -> this process was busy. The work is ours to fix.
 * - `selfCpuPct` low while `systemCpuPct` is high -> the machine was contended
 *   and the backend was starved of CPU by something else. Nothing in this
 *   codebase would fix that.
 *
 * Measured over the same window as the stall, so the attribution is local to
 * the event rather than a session average.
 */
interface CpuSnapshot {
  readonly selfUs: number;
  readonly busyMs: number;
  readonly totalMs: number;
}

function readCpuSnapshot(): CpuSnapshot {
  const self = process.cpuUsage();
  let busyMs = 0;
  let totalMs = 0;
  for (const cpu of NodeOS.cpus()) {
    const { user, nice, sys, irq, idle } = cpu.times;
    busyMs += user + nice + sys + irq;
    totalMs += user + nice + sys + irq + idle;
  }
  return { selfUs: self.user + self.system, busyMs, totalMs };
}

/** Percent of one core used by this process, and of all cores machine-wide. */
function cpuBetween(
  previous: CpuSnapshot,
  next: CpuSnapshot,
  elapsedMs: number,
): { selfCpuPct: number; systemCpuPct: number } {
  const selfMs = (next.selfUs - previous.selfUs) / 1000;
  const totalDelta = next.totalMs - previous.totalMs;
  const busyDelta = next.busyMs - previous.busyMs;
  return {
    selfCpuPct: elapsedMs > 0 ? Math.round((100 * selfMs) / elapsedMs) : 0,
    systemCpuPct: totalDelta > 0 ? Math.round((100 * busyDelta) / totalDelta) : 0,
  };
}

/**
 * Append one JSON line per stall. Synchronous and best-effort: a stall record
 * is worthless if writing it can itself fail the server, and the write happens
 * only when a stall already occurred, so it adds no cost to the healthy path.
 */
function appendDiagnostic(record: Record<string, unknown>): void {
  const file = process.env.T3_DIAGNOSTICS_FILE?.trim();
  if (!file) return;
  try {
    NodeFS.appendFileSync(file, `${JSON.stringify(record)}\n`);
  } catch {
    // Never let diagnostics break the process they are observing.
  }
}

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
    const cpuRef = yield* Ref.make(readCpuSnapshot());

    const sample = Effect.gen(function* () {
      yield* Effect.sleep(SAMPLE_INTERVAL);
      const now = yield* Clock.currentTimeMillis;
      const previous = yield* Ref.getAndSet(lastRef, now);
      // Sampled every tick, not only on a stall, so the CPU window matches the
      // stall window exactly instead of spanning the gap since the last stall.
      const previousCpu = yield* Ref.getAndSet(cpuRef, readCpuSnapshot());
      // Overshoot beyond the requested sleep is time the loop could not run timers.
      const lagMs = now - previous - SAMPLE_INTERVAL_MS;
      if (lagMs < thresholdMs) {
        return;
      }
      const cpu = cpuBetween(previousCpu, yield* Ref.get(cpuRef), now - previous);

      const stats = yield* Ref.updateAndGet(statsRef, (previous) => ({
        maxLagMs: Math.max(previous.maxLagMs, lagMs),
        totalLagMs: previous.totalLagMs + lagMs,
        stallCount: previous.stallCount + 1,
      }));
      const message =
        lagMs >= SEVERE_THRESHOLD_MS
          ? "Event loop blocked long enough to fail a client health check"
          : "Event loop stalled";
      const annotations = {
        lagMs: Math.round(lagMs),
        sinceStartupMs: Math.round(now - startedAt),
        maxLagMs: Math.round(stats.maxLagMs),
        totalStalledMs: Math.round(stats.totalLagMs),
        stallCount: stats.stallCount,
      };
      appendDiagnostic({
        // `now` is already Effect's clock reading; epoch millis avoids
        // constructing a Date inside Effect code (globalDateInEffect).
        tsEpochMs: Math.round(now),
        kind: "event-loop-stall",
        pid: process.pid,
        severe: lagMs >= SEVERE_THRESHOLD_MS,
        // Attribution: self high = our work; self low + system high = the
        // machine was contended and this process was starved.
        selfCpuPct: cpu.selfCpuPct,
        systemCpuPct: cpu.systemCpuPct,
        cpuCount: NodeOS.cpus().length,
        ...annotations,
      });
      yield* Effect.logWarning(message).pipe(Effect.annotateLogs(annotations));
    });

    yield* Effect.forkScoped(Effect.forever(sample));
    yield* Effect.logDebug("Event loop lag monitor started").pipe(
      Effect.annotateLogs({ thresholdMs, sampleIntervalMs: SAMPLE_INTERVAL_MS }),
    );
  }),
);
