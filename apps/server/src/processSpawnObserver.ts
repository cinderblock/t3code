/**
 * Rolling subprocess-spawn instrumentation, to diagnose a spawn storm from logs after the fact.
 * On Windows each non-zero child exit triggers `taskkill` through `cmd.exe` twice, so non-zero
 * exits amplify process creation. See `plans/process-spawn-storm.md`.
 */

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import * as HostProcess from "@t3tools/shared/HostProcess";

/**
 * How a subprocess finished. `non-zero-exit` is what triggers the redundant Windows `taskkill`
 * cleanup, so it drives the amplification estimate.
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
 * Process-wide on purpose: several layers build their own `ProcessRunner`, and the spawn rate
 * being measured belongs to the whole OS process. Node's single thread makes mutation safe.
 */
const store: { records: ProcessSpawnRecord[]; lastReportAtMs: number } = {
  records: [],
  lastReportAtMs: 0,
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
  const platform = yield* HostProcess.Platform;
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
