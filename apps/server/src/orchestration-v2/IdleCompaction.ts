import {
  isListedThreadLineage,
  type OrchestrationV2ThreadProjection,
  type RunId,
} from "@t3tools/contracts";
import {
  COMPACTION_SUGGESTION_MIN_TOKENS,
  hasDismissedResumeCompaction,
  shouldOfferResumeCompaction,
} from "@t3tools/shared/claudeCompaction";
import { derivePendingBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as DateTime from "effect/DateTime";

// Claude Code's idleCompaction defaults to 200K and won't go below 100K. Below
// that a cold re-read is cheap, so compacting mostly loses context for little
// saving.
const MIN_CONTEXT_TOKENS = COMPACTION_SUGGESTION_MIN_TOKENS;
// Start this long before the cache expires: enough for the session to resume
// and send the compaction while the cache is still warm.
const LEAD_MS = 2 * 60_000;

export const IDLE_COMPACTION_RECORD_FIELDS = [
  "runs",
  "messages",
  "providerThreads",
  "providerTurns",
  "runtimeRequests",
  "turnItems",
  "contextTransfers",
] as const;

/** Reads only the latest run's message and the turn items still open, which is all this needs. */
export const idleCompactionRecordFilter = (runId: RunId) =>
  ({ messageRunIds: [runId], turnItemStatuses: ["pending", "running", "waiting"] }) as const;

export type IdleCompactionRecords = Pick<
  OrchestrationV2ThreadProjection,
  "thread" | (typeof IDLE_COMPACTION_RECORD_FIELDS)[number]
>;

type Run = IdleCompactionRecords["runs"][number];

const latestOf = (runs: ReadonlyArray<Run>) =>
  runs
    // A removed or steered queued message leaves a cancelled run that never started.
    .filter((run) => run.status !== "cancelled" || run.startedAt !== null)
    .reduce<Run | null>(
      (latest, run) => (latest === null || run.ordinal > latest.ordinal ? run : latest),
      null,
    );

/**
 * The context size of the Claude session `latestRun` left behind, or null when T3 must not compact
 * it: too small, not this thread's current session, or holding work for the next turn.
 */
function compactableUsage(
  {
    thread,
    messages,
    providerThreads,
    providerTurns,
    runtimeRequests,
    turnItems,
    contextTransfers,
    runs,
  }: IdleCompactionRecords,
  latestRun: Run,
) {
  if (!isListedThreadLineage(thread.lineage)) return null;
  const message = messages.find((candidate) => candidate.id === latestRun.userMessageId);
  // Never compact a compaction, so one idle spell compacts at most once.
  if (message === undefined || message.text.trim().toLowerCase() === "/compact") return null;
  if (
    runtimeRequests.some((request) => request.status === "pending") ||
    // A pending merge-back belongs to the user's next message.
    contextTransfers.some(
      (transfer) =>
        transfer.type === "merge_back" &&
        transfer.targetThreadId === thread.id &&
        transfer.status === "pending",
    ) ||
    // Background work reports into the next turn; compaction would swallow it.
    derivePendingBackgroundWork({
      latestRun,
      runs,
      providerThreads,
      turnItems,
      activeProviderThreadId: thread.activeProviderThreadId,
    }).length > 0
  )
    return null;
  const providerThread = providerThreads.find(
    (candidate) => candidate.id === thread.activeProviderThreadId,
  );
  // The thread's current selection receives the /compact, so it must still be this Claude session.
  if (
    providerThread?.driver !== "claudeAgent" ||
    providerThread.id !== latestRun.providerThreadId ||
    providerThread.providerInstanceId !== thread.providerInstanceId ||
    latestRun.providerInstanceId !== thread.providerInstanceId
  )
    return null;
  const usages = providerTurns
    .filter((turn) => turn.providerThreadId === providerThread.id && turn.tokenUsage !== undefined)
    .map((turn) => turn.tokenUsage!)
    .toSorted((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  const usage = usages[0];
  return usage !== undefined && usage.usedTokens >= MIN_CONTEXT_TOKENS ? usage : null;
}

/**
 * When an idle Claude thread should compact, or null when it should not. The
 * window ends when the prompt cache of Claude's last request expires (1h on
 * subscriptions, 5m on API keys); compacting after that pays a full uncached
 * read.
 */
export function idleCompactionWindow(
  records: IdleCompactionRecords,
  nowMs: number,
): {
  readonly runId: Run["id"];
  readonly startMs: number;
  readonly endMs: number;
} | null {
  const { thread, runs } = records;
  if (thread.deletedAt !== null || thread.archivedAt !== null) return null;
  if (thread.settledAt !== null || thread.settledOverride === "settled") return null;
  if (thread.snoozedUntil != null && DateTime.toEpochMillis(thread.snoozedUntil) > nowMs)
    return null;
  if (thread.blockedOn != null) return null;
  const latestRun = latestOf(runs);
  if (latestRun?.status !== "completed" || latestRun.completedAt === null) return null;
  const usage = compactableUsage(records, latestRun);
  if (usage === null) return null;
  // A request served fully from cache creates no cache entry and reports no
  // TTL, but it still refreshes the cache. Treat it as unknown and skip.
  const expiresAt = usage.promptCacheExpiresAt;
  const endMs = expiresAt === undefined ? Number.NaN : Date.parse(expiresAt);
  if (!Number.isFinite(endMs) || nowMs >= endMs) return null;
  return { runId: latestRun.id, startMs: endMs - LEAD_MS, endMs };
}

/** The run a message sent now would continue from, or null while other work is still ahead of it. */
export function resumedRun(runs: ReadonlyArray<Run>): Run | null {
  const ended = runs.filter(
    (run) => run.status === "completed" || run.status === "failed" || run.status === "interrupted",
  );
  const busy = runs.some(
    (run) =>
      run.status === "preparing" ||
      run.status === "queued" ||
      run.status === "starting" ||
      run.status === "running" ||
      run.status === "waiting",
  );
  return busy ? null : latestOf(ended);
}

/**
 * The composer's Compact chip, for a send with no composer attached: whether a message sent now
 * lands on a session whose prompt cache has expired. Settled and snoozed threads count, unlike
 * `idleCompactionWindow`, since the message wakes them anyway.
 */
export function shouldCompactBeforeSend(records: IdleCompactionRecords, now: string): boolean {
  const latestRun = resumedRun(records.runs);
  if (latestRun === null || hasDismissedResumeCompaction(records.runtimeRequests)) return false;
  const usage = compactableUsage(records, latestRun);
  return (
    usage !== null &&
    shouldOfferResumeCompaction({
      provider: "claudeAgent",
      usedTokens: usage.usedTokens,
      updatedAt: usage.updatedAt,
      promptCacheTtlMs: usage.promptCacheTtlMs,
      now,
    })
  );
}
