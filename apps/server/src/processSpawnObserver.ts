/**
 * Rolling instrumentation for subprocess spawning.
 *
 * The server periodically falls into a "spawn storm": subprocess creation saturates the Node
 * event loop, unrelated in-process work (SQLite, stats, RPC dispatch) queues behind it, and
 * round-trips blow past the client's 15s slow-request threshold. The storm is not reliably
 * reproducible, so this records enough to diagnose one *after the fact* from the logs alone.
 *
 * Two things make it worth measuring spawns specifically rather than trusting the trace:
 *
 * 1. Windows process creation is expensive, and `@effect/platform-node-shared` reacts to any
 *    non-zero child exit by running `taskkill /pid <pid> /T /F` through `NodeChildProcess.exec`
 *    — twice, via both an `exit` listener and the `acquireRelease` finalizer. `exec` goes
 *    through `cmd.exe`, so each kill costs cmd.exe + taskkill.exe + two conhost.exe. A single
 *    *expected* non-zero exit (e.g. `git rev-parse` in a non-repo, which exits 128) therefore
 *    costs roughly eight extra processes on top of the one we asked for. Counting non-zero
 *    exits is counting the amplifier.
 * 2. Spans tell you an operation was slow; they don't tell you the machine was being buried by
 *    process creation at that moment. The storm report pins both together.
 *
 * See `plans/process-spawn-storm.md` for the measurements this was built from.
 */

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

/**
 * How a subprocess finished, from the spawner's point of view.
 *
 * `non-zero-exit` is the load-bearing one on Windows: it is what triggers the dependency's
 * redundant `taskkill` cleanup, so it drives the amplification estimate rather than merely
 * describing an unhappy command.
 */
export type ProcessSpawnOutcome = "ok" | "non-zero-exit" | "timeout" | "spawn-error" | "error";

export interface ProcessSpawnRecord {
  readonly command: string;
  /** First argument, which for git-style CLIs is the subcommand. Kept for grouping. */
  readonly subcommand: string | null;
  readonly cwd: string | null;
  readonly durationMs: number;
  readonly exitCode: number | null;
  readonly outcome: ProcessSpawnOutcome;
  readonly finishedAtMs: number;
}

export interface ProcessSpawnWindowSummary {
  readonly windowMs: number;
  readonly spawns: number;
  readonly spawnsPerSecond: number;
  readonly nonZeroExits: number;
  readonly timeouts: number;
  readonly spawnErrors: number;
  /**
   * Extra processes Windows created purely to tear down children that had already exited.
   * Zero on other platforms — the POSIX path uses `process.kill` and spawns nothing.
   */
  readonly estimatedWindowsCleanupProcesses: number;
  readonly totalDurationMs: number;
  readonly topCommands: ReadonlyArray<{
    readonly label: string;
    readonly count: number;
    readonly nonZeroExits: number;
    readonly avgDurationMs: number;
  }>;
  readonly topCwds: ReadonlyArray<{ readonly cwd: string; readonly count: number }>;
}

export class ProcessSpawnObserver extends Context.Service<
  ProcessSpawnObserver,
  {
    readonly record: (record: ProcessSpawnRecord) => Effect.Effect<void>;
    /** Summarise the trailing window. Exposed so a future RPC or crash snapshot can dump it. */
    readonly summarize: (windowMs?: number) => Effect.Effect<ProcessSpawnWindowSummary>;
  }
>()("t3/processSpawnObserver") {}

/** Trailing window each summary covers. */
const WINDOW_MS = 30_000;
/** Records retained. At the observed storm rate (~4/s) this is several windows' worth. */
const MAX_RECORDS = 2_000;
/** Sustained spawn rate that counts as a storm, well above the idle baseline. */
const STORM_SPAWNS_PER_SECOND = 2;
/** Don't report a storm until the window holds enough samples for the rate to mean anything. */
const STORM_MIN_SPAWNS = 30;
/** Gap between storm reports, so the instrumentation can't become its own noise source. */
const STORM_REPORT_INTERVAL_MS = 60_000;
/**
 * Processes Windows spawns per already-exited child with a non-zero code: two `taskkill`
 * invocations, each of which is `cmd.exe` + `taskkill.exe` + a conhost for each.
 */
const WINDOWS_CLEANUP_PROCESSES_PER_NON_ZERO_EXIT = 8;

const TOP_N = 5;

/**
 * Shared across every `ProcessRunner` instance, deliberately.
 *
 * Several layers (`VcsProcess`, `TerminalManager`, `ServerEnvironment`, `PortScanner`,
 * `RepositoryIdentityResolver`, ...) each build their own `ProcessRunner`, so layer-scoped
 * state would fragment the measurement into a handful of partial views. What is being measured
 * — how fast this OS process is creating child processes — is a property of the process as a
 * whole, so the store is too. Node's single thread makes the plain mutation safe.
 */
const store: { records: ProcessSpawnRecord[]; lastReportAtMs: number } = {
  records: [],
  lastReportAtMs: 0,
};

/** Test seam: drop everything recorded so far. */
export const resetForTesting = (): void => {
  store.records = [];
  store.lastReportAtMs = 0;
};

const labelFor = (record: Pick<ProcessSpawnRecord, "command" | "subcommand">): string =>
  record.subcommand === null ? record.command : `${record.command} ${record.subcommand}`;

/** Flags that consume the following argument, so it isn't mistaken for the subcommand. */
const VALUE_TAKING_FLAGS = new Set(["-C", "-c", "--git-dir", "--work-tree"]);

/**
 * First non-flag argument, which for git-style CLIs is the subcommand.
 *
 * Grouping on `args[0]` alone is useless here: the VCS layer prefixes nearly every invocation
 * with `-C <cwd>` and a run of `-c key=value` overrides, so `args[0]` is almost always `-C`.
 */
export function pickSubcommand(args: ReadonlyArray<string>): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg.startsWith("-")) {
      if (VALUE_TAKING_FLAGS.has(arg)) index += 1;
      continue;
    }
    return arg;
  }
  return null;
}

export function summarizeRecords(
  records: ReadonlyArray<ProcessSpawnRecord>,
  windowMs: number,
  isWindows: boolean,
): ProcessSpawnWindowSummary {
  const spawns = records.length;
  const seconds = windowMs / 1_000;

  let nonZeroExits = 0;
  let timeouts = 0;
  let spawnErrors = 0;
  let totalDurationMs = 0;

  const byCommand = new Map<string, { count: number; nonZeroExits: number; durationMs: number }>();
  const byCwd = new Map<string, number>();

  for (const record of records) {
    totalDurationMs += record.durationMs;
    if (record.outcome === "non-zero-exit") nonZeroExits += 1;
    else if (record.outcome === "timeout") timeouts += 1;
    else if (record.outcome === "spawn-error") spawnErrors += 1;

    const label = labelFor(record);
    const entry = byCommand.get(label) ?? { count: 0, nonZeroExits: 0, durationMs: 0 };
    entry.count += 1;
    entry.durationMs += record.durationMs;
    if (record.outcome === "non-zero-exit") entry.nonZeroExits += 1;
    byCommand.set(label, entry);

    if (record.cwd !== null) {
      byCwd.set(record.cwd, (byCwd.get(record.cwd) ?? 0) + 1);
    }
  }

  const topCommands = [...byCommand.entries()]
    .toSorted(([, left], [, right]) => right.count - left.count)
    .slice(0, TOP_N)
    .map(([label, entry]) => ({
      label,
      count: entry.count,
      nonZeroExits: entry.nonZeroExits,
      avgDurationMs: Math.round(entry.durationMs / entry.count),
    }));

  const topCwds = [...byCwd.entries()]
    .toSorted(([, left], [, right]) => right - left)
    .slice(0, TOP_N)
    .map(([cwd, count]) => ({ cwd, count }));

  return {
    windowMs,
    spawns,
    spawnsPerSecond: seconds > 0 ? Math.round((spawns / seconds) * 100) / 100 : 0,
    nonZeroExits,
    timeouts,
    spawnErrors,
    estimatedWindowsCleanupProcesses: isWindows
      ? nonZeroExits * WINDOWS_CLEANUP_PROCESSES_PER_NON_ZERO_EXIT
      : 0,
    totalDurationMs,
    topCommands,
    topCwds,
  };
}

export const make = Effect.fn("ProcessSpawnObserver.make")(function* () {
  const platform = yield* HostProcessPlatform;
  const isWindows = platform === "win32";

  const summarize = Effect.fn("ProcessSpawnObserver.summarize")(function* (
    windowMs: number = WINDOW_MS,
  ) {
    const nowMs = yield* Clock.currentTimeMillis;
    const cutoffMs = nowMs - windowMs;
    return summarizeRecords(
      store.records.filter((record) => record.finishedAtMs >= cutoffMs),
      windowMs,
      isWindows,
    );
  });

  const record = Effect.fn("ProcessSpawnObserver.record")(function* (
    nextRecord: ProcessSpawnRecord,
  ) {
    const cutoffMs = nextRecord.finishedAtMs - WINDOW_MS;

    // Trim to the window, then to the hard cap, so a burst can't grow the array without bound
    // between reports.
    store.records = [...store.records, nextRecord]
      .filter((entry) => entry.finishedAtMs >= cutoffMs)
      .slice(-MAX_RECORDS);

    const windowRecords = store.records;
    const stormy =
      windowRecords.length >= STORM_MIN_SPAWNS &&
      windowRecords.length / (WINDOW_MS / 1_000) >= STORM_SPAWNS_PER_SECOND;
    const dueForReport = nextRecord.finishedAtMs - store.lastReportAtMs >= STORM_REPORT_INTERVAL_MS;
    if (!(stormy && dueForReport)) return;

    const previousReportAtMs = store.lastReportAtMs;
    store.lastReportAtMs = nextRecord.finishedAtMs;

    const summary = summarizeRecords(windowRecords, WINDOW_MS, isWindows);
    yield* Effect.logWarning(
      `Subprocess spawn storm: ${summary.spawns} spawns in ${Math.round(
        summary.windowMs / 1_000,
      )}s (${summary.spawnsPerSecond}/s). Top: ${summary.topCommands
        .map((entry) => `${entry.label} x${entry.count} (avg ${entry.avgDurationMs}ms)`)
        .join(", ")}`,
    ).pipe(
      Effect.annotateLogs({
        spawns: summary.spawns,
        spawnsPerSecond: summary.spawnsPerSecond,
        nonZeroExits: summary.nonZeroExits,
        timeouts: summary.timeouts,
        spawnErrors: summary.spawnErrors,
        estimatedWindowsCleanupProcesses: summary.estimatedWindowsCleanupProcesses,
        totalDurationMs: summary.totalDurationMs,
        topCommands: summary.topCommands,
        topCwds: summary.topCwds,
        previousReportAtMs,
      }),
    );
  });

  return ProcessSpawnObserver.of({ record, summarize });
});

export const layer = Layer.effect(ProcessSpawnObserver, make());

/** No-op instance for tests and call sites that don't care about instrumentation. */
export const noop = ProcessSpawnObserver.of({
  record: () => Effect.void,
  summarize: (windowMs: number = WINDOW_MS) =>
    Effect.succeed(summarizeRecords([], windowMs, false)),
});

export const layerNoop = Layer.succeed(ProcessSpawnObserver, noop);
