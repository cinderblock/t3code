/**
 * Diagnostics for the environment shell stream — the client-side list of projects and threads.
 *
 * Why this exists: threads have gone missing from the UI while every other layer was provably
 * healthy — the server logged 2 trivial failures in 10,194 spans, the threads were present and
 * undeleted in `state.sqlite`, and the local socket never dropped. The loss is somewhere in the
 * client's incremental view of the shell, and that path currently reports **nothing at all**:
 * `applyShellStreamEvent` silently returns the previous snapshot for a stale event, and
 * `applyItem` silently returns for an event with no cached snapshot. A view that quietly stops
 * matching the server is the hardest possible failure to diagnose after the fact.
 *
 * Sequence numbers here come from `computeSnapshotSequence`, a **min across projectors of the
 * global orchestration event-log sequence**. They are therefore NOT contiguous — most logged
 * events are not shell-relevant. Do not add gap detection on the strength of a jump; a jump is
 * the normal case. What is worth reporting is a shell view that *shrinks* or *stops advancing*.
 *
 * Emitted through the same desktop crash-log bridge as the connection diagnostics, so it lands
 * in `renderer.log` and survives trace rotation. Absent on web/mobile, hence the guard.
 */

import * as Effect from "effect/Effect";

export interface ShellStreamDiagnostic {
  readonly event:
    | "shell-view-shrank"
    | "shell-event-discarded"
    | "shell-event-dropped"
    | "shell-subscribed"
    | "shell-applied";
  readonly environmentId: string;
  /** `snapshot`, `synchronized`, or the stream event's `kind`. */
  readonly itemKind: string;
  readonly itemSequence: number | null;
  readonly previousSequence: number | null;
  readonly nextSequence: number | null;
  readonly previousThreadCount: number | null;
  readonly nextThreadCount: number | null;
  readonly previousProjectCount: number | null;
  readonly nextProjectCount: number | null;
  readonly msSinceLoad: number;
}

/** Monotonic ms since this client loaded; 0 where `performance` is unavailable. */
const msSinceLoad = (): number =>
  typeof performance !== "undefined" ? Math.round(performance.now()) : 0;

const crashLogBridge = (): { send: (payload: unknown) => void } | undefined => {
  const candidate = (globalThis as { __t3CrashLog?: { send?: (payload: unknown) => void } })
    .__t3CrashLog;
  return typeof candidate?.send === "function"
    ? (candidate as { send: (payload: unknown) => void })
    : undefined;
};

export interface ShellTransition {
  readonly environmentId: string;
  readonly itemKind: string;
  readonly itemSequence: number | null;
  readonly previousSequence: number | null;
  readonly nextSequence: number | null;
  readonly previousThreadCount: number | null;
  readonly nextThreadCount: number | null;
  readonly previousProjectCount: number | null;
  readonly nextProjectCount: number | null;
  /** The event carried a sequence at or behind the cached snapshot, so the reducer ignored it. */
  readonly discardedAsStale: boolean;
  /** An incremental event arrived with no cached snapshot to apply it to, so it was dropped. */
  readonly droppedWithoutSnapshot: boolean;
}

/**
 * Decide whether a shell transition is worth reporting, and as what.
 *
 * Deliberately quiet: the shell stream is busy, and a diagnostic that fires on every event is
 * one nobody reads. Only three things are reported, each of which means the client's view can
 * no longer be trusted to match the server:
 *
 * - the view lost a thread or a project,
 * - an event was ignored because it was at or behind the cached cursor,
 * - an event arrived with nothing to apply it to.
 */
export function classifyShellTransition(
  transition: ShellTransition,
): ShellStreamDiagnostic["event"] | null {
  if (transition.droppedWithoutSnapshot) {
    return "shell-event-dropped";
  }
  if (transition.discardedAsStale) {
    return "shell-event-discarded";
  }

  const { previousThreadCount, nextThreadCount, previousProjectCount, nextProjectCount } =
    transition;
  const threadsShrank =
    previousThreadCount !== null &&
    nextThreadCount !== null &&
    nextThreadCount < previousThreadCount;
  const projectsShrank =
    previousProjectCount !== null &&
    nextProjectCount !== null &&
    nextProjectCount < previousProjectCount;

  return threadsShrank || projectsShrank ? "shell-view-shrank" : null;
}

export const emitShellStreamDiagnostic = (transition: ShellTransition): Effect.Effect<void> =>
  Effect.sync(() => {
    const event = classifyShellTransition(transition);
    if (event === null) {
      return;
    }
    const record: ShellStreamDiagnostic = {
      event,
      environmentId: transition.environmentId,
      itemKind: transition.itemKind,
      itemSequence: transition.itemSequence,
      previousSequence: transition.previousSequence,
      nextSequence: transition.nextSequence,
      previousThreadCount: transition.previousThreadCount,
      nextThreadCount: transition.nextThreadCount,
      previousProjectCount: transition.previousProjectCount,
      nextProjectCount: transition.nextProjectCount,
      msSinceLoad: msSinceLoad(),
    };
    try {
      crashLogBridge()?.send({
        level: "warn",
        source: "shell-stream",
        message: `${record.event}: ${record.environmentId}`,
        data: record,
      });
    } catch {
      // A diagnostic must never break the stream it is observing.
    }
  });

/**
 * Rate limiter for the positive signal.
 *
 * The failure-only diagnostics above proved insufficient: a reproduction produced complete
 * silence, and silence could not distinguish "the stream delivered everything cleanly" from
 * "the stream delivered nothing at all". A heartbeat makes absence readable. The shell stream
 * runs at roughly five items a minute, so the first item plus every tenth is plenty to show
 * liveness without turning `renderer.log` into a firehose.
 */
export function shouldReportApplied(appliedCount: number): boolean {
  return appliedCount === 1 || appliedCount % 10 === 0;
}

export interface ShellAppliedReport {
  readonly environmentId: string;
  readonly itemKind: string;
  readonly appliedCount: number;
  readonly itemSequence: number | null;
  readonly nextSequence: number | null;
  readonly nextThreadCount: number | null;
  readonly nextProjectCount: number | null;
}

/** Heartbeat: the stream is alive and this is what the view looks like right now. */
export const emitShellAppliedDiagnostic = (report: ShellAppliedReport): Effect.Effect<void> =>
  Effect.sync(() => {
    if (!shouldReportApplied(report.appliedCount)) {
      return;
    }
    try {
      crashLogBridge()?.send({
        level: "warn",
        source: "shell-stream",
        message: `shell-applied: ${report.environmentId}`,
        data: { event: "shell-applied", ...report, msSinceLoad: msSinceLoad() },
      });
    } catch {
      // A diagnostic must never break the stream it is observing.
    }
  });

export interface ShellSubscribedReport {
  readonly environmentId: string;
  /** Resuming from a cached cursor, or asking for a complete snapshot. */
  readonly resumed: boolean;
  readonly cursorSequence: number | null;
  readonly cachedThreadCount: number | null;
}

/**
 * The subscription was (re)established.
 *
 * Without this there is no way to tell whether the shell stream was ever opened. A live
 * subscription emits no server span until it ends, so the server trace cannot answer it either.
 */
export const emitShellSubscribedDiagnostic = (report: ShellSubscribedReport): Effect.Effect<void> =>
  Effect.sync(() => {
    try {
      crashLogBridge()?.send({
        level: "warn",
        source: "shell-stream",
        message: `shell-subscribed: ${report.environmentId}`,
        data: { event: "shell-subscribed", ...report, msSinceLoad: msSinceLoad() },
      });
    } catch {
      // A diagnostic must never break the stream it is observing.
    }
  });
